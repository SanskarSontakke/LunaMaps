import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { attachKeyboard, keyAction, type KeyboardHandlers } from '@/lib/keyboard';
import { MAX_H, MIN_H } from '@/lib/cesium/moon';

describe('keyAction', () => {
  it('maps zoom and pan', () => {
    expect(keyAction('+')).toBe('zoom-in');
    expect(keyAction('=')).toBe('zoom-in');
    expect(keyAction('-')).toBe('zoom-out');
    expect(keyAction('_')).toBe('zoom-out');
    expect(keyAction('ArrowUp')).toBe('pan-n');
    expect(keyAction('ArrowDown')).toBe('pan-s');
    expect(keyAction('ArrowLeft')).toBe('pan-w');
    expect(keyAction('ArrowRight')).toBe('pan-e');
  });
  it('shift pans faster', () => {
    expect(keyAction('ArrowLeft', true)).toBe('pan-w-fast');
    expect(keyAction('ArrowUp', true)).toBe('pan-n-fast');
  });
  it('maps rotation and ignores plain letters', () => {
    expect(keyAction('q')).toBe('rotate-left');
    expect(keyAction('e')).toBe('rotate-right');
    expect(keyAction('a')).toBeNull();
  });
  it('ignores everything while typing in a field', () => {
    expect(keyAction('ArrowLeft', false, true)).toBeNull();
    expect(keyAction('+', false, true)).toBeNull();
  });

  // Extra assertions (Task 13): the keys the *UI* owns must not be camera
  // actions, and modifier chords other than shift must not fire either.
  it('leaves the app chrome keys to their own handlers', () => {
    for (const k of ['1', '2', '/', 'Escape', 'Tab', 'Enter']) {
      expect(keyAction(k)).toBeNull();
    }
    expect(keyAction('ArrowLeft', false, true)).toBeNull();
    expect(keyAction('q', true)).toBe('rotate-left'); // shift only speeds pans
  });
});

/** A stand-in for `window`/`document` that records the single keydown listener. */
function fakeTarget() {
  const listeners: ((e: KeyboardEvent) => void)[] = [];
  return {
    target: {
      addEventListener: (type: string, listener: (e: KeyboardEvent) => void) => {
        if (type === 'keydown') listeners.push(listener);
      },
      removeEventListener: (type: string, listener: (e: KeyboardEvent) => void) => {
        if (type === 'keydown') {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        }
      },
    },
    listeners,
    send(e: { key: string; shiftKey?: boolean }) {
      const prevented: boolean[] = [];
      const event = {
        preventDefault: () => prevented.push(true),
        ...e,
      } as unknown as KeyboardEvent;
      for (const l of [...listeners]) l(event);
      return { prevented: prevented.length > 0 };
    },
  };
}

function fakeViewer(height = 5e5) {
  const calls: string[] = [];
  const state = { height };
  const camera = {
    get positionCartographic() {
      return { height: state.height, latitude: 0.1, longitude: 0.4 };
    },
    moveUp: (a: number) => calls.push(`up ${a.toFixed(1)}`),
    moveDown: (a: number) => calls.push(`down ${a.toFixed(1)}`),
    moveLeft: (a: number) => calls.push(`left ${a.toFixed(1)}`),
    moveRight: (a: number) => calls.push(`right ${a.toFixed(1)}`),
    zoomIn: (a: number) => calls.push(`in ${a.toFixed(1)}`),
    zoomOut: (a: number) => calls.push(`out ${a.toFixed(1)}`),
    rotateLeft: (a: number) => calls.push(`rot-left ${a.toFixed(4)}`),
    rotateRight: (a: number) => calls.push(`rot-right ${a.toFixed(4)}`),
  };
  const viewer = {
    camera,
    scene: {
      requestRender: () => calls.push('render'),
      mode: Cesium.SceneMode.SCENE3D,
    },
  } as unknown as Cesium.Viewer;
  return { viewer, calls, state };
}

function attach(height?: number, handlers: KeyboardHandlers = {}) {
  const t = fakeTarget();
  const v = fakeViewer(height);
  const detach = attachKeyboard(t.target, v.viewer, handlers);
  return { ...t, ...v, detach };
}

describe('attachKeyboard', () => {
  it('registers exactly one keydown listener and detaches it', () => {
    const a = attach();
    expect(a.listeners).toHaveLength(1);
    a.detach();
    expect(a.listeners).toHaveLength(0);
    a.send({ key: 'ArrowUp' });
    expect(a.calls).toEqual([]);
  });

  it('pans, zooms and rotates the camera, then pumps a frame', () => {
    const a = attach(5e5);
    a.send({ key: 'ArrowUp' });
    expect(a.calls.some((c) => c.startsWith('up '))).toBe(true);
    a.send({ key: 'ArrowLeft', shiftKey: true });
    a.send({ key: '+' });
    a.send({ key: '-' });
    a.send({ key: 'q' });
    expect(a.calls.some((c) => c.startsWith('left '))).toBe(true);
    expect(a.calls.some((c) => c.startsWith('in '))).toBe(true);
    expect(a.calls.some((c) => c.startsWith('out '))).toBe(true);
    expect(a.calls.some((c) => c.startsWith('rot-left '))).toBe(true);
    // requestRenderMode viewer: every camera move must ask for its own frame,
    // otherwise the readout and the labels freeze (plan Task 13 Step 5).
    expect(a.calls.filter((c) => c === 'render')).toHaveLength(5);
  });

  it('shift pans three times as far', () => {
    const slow = attach();
    slow.send({ key: 'ArrowRight' });
    const fast = attach();
    fast.send({ key: 'ArrowRight', shiftKey: true });
    const amount = (calls: string[]) =>
      Number(calls.find((c) => c.startsWith('right '))?.split(' ')[1]);
    expect(amount(fast.calls)).toBeCloseTo(amount(slow.calls) * 3, 3);
  });

  it('never drives the camera past the controller limits', () => {
    const deep = attach(MIN_H);
    deep.send({ key: '+' }); // already at minimumZoomDistance
    expect(deep.calls.filter((c) => c.startsWith('in '))).toHaveLength(0);
    const far = attach(MAX_H);
    far.send({ key: '-' });
    expect(far.calls.filter((c) => c.startsWith('out '))).toHaveLength(0);
    // A zoom that would overshoot the floor is truncated to the gap, not skipped.
    const near = attach(MIN_H + 200);
    near.send({ key: '=' });
    const amount = Number(near.calls[0].split(' ')[1]);
    expect(amount).toBeCloseTo(200, 6);
  });

  it('prevents the page from scrolling on the keys that would scroll it', () => {
    const a = attach();
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '-', '_']) {
      expect(a.send({ key }).prevented).toBe(true);
    }
    expect(a.send({ key: 'a' }).prevented).toBe(false);
    expect(a.send({ key: 'z' }).prevented).toBe(false);
  });

  it('is inert while the user is typing, and does not swallow the key', () => {
    const a = attach(5e5, { isTyping: () => true });
    const r = a.send({ key: 'ArrowLeft' });
    expect(a.calls).toEqual([]);
    expect(r.prevented).toBe(false);
    // The search field owns its own arrows and Escape; the camera must not move.
    expect(a.send({ key: 'Escape' }).prevented).toBe(false);
  });

  it('routes the chrome keys to their own handlers', () => {
    const seen: string[] = [];
    const a = attach(5e5, {
      setMode: (m) => seen.push(`mode:${m}`),
      focusSearch: () => seen.push('focus'),
      close: () => seen.push('close'),
      afterMove: () => seen.push('afterMove'),
    });
    a.send({ key: '1' });
    a.send({ key: '2' });
    a.send({ key: '/' });
    a.send({ key: 'Escape' });
    a.send({ key: 'ArrowUp' });
    expect(seen).toEqual([
      'mode:paper',
      'mode:globe',
      'focus',
      'close',
      'afterMove',
    ]);
    expect(a.send({ key: '/' }).prevented).toBe(true); // no quick-find dialog
  });

  it('fires afterMove for camera actions only', () => {
    const seen: string[] = [];
    const a = attach(5e5, { afterMove: () => seen.push('m') });
    a.send({ key: 'ArrowUp' });
    a.send({ key: 'q' });
    a.send({ key: 'a' });
    a.send({ key: '1' });
    expect(seen).toHaveLength(2);
  });
});
