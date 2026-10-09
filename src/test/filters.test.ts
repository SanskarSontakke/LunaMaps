import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DENSITY_DEFAULT,
  DENSITY_MAX,
  DENSITY_MIN,
  createLabelGate,
  visibleTiers,
} from '@/lib/labels/tiers';
import { parseFeatureCollection } from '@/lib/features';
import {
  SORT_KEYS,
  activeFilterCount,
  admittedNames,
  applyFilters,
  defaultFilters,
  densityLabel,
  densityRanks,
  diameterBounds,
  formatCount,
  hasActiveMapFilter,
  isDefaultFilters,
  mapFilters,
  matchesFilters,
  missionOptions,
  rankFor,
  regionOptions,
  showingLabel,
  sortFeatures,
  typeOptions,
  unmeasuredCount,
  type FilterState,
  type SortKey,
} from '@/lib/filters';
import type { Feature, Tier } from '@/types';

/**
 * The D10/D9 model, measured against the shipped gazetteer rather than a fixture:
 * `public/data/features.json` through the same validator the app runs it through
 * (`src/lib/features.ts`), so every count below is a count of what the map draws
 * and not of what this file would like it to be. The brief's numbers — 1,585
 * names, 14 types, tiers 17/134/1353/81, `mission` on exactly the 81 — are
 * asserted here, because they are the numbers the option lists are derived from.
 */
const raw: unknown = JSON.parse(
  readFileSync('public/data/features.json', 'utf8'),
);
const parsed = parseFeatureCollection(raw);
if (!parsed) throw new Error('features.json was refused by its own validator');
const ALL = parsed.features;

const byName = (name: string): Feature => {
  const hit = ALL.find((f) => f.properties.name === name);
  if (!hit) throw new Error(`no feature named ${name} in the gazetteer`);
  return hit;
};

/**
 * Built from the module's own `defaultFilters()` rather than a literal copy of
 * it: a hand-written default here would drift the day a field is added, and
 * `isDefaultFilters` would then be asserting against a state the app never has.
 */
const state = (over: Partial<FilterState> = {}): FilterState => ({
  ...defaultFilters(),
  ...over,
});

describe('the gazetteer the option lists are derived from', () => {
  it('is the 1,585 names the app claims, with the tiers the brief states', () => {
    expect(ALL).toHaveLength(1585);
    const tiers = new Map<Tier, number>();
    for (const f of ALL) tiers.set(f.properties.tier, (tiers.get(f.properties.tier) ?? 0) + 1);
    expect([...tiers].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 17],
      [1, 134],
      [2, 1353],
      [3, 81],
    ]);
  });
  it('has 14 types, and `mission` only on the 81 astronaut-named traverse sites', () => {
    expect(typeOptions(ALL)).toHaveLength(14);
    expect(typeOptions(ALL)[0]).toEqual({ value: 'Crater, craters', count: 1319 });
    const withMission = ALL.filter((f) => f.properties.mission !== null);
    expect(withMission).toHaveLength(81);
    expect(new Set(withMission.map((f) => f.properties.tier))).toEqual(new Set([3]));
    expect(missionOptions(ALL).reduce((n, m) => n + m.count, 0)).toBe(81);
  });
  it('names every feature uniquely, which is what the name-set handoff assumes', () => {
    // `admittedNames` returns a Set of names and `selectByName` resolves a name,
    // so a duplicate would silently draw two features for one row.
    const names = ALL.map((f) => f.properties.name);
    expect(new Set(names).size).toBe(names.length);
  });
  it('carries 144 quadrangles and diameters from 0 to 2,592 km', () => {
    expect(regionOptions(ALL)).toHaveLength(144);
    expect(diameterBounds(ALL)).toEqual([0, 2592.2378]);
    expect(unmeasuredCount(ALL)).toBe(0);
  });
});

describe('applyFilters: every predicate, over the real data', () => {
  it('returns everything at the default state, in name order', () => {
    const out = applyFilters(ALL, state());
    expect(out).toHaveLength(1585);
    // The collation endpoints of the shipped file: `Abbe` precedes `Abel` and
    // `Zwicky` follows `Zupus` under both codepoint and `localeCompare` order, so
    // these two rows pin the whole 1,585-name list between them.
    expect(out[0].properties.name).toBe('Abbe');
    expect(out.at(-1)?.properties.name).toBe('Zwicky');
  });

  it('narrows to a type, and to the union of two types', () => {
    expect(applyFilters(ALL, state({ types: new Set(['Mare, maria']) }))).toHaveLength(22);
    const two = new Set(['Mare, maria', 'Sinus, sinūs']);
    expect(applyFilters(ALL, state({ types: two }))).toHaveLength(34);
  });

  it('answers the empty selection with an empty list, not the whole pool', () => {
    expect(applyFilters(ALL, state({ types: new Set<string>() }))).toEqual([]);
  });

  it('keeps a size range inclusive, and hides a name with no diameter', () => {
    const inRange = (km: number) =>
      applyFilters(ALL, state({ diameterKm: [0, km] })).length;
    expect(inRange(20)).toBe(
      ALL.filter((f) => (f.properties.diameterKm ?? -1) <= 20).length,
    );
    expect(inRange(0)).toBe(1); // `Planitia Descensus`, recorded as 0
    expect(inRange(2592.2378)).toBe(1585);
    // The `null` branch the shipped file never exercises: no diameter cannot
    // satisfy a numeric range, and `unmeasuredCount` is how the UI says so.
    const unmeasured = byName('Tycho');
    const synthetic: Feature = {
      ...unmeasured,
      properties: { ...unmeasured.properties, diameterKm: null },
    };
    expect(matchesFilters(synthetic, state())).toBe(true);
    expect(matchesFilters(synthetic, state({ diameterKm: [0, 100] }))).toBe(false);
    expect(unmeasuredCount([synthetic])).toBe(1);
  });

  it('treats a mission or region as “exactly this”, not “this or nothing”', () => {
    expect(applyFilters(ALL, state({ mission: 'Apollo 11' }))).toHaveLength(4);
    expect(applyFilters(ALL, state({ region: 'LAC-60' }))).toHaveLength(27);
    // A mission filter is also a type filter in disguise: only tier-3 names carry
    // one, so it must hide every crater, mare and rima on the Moon.
    const apollo = applyFilters(ALL, state({ mission: 'Apollo 17' }));
    expect(apollo).toHaveLength(29);
    expect(new Set(apollo.map((f) => f.properties.type))).toEqual(
      new Set(['Astronaut-named features']),
    );
  });

  it('composes: type AND size AND region together, not one at a time', () => {
    const out = applyFilters(
      ALL,
      state({
        types: new Set(['Crater, craters']),
        diameterKm: [100, 200],
        region: 'LAC-43',
      }),
    );
    const manual = ALL.filter(
      (f) =>
        f.properties.type === 'Crater, craters' &&
        f.properties.diameterKm !== null &&
        f.properties.diameterKm >= 100 &&
        f.properties.diameterKm <= 200 &&
        f.properties.quad === 'LAC-43',
    );
    expect(out.map((f) => f.properties.name)).toEqual(
      manual.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b)),
    );
  });

  it('narrows with the query through the ONE matcher the combobox uses', () => {
    const out = applyFilters(ALL, state({ query: 'tycho' }));
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((f) => f.properties.name)).toContain('Tycho');
    // A query the type filter also excludes yields nothing, rather than leaking
    // the unfiltered answer.
    expect(
      applyFilters(ALL, state({ query: 'tycho', types: new Set(['Oceanus, oceani']) })),
    ).toEqual([]);
    // Whitespace is not a query.
    expect(applyFilters(ALL, state({ query: '   ' }))).toHaveLength(1585);
  });

  it('does not mutate the pool it was handed', () => {
    const before = ALL.map((f) => f.properties.name);
    applyFilters(ALL, state({ query: 'mare' }), 'diameter', 'desc');
    expect(ALL.map((f) => f.properties.name)).toEqual(before);
  });
});

describe('sortFeatures: four keys, one total order', () => {
  for (const { key } of SORT_KEYS) {
    it(`${key}: ascending and descending are exact reversals, and ties break on name`, () => {
      const asc = applyFilters(ALL, state(), key);
      const desc = applyFilters(ALL, state(), key, 'desc');
      expect(asc.map((f) => f.properties.name)).not.toEqual(
        desc.map((f) => f.properties.name),
      );
      // Equal keys fall through to the name, so each ordering is fully determined
      // by the data: reversing must give the reverse.
      expect(asc.map((f) => f.properties.name)).toEqual(
        desc.map((f) => f.properties.name).reverse(),
      );
    });
  }

  it('is independent of the input order', () => {
    const keys: SortKey[] = ['name', 'diameter', 'tier', 'type'];
    for (const key of keys) {
      const a = sortFeatures(ALL, key);
      const b = sortFeatures([...ALL].reverse(), key);
      expect(a.map((f) => f.properties.name)).toEqual(b.map((f) => f.properties.name));
    }
  });

  it('sorts tier 0 first ascending, and keeps a null diameter last in BOTH directions', () => {
    const asc = sortFeatures(ALL, 'tier');
    expect(asc[0].properties.tier).toBe(0);
    expect(asc.at(-1)?.properties.tier).toBe(3);
    const unmeasured = byName('Tycho');
    const withNull: Feature = {
      ...unmeasured,
      properties: { ...unmeasured.properties, name: 'NoMeasure', diameterKm: null },
    };
    const pool = [withNull, byName('West'), byName('Mare Imbrium')];
    expect(sortFeatures(pool, 'diameter').at(-1)?.properties.name).toBe('NoMeasure');
    expect(sortFeatures(pool, 'diameter', 'desc').at(-1)?.properties.name).toBe(
      'NoMeasure',
    );
  });

  it('orders the tier key by tier, then name, so the list is stable on a tie', () => {
    const tiers = sortFeatures(ALL, 'tier').map((f) => f.properties.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    const tier0 = sortFeatures(ALL, 'tier').filter((f) => f.properties.tier === 0);
    expect(tier0.map((f) => f.properties.name)).toEqual(
      [...tier0.map((f) => f.properties.name)].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe('admittedNames: what the canvas is allowed to draw', () => {
  it('is everything at the default state', () => {
    expect(admittedNames(ALL, state()).size).toBe(1585);
  });
  it('follows the type, size, mission and region filters', () => {
    expect(admittedNames(ALL, state({ types: new Set(['Oceanus, oceani']) }))).toEqual(
      new Set(['Oceanus Procellarum']),
    );
    expect(admittedNames(ALL, state({ mission: 'Apollo 11' })).size).toBe(4);
  });
  it('ignores the query, because a search is a locator and not a view', () => {
    // D10 lists type, size range, mission, region and density as the controls that
    // drive map visibility. The query is not among them: typing `tyc` narrows the
    // LIST, and must not blank the map down to one name.
    expect(admittedNames(ALL, state({ query: 'tycho' })).size).toBe(1585);
    expect(applyFilters(ALL, state({ query: 'tycho' })).length).toBeLessThan(1585);
    expect(mapFilters(state({ query: 'tycho' })).query).toBe('');
    // Nothing to strip, so nothing copied: the no-op path hands back the state it
    // was given instead of a fresh object per call.
    const unchanged = state();
    expect(mapFilters(unchanged)).toBe(unchanged);
  });
});

describe('density: the default reproduces today’s shown counts exactly', () => {
  /** The rule `labels/entities.ts` implemented before the density control
   *  existed: a name is a declutter candidate iff its tier is in `visibleTiers`. */
  const shownBefore = (heightM: number, viewportPx: number): number => {
    const open = new Set(visibleTiers(heightM, viewportPx, 60));
    return ALL.filter((f) => open.has(f.properties.tier)).length;
  };
  /** The rule it implements now, with the gate at the default density. */
  const shownAfter = (heightM: number, viewportPx: number, density: number): number => {
    const gate = createLabelGate(viewportPx, 60, density);
    const ranks = densityRanks(ALL);
    const open = new Set(gate.tiersAt(heightM));
    return ALL.filter(
      (f) =>
        open.has(f.properties.tier) &&
        gate.admits(f.properties.tier, rankFor(ranks, f.properties.name), heightM),
    ).length;
  };

  const HEIGHTS = [5e3, 2e4, 1e5, 5e5, 1.0e6, 1.2e6, 2e6, 3.5e6, 6e6, 1e7, 2.6e7];
  const VIEWPORTS = [900, 805, 786, 564, 420];

  it('counts the same names at the default density, at every height and viewport', () => {
    for (const viewport of VIEWPORTS) {
      for (const height of HEIGHTS) {
        expect(shownAfter(height, viewport, DENSITY_DEFAULT), `${height}@${viewport}`).toBe(
          shownBefore(height, viewport),
        );
      }
    }
  });

  it('is not vacuous: the sweep actually spans both tier gates', () => {
    // A test that compared two constant numbers would pass for the wrong reason.
    const counts = new Set(HEIGHTS.map((h) => shownBefore(h, 900)));
    expect(counts.size).toBeGreaterThan(2);
    expect(Math.max(...counts)).toBe(1585);
    expect(Math.min(...counts)).toBe(98); // tier 0 (17) + tier 3 (81)
  });

  it('moves the count away from the default, in both directions', () => {
    const height = 1.4e6; // tier 2's gate on a 900 px view is just below this
    const base = shownAfter(height, 900, DENSITY_DEFAULT);
    expect(shownAfter(height, 900, DENSITY_MIN)).toBeLessThan(base);
    expect(shownAfter(height, 900, DENSITY_MAX)).toBeGreaterThan(base);
    // …and it never removes the head of a tier before the tier itself is gone.
    expect(shownAfter(height, 900, DENSITY_MIN)).toBeGreaterThanOrEqual(
      ALL.filter((f) => f.properties.tier <= 1).length,
    );
  });
});

describe('densityRanks: the order the multiplier bites against', () => {
  it('gives every name a rank in [0, 1], with the biggest at 0 and the tail at 1', () => {
    const ranks = densityRanks(ALL);
    expect(ranks.size).toBe(1585);
    for (const v of ranks.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    const tier2 = ALL.filter((f) => f.properties.tier === 2);
    const biggest = tier2.reduce((a, b) =>
      (a.properties.diameterKm ?? 0) > (b.properties.diameterKm ?? 0) ? a : b,
    );
    const smallest = tier2.reduce((a, b) =>
      (a.properties.diameterKm ?? 0) < (b.properties.diameterKm ?? 0) ? a : b,
    );
    expect(rankFor(ranks, biggest.properties.name)).toBe(0);
    expect(rankFor(ranks, smallest.properties.name)).toBe(1);
  });
  it('ranks a tier of one at 0, not by division', () => {
    const single = ALL.filter((f) => f.properties.type === 'Oceanus, oceani');
    expect(single).toHaveLength(1);
    expect(rankFor(densityRanks(single), single[0].properties.name)).toBe(0);
  });
  it('answers a name it has never seen with 0 — the visible end', () => {
    expect(rankFor(new Map(), 'Nowhere')).toBe(0);
  });
});

describe('the state copy the controls read', () => {
  it('counts what is on, and calls the default the default', () => {
    expect(isDefaultFilters(state())).toBe(true);
    expect(activeFilterCount(state())).toBe(0);
    expect(activeFilterCount(state({ query: 'x' }))).toBe(1);
    expect(activeFilterCount(state({ mission: 'Apollo 11', region: 'LAC-60' }))).toBe(2);
    // Density is never "on": it always has a value, and counting it would leave
    // "Clear filters" looking permanently armed.
    expect(activeFilterCount(state({ density: 2.5 }))).toBe(0);
    expect(isDefaultFilters(state({ density: 2.5 }))).toBe(false);
    expect(hasActiveMapFilter(state({ query: 'x' }))).toBe(false);
    expect(hasActiveMapFilter(state({ mission: 'Apollo 11' }))).toBe(true);
  });

  it('prints the row count the brief asks for, grouped', () => {
    expect(showingLabel(412, 1585)).toBe('showing 412 of 1,585');
    expect(formatCount(1585)).toBe('1,585');
    expect(showingLabel(0, 1585)).toBe('showing 0 of 1,585');
  });

  it('describes the density setting, and calls the default what it is', () => {
    expect(densityLabel(DENSITY_DEFAULT)).toMatch(/Standard/);
    expect(densityLabel(0.4)).toMatch(/Sparser/);
    expect(densityLabel(2)).toMatch(/Denser/);
    expect(densityLabel(Number.NaN)).toMatch(/Standard/);
  });
});
