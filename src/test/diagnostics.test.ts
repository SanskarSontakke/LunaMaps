import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Manifest } from '@/types';
import { ManifestError } from '@/lib/manifestError';
import NoAssets from '@/components/NoAssets';
import ErrorPanel from '@/components/ErrorPanel';
import {
  assetCommands,
  bootFailure,
  bootHint,
  classifyBootError,
  createTileErrorTally,
  hasWebGL2,
  parseTileFailure,
  rawMessage,
  runBoot,
} from '@/lib/diagnostics';

describe('classifyBootError', () => {
  it('recognises a Cesium asset/worker path failure', () => {
    expect(classifyBootError(new Error('Failed to fetch Assets/approximateTerrainHeights.json')))
      .toBe('cesiumBase');
    expect(classifyBootError(new Error('Workers/createTaskProcessorWorker.js 404')))
      .toBe('cesiumBase');
  });
  it('recognises missing baked assets', () => {
    expect(classifyBootError(new Error('manifest.json HTTP 404'))).toBe('assets');
    expect(classifyBootError(new Error('ENOENT: public/tiles/paper'))).toBe('assets');
  });
  it('recognises missing WebGL', () => {
    expect(classifyBootError(new Error('WebGL not supported'))).toBe('webgl');
  });
  it('does not invent a category', () => {
    expect(classifyBootError('x')).toBe('unknown');
    expect(classifyBootError(new Error(''))).toBe('unknown');
  });
  // A thrown non-Error is the realistic case for `fetch` rejections and Cesium
  // RuntimeError strings; the message must still be read, not discarded.
  it('reads the message of a thrown string too', () => {
    expect(classifyBootError('manifest.json HTTP 404')).toBe('assets');
    expect(classifyBootError('WebGL 2.0 context unavailable')).toBe('webgl');
  });
  it('classifies the strings Cesium 1.146 actually throws', () => {
    expect(
      classifyBootError(new Error('Failed to create WebGL context: WebGL 2.0 is not supported')),
    ).toBe('webgl');
    expect(
      classifyBootError(
        new Error(
          'Resource exhausted. Error Creating a texture from /tiles/photo/0/0/0.jpg',
        ),
      ),
    ).toBe('assets');
  });
});

describe('assetCommands', () => {
  it('names the whole pipeline when the manifest is missing', () => {
    const c = assetCommands(['tiles/manifest.json']);
    expect(c).toContain('npm run fetch');
    expect(c).toContain('npm run bake');
    expect(c).toContain('npm run labels');
  });
  it('names only the bake when tiles are missing', () => {
    expect(assetCommands(['tiles/paper/6/3/1.jpg'])).toContain('npm run bake');
  });
  it('keeps the tile-only command to flags bake.py actually accepts', () => {
    expect(assetCommands(['tiles/photo/0/0/0.jpg'])).toBe(
      'npm run bake -- --top 6 --layer both',
    );
  });
  it('names the pipeline for an empty list (nothing was probed at all)', () => {
    expect(assetCommands([])).toContain('npm run fetch');
  });
});

describe('bootHint', () => {
  it('gives every kind its own actionable sentence', () => {
    expect(bootHint('cesiumBase')).toContain('npm run postinstall');
    expect(bootHint('webgl')).toContain('WebGL2');
    expect(bootHint('assets')).toContain('git-ignored');
    expect(bootHint('unknown')).toContain('raw message');
  });
});

// The dev overlay's per-tile counter. `tileErrors` is only allowed to exist
// because these events are REAL: Cesium raises `ImageryLayer.errorEvent` with a
// TileProviderError carrying level/x/y. A counter that reported a made-up number
// would be worse than no counter, so these tests pin it to the events observed.
describe('parseTileFailure', () => {
  it('names the tile when the error carries coordinates', () => {
    const f = parseTileFailure({ level: 6, x: 48, y: 32, message: 'An error occurred while' });
    expect(f.tile).toBe('L6/48/32');
    expect(f.level).toBe(6);
    expect(f.x).toBe(48);
    expect(f.y).toBe(32);
  });
  it('does not invent a tile for a provider-level error', () => {
    const f = parseTileFailure(new Error('Image failed to load'));
    expect(f.tile).toBeNull();
    expect(f.level).toBeNull();
    expect(f.message).toBe('Image failed to load');
  });
  it('survives a null/undefined throw', () => {
    expect(parseTileFailure(null).message).toBe('null');
    expect(parseTileFailure(undefined).tile).toBeNull();
  });
});

describe('createTileErrorTally', () => {
  it('counts exactly the events it was handed', () => {
    const t = createTileErrorTally();
    expect(t.total()).toBe(0);
    t.observe({ level: 0, x: 0, y: 0, message: '404' });
    t.observe({ level: 3, x: 5, y: 1, message: '404' });
    t.observe({ level: 3, x: 5, y: 1, message: '404' });
    expect(t.total()).toBe(3);
  });
  it('reports the most recent failures first and caps its memory', () => {
    const t = createTileErrorTally(2, () => 1);
    t.observe({ level: 1, x: 1, y: 1, message: 'a' });
    t.observe({ level: 2, x: 2, y: 2, message: 'b' });
    t.observe({ level: 3, x: 3, y: 3, message: 'c' });
    expect(t.total()).toBe(3);
    const r = t.recent();
    expect(r.map((f) => f.tile)).toEqual(['L3/3/3', 'L2/2/2']);
  });
  it('reset() zeroes it, so a retry does not inherit the old count', () => {
    const t = createTileErrorTally();
    t.observe({ level: 6, x: 1, y: 1, message: 'x' });
    t.reset();
    expect(t.total()).toBe(0);
    expect(t.recent()).toEqual([]);
  });
});

it('hasWebGL2 is false outside a browser', () => {
  expect(hasWebGL2()).toBe(false);
});

// The boot order itself, with every dependency injected: this is the only place
// the three failure paths are provable without a browser tab (see
// docs/superpowers/specs/verify-15.md for what the sweep still has to do for
// real). `runBoot` never rejects — a step that throws is a state, not a crash.
describe('runBoot', () => {
  // `runBoot` only passes the manifest through, so an opaque object is enough to
  // prove which object ends up in the `ready` state.
  const MANIFEST = { schema: 1 } as unknown as Manifest;
  const deps = (over: Partial<Parameters<typeof runBoot>[0]> = {}) => ({
    hasWebGL2: () => true,
    loadManifest: () => Promise.resolve(MANIFEST),
    probeAssets: (m: Manifest) =>
      Promise.resolve(
        [
          { path: '/tiles/photo/0/0/0.jpg', ok: true },
          { path: '/tiles/paper/6/63/31.jpg', ok: true },
        ].map((p) => ({ ...p, m })),
      ),
    ...over,
  });

  it('renders the WebGL panel when the context is absent, without fetching', () => {
    const loadManifest = vi.fn();
    return runBoot(deps({ hasWebGL2: () => false, loadManifest })).then((s) => {
      expect(s).toEqual({
        phase: 'error',
        step: 'webgl',
        kind: 'webgl',
        message: 'WebGL2 context is not available in this browser.',
      });
      expect(loadManifest).not.toHaveBeenCalled();
    });
  });

  it('sends an absent manifest to the unbaked panel with the whole pipeline', async () => {
    const s = await runBoot(
      deps({
      loadManifest: () =>
        Promise.reject(
          new ManifestError('http', 'manifest.json HTTP 404', {
            status: 404,
            url: '/tiles/manifest.json',
          }),
        ),
    }),
    );
    expect(s).toEqual({ phase: 'assets', missing: ['/tiles/manifest.json'] });
    expect(assetCommands(s.phase === 'assets' ? s.missing : [])).toContain('npm run fetch');
  });

  it('routes by the error type, not by the wording it happens to carry', async () => {
    // The whole finding: this used to be `kind === 'assets' && !/not compatible/i` with
    // the producer's sentence re-typed here. Reword `assets.ts` and every malformed
    // manifest silently became "Imagery has not been baked yet" plus a bake command
    // that cannot fix it. The message below deliberately contains no recognizable word
    // at all: if the routing still lands on the error panel, it is the type deciding.
    const shaped = 'shape does not match';
    const s = await runBoot(
      deps({
        loadManifest: () =>
          Promise.reject(
            new ManifestError('incompatible', shaped, { url: '/tiles/manifest.json' }),
          ),
      }),
    );
    expect(s).toEqual({ phase: 'error', step: 'manifest', kind: 'unknown', message: shaped });

    // Same situation, untyped: the classifier reads "manifest.json" in the text and
    // sends the user to the unbaked-imagery panel with a bake command. That difference
    // is the coupling this removes, written as a pair so a future edit cannot quietly
    // restore it — and it is why `loadManifest` now throws the typed error at all.
    const untyped = await runBoot(
      deps({
        loadManifest: () => Promise.reject(new Error('manifest.json shape does not match')),
      }),
    );
    expect(untyped).toEqual({ phase: 'assets', missing: ['tiles/manifest.json'] });
  });

  it('still routes an untyped fetch failure by its text, which is all there is', async () => {
    // A `fetch` rejection or a Cesium worker 404 arrives untyped, so the classifier
    // stays as the fallback rather than being deleted along with the coupling.
    const s = await runBoot(
      deps({ loadManifest: () => Promise.reject(new Error('manifest.json HTTP 404')) }),
    );
    expect(s).toEqual({ phase: 'assets', missing: ['tiles/manifest.json'] });
  });

  it('names the tile paths the probe could not fetch', async () => {
    const s = await runBoot(
      deps({
        probeAssets: () =>
          Promise.resolve([
            { path: '/tiles/photo/0/0/0.jpg', ok: false },
            { path: '/tiles/paper/6/63/31.jpg', ok: true },
            { path: '/tiles/photo/6/0/31.jpg', ok: false },
          ]),
      }),
    );
    expect(s).toEqual({
      phase: 'assets',
      missing: ['/tiles/photo/0/0/0.jpg', '/tiles/photo/6/0/31.jpg'],
    });
    expect(assetCommands(s.phase === 'assets' ? s.missing : [])).toBe(
      'npm run bake -- --top 6 --layer both',
    );
  });

  it('reports a probe that returns something unusable as a step failure', async () => {
    const s = await runBoot(
      deps({
        probeAssets: () => Promise.resolve('not an array' as never),
      }),
    );
    expect(s.phase).toBe('error');
    expect(s.phase === 'error' && s.step).toBe('probe');
  });

  it('reaches ready with the manifest it loaded, and nothing else', async () => {
    const s = await runBoot(deps());
    expect(s).toEqual({ phase: 'ready', manifest: MANIFEST });
  });

  it('routes a thrown non-Error by its text instead of crashing', async () => {
    const s = await runBoot(
      deps({ loadManifest: () => Promise.reject('no manifest.json at /tiles/') }),
    );
    expect(s).toEqual({ phase: 'assets', missing: ['tiles/manifest.json'] });
  });
});

describe('bootFailure', () => {
  it('labels a viewer-build worker 404 as the cesiumBase path', () => {
    expect(bootFailure('viewer', new Error('Workers/createTaskProcessorWorker.js 404'))).toEqual({
      phase: 'error',
      step: 'viewer',
      kind: 'cesiumBase',
      message: 'Workers/createTaskProcessorWorker.js 404',
    });
  });
  it('labels an unclassifiable step honestly', () => {
    expect(bootFailure('picking', new Error('boom')).kind).toBe('unknown');
    expect(rawMessage(null)).toBe('no message');
  });
});

// The panels themselves, rendered with `react-dom/server` (vitest runs in node;
// see `esbuild.jsx` in vitest.config.ts). What is fed in is exactly what `runBoot`
// and `bootFailure` produced above, so this is the failure path end-to-end minus
// the browser: injected failure -> boot state -> the text the user would read.
describe('failure panels', () => {
  const retry = () => {};

  it('NoAssets names the missing paths, the command and the git-ignore reason', () => {
    const html = renderToStaticMarkup(
      NoAssets({ missing: ['/tiles/photo/0/0/0.jpg', '/tiles/photo/6/0/31.jpg'], onRetry: retry }),
    );
    expect(html).toContain('public/tiles/photo/0/0/0.jpg');
    expect(html).toContain('npm run bake -- --top 6 --layer both');
    expect(html).toContain('git-ignored by design');
    expect(html).toContain('Try again');
  });

  it('NoAssets switches to the whole pipeline when the manifest is what is missing', () => {
    const html = renderToStaticMarkup(
      NoAssets({ missing: ['tiles/manifest.json'], onRetry: retry }),
    );
    expect(html).toContain('npm run fetch &amp;&amp; npm run bake &amp;&amp; npm run labels');
    expect(html).toContain('public/tiles/manifest.json');
  });

  it('ErrorPanel prints the postinstall fix for a missing Cesium asset tree', () => {
    const e = bootFailure('viewer', new Error('Failed to fetch Assets/approximateTerrainHeights.json'));
    const html = renderToStaticMarkup(
      ErrorPanel({ kind: e.kind, step: e.step, message: e.message, onRetry: retry }),
    );
    expect(html).toContain('npm run postinstall');
    expect(html).toContain('public/cesium/Workers/');
    expect(html).toContain('creating the Cesium viewer');
    expect(html).toContain('Try again');
  });

  it('ErrorPanel prints the WebGL truth and nothing invented', () => {
    const html = renderToStaticMarkup(
      ErrorPanel({ kind: 'webgl', step: 'webgl', onRetry: retry }),
    );
    expect(html).toContain('This app needs WebGL2');
    expect(html).toContain('This browser cannot run the map');
  });

  it('ErrorPanel shows the raw message for an unknown failure', () => {
    const e = bootFailure('labels', new Error('Cannot read properties of undefined (reading x)'));
    const html = renderToStaticMarkup(
      ErrorPanel({ kind: e.kind, step: e.step, message: e.message, onRetry: retry }),
    );
    expect(html).toContain('<pre');
    expect(html).toContain('Cannot read properties of undefined (reading x)');
    expect(html).toContain('raw message');
  });
});
