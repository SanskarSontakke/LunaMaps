import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import {
  MAX_H,
  MIN_H,
  MORPH_DEADLINE_MS,
  MORPH_SECONDS,
  MorphIncompleteError,
  clampHeight,
  preserveState,
  settleMode,
  type CameraState,
} from '@/lib/cesium/morph';
import { MAX_H as MOON_MAX_H, MIN_H as MOON_MIN_H } from '@/lib/cesium/moon';

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
