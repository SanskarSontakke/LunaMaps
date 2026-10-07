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
const morphQueue = new WeakMap<Cesium.Viewer, Promise<ModeChange>>();

export function setMode(viewer: Cesium.Viewer, mode: Mode): Promise<ModeChange> {
  const run = () => doSetMode(viewer, mode);
  const prev = morphQueue.get(viewer);
  const next = prev ? prev.then(run, run) : run();
  morphQueue.set(viewer, next);
  return next;
}

async function doSetMode(viewer: Cesium.Viewer, mode: Mode): Promise<ModeChange> {
  if (viewer.isDestroyed()) return NOT_APPLIED(mode);
  const scene = viewer.scene;
  const target = mode === 'globe' ? Cesium.SceneMode.SCENE3D : Cesium.SceneMode.SCENE2D;
  const snap = preserveState(getCameraState(viewer), mode);
  if (scene.mode === Cesium.SceneMode.MORPHING) scene.completeMorph();
  let wait: MorphWait = LANDED;
  if (scene.mode !== target) {
    // The morph methods live on Scene, not Camera (verified against 1.146:
    // Scene.morphTo2D(duration) / morphTo3D(duration) take no completion
    // callback and resolve the transition through tweens driven inside
    // Scene.render).
    if (mode === 'globe') scene.morphTo3D(MORPH_SECONDS);
    else scene.morphTo2D(MORPH_SECONDS);
    wait = await waitForSceneMode(viewer, target);
  }
  // waitForSceneMode can resolve on destroy (teardown) or on the fallback
  // deadline. settleMode re-checks the *live* scene mode before touching the
  // controller either way, so a torn-down viewer is left alone, a jump-cut is
  // reported as `forced` instead of as an animated morph, and a morph that even
  // completeMorph() could not land rejects (and stays retryable) instead of
  // half-applying onto a wrong scene.
  return settleMode(viewer, mode, target, snap, wait);
}

/** Thrown by `settleMode` when the scene did not reach the requested mode.
 *  MoonMap rolls its mode latch back on rejection, surfaces the failure, and so
 *  keeps the switch retryable. */
export class MorphIncompleteError extends Error {
  constructor(mode: Mode) {
    super(`scene never reached ${mode} mode; try again`);
    this.name = 'MorphIncompleteError';
  }
}

/** What `waitForSceneMode` saw while the transition was running. */
export interface MorphWait {
  /** `scene.mode === target` was reached without the deadline fallback. */
  landed: boolean;
  /** The deadline fired and `completeMorph()` jump-cut the rest. */
  forced: boolean;
  /** The viewer/scene was destroyed while waiting (teardown, not a failure). */
  tornDown: boolean;
}

const LANDED: MorphWait = { landed: true, forced: false, tornDown: false };

/** What a mode-change request actually achieved — the honest answer the caller
 *  (and the UI) has to report. */
export interface ModeChange {
  mode: Mode;
  /** False only when the viewer was destroyed mid-flight: nothing was applied. */
  applied: boolean;
  /** The transition was not cut short by the deadline fallback. When the scene
   *  was already in `mode` no morph ran at all, and both flags are vacuous. */
  animated: boolean;
  /** True when `completeMorph()` jump-cut the transition at the deadline. The
   *  scene IS in `mode`, but the user never saw it animate — Task 18's sweep
   *  reads this instead of monkey-patching `scene.completeMorph`. */
  forced: boolean;
}

const NOT_APPLIED = (mode: Mode): ModeChange => ({
  mode,
  applied: false,
  animated: false,
  forced: false,
});

/**
 * The synchronous tail of a mode change, run after the morph has been awaited.
 * Kept free of any DOM/timer dependency so it is unit-testable with a plain
 * fake viewer (the await in `doSetMode` is what needs a real tab).
 *  - tornDown / viewer / scene destroyed: teardown, not a failed switch —
 *    report `applied: false` and write nothing (there is no scene to retry onto).
 *  - scene.mode !== target: even the forced completion failed to land the mode
 *    (Cesium's morphToX called during MORPHING returns without starting the new
 *    transition), so throw — this is the one case that is genuinely not a
 *    success, and it is reachable through `setMode` (see morph.test.ts).
 *  - otherwise: apply tilt + setView + requestRender, reporting `forced` for
 *    whatever the wait had to jump-cut.
 */
export function settleMode(
  viewer: Cesium.Viewer,
  mode: Mode,
  target: number,
  snap: CameraState,
  wait: MorphWait = LANDED,
): ModeChange {
  if (wait.tornDown || viewer.isDestroyed() || viewer.scene.isDestroyed?.()) {
    return NOT_APPLIED(mode);
  }
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
  return { mode, applied: true, animated: !wait.forced, forced: wait.forced };
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
 *
 * It never decides whether the change *succeeded*: it only reports which way it
 * stopped, and `settleMode` re-reads the live scene mode afterwards. Settling a
 * starved morph can take the whole `MORPH_DEADLINE_MS` (15 s), so any automated
 * sweep must allow more than that per toggle.
 */
function waitForSceneMode(viewer: Cesium.Viewer, target: number): Promise<MorphWait> {
  return new Promise<MorphWait>((resolve) => {
    const scene = viewer.scene;
    // Cesium's morph is two sequential tweens (camera, then morphTime). The
    // deadline is deliberately generous (see MORPH_DEADLINE_MS) so a stalled
    // first frame in a visible tab never trips the completeMorph() jump-cut
    // before the real animation lands; the fallback only fires when frames are
    // starved (a hidden tab), where this pump ticks at the 1 s timer clamp.
    const deadline = Date.now() + MORPH_DEADLINE_MS;
    const pump = () => {
      if (viewer.isDestroyed() || scene.isDestroyed?.()) {
        return resolve({ landed: false, forced: false, tornDown: true });
      }
      if (scene.mode === target) {
        return resolve({ landed: true, forced: false, tornDown: false });
      }
      if (Date.now() > deadline) {
        // Force the transition to finish. If that does NOT land the target mode
        // we do not pretend otherwise: `settleMode` re-reads scene.mode and
        // rejects, and MoonMap rolls its latch back so the click can be retried.
        scene.completeMorph();
        scene.requestRender();
        return resolve({ landed: false, forced: true, tornDown: false });
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
