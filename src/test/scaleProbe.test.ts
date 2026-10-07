import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { measureMPerPx, PROBE_D_LON_DEG } from '@/lib/cesium/scaleProbe';
import { MOON_ELLIPSOID, MOON_RADIUS_M } from '@/lib/cesium/moon';
import { cameraHeightForLevel, mPerPx } from '@/lib/grid';
import { alongParallelMeters } from '@/lib/scale';

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
