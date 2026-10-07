# Verify 11 — label tiers, declutter, traverse dots

**Task:** 11 of 18 (`task-11-brief.md`).

Gate status: **implemented and unit-verified. No visual check has been made, and none is
claimed by this file.** Subtlety of the names, absence of on-screen overlap, tier
progression while zooming, dot persistence and Paper↔Globe stability have **never been
looked at by a human eye**. They are owed to the Task 18 browser sweep (see the last
section). This task also exposes no screenshots: no browser surface was driven by the
commit run at all.

## Verified at commit time by unit tests and static checks (this run)

Commands and real output:

| command | result |
|---|---|
| `npx vitest run` | **32 passed / 5 files** (declutter 9, tiers 7, grid 7, assets 4, morph 5) |
| `npx tsc --noEmit` | **exit 0, no diagnostics** |
| `.venv/Scripts/python.exe -m pytest scripts/tests -q` | **124 passed**, 9.50 s |

Properties proven by tests (not by looking):

- **`declutter` is pure and order-independent** (`src/test/declutter.test.ts`): it sorts a
  copy (`[...items].sort`) and never mutates the caller's array or boxes; ties break on
  `id`, so `declutter(items)` equals `declutter([...items].reverse())`. Highest priority
  survives a collision; a 5-label chain collapses to the top-ranked survivor; a 400 px
  wide label spans several `cellPx = 96` cells and is still kept; empty input returns `[]`.
- **`overlaps`** detects intersection and containment and treats touching edges as
  non-overlapping (`x+w` strict), which is what makes the no-overlap guarantee inclusive
  rather than accidental.
- **Tier gating is grid-derived, not magic numbers** (`src/test/tiers.test.ts`):
  `TIER_FROM_LEVEL = {0: null, 1: 1, 2: 3, 3: null}` and
  `visibleTiers(h) = [0,1,2,3].filter(t => h <= cameraHeightForLevel(TIER_FROM_LEVEL[t], 900, 60))`
  with `null` meaning "always visible". Recomputed independently for this run:
  `cameraHeightForLevel(1, 900, 60) ≈ 4.150e6 m`, `cameraHeightForLevel(3, 900, 60) = 1 038 640 m`.
- **`tierPriority`** ranks every lower tier above every higher one (`(3-tier)*1e6` base,
  size capped at 9 999 km × 10 so a tier can never be outvoted by size), and breaks ties
  inside a tier by diameter.
- **Data shape matches the renderer** (recomputed from the tracked
  `public/data/features.json` for this run): 600 features, tiers **17 / 134 / 368 / 81**
  (0/1/2/3), no feature missing `name` or `diameterKm`; the 81 tier-3 sites span lon
  −23.4…40.0°, lat −9.2…26.3° — i.e. all near-side, which is why they cluster on one limb.
- **Style constants are exactly the briefed ones** (`src/lib/labels/entities.ts`): fill
  `rgba(238,238,238,0.62)`, outline `rgba(0,0,0,0.68)` at 1.5 px, `FILL_AND_OUTLINE`,
  `500 13px system-ui`, `translucencyByDistance NearFarScalar(2e4, 0.85, 2.2e6, 0.25)`,
  `scaleByDistance NearFarScalar(2e4, 0.95, 2.2e6, 0.72)`, tier-3 dot 6 px
  `rgba(255,214,102,0.85)` with 1 px black outline. Low contrast + distance fade are
  therefore *specified and shipped*, but their on-screen effect is unmeasured.
- **Wiring is complete, not half-wired** (read in `src/components/MoonMap.tsx`):
  `attachLabels` runs once (guarded by `labelsRef.current`), `labels.refresh(...)` is
  called immediately on attach **and** from a `postRender` listener throttled to 125 ms
  (8 Hz) with `getCameraState(viewer).height`; `attachPicking` is registered and its
  detach function is returned. Cleanup removes the `postRender` listener, calls
  `labels.destroy()` (removes all 600 entities) and `detachPick()`, and nulls the ref, so
  a StrictMode double-mount attaches exactly once. If a fetch of `/data/features.json`
  fails, `features` stays `null`, no labels are attached, and the map still works —
  the design §6 degraded-mode path.
- **Served asset path is live**: `GET http://localhost:3110/data/features.json` → 200,
  270 531 bytes (the dev server from the implementing session is still listening on 3110;
  the commit run started nothing, and queried it read-only).

## Numbers from the implementing session's hidden-tab harness — NOT reproduced here

The table below is the prior session's transcript, taken through
`globalThis.__moonHarness` (`labelCount()`, `shownEntities()` =
`viewer.entities.values.filter(e => e.show).length`, the brief's metric, `refreshLabels`,
`setCamera`) on a 531×786 canvas, camera centred at (0°, 0°). The commit run could not
re-measure any of it (browser work belongs to Task 18), so treat these as **unconfirmed
inputs to that sweep**, not as evidence of passing.

| height (m) | visible tiers | shown entities | labels | dots |
|---|---|---|---|---|
| 2.2e7 | [0, 3] | 84 | 3 | 81 |
| 3.5e6 | [0, 1, 3] | 116 | 35 | 81 |
| 4e5 | [0, 1, 2, 3] | 3 | 3 | 0 |

Interpretation recorded then: 84 = the 81 near-side tier-3 **dots** (point graphics skip
the declutter contest; only their *text* competes) + the 3 tier-0 names that fit; at 4e5 m
the ~462 km nadir window holds no traverse site and only 3 named features.

## Deviations from the brief (deliberate, documented)

1. **`tiers.test.ts` test 3.** The brief asserts `visibleTiers(1.2e6, 900, 60) ===
   [0, 1, 2, 3]`, but with the brief's *own* formula and the documented
   `TIER_FROM_LEVEL = {2: 3}` the threshold is `cameraHeightForLevel(3, 900, 60) =
   1 038 640 m < 1.2e6` — the two brief assertions (level mapping, tier-2-at-1.2e6) are
   mutually unsatisfiable. Re-derived for this run, so the contradiction is real and not a
   measurement artifact. The shipped test uses 1.0e6 for "regional scale" and pins the
   boundary explicitly (`> 1.0e6`, `< 1.2e6`, `visibleTiers(1.2e6) === [0, 1, 3]`).
   Nothing was weakened: that test now carries 4 assertions instead of 1, and design
   §4.1 ("T2 shown from tile level 3") is preserved.
2. **Label visibility plumbing.** The brief sets `show: false` *inside* the label graphics
   and toggles `entity.show` in `refresh` — as literally written, `entity.show = true`
   would still draw no text, so no label could ever appear. Shipped code hides via
   `show: false` on the entity and toggles `entity.show` per refresh; tier 3 additionally
   toggles `entity.label.show` through a `ConstantProperty`, so the dots stay up at every
   height while their names compete. This is the change the brief's own Step 6 expectation
   requires, not a redesign.
3. **Two gates the brief's `refresh` lacked**, both needed for the briefed behaviour: a
   horizon test in `SCENE3D` (a point is a candidate only when the angle between its
   surface normal and the camera direction is acute — with
   `disableDepthTestDistance: ∞` nothing else stops far-side names painting across the
   disk), and an on-screen box filter so off-viewport names don't occupy declutter cells.
   Plus scratch `Cartesian3` reuse, since this runs over 600 entities at 8 Hz.
4. **Extras beyond the brief's interfaces:** `LabelSet.shown` and
   `tierVisibleMaxHeight` (the tier-2 threshold in metres) are public; `shown` is
   currently unconsumed (the harness counts `viewer.entities.values` directly) and is a
   candidate for Task 12 or removal. `MoonMap` gained harness methods
   `labelCount / shownEntities / refreshLabels / picked`, which is how the brief's Step 6
   metric is readable at all.
5. **`MoonMap` dedup, checked against `git show HEAD`:** the Task 10 commit assigned
   `applied.current = { mode, layer }` twice in the same effect (once after viewer
   creation, once after `viewerRef.current = viewer`). Task 11 removed only the redundant
   second assignment; no mode/layer behaviour changed.

## Not verified (honest list)

- **Every visual property.** No screenshot exists for this task: the implementing session's
  `take_screenshot` returned `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE (visible=false)`, the
  same wall as Gate G1 and Task 10, and the commit run opened no browser at all. Faintness,
  legibility against the albedo, outline weight, and the 0.72–0.95 distance scale are
  unread. "Labels do not overlap" is proven for the *algorithm* by unit tests; that no
  rendered pair overlaps on a real canvas is **not** observed evidence.
- **The "~17 names from deep space" product target.** All 17 tier-0 features are
  tier-visible at every height (that part is arithmetic + unit-tested), but how many of
  them land on the near side, survive the horizon gate and fit without overlap at a given
  canvas size was only ever reported through the harness table above.
- **Click → pick.** `attachPicking` mounts and unmounts cleanly and its read path
  (`scene.pick(position)` → `entity.properties.feature` → `setSelectedFeature`) typechecks
  and compiles, but it has **no unit test** and end-to-end picking never worked in the
  hidden tab (`scene.pick` returned nothing without a composited surface). Deferred to
  Task 12, which is the first consumer.
- **Real user drag / wheel zoom while labels refresh** — synthetic PointerEvents do not
  reach Cesium's controller in this harness (same limitation as Task 10); the camera was
  moved with `setView`, which exercises the same `postRender` path but not the same input.

## Owed to the Task 18 browser sweep

1. At the L5 home view: a handful of faint names with dark outlines around Mare
   Tranquillitatis; legible but subordinate to the imagery.
2. Zoom out to the full globe: tier-0 only (~17 candidates), **no visible overlap**, the
   81 amber traverse dots still present.
3. Zoom in past ~4.15e6 m: craters (tier 1) appear; past 1 038 640 m: rimae/catenae
   (tier 2). Recheck the two thresholds at a real viewport height rather than 900 px.
4. Click a label → `__moonHarness.picked()` returns its feature (closes Task 12's first
   requirement); the feature card shows it.
5. Paper↔Globe round trip: the visible name set must not thrash.
6. Screenshots at 2.2e7 / 3.5e6 / 4e5 m, and `viewer.entities.values.filter(e => e.show).length`
   re-measured in the same breath, replacing the unconfirmed table above.
7. One real drag and one wheel-zoom, to confirm the 8 Hz refresh keeps up and costs no
   visible stutter.
