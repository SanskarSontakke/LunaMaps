'use client';
import { useId } from 'react';
import {
  activeFilterCount,
  densityLabel,
  diameterBounds,
  formatCount,
  missionOptions,
  regionOptions,
  showingLabel,
  typeOptions,
  unmeasuredCount,
  type FilterState,
  type SortDirection,
  type SortKey,
  SORT_KEYS,
} from '@/lib/filters';
import { DENSITY_DEFAULT, DENSITY_MAX, DENSITY_MIN } from '@/lib/labels/tiers';
import type { Feature } from '@/types';

/**
 * The D10 filter controls: type, size range, mission, region and density, plus
 * the list's sort. Every option list is COUNTED from the features handed in
 * (`typeOptions` et al. in `src/lib/filters.ts`), never typed into this file — a
 * hardcoded list is how this project's search box ended up advertising "600
 * names" against a 1,585-name gazetteer, which is a claim about data the UI has
 * never seen.
 *
 * The component owns no state: `filters` comes from `MoonMap`, because the same
 * object has to drive the sidebar list AND the label layer on the map. A control
 * that kept its own copy would be a second source of truth about what is visible,
 * which is the failure D10 exists to prevent.
 */
export interface SortState {
  key: SortKey;
  direction: SortDirection;
}

export interface FilterPanelProps {
  features: readonly Feature[];
  filters: FilterState;
  sort: SortState;
  shown: number;
  onChange: (next: FilterState) => void;
  onSortChange: (next: SortState) => void;
  onClear: () => void;
}

/** Nothing selected — reachable by unticking the last box, and NOT the same
 *  thing as `'all'`. */
const NONE: ReadonlySet<string> = new Set<string>();

/** A range side, or `null` for "not written". Garbage is `null`, not `NaN`. */
function parseKm(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const finiteOr = (v: number): number => (Number.isFinite(v) ? v : Number.POSITIVE_INFINITY);

export default function FilterPanel({
  features,
  filters,
  sort,
  shown,
  onChange,
  onSortChange,
  onClear,
}: FilterPanelProps) {
  const uid = useId();
  const total = features.length;
  const types = typeOptions(features);
  const missions = missionOptions(features);
  const regions = regionOptions(features);
  const bounds = diameterBounds(features);
  const unmeasured = unmeasuredCount(features);
  const missionTotal = missions.reduce((n, m) => n + m.count, 0);
  const active = activeFilterCount(filters);
  const allTypes = filters.types === 'all';
  // The comparison is written out rather than reusing `allTypes`, because a
  // boolean variable does not narrow a union and `'all'` has no `.has`.
  const isSelected = (value: string): boolean =>
    filters.types === 'all' || filters.types.has(value);
  const range = filters.diameterKm;
  const minKm = range ? String(range[0]) : '';
  const maxKm = range && Number.isFinite(range[1]) ? String(range[1]) : '';

  /** Re-derive the type selection, collapsing "every box ticked" back to `'all'`
   *  so the state cannot hold 14 values that mean the same thing as one. */
  const toggleType = (value: string): void => {
    const next = new Set<string>();
    for (const option of types) {
      if (option.value === value) continue;
      if (isSelected(option.value)) next.add(option.value);
    }
    if (!isSelected(value)) next.add(value);
    onChange({ ...filters, types: next.size === types.length ? 'all' : next });
  };

  const setRange = (side: 'min' | 'max', raw: string): void => {
    const min = side === 'min' ? parseKm(raw) : range ? range[0] : null;
    const max = side === 'max' ? parseKm(raw) : range ? finiteOr(range[1]) : null;
    onChange({
      ...filters,
      diameterKm:
        min === null && max === null
          ? null
          : [min ?? 0, max ?? Number.POSITIVE_INFINITY],
    });
  };

  return (
    <div className="filters">
      <p className="filters-count" aria-live="polite" data-testid="filter-count">
        {showingLabel(shown, total)}
        {active > 0 ? ` · ${active} filter${active === 1 ? '' : 's'} on` : ''}
      </p>

      <fieldset className="filter-group">
        <legend>Feature type</legend>
        <label className="filter-row" data-value="">
          <input
            type="checkbox"
            checked={allTypes}
            onChange={() => onChange({ ...filters, types: allTypes ? NONE : 'all' })}
          />
          <span>All types</span>
          <span className="filter-count">{formatCount(total)}</span>
        </label>
        {types.map((option) => (
          <label className="filter-row" key={option.value} data-value={option.value}>
            <input
              type="checkbox"
              checked={isSelected(option.value)}
              onChange={() => toggleType(option.value)}
            />
            <span>{option.value}</span>
            <span className="filter-count">{formatCount(option.count)}</span>
          </label>
        ))}
      </fieldset>

      <fieldset className="filter-group">
        <legend>Diameter range (km)</legend>
        <div className="filter-range">
          <label className="filter-side">
            <span className="sr-only">Smallest diameter, kilometres</span>
            <span aria-hidden="true">min</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={bounds ? String(Math.round(bounds[0])) : '0'}
              value={minKm}
              onChange={(e) => setRange('min', e.target.value)}
            />
          </label>
          <span aria-hidden="true">–</span>
          <label className="filter-side">
            <span className="sr-only">Largest diameter, kilometres</span>
            <span aria-hidden="true">max</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              step="any"
              placeholder={bounds ? String(Math.round(bounds[1])) : 'any'}
              value={maxKm}
              onChange={(e) => setRange('max', e.target.value)}
            />
          </label>
        </div>
        <p className="filter-hint">
          {range
            ? `Names from ${formatCount(range[0])}–${
                Number.isFinite(range[1]) ? formatCount(range[1]) : 'any'
              } km.`
            : `Recorded diameters run ${
                bounds
                  ? `${formatCount(Math.round(bounds[0]))}–${formatCount(
                      Math.round(bounds[1]),
                    )} km.`
                  : 'no further.'
              }`}
          {unmeasured > 0
            ? ` A range hides the ${formatCount(unmeasured)} name${
                unmeasured === 1 ? '' : 's'
              } with no diameter recorded.`
            : ' Every name in the gazetteer carries a diameter.'}
        </p>
      </fieldset>

      <div className="filter-group">
        <label className="filter-field" htmlFor={`${uid}-mission`}>
          Mission
          <select
            id={`${uid}-mission`}
            value={filters.mission ?? ''}
            onChange={(e) =>
              onChange({
                ...filters,
                mission: e.target.value === '' ? null : e.target.value,
              })
            }
          >
            <option value="">Any mission</option>
            {missions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </select>
        </label>
        <p className="filter-hint">
          {formatCount(missionTotal)} of the {formatCount(total)} names carry a
          mission — the astronaut-named traverse sites. Selecting one hides every
          other name.
        </p>
      </div>

      <div className="filter-group">
        <label className="filter-field" htmlFor={`${uid}-region`}>
          Region (IAU quadrangle)
          <select
            id={`${uid}-region`}
            value={filters.region ?? ''}
            onChange={(e) =>
              onChange({
                ...filters,
                region: e.target.value === '' ? null : e.target.value,
              })
            }
          >
            <option value="">All quadrangles ({formatCount(regions.length)})</option>
            {regions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value} ({option.count})
              </option>
            ))}
          </select>
        </label>
        <p className="filter-hint">
          The quadrangle is the lunar atlas sheet the name was mapped on — the
          region partition the gazetteer itself carries.
        </p>
      </div>

      <div className="filter-group">
        <label className="filter-field" htmlFor={`${uid}-density`}>
          Label density
          <input
            id={`${uid}-density`}
            type="range"
            min={DENSITY_MIN}
            max={DENSITY_MAX}
            step={0.05}
            value={filters.density}
            aria-valuetext={densityLabel(filters.density)}
            onChange={(e) => onChange({ ...filters, density: Number(e.target.value) })}
          />
        </label>
        <p className="filter-hint" data-density-copy>
          {densityLabel(filters.density)}
        </p>
      </div>

      <div className="filter-group filter-sort">
        <label className="filter-field" htmlFor={`${uid}-sort`}>
          Sort list by
          <select
            id={`${uid}-sort`}
            value={sort.key}
            onChange={(e) =>
              onSortChange({ ...sort, key: e.target.value as SortKey })
            }
          >
            {SORT_KEYS.map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="filter-direction"
          aria-label={`Sort direction: ${
            sort.direction === 'asc' ? 'ascending' : 'descending'
          }. Activate to reverse.`}
          onClick={() =>
            onSortChange({
              ...sort,
              direction: (sort.direction === 'asc' ? 'desc' : 'asc') as SortDirection,
            })
          }
        >
          {sort.direction === 'asc' ? '↑ ascending' : '↓ descending'}
        </button>
      </div>

      <button
        type="button"
        className="filter-clear"
        onClick={onClear}
        disabled={active === 0 && filters.density === DENSITY_DEFAULT}
      >
        Clear filters
      </button>
    </div>
  );
}
