import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseViewRegions, VIEW_KINDS } from '@/lib/viewRegions';
import type { ViewRegion } from '@/lib/viewRegions';
import {
  KIND_LABELS,
  KIND_ORDER,
  groupAreas,
} from '@/components/AreaSelect';
import {
  areaRectangle,
  outlinePlanFor,
  spansAllLongitudes,
} from '@/lib/cesium/areaOutline';

/**
 * The geometry decisions behind D11, measured against the shipped `views`
 * collection rather than invented boxes. Two shapes in that file are the ones a
 * naive rectangle gets wrong, and both are asserted below with the artifact's own
 * numbers.
 */
const parsed = parseViewRegions(
  JSON.parse(readFileSync('public/data/regions.json', 'utf8')),
);
if (!parsed) throw new Error('regions.json was refused by its own reader');
const VIEWS = parsed;
const byId = (id: string): ViewRegion => {
  const hit = VIEWS.find((v) => v.id === id);
  if (!hit) throw new Error(`no view ${id} in the shipped file`);
  return hit;
};
const lats = (view: ViewRegion) =>
  outlinePlanFor(view).edges.filter((e) => e.kind === 'parallel').map((e) => e.at);
const lons = (view: ViewRegion) =>
  outlinePlanFor(view).edges.filter((e) => e.kind === 'meridian').map((e) => e.at);

describe('a full-longitude band is bounded by parallels, not by a rectangle', () => {
  it('the south polar cap contributes exactly the 60° S circle', () => {
    const plan = outlinePlanFor(byId('south-polar-cap'));
    expect(byId('south-polar-cap').boxes).toEqual([[-180, -90, 180, -60]]);
    expect(plan.fill).toEqual([[-180, -90, 180, -60]]);
    expect(plan.edges).toEqual([
      { kind: 'parallel', at: -60, from: -180, to: 180 },
    ]);
    // The claim that matters: there is no meridian geometry at all, so the seam
    // cannot be drawn. Outlining that box as a rectangle would put a line at
    // 180° and a degenerate one at the pole.
    expect(lons(byId('south-polar-cap'))).toEqual([]);
  });

  it('the north polar cap mirrors it, and keeps its own parallel', () => {
    expect(lats(byId('north-polar-cap'))).toEqual([60]);
    expect(lons(byId('north-polar-cap'))).toEqual([]);
  });

  it('the near side keeps its meridians and drops both poles', () => {
    expect(spansAllLongitudes(byId('near-side').boxes[0])).toBe(false);
    expect(lons(byId('near-side'))).toEqual([-90, 90]);
    // lat -90 and +90 are single points: an edge there is a dot on the pole.
    expect(lats(byId('near-side'))).toEqual([]);
  });

  it('a band that touches neither pole gets both of its parallels', () => {
    const plan = outlinePlanFor({
      id: 'torrid-zone',
      name: 'Torrid Zone',
      kind: 'polar-cap',
      boxes: [[-180, -23.44, 180, 23.44]],
      derivedFrom: 'declared',
    });
    expect(plan.edges).toEqual([
      { kind: 'parallel', at: -23.44, from: -180, to: 180 },
      { kind: 'parallel', at: 23.44, from: -180, to: 180 },
    ]);
  });

  it('an ordinary box gets all four edges', () => {
    const plan = outlinePlanFor(byId('mare-orientale'));
    expect(plan.edges).toEqual([
      { kind: 'meridian', at: -99.96289999999999, from: -24.3901, to: -15.231 },
      { kind: 'meridian', at: -89.7414, from: -24.3901, to: -15.231 },
      { kind: 'parallel', at: -24.3901, from: -99.96289999999999, to: -89.7414 },
      { kind: 'parallel', at: -15.231, from: -99.96289999999999, to: -89.7414 },
    ]);
  });
});

describe('framing', () => {
  it('the far side frames the crossing rectangle, not the whole globe', () => {
    const view = byId('far-side');
    expect(view.boxes).toEqual([
      [-180, -90, -90, 90],
      [90, -90, 180, 90],
    ]);
    // min(west)..max(east) over those two is -180..180: an outline of nothing and
    // a camera parked at the wrong height. The covering rectangle is 90..-90.
    expect(areaRectangle(view)).toEqual([90, -90, -90, 90]);
    // Both boxes are half-width, so their own edges are all real.
    expect(outlinePlanFor(view).edges.length).toBe(4);
  });

  it('a mare frames its own box', () => {
    expect(areaRectangle(byId('mare-orientale'))).toEqual([
      -99.96289999999999, -24.3901, -89.7414, -15.231,
    ]);
  });

  it('an empty box list frames nothing rather than framing the world', () => {
    expect(
      areaRectangle({
        id: 'nothing',
        name: 'Nothing',
        kind: 'mare',
        boxes: [],
        derivedFrom: 'declared',
      }),
    ).toBeNull();
  });
});

describe('the property over all 61 shipped views', () => {
  it('every box contributes its real edges and nothing else', () => {
    expect(VIEWS.length).toBe(61);
    for (const view of VIEWS) {
      const plan = outlinePlanFor(view);
      expect(plan.fill).toEqual(view.boxes);
      const expected = view.boxes.flatMap(([west, south, east, north]) => {
        const full = spansAllLongitudes([west, south, east, north]);
        const parallels = [south, north]
          .filter((lat) => lat !== 90 && lat !== -90)
          .map((at) => ({
            kind: 'parallel' as const,
            at,
            from: full ? -180 : west,
            to: full ? 180 : east,
          }));
        return full
          ? parallels
          : [
              { kind: 'meridian' as const, at: west, from: south, to: north },
              { kind: 'meridian' as const, at: east, from: south, to: north },
              ...parallels,
            ];
      });
      expect(plan.edges, view.id).toEqual(expected);
      for (const edge of plan.edges) {
        expect(Number.isFinite(edge.at), view.id).toBe(true);
        // No zero-length edge is ever stroked.
        expect(edge.to, view.id).not.toBe(edge.from);
      }
    }
  });

  it('exactly the two caps are bands, and they are the only full-span boxes', () => {
    const bands = VIEWS.filter((v) => v.boxes.some(spansAllLongitudes));
    expect(bands.map((v) => v.id).sort()).toEqual([
      'north-polar-cap',
      'south-polar-cap',
    ]);
  });
});

describe('the area control groups every kind it can be given', () => {
  it('no kind is in the reader that is missing from the picker', () => {
    // `groupAreas` filters by `KIND_ORDER`, so a kind the emitter adds and this
    // list does not know would vanish from the control silently — an area that
    // exists and cannot be selected.
    for (const kind of VIEW_KINDS) {
      expect(KIND_ORDER, kind).toContain(kind);
      expect(KIND_LABELS[kind], kind).toBeTruthy();
    }
    expect(KIND_ORDER.length).toBe(VIEW_KINDS.length);
  });

  it('every one of the 61 areas lands in exactly one group', () => {
    const groups = groupAreas(VIEWS);
    expect(groups.reduce((n, g) => n + g.areas.length, 0)).toBe(VIEWS.length);
    expect(new Set(groups.flatMap((g) => g.areas.map((a) => a.id))).size).toBe(
      VIEWS.length,
    );
    expect(groups.map((g) => g.kind)).toEqual(
      KIND_ORDER.filter((k) => VIEWS.some((v) => v.kind === k)),
    );
    for (const group of groups) expect(group.areas.length).toBeGreaterThan(0);
  });

  it('the caps head the list, because they are what the feature was asked for', () => {
    const groups = groupAreas(VIEWS);
    expect(groups[0].kind).toBe('polar-cap');
    expect(groups[0].areas.map((a) => a.id).sort()).toEqual([
      'north-polar-cap',
      'south-polar-cap',
    ]);
    expect(groups[0].label).toBe('Polar caps');
  });
});
