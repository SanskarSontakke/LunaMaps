import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { measureMPerPx, PROBE_D_LON_DEG } from '@/lib/cesium/scaleProbe';
import { MOON_ELLIPSOID, MOON_RADIUS_M } from '@/lib/cesium/moon';
import { cameraHeightForLevel, mPerPx } from '@/lib/grid';
import { alongParallelMeters, deepestLevel, levelForMPerPx, stackTop } from '@/lib/scale';
import ScaleReadout from '@/components/ScaleReadout';

const VIEWPORT_PX = 900;
const FOV_DEG = 60;

/**
 * A real Cesium camera on the real moon ellipsoid, fed to the *real*
 * `SceneTransforms.worldToWindowCoordinates`. `Camera` needs a scene-shaped
 * object (ellipsoid, mapProjection, drawing-buffer size, frameState.mode) and
 * `worldToWindowCoordinates` reads `frameState.mode`, `canvas` and `camera` in
 * SCENE3D — none of them requires WebGL, so a full Viewer (which does, plus a
 * sized canvas) is not needed to exercise the projection. The canvas is square
 * so Cesium's "fov spans the larger dimension" rule cannot change the answer,
 * and 900 px matches the viewport height the grid contract and the label tiers
 * already assume.
 */
function globeViewer(
  lonDeg: number,
  latDeg: number,
  heightM: number,
  pitchRad = -Math.PI / 2,
) {
  const scene: Record<string, unknown> = {
    ellipsoid: MOON_ELLIPSOID,
    mapProjection: new Cesium.WebMercatorProjection(MOON_ELLIPSOID),
    drawingBufferWidth: VIEWPORT_PX,
    drawingBufferHeight: VIEWPORT_PX,
    mode: Cesium.SceneMode.SCENE3D,
    frameState: { mode: Cesium.SceneMode.SCENE3D, ellipsoid: MOON_ELLIPSOID },
    canvas: { clientWidth: VIEWPORT_PX, clientHeight: VIEWPORT_PX },
    requestRender: () => undefined,
  };
  const camera = new Cesium.Camera(scene as unknown as Cesium.Scene);
  scene.camera = camera;
  camera.frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.toRadians(FOV_DEG),
    aspectRatio: 1,
    near: 1,
    far: 1e10,
  });
  camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      lonDeg,
      latDeg,
      heightM,
      MOON_ELLIPSOID,
    ),
    orientation: { heading: 0, pitch: pitchRad, roll: 0 },
  });
  return { camera, scene } as unknown as Cesium.Viewer;
}

describe('measureMPerPx through a real projection (SCENE3D)', () => {
  it('reproduces the grid contract at the L6 camera height', () => {
    const h = cameraHeightForLevel(6, VIEWPORT_PX, FOV_DEG);
    const measured = measureMPerPx(globeViewer(23.4731, 0.6746, h));
    expect(measured).not.toBeNull();
    // The plan's Task 13 acceptance is "within a factor of 2"; this lands inside
    // 0.2%, which is the curvature + perspective second-order error.
    expect(measured as number).toBeGreaterThan(mPerPx(6) / 2);
    expect(measured as number).toBeLessThan(mPerPx(6) * 2);
    expect(measured as number).toBeCloseTo(mPerPx(6), 2);
  });

  it('scales linearly with camera height, as a pinhole must', () => {
    const far = measureMPerPx(globeViewer(0, 0, 1e6)) as number;
    const near = measureMPerPx(globeViewer(0, 0, 5e5)) as number;
    expect(far / near).toBeCloseTo(2, 2);
    expect(far).toBeGreaterThan(near);
  });

  it('is the same m/px at any latitude in a nadir globe view', () => {
    // The ground probe distance halves at 60 deg (cos factor) and so does its
    // image: on a sphere seen straight down the two cancel. This is *why* the
    // readout has to be measured rather than looked up in a table.
    const h = cameraHeightForLevel(5, VIEWPORT_PX, FOV_DEG);
    const eq = measureMPerPx(globeViewer(0, 0, h)) as number;
    const hi = measureMPerPx(globeViewer(0, 60, h)) as number;
    expect(hi / eq).toBeCloseTo(1, 2);
    expect(alongParallelMeters(60, PROBE_D_LON_DEG)).toBeCloseTo(
      alongParallelMeters(0, PROBE_D_LON_DEG) / 2,
      3,
    );
  });

  it('measures metres on the moon radius, not WGS84', () => {
    // 0.01 deg of longitude at the equator is 303.2 m on the moon; the same
    // chord on Earth would be 1 113 m, a 3.7x error no clamp would hide.
    expect(MOON_RADIUS_M).toBe(1_737_400);
    expect(alongParallelMeters(0, PROBE_D_LON_DEG)).toBeCloseTo(303.22, 1);
    const h = cameraHeightForLevel(6, VIEWPORT_PX, FOV_DEG);
    const pxPerDeg = (303.22 / (measureMPerPx(globeViewer(0, 0, h)) as number)) * 100;
    expect(pxPerDeg).toBeCloseTo(512 * 2 ** 7 / 360, 0);
  });

  it('returns null when the surface point is behind the view plane', () => {
    // Zenith-looking camera: the ground point under the camera is off-screen,
    // which is exactly what the readout must show as UNAVAILABLE, not 0 or NaN.
    const v = globeViewer(0, 0, 1e6, Math.PI / 2);
    expect(measureMPerPx(v)).toBeNull();
  });
});

/**
 * An equirectangular pixel grid — what Cesium's SCENE2D map projection gives:
 * x is proportional to longitude *independent of latitude*. This is the case
 * the cos(lat) factor exists for, and it is modelled with an injected
 * projector because the SCENE2D camera setup needs a real WebGL scene.
 */
function paperProjector(pxPerDeg: number) {
  return (_scene: Cesium.Scene, world: Cesium.Cartesian3) => {
    const c = MOON_ELLIPSOID.cartesianToCartographic(world);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const lat = Cesium.Math.toDegrees(c.latitude);
    return { x: lon * pxPerDeg, y: -lat * pxPerDeg };
  };
}

describe('measureMPerPx on an equirectangular grid (paper mode shape)', () => {
  const PX_PER_DEG = (512 * 2 ** 7) / 360; // L6 of the grid contract
  // The camera only supplies the *centre* lat/lon here; the projector stands in
  // for Cesium's SCENE2D map projection, which needs a real WebGL scene.
  const centre = () => globeViewer(0, 0, 1e6);

  it('shrinks the along-parallel readout by cos(latitude)', () => {
    const eq = measureMPerPx(centre(), paperProjector(PX_PER_DEG)) as number;
    const at60 = measureMPerPx(
      globeViewer(0, 60, 1e6),
      paperProjector(PX_PER_DEG),
    ) as number;
    expect(eq).toBeCloseTo(mPerPx(6), 2);
    expect(at60 / eq).toBeCloseTo(Math.cos(Cesium.Math.toRadians(60)), 3);
  });

  it('is proportional to the pixel density of the grid', () => {
    const half = measureMPerPx(centre(), paperProjector(PX_PER_DEG / 2)) as number;
    const full = measureMPerPx(centre(), paperProjector(PX_PER_DEG)) as number;
    expect(half / full).toBeCloseTo(2, 6);
  });

  it('returns null when either probe point is off-screen', () => {
    const firstOnly = (_scene: Cesium.Scene, world: Cesium.Cartesian3) => {
      const c = MOON_ELLIPSOID.cartesianToCartographic(world);
      // The second probe point (east of the centre) falls off the right edge.
      if (c.longitude > 0.0001) return undefined;
      return { x: 10, y: 10 };
    };
    expect(measureMPerPx(centre(), firstOnly)).toBeNull();
  });

  it('returns null when the two points land on the same pixel', () => {
    const frozen = () => ({ x: 42, y: 42 });
    expect(measureMPerPx(centre(), frozen)).toBeNull();
  });
});

/**
 * The part of the readout the probe does not decide: which LEVEL the panel is
 * allowed to name.
 *
 * `mPerPx` is measured, so it was always honest. The ceiling next to it was not:
 * `ScaleReadout` clamped through the BASE layer's manifest top, so with the
 * `ortho` overlay delivering 10.4 m/px over a base that stops at L7 it printed
 * "L7 of L7" — a level claim about a stack that was not there. The three states
 * below are the three the app can be in, and each is asserted on the rendered
 * markup rather than on a helper's return value, because the bug lived in what
 * the user reads.
 */
const readoutAt = (metresPerPixel: number) => ({
  mPerPx: metresPerPixel,
  latDeg: 0.6746,
  lonDeg: 23.4731,
});

/** The `Lx of Ly` span the panel renders, with the tabular lat/lon span removed. */
const levelText = (html: string) => {
  const meta = /<div class="scale-meta">([\s\S]*?)<\/div>/.exec(html);
  const spans = meta ? [...meta[1].matchAll(/<span>([^<]*)<\/span>/g)] : [];
  return spans.map((s) => s[1]).join(' | ');
};

describe('the level ceiling follows the stack that serves the pixels', () => {
  const BASE_TOP = 7;
  const DEEP_TOP = 10;

  it('names L10 of L10 when the deep overlay is attached and resolving', () => {
    const html = renderToStaticMarkup(
      ScaleReadout({
        readout: readoutAt(mPerPx(DEEP_TOP)),
        top: BASE_TOP,
        overlayTop: DEEP_TOP,
      }),
    );
    expect(levelText(html)).toContain('L10 of L10');
    // The claim the whole finding is about: the base's ceiling must not survive
    // as the advertised one while the overlay is what paints.
    expect(html).not.toContain('of L7');
  });

  it('still says L7 of L7 with the overlay off', () => {
    const html = renderToStaticMarkup(
      ScaleReadout({
        readout: readoutAt(mPerPx(BASE_TOP)),
        top: BASE_TOP,
        overlayTop: null,
      }),
    );
    expect(levelText(html)).toContain('L7 of L7');
  });

  it('says L7 of L7 when the overlay was asked for but is not on this machine', () => {
    // The caller's third state arrives as the same `null`: nothing deeper is in
    // the stack, so nothing deeper may be advertised. The MoonMap side of that
    // pairing is asserted from the source below, because the disk probe is not
    // something this environment can run.
    const html = renderToStaticMarkup(
      ScaleReadout({
        readout: readoutAt(mPerPx(DEEP_TOP)),
        top: BASE_TOP,
        overlayTop: null,
      }),
    );
    expect(levelText(html)).toContain('L7 of L7');
    expect(html).toContain('10 m/px'); // the m/px stays the measured one
  });

  it('keeps the deep ceiling while the camera is only resolving the base', () => {
    // "of N" is a ceiling, not a promise about the tile under the cursor: inside
    // the recorded boxes the stack does reach L10, so naming it while the current
    // level is L5 is the honest reading of the attached overlay.
    const html = renderToStaticMarkup(
      ScaleReadout({
        readout: readoutAt(mPerPx(5)),
        top: BASE_TOP,
        overlayTop: DEEP_TOP,
      }),
    );
    expect(levelText(html)).toContain('L5 of L10');
  });

  it('is derived from the measurement, not from a level the manifest never baked', () => {
    // The clamp is still a clamp: an absurd m/px cannot name a level past the
    // ceiling the caller supplied.
    expect(levelForMPerPx(mPerPx(DEEP_TOP), BASE_TOP)).toBe(7);
    expect(levelForMPerPx(mPerPx(DEEP_TOP), DEEP_TOP)).toBe(10);
    expect(levelForMPerPx(mPerPx(0), DEEP_TOP)).toBe(0);
  });
});

describe('stackTop / deepestLevel: the two rules the ceiling is built from', () => {
  it('an absent or refused overlay leaves the base ceiling alone', () => {
    for (const none of [null, undefined]) expect(stackTop(7, none)).toBe(7);
    // A non-integer or negative overlay depth is not a depth, and must not become
    // a ceiling the readout cannot reach.
    for (const bad of [NaN, 1.5, -1, Infinity]) expect(stackTop(7, bad)).toBe(7);
  });
  it('an attached overlay can only raise the ceiling, never lower it', () => {
    expect(stackTop(7, 10)).toBe(10);
    expect(stackTop(7, 7)).toBe(7);
    expect(stackTop(7, 3)).toBe(7);
    expect(stackTop(7, 0)).toBe(7);
  });
  it('the deepest level of a served list, in any order, and null for none', () => {
    expect(deepestLevel([8, 9, 10])).toBe(10);
    expect(deepestLevel([10, 8, 9])).toBe(10);
    expect(deepestLevel([7])).toBe(7);
    expect(deepestLevel([])).toBeNull();
    expect(deepestLevel([1.5])).toBeNull();
    expect(deepestLevel([-2])).toBeNull();
  });
});

describe('MoonMap feeds the ceiling from the live stack', () => {
  const src = readFileSync(
    resolve(__dirname, '../components/MoonMap.tsx'),
    'utf8',
  );

  it('passes overlayTop, and only while the overlay is attached', () => {
    expect(src).toMatch(
      /overlayTop=\{overlayAttached \? overlayServedTop\(manifest\) : null\}/,
    );
  });
  it('writes that flag from the viewer’s own layer stack, not from the intent', () => {
    // `orthoEnabled` is what the user asked for; `orthoOverlayEnabled(viewer)` is
    // what the stack holds, and a refused attach must not raise the ceiling.
    expect(src).toMatch(/setOverlayAttached\(!viewer\.isDestroyed\(\) && orthoOverlayEnabled\(viewer\)\)/);
    expect(src).toMatch(/const \[overlayAttached, setOverlayAttached\] = useState\(false\)/);
  });
  it('derives the served depth from the same envelope-filtered level list', () => {
    // The provider's `maximumLevel`, the control's label and the readout's ceiling
    // must not each hold their own idea of how deep `ortho` goes.
    expect(src).toMatch(/deepestLevel\(orthoLevels\(ortho\.availability, ortho\.top\)\)/);
  });
});
