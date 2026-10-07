# Verify 12 — label search and the provenance feature card

**Task:** 12 of 18 (plan `docs/superpowers/plans/2026-10-06-lunar-map-explorer.md` §Task 12).

Status: **implemented and unit-verified. No browser surface was driven by this run** (the
in-app tab reports a 0×0 viewport and the external tab cannot be scripted), so **nothing in
this file is a visual or interactive observation.** Every "verified" line below is a unit
test or a static check. Everything that requires eyes or a real keyboard is listed in
*Owed to the Task 18 sweep* with the exact steps.

## Verified at commit time by tests and static checks

| command | result |
|---|---|
| `npx vitest run` | **75 passed / 7 files** (search 16, provenance 8, morph 13, assets 15, declutter 9, tiers 7, grid 7) |
| `npx tsc --noEmit` | **exit 0, no diagnostics** (tsconfig `include` covers `**/*.tsx`, so `SearchBox.tsx` / `FeatureCard.tsx` are typechecked) |
| `.venv/Scripts/python.exe -m pytest scripts/tests -q` | **134 passed** |

TDD order actually followed: `src/test/search.test.ts` and `src/test/provenance.test.ts`
were written first and run — both failed with
`Error: Cannot find package '@/lib/search'` / `'@/lib/provenance'` (the modules did not
exist yet, and `flyToFeature`/`flyToHeightMeters` were not exported from `morph.ts`).
Then `src/lib/search.ts`, `src/lib/provenance.ts` and the two `morph.ts` exports were
written, and the same files went green.

### What the tests prove (all from the tracked `public/data/features.json`, 600 features)

Search behaviour — `src/test/search.test.ts`:

- `tranq` → **first result is `Mare Tranquillitatis`** (score 3 145 = substring 2 995 +
  importance 150; the only other `tranq` match in the set is its own gloss).
- `sea of tranquility` → **first result is `Mare Tranquillitatis`**, reached through the
  `gloss` field (`"Sea of Tranquility."` normalises to exactly the query → 10 000 × 0.85).
- `tycho` / `copern` / `arista` → first results are `Tycho`, `Copernicus`, `Aristarchus`.
- `apollo 11` → **exactly the four records whose `mission === "Apollo 11"`**: `West`,
  `Little West`, `Double`, `Mount Marilyn`. There is no feature named "Apollo 11"; the
  result set is asserted to be those four and nothing else, and `hits.every(mission ===
  'Apollo 11')` is asserted (plan-verbatim).
- `qxzvjw` → `[]`; `fuzzySearch('mare', fc, 3)` has length 3; `fuzzySearch('m', fc, 5)[0]`
  is tier ≤ 1 (`Mare Nubium`, tier 0).
- Empty query / empty candidate score 0; a tight subsequence (`tco` → `Tycho`) scores > 0.
- **Cross-check demanded by the dispatch:** the `Mare Tranquillitatis` record still carries
  bbox `[16.924, −4.0512, 45.4903, 19.3748]` (asserted to 3 decimals), and all four
  Apollo 11 hits have their `geometry.coordinates` inside that box:
  West 23.4908/0.6705, Little West 23.4756/0.6743, Double 23.4727/0.6738,
  Mount Marilyn 40.0/1.13.
- The 12 records with `bbox: null` (upstream defects) are still searchable by their exact
  name.

Card content — `src/test/provenance.test.ts`, against `cardContent()` which is the only
data source `FeatureCard.tsx` renders:

- The note **`Coordinates are planetocentric on the IAU2000 sphere, r = 1,737.4 km.`** is
  one exported constant (`PLANTOCENTRIC_NOTE`), and `cardContent(…).note` is that constant
  for every feature — so the printed note is pinned by test, not by reading JSX.
- Title `Mare Tranquillitatis`, subtitle (gloss) `"Sea of Tranquility."`, `Type` =
  `Mare, maria (ME)`, `Diameter` = **`875.7 km`** (from 875.74884), `Quadrangle` = **`LAC-61`**,
  `Approved` = the record's `approval` verbatim (matches `^\d{4}[-/]\d{2}[-/]\d{2}$`),
  lat/lon to 4 decimals **and** in degrees/minutes (`8.3487° (8°20.9′N)`,
  `30.8346° (30°50.1′E)`), `Extent` from `bbox`, `Gazetteer record` row carrying
  `href = http://planetarynames.wr.usgs.gov/Feature/3691`.
- `Mission` row appears **only** for visit features (`West` → `Apollo 11`; absent for the mare).
- Missing upstream values render as `not recorded`, never `null`/`NaN`/empty: the `bbox: null`
  record's `Extent` is `not recorded`, and a synthetic `diameterKm: null` gives `not recorded`.
- `formatDms` rounding: `0.6705 → 0°40.2′N`, `23.4908 → 23°29.4′E`, `-4.0512 → 4°03.1′S`,
  and a rounded-up 60.0′ carries into the degree (`0.99999 → 1°00.0′N`,
  `-89.99999 → 90°00.0′S`).

Camera (`flyToHeightMeters` / `flyToFeature`, unit-tested with a stub viewer and real
Cesium maths on `MOON_ELLIPSOID`):

- Height = `max(20 km, 4 × diameter)`, clamped to the controller limits:
  `0.1882 km → 20 000 m`, `60 km → 240 000 m`, `null → 240 000 m` (60 km default),
  `875.74884 km → 3 502 995 m`; for diameters 0…1e6 km the result is always within
  `[MIN_H 1 500, MAX_H 3.5e7]` and is a fixed point of `clampHeight`.
- `flyToFeature` calls `camera.flyTo` once, with a destination that round-trips back to
  the feature's lon/lat to 4 decimals, `height ≈ 20 000 m` measured on the **moon** radius
  (1 737 400 m, asserted), `pitch = −90°`, `heading = 0`, `duration > 0`.

Wiring (static read of `src/components/MoonMap.tsx`, not a runtime observation):
`SearchBox.onChoose` → `goToFeature` → `flyToFeature` + `selectFeature`; the existing
`attachPicking` callback now also calls `selectFeature`, so a label click opens the same
card (Task 11's `picked()` harness metric and `picking.ts` behaviour are unchanged —
`pickedRef` is still written by the pick path only). `FeatureCard` renders `null` while
nothing is selected and its close button calls `selectFeature(null)`. If
`/data/features.json` fails, `features` is `null`: `SearchBox` renders a disabled input with
`placeholder="Search unavailable"`, a `role="status"` note appears, and the map is otherwise
untouched (design §6).

## Deviations from the plan (deliberate, documented)

1. **`score()` subsequence branch is now token-guarded.** The plan's implementation and the
   plan's own test for `apollo 11` are mutually unsatisfiable: the plan's `score` accepts any
   whole-string subsequence, and `"jean louis rodolphe swiss zoologist geologist 1807 1873"`
   *does* contain `apollo 11` that way (a-p-o-l-l-o across three words, two `1`s in the life
   dates) → `Promontorium Agassiz` and `Compton` ranked 5th and 6th, so
   `hits.every(h => h.properties.mission === 'Apollo 11')` was **false**. The assertion was
   not weakened; the matcher was fixed — a subsequence hit now also requires every query
   token to be matchable inside a single candidate token. The plan's four `score` ordering
   assertions (`exact > prefix > substring > subsequence`, case/punctuation insensitivity)
   still pass with the same numbers (10 000 / 5 087 / 2 999 / 0).
2. **Card content moved to `src/lib/provenance.ts`.** Not in the plan's file list. The
   environment is vitest `environment: 'node'` with no DOM and no React testing library, and
   no new dependencies are allowed, so JSX cannot be rendered here. `cardContent()` is the
   card's view model and `FeatureCard.tsx` renders exactly it, which makes the briefed card
   contents testable instead of merely typed.
3. **Extra exports/tests beyond the plan:** `flyToHeightMeters` (the height rule split out of
   `flyToFeature` so it is assertable), `formatDms`, and three test files' worth of extra
   assertions listed above. `MoonHarness` gained dev-only `search(q)`, `selectByName(name)`
   and `selected()` so Task 18 can drive search without synthesising keystrokes.

## Not verified (honest list)

- That the search input, result list or card **appear** at all; that they are legible,
  correctly positioned (top-right, right column) or that `.ctl-search` / `.card` CSS renders
  as intended. No screenshot exists for this task.
- That `role="combobox"` + `aria-expanded` / `aria-controls` / `aria-activedescendant` behave
  for an assistive tech; the attributes are set from state in JSX, unit-tested only in the
  sense that the code assigns them.
- That ArrowDown/ArrowUp/Enter/Escape **fire**: `onKeyDown` is a React handler and no key
  event was dispatched against a real DOM node in this run.
- That `camera.flyTo` animates in the live scene (only that it is called with the right
  arguments on a stub viewer), that the tile pyramid keeps up with it, or that
  `requestRenderMode` pumps frames during the flight.
- That a real left-click on a label opens the card (`scene.pick` never worked in the hidden
  tab — Task 11's known limitation).
- That the external gazetteer link resolves (URLs are `http://planetarynames.wr.usgs.gov/…`
  and were not fetched; the local map is the product, the link is provenance).

## Owed to the Task 18 sweep

Preconditions: `npm run dev`, open the app in a **visible** tab (the harness needs real
frames), then:

1. **Search by latin name.** Click the top-right field, type `tranq`.
   Expect: `Mare Tranquillitatis` first in a list of ≤ 8 buttons. Same with `sea of
   tranquility` (arrives through the gloss), `tycho`, `copern`, `arista`.
   Console check without a keyboard:
   `__moonHarness.search('tranq')` → `['Mare Tranquillitatis', …]`,
   `__moonHarness.search('apollo 11')` → exactly
   `['Mount Marilyn', 'West', 'Little West', 'Double']` in that score order.
2. **Enter flies there.** ArrowDown to the first result, Enter.
   Expect: ~1.4 s camera flight, straight down, at 4 × 875.7 km ≈ 3 502 995 m for the mare;
   `__moonHarness.camera()` should then report lon ≈ 30.8346, lat ≈ 8.3487, height ≈ 3.503e6
   (clamped by MAX_H only if the viewport is extreme).
3. **Card contents.** Expect the card to print: title `Mare Tranquillitatis`, italic subtitle
   `"Sea of Tranquility."`, `Type | Mare, maria (ME)`, `Diameter | 875.7 km`,
   `Quadrangle | LAC-61`, `Approved | 1935/01/01` verbatim from the record — **the plan's
   Step 4 expectation says `1935-01-01` but the tracked record is `1935/01/01` (solidus;
   verified by code point 47, not by eyeballing output). The card prints the record, and
   the test asserts passthrough + `^\d{4}[-/]\d{2}[-/]\d{2}$` instead of hard-coding either
   separator.** Both coordinates
   in decimal and °/′, and the note
   `Coordinates are planetocentric on the IAU2000 sphere, r = 1,737.4 km.`
   Screenshot it.
4. **Apollo 11 cross-check in the UI.** Search `apollo 11`; expect **four** results, each with
   `Mission | Apollo 11` on its card; open `West` and confirm its coordinates
   (23.4908, 0.6705) fall inside the `Extent` row printed by the mare's own card
   (`16.9240…45.4903°, -4.0512…19.3748°`). Console:
   `__moonHarness.selectByName('West'); __moonHarness.selected().properties.mission`.
5. **Close behaviour.** The `Close` button and `Escape` (Task 13's keyboard) must dismiss the
   card; the canvas must stay interactive afterwards.
6. **Click → card.** Click the `Mare Tranquillitatis` label at the L5 home view;
   `__moonHarness.picked()` must return that feature and the card must show it. This closes
   the pick path Task 11 could not reach.
7. **Null-bbox records.** `__moonHarness.selectByName('Double')` (bbox is null upstream) must
   open a card whose `Extent` row says `not recorded` — no crash, no `NaN`.
8. **Degraded mode.** Temporarily rename `public/data/features.json` and reload: search input
   disabled with `Search unavailable`, the `role="status"` note visible, no labels, map still
   pannable. (Restore the file afterwards.)
9. Screenshots: empty search, opened result list, mare card, West card.
