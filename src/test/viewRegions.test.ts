import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  VIEW_FORBIDDEN_KEYS,
  VIEW_KINDS,
  parseViewRegions,
  validateViewRegions,
  viewRegionBounds,
  viewRegionCenter,
  type ViewBox,
} from '@/lib/viewRegions';

/**
 * The reader for `regions.json`'s `views` collection (amendment 2 D11): geometry
 * for outlining a selected area and framing the camera on it, with no bake promise
 * attached.
 *
 * These tests are the predicate's own contract, and they are written to fail for
 * any value — the discipline `src/test/features.test.ts` applies to the gazetteer,
 * for the same reason: the UI renders `name` and `kind` as text and uses `id` as a
 * selection key, so a field that merely *looked* checked is a checked-looking lie.
 */

/** The file the app fetches, parsed as the browser would get it. */
const shipped = JSON.parse(readFileSync('public/data/regions.json', 'utf8')) as unknown;

const shippedViews = (): unknown[] => {
  const body = shipped as { views?: unknown };
  return Array.isArray(body.views) ? body.views : [];
};

/** One complete, legal view: the baseline every case below mutates. */
const goodView = (): Record<string, unknown> => ({
  id: 'mare-imbrium',
  name: 'Mare Imbrium',
  kind: 'mare',
  boxes: [[-38.36, 15.23, 8.56, 51.46]],
  derivedFrom: 'bbox',
});

/** A complete, legal file body, with the four areas D11 was asked for. */
const goodBody = (): Record<string, unknown> => ({
  schema: 1,
  grid: { tileSize: 512, yOrigin: 'north' },
  regions: [{ id: 'tycho', name: 'Tycho', box: [1, 2, 3, 4], minLevel: 8 }],
  views: [
    goodView(),
    { id: 'south-polar-cap', name: 'South Polar Cap', kind: 'polar-cap',
      boxes: [[-180, -90, 180, -60]], derivedFrom: 'declared' },
    { id: 'far-side', name: 'Far Side', kind: 'hemisphere',
      boxes: [[-180, -90, -90, 90], [90, -90, 180, 90]], derivedFrom: 'declared' },
  ],
  availability: { '8': [[0, 1, 0, 1]] },
  cost: { tiles: 2 },
});

const expectRefused = (value: unknown, mentions?: string): string => {
  const result = validateViewRegions(value);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) return '';
  if (mentions) expect(result.reason.toLowerCase()).toContain(mentions.toLowerCase());
  return result.reason;
};

const accept = (value: unknown) => {
  const result = validateViewRegions(value);
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.value;
};

/** Containment under this repo's own convention: `west > east` is the
 *  antimeridian crossing (`labels.bbox_contains`, Cesium `Rectangle`), not a bug. */
const covers = (box: ViewBox, lon: number, lat: number): boolean => {
  const [w, s, e, n] = box;
  if (!(s <= lat && lat <= n)) return false;
  return w <= e ? w <= lon && lon <= e : lon >= w || lon <= e;
};

describe('validateViewRegions — the shipped artifact', () => {
  it('accepts public/data/regions.json and returns every view in it', () => {
    const views = accept(shipped);
    expect(views.length).toBe(shippedViews().length);
    expect(views.length).toBeGreaterThan(50);
    const ids = views.map((v) => v.id);
    for (const id of ['south-polar-cap', 'north-polar-cap', 'near-side', 'far-side']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns only the fields it checked, and no more', () => {
    // The `as` discipline: nothing reaches the caller that was not built out of
    // values that each passed a predicate, so the returned objects cannot claim
    // a key the validator never looked at — including a bake-promise key.
    for (const view of accept(shipped)) {
      expect(Object.keys(view).sort()).toEqual(
        ['boxes', 'derivedFrom', 'id', 'kind', 'name'],
      );
      expect(VIEW_KINDS).toContain(view.kind);
      expect(view.boxes.length).toBeGreaterThan(0);
      for (const box of view.boxes) {
        expect(box.length).toBe(4);
        expect(box[0]).toBeLessThan(box[2]);
        expect(box[1]).toBeLessThan(box[3]);
      }
    }
  });

  it('drops an unmodelled key instead of asserting it', () => {
    const body = goodBody();
    (body.views as Record<string, unknown>[])[0].note = 'not part of the contract';
    const [view] = accept(body);
    expect('note' in view).toBe(false);
    // …and the validator reads `views` and nothing else: a body that carries the
    // bake keys at the top level, as the shipped file does, is still accepted.
    expect(accept({ schema: 1, views: [goodView()] })).toHaveLength(1);
  });
});

describe('validateViewRegions — refuses what it cannot check', () => {
  it('refuses a body that is not the plan object', () => {
    for (const value of [null, undefined, 42, 'views', [], {}]) {
      expectRefused(value, 'schema');
    }
  });

  it('refuses a schema it does not know', () => {
    for (const schema of [0, 2, '1', null]) {
      expectRefused({ ...goodBody(), schema }, 'schema');
    }
  });

  it('refuses a missing, non-array or empty views block', () => {
    const { views: _drop, ...noViews } = goodBody();
    expectRefused(noViews, 'views');
    expectRefused({ ...goodBody(), views: {} }, 'views');
    expectRefused({ ...goodBody(), views: [] }, 'views');
  });

  it('refuses a view that carries a bake promise rather than quietly ignoring it', () => {
    // The whole separation rests on a view having no levels and no source: a file
    // that grew one back would claim tiles for an outline, and a validator that
    // *cast* the object would have shipped that claim to the UI unnoticed.
    for (const key of VIEW_FORBIDDEN_KEYS) {
      const body = goodBody();
      (body.views as Record<string, unknown>[])[0][key] = 8;
      expectRefused(body, key);
    }
  });

  it('refuses a view that is not an object, or is a bare array', () => {
    expectRefused({ ...goodBody(), views: ['mare-imbrium'] }, 'not an object');
    expectRefused({ ...goodBody(), views: [[]] }, 'not an object');
  });

  it('refuses a missing or blank name, id or a non-slug id', () => {
    for (const [field, bad] of [
      ['name', ''],
      ['name', '   '],
      ['id', ''],
      ['id', 'Mare Imbrium'],
      ['id', 'mareImbrium'],
      ['id', 'mare--imbrium'],
      ['id', '_mare_imbrium'],
    ] as const) {
      const body = goodBody();
      (body.views as Record<string, unknown>[])[0][field] = bad;
      const reason = expectRefused(body, field);
      // An id the generator did not slug is refused as an id, not as a name.
      if (field === 'id') expect(reason).toContain('id');
    }
  });

  it('refuses an id that is not the slug of its own name', () => {
    const body = goodBody();
    (body.views as Record<string, unknown>[])[0].id = 'mare-serenitatis';
    expectRefused(body, 'slug');
  });

  it('refuses a duplicate id, because the UI keys and routes on it', () => {
    const body = goodBody();
    (body.views as Record<string, unknown>[]).push(goodView());
    expectRefused(body, 'duplicate');
  });

  it('refuses a kind it has no wording for', () => {
    for (const kind of ['crater', 'region', 'MARE', '', null, undefined]) {
      const body = goodBody();
      (body.views as Record<string, unknown>[])[0].kind = kind;
      expectRefused(body, 'kind');
    }
    expect(VIEW_KINDS).toContain('oceanus');
    expect(VIEW_KINDS).toContain('polar-cap');
    expect(VIEW_KINDS).toContain('hemisphere');
  });

  it('refuses a derivedFrom it did not emit', () => {
    for (const derivedFrom of ['midpoint', 'bbox ', '', null]) {
      const body = goodBody();
      (body.views as Record<string, unknown>[])[0].derivedFrom = derivedFrom;
      expectRefused(body, 'derivedFrom');
    }
  });

  it('refuses a view with no box to draw', () => {
    expectRefused({ ...goodBody(), views: [{ ...goodView(), boxes: [] }] }, 'boxes');
    expectRefused({ ...goodBody(), views: [{ ...goodView(), boxes: null }] }, 'boxes');
    expectRefused(
      { ...goodBody(), views: [{ ...goodView(), boxes: 'mare'}] },
      'boxes',
    );
  });

  it('refuses a box that is not four finite lon/lat numbers', () => {
    const bad: unknown[] = [
      [1, 2, 3],
      [1, 2, 3, 4, 5],
      ['1', 2, 3, 4],
      [1, 2, 3, null],
      [1, 2, 3, NaN],
      [1, 2, 3, Infinity],
      [1, 91, 3, 92],
      [-181, 2, 3, 4],
      // the 0-360 form the task forbids: east 200 is outside the convention
      [1, 2, 200, 4],
      'not-a-box',
      null,
    ];
    for (const box of bad) {
      expectRefused(
        { ...goodBody(), views: [{ ...goodView(), boxes: [box] }] },
        'box',
      );
    }
  });

  it('refuses a box that runs backwards instead of silently drawing the complement', () => {
    // `west > east` is legal gazetteer geometry and a lie about an outline: the
    // emitter splits those into two drawable halves, so a backwards pair here
    // means the split did not happen.
    const reason = expectRefused(
      { ...goodBody(), views: [{ ...goodView(), boxes: [[170, 5, -170, 15]] }] },
      'antimeridian',
    );
    expect(reason).toContain('170');
  });

  it('refuses an empty box or a line, which tints nothing and frames nothing', () => {
    expectRefused(
      { ...goodBody(), views: [{ ...goodView(), boxes: [[10, 20, 10, 25]] }] },
      'box',
    );
    expectRefused(
      { ...goodBody(), views: [{ ...goodView(), boxes: [[10, 25, 20, 20]] }] },
      'box',
    );
  });

  it('parses to null through the one-call form, never to a partial list', () => {
    expect(parseViewRegions(goodBody())).toHaveLength(3);
    expect(parseViewRegions({ ...goodBody(), views: [{ ...goodView(), kind: 'sea' }] }))
      .toBeNull();
    expect(parseViewRegions(undefined)).toBeNull();
  });
});

describe('viewRegionCenter', () => {
  it('centres a single-box view on its own middle', () => {
    expect(viewRegionCenter([[10, 20, 30, 40]])).toEqual({ lon: 20, lat: 30 });
    const cap = accept(shipped).find((v) => v.id === 'south-polar-cap');
    expect(cap).toBeDefined();
    expect(viewRegionCenter(cap!.boxes)).toEqual({ lon: 0, lat: -75 });
    const north = accept(shipped).find((v) => v.id === 'north-polar-cap');
    expect(viewRegionCenter(north!.boxes)).toEqual({ lon: 0, lat: 75 });
  });

  it('centres a multi-box view between its boxes, not inside the gap', () => {
    const far = accept(shipped).find((v) => v.id === 'far-side');
    expect(far).toBeDefined();
    expect(far!.boxes.length).toBe(2);
    const center = viewRegionCenter(far!.boxes);
    expect(center).not.toBeNull();
    // A naive mean of the four corners is lon 0 — the middle of the NEAR side,
    // i.e. inside the empty gap the two boxes do not cover. The far side's own
    // centre is the antipode of the sub-Earth point.
    expect(Math.abs(center!.lon)).toBeCloseTo(180, 9);
    expect(center!.lat).toBeCloseTo(0, 9);
    // …and the centre is ON the selected area, in one of its two boxes, not in the
    // near-side gap between them.
    expect(far!.boxes.some((box) => covers(box, center!.lon, center!.lat))).toBe(true);
    const near = accept(shipped).find((v) => v.id === 'near-side');
    expect(viewRegionCenter(near!.boxes)).toEqual({ lon: 0, lat: 0 });
  });

  it('centres the contiguous rectangle over two side-by-side boxes', () => {
    // Boxes at lon 0..10 and 20..22: the widest empty arc is the 338 degrees that
    // wrap the seam, so the covering rectangle is 0..22 and its middle is 11 — not
    // the mean of the two box centres (13), which would sit in the gap.
    const boxes: ViewBox[] = [
      [0, 0, 10, 10],
      [20, 0, 22, 10],
    ];
    expect(viewRegionCenter(boxes)).toEqual({ lon: 11, lat: 5 });
    expect(viewRegionBounds(boxes)).toEqual({ west: 0, south: 0, east: 22, north: 10 });
  });

  it('has no centre for no boxes', () => {
    expect(viewRegionCenter([])).toBeNull();
  });
});

describe('viewRegionBounds', () => {
  it('is the box itself for a single-box view', () => {
    expect(viewRegionBounds([[10, 20, 30, 40]])).toEqual({
      west: 10, south: 20, east: 30, north: 40,
    });
    const imbrium = accept(shipped).find((v) => v.id === 'mare-imbrium');
    expect(viewRegionBounds(imbrium!.boxes)).toEqual({
      west: imbrium!.boxes[0][0], south: imbrium!.boxes[0][1],
      east: imbrium!.boxes[0][2], north: imbrium!.boxes[0][3],
    });
  });

  it('does not pretend the far side is one plain rectangle', () => {
    const far = accept(shipped).find((v) => v.id === 'far-side')!;
    const bounds = viewRegionBounds(far.boxes)!;
    // min/max over both boxes would be west=-180, east=180: the whole globe, an
    // outline of nothing and a camera at the wrong height.
    expect([bounds.west, bounds.east]).not.toEqual([-180, 180]);
    expect(bounds.west).toBeGreaterThan(bounds.east); // the documented crossing
    const width = ((bounds.east - bounds.west) + 360) % 360;
    expect(width).toBeCloseTo(180, 9);
    expect(bounds.south).toBeCloseTo(-90, 9);
    expect(bounds.north).toBeCloseTo(90, 9);
    // and it still contains every box it was given
    for (const box of far.boxes) {
      expect(covers([bounds.west, bounds.south, bounds.east, bounds.north],
        box[0] + 0.001, box[1] + 0.001)).toBe(true);
      expect(covers([bounds.west, bounds.south, bounds.east, bounds.north],
        box[2] - 0.001, box[3] - 0.001)).toBe(true);
    }
  });

  it('joins boxes that touch into one rectangle and keeps their latitude extent', () => {
    const bounds = viewRegionBounds([[0, -30, 10, 20], [10, -10, 20, 30]])!;
    expect(bounds).toEqual({ west: 0, south: -30, east: 20, north: 30 });
  });

  it('has no bounds for no boxes', () => {
    expect(viewRegionBounds([])).toBeNull();
  });

  it('agrees with the centre it is drawn beside', () => {
    for (const view of accept(shipped)) {
      const bounds = viewRegionBounds(view.boxes)!;
      const center = viewRegionCenter(view.boxes)!;
      expect(covers([bounds.west, bounds.south, bounds.east, bounds.north],
        center.lon, center.lat)).toBe(true);
      expect(center.lat).toBeCloseTo((bounds.south + bounds.north) / 2, 9);
    }
  });
});
