import type { Mode } from '@/types';
import { MAX_H, MIN_H } from '@/lib/cesium/moon';

export type CameraAction =
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-n'
  | 'pan-s'
  | 'pan-e'
  | 'pan-w'
  | 'pan-n-fast'
  | 'pan-s-fast'
  | 'pan-e-fast'
  | 'pan-w-fast'
  | 'rotate-left'
  | 'rotate-right';

export function keyAction(
  key: string,
  shift = false,
  inField = false,
): CameraAction | null {
  if (inField) return null;
  switch (key) {
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case 'ArrowUp':
      return shift ? 'pan-n-fast' : 'pan-n';
    case 'ArrowDown':
      return shift ? 'pan-s-fast' : 'pan-s';
    case 'ArrowLeft':
      return shift ? 'pan-w-fast' : 'pan-w';
    case 'ArrowRight':
      return shift ? 'pan-e-fast' : 'pan-e';
    case 'q':
      return 'rotate-left';
    case 'e':
      return 'rotate-right';
    default:
      return null;
  }
}

/** A `Window` or `Document`; typed loosely so the listener is unit-testable. */
export interface KeyboardTarget {
  addEventListener(
    type: 'keydown',
    listener: (event: KeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: 'keydown',
    listener: (event: KeyboardEvent) => void,
  ): void;
}

export interface KeyboardHandlers {
  /** Fired after the camera actually moved (label refresh + scale readout). */
  afterMove?: () => void;
  /** `1` = paper, `2` = globe — the same order the mode toggle lists them in. */
  setMode?: (mode: Mode) => void;
  /** `/` focuses the search field. */
  focusSearch?: () => void;
  /** `Escape` closes the feature card. */
  close?: () => void;
  /**
   * Truthy while the user is typing. Defaults to "document.activeElement is a
   * text field", and is injectable so the inert-while-typing rule is testable
   * without a DOM.
   */
  isTyping?: () => boolean;
}

/** Pan step in metres: 8 % of the camera altitude, with a floor for zoomed-in
 *  views, so one keypress covers the same *fraction* of the screen at any
 *  height. Shift triples it. */
const panStep = (heightM: number) => Math.max(500, heightM * 0.08);
/** Rotation step in radians. */
const ROT_STEP = 0.08;
const FAST = 3;

const defaultIsTyping = () => {
  // No `document` under vitest's node environment: not typing, always.
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    (el as HTMLElement).isContentEditable === true
  );
};

/**
 * Apply one action to the live camera. Returns false when the move was refused
 * — currently only a zoom that would cross the controller's own
 * `minimumZoomDistance` / `maximumZoomDistance`, which programmatic camera
 * moves do *not* enforce (only user input does). A zoom that would only
 * partially overshoot is truncated to the remaining gap, so `+` at 1 700 m
 * still moves the last 200 m instead of silently doing nothing.
 */
function applyAction(
  viewer: { camera: CesiumCamera },
  action: CameraAction,
): boolean {
  const camera = viewer.camera;
  const height = camera.positionCartographic.height;
  const fast = action.endsWith('-fast') ? FAST : 1;
  const base = action.replace('-fast', '');
  const step = panStep(height) * fast;
  switch (base) {
    case 'pan-n':
      camera.moveUp(step);
      return true;
    case 'pan-s':
      camera.moveDown(step);
      return true;
    case 'pan-w':
      camera.moveLeft(step);
      return true;
    case 'pan-e':
      camera.moveRight(step);
      return true;
    case 'rotate-left':
      camera.rotateLeft(ROT_STEP * fast);
      return true;
    case 'rotate-right':
      camera.rotateRight(ROT_STEP * fast);
      return true;
    case 'zoom-in': {
      const amount = Math.min(step, Math.max(0, height - MIN_H));
      if (amount <= 0) return false;
      camera.zoomIn(amount);
      return true;
    }
    case 'zoom-out': {
      const amount = Math.min(step, Math.max(0, MAX_H - height));
      if (amount <= 0) return false;
      camera.zoomOut(amount);
      return true;
    }
    default:
      return false;
  }
}

/** The slice of `Cesium.Camera` this module touches, so a fake can stand in. */
export interface CesiumCamera {
  positionCartographic: { height: number };
  moveUp(amount: number): void;
  moveDown(amount: number): void;
  moveLeft(amount: number): void;
  moveRight(amount: number): void;
  zoomIn(amount: number): void;
  zoomOut(amount: number): void;
  rotateLeft(angle: number): void;
  rotateRight(angle: number): void;
}

/**
 * Keyboard navigation. Returns the removal function.
 *
 * Two things this has to get right that the plan calls out: `preventDefault()`
 * on the keys the *page* would otherwise scroll on, and a
 * `scene.requestRender()` after every move — the viewer runs with
 * `requestRenderMode: true`, so a missing request shows up as a frozen
 * readout rather than an error. While a text field has focus every key is left
 * completely alone (no preventDefault, no camera move), so typing in the search
 * box moves the caret and the field's own Escape handler still closes its list.
 */
export function attachKeyboard(
  target: KeyboardTarget,
  viewer: { camera: CesiumCamera; scene: { requestRender(): void } },
  handlers: KeyboardHandlers = {},
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if ((handlers.isTyping ?? defaultIsTyping)()) return;
    const key = event.key;
    if (key === 'Escape') {
      handlers.close?.();
      return;
    }
    if (key === '1') {
      event.preventDefault();
      handlers.setMode?.('paper');
      return;
    }
    if (key === '2') {
      event.preventDefault();
      handlers.setMode?.('globe');
      return;
    }
    if (key === '/') {
      // Without preventDefault, Firefox opens its quick-find bar instead.
      event.preventDefault();
      handlers.focusSearch?.();
      return;
    }
    const action = keyAction(key, event.shiftKey);
    if (!action) return;
    event.preventDefault();
    if (applyAction(viewer, action)) {
      viewer.scene.requestRender();
      handlers.afterMove?.();
    }
  };
  target.addEventListener('keydown', onKeyDown);
  return () => target.removeEventListener('keydown', onKeyDown);
}
