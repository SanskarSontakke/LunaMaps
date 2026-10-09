/**
 * Where the delivered imagery lives — one code path, two deployments.
 *
 * The project was built **local-first**: `public/tiles/**` is baked on this machine by
 * `npm run bake` / `npm run bake:deep`, it is gitignored because it is build output
 * (87,380 tiles and 2.82 GB do not belong in a repository), and the app reads it from
 * the same origin as the code at `/tiles`. That remains the default, with no
 * configuration and no network egress.
 *
 * Static hosting needs one thing changed: the pyramid cannot ride in the bundle, so it
 * is served from an object store or CDN and its prefix is baked into the client at
 * build time through `NEXT_PUBLIC_TILE_BASE_URL`. The prefix is a *build-time* constant
 * on purpose — Cesium's `UrlTemplateImageryProvider` builds request URLs from a string
 * template, and `Resource` sets `crossOrigin` itself only when it can see the URL is
 * cross-origin (`@cesium/engine/Source/Core/Resource.js:1017-1027`), which means the
 * value has to be resolved before the template is assembled, not per request.
 *
 * What that requires of the store, stated here because nothing in the code can check
 * it: **it must send `Access-Control-Allow-Origin`** for the tile requests, or every
 * texture upload fails and the map renders an empty globe. Long `Cache-Control` is
 * strongly advised — a tile URL is immutable content behind an immutable name.
 *
 * Every path the app asks the network for comes from this file: `assets.ts` for the
 * manifest and the boot probes, `moon.ts` and `ortho.ts` for the imagery templates, and
 * `orthoProbePaths` for the "is the deep layer actually here" check. A hardcoded
 * `/tiles/...` anywhere else would be a second answer to the same question.
 */

/** The one environment variable this layer reads. Inlined by Next at build time. */
export const TILE_BASE_ENV = 'NEXT_PUBLIC_TILE_BASE_URL';

/** Same-origin, gitignored, baked locally: the state the project was designed in. */
export const LOCAL_TILES_BASE = '/tiles';

/**
 * Normalise an operator-supplied base, or fall back to the local one.
 *
 * Accepted: nothing (local), a root-relative path (`/tiles`, `/assets/tiles`), or an
 * `https://` origin with optional path. Everything else falls back to local and says so
 * — a typo that silently turns the map into 404s is worse than a loud one, and the two
 * rejected cases matter specifically: `http:` under an `https:` page is mixed content
 * and would be blocked by the browser mid-render, and any other scheme can be smuggled
 * into a `<img>`/`<a>` path.
 */
export function resolveTilesBase(raw: string | undefined | ''): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  if (value === '') return LOCAL_TILES_BASE;
  if (value.startsWith('/')) return value;
  if (value.startsWith('https://') && value.length > 'https://'.length) return value;
  if (typeof console !== 'undefined') {
    console.warn(
      `[tiles] ignoring ${TILE_BASE_ENV}=${JSON.stringify(raw)}: expected a root-relative ` +
        `path or an https:// URL. Serving from ${LOCAL_TILES_BASE} instead.`,
    );
  }
  return LOCAL_TILES_BASE;
}

/**
 * The resolved base, once. `process.env.NEXT_PUBLIC_TILE_BASE_URL` is written out
 * literally rather than through `TILE_BASE_ENV` because Next inlines that exact
 * expression at build time — a computed key would survive to runtime as `undefined`.
 */
export const TILES_BASE: string = resolveTilesBase(process.env.NEXT_PUBLIC_TILE_BASE_URL);

/** True when imagery is expected from somewhere other than this origin's `/tiles`. */
export const tilesAreRemote = (): boolean => TILES_BASE !== LOCAL_TILES_BASE;

export const manifestUrl = (): string => `${TILES_BASE}/manifest.json`;

/** A tile's URL. Same layout `scripts/grid.py`'s `tile_path` and `bake.save_tile` write. */
export const tilePath = (layer: string, level: number, x: number, y: number): string =>
  `${TILES_BASE}/${layer}/${level}/${x}/${y}.jpg`;

/** Cesium's template form, with its own `{z}/{x}/{y}` placeholders. */
export const tileTemplate = (layer: string): string =>
  `${TILES_BASE}/${layer}/{z}/{x}/{y}.jpg`;
