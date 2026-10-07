# Verify 18 — Gate G3: the verification sweep

**Task:** 18 of 18. Gate **G3** is the end-to-end record: it does not re-prove G1 or G2, it
collects what every earlier artifact and the controller's live browser pass actually established,
and names what they did not.

**Written 2026-10-07 on branch `feat/lunar-map-explorer`, HEAD `b8651e0`, from primary sources
only:** `gate-G1.md`, `gate-G2.md`, `bake-log.md`, `fetch-log.md`, `tierA-check-transcript.txt`,
`verify-10.md` … `verify-16.md`, the controller's ledger
`.superpowers/sdd/2026-10-06-lunar-map-explorer/progress.md` (read, not edited),
`public/tiles/manifest.json`, and the final code state read directly. No number below is copied
from a summary or guessed; every one carries the file it came from, and the four commands in §1
were re-run for this document rather than quoted.

**Standing rule for this file: nothing here is claimed to have been seen.** No image was opened
and no rendered pixel was judged. §4 reports what the controller's instrumented live pass measured
(a number read out of a running page is not a visual verdict), and §5 is the list of everything
that still has no evidence.

---

## 1. Final counts — re-run for this file

All four run against the tree at HEAD, on this machine, in this session. Real output, not the
expected output.

| command | observed |
|---|---|
| `.venv/Scripts/python.exe -m pytest -q` | **`178 passed in 21.69s`** |
| `npx vitest run` | **`Test Files  15 passed (15)` / `Tests  222 passed (222)`**, `Duration 2.85s` |
| `npx tsc --noEmit` | **exit 0, no diagnostics emitted** (no output at all) |
| `npm run build` | **`✓ Compiled successfully in 5.4s`**, linting and type validity passed, `✓ Generating static pages (5/5)`, `/` = 1.28 kB + 104 kB First Load JS, both routes `(Static)` |

vitest per-file, as printed: `declutter` 9, `assets` 20, `diagnostics` 32, `provenance` 8,
`scale` 13, `modeLatch` 12, `tiers` 7, `keyboard` 13, `attribution` 9, `scaleProbe` 9, `grid` 10,
`urlState` 27, `morph` 31, `paperTint` 6, `search` 16 — 15 files, 222 tests, 0 skipped.

Growth is accounted for, not assumed: `verify-16.md` recorded **177 passed / 14 files** at Task 16,
`verify-15.md` recorded **209 / 15 files** and pytest **168** once Task 15 landed, and the tree now
reads 222 / 178. The **+13 vitest and +10 pytest** since Task 15 belong to the whole-branch review's
fix commits (`d03f256` derive round-trip tests, `69e8b78` `contract.MOON_WKT` + constant pinning,
`b8651e0` the one-layer run record, `13322e9`/`b1623f2` morph pump, queue watchdog and latch tests,
`334b6bb` the two-writer proof). **No test was weakened or deleted to reach 222/178**; those commits
added assertions and, on `verify-16.md`'s precedent, extended fakes rather than relaxing expectations
(the only suite-shape change of record is `modeLatch` 10 → 12, from `b1623f2`'s two double-click tests).

One incidental observation while writing this file: `npm run proof` was run to confirm what the
README claims about it, and it exited 0 with `GATE G2 PASS` and left `public/tiles/manifest.json`
**byte-identical** (md5 `721e29a91a8dac525557fc03d144f456` before and after) with `git status`
empty — the effect of `334b6bb` routing the write through `manifest.write_manifest`.

The build prints one pre-existing warning, recorded by `verify-15.md` §4 and unchanged: Next
infers a monorepo-style tracing root and reports an additional lockfile; silencing it needs
`outputFileTracingRoot` in `next.config.mjs`, which is a code change outside this wave.

## 2. Gate results, with their evidence files

**Gate G1 — PASS. Evidence: [`gate-G1.md`](gate-G1.md).** It proves Cesium boots on self-hosted
assets and that the geodetic `y` origin is the one the bake writes. Criteria, as recorded there:
(1) a sphere painted with imagery — live page, `globe.tilesLoaded === true`, no console errors or
warnings, every request same-origin, no ion 401; (2) black above the red stripe and white below it
— screenshots under the centre line, `work/g1/fix-g1-sphere-l1-v2.png`; (3)
`tileXYToRectangle(0, 0, 1).north === 90°` and row 1 north `=== 0°`; (4) L1 grid `4 × 2` (and L2
`8 × 4`), `tileWidth = 512`, radii `1737400 1737400 1737400`. The tile template the provider was
built with is `/tiles/probe/{z}/{x}/{y}.jpg` — plain `{y}`, **no `{reverseY}`**, which is the whole
consequence: **row 0 is north end to end and the bake is never given `--y-flip`**. Criteria 3 and 4
are proven twice (headless `node scripts/g1_tiling_probe.mjs`, and in-page), and the probe is
tracked so a fresh clone reproduces them *with* it. `gate-G1.md` also records the trap for later
tasks: `provider.requestImage()` returns a Y-flipped bitmap, so it must never be used to check tile
orientation. Note the caveat this file's own §5 repeats: G1's render evidence is a synthetic
fixture; it says nothing about real imagery, and a per-row `y` error in a real bake is not
browser-detectable.

**Gate G2 — PASS. Evidence: [`gate-G2.md`](gate-G2.md)**, numbers echoed by
`public/tiles/manifest.json` (`albedoHistogram`, `geometryProof`) and by
`.superpowers/sdd/.../progress.md` (Task 9 row). Measured on level-5 `paper` — the raw WAC albedo
band, no gain — over 2,048 tiles / **536,870,912 px**: mare median **33.5 DN** vs highland median
**80.5 DN**, contrast **47.0 DN** against the **25 DN** floor (1.9×), histogram mean **64.34**,
p33 **47**, p67 **76**; **20/20** mare and **16/16** highland markers resolved (floor 15). The four
Apollo 11 traverse features — West 23.4908/0.6705, Little West 23.4756/0.6743, Double 23.4727/0.6738,
Mount Marilyn 40.0000/1.1300 — fall inside the Mare Tranquillitatis bbox (lat
`−4.0512…19.3748`, lon `16.924…45.4903`) and read dark: **28, 28, 28, 57** against p67 = 76, worst
headroom 19 DN. **The pass is falsifiable, which is the only reason it means anything:** the same
lookups deliberately mis-registered give mirror `lat → −lat` **−1.5 DN** and rotation
`lon → lon+180` **−16.5 DN** — the sign *inverts* rather than merely weakening — with a bbox-footprint
variant agreeing at +33.0 / −7.0 / −15.0 DN. Honest scope, from the file: floor ~333 m (one L5
pixel), so whole-tile errors are caught and sub-pixel offsets are not; the `photo` layer's chroma
transfer is untested for geometry; and G2 proves the two datasets *agree*, not that either is
independently right.

Separately, the delivered pyramid passed **54/54** region-scale checks (five maria dark, Tycho and
Copernicus bright, orientation from 23 mare vs 334 crater gazetteer points, antimeridian seam) with
every value reproduced into a committed transcript:
[`tierA-check-transcript.txt`](tierA-check-transcript.txt) — 6 runs × 9 verdicts, all exit 0, photo
direct-vs-flipped correlations 0.9801/0.3047 (L2), 0.9824/0.2996 (L3), 0.9712/0.2916 (L4).

**Gate G3 — this file.** G1 and G2 are gates with pass criteria. G3 has no numeric threshold: it is
the record of what the shipped build was actually shown to do and what it was not.

## 3. Measured pipeline facts

Sources, from [`fetch-log.md`](fetch-log.md) §1: `LRO_WAC_Mosaic_Global_303ppd_v3.jp2`
**2,500,331,610 B** (plus a 5,248 B `.aux.xml` sidecar), `lroc_color_poles.tif` **518,090,428 B**,
`MOON_nomenclature_center_pts.zip` **23,845,070 B** — total on disk **3,042,272,356 B (~3.04 GB)**,
each SHA-256 recorded in `data/raw/sha256.json`. Re-hashing all of it costs 2.48 s, so verification
is the default (`bake-log.md` §0). The 5,959,263,751 B 100 m TIF fallback was **not** downloaded
because the `JP2OpenJPEG` driver registered (`driver-probe.txt`). Stage 0 printed `STAGE 0 OK` with
the declared-vs-canonical pixel-size drift at `-0.015902 px` inside a 0.1 px tolerance.

Tier A (`--top 6`, both layers), measured in [`bake-log.md`](bake-log.md) §4.1–§4.3:

| quantity | value | source |
|---|---|---|
| tiles | **21,844** JPEGs = 10,922 per layer (2/8/32/128/512/2,048/8,192 per level) | §4.2 |
| bytes | **927,406,556 B = 0.927 GB** (0.864 GiB); paper 472,094,745, photo 455,311,811 | §4.3 |
| bits/px | paper **1.3191**, photo **1.2722**, both **1.2957**; per level paper runs 2.506 (L0) → 1.215 (L6), photo 1.470 → 1.207 | §4.3 |
| wall clock | **2 h 58 m 03 s** (`real 178m3.232s`; `timings.bakeSeconds = 10680.5 s`; `generatedAt` span 2 h 58 m 00 s) | §4.1 |
| band rate | 150–195 s/band paper, 150–200 s/band photo; the L2 smoke bake cost 285 s/band (84 tiles, 38 min) | §4.1 |

`find public/tiles -name '*.jpg' | wc -l` prints **21,854**, not 21,844: the extra 10 are the
git-ignored Gate G1 probe tiles sharing the parent directory (§4.2's deviation note). Spec §3's
"~1.0–1.8 GB" is superseded by the measurement; `bake.py`'s estimator now carries the measured
bits/px and predicts 927,405,788 B against 927,406,556 B measured.

**Tier B (`--top 7`) was NOT run.** Everything about it is an **extrapolation, not a measurement**:
`project_seconds(7, both, 1024)` puts it at **6.7–8.4 h** (128 bands over the measured 150–200 s/band;
`bake-log.md` §5's looser band is "on the order of 6–12 h") across 87,380 files, and the estimator
puts its bytes at **3.71 GB = 4.00× the measured Tier A total**, for which the disk guard asks
**5.56 GB** free (`bake-log.md` §5, §5.1; `progress.md` Task 17 row). It stays opt-in and the
controller's ruling keeps it declined, because it buys L7 at 83.3 m/px — a 1.2× *upsample* of a
100 m/px source, per the README's grid section — where L6 at 166.57 m/px is the last true downsample.
No Tier B tile exists, so no Tier B number in this file is a measurement.

## 4. What the controller's live browser pass measured

These are the only live-page observations behind G3. They were taken by the controller in a real tab
against `npm run dev` on **port 3200** — the session that wrote this file started no server, drove no
browser, and adds nothing to this list. **They were not recorded in any earlier `verify-*.md`:**
`verify-10/11/12/13/14/15/16.md` each state that no browser surface was driven by that task's run
(0×0 viewport, `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, `visibilityState=hidden`), so this section is
the sweep's sole written record and is attributed to the controller's pass, not to a file.

- **Exactly one imagery layer** at all times (`viewer.imageryLayers.length === 1` across swaps), which
  is the invariant `setLayer` is written to hold (`src/lib/cesium/morph.ts`).
- **The camera was applied from the URL hash** on load — the inbound half of Task 14's round trip,
  which `verify-14.md` listed as unobserved.
- **84 labels shown at 2.2e7 m and 93 at 3.5e6 m.** The 84 agrees with the unconfirmed prior-session
  table in `verify-11.md` (84 shown entities at 2.2e7 m, read as the 81 near-side tier-3 dots + 3
  tier-0 names); the 93 does not agree with that table's 116 at 3.5e6 m — see §7.
- **Zero tile errors** and **zero non-localhost requests** — the `__moonHarness.tileErrors()` 0 that
  `verify-15.md` §3.4 owed, and G1's same-origin claim reproduced on real imagery.
- **Search → fly-to → feature card → hash update all worked** as a chain, i.e. the Task 12 flow whose
  individual halves (`camera.flyTo` animating, the card appearing, the feature segment being written)
  `verify-12.md` and `verify-14.md` each listed as never executed.
- **The framebuffer read 100% non-black with 181 distinct colours**, at ~120 km over Mare
  Tranquillitatis, at **~176 m/px**, reported as matching the grid's **166.6 m/px** (the exact
  `m_per_px(6)` = 166.57113880453207), and the scale panel reported **"L6 of L6"** — the level check
  `verify-13.md`'s owed item 2 asked for. This is a pixel *count*, not an appearance judgement: it
  says the GL surface held composited imagery rather than a cleared buffer, not that the picture is
  correct or legible. See §7 for the ~6% gap between 176 and 166.6 and why the two numbers are not
  directly comparable.
- **Paper mode failed live, and that failure is what produced the shipped code fix.** The pass could not
  land a Paper mode change. Two separate causes were found, and they are not the same kind of defect:
  - **The engine half was real.** One probe before the fix watched `scene.mode` hold **`MORPHING` for
    minutes**. The hidden-tab pump called `scene.render(wallClock)`, which advances nothing: in Cesium
    1.146 the morph tweens are updated only by `Scene.initializeFrame()`, whose sole caller in the render
    path is `CesiumWidget.render()`. **`13322e9`** pumps through `viewer.cesiumWidget.render()` instead
    and adds a wall-clock watchdog on the morph *queue* (`MORPH_QUEUE_DEADLINE_MS`), so a frozen
    head-of-queue fails loudly and releases the requests behind it rather than deadlocking every later
    toggle.
  - **The `data-mode` half was a harness artifact, not an app defect.** The dev harness's `setMode` went
    straight to the morph primitive, bypassing the mode latch, so `#cesiumContainer`'s `data-mode` never
    followed — and `b1623f2` says in terms that "a live probe that read `data-mode='globe'` while a morph
    had been requested was reading this, not an app defect". `requestMode` was added to drive the same
    `attemptMode` machine a click runs, and that commit also settled the double-click rule (the **first**
    click wins; the component comment claiming otherwise was wrong).
  **Status: UNRESOLVED until re-tested.** The fixes are committed and unit-covered, but no observation of
  the shipped pump exists. `verify-10.md`'s camera-preservation table and its "every toggle completed via
  the fallback in 4.0–8.7 s" were measured against the *pre-fix* build under the *old* 4 s deadline, so
  they do not transfer. The end state, the animation, and the `data-mode` binding in Paper mode are all
  open — see §5.

## 5. NOT verified

Nothing in this section has evidence. It is the list to read before claiming G3 closed anything.

- **No visual verification of any kind, by anyone, of the shipped app.** No screenshot of the live
  app exists; nothing in §4 was *looked at*.
- **The four per-mode screenshots `verify-16.md` owes do not exist** — globe+photo, globe+paper,
  paper+paper, paper+photo at L2 and L6. The same is true of every other owed image set:
  `verify-14.md` item 9 (default / paper / feature / malformed-hash address bars), `verify-12.md`
  item 9 (empty search, result list, mare card, West card), `verify-13.md` item 8 (deep zoom,
  full-disc, Paper at lat 60, credit panel with the disclosure open), and `verify-11.md` item 6
  (labels at 2.2e7 / 3.5e6 / 4e5 m). Consequently **no claim is made about how either mode looks**,
  and `verify-16.md`'s own question — whether `sepia(0.22) saturate(0.55) contrast(0.94)
  brightness(1.08)` reads as paper or as washed out, and whether the 47 DN mare/highland difference
  survives it as a *display* difference — is unanswered.
- **The morph animation and Paper mode's end state under the new pump**: unobserved. Includes whether
  `CesiumWidget.render()` actually advances the tweens in a visible tab, whether `forced` ever comes
  back `true` there, and whether `#cesiumContainer`'s `data-mode` follows `sceneMode()` after one
  click on Paper. `verify-10.md`'s hidden-tab numbers are pre-fix evidence, not current evidence.
  (Known limit in the code, from `morph.ts`: `CesiumWidget.render()` is gated on `_canRender`, which
  Cesium sets from canvas size, so a 0×0 tab still cannot animate a morph.)
- **The three failure panels were never induced** — unbaked tiles/manifest → `NoAssets`, missing
  `public/cesium` → `ErrorPanel(cesiumBase)`, no WebGL2 → `ErrorPanel(webgl)`. `verify-15.md` §3 says
  so itself: boot order and panel text are proven with injected fakes and `react-dom/server` renders;
  the real paths, the "Try again" round trip after restoring the tiles, and where Cesium surfaces a
  missing `Workers/` (constructor throw vs async 404s) are all unobserved, and the WebGL2 path cannot
  be provoked in this harness at all.
- **Label subtlety and overlap as rendered pixels.** "Labels do not overlap" is proven for the
  `declutter` algorithm (`verify-11.md`); no rendered pair has been checked. Faintness, legibility
  against the albedo, outline weight, the 0.72–0.95 distance scaling, the horizon gate at the limb,
  and whether names thrash across a Paper↔Globe round trip are unread. The tier thresholds
  (4.150e6 m, 1 038 640 m) are arithmetic for a 900 px canvas and have not been rechecked against a
  real viewport height.
- **The `±180` strip and the poles as rendered.** G2's mutation test exercises `bbox_contains`'s wrap
  branch and `tierA_check`'s seam statistic is numeric; no page has been looked at across the seam.
  The polar DN-0 hole is measured in the *data* (README "Known limits": 35,454,232 of 536,870,912 L5
  `paper` px = 6.6039%; 5.8% of the northern hemisphere's grid, 7.4% of the southern) but
  `verify-16.md`'s "the poles will look punched out" and its claim that globe mode loses detail
  rather than going black remain a prediction from tile statistics, not an observation.
- **Frame rate** during drag-rotate, and the whole of `verify-14.md`'s live half: the address bar
  updating at ≤ 4 Hz under a real drag, `hashchange` → apply in a browser, back/forward not being
  re-written, `replaceState` at 4 Hz not thrashing the URL UI, and whether a `postRender`-driven sync
  fires often enough to be felt. Real mouse-drag and wheel behaviour is likewise unobserved
  (synthetic `PointerEvent`s do not reach Cesium's controller in this harness), as is whether typing
  in search leaves the camera byte-identical, and whether keyboard `1`/`2`/`/`/`Escape`/arrows do
  their jobs and suppress scrolling.
- **The whole of spec §4.5's performance budget**: not implemented and not measured — no
  `maximumScreenSpaceError` or imagery request scheduling anywhere in `src/` (`grep -rn
  "maximumScreenSpaceError" src/` → no hits; `makeProvider` passes no such option), and no
  tile-response timing, in-flight request count, L0-paint timing or tab-memory sample exists in any
  gate or sweep file. None of §4.5's four numbers has a value, and none of them has a knob.
- **Everything the ledger records as parked or deferred** (`.superpowers/sdd/2026-10-06-lunar-map-explorer/progress.md`),
  none of it re-examined for a *fix* by this wave: Task 1 (postinstall referencing a file created in
  Task 2, so a fresh `npm ci` at `5209e34` alone fails postinstall; two plan-doc edits swept into the
  scaffold commit; `Unsupported engine` / Vite ESM-config warnings), Task 3 (`grid.json` duplicate
  corner vectors and no interior tile per level, CWD-relative vector paths in both suites,
  `world_px_of` returning the far edge so callers must clamp, the non-discriminating all-black-pixel
  test, `gauss1d`/`blur` return dtypes unasserted), Task 5 (the near-vacuous `assign_tier(...) != 3`
  floor assertion; `test_main_exits_zero` rewriting the committed `features.json`), Task 6 (`main()`
  exiting 0 with `crcOk: false` — recorded, never gating; a second `--force` resuming a stale
  `.force.part`; `fetchedAt` absent on untouched roles; `EXPECTED_DETAIL.tol 2e-3`; `test_fetch.py:244`
  enshrining the since-reverted reuse-without-verify behaviour), Task 7 (no atomic write or integrity
  check when resuming — existence is the resume key; unpinned band choice `(1,2,3)`; photometrics
  hardcoded; PIL chroma subsampling inherited; parents at 54–64 % of a direct bake's bytes), and
  Task 10's three remaining minors (no `requestRender` after the home `setView`, the plan-mandated
  vacuous 89.9999 clamp test, a silent `catch`).
  Checked and **found closed**, so they are not open items: probeAssets' per-layer `top` and its dead
  bottom-row expression (`b3a9de0`; `src/lib/assets.ts` now probes `bottomRowAt(...)` for both layers
  and says so in comments), `MIN_H`/`MAX_H` duplicated across `moon.ts`/`morph.ts` (`morph.ts` re-exports
  them), the harness shipping in production (dev-gated), `bake-log.md` §4.7's browser-skip wording, the
  missing `NotGeoreferencedWarning` record, and the manifest listing an un-baked L7.
  **Also not a code item but part of the record:** `progress.md` line 119 discloses that Tasks 11, 12,
  13, 14, 16 and 17 were **not reviewed individually** — they are covered by the whole-branch final
  review instead, and the per-task gate was *skipped, not failed*. And the 20 pinned upstream gazetteer
  bbox defects (19 centre-outside-bbox + `Brill`'s `±180` convention, incl. `Statio Tianhe`'s genuine
  90.9° sign error) ship as `bbox: null`; that is an upstream data-quality fact, not something this
  sweep can verify.
- **Tier B**: unrunnable claims. No L7 tile exists, so its bytes, duration, resolution and any
  rendering behaviour at 83.3 m/px are projections only (§3).
- Two documentation defects in the G1 evidence record were **fixed by this wave** rather than left
  parked: `gate-G1.md`'s centre-line paragraph quoted a disk extent of `y≈87..809` that its own
  transcript does not measure (now the scan-supported `788` limb / `~108..788` re-measurement), and
  its reproduce section said a fresh clone could reproduce criteria 3 and 4 "without" the tracked
  probe (now "with it"). Both were recorded as parked in `progress.md`'s Task 2 row; neither changed
  a gate conclusion.

## 6. What G3 concludes

The data path is proven twice over and the app is proven *functionally* by instrumentation: G1 fixes
the `y` origin, G2 fixes the registration with a falsifiable sign test, `tierA_check` reproduces 54
region-scale verdicts, and the live pass shows one imagery layer, a hash-driven camera, a working
search→fly-to→card→hash chain, zero tile errors, zero off-site requests and a non-black framebuffer
carrying 181 distinct colours at the grid's own resolution. **That is the extent of it.** The morph
and Paper mode are open under the shipped pump, no failure panel has been induced, no pixel of the
shipped UI has been *judged*, and the performance budget is untouched. **G3 should be signed as
CONDITIONAL: the pipeline passes, the interaction layer is unverified.** Closing it needs a visible
tab and the §5 bullets, in that order.

## 7. Where the sources disagree with each other

Recorded rather than reconciled, because reconciling them needs a browser this wave may not drive.

1. **`verify-11.md`'s label counts vs the controller's live pass.** At 3.5e6 m the prior-session table
   says 116 shown entities (35 labels + 81 dots); the live pass says 93. At 2.2e7 m both say 84.
   `verify-11.md` already labels its own table "unconfirmed inputs to that sweep", so the live number
   supersedes it — but nobody has established *why* they differ (canvas height, tier thresholds
   computed for 900 px, or a changed declutter/horizon gate), and neither count has an image behind it.
2. **~176 m/px (live readout) vs 166.6 m/px (the grid contract) vs 166.571 (verify-13's headless
   measurement).** `verify-13.md` measured 166.571 m/px at 129,829 m on a **900×900** canvas through
   real `SceneTransforms`; the live reading is ~176 m/px at ~120 km on a canvas whose size was not
   recorded. Since `m/px ∝ height / longer-canvas-side`, the two are not comparable without that
   dimension — a ~6 % difference is exactly what a non-900 viewport explains, but that is arithmetic
   plausibility, not evidence. The controller's pass reported them as "matching"; this file records
   both numbers and the missing denominator.
3. **"~10% of each hemisphere's disc" for the polar hole vs the tiles.** `gate-G2.md` line 442 and
   `verify-16.md` both state it; re-counting the delivered L5 `paper` tiles the way `proof.py` reads
   them gives 15,622,097 of 268,435,456 = **5.8%** in the north and 19,832,135 = **7.4%** in the
   south (4.9% for the dense cap, rows 0-2). No quantity that means "per hemisphere's disc" comes out
   near 10%. The README has been corrected; **`gate-G2.md` and `verify-16.md` still carry the
   unsupported figure** and are outside this wave's edit scope.
4. **`README.md`'s "Open: Gate G3 (Task 18 sweep) has not been run"** vs this file. The README line is
   now stale. It was left alone deliberately: this wave's README brief was four named corrections,
   and G3 should not be signed off in the README by the same pass that wrote its evidence file.
5. **Which click wins a fast Paper/Globe double-click.** `MoonMap`'s comment said "the second one
   wins"; `requestMode` dedupes on `applied`, so the **first** wins and the second is dropped.
   `b1623f2` kept the coded behaviour and pinned it with two tests, so `verify-10.md`'s latch narrative
   and the current source agree only after that commit — earlier text describing the opposite is
   superseded, not merely worded differently.
6. **`gate-G2.md`'s reproduction wording vs `progress.md`'s Task 9 review note.** The review found the
   original text overstated what a fresh clone can reproduce (it omitted `npm run bake`, and the tiles
   are gitignored). `gate-G2.md`'s "How to reproduce" section now lists fetch/bake/labels/proof, so the
   finding is addressed in the file; the ledger row still records it as a past overstatement, and the
   two readings agree only if the ledger row is understood as history rather than current status.
