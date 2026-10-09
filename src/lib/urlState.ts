import type { LayerName, Mode } from '@/types';
import { FALLBACK_HOME_HEIGHT, globeFitHeightMeters } from '@/lib/cesium/moon';
import { clampHeight } from '@/lib/cesium/morph';
import type { CameraState } from '@/lib/cesium/morph';

/**
 * Shareable URL state: `#lon/lat/height/mode/layer[/feature]`.
 *
 * Two properties matter more than the format itself, and both are pinned by
 * `src/test/urlState.test.ts`:
 *
 * 1. **Totality.** A URL is user input. Anything unparseable degrades to the
 *    default view instead of throwing — a `URIError` from one bad percent-escape
 *    would otherwise take the whole map down on reload.
 * 2. **A fixed point.** `serialize(parse(serialize(v))) === serialize(v)`. The
 *    two-way sync (camera -> hash on a throttle, hash -> camera on `hashchange`)
 *    only terminates because of this: the value written must read back as the
 *    same value it was written from, or the two directions feed each other.
 */
export interface ViewState {
  lon: number;
  lat: number;
  height: number;
  mode: Mode;
  layer: LayerName;
  feature?: string;
}

/** The fov the default framing assumes: Cesium's own 60° vertical default, the
 *  same value `MoonMap.homeHeight` reads off a perspective frustum and falls
 *  back to when the frustum has no fov (2D/orthographic). */
const DEFAULT_FOV_RAD = Math.PI / 3;

/**
 * The height a URL that carries no camera gets, DERIVED rather than typed.
 *
 * It was `2.2e7` (22,000 km) — the framing gate G3 measured as defect 3: a
 * ~110 px disc in a 564 × 786 canvas, most of the screen black. Amendment 2
 * replaced it for the real HOME view by calling `globeFitHeightMeters` with the
 * live canvas, but a hand-typed short link (`#0/0`, `#0/0/globe/photo`) still
 * landed on the stale literal, because `parseHash` fills an absent height slot
 * from `DEFAULT_VIEW.height`.
 *
 * A URL carries no viewport, so the honest input to that same function is the
 * shape it documents as un-measurable: a square canvas at the default fov, which
 * is exactly the case `moon.ts` exports `FALLBACK_HOME_HEIGHT` for. `src/test/
 * urlState.test.ts` pins this constant against BOTH — the function and the
 * fallback it must equal — plus against the semantic it is supposed to have (the
 * limb of the disc sits at `HOME_MARGIN` of the half-field), so the value cannot
 * be edited back to deep space without a test failing.
 *
 * Rounded to whole metres because `serializeHash` writes whole metres: this makes
 * `DEFAULT_VIEW` its own fixed point under parse/serialize, which the two-way
 * sync depends on.
 */
export const DEFAULT_HEIGHT = Math.round(
  clampHeight(globeFitHeightMeters(1, 1, DEFAULT_FOV_RAD)),
);

/**
 * The whole-disc fallback view, and the string a bare `#` maps to. Deliberately
 * *not* the app's `HOME` (Mare Tranquillitatis at the fitted height): a shared
 * link that omits the camera should show the map centred on the disc's middle,
 * not a random crater, and `MoonMap` keeps its HOME behaviour for a hash that
 * carried nothing (see `wasEmptyHash`).
 */
export const DEFAULT_VIEW: ViewState = {
  lon: 0,
  lat: 0,
  height: DEFAULT_HEIGHT,
  mode: 'globe',
  layer: 'photo',
};

/** Camera -> URL write rate: 4 Hz (see `createUrlSync`). */
export const HASH_SYNC_MS = 250;

const MINUS_INFINITY = -Infinity;

const num = (raw: string | undefined, fallback: number) => {
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

/**
 * `clamp` is written out rather than reusing `preserveState`'s latitude clamp so
 * the URL reader does not depend on morph internals; the *height* clamp is
 * `clampHeight` on purpose — it is the same MIN_H/MAX_H pair the camera
 * controller enforces, so a URL can never ask for a height the scene refuses.
 */
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** `#`-prefixed, one segment per field; the feature is percent-encoded so a
 *  name containing `/` or `#` still occupies exactly one segment. */
export function serializeHash(v: ViewState): string {
  const parts = [
    v.lon.toFixed(5),
    v.lat.toFixed(5),
    // Integer metres: `round-trips a view` (plan Task 14) only passes because
    // height is written whole and `clampHeight` is identity in range. Changing
    // this precision means changing that expectation deliberately.
    String(Math.round(v.height)),
    v.mode,
    v.layer,
  ];
  if (v.feature) parts.push(encodeURIComponent(v.feature));
  return `#${parts.join('/')}`;
}

/**
 * `decodeURIComponent` throws on a lone `%` or a truncated escape — exactly what
 * a hand-edited URL contains. An undecodable feature is dropped (the camera and
 * the view still restore), never propagated.
 */
function decodeFeature(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export function parseHash(hash: string): ViewState {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return { ...DEFAULT_VIEW };
  const [lonRaw, latRaw, height, mode, layer, feature] = raw.split('/');
  const lon = num(lonRaw, NaN);
  const lat = num(latRaw, NaN);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ...DEFAULT_VIEW };
  return {
    // ±89.9999, not ±90: the same latitude guard `preserveState` uses, because a
    // true pole is a degenerate camera position in 2D/3D alike.
    lon: clamp(lon, -180, 180),
    lat: clamp(lat, -89.9999, 89.9999),
    // An absent/blank height slot is the default height, not 0 — 0 m is inside
    // the clamp range and would land the camera on the surface.
    height: clampHeight(num(height, DEFAULT_VIEW.height)),
    mode: mode === 'paper' || mode === 'globe' ? mode : DEFAULT_VIEW.mode,
    // `probe` is a single-level gate fixture, not a shareable product layer.
    layer: layer === 'paper' || layer === 'photo' ? layer : DEFAULT_VIEW.layer,
    feature: decodeFeature(feature),
  };
}

/**
 * Did the hash carry state of its own, or did `parseHash` fall back?
 *
 * The mount path needs this distinction: with a malformed or empty hash the
 * viewer must keep its own HOME framing rather than being flown to
 * `DEFAULT_VIEW`, and the first sync tick then writes the real camera into the
 * URL. Comparing against `DEFAULT_VIEW` instead would make a hand-written URL
 * that spells the default framing out in full (which is exactly what
 * `serializeHash(DEFAULT_VIEW)` produces) look empty, and would silently drop
 * `#0/0` — so the test is "were lon/lat parsed".
 */
export function wasEmptyHash(hash: string): boolean {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return true;
  const [lonRaw, latRaw] = raw.split('/');
  return !Number.isFinite(Number(lonRaw)) || !Number.isFinite(Number(latRaw));
}

/** The camera fields of a `ViewState`, from the live camera plus the app's mode
 *  and selection state. `height` is clamped here so a mid-morph camera (which
 *  Cesium can carry outside the controller limits) never serialises a value the
 *  reader would have to clamp on the way back in. */
export function viewFromCamera(
  camera: Pick<CameraState, 'lonDeg' | 'latDeg' | 'height'>,
  mode: Mode,
  layer: LayerName,
  feature?: string,
): ViewState {
  const view: ViewState = {
    lon: camera.lonDeg,
    lat: camera.latDeg,
    height: clampHeight(camera.height),
    mode,
    layer,
  };
  if (feature) view.feature = feature;
  return view;
}

export interface UrlSyncDeps {
  /** Reads the hash the document holds right now (`window.location.hash`). */
  readHash: () => string;
  /** Writes it without creating a history entry (`history.replaceState`). */
  write: (hash: string) => void;
  /** Injectable clock so the throttle is testable without timers. */
  now?: () => number;
  intervalMs?: number;
}

export interface UrlSync {
  /** Frame-driven path: throttled, then differ-guarded. */
  tick: (view: ViewState) => boolean;
  /** Event-driven path (a selection changed): writes now, guard still applies. */
  flush: (view: ViewState) => boolean;
  /** The last string THIS instance wrote, or null. Lets the `hashchange`
   *  handler tell its own writes (which never fire the event, but may after a
   *  back/forward traversal) from a genuine inbound navigation. */
  lastWritten: () => string | null;
  /** After teardown: every write becomes a no-op. */
  stop: () => void;
}

/**
 * The write side of the two-way sync, as a testable unit (vitest runs in a
 * `node` environment, so this is where the anti-loop proof lives rather than
 * inside `MoonMap`).
 *
 * Both paths reduce to `writeIfChanged`: compare the *serialised string* against
 * what the document holds and write only on a difference. Combined with the
 * fixed-point property above that makes the pair terminating — proven by the
 * "cannot loop" test, which wires a deliberately hostile `hashchange` handler
 * into `write` and requires exactly one write.
 */
export function createUrlSync(deps: UrlSyncDeps): UrlSync {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.intervalMs ?? HASH_SYNC_MS;
  // `-Infinity`, not 0: the first tick after boot must publish the real camera
  // even when it lands inside the first throttle window.
  let last = MINUS_INFINITY;
  let written: string | null = null;
  let stopped = false;

  const writeIfChanged = (view: ViewState): boolean => {
    if (stopped) return false;
    const next = serializeHash(view);
    // The guard is against the DOCUMENT, not against `written`: an external
    // writer (back/forward, a paste into the address bar) changes the document,
    // and re-writing it back would be the loop this function exists to prevent.
    if (next === deps.readHash()) return false;
    written = next;
    deps.write(next);
    return true;
  };

  return {
    tick(view) {
      if (stopped) return false;
      const t = now();
      if (t - last < intervalMs) return false;
      last = t;
      return writeIfChanged(view);
    },
    flush(view) {
      if (stopped) return false;
      last = now();
      return writeIfChanged(view);
    },
    lastWritten: () => written,
    stop() {
      stopped = true;
    },
  };
}
