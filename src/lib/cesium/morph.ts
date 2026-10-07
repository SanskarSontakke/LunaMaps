import * as Cesium from 'cesium';
import type { LayerName, Mode } from '@/types';
import { MAX_H, MIN_H, MOON_ELLIPSOID, makeProvider } from './moon';

// The height limits are defined once in moon.ts (where the screen-space
// controller is configured) and re-exported here so callers and tests keep
// importing them from morph.ts without a second, drifting copy.
export { MAX_H, MIN_H };
/** Duration passed to Cesium's scene morph, in seconds. */
export const MORPH_SECONDS = 0.5;
/**
 * Wall-clock ceiling for a morph to land on its own before the completeMorph()
 * fallback jump-cuts it. Cesium's morph is two sequential tweens (~2 *
 * MORPH_SECONDS of wall time) and the first frame can stall on tile decode or a
 * GC pause; a deadline close to the morph duration turns that stall into a
 * jump-cut. This sits far above the duration so a *visible* tab always reaches
 * scene.mode === target unaided — the fallback only ever fires when the render
 * loop is starved (a hidden tab, where the tweens are pumped manually).
 */
export const MORPH_DEADLINE_MS = Math.max(15_000, (2 * MORPH_SECONDS + 12) * 1000);

export interface CameraState {
  lonDeg: number;
  latDeg: number;
  height: number;
  heading: number;
  pitch: number;
}

export const clampHeight = (h: number) => Math.min(Math.max(h, MIN_H), MAX_H);

export function getCameraState(viewer: Cesium.Viewer): CameraState {
  const c = viewer.camera.positionCartographic;
  const toDeg = 180 / Math.PI;
  return {
    lonDeg: c.longitude * toDeg,
    latDeg: c.latitude * toDeg,
    height: c.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
  };
}

export function preserveState(s: CameraState, mode: Mode): CameraState {
  const lat = Math.min(Math.max(s.latDeg, -89.9999), 89.9999);
  return {
    lonDeg: s.lonDeg,
    latDeg: lat,
    height: clampHeight(s.height),
    heading: mode === 'paper' ? 0 : s.heading,
    // Paper is a flat map: always straight down, always north-up. Globe keeps
    // whatever tilt the user had.
    pitch: mode === 'paper' ? -Math.PI / 2 : s.pitch,
  };
}

/**
 * One morph at a time per viewer. Without this, a fast Paper/Globe double-click
 * interleaves two waits on the same scene: Scene.morphTo2D/3D called during
 * MORPHING first completes the running morph and then *returns without starting
 * the new one* (Cesium 1.146, SceneTransitioner), so the naive version can wait
 * for a mode that never arrives.
 */
const morphQueue = new WeakMap<Cesium.Viewer, Promise<void>>();

export function setMode(viewer: Cesium.Viewer, mode: Mode): Promise<void> {
  const run = () => doSetMode(viewer, mode);
  const prev = morphQueue.get(viewer);
  const next = prev ? prev.then(run, run) : run();
  morphQueue.set(viewer, next);
  return next;
}

async function doSetMode(viewer: Cesium.Viewer, mode: Mode): Promise<void> {
  if (viewer.isDestroyed()) return;
  const scene = viewer.scene;
  const target = mode === 'globe' ? Cesium.SceneMode.SCENE3D : Cesium.SceneMode.SCENE2D;
  const snap = preserveState(getCameraState(viewer), mode);
  if (scene.mode === Cesium.SceneMode.MORPHING) scene.completeMorph();
  if (scene.mode !== target) {
    // The morph methods live on Scene, not Camera (verified against 1.146:
    // Scene.morphTo2D(duration) / morphTo3D(duration) take no completion
    // callback and resolve the transition through tweens driven inside
    // Scene.render).
    if (mode === 'globe') scene.morphTo3D(MORPH_SECONDS);
    else scene.morphTo2D(MORPH_SECONDS);
    await waitForSceneMode(viewer, target);
  }
  // waitForSceneMode can resolve on destroy (teardown) or on the fallback
  // deadline *without* the mode ever landing. settleMode re-checks both before
  // touching the controller, so a torn-down viewer is left alone and a stalled
  // morph rejects (and stays retryable) instead of half-applying onto a wrong
  // scene — the destroy race this guards against.
  settleMode(viewer, mode, target, snap);
}

/** Thrown by `settleMode` when the scene did not reach the requested mode.
 *  MoonMap turns the resulting rejection into a visible error and leaves its
 *  committed `applied` mode untouched, so the switch can be retried. */
export class MorphIncompleteError extends Error {
  constructor(mode: Mode) {
    super(`scene never reached ${mode} mode; try again`);
    this.name = 'MorphIncompleteError';
  }
}

/**
 * The synchronous tail of a mode change, run after the morph has been awaited.
 * Kept free of any DOM/timer dependency so it is unit-testable with a plain
 * fake viewer (the await in `doSetMode` is what needs a real tab).
 *  - viewer/scene destroyed: teardown, not a failed switch — resolve quietly,
 *    apply nothing (there is no scene to retry onto).
 *  - scene.mode !== target: the morph was cut short — throw so the caller can
 *    surface it and keep the switch retryable.
 *  - otherwise: apply tilt + setView + requestRender.
 */
export function settleMode(
  viewer: Cesium.Viewer,
  mode: Mode,
  target: number,
  snap: CameraState,
): void {
  if (viewer.isDestroyed() || viewer.scene.isDestroyed?.()) return;
  if (viewer.scene.mode !== target) throw new MorphIncompleteError(mode);
  const scene = viewer.scene;
  scene.screenSpaceCameraController.enableTilt = mode === 'globe';
  viewer.camera.setView({
    // Cartesian3 (not Cartographic) because 1.146's setView typings only
    // accept Rectangle | Cartesian3; fromDegrees on the moon ellipsoid is
    // exactly the Cartographic conversion setView would have done.
    destination: Cesium.Cartesian3.fromDegrees(
      snap.lonDeg,
      snap.latDeg,
      snap.height,
      MOON_ELLIPSOID,
    ),
    orientation: { heading: snap.heading, pitch: snap.pitch, roll: 0 },
  });
  scene.requestRender();
}

/**
 * The viewer runs with requestRenderMode: true, so the morph tweens only
 * advance while frames are being asked for. Poll scene.mode (public API;
 * MORPHING until the transition lands) on a setTimeout pump — a
 * requestAnimationFrame loop would never tick in a hidden tab, where Chrome
 * suspends animation frames. In a hidden tab we additionally pump one
 * synchronous scene.render(wallClock) per poll so the real tween runs instead
 * of just waiting for the timeout fallback; a visible tab lets Cesium's own
 * loop render at display rate after our requestRender().
 */
function waitForSceneMode(viewer: Cesium.Viewer, target: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const scene = viewer.scene;
    // Cesium's morph is two sequential tweens (camera, then morphTime). The
    // deadline is deliberately generous (see MORPH_DEADLINE_MS) so a stalled
    // first frame in a visible tab never trips the completeMorph() jump-cut
    // before the real animation lands; the fallback only fires when frames are
    // starved (a hidden tab), where this pump ticks at the 1 s timer clamp.
    const deadline = Date.now() + MORPH_DEADLINE_MS;
    const pump = () => {
      if (viewer.isDestroyed() || scene.isDestroyed?.()) return resolve();
      if (scene.mode === target) return resolve();
      if (Date.now() > deadline) {
        scene.completeMorph();
        scene.requestRender();
        return resolve();
      }
      if (document.visibilityState === 'visible') {
        scene.requestRender();
      } else {
        try {
          // Explicit wall-clock time: the widget clock is frozen while the
          // tab is hidden, but the morph tweens compare against it.
          scene.render(Cesium.JulianDate.now());
        } catch {
          // Lost GL context (hidden tabs can discard it): the deadline above
          // still finishes the morph via completeMorph().
        }
      }
      setTimeout(pump, 50);
    };
    pump();
  });
}

export function setLayer(viewer: Cesium.Viewer, layer: LayerName, top: number): void {
  // Remove *every* existing layer, then add exactly one. Removing only index 0
  // could leave two imagery layers stacked if a previous swap added without
  // removing; imageryLayers.length must be 1 after any number of swaps.
  while (viewer.imageryLayers.length > 0) {
    const existing = viewer.imageryLayers.get(0);
    if (!existing) break;
    viewer.imageryLayers.remove(existing, true);
  }
  viewer.imageryLayers.addImageryProvider(makeProvider(layer, top));
  viewer.scene.requestRender();
}

/**
 * Camera height (m) for a fly-to: four feature diameters, never closer than
 * 20 km (spec §4.3), and always inside the screen-space controller's limits —
 * a 188 m traverse crater would otherwise ask for 753 m, below MIN_H, and
 * Cesium would clamp it silently instead of erroring.
 */
export function flyToHeightMeters(diameterKm: number | null): number {
  const diameter = diameterKm ?? 60;
  return clampHeight(Math.max(20_000, diameter * 1000 * 4));
}

/**
 * Search / pick → camera. Pure maths on the shared moon ellipsoid, so it is
 * unit-testable with a stub viewer; `duration` is the only animation knob.
 */
export function flyToFeature(
  viewer: Cesium.Viewer,
  feature: { coordinates: [number, number]; diameterKm: number | null },
): void {
  const [lon, lat] = feature.coordinates;
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      flyToHeightMeters(feature.diameterKm),
      MOON_ELLIPSOID,
    ),
    duration: 1.4,
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}
