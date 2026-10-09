'use client';
import { memo, useEffect, useMemo } from 'react';
import FilterPanel, { type SortState } from './FilterPanel';
import { applyFilters, formatCount, showingLabel, type FilterState } from '@/lib/filters';
import type { Feature } from '@/types';

/**
 * The D10 sidebar: the filtered, sorted list of place names, beside the map
 * whose visibility the same filters drive.
 *
 * A row is a `<button>` that flies the camera to the feature and opens its
 * existing card — through `onChoose`, which is `MoonMap`'s `goToFeature`, the same
 * owner the search result and the map click already use. No fly logic lives here,
 * so a row, a search result and a click cannot drift apart.
 *
 * COLLAPSED BY DEFAULT. The first render — the server render and the client's
 * first paint, which must match it — is collapsed, because the panel paints 288 px
 * wide (268 of content plus 10 px of padding each side) and over a 564 px phone that
 * is 51 % of the map — measured, not estimated. On a viewport wide enough to hold both
 * the panel and a usable map, the effect below opens it. That is an effect and
 * not an initial state on purpose: reading `window` during render would make the
 * server's markup and the client's disagree.
 *
 * The panel is a DISCLOSURE, so opening it never moves focus: the WAI-ARIA
 * pattern leaves the caret on the toggle, and the list is one Tab away. An
 * auto-focus here would also fire on page load, when the wide-viewport effect
 * opens the panel by itself — a focus steal from a control the user never
 * activated.
 *
 * The list is capped at `MAX_ROWS` and says so. Rendering 1,585 buttons on every
 * filter keystroke is the kind of cost that turns an 8 Hz camera readout into a
 * stutter; the cap bounds the DOM, and the header states the real total, so a
 * capped list is never mistaken for the whole selection.
 */
export const MAX_ROWS = 400;
export const SIDEBAR_LIST_ID = 'moon-sidebar-list';
export const SIDEBAR_PANEL_ID = 'moon-sidebar-panel';
export const SIDEBAR_TOGGLE_ID = 'moon-sidebar-toggle';
/** Wide enough that the panel is not most of the map. */
export const SIDEBAR_WIDE_PX = 900;

export interface SidebarProps {
  features: readonly Feature[] | null;
  filters: FilterState;
  sort: SortState;
  selectedName: string | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  onFiltersChange: (next: FilterState) => void;
  onSortChange: (next: SortState) => void;
  onClearFilters: () => void;
  onChoose: (feature: Feature) => void;
}

const round = (km: number): number => (km < 10 ? Math.round(km * 10) / 10 : Math.round(km));

/** One row: the name, what it is, how big it is, and which tier the map rates it. */
const Row = memo(function Row({
  feature,
  selected,
  onChoose,
}: {
  feature: Feature;
  selected: boolean;
  onChoose: (feature: Feature) => void;
}) {
  const p = feature.properties;
  return (
    <li className="sidebar-item">
      <button
        type="button"
        className="sidebar-row"
        // A row opens the card the map click opens, so it is navigation, not a
        // toggle: `aria-current` says which one is already on screen.
        aria-current={selected ? 'true' : undefined}
        onClick={() => onChoose(feature)}
      >
        <span className="sidebar-name">{p.name}</span>
        <span className="sidebar-meta">
          {p.mission ?? p.type}
          {p.diameterKm === null
            ? ' · diameter not recorded'
            : ` · Ø ${formatCount(round(p.diameterKm))} km`}
          {` · tier ${p.tier}`}
        </span>
      </button>
    </li>
  );
});

function Sidebar({
  features,
  filters,
  sort,
  selectedName,
  open,
  onToggle,
  onFiltersChange,
  onSortChange,
  onClearFilters,
  onChoose,
}: SidebarProps) {
  const total = features ? features.length : 0;
  const rows = useMemo(
    () => (features ? applyFilters(features, filters, sort.key, sort.direction) : []),
    [features, filters, sort],
  );
  const capped = rows.length > MAX_ROWS;

  // Open the panel by default where there is room for it. `matchMedia`, asked
  // once: a resize listener would fight a user who has already collapsed it by
  // hand, and the answer is not wanted during render.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    if (window.matchMedia(`(min-width: ${SIDEBAR_WIDE_PX}px)`).matches) onToggle(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="ctl sidebar-toggle-wrap">
        <button
          type="button"
          id={SIDEBAR_TOGGLE_ID}
          className="sidebar-toggle"
          aria-expanded={open}
          // Named only while the list is actually in the document: `aria-controls`
          // pointing at a node that is not rendered is a dangling reference, not a
          // relationship (the same rule `SearchBox` gates `aria-controls` on).
          aria-controls={open ? SIDEBAR_LIST_ID : undefined}
          onClick={() => onToggle(!open)}
        >
          {open ? 'Hide place list' : 'Place list'}
          <span className="sidebar-badge">
            {features ? formatCount(rows.length) : '—'}
          </span>
        </button>
      </div>
      {open && (
        <aside
          className="ctl sidebar"
          id={SIDEBAR_PANEL_ID}
          role="region"
          aria-label="Place names"
        >
          {features ? (
            <>
              <FilterPanel
                features={features}
                filters={filters}
                sort={sort}
                shown={rows.length}
                onChange={onFiltersChange}
                onSortChange={onSortChange}
                onClear={onClearFilters}
              />
              <p className="sidebar-list-head" data-testid="sidebar-head">
                {showingLabel(rows.length, total)}
                {capped
                  ? ` · the first ${formatCount(MAX_ROWS)} are listed below — narrow the filters for the rest`
                  : ''}
              </p>
              {rows.length === 0 ? (
                <p className="sidebar-empty" role="status">
                  No name matches these filters.
                </p>
              ) : (
                <ol
                  id={SIDEBAR_LIST_ID}
                  className="sidebar-list"
                  aria-label={`Place names matching the filters, sorted by ${sort.key}, ${sort.direction}ending`}
                >
                  {rows.slice(0, MAX_ROWS).map((f) => (
                    <Row
                      key={f.properties.name}
                      feature={f}
                      selected={f.properties.name === selectedName}
                      onChoose={onChoose}
                    />
                  ))}
                </ol>
              )}
            </>
          ) : (
            <p className="sidebar-empty" role="status">
              Place names are unavailable, so there is nothing to list.
            </p>
          )}
        </aside>
      )}
    </>
  );
}

/** Memoised because `MoonMap` re-renders at up to 8 Hz from the scale readout;
 *  with stable props (all of them state or `useCallback`) a camera move must not
 *  re-render 400 rows. */
export default memo(Sidebar);
