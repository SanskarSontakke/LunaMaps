import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, TILE_SIZE } from './moon';
import { tilePath, tileTemplate } from '@/lib/tileSource';
import { MAX_TOP_LEVEL, levelCols, levelRows, mPerPx } from '@/lib/grid';
import type { Availability, TileRange } from '@/types';

/**
 * The overlay's own attribution, because these pixels are not LROC's.
 *
 * `moon.ts`'s `CREDIT` names the three products the *baked* layers come from, and
 * `ortho` is none of them: its tiles are the Kaguya TC orthomosaic — SELENE/Kaguya
 * Terrain Camera, JAXA — range-read out of the COG USGS Astrogeology serves at
 * `asc-pds-services` (`regions.SOURCES['kaguya-tc'].url`, whose bytes were streamed,
 * never downloaded, so it is absent from `data/raw/sha256.json` and therefore from the
 * manifest's `sources` too). Per-tile credit that names a different mission than the
 * imagery is not a formatting slip, it is a citation error.
 *
 * The Task-2 ruling "CREDIT is the single attribution source" was made for two layers
 * that genuinely shared one provenance; the whole-branch review re-ruled it for a
 * fourth source, and `ortho.test.ts` now pins that the overlay does not carry the WAC
 * string.
 */
export const ORTHO_CREDIT = new Cesium.Credit(
  'Kaguya TC orthomosaic (SELENE/Kaguya Terrain Camera, JAXA) via USGS Astrogeology',
);

/**
 * The deep-zoom `ortho` overlay: L8–L10 JPEGs of a Kaguya TC orthophoto, baked
 * for twelve region boxes into `public/tiles/ortho/` and nowhere else.
 *
 * Two facts decide the shape of this file.
 *
 * 1. **The holes are the layer.** Outside those boxes there is no `ortho` tile at
 *    any level, so the app must never ask for one: this is a local-first build
 *    with no server and no tile endpoint, which means a request for a missing
 *    file is a 404 the user watches as a hole in the map. Availability therefore
 *    comes from the manifest — `layers.ortho.availability`, written from the
 *    tiles actually on disk — and never from a constant, and an absent or empty
 *    block means *unavailable*, never "the whole globe".
 *
 * 2. **Cesium 1.146 does not ask an imagery provider about availability.**
 *    Verified against the installed package rather than from release notes:
 *    `availableTiles` appears in `node_modules/cesium/Source/Cesium.d.ts` zero
 *    times and in `@cesium/engine/Source/` in one *terrain* file only; the
 *    `ImageryProvider` type lists `rectangle, tileWidth, tileHeight, maximumLevel,
 *    minimumLevel, tilingScheme, tileDiscardPolicy, errorEvent, credit, proxy,
 *    hasAlphaChannel, getTileCredits, requestImage, pickFeatures` and nothing
 *    else. `ImageryLayer._createTileImagerySkeletons` intersects the tile with
 *    ONE rectangle (`provider.rectangle ∩ layer.rectangle`) and then requests
 *    every tile in the level-clamped block. Twelve disjoint boxes — landing sites,
 *    maria, craters and rilles scattered from −43° to +43° and across 180° of
 *    longitude — are not expressible as one rectangle, so the gate has to live in
 *    `requestImage` itself.
 *
 * So the hole geometry is expressed once — `isTileAvailable` / `availableTiles`,
 * both reading the same `Availability` — and consumed twice: `availableTiles` is
 * the query (the app's, the tests', and a future Cesium's), and `requestImage`
 * answers from the same predicate before it touches the URL template. A hole
 * resolves to `ORTHO_NO_DATA`, which `tileDiscardPolicy` recognises by identity;
 * that is the path 1.146 marks `ImageryState.INVALID` — "parent imagery will be
 * used instead" — so the base layer beneath renders. Returning `undefined`
 * instead would run `ImageryLayer._requestImagery`'s failure branch and raise a
 * provider error for every single hole tile.
 */

/** Where the baked pyramid lives. `{z}/{x}/{y}` is Cesium's own substitution, and
 *  its `GeographicTilingScheme` gives the same tile grid `scripts/grid.py` does
 *  (`src/test/ortho.test.ts` compares the two instead of assuming it). The prefix is
 *  `src/lib/tileSource.ts`'s answer: `/tiles` for a local build, the configured store
 *  for a deployment whose imagery does not ride in the bundle. */
export const ORTHO_URL_TEMPLATE = tileTemplate('ortho');

/** The layer's name, as it appears in the manifest and on disk. */
export const ORTHO_LAYER_NAME = 'ortho';

/** The levels the deep-zoom source can pay for: L8 (41.6 m/px) through L10
 *  (10.4 m/px). L11 would be interpolation, and the plan rules it out. */
export const ORTHO_MIN_LEVEL = 8;
export const ORTHO_MAX_LEVEL = MAX_TOP_LEVEL;

/**
 * The floor the provider *advertises*, which is deliberately below the floor the
 * data *starts* at.
 *
 * Cesium 1.146 clamps the imagery level it picks for a terrain tile UP to
 * `provider.minimumLevel` (`ImageryLayer.js:814-817`) and then attaches one
 * `TileImagery` for every imagery tile inside that terrain tile's footprint at
 * the clamped level, with no cap on the count (`:958-1045`). Advertising
 * `ORTHO_MIN_LEVEL` therefore takes the app's default whole-disc framing — where
 * the matched terrain level is 0 — and spreads an L8 imagery block over every
 * visible terrain tile: thousands of objects per mid-level tile, up to ~10^5 for
 * a coarse root tile, every one of them a hole the per-tile gate answers anyway.
 * The two base layers never hit this, because `moon.ts` builds them with
 * `minimumLevel: 0`, and Cesium's own docs warn that more than a few tiles at the
 * provider's minimum level leads to rendering problems.
 *
 * `0` costs one sentinel answer per terrain tile instead of a block of them, and
 * the picture is identical: what refuses L0–L7 is availability, not the clamp.
 * The brief asked for `minimumLevel: 8`; the review measured what that costs and
 * the controller ruled against the brief (task-3-findings, Important 2).
 *
 * The condition on that ruling is discharged. Measured live over CDP in four states
 * (driver and both runs are gitignored capture tooling, like everything else here:
 * `work/perf_probe.mjs`, `work/perf-run1.json`, `work/perf-minimumLevel.json`; every
 * count reproduced identically across the two runs): inside a region the overlay is
 * asked for 12 tiles and 12 HTTP requests follow, plus 5 sentinel answers for the
 * L0-L7 terrain tiles; outside every region it is asked for 28 and issues no request
 * at all -- the gate, not the clamp, is what refuses, exactly as argued above.
 * Tiles-to-render is 5 inside and 2 outside with the overlay on or off. SwiftShader
 * frame p50, run 1: 73.3 -> 89.3 ms inside a region (the 12 new 512 px textures) and
 * 78.2 -> 75.5 ms outside; run 2: 74.9 -> 88.7 and 79.2 -> 75.0. Absolute
 * milliseconds are CPU rasterised, not this machine's GPU, and the viewer runs in
 * `requestRenderMode`, so the cost is paid on interaction frames rather than
 * continuously. Zero tile errors in all four states. `0` stays.
 */
const ORTHO_ADVERTISED_MIN_LEVEL = 0;

/**
 * The "there is no tile here" answer. A frozen object rather than a blank canvas
 * because it is never rendered: the discard policy below matches it by identity
 * and Cesium marks the tile INVALID before any texture work, and this build's
 * tests run in a node environment with no `document` to make a canvas from.
 */
export const ORTHO_NO_DATA: Cesium.ImageryTypes = Object.freeze({
  orthoNoData: true,
}) as unknown as Cesium.ImageryTypes;

/**
 * The slice of `Cesium.UrlTemplateImageryProvider` this provider delegates to.
 * `Pick` rather than a hand-written interface, so the real class defines it and a
 * test cannot drift away from what Cesium actually offers.
 */
export type OrthoInner = Pick<
  Cesium.UrlTemplateImageryProvider,
  | 'url'
  | 'rectangle'
  | 'tilingScheme'
  | 'tileWidth'
  | 'tileHeight'
  | 'minimumLevel'
  | 'maximumLevel'
  | 'credit'
  | 'proxy'
  | 'hasAlphaChannel'
  | 'errorEvent'
  | 'getTileCredits'
  | 'requestImage'
  | 'pickFeatures'
>;

/** Cesium's `TileDiscardPolicy`, stated over the types that really reach it. */
export interface OrthoDiscardPolicy {
  isReady(): boolean;
  shouldDiscardImage(image: Cesium.ImageryTypes): boolean;
}

export const orthoTilingScheme = () =>
  new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });

/** The levels an availability block names, ascending. */
export function availabilityLevels(availability: Availability): number[] {
  return Object.keys(availability)
    .map(Number)
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

/**
 * The levels the block actually has data for: named, with at least one range
 * inside that level's grid — the same test `levelRectangles` applies before it
 * builds a rectangle, so the span and the rectangles cannot disagree.
 *
 * This is a different question from `availabilityLevels` ("which levels are
 * named?"), and neither of them may feed a span or a label directly — `orthoLevels`
 * puts this list inside the layer's envelope and that is what everything reads.
 * A level named with an empty list, or with ranges that fall outside the grid, has
 * nothing to show, so advertising it would put a guaranteed-hole level into
 * `maximumLevel` — the one availability signal Cesium 1.146 honours — and into the
 * control's m/px claim.
 * It also cannot be looked up: a non-canonical key such as `'09'` reads as level
 * 9 here but as `availability['9']` (absent) everywhere else, and a level no
 * reader can find is not coverage.
 */
export function levelsWithData(availability: Availability): number[] {
  return availabilityLevels(availability).filter((level) =>
    (availability[String(level)] ?? []).some((range) => rangeIsInGrid(level, range)),
  );
}

/**
 * THE ONE ANSWER TO "WHICH LEVELS DOES THIS LAYER HAVE?": the levels with data
 * (`levelsWithData`) inside the envelope the deep-zoom pyramid was baked for —
 * `ORTHO_MIN_LEVEL`..`cap`, where `cap` is the manifest's own `ortho.top` clamped
 * to the grid's `ORTHO_MAX_LEVEL`.
 *
 * Every consumer of that question reads this function, and only this one: the
 * provider's span, the control's label, and both attach gates. They used to read
 * three different answers — the span filtered to the envelope, the label used
 * bare `levelsWithData` and never saw `top`, and the gate used
 * `isAvailabilityEmpty`, which reads neither — and for a block naming only L7 the
 * label promised "...at L7 - L7" while the envelope refused to serve anything
 * below L8: toggle on, map unchanged. One list makes "what we offer", "what we
 * can draw" and "what the control promises" unquotable separately, which is the
 * only way the promise cannot drift from the service.
 *
 * So `orthoLevels(...).length === 0` IS "unavailable": nothing inside the
 * envelope has rectangles, whether because the block is absent, empty, names
 * levels outside the grid, names levels the record's own `top` forbids, or names
 * levels shallower than this layer.
 */
export function orthoLevels(availability: Availability, top?: number): number[] {
  const cap = Math.min(top ?? ORTHO_MAX_LEVEL, ORTHO_MAX_LEVEL);
  return levelsWithData(availability).filter(
    (level) => level >= ORTHO_MIN_LEVEL && level <= cap,
  );
}

/**
 * Does this block name a rectangle anywhere? A block with no levels, or only
 * levels with no ranges, is empty; emptiness is never resolved by guessing a
 * coverage.
 *
 * This is the envelope-*blind* half of the question. `orthoLevels` adds the
 * L8..`cap` window, and it — not this — decides whether the overlay attaches and
 * what the control promises: a block of only-L7 ranges is not empty, and is still
 * nothing this layer can show.
 */
export function isAvailabilityEmpty(availability: Availability): boolean {
  return Object.values(availability).every((ranges) => ranges.length === 0);
}

/** Does tile `x`/`y` at `level` exist? Inclusive ranges, `y` growing south. */
export function isTileAvailable(
  availability: Availability,
  level: number,
  x: number,
  y: number,
): boolean {
  if (!Number.isInteger(level) || !Number.isInteger(x) || !Number.isInteger(y)) {
    return false;
  }
  const ranges = availability[String(level)];
  if (!ranges) return false;
  return ranges.some(([x0, x1, y0, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
}

/** The grid's own sanity check for a range, kept next to the reader so a
 *  hand-typed fixture cannot name a tile that does not exist. */
export function rangeIsInGrid(level: number, range: TileRange): boolean {
  const [x0, x1, y0, y1] = range;
  return (
    x0 >= 0 &&
    y0 >= 0 &&
    x0 <= x1 &&
    y0 <= y1 &&
    x1 <= levelCols(level) - 1 &&
    y1 <= levelRows(level) - 1
  );
}

/** One merged range → the rectangle it covers, in Cesium's radians. */
function rangeRectangle(
  scheme: Cesium.GeographicTilingScheme,
  level: number,
  [x0, x1, y0, y1]: TileRange,
): Cesium.Rectangle {
  const nw = scheme.tileXYToRectangle(x0, y0, level);
  const se = scheme.tileXYToRectangle(x1, y1, level);
  return new Cesium.Rectangle(nw.west, se.south, se.east, nw.north);
}

export interface OrthoProviderOptions {
  /** From `manifest.layers.ortho.availability`. No fallback, no default. */
  availability: Availability;
  /** `manifest.layers.ortho.top`, the grid cap the manifest was written under. */
  top?: number;
  /** The fetcher. Replaceable so a test can count requests instead of trusting
   *  a comment; the default is a real `UrlTemplateImageryProvider`. */
  inner?: OrthoInner;
}

export interface OrthoImageryProvider {
  readonly layerName: typeof ORTHO_LAYER_NAME;
  readonly availability: Availability;
  readonly inner: OrthoInner;
  readonly rectangle: Cesium.Rectangle;
  readonly tilingScheme: Cesium.TilingScheme;
  readonly tileWidth: number;
  readonly tileHeight: number;
  readonly minimumLevel: number;
  readonly maximumLevel: number;
  readonly credit: Cesium.Credit;
  readonly proxy: Cesium.Proxy;
  readonly hasAlphaChannel: boolean;
  readonly errorEvent: Cesium.Event;
  readonly tileDiscardPolicy: OrthoDiscardPolicy;
  /**
   * The level's available rectangles, intersected with `rectangle`.
   *
   * This is the hole geometry in one expression, and Cesium 1.146 never calls it
   * (see the file header). It is here because the app and the tests ask it
   * directly, because it is the hook a future Cesium uses, and because the
   * gate that 1.146 does consult — `requestImage` — reads the same predicate.
   */
  availableTiles(rectangle: Cesium.Rectangle, level: number): Cesium.Rectangle[];
  getTileCredits(x: number, y: number, level: number): Cesium.Credit[];
  requestImage(
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request,
  ): Promise<Cesium.ImageryTypes> | undefined;
  pickFeatures(
    x: number,
    y: number,
    level: number,
    longitude: number,
    latitude: number,
  ): Promise<Cesium.ImageryLayerFeatureInfo[]> | undefined;
}

export function createOrthoProvider(
  options: OrthoProviderOptions,
): OrthoImageryProvider {
  const availability = options.availability;
  const scheme = orthoTilingScheme();

  // The levels this layer offers, from `orthoLevels` — the one function the span,
  // the attach gates and the control's label all read, so the label cannot quote
  // a level the provider refuses to serve. Naming a level with no rectangles, or
  // one outside the L8..`cap` envelope, would put a guaranteed-hole level into
  // `maximumLevel`, the one availability signal Cesium 1.146 does honour.
  const levels = orthoLevels(availability, options.top);
  // The served floor is `levels[0]`; the *advertised* floor is
  // `ORTHO_ADVERTISED_MIN_LEVEL`, and the two differ on purpose (see there). When
  // the envelope holds nothing the span collapses to that advertised floor:
  // nothing offered, nothing served, and every request answered from availability
  // — it never reaches the URL template, so it can never be a 404.
  const serveFrom = levels.length > 0 ? levels[0] : null;
  const minimumLevel = ORTHO_ADVERTISED_MIN_LEVEL;
  const maximumLevel =
    levels.length > 0 ? levels[levels.length - 1] : ORTHO_ADVERTISED_MIN_LEVEL;
  // The collapse is not a defence against a validator, because there is none:
  // Cesium 1.146 has no "minimumLevel must be no greater than maximumLevel" check
  // anywhere in the installed package — `grep -rIn "no greater than maximum"
  // node_modules/@cesium` returns nothing, and `UrlTemplateImageryProvider.js:197`
  // validates only `options.url` and stores both levels raw. An inverted span
  // would therefore reach `_createTileImagerySkeletons`, which clamps the level
  // DOWN to `maximumLevel` and only then UP to `minimumLevel`
  // (`ImageryLayer.js:809-819`), and would come out requesting `minimumLevel` — a
  // level the provider had just declared it does not have, straight into the URL
  // template, for a file no bake wrote. Nothing catches that, so the construction
  // cannot make one: `minimumLevel` is a constant 0 and `maximumLevel` is either a
  // level from the same ascending list or 0.

  const inner: OrthoInner =
    options.inner ??
    new Cesium.UrlTemplateImageryProvider({
      url: ORTHO_URL_TEMPLATE,
      tilingScheme: scheme,
      tileWidth: TILE_SIZE,
      tileHeight: TILE_SIZE,
      minimumLevel,
      maximumLevel,
      // No rectangle: the coverage is twelve scattered boxes, which is not a
      // rectangle, and the per-tile gate below is what keeps the requests honest.
      rectangle: Cesium.Rectangle.MAX_VALUE,
      credit: ORTHO_CREDIT,
    });

  const errorEvent = new Cesium.Event();
  inner.errorEvent.addEventListener((e: unknown) => errorEvent.raiseEvent(e));

  /** The one span test both consumers read: the manifest's block is the truth
   *  about *where*, the provider's span is the truth about *how deep*. It is the
   *  SERVED span, not the advertised `[minimumLevel, maximumLevel]` pair Cesium
   *  reads — L0–L7 are advertised and never served, because advertising the deep
   *  floor is what would make the renderer expand an L8 block over the whole disc
   *  (`ORTHO_ADVERTISED_MIN_LEVEL`), and a level outside the served span is a
   *  level with no rectangles behind it (`orthoLevels`). */
  const inSpan = (level: number): boolean =>
    serveFrom !== null &&
    Number.isInteger(level) &&
    level >= serveFrom &&
    level <= maximumLevel;

  /** Per-level rectangles, computed once per provider: availability never changes
   *  under a live provider (a new manifest replaces the overlay instead). */
  const rectangles = new Map<number, Cesium.Rectangle[]>();
  const levelRectangles = (level: number): Cesium.Rectangle[] => {
    const cached = rectangles.get(level);
    if (cached) return cached;
    const ranges = availability[String(level)] ?? [];
    const built = ranges
      .filter((r) => rangeIsInGrid(level, r))
      .map((r) => rangeRectangle(scheme, level, r));
    rectangles.set(level, built);
    return built;
  };

  const availableTiles = (
    rectangle: Cesium.Rectangle,
    level: number,
  ): Cesium.Rectangle[] => {
    // A level outside this provider's own span has no coverage by definition,
    // even if the manifest recorded ranges for it: `ortho` is L8–L10, and a
    // deeper or shallower block is data no bake wrote.
    if (!inSpan(level)) return [];
    const out: Cesium.Rectangle[] = [];
    for (const box of levelRectangles(level)) {
      const hit = Cesium.Rectangle.intersection(rectangle, box);
      if (hit) out.push(hit);
    }
    return out;
  };

  const tileDiscardPolicy: OrthoDiscardPolicy = {
    isReady: () => true,
    shouldDiscardImage: (image) => image === ORTHO_NO_DATA,
  };

  return {
    layerName: ORTHO_LAYER_NAME,
    availability,
    inner,
    rectangle: Cesium.Rectangle.MAX_VALUE,
    tilingScheme: scheme,
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel,
    maximumLevel,
    // The single attribution object from moon.ts, never a retyped string.
    credit: ORTHO_CREDIT,
    proxy: inner.proxy,
    hasAlphaChannel: false,
    errorEvent,
    tileDiscardPolicy,
    availableTiles,
    getTileCredits: (x, y, level) => inner.getTileCredits(x, y, level),
    pickFeatures: (x, y, level, longitude, latitude) =>
      inner.pickFeatures(x, y, level, longitude, latitude),
    requestImage: (x, y, level, request) => {
      // THE GATE. Anything outside the span, or outside every recorded rectangle,
      // never reaches the URL template — so it can never be a 404, and never
      // raises the provider error that a resolved-`undefined` would.
      if (!inSpan(level) || !isTileAvailable(availability, level, x, y)) {
        return Promise.resolve(ORTHO_NO_DATA);
      }
      return inner.requestImage(x, y, level, request);
    },
  };
}

export interface OrthoControlCopy {
  title: string;
  gloss: string;
  /** True when there is nothing to overlay, which the control has to say. */
  unavailable: boolean;
}

/**
 * Paths that prove the recorded deep layer is on **this** machine.
 *
 * `public/tiles/*` is gitignored with only `manifest.json` force-added
 * (`.gitignore:46-47`), and `layers.ortho` is carried through a reindex verbatim, so
 * the record and the tree can only ever diverge: a fresh clone has a manifest
 * promising 7,106 deep tiles, `probeAssets` checks three base-layer paths and none of
 * them, and the overlay would attach and 404 inside every box.
 *
 * Two samples per served level -- the near corner of the first rectangle and the far
 * corner of the last -- not one per rectangle: this answers "did the stream run on
 * this machine", which is the question a clone can actually be the wrong answer to. It
 * does NOT promise that all 12 boxes are complete, and nothing short of shipping an
 * index of every tile would; a half-streamed plan still advertises its finished boxes
 * and shows the base layer inside the unfinished ones, which is what the availability
 * gate is for.
 */
export function orthoProbePaths(availability: Availability, top: number): string[] {
  const out: string[] = [];
  for (const level of orthoLevels(availability, top)) {
    const ranges = availability[String(level)] ?? [];
    if (ranges.length === 0) continue;
    const [x0, , , y0] = ranges[0];
    const [, x1, , y1] = ranges[ranges.length - 1];
    out.push(tilePath('ortho', level, x0, y0));
    out.push(tilePath('ortho', level, x1, y1));
  }
  // A level with one rectangle gives the same tile twice; the point is two samples
  // per level where they differ, not two fetches for one file.
  return [...new Set(out)];
}

/**
 * The answer to "is the deep layer actually here?", in one pure function so the
 * routing is testable without a fetch.
 *
 * Any failed sample means no. An empty probe list means no, because callers reach
 * here only when they expected tiles: `[]` is "nothing to check", and treating that as
 * proof would turn a bug in the path builder into a claim that the tree exists.
 */
export function orthoOnDisk(probes: { ok: boolean }[]): boolean {
  return probes.length > 0 && probes.every((p) => p.ok);
}

/**
 * The wording that names where the overlay's pixels came from, in one place so the
 * control's gloss and the layer's own attribution cannot disagree about it.
 *
 * `source` is the manifest's `layers.ortho.source`, carried through `parseManifest`
 * because a label that recites "Kaguya TC" from a literal stays true only until the day
 * the record names something else — and by then the text is the only thing a user has
 * to go on. An unknown key is named verbatim and its radiometry declared unknown rather
 * than dressed up as this product. `undefined` is today's live case (the caller has not
 * been wired to the record yet) and keeps the shipped wording, which is what the
 * delivered record actually says.
 */
export function orthoSourcePhrase(source?: string): string {
  if (source === undefined || source === 'kaguya-tc') {
    return 'Kaguya TC orthophoto — shaded relief, not albedo';
  }
  return `ortho layer, source ${source} — radiometry not declared by this build`;
}

/**
 * The control's wording, in one exported function so requirement 6 is testable
 * prose rather than JSX nobody reads. It names the source and the radiometry:
 * `ortho` is a **shaded orthophoto**, not illumination-normalised albedo, and a
 * label that let it read like the `paper` layer would be the mixing ban
 * (amendment 2 §2 item 4) broken in the interface.
 *
 * `top` is the record's own ceiling and it is required for the same reason the
 * provider takes it: the label and the span must come from one list. Without it
 * the copy fell back to bare `levelsWithData` and would quote "…at L7 - L7" for a
 * block the L8..`cap` envelope refuses to serve, which is a toggle that attaches
 * an overlay and changes nothing on the map.
 */
export function orthoControlCopy(
  availability: Availability | undefined,
  top?: number,
  onDisk = true,
  sourceKey?: string,
): OrthoControlCopy {
  const levels = availability ? orthoLevels(availability, top) : [];
  // Emptiness is "nothing inside the envelope has a rectangle in it", which is
  // `orthoLevels` answering `[]`: a block with no keys, a key whose list is
  // empty, ranges outside the grid, or levels outside L8..`top` are all the same
  // nothing as far as the user is concerned, and none of them may be described as
  // coverage or quoted as an m/px the bake did not write. The control and the
  // provider's span read this one function, so the label cannot promise a level
  // the provider refuses to serve.
  const empty = levels.length === 0;
  const deepest = levels.length > 0 ? levels[levels.length - 1] : ORTHO_MAX_LEVEL;
  // 10.4 m/px comes from the grid, so the number cannot drift from the pyramid.
  const resolution = `${mPerPx(deepest).toFixed(1)} m/px`;
  const source = orthoSourcePhrase(sourceKey);
  if (empty) {
    return {
      title: 'Deep zoom unavailable',
      // "…the overlay can serve", not "…the manifest records none": a record may
      // name tiles at levels this layer does not have, and this text still has to
      // be true then.
      gloss:
        `${source}: the manifest records no ortho tiles the overlay can serve, so ` +
        'nothing was baked here to request and the overlay stays off.',
      unavailable: true,
    };
  }
  if (!onDisk) {
    // The record names tiles and the tree does not hold them: a clone that has run
    // `npm run bake` but not `npm run bake:deep`, or a partial stream. Saying "the
    // manifest records no ortho tiles" here would be false, and saying nothing would
    // let the user attach an overlay that 404s inside every box.
    return {
      title: 'Deep zoom not on this machine',
      gloss:
        `${source}: the manifest records tiles at ${
          levels.length === 1 ? `L${levels[0]}` : `L${levels[0]}–L${levels[levels.length - 1]}`
        }, but they are not in public/tiles/ortho here. Run npm run bake:deep ` +
        '(streaming the baked boxes out of the Kaguya COG) and then npm run bake:publish.',
      unavailable: true,
    };
  }
  const span =
    levels.length === 1 ? `L${levels[0]}` : `L${levels[0]}–L${levels[levels.length - 1]}`;
  return {
    title: 'Deep zoom (ortho)',
    gloss:
      `${source}, ~${resolution} at L${deepest} · region-limited: only the baked ` +
      `boxes at ${span}, stacked over the current layer. Outside them the layer ` +
      'beneath shows through.',
    unavailable: false,
  };
}
