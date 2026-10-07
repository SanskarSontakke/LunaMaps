/**
 * Task 15 — boot diagnostics.
 *
 * Everything here is pure and DOM-free except `hasWebGL2`, so the failure
 * classification the whole unbaked-app path rests on is unit-testable in the
 * node vitest environment (`vitest.config.ts` sets `environment: 'node'`, which
 * is also why `hasWebGL2()` is `false` under test rather than mocked).
 *
 * `runBoot` is the boot ORDER (webgl → manifest → probe) as a plain function with
 * injected dependencies, so `src/test/diagnostics.test.ts` can drive every failure
 * path with a fake and prove which panel the user would see — the one honest way
 * to test this without a scriptable browser tab. It consumes `loadManifest` /
 * `probeAssets` from `src/lib/assets.ts` through those injections rather than
 * importing the network layer, which is what keeps it testable.
 */
import type { Manifest } from '@/types';

export type BootErrorKind = 'webgl' | 'assets' | 'cesiumBase' | 'unknown';

/** The order `MoonMap` boots in. Each step renders a panel on failure. */
export type BootStep = 'webgl' | 'manifest' | 'probe' | 'viewer' | 'labels' | 'picking';

export const BOOT_STEPS: readonly BootStep[] = [
  'webgl',
  'manifest',
  'probe',
  'viewer',
  'labels',
  'picking',
];

export const stepLabel = (step: BootStep): string =>
  ({
    webgl: 'checking for WebGL2',
    manifest: 'loading tiles/manifest.json',
    probe: 'probing baked tiles',
    viewer: 'creating the Cesium viewer',
    labels: 'attaching place names',
    picking: 'attaching map picking',
  })[step];

/**
 * A real WebGL2 probe. Cesium 1.146 requires WebGL2; a canvas that cannot hand
 * out the context is the one failure the app cannot render around, so it has to
 * be checked before anything is fetched.
 */
export function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

/**
 * Classify a boot failure by the text of its message.
 *
 * Order matters: a Cesium worker 404 also contains "404", and a `tiles/...`
 * texture failure also reads like a fetch error, so the more specific patterns
 * go first. `webgl` is checked before `cesiumBase` because Cesium reports a lost
 * or absent context as a `Workers/`-adjacent RuntimeError string in some paths.
 *
 * Non-Error throws are read too (a bare `throw 'manifest.json HTTP 404'` and
 * some Cesium `Resource` failures carry the text in the thrown value itself).
 * Anything that matches no pattern stays `unknown` — this function never
 * invents a category, and `ErrorPanel` shows the raw message in that case.
 */
export function classifyBootError(err: unknown): BootErrorKind {
  const msg =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : err && typeof err === 'object' && 'message' in err && typeof err.message === 'string'
          ? err.message
          : '';
  if (/webgl/i.test(msg)) return 'webgl';
  if (/Workers|Widgets|Assets[\\/]|approximateTerrainHeights/.test(msg)) return 'cesiumBase';
  if (/manifest|tiles[\\/]|HTTP \d{3}|ENOENT/i.test(msg)) return 'assets';
  return 'unknown';
}

/**
 * The command that fixes the missing paths.
 *
 * No manifest means nothing downstream exists to trust, so the whole pipeline is
 * named (fetch the sources, bake the pyramids, build the labels). Missing tiles
 * alone name only the bake — and with the flags `scripts/bake.py` actually
 * accepts (`--top` default 6, `--layer both`), because an invented flag printed
 * as "the exact command" is worse than no command.
 *
 * An empty list is treated as "nothing was probed at all" → the full pipeline.
 */
export function assetCommands(missing: string[]): string {
  const joined = missing.join(' ');
  if (joined === '' || /manifest/.test(joined)) {
    return 'npm run fetch && npm run bake && npm run labels';
  }
  return 'npm run bake -- --top 6 --layer both';
}

export function bootHint(kind: BootErrorKind): string {
  switch (kind) {
    case 'cesiumBase':
      return 'The Cesium static assets were not copied. Run npm run postinstall and confirm public/cesium/Workers/ exists.';
    case 'webgl':
      return 'This app needs WebGL2. Your browser or GPU did not provide it.';
    case 'assets':
      return 'Imagery has not been baked yet. public/tiles/ is git-ignored by design.';
    default:
      return 'Unexpected error. The raw message is shown below.';
  }
}

// ---- the boot order --------------------------------------------------------

/** The message of any thrown value, without pretending one exists. */
export function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err === null || err === undefined) return 'no message';
  if (typeof err === 'object' && 'message' in err && typeof err.message === 'string') {
    return err.message;
  }
  return String(err);
}

/**
 * What the page shows. `assets` is the unbaked path (a `NoAssets` panel naming
 * the paths and the command); `error` is any other failed step (an `ErrorPanel`
 * naming the kind and the hint). Neither is a latch: `runBoot` may be re-run and
 * return a different state, which is what makes every failure retryable.
 */
export type BootState =
  | { phase: 'booting' }
  | { phase: 'ready'; manifest: Manifest }
  | { phase: 'assets'; missing: string[] }
  | { phase: 'error'; step: BootStep; kind: BootErrorKind; message: string };

/** The `error` arm of `BootState`, named so consumers can hold just that. */
export type BootErrorState = Extract<BootState, { phase: 'error' }>;

/** One failed step, in the shape `BootState` and the retry banner both render. */
export function bootFailure(step: BootStep, err: unknown): BootErrorState {
  return {
    phase: 'error',
    step,
    kind: classifyBootError(err),
    message: rawMessage(err),
  };
}

/** The subset of `Probe` (src/lib/assets.ts) the boot order reads. */
export interface ProbeResult {
  path: string;
  ok: boolean;
}

export interface BootDeps {
  hasWebGL2: () => boolean;
  loadManifest: () => Promise<Manifest>;
  probeAssets: (m: Manifest) => Promise<ProbeResult[]>;
}

/**
 * Steps 1–3 of the boot order. Steps 4–6 (viewer, labels, picking) need a DOM and
 * Cesium, so they live in `MoonMap` and report through `bootFailure`.
 *
 * It resolves a state for every outcome and therefore never rejects: a boot that
 * falls over must produce a panel, not an unhandled rejection.
 *
 * Manifest routing: an asset-classified manifest failure is the unbaked case
 * (the message is `manifest.json HTTP 404`, or a text throw naming the path), so
 * it gets `NoAssets`. A manifest that exists but does not match this build is a
 * pipeline/version mismatch, not missing imagery — that stays on the error panel
 * with the real message instead of telling the user to bake again.
 */
export async function runBoot(deps: BootDeps): Promise<BootState> {
  if (!deps.hasWebGL2()) {
    return {
      phase: 'error',
      step: 'webgl',
      kind: 'webgl',
      message: 'WebGL2 context is not available in this browser.',
    };
  }
  let manifest: Manifest;
  try {
    manifest = await deps.loadManifest();
  } catch (e: unknown) {
    const kind = classifyBootError(e);
    if (kind === 'assets' && !/not compatible/i.test(rawMessage(e))) {
      return { phase: 'assets', missing: ['tiles/manifest.json'] };
    }
    return bootFailure('manifest', e);
  }
  let missing: string[];
  try {
    const probes = await deps.probeAssets(manifest);
    missing = probes.filter((p) => !p.ok).map((p) => p.path);
  } catch (e: unknown) {
    return bootFailure('probe', e);
  }
  if (missing.length > 0) return { phase: 'assets', missing };
  return { phase: 'ready', manifest };
}

// ---- runtime per-tile failures ---------------------------------------------
//
// Design §4.4 asks for individual tile 404s to be "counted and logged, surfaced
// in a dev overlay". The plan sketched that as a `tileErrors()` counter, but a
// counter is only honest if every increment comes from an event that really
// happened. Cesium 1.146 does raise one: `ImageryLayer.errorEvent` fires with a
// `TileProviderError` carrying `level`, `x`, `y` and `message`. So this is real
// capture — the tally only ever reports what `observe` was handed — and there is
// no fallback number, no sampling estimate and no per-frame guessing.

export interface TileFailure {
  /** `L{level}/{x}/{y}` when Cesium named the tile, otherwise null. */
  tile: string | null;
  level: number | null;
  x: number | null;
  y: number | null;
  message: string;
  /** `now()` at the moment of the event (ms). */
  at: number;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Turn whatever Cesium threw into a record. Unknown-shaped errors keep their
 * message and simply report no tile — nothing here fabricates coordinates.
 */
export function parseTileFailure(err: unknown, at: number = Date.now()): TileFailure {
  const o = (err ?? {}) as { level?: unknown; x?: unknown; y?: unknown; message?: unknown };
  const level = num(o.level);
  const x = num(o.x);
  const y = num(o.y);
  const message =
    typeof o.message === 'string' && o.message !== ''
      ? o.message
      : err === null || err === undefined
        ? String(err)
        : String(err);
  return {
    tile: level !== null && x !== null && y !== null ? `L${level}/${x}/${y}` : null,
    level,
    x,
    y,
    message,
    at,
  };
}

export interface TileErrorTally {
  /** Record one real Cesium imagery error. */
  observe(err: unknown): void;
  /** How many errors were actually observed. */
  total(): number;
  /** Newest first, capped by `cap` so a broken pyramid cannot grow forever. */
  recent(limit?: number): TileFailure[];
  /** Forget everything (called on retry, so a new attempt inherits no old count). */
  reset(): void;
}

export function createTileErrorTally(cap = 24, now: () => number = Date.now): TileErrorTally {
  const seen: TileFailure[] = [];
  let total = 0;
  return {
    observe(err: unknown) {
      total += 1;
      seen.unshift(parseTileFailure(err, now()));
      if (seen.length > cap) seen.length = cap;
    },
    total: () => total,
    recent: (limit = 5) => seen.slice(0, limit),
    reset() {
      seen.length = 0;
      total = 0;
    },
  };
}
