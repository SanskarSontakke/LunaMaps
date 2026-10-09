'use client';
import { useId, useMemo, useRef, useState } from 'react';
import { fuzzySearch } from '@/lib/search';
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
 */
export default function SearchBox({
  features,
  onChoose,
}: {
  features: FeatureCollection | null;
  onChoose: (feature: Feature) => void;
}) {
  const [query, setQuery] = useState('');
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

  const choose = (feature: Feature | undefined) => {
    if (!feature) return;
    onChoose(feature);
    setQuery(feature.properties.name);
    setOpen(false);
    setActive(-1);
    inputRef.current?.blur();
  };

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
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? optionId(active) : undefined}
        aria-autocomplete="list"
        aria-owns={listId}
        autoComplete="off"
        spellCheck={false}
        placeholder={
          features ? `Search ${features.features.length.toLocaleString('en-GB')} names…` : 'Search unavailable'
        }
        disabled={!features}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {open && results.length > 0 && (
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
      {features && open && query.trim() !== '' && results.length === 0 && (
        <div className="res-empty" role="status">
          No match for “{query.trim()}”.
        </div>
      )}
    </div>
  );
}
