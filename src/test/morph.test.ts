import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Cesium from 'cesium';
import {
  MAX_H,
  MIN_H,
  MORPH_DEADLINE_MS,
  MORPH_QUEUE_DEADLINE_MS,
  MORPH_SECONDS,
  MorphIncompleteError,
  MorphQueueTimeoutError,
  clampHeight,
  preserveState,
  setMode,
  settleMode,
  withQueueWatchdog,
  type CameraState,
  type ModeChange,
} from '@/lib/cesium/morph';
import { MAX_H as MOON_MAX_H, MIN_H as MOON_MIN_H, baseColorFor } from '@/lib/cesium/moon';
import type { Mode } from '@/types';

describe('clampHeight', () => {
  it('bounds the camera inside the controller limits', () => {
    expect(MIN_H).toBe(1_500);
    expect(MAX_H).toBe(3.5e7);
    expect(clampHeight(10)).toBe(MIN_H);
    expect(clampHeight(9e7)).toBe(MAX_H);
    expect(clampHeight(5e5)).toBe(5e5);
  });
});

describe('preserveState', () => {
  const s = { lonDeg: 23.4731, latDeg: 0.6746, height: 2e5, heading: 0.4, pitch: -1.2 };
  it('keeps the centre across a mode change', () => {
    const out = preserveState(s, 'paper');
    expect(out.lonDeg).toBeCloseTo(23.4731);
    expect(out.latDeg).toBeCloseTo(0.6746);
  });
  it('forces straight-down, no heading in paper mode', () => {
    const out = preserveState(s, 'paper');
    expect(out.pitch).toBeCloseTo(-Math.PI / 2);
    expect(out.heading).toBe(0);
  });
  it('keeps tilt freedom in globe mode', () => {
    const out = preserveState(s, 'globe');
    expect(out.pitch).toBe(-1.2);
    expect(out.heading).toBe(0.4);
  });
  it('keeps the pole visible instead of clipping it', () => {
    expect(preserveState({ ...s, latDeg: 89.9999 }, 'globe').latDeg).toBeLessThan(90);
  });
  // The vacuous 89.9999 assertion above is plan-verbatim; these strengthen the
  // clamp against values that actually need it, without replacing it.
  it('clamps a genuine over-pole latitude back under 90', () => {
    expect(preserveState({ ...s, latDeg: 95 }, 'globe').latDeg).toBe(89.9999);
    expect(preserveState({ ...s, latDeg: -95 }, 'globe').latDeg).toBe(-89.9999);
  });
});

describe('controller height limits are a single source', () => {
  it('morph re-exports exactly the limits moon.ts configures the controller with', () => {
    expect(MIN_H).toBe(MOON_MIN_H);
    expect(MAX_H).toBe(MOON_MAX_H);
  });
});

describe('morph fallback deadline', () => {
  it('comfortably exceeds the old 4 s so a stalled first frame is not jump-cut', () => {
    // The natural morph is ~2 * MORPH_SECONDS of wall time. The completeMorph()
    // fallback must never preempt a morph that would have landed, so the deadline
    // sits far above both the morph duration and the previous (2*0.5+3) = 4000 ms.
    expect(MORPH_DEADLINE_MS).toBeGreaterThan(2 * MORPH_SECONDS * 1000 + 3_000);
    expect(MORPH_DEADLINE_MS).toBeGreaterThanOrEqual(10_000);
  });
});

const snap: CameraState = {
  lonDeg: 10,
  latDeg: 20,
  height: 5e5,
  heading: 0,
  pitch: -Math.PI / 2,
};

/**
 * A `document` for the pump and the watchdog, which both read
 * `visibilityState` and register a `visibilitychange` listener (the hidden-tab
 * timer clamp is why a listener is required at all). `show()` is how a test
 * becomes visible again and asserts the re-arm.
 */
function stubTab(visibility: 'hidden' | 'visible' = 'hidden') {
  const listeners: Array<() => void> = [];
  const doc = {
    visibilityState: visibility,
    addEventListener: (name: string, fn: () => void) => {
      if (name === 'visibilitychange') listeners.push(fn);
    },
    removeEventListener: (name: string, fn: () => void) => {
      if (name === 'visibilitychange') {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      }
    },
  };
  vi.stubGlobal('document', doc);
  return {
    listenerCount: () => listeners.length,
    show() {
      doc.visibilityState = 'visible';
      listeners.forEach((fn) => fn());
    },
  };
}

function fakeViewer(opts: {
  mode: number;
  destroyed?: boolean;
  sceneDestroyed?: boolean;
}) {
  const calls = { setView: 0, render: 0 };
  const viewer = {
    isDestroyed: () => !!opts.destroyed,
    scene: {
      mode: opts.mode,
      isDestroyed: () => !!opts.sceneDestroyed,
      screenSpaceCameraController: { enableTilt: true },
      // Task 16: `settleMode` paints the globe itself, so the fake has to carry
      // the field it writes. The sentinel is what the untouched tests assert on.
      globe: { baseColor: 'untouched' as unknown as Cesium.Color },
      requestRender: () => {
        calls.render += 1;
      },
    },
    camera: {
      setView: () => {
        calls.setView += 1;
      },
    },
  };
  return {
    viewer: viewer as unknown as Cesium.Viewer,
    scene: viewer.scene,
    calls,
  };
}

describe('settleMode post-morph guard', () => {
  it('applies tilt + setView + render when the scene reached the target', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, scene, calls } = fakeViewer({ mode: target });
    settleMode(viewer, 'paper', target, snap);
    expect(calls.setView).toBe(1);
    expect(calls.render).toBe(1);
    expect(scene.screenSpaceCameraController.enableTilt).toBe(false);
  });

  it('enables tilt when it reaches globe mode', () => {
    const target = Cesium.SceneMode.SCENE3D;
    const { viewer, scene, calls } = fakeViewer({ mode: target });
    settleMode(viewer, 'globe', target, snap);
    expect(scene.screenSpaceCameraController.enableTilt).toBe(true);
    expect(calls.setView).toBe(1);
  });

  it('bails out silently when the viewer was destroyed during the morph', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, scene, calls } = fakeViewer({ mode: target, destroyed: true });
    expect(() => settleMode(viewer, 'paper', target, snap)).not.toThrow();
    expect(calls.setView).toBe(0);
    expect(calls.render).toBe(0);
    // untouched: no write to the controller of a torn-down scene
    expect(scene.screenSpaceCameraController.enableTilt).toBe(true);
  });

  it('bails out silently when the scene was destroyed during the morph', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, calls } = fakeViewer({ mode: target, sceneDestroyed: true });
    expect(() => settleMode(viewer, 'paper', target, snap)).not.toThrow();
    expect(calls.setView).toBe(0);
  });

  it('rejects when the scene never reached the target, without applying', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, calls } = fakeViewer({ mode: Cesium.SceneMode.SCENE3D });
    expect(() => settleMode(viewer, 'paper', target, snap)).toThrow(
      MorphIncompleteError,
    );
    expect(calls.setView).toBe(0);
    expect(calls.render).toBe(0);
  });
});

describe('settleMode outcome reporting', () => {
  it('reports a morph that landed on its own as animated and not forced', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer } = fakeViewer({ mode: target });
    expect(settleMode(viewer, 'paper', target, snap, { landed: true, forced: false, tornDown: false }))
      .toEqual({ mode: 'paper', applied: true, animated: true, forced: false });
  });
  it('reports a deadline-forced jump-cut as applied but NOT animated', () => {
    // The scene really is in the target mode (completeMorph put it there), so the
    // switch succeeded — but nothing animated, and the UI must say so.
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, calls } = fakeViewer({ mode: target });
    const out = settleMode(viewer, 'paper', target, snap, { landed: false, forced: true, tornDown: false });
    expect(out).toEqual({ mode: 'paper', applied: true, animated: false, forced: true });
    expect(calls.setView).toBe(1);
  });
  it('reports a wait that ended in teardown as not applied', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, calls } = fakeViewer({ mode: Cesium.SceneMode.SCENE3D });
    expect(settleMode(viewer, 'paper', target, snap, { landed: false, forced: false, tornDown: true }))
      .toEqual({ mode: 'paper', applied: false, animated: false, forced: false });
    expect(calls.setView).toBe(0);
  });
});

/**
 * Task 16: the globe base colour is part of settling a mode, not an extra pass.
 *
 * `scene.globe.baseColor` is what shows wherever no tile is loaded — in paper
 * mode that is the band around the rectangular world, so a mode that landed
 * without repainting the globe reads as a sheet with a dark hole in it. It is
 * asserted on the SAME guard as everything else in `settleMode`: a torn-down or
 * never-landed scene must not be written to at all.
 */
describe('settleMode paints the globe base colour for the mode', () => {
  it('paints the paper tone when the scene reached paper', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, scene } = fakeViewer({ mode: target });
    settleMode(viewer, 'paper', target, snap);
    expect(scene.globe.baseColor).toEqual(baseColorFor('paper'));
  });

  it('paints the void tone back when the scene reached globe', () => {
    const target = Cesium.SceneMode.SCENE3D;
    const { viewer, scene } = fakeViewer({ mode: target });
    scene.globe.baseColor = baseColorFor('paper');
    settleMode(viewer, 'globe', target, snap);
    expect(scene.globe.baseColor).toEqual(baseColorFor('globe'));
  });

  it('writes nothing when the viewer was destroyed mid-morph', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, scene } = fakeViewer({ mode: target, destroyed: true });
    settleMode(viewer, 'paper', target, snap);
    expect(scene.globe.baseColor).toBe('untouched');
  });

  it('writes nothing when the morph never landed', () => {
    const target = Cesium.SceneMode.SCENE2D;
    const { viewer, scene } = fakeViewer({ mode: Cesium.SceneMode.SCENE3D });
    expect(() => settleMode(viewer, 'paper', target, snap)).toThrow(
      MorphIncompleteError,
    );
    expect(scene.globe.baseColor).toBe('untouched');
  });

  it('the two tones differ, and setMode reaches the paint too', async () => {
    expect(baseColorFor('paper')).not.toEqual(baseColorFor('globe'));
    // End-to-end through the real entry point, not just `settleMode`: this fake
    // lands the morph on the first poll, so the deadline pump is never armed.
    const { viewer } = morphableViewer({
      start: Cesium.SceneMode.SCENE3D,
      morphLands: true,
      completeTo: Cesium.SceneMode.SCENE2D,
    });
    const out = await setMode(viewer, 'paper');
    expect(out.applied).toBe(true);
    const { globe } = viewer.scene as unknown as {
      globe: { baseColor: Cesium.Color };
    };
    expect(globe.baseColor).toEqual(baseColorFor('paper'));
  });
});

/**
 * A viewer whose scene can be mid-morph, with the two behaviours the deadline
 * path depends on: morphToX leaves MORPHING (a hidden tab never advances the
 * tweens) and completeMorph lands wherever the *running* transition was headed —
 * which is not necessarily the mode we just asked for.
 *
 * It also counts the two render entry points, because that distinction IS the
 * bug this file pins: morph tweens advance only under `Scene.initializeFrame()`,
 * whose only caller in the render path is `CesiumWidget.render()`. `scene.render`
 * is here solely so a test can prove the pump no longer calls it.
 */
function morphableViewer(opts: {
  start: number;
  morphLands: boolean;
  completeTo: number;
}) {
  const stats = { sceneRender: 0, widgetRender: 0, completeMorph: 0, requestRender: 0 };
  const scene = {
    mode: opts.start,
    isDestroyed: () => false,
    morphTo2D: () => {
      scene.mode = Cesium.SceneMode.MORPHING;
      if (opts.morphLands) scene.mode = Cesium.SceneMode.SCENE2D;
    },
    morphTo3D: () => {
      scene.mode = Cesium.SceneMode.MORPHING;
      if (opts.morphLands) scene.mode = Cesium.SceneMode.SCENE3D;
    },
    completeMorph: () => {
      stats.completeMorph += 1;
      scene.mode = opts.completeTo;
    },
    requestRender: () => {
      stats.requestRender += 1;
    },
    render: () => {
      stats.sceneRender += 1;
    },
    screenSpaceCameraController: { enableTilt: true },
    globe: { baseColor: 'untouched' as unknown as Cesium.Color },
  };
  const viewer = {
    isDestroyed: () => false,
    scene,
    cesiumWidget: {
      render: () => {
        stats.widgetRender += 1;
      },
    },
    camera: {
      positionCartographic: { longitude: 0.41, latitude: 0.011, height: 2e5 },
      heading: 0,
      pitch: -1.2,
      setView: () => {},
    },
  };
  return { viewer: viewer as unknown as Cesium.Viewer, stats };
}

async function setModeThroughDeadline(viewer: Cesium.Viewer, mode: Mode) {
  // Capture the outcome synchronously: `setMode` settles while the timers are
  // being advanced, and a rejection with no handler attached yet would surface as
  // an unhandled rejection instead of a test result.
  const run = setMode(viewer, mode).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // The pump re-arms a 50 ms timer per poll; run the whole 15 s deadline out,
  // plus the queue watchdog's own budget so a request that never even started
  // gets its chance to be judged by the deadline rather than by the queue.
  await vi.advanceTimersByTimeAsync(MORPH_DEADLINE_MS + MORPH_QUEUE_DEADLINE_MS);
  return run;
}

describe('the deadline path is reachable through setMode and reported honestly', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('resolves with a forced (non-animated) outcome when completeMorph lands the mode', async () => {
    vi.useFakeTimers();
    // A hidden tab: the pump takes the widget-render branch, which needs `document`.
    stubTab('hidden');
    const { viewer } = morphableViewer({
      start: Cesium.SceneMode.SCENE3D,
      morphLands: false,
      completeTo: Cesium.SceneMode.SCENE2D,
    });
    expect(await setModeThroughDeadline(viewer, 'paper')).toEqual({
      ok: true,
      value: { mode: 'paper', applied: true, animated: false, forced: true },
    });
  });

  it('REJECTS with MorphIncompleteError when even completeMorph leaves the wrong mode', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    // What this pins is the CONTRACT: a wait that ends with the scene still in the
    // wrong mode must reject, not resolve as success — the dead error path the
    // review flagged was dead because the old wait minted success unconditionally.
    // The fake models a `completeMorph()` that does not land the target (Cesium's
    // own completion is gated on an installed `_completeMorph`; see
    // docs/superpowers/specs/verify-10.md for exactly what is proven here and what
    // is only reasoned from Cesium's source).
    const { viewer } = morphableViewer({
      start: Cesium.SceneMode.MORPHING,
      morphLands: false,
      completeTo: Cesium.SceneMode.SCENE3D,
    });
    const out = await setModeThroughDeadline(viewer, 'paper');
    expect(out.ok).toBe(false);
    expect((out as { error: unknown }).error).toBeInstanceOf(MorphIncompleteError);
  });

  /**
   * MUST FIX 1, the pump itself. In Cesium 1.146 the morph tweens are advanced
   * only by `Scene.initializeFrame()`, and `Scene.prototype.render` never calls
   * it — so a hidden tab that pumps `scene.render(now)` keeps `scene.mode` at
   * MORPHING forever and only ever exits through the 15 s jump-cut. The pump has
   * to go through the widget, which is `initializeFrame()` + `clock.tick()` +
   * `scene.render(time)`. These two assertions pin which entry point is called;
   * whether the tween then really lands is a browser fact Task 18 still owes.
   */
  it('hidden-tab pump drives CesiumWidget.render(), the frame that updates the tweens', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    const { viewer, stats } = morphableViewer({
      start: Cesium.SceneMode.SCENE3D,
      morphLands: false,
      completeTo: Cesium.SceneMode.SCENE2D,
    });
    await setModeThroughDeadline(viewer, 'paper');
    expect(stats.widgetRender).toBeGreaterThan(0);
  });

  it('hidden-tab pump never calls scene.render(): that is the pump that did nothing', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    const { viewer, stats } = morphableViewer({
      start: Cesium.SceneMode.SCENE3D,
      morphLands: false,
      completeTo: Cesium.SceneMode.SCENE2D,
    });
    await setModeThroughDeadline(viewer, 'paper');
    expect(stats.sceneRender).toBe(0);
    // And the mode really did not land on its own, which is why the fallback is
    // what reports it: the fake only leaves MORPHING when forced.
    expect(stats.completeMorph).toBe(1);
  });

  it('a visibilitychange re-pumps immediately instead of waiting for the clamped timer', async () => {
    vi.useFakeTimers();
    const tab = stubTab('hidden');
    const { viewer, stats } = morphableViewer({
      start: Cesium.SceneMode.SCENE3D,
      morphLands: false,
      completeTo: Cesium.SceneMode.SCENE2D,
    });
    const run = setMode(viewer, 'paper');
    await vi.advanceTimersByTimeAsync(100);
    expect(stats.widgetRender).toBeGreaterThan(0);
    // Becoming visible re-pumps synchronously: no timer is advanced here, so the
    // only thing that can move a counter is the `visibilitychange` handler. The
    // visible branch asks Cesium's own loop for a frame (`scene.requestRender`).
    const before = stats.requestRender;
    tab.show();
    expect(stats.requestRender).toBeGreaterThan(before);
    // Landing the mode on a later poll settles normally, and the listener is
    // gone again — a leaked `visibilitychange` handler would re-pump forever.
    await vi.advanceTimersByTimeAsync(MORPH_DEADLINE_MS + 1_000);
    expect((await run).forced).toBe(true);
    expect(tab.listenerCount()).toBe(0);
  });
});

/**
 * MUST FIX 1, the queue watchdog. `setMode` chains requests, so a frozen
 * head-of-queue is never even *started* and its own deadline can only release
 * itself — everything behind it would hang silently forever. The watchdog bounds
 * a request from the moment it was QUEUED and rejects with a
 * `MorphIncompleteError` subclass, which is what makes the failure loud (latch
 * rollback + `role="alert"`) and, above all, recoverable.
 */
describe('the morph queue has a wall-clock watchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const landed = (mode: Mode): ModeChange => ({
    mode,
    applied: true,
    animated: true,
    forced: false,
  });

  it('the budget is bigger than one morph deadline: it counts the request ahead', () => {
    expect(MORPH_QUEUE_DEADLINE_MS).toBeGreaterThan(2 * MORPH_DEADLINE_MS);
  });

  it('a request that never reaches the front of the queue rejects loudly', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    const frozen = new Promise<ModeChange>(() => {});
    const guarded = withQueueWatchdog('paper', frozen).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(MORPH_QUEUE_DEADLINE_MS + 1);
    const out = await guarded;
    expect(out.ok).toBe(false);
    const error = (out as { error: unknown }).error;
    // The rollback path keys off MorphIncompleteError, so the subclass is the
    // whole contract: loud for the UI, distinguishable in the message.
    expect(error).toBeInstanceOf(MorphIncompleteError);
    expect(error).toBeInstanceOf(MorphQueueTimeoutError);
    expect((error as Error).message).toContain('front of the morph queue');
  });

  it('a request that settles is never touched by the watchdog, and stops its timer', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    const guarded = withQueueWatchdog('paper', Promise.resolve(landed('paper')));
    expect(await guarded).toEqual(landed('paper'));
    // Well past the budget with a settled request: firing the watchdog now would
    // be a double-settle, and the timer/listener are what `stop()` must release.
    await vi.advanceTimersByTimeAsync(MORPH_QUEUE_DEADLINE_MS * 2);
    expect(await guarded).toEqual(landed('paper'));
  });

  it('a clamped timer cannot hide the deadline: becoming visible re-checks it', async () => {
    vi.useFakeTimers();
    const tab = stubTab('hidden');
    const frozen = new Promise<ModeChange>(() => {});
    const guarded = withQueueWatchdog('paper', frozen, 10_000).catch(
      (e: unknown) => e as Error,
    );
    // Burn the budget on the CLOCK only — the timer has not fired, which is the
    // hidden-tab clamp in miniature. Nothing has rejected yet.
    await vi.advanceTimersByTimeAsync(9_000);
    vi.setSystemTime(Date.now() + 2_000);
    tab.show();
    expect(await guarded).toBeInstanceOf(MorphQueueTimeoutError);
  });

  it('the watchdog releases the queue, so the request behind a frozen one still runs', async () => {
    vi.useFakeTimers();
    stubTab('hidden');
    // The same composition `setMode` builds: a head that never settles, and a
    // follower chained off the GUARDED promise, because the guarded promise is
    // what the queue stores.
    const guarded = withQueueWatchdog('paper', new Promise<ModeChange>(() => {}));
    const follower = guarded.then(
      () => landed('globe'),
      () => landed('globe'),
    );
    const out = follower.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.advanceTimersByTimeAsync(MORPH_QUEUE_DEADLINE_MS + 1);
    // A deadlock leaves this pending; the contract is that it settles.
    expect(await out).toEqual({ ok: true, value: landed('globe') });
  });
});
