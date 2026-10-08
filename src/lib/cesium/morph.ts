import * as Cesium from 'cesium';
import type { LayerName, Mode } from '@/types';
import {
  MAX_H,
  MIN_H,
  MOON_ELLIPSOID,
  baseColorFor,
  clampHeight,
  makeProvider,
} from './moon';

// The height limits and the height clamp are defined once in moon.ts (where the
// screen-space controller is configured) and re-exported here so callers and
// tests keep importing them from morph.ts without a second, drifting copy.
export { MAX_H, MIN_H, clampHeight };
/** Duration passed to Cesium's scene morph, in seconds. */
export const MORPH_SECONDS = 0.5;
/**
 * Wall-clock ceiling for ONE morph to land on its own before the completeMorph()
 * fallback jump-cuts it. Cesium's morph is two sequential tweens (~2 *
 * MORPH_SECONDS of wall time) and the first frame can stall on tile decode or a
 * GC pause; a deadline close to the morph duration turns that stall into a
 * jump-cut. This sits far above the duration so a *visible* tab always reaches
 * scene.mode === target unaided.
 *
 * What it does NOT do is rescue a tab that cannot render at all. The tweens are
 * advanced by `Scene.initializeFrame()`, which nothing in this app calls except
 * Cesium's own `CesiumWidget.render()` inside the requestAnimationFrame loop; a
 * hidden tab whose animation frames are suspended therefore never advances them
 * on its own, and this deadline is the only exit it has (see `waitForSceneMode`
 * for what the manual pump can and cannot do about that).
 */
export const MORPH_DEADLINE_MS = Math.max(15_000, (2 * MORPH_SECONDS + 12) * 1000);

/**
 * Wall-clock ceiling on a request measured FROM THE MOMENT IT WAS QUEUED, which
 * is what makes it bigger than `MORPH_DEADLINE_MS`: three full morph deadlines —
 * one for the morph already in front of it (which jump-cuts at 15 s), one for
 * this one, and one spare for a tab whose timers are clamped. Anything past that
 * is not a slow morph; it is a frozen head-of-queue, and every later toggle would
 * wait on it forever.
 *
 * The watchdog turns that silent deadlock into a loud, retryable failure: it
 * rejects with `MorphQueueTimeoutError` (a `MorphIncompleteError`), `attemptMode`
 * rolls the latch back, and `MoonMap` renders the rollback as a `role="alert"`
 * with a retry, so the next click works again.
 */
export const MORPH_QUEUE_DEADLINE_MS = 3 * MORPH_DEADLINE_MS;

export interface CameraState {
  lonDeg: number;
  latDeg: number;
  height: number;
  heading: number;
  pitch: number;
}

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
  // The WATCHDOG (`withQueueWatchdog`, defined below) wraps the queued promise
  // and the wrapped promise is what the queue holds, so a frozen head-of-queue
  // times out and releases the requests behind it instead of deadlocking every
  // later toggle.
  const next = withQueueWatchdog(mode, prev ? prev.then(run, run) : run());
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
    // callback). They install two tweens on `scene.tweens`, and that list is
    // updated ONLY by `Scene.initializeFrame()` — which `Scene.render()` does
    // NOT call; its sole caller in the render path is `CesiumWidget.render()`,
    // inside Cesium's requestAnimationFrame loop. See `waitForSceneMode` for
    // what the manual pump can therefore do, and what it cannot.
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

/**
 * A morph request that never even reached the front of the queue — the loud
 * version of the silent deadlock. It IS a `MorphIncompleteError`, so every
 * handler of a failed morph (the latch rollback, the `role="alert"`, the retry)
 * applies unchanged; the distinct class and message say which half is stuck —
 * this queue, not Cesium's transition.
 */
export class MorphQueueTimeoutError extends MorphIncompleteError {
  constructor(mode: Mode, budgetMs: number) {
    super(mode);
    this.name = 'MorphQueueTimeoutError';
    this.message =
      `mode request for ${mode} never reached the front of the morph queue ` +
      `within ${budgetMs} ms — the morph ahead of it is frozen; try again`;
  }
}

/**
 * Put a wall-clock ceiling on a QUEUED morph request, measured from the moment
 * the request was enqueued (`MORPH_QUEUE_DEADLINE_MS`).
 *
 * Why this exists: `setMode` chains each request onto the previous one, so a
 * request whose predecessor never settles is never even *started*, and
 * `waitForSceneMode`'s own deadline lives inside that predecessor — it cannot
 * release anything behind it. Without a watchdog, one frozen morph silently
 * deadlocks every later toggle. With one it degrades loudly, and because the
 * guarded promise is what the queue stores, the follower is actually released.
 *
 * Hidden-tab caveat: `setTimeout` is throttled in a background tab (Chrome
 * clamps hard after a few minutes hidden), so a timer alone cannot be trusted to
 * notice the deadline. The check is therefore a `Date.now()` comparison against
 * an absolute due time, and becoming visible re-arms it immediately — which is
 * also when Cesium's own render loop resumes and the queued morph may land.
 */
export function withQueueWatchdog(
  mode: Mode,
  work: Promise<ModeChange>,
  budgetMs: number = MORPH_QUEUE_DEADLINE_MS,
): Promise<ModeChange> {
  return new Promise<ModeChange>((resolve, reject) => {
    const due = Date.now() + budgetMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    function stop() {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', check);
      }
    }
    function check() {
      if (settled) return;
      if (Date.now() < due) {
        // Re-arm for the remaining time: a clamped timer that fired early here
        // must not be the reason the deadline is missed.
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(check, Math.max(0, due - Date.now()));
        return;
      }
      stop();
      reject(new MorphQueueTimeoutError(mode, budgetMs));
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', check);
    }
    timer = setTimeout(check, budgetMs);
    work.then(
      (change) => {
        stop();
        resolve(change);
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });
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
  // Task 16: the sheet tone. Part of *settling* the mode, so it is covered by the
  // same guard as the tilt and the camera — a scene that never reached `mode`
  // (rejected, or destroyed mid-morph) keeps the colour of what it still shows.
  // The CSS tint rides on the canvas; this is what the engine paints where no tile
  // exists, i.e. the margins around the rectangular world in paper mode.
  scene.globe.baseColor = baseColorFor(mode);
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
 * What the pump can and cannot do, stated against Cesium 1.146 rather than
 * against hope:
 *
 * The viewer runs with `requestRenderMode: true`, so nothing renders until a
 * frame is asked for. A morph's tweens live on `scene.tweens`, and the ONLY
 * thing that advances them is `Scene.initializeFrame()` — verified in 1.146:
 * `initializeFrame` calls `this._tweens.update()`, and `Scene.prototype.render`
 * never calls it. In the render path `initializeFrame` has exactly one caller,
 * `CesiumWidget.prototype.render()` (which then does `clock.tick()` and
 * `scene.render(time)`), and that runs inside Cesium's requestAnimationFrame
 * loop — which a hidden/throttled tab does not tick. So:
 *   - polling `scene.mode` on a `setTimeout` pump is the only thing that still
 *     runs in a hidden tab (an rAF loop would never tick at all), and
 *   - the hidden-tab branch must call `viewer.cesiumWidget.render()`, because
 *     `scene.render(wallClock)` — what this pump used to call — advances nothing:
 *     `scene.mode` stays MORPHING no matter how many of those are made, and the
 *     15 s deadline was then the only exit.
 *
 * Honest limit, in one sentence: `CesiumWidget.render()` starts with
 * `if (this._canRender)`, and Cesium sets `_canRender` from the canvas size
 * (`width !== 0 && height !== 0` in `configureCanvasSize`), so a 0x0 canvas —
 * which is what a headless or hidden harness often has — still cannot animate a
 * morph even with this pump in place. It degrades to the deadline jump-cut, and
 * the `forced` flag is what reports that honestly.
 *
 * It never decides whether the change *succeeded*: it only reports which way it
 * stopped, and `settleMode` re-reads the live scene mode afterwards. Settling a
 * starved morph can take the whole `MORPH_DEADLINE_MS` (15 s), and queuing behind
 * one can take `MORPH_QUEUE_DEADLINE_MS` (45 s) before the watchdog calls it
 * frozen, so any automated sweep must allow more than that per toggle.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    function stop() {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    }
    function finish(wait: MorphWait) {
      stop();
      resolve(wait);
    }
    function pump() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (settled) return;
      if (viewer.isDestroyed() || scene.isDestroyed?.()) {
        return finish({ landed: false, forced: false, tornDown: true });
      }
      if (scene.mode === target) {
        return finish({ landed: true, forced: false, tornDown: false });
      }
      if (Date.now() > deadline) {
        // Force the transition to finish. If that does NOT land the target mode
        // we do not pretend otherwise: `settleMode` re-reads scene.mode and
        // rejects, and MoonMap rolls its latch back so the click can be retried.
        scene.completeMorph();
        scene.requestRender();
        return finish({ landed: false, forced: true, tornDown: false });
      }
      if (document.visibilityState === 'visible') {
        scene.requestRender();
      } else {
        try {
          // The widget's own frame: `initializeFrame()` (which is what updates
          // the morph tweens) + `clock.tick()` + `scene.render(time)`. NOT
          // `scene.render(...)` — see the block comment above for why that
          // advances nothing, and the `_canRender` / 0x0-canvas limit that still
          // applies here.
          viewer.cesiumWidget.render();
        } catch {
          // Lost GL context (hidden tabs can discard it) or a widget already
          // torn down: the deadline above still finishes the morph via
          // completeMorph().
        }
      }
      timer = setTimeout(pump, 50);
    }
    /** Becoming visible is the moment Cesium's rAF loop resumes: check now
     *  instead of waiting out the hidden-tab timer clamp. */
    function onVisibility() {
      pump();
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
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
