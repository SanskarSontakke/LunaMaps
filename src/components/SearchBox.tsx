'use client';
import { useId, useMemo, useRef, useState } from 'react';
import { fuzzySearch } from '@/lib/search';
import {
  admittedNames,
  hasActiveMapFilter,
  mapFilters,
  type FilterState,
} from '@/lib/filters';
import type { Feature, FeatureCollection } from '@/types';

/** The keyboard `/` shortcut focuses the input with this id (see
 *  `attachKeyboard` → `handlers.focusSearch`), so it is one exported constant
 *  instead of a string duplicated in two files. */
export const SEARCH_INPUT_ID = 'moon-search-input';

/**
 * Label search. Hand-rolled matcher (`src/lib/search.ts`), no dependency.
 * Combobox pattern: the input carries `aria-expanded` / `aria-controls` /
 * `aria-activedescendant`, the results are a listbox of `role="option"`
 * buttons, and ArrowUp/ArrowDown/Enter/Escape drive it from the keyboard.
 *
 * D10 wiring: the query is the SAME string the sidebar list narrows on, so it is
 * lifted into `FilterState` when a parent provides one (`filters` +
 * `onQueryChange`) and kept locally when nobody does — every existing caller and
 * test renders this with just `features` and `onChoose`, and that path is
 * unchanged. The combobox still searches the WHOLE gazetteer, because a filter is
 * a view and a search is a question; what it does now is say so, naming how many
 * of its own answers the active filters would not draw. A result that silently
 * vanished behind a filter is the "filtering is silently empty" failure in the
 * other direction.
 */
export default function SearchBox({
  features,
  onChoose,
  filters,
  onQueryChange,
}: {
  features: FeatureCollection | null;
  onChoose: (feature: Feature) => void;
  /** The lifted filter state. Absent means "this box owns its own query". */
  filters?: FilterState;
  onQueryChange?: (next: string) => void;
}) {
  const [localQuery, setLocalQuery] = useState('');
  const controlled = filters !== undefined;
  const query = controlled ? filters.query : localQuery;
  const writeQuery = (next: string) => {
    if (controlled) onQueryChange?.(next);
    else setLocalQuery(next);
  };
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uid = useId();
  const listId = `${uid}-results`;
  const optionId = (i: number) => `${uid}-opt-${i}`;

  // 1,585 features x ~8 field scores per keystroke; the matcher is sub-millisecond
  // but the memo keeps it off the React render path on every unrelated state
  // change (camera readouts re-render at 8 Hz).
  const results = useMemo(
    () => (features ? fuzzySearch(query, features) : []),
    [query, features],
  );

  /** How many of these the D10 filters would keep off the map. Computed from the
   *  same `admittedNames` the canvas is handed, so the number and the map cannot
   *  disagree — and from the map-visible half of the state, so it never counts
   *  this box's own query as a filter. */
  const hiddenByFilters = useMemo(() => {
    if (!features || !filters || !hasActiveMapFilter(filters)) return 0;
    const allowed = admittedNames(features.features, mapFilters(filters));
    return results.filter((f) => !allowed.has(f.properties.name)).length;
  }, [features, filters, results]);

  const choose = (feature: Feature | undefined) => {
    if (!feature) return;
    onChoose(feature);
    writeQuery(feature.properties.name);
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
  };

  /** The listbox is in the document only while it is rendered, and
   *  `aria-controls` / `aria-owns` name an element by id — pointing at a node
   *  that is not there is a dangling reference, not a relationship. So the two
   *  attributes and the listbox itself are gated on the same condition, and the
   *  closed combobox simply omits them rather than keeping a hidden node alive to
   *  satisfy the id. */
  const listShown = open && results.length > 0;

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => (results.length ? (i + 1) % results.length : -1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) =>
        results.length ? (i <= 0 ? results.length - 1 : i - 1) : -1,
      );
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active >= 0 ? active : 0]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
      inputRef.current?.blur();
    }
  };

  return (
    <div className="ctl ctl-search">
      <input
        id={SEARCH_INPUT_ID}
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search lunar feature names"
        aria-expanded={listShown}
        aria-controls={listShown ? listId : undefined}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-autocomplete="list"
        aria-owns={listShown ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          features ? `Search ${features.features.length.toLocaleString('en-GB')} names…` : 'Search unavailable'
        }
        disabled={!features}
        value={query}
        onChange={(e) => {
          writeQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {listShown && (
        <div id={listId} role="listbox" aria-label="Search results">
          {results.map((f, i) => (
            <button
              key={`${f.properties.name}-${i}`}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              // Keep the input's focus (and therefore the combobox contract)
              // while a result is clicked.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(f)}
            >
              <span className="res-name">{f.properties.name}</span>
              <span className="res-kind">
                {f.properties.mission ?? f.properties.type}
              </span>
            </button>
          ))}
        </div>
      )}
      {listShown && hiddenByFilters > 0 && (
        <p className="res-filtered" role="status">
          {hiddenByFilters} of {hiddenByFilters === 1 ? 'it is' : 'these are'} hidden
          by the active filters, so the map is not drawing {hiddenByFilters === 1 ? 'it' : 'them'}.
        </p>
      )}
      {features && open && query.trim() !== '' && results.length === 0 && (
        <div className="res-empty" role="status">
          No match for “{query.trim()}”.
        </div>
      )}
    </div>
  );
}
