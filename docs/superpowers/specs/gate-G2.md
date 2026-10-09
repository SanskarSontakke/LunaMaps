# Gate G2 — geometry proof against real imagery

**Task:** 9 of 18 (`task-9-brief.md`), spec §5.1.
**Run by:** the Task 9 implementation agent, 2026-10-07, against the Tier A tile
pyramid in the working tree: `public/tiles/paper/**` and `public/tiles/photo/**`,
L0–L6, 10,922 tiles per layer. **Those tiles are gitignored build output, not a
commit** — `git ls-files public/tiles` returns `manifest.json` only, and the
pyramid is produced by `npm run bake` (the bake code is what `560a264` committed).
Every number below was measured off that working-tree pyramid and can be
re-measured only by producing it again: `npm run fetch && npm run bake` first, or
`npm run proof` stops with
`SystemExit: no paper tiles at level 5 under public/tiles`.
**Verdict: G2 PASSES.** Every requirement is met with margin, on real LRO WAC
imagery and the real IAU label set, and the pass is *falsifiable* — the same
measurements run against deliberately mis-registered imagery produce the wrong
sign, which is the only reason the pass means anything.

| Requirement (plan) | Threshold | Measured | Margin |
|---|---|---|---|
| mare median < highland median | strict | **33.5 < 80.5** | +47.0 DN |
| contrast | ≥ 25 DN | **47.0 DN** | 1.9× the floor |
| mare median below the global mean | strict | 33.5 vs mean 64.34 | −30.8 DN |
| highland median above the global mean | strict | 80.5 vs mean 64.34 | +16.2 DN |
| ≥ 15 mare markers present | 15 | **20 / 20** | +5 |
| ≥ 15 highland markers present | 15 | **16 / 16** | +1 |
| 4 Apollo 11 features inside the Tranquillitatis bbox (`bbox_contains`) | all 4 | **4 / 4** | — |
| 4 Apollo 11 features read dark (≤ p67 = 76) | all 4 | **28, 28, 28, 57** | worst 19 DN of headroom |
| `albedoHistogram` + `geometryProof` in `manifest.json` | — | written, exit 0 | — |

Commands, verbatim results: `npm run labels` → exit 0, `bbox defects: 19 found, 20
known, 0 new`, `curated: 600`, and **no drift** in `public/data/features.json`
(`git diff --stat` empty). `npm run proof` → exit 0, `GATE G2 PASS`.
`.venv/Scripts/python.exe -m pytest scripts/tests -q -W error` → **134 passed**, zero
warnings (124 before the review round; the 10 added tests are 7 that read specific
in-tile blocks of the new `ramp_pyramid` fixture, 2 for the missing-marker failure
string, and 1 that a failing `main()` leaves `manifest.json` strict-JSON parseable).
`npx vitest run` → **7 passed** as Task 9 closed (**32** by the end of this review round,
after Tasks 10–11 added their own; G2 gates no frontend test). Re-run after the review
round, on the same working-tree pyramid: the verdict and every number in the JSON below
are unchanged.

---

## The full output of `npm run proof`

```json
{
 "passed": true,
 "level": 5,
 "mareSamples": 20,
 "highlandSamples": 16,
 "mareMedian": 33.5,
 "highlandMedian": 80.5,
 "contrast": 47.0,
 "histogram": {
  "level": 5,
  "mean": 64.34,
  "p33": 47,
  "p67": 76,
  "samples": 536870912,
  "tiles": 2048
 },
 "checks": {
  "mare:Mare Tranquillitatis": "25",
  "mare:Mare Imbrium": "34",
  "mare:Mare Crisium": "33",
  "mare:Oceanus Procellarum": "27",
  "mare:Mare Fecunditatis": "34",
  "mare:Mare Nubium": "29",
  "mare:Mare Serenitatis": "34",
  "mare:Mare Marginis": "37",
  "mare:Mare Humboldtianum": "35",
  "mare:Mare Vaporum": "33",
  "mare:Mare Nectaris": "49",
  "mare:Mare Frigoris": "47",
  "mare:Mare Cognitum": "33",
  "mare:Mare Insularum": "33",
  "mare:Mare Orientale": "56",
  "mare:Mare Undarum": "31",
  "mare:Mare Smythii": "37",
  "mare:Sinus Iridum": "35",
  "mare:Lacus Mortis": "0",
  "mare:Lacus Felicitatis": "26",
  "highland:Tycho": "54",
  "highland:Copernicus": "168",
  "highland:Kepler": "73",
  "highland:Aristarchus": "123",
  "highland:Clavius": "142",
  "highland:Theophilus": "144",
  "highland:Langrenus": "141",
  "highland:Janssen": "63",
  "highland:Maginus": "79",
  "highland:Ptolemaeus": "52",
  "highland:Petavius": "82",
  "highland:Piccolomini": "6",
  "highland:Regiomontanus": "97",
  "highland:Avogadro": "96",
  "highland:Hermite": "8",
  "highland:Messala": "68",
  "apollo11:West": "23.4908,0.6705 albedo 28",
  "apollo11:Mount Marilyn": "40.0000,1.1300 albedo 57",
  "apollo11:Little West": "23.4756,0.6743 albedo 28",
  "apollo11:Double": "23.4727,0.6738 albedo 28"
 },
 "failures": []
}
```

Sorted, so the medians are auditable by hand:

```
mare (n=20)      0 25 26 27 29 31 33 33 33 33 | 34 34 34 35 35 37 37 47 49 56   median 33.5
highland (n=16)  6 8 52 54 63 68 73 79 | 82 96 97 123 141 142 144 168           median 80.5
```

Three of the 36 single-pixel reads are outliers, and the median is what makes them
harmless (spec §5.1 check 2 is deliberately median-based, "not per-feature thresholds"):
`Lacus Mortis` 0, `Hermite` 8 and `Piccolomini` 6. They move no decision — 33.5 and 80.5
are set by the middle of each list, not its tails. Per-marker values are recorded for
diagnosis and are **not** gating.

## Why the outliers are real Moon, not a broken pipeline

A single dark read at a bright feature could be a hole in the bake, so each suspicious
point was re-read straight out of the source raster
(`data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2`, 303.2 px/deg, a 13×13 source window ≈
one L5 pixel) and compared to the tile:

| point | lon, lat | tile DN | source 13×13 mean | source range | window DN-0 share |
|---|---|---|---|---|---|
| Lacus Mortis | 27.32, 45.13 | **0** | 0.3 | 0–3 | 81.7% |
| Piccolomini | 32.20, −29.70 | **6** | 5.4 | 0–29 | 8.9% |
| Hermite | −93.32, 86.17 | **8** | 17.5 | 0–74 | 0.6% |
| Tycho | −11.22, −43.30 | 54 | 56.9 | 13–123 | 0.0% |
| Apollo 11 / West | 23.49, 0.67 | 28 | 28.5 | 18–42 | 0.0% |
| Mare Orientale | −94.67, −19.87 | 56 | 55.5 | 48–61 | 0.0% |
| Mare Frigoris | −0.01, 57.59 | 47 | 50.9 | 41–63 | 0.0% |
| **North pole** | **0.00, 89.50** | **1** | **0.0** | **0–0** | **100.0%** |
| **South pole** | **0.00, −89.50** | **0** | **0.1** | **0–2** | **95.9%** |
| **Equator control** | **0.00, 0.00** | **38** | **38.4** | **29–53** | **0.0%** |

Nine of the ten pairs agree within 4 DN. `Hermite` is the exception and it is the polar
defect, not a lookup error: its 13×13 source window spans 0–74, so an average-resampled
pixel there can legitimately land anywhere in that range. What the check actually rules out
is the signature of a flip, a rotation or an off-by-one tile index — a marker reading a
value that belongs to a *distant* region — and no marker does that.

The last three rows are the polar evidence the first version of this document lacked, and
they close the DN-0 question below rather than opening a new one: read straight from
`LRO_WAC_Mosaic_Global_303ppd_v3.jp2`, the source at 0 E / 89.5 N is **entirely zeros** and
at 0 E / −89.5 S it is 95.9% zeros, and the tiles say 1 and 0. The equatorial control, read
with the same code path two rows earlier, agrees to 0.4 DN with no zeros anywhere in its
window. The black is in the mosaic we sample, not in the sampler. (`Lacus Mortis`, 81.7%
zeros in a *mid-latitude* window, is the same phenomenon locally: a dark mantle deposit in
the source, which is why its tile reads 0 and why single-pixel reads are not gating.)

So `Piccolomini 6` is geology (its floor is the dark hummocky landslide terrain), and
`Lacus Mortis 0` is a dark mantle deposit in the source mosaic. Neither is an indexing
error. That check exists because the gate reads single pixels, and a single pixel is
exactly where a subtle geometry bug would hide.

## Falsifiability: what the numbers would have been if the map were wrong

The gate's own statistic was re-measured on the **real** L5 tiles with the lookup
deliberately mis-registered two ways. `σ` = 40.35 DN, the standard deviation of the
global L5 paper distribution.

**Point lookups (the gate's own method, 20 mare / 16 highland centroids):**

| registration | mare median | highland median | contrast | verdict G2 would print |
|---|---|---|---|---|
| **true** | 33.5 | 80.5 | **+47.0 DN (+1.16 σ)** | PASS |
| latitude mirrored (`lat → −lat`, the `y`-flip signature) | 51.5 | 50.0 | **−1.5 DN (−0.04 σ)** | FAIL: "mare median 51.5 is not darker than highland median 50.0" + "contrast −1.5 DN is below the 25.0 DN floor" |
| longitude rotated (`lon → lon+180`, the far-side signature) | 76.5 | 60.0 | **−16.5 DN (−0.41 σ)** | FAIL: "mare median 76.5 is not darker than highland median 60.0" — the maria read *brighter* than the craters |

**Footprint lookups (every L5 pixel inside each trusted gazetteer bbox, a much larger
sample, so a different statistic with the same direction):**

| registration | mare footprint median | highland footprint median | contrast |
|---|---|---|---|
| true | 40.5 | 73.5 | **+33.0 DN** |
| latitude mirrored | 56.0 | 49.0 | **−7.0 DN** |
| longitude rotated | 76.5 | 61.5 | **−15.0 DN** |

This is the same effect the bake agent measured independently at region scale (mare
medians 1.67–2.15 σ below crater medians at true latitude, collapsing to 0.24–0.49 σ
when mirrored). Point-based here: +1.16 σ → −0.04 σ. **A flipped or rotated map does not
merely lower the contrast, it inverts its sign**, which is what `mare_med < high_med`
catches. This closes the gap G1 left open (gate-G1.md, consequence 7: "a per-row `y`
error in the real bake is not browser-detectable … it is caught by Task 9's albedo
proof"). It is now caught.

**The Apollo 11 sub-check, measured the same way** (reads against p67 = 76):

| registration | West | Little West | Double | Mount Marilyn | does check 3 fire? |
|---|---|---|---|---|---|
| true | 28 | 28 | 28 | 57 | no (correct) |
| latitude mirrored | 60 | 43 | 43 | 46 | **no** — Tranquillitatis straddles the equator, so a mirrored lookup is still mare |
| longitude rotated | 118 | 135 | 135 | 65 | **yes** — 3 of 4 exceed p67 |

Stating that plainly matters more than claiming coverage: **check 3 pins the longitude
and the label placement; check 2 pins the `y` direction.** Neither alone covers both, and
this document does not pretend otherwise.

## The synthetic pyramids in `scripts/tests/test_proof.py`

Real imagery cannot be re-baked per test, so the lookup math and the gate's sign are
pinned by three synthetic pyramids.

1. **`indexed_pyramid`** — L1 (4 cols × 2 rows), each tile filled with the constant
   `10*x + y`, so every tile is distinguishable and a wrong index returns a wrong number
   rather than plausible noise. It exercises `tile_pixel`'s real index math through
   `grid`: all four longitude columns, both rows, row 0 = north, the poles clamping into
   rows 0 and 1, a missing tile raising `FileNotFoundError` instead of reading 0, and the
   **antimeridian**: `tile_pixel(…, 180.0, …) == tile_pixel(…, −180.0, …)`, with `179.9`
   and `−179.9` still landing in the world's last and first columns.
2. **`ramp_pyramid`** — the same L1 grid, but each tile holds a **unique 16 × 16 pattern**
   (32 px blocks, DN = `block_row * 16 + block_col`) instead of a constant. A constant tile
   can only falsify the tile *index*: inside it `im[row, col]`, `im[col, row]` and
   `im[row, 511−col]` all return the same DN, so the within-tile half of `tile_pixel` was
   unfalsifiable — and the gate on real imagery cannot see such an error either, because a
   mis-pointed in-tile pixel still sits inside the same 5.6° tile (0.011° of mis-aiming per
   pixel, far below the medians' resolution). The pattern is asymmetric in row and column,
   so a transposition or an in-tile mirror changes the read at every off-diagonal block,
   and its orientation alternates with the parity of `x + y`, so a wrong tile index that
   keeps the in-tile offset changes it too. Seven tests (`test_in_tile_lookup_reads_the_
   right_block`, six blocks, plus `test_in_tile_lookup_distinguishes_neighbouring_blocks`)
   read block centres, 16 px from any edge, so neither a float truncation nor JPEG
   step-edge ringing can move them.
3. **`synthetic_globe`** — an L4 pyramid (512 tiles) standing for a correctly registered
   Moon: tiles holding a mare centroid are dark (30 DN), tiles holding a ray crater are
   bright (200 DN), everything else is 120 DN, and the tiles containing the four Apollo 11
   points are dark because they lie inside the Tranquillitatis bbox. `run_proof` on it
   **PASSES**. The same pyramid is then rebuilt **mirrored in row order** (`y → rows−1−y`)
   and **rotated by half the columns** (`x → (x+16) mod 32`) — the two geometry errors,
   produced by moving the imagery, not the labels — and `run_proof` **FAILS** on both. The
   failure required is now the **sign branch by name** (`'not darker'`, exactly one, with
   both medians quoted in it), not the old `… or 'contrast' in f` disjunction: both
   transforms level the medians at 120.0 DN and so also trip the 25 DN floor and the mean
   checks, which is why deleting `if not mare_med < high_med:` entirely used to leave the
   suite green. That is the gate's falsifiability asserted in CI, not just measured once.
4. **Wrap-aware containment is mutation-tested.** A fixture with a seam-crossing
   Tranquillitatis bbox `[170, −5, −170, 5]` puts `West` at 179.5 E *inside* it and
   `Double` at −160 *outside*, and the proof reports exactly one "is outside" failure.
   Verified against a naive `w <= lon <= e`: the naive version reports **two**, falsely
   condemning `West`. So the requirement that the proof import `labels.bbox_contains` is
   pinned by a test that fails if anyone swaps it back.
5. The marker lists are pinned by **presence and class**, never by measured albedo:
   `test_every_marker_resolves_in_the_shipped_label_set` (every name must exist in the
   shipped `features.json`) and `test_marker_lists_are_class_pure` (mare list ⊆
   `labels.MARE_CODES`, highland list all code `AA`, dark-floored craters in neither).
   `test_gate_constants_are_the_planned_ones` pins `MIN_CONTRAST_DN == 25.0`,
   `MIN_SAMPLES == 15`, `PROBE_LEVEL == 5`, so lowering a threshold to get a pass has to
   be a deliberate edit to a passing test.

### Mutation ledger: every new test proven to bite

A pinning test that passes on correct code proves nothing on its own, so each of the five
was checked against the defect it is supposed to catch. Each mutation was applied to
`scripts/proof.py`, the suite run, and the file restored (SHA-256 verified against the
pre-mutation copy each time). `134 passed` is the unmutated state.

| mutation applied to `proof.py` | tests that then failed | before this round |
|---|---|---|
| `im[row, col]` → `im[col, row]` (in-tile transposition) | 7 — every `ramp_pyramid` test | **survived**: 124 passed, 18 of them in `test_proof.py` |
| `im[row, col]` → `im[row, 511 − col]` (in-tile mirror) | the same 7 | **survived** |
| `if not mare_med < high_med:` branch deleted | 2 — `flipped_or_rotated[flip-y]`, `[rot-180]` | **survived**: the old `… or 'contrast' in f` assertion accepted the floor failure instead, so the sign check itself was unpinned |
| the `{kind} marker absent from the curated set:` append deleted | 2 — `unresolvable_marker[highland]`, `[mare]` | **survived**: the string existed in code with no test on it (15/19 samples still cleared `MIN_SAMPLES`, so the gate still passed) |
| `main()` restored to HEAD's write path (no `_json_safe`, default `allow_nan`) | 1 — `a_failing_proof_leaves_a_strictly_parseable_manifest`, on `'NaN' not in text` | **survived**, and the written manifest carried literal `NaN`, which node's `JSON.parse` rejects: `Unexpected token 'N', …"highlandMedian": NaN… is not valid JSON` |

The failure-path fix chosen is **`null`, not "skip the write"**: a skipped write leaves the
previous PASS numbers in `manifest.json` as stale evidence, which is the worse of the two
failure modes for an artifact whose whole purpose is to record the verdict. `main()` now
sanitises non-finite floats to `null` recursively and writes with `allow_nan=False`, so a
value the sanitiser missed raises *before* `write_text` rather than corrupting the file
after it. The printed JSON on stdout is sanitised the same way, so a failed run's log is
parseable too. On a passing run none of this changes a byte — see the re-run below.

### Two bugs in the brief's test snippet, fixed rather than inherited

Both the brief and the plan carry them, so they are documented here rather than silently
patched.

1. `assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 10.0, 80.0) == 10`. At L1 the
   grid has **4 columns of 90°** (`grid.level_cols(1)`, pinned by the golden vectors and by
   G1 criterion 4), so 10° E is `x = 2` → `20`. The value `10` is column `x = 1`, i.e.
   −10°. The assertion was kept as `== 20` and a `−10.0 → 10` case was added, so all four
   columns are covered instead of three.
2. `test_lookup_is_continuous_across_the_seam` cannot pass against the plan's
   `tile_pixel`: `grid.lon_to_tile_x(180.0, 1)` clamps to the last column (`x = 3` → 30)
   while `−180.0` gives `x = 0` → 0, so the plan's own test contradicts the plan's own
   implementation. Since +180 and −180 are the *same meridian*, the fold was added to
   `tile_pixel` (`lon = wrap_lon(lon)`, `labels.wrap_lon`, whose contract already states
   `wrap_lon(180.0) == −180.0`). This is the correct reading of the seam and cannot change
   the real gate result: `wrap_lon` is identity on `(−180, 180)`, and every one of the 36
   markers and 4 Apollo points lies strictly inside that range.

## Marker substitution record (diagnosis step 4)

**Replaced `Cyrano` with `Messala` in `HIGHLAND_CENTRES`.**

- `Cyrano` is a genuine IAU record (code `AA`, 79.58 km), but it is **not in the curated
  set**: `curate()` prunes tier 2 first and smallest-first (`DROP_ORDER[2] == 0`,
  70 km floor), and at 79.58 km it falls below the surviving tier-2 cut. An unresolvable
  name is a silent no-op: `run_proof` appends `highland marker absent from the curated
  set: Cyrano`, which fails the gate for a bookkeeping reason while contributing nothing
  to the measurement. The plan's comment asserts "every name here was confirmed present in
  the gazetteer" — true of the *gazetteer*, false of the *curated set*, and the curated
  set is what the gate can look up.
- Grounds for the replacement, per the diagnosis rule (presence and feature class only):
  `Messala` — IAU code `AA`, 122.40 km, 60.06 E 39.31 N, present in the curated set at
  tier 2, a ray crater in the continental north-east, floor not basalt-flooded. Same class
  as `Cyrano` (an `AA` crater, not a mare/lacus) and 16 resolvable highland markers rather
  than 15, so the sample floor has one marker of headroom instead of zero.
- Selection was **not** made on measured albedo. Candidates also present in the curated set
  — `Zeeman`, `Fracastorius`, `Mersenius`, `Van de Graaff` — were rejected on the
  geological rule the spec already states for Plato/Grimaldi/Wargentin: a basalt-flooded
  or heavily degraded floor makes a poor *bright* marker. Recording that keeps the lists
  defensible as inputs rather than tuned as outputs.
- The mare list needed no substitution: all 20 names resolve.

## G2 FAILS-STOP: the diagnosis checklist, and which branch fired

No branch (1)–(3) fired; the gate passed. Branch (4), "one or two named markers fail",
fired in the weaker form of an unresolvable name and is recorded above. Nothing in
`bake.py`, `grid.py`, `composite.py`, `labels.py`, `contract.py` or `src/` was changed for
this task, because the evidence did not point at any of them — and the source-vs-tile
table above is what rules out a silent bake fault specifically.

## Deviations from the plan's `proof.py` code, with reasons

1. **`albedo_percentiles` streams into a 256-bin histogram** instead of
   `np.concatenate([a.ravel() …])` over the L5 layer. The plan's version materialises
   536,870,912 pixels as float32 = **2.15 GB**, plus a second copy for the concatenation —
   ~4.3 GB peak, which would OOM the laptop this bake ran on. The decoded tiles are uint8,
   so a histogram is *exact*, and mean/p33/p67 come from it (nearest-rank percentiles;
   `test_percentiles_are_the_measured_distribution` pins mean 15.5, p33 10, p67 21 on a
   distribution where those numbers are computable by hand). Runtime: 2,048 tiles in ~3 s.
   `tiles` and `level` are added to the returned dict; `samples` keeps its meaning (pixel
   count, 536,870,912).
2. **`tile_pixel` folds its longitude with `labels.wrap_lon`** — see bug 2 above.
3. **UTF-8 pinned** on every read/write (`features.json`, `manifest.json`). This is not
   cosmetic — the plan's literal `Path(features_path).read_text()` **crashes on this
   machine**: it decodes with the cp1252 locale codec and raises
   `UnicodeDecodeError: 'charmap' codec can't decode byte 0x81 in position 67636`. 41 fields
   in the shipped label set carry codepoints outside cp1252, mostly the IAU type strings
   (`"Lacus, lacūs"`, `"Sinus, sinūs"` — U+016B) and names like `Von Kármán`, `Poincaré`,
   `Rimae Römer`, `Mons Rümker`. `labels.py` already documents the same trap on the write
   side. Removing the pin re-breaks `test_every_marker_resolves_in_the_shipped_label_set`,
   which reads the real file through `proof._by_name`, so the defect cannot come back
   silently.
4. **`MIN_SAMPLES` is a named constant** (15) instead of a literal, and `run_proof` returns
   `level`, `mareSamples`, `highlandSamples` and `contrast` in addition to the planned keys,
   because "the counts printed" is the required failure output for requirement 4 and the
   manifest should carry the verdict's inputs. `main()`'s `geometryProof` block therefore
   also records `level`, the two medians and the contrast, so the shipped manifest is
   self-explaining without the console log.
5. **The highland list** carries `Messala` where the plan carries `Cyrano` — see the
   substitution record.

## What G2 does NOT prove

Read this before citing the pass.

- **Not a sub-pixel or small-offset proof.** At L5 one pixel is 333 m, so 100 m moves a
  third of a pixel and nothing here would see it. That risk is pinned by the corner-origin
  and golden-vector tests in Task 3 (`test-vectors/grid.json`, mirrored in `src/lib/grid.ts`),
  and by G1's `y`-origin criteria. G2's honest resolution floor is ~333 m, and a whole-tile
  error is what it detects. The *arithmetic* of the within-tile offset is separately pinned
  by `ramp_pyramid` (see the mutation ledger), so an in-tile transposition or mirror cannot
  be introduced silently either — but a real mis-aiming smaller than one tile moves the
  sample without moving the median, and no test here would notice.
- **Not a per-row bake error proof below the marker scale.** The gate samples 36 points. A
  swap of two *adjacent* tile rows that both sit inside mare, or two adjacent columns inside
  Oceanus Procellarum, changes nothing measurable. Row/column order errors are caught when
  they move a feature across the mare/highland boundary, which is exactly what a systematic
  flip or rotation does.
- **Not a statement that the labels are right, or that the imagery is right.** It proves
  the two *agree*. If both were shifted together the gate would pass. What defends against
  that is their independence (USGS shapefile DBF vs. a NASA mosaic raster, different
  producers, different projections) plus the source-vs-tile check above, which ties the
  tiles to the raster the labels were *not* derived from. It also does not re-verify the
  gazetteer's own coordinates: `Mount Marilyn` is stored as exactly `40.0 E, 1.13 N`
  (rounded to two decimals upstream), which is why the check is containment in a 28°×23°
  mare bbox and not a distance to a point.
- **Not a proof about the `photo` layer.** Everything measured is the `paper` layer, which
  is the raw `detail` band (LRO WAC albedo, `MINISBLACK`) with no gain applied, so DN here
  really is albedo. `photo` shares the identical tile grid and the identical `x`/`y` index
  math (same bake loop, same `grid` calls) and inherits the conclusion, but its chroma
  transfer was never tested for geometry — it cannot be, since colour has no mare/highland
  sign to check.
- **Not a visual-quality gate.** It says nothing about seams, JPEG artefacts, resampling
  look, or the polar data defect below. Those belong to Tasks 13/16/18.
- **Not an antimeridian *rendering* proof.** `bbox_contains`'s wrap branch is exercised by
  the mutation test, but no gating marker sits near the seam, so a wrongly wrapped real
  feature would not be caught by this run. Task 11 (label declutter at the seam) is where
  that shows up.

## Concern found (upstream data, not geometry): the paper layer is black over the poles

35,454,232 of the 536,870,912 L5 `paper` pixels — **6.60% — read DN 0**, and they are not
scattered: they are concentrated in the polar latitude bands, symmetric in both
hemispheres, so they are in the LRO WAC v3 source rather than anything our bake did. The
`photo` layer proves the same thing from the other side: photo is
`chroma_detail(base = lroc_color_poles.tif, detail = WAC band, k = 0.4)`, so the WAC
supplies only injected high frequencies there, and `photo/5/0/0.jpg` has a mean of 167.3
with 0.0004% exact zeros where `paper/5/0/0.jpg` has mean 35.2 and 32.7% exact zeros. The
hole is therefore in the WAC albedo raster itself, and in photo mode it shows as a loss of
detail at the poles rather than as black.

That is now measured rather than argued: `scripts/g2_geometry_probe.py --sources` samples
the source raster at 0 E / ±89.5° and at the equator, and the 13×13 windows there are
**100.0%** and **95.9%** exact zeros (mean 0.0 and 0.1) against **0.0%** at the equator
(mean 38.4, where the tile reads 38). The tiles reproduce the source, including its holes.
Before this round the `--sources` probe sampled no polar point at all, which left the 6.60%
mass attributed to the source by inference only.

```
row  0  lat 84.4..90.0    48.27% zeros       row 31  lat -90.0..-84.4   53.78% zeros
row  1  lat 78.8..84.4    19.62%             row 30  lat -84.4..-78.8    24.37%
row  2  lat 73.1..78.8    11.09%             row 29  lat -78.8..-73.1    17.94%
row  3  lat 67.5..73.1     5.64%             row 28  lat -73.1..-67.5     9.42%
row  7  lat 45.0..50.6     0.92%             row 24  lat -50.6..-45.0     1.26%
row 15  lat  0.0.. 5.6     0.07%             row 16  lat  -5.6.. 0.0      0.09%
68 tiles are more than 50% black; all of them are in rows 0, 1, 29, 30, 31.
```

Why it does not weaken the gate:

- It cannot fake the mare-vs-highland result. The mass is at |lat| > 73°, and 33 of the 36
  markers sit below 58° latitude; the three exceptions are `Clavius` (−58.6°, reads 142),
  `Avogadro` (63.2°, reads 96) and `Hermite` (86.2°, reads 8) — only `Hermite` falls inside
  the dense part of the defect, and it is a *false dark* among the bright markers.
  Discarding `Hermite` and `Piccolomini` (6 DN, dark for geological reasons) as
  artefact-affected **raises** the highland median from 80.5 to 89.0, so the measured
  47.0 DN contrast is the conservative figure and no threshold had to absorb the defect.
- It does bias the **global mean and percentiles**, which the gate uses as thresholds: mean
  64.34 over the whole distribution vs **68.9** over the non-zero 93.4%; p33 47. The
  requirement "mare median below the mean" is met against the *lowered* mean (33.5 < 64.34),
  so it would be met a fortiori against 68.9. No threshold was moved because of this.
- Consequences to carry forward: in the `paper` layer the globe's polar caps will render
  **black** — 5.77% of the northern hemisphere's pixels and 7.33% of the southern, recounted
  on the delivered L7 pyramid on 2026-10-09 (`README.md`, `work/polar-measure-l7.txt`); an
  earlier revision of this line said "~10% of each hemisphere's disc" and no measurement
  supported it — 10.9% only appears by dividing *both* caps by *one* hemisphere — and
  `verify-16.md` carried the same unsupported figure until it was corrected the same day.
  In an equator-facing view that reads as punched-out fields at both poles, and Task 16 (paper
  look) should decide whether to mute it. Any later statistic derived from `paper` DN — a
  histogram legend, an albedo colour ramp, a "low contrast" hint — must account for a 6.6%
  spike at 0. Task 18's Gate G3 should include a visual check of the poles. And
  `Lacus Mortis` at 0 DN is a similar local defect at mid-latitude (dark mantle in the
  source), which is fine for diagnosis but is why single-pixel reads are not gating.

## How to reproduce

The pyramid this gate reads is **build output, not a commit**: `public/tiles/**` is
gitignored except `manifest.json`, and `data/raw/**` (the 3 GB of sources) is gitignored
too. A fresh clone therefore has to produce them before G2 can run — otherwise
`npm run proof` exits with `SystemExit: no paper tiles at level 5 under public/tiles`.

```bash
npm install && npm run postinstall      # node toolchain + Cesium assets
npm run fetch                           # 3 GB into gitignored data/raw, sha256-verified
npm run bake                            # gitignored public/tiles/**, 10,922 tiles per layer
npm run labels                          # regenerate features.json; exits 0, no drift expected
npm run proof                           # GATE G2 PASS, exit 0; writes albedoHistogram + geometryProof
.venv/Scripts/python.exe -m pytest scripts/tests -q -W error   # 134 passed, zero warnings
npx vitest run                                                   # 7 passed at Task 9; 32 now
.venv/Scripts/python.exe scripts/g2_geometry_probe.py            # the mis-registration tables above
.venv/Scripts/python.exe scripts/g2_geometry_probe.py --sources  # + the source-vs-tile cross-check
```

`npm run fetch` and `npm run bake` are the slow steps (hours, not seconds) and must not be
re-run to check a number that is already recorded here: `--sources` reads the existing
`data/raw` raster, and `npm run proof` reads the existing pyramid. The synthetic fixtures in
`scripts/tests/test_proof.py` are the part that needs no sources at all, and they are what
CI can run.

`scripts/g2_geometry_probe.py` is a **diagnostic, not a test**: it prints and always exits
0, in the same role as `scripts/g1_tiling_probe.mjs`. It exists because the flip/rot
numbers below were measured ad hoc in the first revision of this file, which left the
gate's central claim — that a mis-registered map inverts the sign — unreproducible from a
fresh clone. Its output is the source of every figure in the two tables that follow; the
`--sources` half reproduces the source-vs-tile table.

`public/tiles/manifest.json` now carries, in addition to the bake record:

```json
"albedoHistogram": {"level": 5, "mean": 64.34, "p33": 47, "p67": 76,
                    "samples": 536870912, "tiles": 2048},
"geometryProof": {"passed": true, "level": 5, "mareMedian": 33.5,
                  "highlandMedian": 80.5, "contrast": 47.0,
                  "checks": {…36 marker reads + 4 Apollo 11 entries…}, "failures": []}
```

`npm run proof` is idempotent: the second run produced a byte-identical manifest
(`git diff --stat` still 58 insertions, 0 deletions against the bake commit).

## Consequences for later tasks

1. **The geometry is trusted.** Tasks 10–18 may build on the tile grid, the label
   coordinates and the wrap convention. Nothing needs a G2 re-run unless the bake, the grid
   contract or the label pipeline changes; if any of those change, re-run `npm run proof`
   before trusting anything else.
2. **`bbox_contains` is the only legal containment test.** Any TS equivalent in Tasks 11/12
   must reproduce the `w > e` branch; the mutation test here shows what a naive
   `w <= lon <= e` costs (one false "misplaced label" per seam-crossing feature, and 10
   curated features legitimately cross).
3. **Do not tune the marker lists or the constants.** `MIN_CONTRAST_DN`, `MIN_SAMPLES` and
   `PROBE_LEVEL` are pinned by a test, and list membership is pinned to presence + class.
   A future failure needs a diagnosis, not a threshold edit.
4. **`wrap_lon` before indexing.** Anything that turns a longitude into a tile index should
   fold first, so +180 and −180 are one meridian. `tile_pixel` now does.
5. Single-pixel albedo reads are diagnostic only; the medians are the decision. If a future
   task wants per-feature albedo (e.g. an info-card sparkline), it should average a
   footprint, not read one pixel — the `Lacus Mortis`/`Hermite`/`Piccolomini` outliers show
   what one pixel can do.
6. The polar black is upstream. Worth one line in the README's limitations section when
   Task 18 writes it.

## Re-run on the delivered L7 pyramid — 2026-10-09

Everything above this line is the **Task 9 run of record**: Tier A (L0-L6), 2026-10-07, and
it is left untouched because it is what that agent measured. The pyramid has since gone to
L7 (`d34a505`) and gained a region-limited `ortho` layer, and deriving L0-L6 from an L7 core
moved the parent tiles, so `scripts/g2_geometry_probe.py` was run again over the delivered
tree. `npm run proof` had already rewritten `geometryProof` and `albedoHistogram` in
`public/tiles/manifest.json`; these are the probe's own numbers, which are the falsifiability
half the manifest does not carry:

| mode | mare median | highland median | contrast | sigma |
|---|---|---|---|---|
| **true registration** | 33.5 | **81.5** | **+48.0 DN** | +1.19 |
| latitude mirrored (`lat -> -lat`, the y-flip signature) | 54.0 | 49.5 | **-4.5 DN** | -0.11 |
| longitude rotated (`lon -> lon+180`, the far-side signature) | 76.5 | 60.5 | **-16.0 DN** | -0.40 |

Footprint lookups (median of every L5 pixel inside each gazetteer bbox) agree with the Task 9
run and with each other: true **+33.0**, flip **-7.0**, rot **-15.0 DN**. The four Apollo 11
traverse features now read **West 29, Little West 30, Double 30, Mount Marilyn 56** against
`p67 = 76` -- previously 28/28/28/57, and all four still dark of the 76 DN ceiling. Global L5
`paper`: mean **64.33**, sd 40.35; exact-black **35,183,101 of 536,870,912 = 6.5534%** (was
6.6039% on the Tier A tree), with 68 tiles more than half black.

**Verdict is unchanged and the margin grew**: +48.0 DN against a 25 DN floor, both mis-registrations
still inverting the sign rather than merely weakening it. What moved is the *level of detail in the
parents*, not the geometry, which is exactly what a gate about geometry should be insensitive to --
had the flip/rot columns moved with the true column, that would have been the alarm.

Two things this re-run does **not** establish, stated so nobody reads more into it: it says nothing
about the `ortho` layer's tiles (no gazetteer marker in the twelve boxes is at a level the gate
samples), and it says nothing about how the deep layer *looks*, which remains owed to Task 18.
