import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import * as Cesium from 'cesium';
import OrthoControl from '@/components/OrthoControl';
import {
  ORTHO_CREDIT,
  ORTHO_MAX_LEVEL,
  ORTHO_NO_DATA,
  ORTHO_URL_TEMPLATE,
  availabilityLevels,
  createOrthoProvider,
  isAvailabilityEmpty,
  isTileAvailable,
  orthoControlCopy,
  orthoOnDisk,
  orthoProbePaths,
} from '@/lib/cesium/ortho';
import { CREDIT, MOON_ELLIPSOID } from '@/lib/cesium/moon';
import {
  disableOrthoOverlay,
  enableOrthoOverlay,
  orthoOverlayEnabled,
  setLayer,
} from '@/lib/cesium/morph';
import { levelCols, levelRows, tileBounds } from '@/lib/grid';
import type { Availability } from '@/types';

/**
 * THE CONTROLLING FIXTURE, verbatim from the task brief: one merged range at one
 * level — columns 10..12, row 5, inclusive, x growing east and y growing south
 * (row 0 is north), the shape `manifest.validate_availability` accepts.
 *
 * Everything below is measured against this, because it is the only thing the
 * app is allowed to believe about where `/tiles/ortho/**` exists.
 */
const FIXTURE: Availability = { '9': [[10, 12, 5, 5]] };

const scheme = new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID });
const toDeg = 180 / Math.PI;
/** The rectangle Cesium itself gives a tile, so the test and the provider cannot
 *  each hold their own idea of the grid. */
const tileRect = (level: number, x: number, y: number) =>
  scheme.tileXYToRectangle(x, y, level);
const asDeg = (r: Cesium.Rectangle) => ({
  west: r.west * toDeg,
  south: r.south * toDeg,
  east: r.east * toDeg,
  north: r.north * toDeg,
});
const rect = (west: number, south: number, east: number, north: number) =>
  Cesium.Rectangle.fromDegrees(west, south, east, north);
const WHOLE_GLOBE = Cesium.Rectangle.MAX_VALUE;

describe('the ortho tiling scheme is the grid contract, in Cesium’s own coordinates', () => {
  // `src/lib/grid.ts` mirrors `scripts/grid.py`: level L = 2^(L+1) columns x 2^L
  // rows, row 0 at the north, -180..180 / -90..90. If Cesium's GeographicTilingScheme
  // disagreed with that, availability would name the wrong boxes and every range
  // the manifest publishes would become a 404 — so the two are compared here rather
  // than assumed to match.
  it('has the grid’s tile counts and the grid’s tile bounds', () => {
    expect(scheme.getNumberOfXTilesAtLevel(9)).toBe(levelCols(9));
    expect(scheme.getNumberOfYTilesAtLevel(9)).toBe(levelRows(9));
    for (const [x, y] of [
      [10, 5],
      [0, 0],
      [levelCols(9) - 1, levelRows(9) - 1],
    ] as const) {
      const d = asDeg(tileRect(9, x, y));
      const g = tileBounds(9, x, y);
      expect(d.west).toBeCloseTo(g.west, 9);
      expect(d.east).toBeCloseTo(g.east, 9);
      expect(d.north).toBeCloseTo(g.north, 9);
      expect(d.south).toBeCloseTo(g.south, 9);
    }
  });
});

describe('availability: the controlling test (brief requirement 2)', () => {
  const provider = createOrthoProvider({ availability: FIXTURE });

  it('(a) tile 11/5 at L9 is available', () => {
    expect(isTileAvailable(FIXTURE, 9, 11, 5)).toBe(true);
    expect(provider.availableTiles(tileRect(9, 11, 5), 9)).toHaveLength(1);
  });

  it('(b) tile 9/5 at L9 is not available', () => {
    expect(isTileAvailable(FIXTURE, 9, 9, 5)).toBe(false);
    expect(provider.availableTiles(tileRect(9, 9, 5), 9)).toEqual([]);
  });

  it('(c) a rectangle over only the empty half of the globe yields nothing at L9', () => {
    // The fixture box sits at lon -176.484..-175.430, so the eastern half is empty.
    expect(provider.availableTiles(rect(0, -90, 180, 90), 9)).toEqual([]);
    // …and the whole globe is answered by exactly the one box, never by the globe:
    // an "assume everything" fallback would return a full-width rectangle here.
    const whole = provider.availableTiles(WHOLE_GLOBE, 9);
    expect(whole).toHaveLength(1);
    expect(asDeg(whole[0]).west).toBeCloseTo(-176.484375, 9);
    expect(asDeg(whole[0]).east).toBeCloseTo(-175.4296875, 9);
    expect(asDeg(whole[0]).north).toBeCloseTo(88.2421875, 9);
    expect(asDeg(whole[0]).south).toBeCloseTo(87.890625, 9);
  });

  it('(d) levels 8 and 10 are answered from their own rectangles, not level 9’s', () => {
    expect(provider.availableTiles(WHOLE_GLOBE, 8)).toEqual([]);
    expect(provider.availableTiles(WHOLE_GLOBE, 10)).toEqual([]);
    expect(provider.availableTiles(WHOLE_GLOBE, 9)).toHaveLength(1);
    // The same holds for the per-tile predicate and for levels outside the
    // provider’s own span: no level inherits another’s coverage, and none falls
    // back to "the whole world".
    expect(isTileAvailable(FIXTURE, 8, 5, 0)).toBe(false);
    expect(isTileAvailable(FIXTURE, 10, 5, 0)).toBe(false);
    expect(isTileAvailable(FIXTURE, 9, 11, 5)).toBe(true);
    expect(provider.availableTiles(WHOLE_GLOBE, 11)).toEqual([]);
    expect(provider.availableTiles(WHOLE_GLOBE, 7)).toEqual([]);
  });

  it('clips to the queried rectangle instead of handing back the whole box', () => {
    const clipped = provider.availableTiles(rect(-176, 87, -170, 90), 9);
    expect(clipped).toHaveLength(1);
    expect(asDeg(clipped[0]).west).toBeCloseTo(-176, 9);
    expect(asDeg(clipped[0]).east).toBeCloseTo(-175.4296875, 9);
    expect(asDeg(clipped[0]).south).toBeCloseTo(87.890625, 9);
    expect(asDeg(clipped[0]).north).toBeCloseTo(88.2421875, 9);
  });

  it('never re-uses one level’s rectangles for another, with several levels present', () => {
    const many: Availability = {
      '8': [[0, 1, 0, 0]],
      '9': [[10, 12, 5, 5]],
      '10': [[20, 20, 7, 7]],
    };
    const p = createOrthoProvider({ availability: many });
    expect(p.availableTiles(WHOLE_GLOBE, 8)).toHaveLength(1);
    expect(p.availableTiles(WHOLE_GLOBE, 9)).toHaveLength(1);
    expect(p.availableTiles(WHOLE_GLOBE, 10)).toHaveLength(1);
    // L8’s box is columns 0..1 of 512, row 0 of 256 — a two-tile strip in the
    // north-west corner. Derived from `tileBounds` rather than hand-typed, so a
    // drift in either grid shows up here instead of quietly agreeing with itself.
    const nw = tileBounds(8, 0, 0);
    const se = tileBounds(8, 1, 0);
    const l8 = asDeg(p.availableTiles(WHOLE_GLOBE, 8)[0]);
    expect(l8.west).toBeCloseTo(nw.west, 9);
    expect(l8.north).toBeCloseTo(nw.north, 9);
    expect(l8.east).toBeCloseTo(se.east, 9);
    expect(l8.south).toBeCloseTo(se.south, 9);
    // L10 gets the same treatment as L8, and it is the assertion that matters
    // here: the deep end is the level a "serve the shallowest named level's
    // ranges at every level" mutation fakes most easily. Length plus an
    // eastern-half query does not catch that — the degrees of the one tile the
    // block names do, at BOTH corners, derived from `tileBounds` rather than
    // typed, so a drift in either grid shows up instead of agreeing with itself.
    const t10 = tileBounds(10, 20, 7);
    const l10 = asDeg(p.availableTiles(WHOLE_GLOBE, 10)[0]);
    expect(l10.west).toBeCloseTo(t10.west, 9);
    expect(l10.east).toBeCloseTo(t10.east, 9);
    expect(l10.north).toBeCloseTo(t10.north, 9);
    expect(l10.south).toBeCloseTo(t10.south, 9);
    // No other level’s rectangle touches the eastern half or the equator, so a
    // leak of level 9’s or 10’s boxes into level 8’s answer shows up here.
    expect(p.availableTiles(rect(0, -90, 180, 44), 8)).toEqual([]);
    expect(p.availableTiles(rect(-180, -90, -179, 0), 8)).toEqual([]);
    expect(p.availableTiles(rect(0, -90, 180, 90), 10)).toEqual([]);
    expect(availabilityLevels(many)).toEqual([8, 9, 10]);
    expect(availabilityLevels(FIXTURE)).toEqual([9]);
  });

  it('an empty availability is empty, and is never read as "everywhere"', () => {
    expect(isAvailabilityEmpty(FIXTURE)).toBe(false);
    expect(isAvailabilityEmpty({})).toBe(true);
    expect(isAvailabilityEmpty({ '9': [] })).toBe(true);
    const none = createOrthoProvider({ availability: {} });
    expect(none.availableTiles(WHOLE_GLOBE, 9)).toEqual([]);
    expect(none.availableTiles(WHOLE_GLOBE, 8)).toEqual([]);
    expect(isTileAvailable({}, 9, 0, 0)).toBe(false);
  });
});

/**
 * The real inner provider with `requestImage` intercepted, so a hole is proven
 * never to reach the URL template rather than merely commented. Spying the
 * constructor’s own method keeps `OrthoInner`’s type honest: the delegate is a
 * `UrlTemplateImageryProvider`, not a hand-shaped stand-in.
 */
function recordingInner() {
  const inner = new Cesium.UrlTemplateImageryProvider({
    url: ORTHO_URL_TEMPLATE,
    tilingScheme: scheme,
    tileWidth: 512,
    tileHeight: 512,
    // The same floor `createOrthoProvider` gives the real inner provider, so the
    // stand-in cannot differ from what it stands in for on the one field Cesium
    // clamps against.
    minimumLevel: 0,
    maximumLevel: ORTHO_MAX_LEVEL,
    credit: CREDIT,
  });
  const calls: number[] = [];
  const fetched = Promise.resolve({ tag: 'inner' } as unknown as Cesium.ImageryTypes);
  vi.spyOn(inner, 'requestImage').mockImplementation((x, y, level) => {
    calls.push(level * 1_000_000 + x * 1_000 + y);
    return fetched;
  });
  return { inner, calls, fetched };
}

const at = (level: number, x: number, y: number) => level * 1_000_000 + x * 1_000 + y;

describe('the provider: a hole is never requested (brief requirement 1)', () => {
  it('delegates an available tile, and does not touch the inner provider for a hole', async () => {
    const { inner, calls, fetched } = recordingInner();
    const p = createOrthoProvider({ availability: FIXTURE, inner });

    // Same promise object, not a wrapper: the delegate is the request.
    expect(p.requestImage(11, 5, 9)).toBe(fetched);
    expect(p.requestImage(10, 5, 9)).toBe(fetched);
    expect(calls).toEqual([at(9, 11, 5), at(9, 10, 5)]);

    // Outside every rectangle: no request at all, at any level.
    expect(await p.requestImage(9, 5, 9)).toBe(ORTHO_NO_DATA);
    expect(await p.requestImage(100, 400, 9)).toBe(ORTHO_NO_DATA);
    expect(await p.requestImage(11, 5, 8)).toBe(ORTHO_NO_DATA);
    expect(await p.requestImage(11, 5, 10)).toBe(ORTHO_NO_DATA);
    expect(calls).toEqual([at(9, 11, 5), at(9, 10, 5)]);
  });

  it('scans a whole row of the fixture level and asks for three tiles, not 1024', () => {
    const { inner, calls } = recordingInner();
    const p = createOrthoProvider({ availability: FIXTURE, inner });
    for (let x = 0; x < 40; x += 1) void p.requestImage(x, 5, 9);
    expect(calls).toEqual([at(9, 10, 5), at(9, 11, 5), at(9, 12, 5)]);
  });

  it('hands Cesium a discard policy for the hole tile — the hook 1.146 actually consults', () => {
    // 1.146 has no `availableTiles` on an imagery provider (see ortho.ts for the
    // evidence). Returning `undefined` for a hole would run
    // `ImageryLayer._requestImagery`’s failure path, which raises the provider’s
    // error event and console.logs one line per hole tile per frame. The discard
    // policy is the designed answer: the tile becomes INVALID and the layer
    // beneath it renders.
    const { inner } = recordingInner();
    const p = createOrthoProvider({ availability: FIXTURE, inner });
    expect(p.tileDiscardPolicy.isReady()).toBe(true);
    expect(p.tileDiscardPolicy.shouldDiscardImage(ORTHO_NO_DATA)).toBe(true);
    expect(
      p.tileDiscardPolicy.shouldDiscardImage(
        { tag: 'inner' } as unknown as Cesium.ImageryTypes,
      ),
    ).toBe(false);
  });

  it('collapses the span instead of inverting it when the manifest names no L8..L10 level', () => {
    // Nothing in the envelope, so nothing is offered: the span collapses to L0,
    // the advertised floor, and the served span is empty. The collapse is NOT
    // defence against a Cesium check — 1.146 has no "minimumLevel must be no
    // greater than maximumLevel" check anywhere in the installed package
    // (`UrlTemplateImageryProvider.js:197` validates only `options.url` and
    // stores both levels raw), and `_createTileImagerySkeletons` clamps DOWN to
    // `maximumLevel` before clamping UP to `minimumLevel` (`ImageryLayer.js:809-
    // 819`), so an inverted span would silently come out requesting `minimumLevel`
    // — a level the provider had just disowned — instead of being rejected. The
    // construction is the only guard, and it cannot invert now.
    const { inner, calls } = recordingInner();
    const p = createOrthoProvider({
      availability: { '7': [[0, 3, 0, 1]] },
      top: 10,
      inner,
    });
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(0);
    expect(p.availableTiles(WHOLE_GLOBE, 7)).toEqual([]);
    expect(p.availableTiles(WHOLE_GLOBE, 8)).toEqual([]);
    void p.requestImage(0, 0, 8);
    void p.requestImage(0, 0, 7);
    void p.requestImage(0, 0, 0);
    expect(calls).toEqual([]);
  });

  it('is configured for the ortho pyramid and carries the overlay’s OWN credit', () => {
    const p = createOrthoProvider({ availability: FIXTURE });
    expect(ORTHO_URL_TEMPLATE).toBe('/tiles/ortho/{z}/{x}/{y}.jpg');
    expect(p.inner).toBeInstanceOf(Cesium.UrlTemplateImageryProvider);
    expect(p.inner.url).toBe(ORTHO_URL_TEMPLATE);
    // Not `CREDIT` from moon.ts: those pixels are Kaguya TC, not the LROC WAC
    // mosaic, and a per-tile credit naming the wrong mission is a citation error
    // the whole-branch review re-ruled against the Task-2 "one credit object"
    // ruling (which was made for two layers that really did share a provenance).
    expect(p.credit).toBe(ORTHO_CREDIT);
    expect(p.credit.html).toMatch(/Kaguya TC/);
    expect(p.credit.html).toMatch(/JAXA/);
    expect(p.credit.html).not.toMatch(/LROC WAC/);
    expect(p.inner.credit).toBe(ORTHO_CREDIT);
    expect(p.tilingScheme).toBeInstanceOf(Cesium.GeographicTilingScheme);
    expect((p.tilingScheme as Cesium.GeographicTilingScheme).ellipsoid).toBe(
      MOON_ELLIPSOID,
    );
    expect(p.tileWidth).toBe(512);
    expect(p.tileHeight).toBe(512);
    expect(p.hasAlphaChannel).toBe(false);
    expect(p.rectangle.west).toBeCloseTo(-Math.PI, 12);
    expect(p.rectangle.north).toBeCloseTo(Math.PI / 2, 12);
  });

  it('keeps the brief’s L8..L10 depth for a full availability, and clamps to a partial one', () => {
    // The advertised floor is L0 in every case (see
    // `ORTHO_ADVERTISED_MIN_LEVEL`); the depth is the data's, and the FLOOR IS
    // NOT ADVERTISED because advertising it is what made Cesium expand an L8
    // block across a whole-disc view.
    const full = createOrthoProvider({
      availability: { '8': [[0, 0, 0, 0]], '9': [[0, 0, 0, 0]], '10': [[0, 0, 0, 0]] },
    });
    expect(full.minimumLevel).toBe(0);
    expect(full.maximumLevel).toBe(10);
    // One level in the manifest must not advertise three: every advertised level
    // the manifest does not name is a level of guaranteed holes.
    const one = createOrthoProvider({ availability: FIXTURE });
    expect(one.minimumLevel).toBe(0);
    expect(one.maximumLevel).toBe(9);
    const capped = createOrthoProvider(
      { availability: { '8': [[0, 0, 0, 0]], '9': [[0, 0, 0, 0]] }, top: 9 },
    );
    expect(capped.minimumLevel).toBe(0);
    expect(capped.maximumLevel).toBe(9);
  });

  it('answers a level the availability does not name from the span as well as the block', () => {
    // L10 is inside the clampable span above only if the manifest names it.
    const { inner, calls } = recordingInner();
    const p = createOrthoProvider({ availability: FIXTURE, inner });
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(9);
    void p.requestImage(10, 5, 9);
    expect(calls).toEqual([at(9, 10, 5)]);
  });
});

/**
 * THE LEVEL SPAN IS BUILT FROM LEVELS THAT CARRY RECTANGLES, NOT FROM LEVEL KEYS.
 *
 * `ortho.ts` states its rule in one function, `orthoLevels`: levels that carry at
 * least one rectangle inside their own grid (`levelsWithData`) intersected with
 * the L8..`cap` envelope. Emptiness is that list answering `[]` — "not 'no keys':
 * a block that names a level with no ranges is empty too", and so is one whose
 * only levels sit outside the envelope. The span has to use that reading, because
 * `maximumLevel` is the ONE availability signal Cesium 1.146 honours: advertising
 * a level with zero rectangles tells the renderer to create skeletons for data
 * that does not exist, and it makes the control quote m/px for a level that was
 * never baked.
 */
describe('the level span ignores a level that names no usable rectangles', () => {
  it('does not advertise a level whose range list is empty', () => {
    const { inner, calls } = recordingInner();
    const p = createOrthoProvider({
      availability: { '8': [[0, 0, 0, 0]], '9': [] },
      top: 10,
      inner,
    });
    // L9 is named but empty, so the deepest level the provider can answer is L8.
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(8);
    expect(p.availableTiles(WHOLE_GLOBE, 8)).toHaveLength(1);
    expect(p.availableTiles(WHOLE_GLOBE, 9)).toEqual([]);
    // And the gate still holds at the level it refuses to advertise: a hole is
    // answered, never requested, so this can never become a 404 either way.
    void p.requestImage(0, 0, 9);
    expect(calls).toEqual([]);
    void p.requestImage(0, 0, 8);
    expect(calls).toEqual([at(8, 0, 0)]);
  });

  it('collapses rather than advertising the only level it has, when it is empty', () => {
    // `{ '10': [] }` is emptiness by the module's own predicate, so the span must
    // not be 10..10. The collapse is the documented answer: the advertised floor
    // and nothing above it, which is also the only span that cannot invert.
    const p = createOrthoProvider({ availability: { '10': [] }, top: 10 });
    expect(isAvailabilityEmpty({ '10': [] })).toBe(true);
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(0);
    expect(p.availableTiles(WHOLE_GLOBE, 10)).toEqual([]);
  });

  it('ignores a level whose only ranges fall outside the grid, as `availableTiles` does', () => {
    // L9 is 1024 x 512 tiles, so column 5000 does not exist. `levelRectangles`
    // filters it out through `rangeIsInGrid`; a span that still advertised L9
    // would be advertising a level the provider has no rectangle for at all.
    const p = createOrthoProvider({
      availability: { '8': [[0, 0, 0, 0]], '9': [[0, 5000, 0, 0]] },
      top: 10,
    });
    expect(p.availableTiles(WHOLE_GLOBE, 9)).toEqual([]);
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(8);
  });

  it('still keeps a real L8–L10 depth, so the fix cannot shave the deep end off', () => {
    const p = createOrthoProvider({
      availability: { '8': [[0, 0, 0, 0]], '9': [[0, 0, 0, 0]], '10': [[0, 0, 0, 0]] },
      top: 10,
    });
    expect(p.minimumLevel).toBe(0);
    expect(p.maximumLevel).toBe(10);
    expect(p.availableTiles(WHOLE_GLOBE, 10)).toHaveLength(1);
  });

  it('is quoted the same way by the control, which names its span from the same levels', () => {
    const copy = orthoControlCopy({ '8': [[0, 0, 0, 0]], '9': [] });
    expect(copy.unavailable).toBe(false);
    // The deepest level with data is L8, so the resolution the user is promised is
    // L8's 41.6 m/px, and the span is L8 alone — not a range ending in nothing.
    expect(copy.gloss).toContain('41.6 m/px');
    expect(copy.gloss).not.toContain('20.8 m/px');
    expect(copy.gloss).toContain('at L8');
    expect(copy.gloss).not.toContain('L8–L9');
  });
});

/**
 * THE FLOOR CESIUM IS TOLD ABOUT IS NOT THE FLOOR THE DATA STARTS AT.
 *
 * `ImageryLayer._createTileImagerySkeletons` clamps the imagery level it picks
 * for a terrain tile UP to `provider.minimumLevel` (Cesium 1.146,
 * `ImageryLayer.js:814-817`) and then walks every imagery tile inside that
 * terrain tile's footprint at the clamped level, one `TileImagery` per tile and
 * no cap on the count (`:958-1045`). Advertising `ORTHO_MIN_LEVEL` — the
 * shallowest level the bake wrote — therefore turns this app's default whole-disc
 * framing, where the matched terrain level is 0, into an L8 imagery block
 * stretched across every visible terrain tile: thousands of objects per
 * mid-level tile, up to ~10^5 for a coarse root tile, each one an `Imagery` plus
 * an immediately-resolved sentinel promise, and every one of them a hole the
 * per-tile gate answers anyway. The base layers never pay it, because `moon.ts`
 * configures theirs with `minimumLevel: 0`.
 *
 * Advertising 0 costs one sentinel per terrain tile instead. The pictures are the
 * same, because the thing that refuses L0–L7 is availability, not the clamp.
 */
describe('the provider advertises L0 and serves only the levels the envelope has', () => {
  it('advertises minimumLevel 0 whatever the block names, and keeps the data’s deep end', () => {
    const deep = createOrthoProvider({
      availability: { '8': [[0, 0, 0, 0]], '9': [[0, 0, 0, 0]], '10': [[0, 0, 0, 0]] },
      top: 10,
    });
    expect(deep.minimumLevel).toBe(0);
    expect(deep.maximumLevel).toBe(10);
    // The inner provider is configured the same way, because it is the object
    // whose level fields Cesium reads when it builds a URL.
    expect(deep.inner.minimumLevel).toBe(0);
    // A single-level block still does not lift the advertised floor to its data.
    const one = createOrthoProvider({ availability: FIXTURE });
    expect(one.minimumLevel).toBe(0);
    expect(one.maximumLevel).toBe(9);
  });

  it('answers the coarse-view levels as holes without reaching the URL template', async () => {
    const { inner, calls } = recordingInner();
    const p = createOrthoProvider({ availability: FIXTURE, inner });
    for (const level of [0, 3, 7]) {
      expect(await p.requestImage(0, 0, level)).toBe(ORTHO_NO_DATA);
      expect(p.availableTiles(WHOLE_GLOBE, level)).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it('never advertises a floor above its ceiling', () => {
    // The construction is the guard: nothing downstream checks it (see the
    // comment in `createOrthoProvider`), so the numbers must not be abutable.
    for (const availability of [
      {},
      FIXTURE,
      { '7': [[0, 3, 0, 1]] },
      { '10': [] },
    ] satisfies Availability[]) {
      const p = createOrthoProvider({ availability, top: 7 });
      expect(p.minimumLevel).toBeLessThanOrEqual(p.maximumLevel);
    }
  });
});

/**
 * ONE ANSWER TO "WHICH LEVELS?", SHARED BY THE SPAN, THE ATTACH GATE AND THE
 * LABEL.
 *
 * They used to be three: the provider filtered `levelsWithData` to the L8..`cap`
 * envelope, `orthoControlCopy` used bare `levelsWithData` and never received
 * `top`, and the attach gate used `isAvailabilityEmpty`, which reads neither. For
 * a block naming only L7 the label therefore promised "...at L7 - L7" while the
 * envelope refused to serve anything below L8 — the user toggled on and the map
 * did not change, next to a comment asserting that state of affairs was
 * impossible. That is the defect class this brief names, so the three readings
 * are now one function.
 */
describe('the span, the attach gate and the control promise exactly the same levels', () => {
  /** Named, in the grid, and outside the L8..L10 envelope every consumer shares. */
  const SEVEN: Availability = { '7': [[0, 3, 0, 1]] };
  const DEEP_ALL: Availability = {
    '8': [[0, 0, 0, 0]],
    '9': [[0, 0, 0, 0]],
    '10': [[0, 0, 0, 0]],
  };

  it('calls a block with nothing inside the envelope unavailable, in the label and on the stack', () => {
    const copy = orthoControlCopy(SEVEN, 10);
    expect(copy.unavailable).toBe(true);
    // No promise of a level it will not serve, and no m/px quoted for it.
    expect(copy.gloss).not.toMatch(/L7/);
    expect(copy.gloss).not.toContain('m/px');
    // The same answer at the gate, so "toggle on, map unchanged" is not reachable.
    const v = stackViewer();
    expect(enableOrthoOverlay(v.viewer, { availability: SEVEN, top: 10 })).toBe(false);
    expect(v.kinds()).toEqual(['base']);
    // The other direction of the same divergence: a level the record's own `top`
    // forbids is not coverage either, even though `levelsWithData` likes it.
    const aboveTop: Availability = { '10': [[0, 0, 0, 0]] };
    expect(orthoControlCopy(aboveTop, 9).unavailable).toBe(true);
    expect(enableOrthoOverlay(v.viewer, { availability: aboveTop, top: 9 })).toBe(false);
    expect(v.kinds()).toEqual(['base']);
  });

  it('quotes the span and the m/px the provider actually advertises', () => {
    const p = createOrthoProvider({ availability: DEEP_ALL, top: 9 });
    const copy = orthoControlCopy(DEEP_ALL, 9);
    expect(p.maximumLevel).toBe(9);
    expect(copy.gloss).toContain('at L9');
    expect(copy.gloss).toContain('20.8 m/px');
    expect(copy.gloss).not.toContain('L10');
    expect(copy.gloss).not.toContain('10.4 m/px');
  });

  it('keeps an advertised `maximumLevel` inside the record’s own top', () => {
    // `top: 7` leaves nothing in the envelope, so the span collapses — and the
    // collapse has to respect `cap` too, or a record that tops out at L7 would
    // still advertise L8 as the deepest level it owns.
    const p = createOrthoProvider({ availability: SEVEN, top: 7 });
    expect(p.maximumLevel).toBeLessThanOrEqual(7);
  });

  it('renders the copy with the record’s top, not a bare availability', () => {
    const html = renderToStaticMarkup(
      OrthoControl({ availability: DEEP_ALL, top: 9, enabled: false, onToggle: () => {} }),
    );
    expect(html).toContain('at L9');
    expect(html).not.toContain('L10');
    const outside = renderToStaticMarkup(
      OrthoControl({ availability: SEVEN, top: 10, enabled: false, onToggle: () => {} }),
    );
    expect(outside).toContain('Deep zoom unavailable');
  });
});

describe('the control copy names the source for what it is (brief requirement 6)', () => {
  it('says Kaguya TC, shaded, not albedo, the derived m/px, and region-limited', () => {
    const copy = orthoControlCopy({
      '8': [[0, 0, 0, 0]],
      '9': [[0, 0, 0, 0]],
      '10': [[0, 0, 0, 0]],
    });
    expect(copy).not.toBeNull();
    const text = `${copy?.title} ${copy?.gloss}`;
    expect(text).toContain('Kaguya TC');
    expect(text).toMatch(/shaded/i);
    expect(text).toMatch(/not albedo/i);
    expect(text).toMatch(/region/i);
    // 10.4 m/px is `grid.mPerPx(10)` rendered, not a literal typed into JSX.
    expect(copy?.gloss).toContain('10.4 m/px');
    expect(copy?.title).toContain('Deep zoom');
    expect(copy?.unavailable).toBe(false);
  });

  it('refuses to describe an unavailable overlay as if it covered anything', () => {
    const missingCases: Array<Availability | undefined> = [{}, undefined, { '9': [] }];
    for (const missing of missingCases) {
      const copy = orthoControlCopy(missing);
      expect(copy).not.toBeNull();
      expect(copy?.unavailable).toBe(true);
      const text = `${copy?.title} ${copy?.gloss}`;
      expect(text).toMatch(/no ortho tiles|not baked|unavailable/i);
      expect(text).not.toMatch(/global/i);
      // And it still names the radiometry, so the label never reads like albedo.
      expect(text).toMatch(/not albedo/i);
    }
  });
});

describe('the control renders that copy, in the DOM the user sees', () => {
  const DEEP: Availability = {
    '8': [[0, 0, 0, 0]],
    '9': [[0, 0, 0, 0]],
    '10': [[0, 0, 0, 0]],
  };

  it('names the source and the radiometry, and reflects the pressed state', () => {
    const html = renderToStaticMarkup(
      OrthoControl({ availability: DEEP, enabled: false, onToggle: () => {} }),
    );
    expect(html).toContain('Kaguya TC orthophoto');
    expect(html).toContain('shaded relief, not albedo');
    expect(html).toContain('10.4 m/px');
    expect(html).toContain('region-limited');
    expect(html).toContain('aria-pressed="false"');
    const on = renderToStaticMarkup(
      OrthoControl({ availability: DEEP, enabled: true, onToggle: () => {} }),
    );
    expect(on).toContain('aria-pressed="true"');
  });

  it('renders an unavailable overlay as a disabled control that says so', () => {
    const html = renderToStaticMarkup(
      OrthoControl({ availability: undefined, enabled: false, onToggle: () => {} }),
    );
    expect(html).toContain('Deep zoom unavailable');
    expect(html).toContain('no ortho tiles');
    expect(html).toContain('disabled');
    // Never enabled by a stale `true`: nothing is attached, nothing is pressed.
    const stuck = renderToStaticMarkup(
      OrthoControl({ availability: {}, enabled: true, onToggle: () => {} }),
    );
    expect(stuck).toContain('aria-pressed="false"');
  });
});

interface FakeLayer {
  name: string;
  provider: unknown;
  destroyRemoved: boolean;
  destroyed: boolean;
}

/**
 * A fake `Cesium.Viewer` carrying only the parts of the imagery stack the overlay
 * code touches, plus the bookkeeping both invariants are measured with: the live
 * stack in order, and EVERY layer ever created with how it was removed. Counting
 * only the live list cannot tell "the overlay was destroyed" from "the overlay
 * was dropped without being destroyed" — which is exactly the leak to pin.
 */
function stackViewer(baseLayer = 'photo') {
  const live: FakeLayer[] = [];
  const created: FakeLayer[] = [];
  let counter = 0;
  const add = (provider: unknown, index?: number): FakeLayer => {
    const layer: FakeLayer = {
      name: `layer-${counter++}`,
      provider,
      destroyRemoved: false,
      destroyed: false,
    };
    live.splice(index ?? live.length, 0, layer);
    created.push(layer);
    return layer;
  };
  const collection = {
    get length() {
      return live.length;
    },
    get: (i: number) => live[i],
    indexOf: (l: FakeLayer) => live.indexOf(l),
    contains: (l: FakeLayer) => live.includes(l),
    addImageryProvider: add,
    remove: (layer: FakeLayer, destroy = true) => {
      const i = live.indexOf(layer);
      if (i < 0) return false;
      live.splice(i, 1);
      layer.destroyRemoved = destroy;
      if (destroy) layer.destroyed = true;
      return true;
    },
  };
  const viewer = {
    destroyed: false,
    isDestroyed: () => viewer.destroyed,
    imageryLayers: collection,
    scene: { requestRender: () => {} },
  };
  // The viewer is built with one base layer, exactly as `createMoonViewer` does.
  add({ kind: 'base', layer: baseLayer });
  // The ortho provider discriminates itself with `layerName`; a base provider
  // (fake here, `UrlTemplateImageryProvider` in the app) never carries it.
  const isOrtho = (l: FakeLayer) =>
    (l.provider as { layerName?: string }).layerName === 'ortho';
  const kinds = () => live.map((l) => (isOrtho(l) ? 'ortho' : 'base'));
  return {
    viewer: viewer as unknown as Cesium.Viewer,
    live,
    created,
    kinds,
    isOrtho,
    markDestroyed: () => {
      viewer.destroyed = true;
    },
    orthoLayers: () => created.filter(isOrtho),
  };
}

describe('the overlay is an overlay: the stack, idempotently (brief requirements 3, 4)', () => {
  it('stacks above the base layer instead of replacing it', () => {
    const v = stackViewer();
    expect(v.live).toHaveLength(1);
    expect(enableOrthoOverlay(v.viewer, { availability: FIXTURE })).toBe(true);
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect(orthoOverlayEnabled(v.viewer)).toBe(true);
    // The provider that reached the layer is an ortho provider, so the tile-error
    // wiring in MoonMap subscribes the layer that can actually load deep tiles.
    const provider = (v.live[1].provider ?? {}) as { availability?: Availability };
    expect(provider.availability).toBe(FIXTURE);
  });

  it('turning it on twice leaves one overlay and no extra layer creation', () => {
    const v = stackViewer();
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect(v.orthoLayers()).toHaveLength(1);
  });

  it('on, off, on again: exactly one overlay, and the removed one was destroyed', () => {
    const v = stackViewer();
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    expect(disableOrthoOverlay(v.viewer)).toBe(true);
    expect(v.kinds()).toEqual(['base']);
    expect(v.orthoLayers()[0].destroyRemoved).toBe(true);
    expect(v.orthoLayers()[0].destroyed).toBe(true);

    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect(v.orthoLayers()).toHaveLength(2);
    // The second on attached a NEW layer; the destroyed first one is not in the stack.
    expect(v.live[1]).toBe(v.orthoLayers()[1]);
    expect(disableOrthoOverlay(v.viewer)).toBe(true);
    expect(disableOrthoOverlay(v.viewer)).toBe(false);
    expect(v.kinds()).toEqual(['base']);
  });

  it('setLayer swaps the base without dropping, duplicating, or reordering the overlay', () => {
    const v = stackViewer('photo');
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    const overlay = v.live[1];
    setLayer(v.viewer, 'paper', 6);
    expect(v.kinds()).toEqual(['base', 'ortho']);
    // The base at index 0 is a fresh provider for the layer that was asked for —
    // read off the URL template `makeProvider` builds, not off a fake's field.
    expect((v.live[0].provider as Cesium.UrlTemplateImageryProvider).url).toBe(
      '/tiles/paper/{z}/{x}/{y}.jpg',
    );
    setLayer(v.viewer, 'photo', 7);
    expect((v.live[0].provider as Cesium.UrlTemplateImageryProvider).url).toBe(
      '/tiles/photo/{z}/{x}/{y}.jpg',
    );
    setLayer(v.viewer, 'paper', 6);
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect((v.live[0].provider as Cesium.UrlTemplateImageryProvider).maximumLevel).toBe(6);
    expect(v.orthoLayers()).toHaveLength(1);
    // The overlay survived every base swap untouched — never removed, never destroyed.
    expect(v.live[1]).toBe(overlay);
    expect(overlay.destroyed).toBe(false);
    expect(overlay.destroyRemoved).toBe(false);
    // Every base that was swapped out was destroyed, so no provider is orphaned.
    const bases = v.created.filter((l) => !v.isOrtho(l));
    expect(bases.filter((l) => l.destroyed)).toHaveLength(3);
    expect(bases).toHaveLength(4);
  });

  it('setLayer with no overlay still leaves exactly one base layer, after any number of swaps', () => {
    const v = stackViewer();
    for (const layer of ['paper', 'photo', 'paper'] as const) {
      setLayer(v.viewer, layer, 6);
    }
    expect(v.kinds()).toEqual(['base']);
    expect(orthoOverlayEnabled(v.viewer)).toBe(false);
  });

  it('an availability the manifest does not fill makes the overlay unavailable, and adds nothing', () => {
    const v = stackViewer();
    expect(enableOrthoOverlay(v.viewer, { availability: {} })).toBe(false);
    expect(v.kinds()).toEqual(['base']);
    expect(orthoOverlayEnabled(v.viewer)).toBe(false);
    // The missing-record case is the same answer, never "whole globe".
    expect(enableOrthoOverlay(v.viewer, { availability: undefined })).toBe(false);
    expect(v.kinds()).toEqual(['base']);
    expect(v.orthoLayers()).toHaveLength(0);
  });

  it('a viewer whose overlay was removed behind its back re-attaches one, and only one', () => {
    const v = stackViewer();
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    const overlay = v.live[1];
    v.live.splice(1, 1); // something else tore the layer out of the collection
    expect(orthoOverlayEnabled(v.viewer)).toBe(false);
    expect(enableOrthoOverlay(v.viewer, { availability: FIXTURE })).toBe(true);
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect(v.live[1]).not.toBe(overlay);
    expect(v.orthoLayers()).toHaveLength(2);
    // The detached layer is not left attached anywhere, and re-enabling is not a
    // second overlay.
    expect(disableOrthoOverlay(v.viewer)).toBe(true);
    expect(v.kinds()).toEqual(['base']);
  });

  it('a new manifest availability replaces the overlay instead of stacking a second one', () => {
    const v = stackViewer();
    enableOrthoOverlay(v.viewer, { availability: FIXTURE });
    const other: Availability = { '9': [[20, 21, 10, 10]] };
    expect(enableOrthoOverlay(v.viewer, { availability: other })).toBe(true);
    expect(v.kinds()).toEqual(['base', 'ortho']);
    expect((v.live[1].provider as { availability: Availability }).availability).toBe(other);
    // The stale overlay was destroyed, not orphaned.
    expect(v.orthoLayers()[0].destroyed).toBe(true);
    expect(v.orthoLayers()[1].destroyed).toBe(false);
  });

  it('a destroyed viewer is refused, not written to', () => {
    const v = stackViewer();
    v.markDestroyed();
    expect(enableOrthoOverlay(v.viewer, { availability: FIXTURE })).toBe(false);
    expect(disableOrthoOverlay(v.viewer)).toBe(false);
    expect(orthoOverlayEnabled(v.viewer)).toBe(false);
  });
});

describe('the one-layer invariant is restated where it lived, not left to rot', () => {
  // `morph.ts` and `MoonMap.tsx` both promised `imageryLayers.length === 1`.
  // Task 3 breaks that on purpose, so the promise has to say the new truth: a
  // comment the code contradicts is worse than no comment. Pinned as text because
  // prose is the only place the old claim survived.
  const read = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

  it('morph.ts no longer claims one layer and states the stack instead', async () => {
    const src = await read('../lib/cesium/morph.ts');
    expect(src).not.toMatch(/imageryLayers\.length must be 1/);
    expect(src).toMatch(/exactly one base layer/i);
    expect(src).toMatch(/ortho overlay/i);
  });

  it('MoonMap.tsx describes imageryCount as the stack it now is', async () => {
    const src = await read('../components/MoonMap.tsx');
    // The old wording was a promise ("must be 1"). Naming the number the stack
    // used to guarantee is fine; making a promise it no longer keeps is not.
    expect(src).not.toMatch(/must be 1/);
    expect(src).toMatch(/exactly one base layer/);
    expect(src).toMatch(/is 1 or 2/);
    expect(src).toMatch(/orthoEnabled\(\): boolean/);
    expect(src).toMatch(/orthoOverlayEnabled\(viewer\)/);
  });
});

describe('a recorded deep layer is proved on disk before it is attached', () => {
  it('samples two corners per served level, and no level the envelope refuses', () => {
    expect(orthoProbePaths(FIXTURE, 10)).toEqual([
      '/tiles/ortho/9/10/5.jpg',
      '/tiles/ortho/9/12/5.jpg',
    ]);
    // L7 is below this layer's envelope, and a single-tile level gives one path,
    // not two fetches for the same file.
    expect(orthoProbePaths({ '7': [[0, 1, 0, 0]], '8': [[0, 0, 0, 0]] }, 8)).toEqual([
      '/tiles/ortho/8/0/0.jpg',
    ]);
    expect(orthoProbePaths({}, 10)).toEqual([]);
  });

  it('reads one failed sample, or no sample at all, as "not here"', () => {
    expect(orthoOnDisk([{ ok: true }, { ok: true }])).toBe(true);
    expect(orthoOnDisk([{ ok: true }, { ok: false }])).toBe(false);
    expect(orthoOnDisk([])).toBe(false);
  });

  it('names the third state instead of claiming the record is empty', () => {
    const recorded: Availability = {
      '8': [[0, 0, 0, 0]],
      '9': [[0, 0, 0, 0]],
      '10': [[0, 0, 0, 0]],
    };
    const absent = orthoControlCopy(recorded, 10, false);
    expect(absent.unavailable).toBe(true);
    expect(absent.title).toMatch(/not on this machine/i);
    expect(absent.gloss).toContain('bake:deep');
    expect(absent.gloss).toContain('L8–L10');
    // The old empty-record wording would be a lie here: this record DOES name tiles.
    expect(absent.gloss).not.toMatch(/records no ortho tiles/);
    // Nothing recorded is still the other answer, and it stays distinct.
    expect(orthoControlCopy({}, 10, false).title).toBe('Deep zoom unavailable');
    // And the ordinary case is unchanged by the new parameter's default.
    expect(orthoControlCopy(recorded, 10).unavailable).toBe(false);
  });

  it('renders the third state as a disabled button that says why', () => {
    const html = renderToStaticMarkup(
      OrthoControl({
        availability: { '10': [[0, 0, 0, 0]] },
        top: 10,
        onDisk: false,
        enabled: false,
        onToggle: () => {},
      }),
    );
    expect(html).toContain('not on this machine');
    expect(html).toMatch(/disabled=""/);
    expect(html).toContain('aria-pressed="false"');
  });
});
