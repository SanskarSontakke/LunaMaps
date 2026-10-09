import { fuzzySearch } from '@/lib/search';
import {
  DENSITY_DEFAULT,
  clampDensity,
  tierPriority,
} from '@/lib/labels/tiers';
import type { Feature } from '@/types';

/**
 * The filter and sort model behind amendment 2's **D10** ("filters drive a
 * collapsible sidebar list as well as map visibility") and the density half of
 * **D9**.
 *
 * Pure on purpose: no React, no Cesium, no DOM. Every rule a control can set is
 * answerable here from a `Feature` and a `FilterState`, which is what lets
 * `src/test/filters.test.ts` measure the whole model against the real
 * `public/data/features.json` — 1,585 validated features — instead of against a
 * component that would need a browser to render.
 *
 * Three rules shaped it:
 *
 * 1. **One matcher, not two.** The query field is narrowed with
 *    `fuzzySearch` (`src/lib/search.ts`), the same function the combobox uses,
 *    so a name the search box finds is a name the list can show. Re-implementing
 *    the scoring here would put two answers to "does it match?" in the app, which
 *    is how a filter starts disagreeing with the search it sits next to.
 * 2. **Every predicate is total over the validated data.** `diameterKm`, `bbox`
 *    and `mission` are `| null` in `FeatureProps` and `src/lib/features.ts`
 *    guarantees only that, so nothing below asserts a value with `!`: a null is
 *    handled in the branch that reads it, and the branch is tested.
 * 3. **Option lists come from the data.** `typeOptions` / `missionOptions` /
 *    `regionOptions` count what is loaded. A hardcoded type array is how this
 *    project's search box ended up reading "600 names" against a 1,585-name
 *    gazetteer; the counts below are derived, so the day the gazetteer changes
 *    the controls change with it.
 */

// ---------------------------------------------------------------- the state --

/** Sort keys, per D10: the list is sorted, and the user says by what. */
export type SortKey = 'name' | 'diameter' | 'tier' | 'type';
export type SortDirection = 'asc' | 'desc';

/**
 * `'all'` rather than "a Set containing every type", because the two mean
 * different things when the gazetteer grows: an exhaustive Set silently hides a
 * type nobody listed, while `'all'` is the statement "nothing is excluded".
 */
export type TypeSelection = 'all' | ReadonlySet<string>;

export interface FilterState {
  /** The `properties.type` strings on the map, or `'all'`. */
  types: TypeSelection;
  /** `[min, max]` in km, inclusive, or `null` for "no size constraint". */
  diameterKm: [number, number] | null;
  /** A `properties.mission`, or `null`. Only tier-3 traverse features carry one. */
  mission: string | null;
  /**
   * The region filter, answered honestly by the only region partition the
   * gazetteer actually carries: `properties.quad`, the IAU lunar atlas
   * quadrangle (144 of them in the shipped file).
   *
   * Deliberately NOT the framing regions of amendment 2's D8/D11
   * (`public/data/regions.json`, `src/lib/viewRegions.ts`): that schema is being
   * built in another change, and a filter that read it would be a filter that
   * cannot load until it lands.
   */
  region: string | null;
  /** The free-text query, shared with the combobox. Trimmed by the matcher. */
  query: string;
  /**
   * The D9 density setting. A multiplier on the tier gates — see
   * `labels/tiers.ts`'s `densityHeightScale` — where `DENSITY_DEFAULT` is
   * today's behaviour exactly. It gates what the MAP draws; it never gates this
   * list (see `applyFilters`), because a list that shrinks when you zoom out is a
   * list that lies about what the filters selected.
   */
  density: number;
}

/** The state the app boots with: everything selected, nothing narrowed. */
export function defaultFilters(): FilterState {
  return {
    types: 'all',
    diameterKm: null,
    mission: null,
    region: null,
    query: '',
    density: DENSITY_DEFAULT,
  };
}

/** One `{ value, count }` row of a derived option list. */
export interface FilterOption {
  value: string;
  count: number;
}

// ------------------------------------------------------------- the predicates --

/** Is this `properties.type` selected? */
export function typeSelected(state: FilterState, type: string): boolean {
  return state.types === 'all' || state.types.has(type);
}

/**
 * Does a recorded diameter fall inside the range?
 *
 * `null` — "the gazetteer has no diameter for this name" — fails an active range
 * and passes a null range. A name with no size cannot be shown to satisfy a size
 * constraint, and `unmeasuredCount` exists so the UI can say how many names a
 * range hid for that reason instead of letting the list look short.
 */
export function diameterSelected(
  diameterKm: number | null,
  range: [number, number] | null,
): boolean {
  if (range === null) return true;
  if (diameterKm === null) return false;
  return diameterKm >= range[0] && diameterKm <= range[1];
}

/** Mission filter: `null` means "any mission", not "features with no mission". */
export function missionSelected(state: FilterState, mission: string | null): boolean {
  return state.mission === null || state.mission === mission;
}

/** Quadrangle filter, on the same `null`-means-any rule. */
export function regionSelected(state: FilterState, quad: string): boolean {
  return state.region === null || state.region === quad;
}

/**
 * Every non-query predicate at once. The query is excluded because it is applied
 * by the shared matcher, which needs the whole pool to rank in (see
 * `applyFilters`), not feature-by-feature.
 */
export function matchesFilters(f: Feature, state: FilterState): boolean {
  const p = f.properties;
  return (
    typeSelected(state, p.type) &&
    diameterSelected(p.diameterKm, state.diameterKm) &&
    missionSelected(state, p.mission) &&
    regionSelected(state, p.quad)
  );
}

/** Is the query empty? (Whitespace alone is empty: `fuzzySearch` says so too.) */
export const hasQuery = (state: FilterState): boolean => state.query.trim() !== '';

/**
 * The features the filters let through, in `key` order.
 *
 * `state.density` is NOT consulted: density is a map-drawing control (D9's "how
 * many names are drawn at a given zoom"), and the sidebar's job is to list what
 * the *filters* selected. The map side of the same state is applied in
 * `labels/entities.ts`, which reads `density` through `createLabelGate` and the
 * name set this function's result is turned into by `admittedNames`.
 */
export function applyFilters(
  features: readonly Feature[],
  state: FilterState,
  key: SortKey = 'name',
  direction: SortDirection = 'asc',
): Feature[] {
  const pool = hasQuery(state)
    ? // `limit` is the whole pool, so this is the combobox's ranking without the
      // truncation the combobox needs and a 1,585-row list does not.
      fuzzySearch(state.query, { type: 'FeatureCollection', features: features.slice() }, features.length)
    : features.slice();
  return sortFeatures(
    pool.filter((f) => matchesFilters(f, state)),
    key,
    direction,
  );
}

/**
 * The map-visible half of the state: everything except the search query.
 *
 * D10 names the controls that drive map visibility — "type, size range, mission,
 * region, density" — and the query is not among them. A query is a *locator*: it
 * narrows the list to find one name, and typing `tyc` must not blank the map down
 * to Tycho and leave the user zooming out to an empty Moon wondering where the
 * labels went. So the list gets the query and the canvas does not.
 */
export function mapFilters(state: FilterState): FilterState {
  return state.query === '' ? state : { ...state, query: '' };
}

/** The names the map may draw: the non-query filters applied to the gazetteer. */
export function admittedNames(
  features: readonly Feature[],
  state: FilterState,
): Set<string> {
  const kept = applyFilters(features, mapFilters(state), 'name');
  const names = new Set<string>();
  for (const f of kept) names.add(f.properties.name);
  return names;
}

// ------------------------------------------------------------------- sorting --

const byName = (a: Feature, b: Feature) =>
  a.properties.name.localeCompare(b.properties.name);

/**
 * A total order on every key. Two names of equal diameter, equal tier and equal
 * type still land in the same row on every run and in every browser, because
 * each comparator falls through to `byName`; `src/test/filters.test.ts` asserts
 * that the result is independent of input order.
 *
 * The fallthrough is multiplied by `sign` along with the primary key, so
 * `desc` is the exact reverse of `asc` rather than "same ties, flipped keys" —
 * which is what makes a two-state sort toggle predictable: pressing it again
 * turns the list inside out, ties and all.
 *
 * A feature with no recorded diameter sorts last on `diameter` in both
 * directions: "unknown" is not zero, and sorting it to the top would present it
 * as the smallest thing on the Moon. That fixed placement is the one departure
 * from exact reversal — inside the unmeasured block the names do reverse — and
 * it does not arise in the shipped gazetteer, where `unmeasuredCount` is 0.
 */
export function sortFeatures(
  list: readonly Feature[],
  key: SortKey,
  direction: SortDirection = 'asc',
): Feature[] {
  const sign = direction === 'asc' ? 1 : -1;
  const compare = (a: Feature, b: Feature): number => {
    switch (key) {
      case 'diameter': {
        const av = a.properties.diameterKm;
        const bv = b.properties.diameterKm;
        if (av === null && bv === null) return byName(a, b) * sign;
        if (av === null) return 1;
        if (bv === null) return -1;
        return av === bv ? byName(a, b) * sign : (av - bv) * sign;
      }
      case 'tier': {
        const d = a.properties.tier - b.properties.tier;
        return d === 0 ? byName(a, b) * sign : d * sign;
      }
      case 'type': {
        const d = a.properties.type.localeCompare(b.properties.type);
        return d === 0 ? byName(a, b) * sign : d * sign;
      }
      case 'name':
      default:
        return byName(a, b) * sign;
    }
  };
  return list.slice().sort(compare);
}

/** The labels the sort control shows, in the order the control lists them. */
export const SORT_KEYS: readonly { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'diameter', label: 'Diameter' },
  { key: 'tier', label: 'Prominence (tier)' },
  { key: 'type', label: 'Type' },
];

// -------------------------------------------------------- derived option lists --

/** Count rows, most populous first, then alphabetical — a stable option order. */
function tally(values: readonly string[]): FilterOption[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/** The 14 `properties.type` values present, with their counts. */
export const typeOptions = (features: readonly Feature[]): FilterOption[] =>
  tally(features.map((f) => f.properties.type));

/** The missions present — `Apollo 11` … `Apollo 17`, from the 81 tier-3 names. */
export const missionOptions = (features: readonly Feature[]): FilterOption[] =>
  tally(features.map((f) => f.properties.mission).filter((m): m is string => m !== null));

/** The IAU quadrangles present, with their counts. */
export const regionOptions = (features: readonly Feature[]): FilterOption[] =>
  tally(features.map((f) => f.properties.quad));

/** `[min, max]` over the recorded diameters, or `null` when none are recorded. */
export function diameterBounds(
  features: readonly Feature[],
): [number, number] | null {
  let min = Infinity;
  let max = -Infinity;
  for (const f of features) {
    const d = f.properties.diameterKm;
    if (d === null) continue;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return Number.isFinite(min) && Number.isFinite(max) ? [min, max] : null;
}

/** How many names carry no diameter at all — the ones a size range must hide. */
export const unmeasuredCount = (features: readonly Feature[]): number =>
  features.reduce((n, f) => n + (f.properties.diameterKm === null ? 1 : 0), 0);

// -------------------------------------------------------------------- density --

/**
 * Where each name sits inside its own tier, `0` = the largest name in the tier
 * and `1` = the tail, by the same `tierPriority` the declutter ranks with.
 *
 * This is what turns the density control from a two-position switch into a
 * gradient: the tier gate is one altitude, and 1,353 names share tier 2's, so a
 * multiplier on the gate alone could only ever hide them all at once. Giving each
 * name a rank inside its tier and scaling the gate by it means the tail of a tier
 * closes first and reopens last, which is what "how many names are drawn" asks
 * for. Keyed by name, which `src/test/filters.test.ts` proves unique over the
 * shipped gazetteer — the same uniqueness `selectByName` already relies on.
 */
export function densityRanks(features: readonly Feature[]): Map<string, number> {
  const byTier = new Map<Feature['properties']['tier'], Feature[]>();
  for (const f of features) {
    const list = byTier.get(f.properties.tier);
    if (list) list.push(f);
    else byTier.set(f.properties.tier, [f]);
  }
  const ranks = new Map<string, number>();
  for (const list of byTier.values()) {
    const ordered = list.slice().sort(
      (a, b) =>
        tierPriority(b.properties.tier, b.properties.diameterKm) -
          tierPriority(a.properties.tier, a.properties.diameterKm) ||
        byName(a, b),
    );
    const last = ordered.length - 1;
    ordered.forEach((f, i) => {
      ranks.set(f.properties.name, last === 0 ? 0 : i / last);
    });
  }
  return ranks;
}

/** A name's rank, or `0` — the most visible end — for a name not in the map. */
export function rankFor(ranks: ReadonlyMap<string, number>, name: string): number {
  return ranks.get(name) ?? 0;
}

// ----------------------------------------------------------------- state copy --

/**
 * How many narrowing controls are set. Density is excluded: it is never "off",
 * it has a value at all times, and counting it would make "Clear filters" look
 * permanently armed.
 */
export function activeFilterCount(state: FilterState): number {
  let n = 0;
  if (state.types !== 'all') n += 1;
  if (state.diameterKm !== null) n += 1;
  if (state.mission !== null) n += 1;
  if (state.region !== null) n += 1;
  if (hasQuery(state)) n += 1;
  return n;
}

export const isDefaultFilters = (state: FilterState): boolean =>
  activeFilterCount(state) === 0 && state.density === DENSITY_DEFAULT;

/** Is anything the CANVAS listens to switched on? (The query is not one of them —
 *  see `mapFilters`.) `SearchBox` uses this to decide whether it has to explain a
 *  result the map will not draw. */
export const hasActiveMapFilter = (state: FilterState): boolean =>
  activeFilterCount(mapFilters(state)) > 0;

/** `1,585` — the grouping the row count and the search placeholder share. */
export const formatCount = (n: number): string => n.toLocaleString('en-GB');

/** The D10 row-count line, e.g. `showing 412 of 1,585`. */
export function showingLabel(shown: number, total: number): string {
  return `showing ${formatCount(shown)} of ${formatCount(total)}`;
}

/**
 * What the density slider is about to do, in the words the control prints.
 *
 * The slider moves the tier gates, not a "number of labels" dial, so the copy
 * says which end of a tier it is removing and from what altitude — a control
 * labelled "density 0.4" with no unit is a control the user cannot predict.
 */
export function densityLabel(density: number): string {
  const d = clampDensity(density);
  if (Math.abs(d - DENSITY_DEFAULT) < 0.005) {
    return 'Standard — every name the zoom already allows is drawn';
  }
  const which = d < DENSITY_DEFAULT ? 'Sparser' : 'Denser';
  return `${which} — the tail of each tier is drawn at ${d.toFixed(2)}× its usual altitude`;
}

