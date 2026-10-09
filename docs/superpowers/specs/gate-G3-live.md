# Gate G3 — live browser pass

Date: 2026-10-08. Run by the controller against `npm run dev -p 3200` (Next.js 15.5.27,
Cesium 1.146) with the Qoder browser connector, at
`http://localhost:3200/#0/0/22000000/globe/photo`.

A visible surface was never available: `take_screenshot` returns
`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` (`visible=false`, `visibilityState=hidden`), and
that did not change. What is different this time is that the tab's timers and
`setTimeout` **do** run, so `evaluate_script` + `WebGLRenderingContext.readPixels`
produce real evidence about the rendered scene. Numbers below are values read back from
the live page, not values the unit tests expected.

## 1. The app mounts, and imagery really paints

| probe | observed |
|---|---|
| canvases in DOM | 1, sized 648 × 786 |
| `viewer.imageryLayers.length` | 1 (never two stacked) |
| non-localhost network requests | **0** — no Cesium ion, no CDN, no tile host |
| tile errors counted by `ImageryLayer.errorEvent` | **0** |
| framebuffer, 120 km over 31°E 8°N | 100 % non-black pixels sampled, 181 distinct colours |
| framebuffer, 400 km over (0,0) | 100 % non-black, 100 distinct colours |
| framebuffer, 22 000 km | 1.4 % non-black, 7 distinct colours — the disc is small at that range |
| scale readout, 120 km over Tranquillitatis | **176.29 m/px** against the grid's `mPerPx(6)` = 166.57 (+5.8 %), level reported `L6 of L6` |
| scale readout, 22 000 km | 10 209 m/px, bar 500 km, `L1 of L6` |

Camera-projected 176 m/px at 120 km agrees with the tile level actually requested, which
is the check spec §4.3 asked for: the readout is not 10× off, and it tracks the pyramid.

## 2. URL state, search and provenance, live

After a search-driven selection the live hash read
`#30.83460/8.34870/3502995/globe/photo/Mare%20Tranquillitatis` — longitude, latitude,
height, mode, layer and selection, all published from the running scene.
`__moonHarness.search('tranq')` returned Mare Tranquillitatis first; the selected feature
object carried `gloss: "Sea of Tranquility."`, `diameterKm: 875.74884`, `quad: "LAC-61"`,
`code: "ME"`, `tier: 0`, `approval: "1935/01/01"`,
`url: http://planetarynames.wr.usgs.gov/Feature/3691`, and a bbox containing the four
Apollo 11 traverse features. The visible DOM text included the card
(`Close Mare Tranquillitatis / Sea of Tranquility. / Type Mare, maria (ME) / Diameter
875.7 km`) and the full attribution line with the U+2019 apostrophe.

## 3. Label tiering, live

`entities.values.filter(e => e.show).length` at three ranges, over 600 label entities:

| camera height | shown | reading |
|---|---|---|
| 22 000 km | 84 (an 86 seen later after the mode change) | tier 0 + tier 3 only, decluttered — the brief's "subtle" case |
| 3 500 km | 93 | tiers 0/1/3 |
| 400 km | 4 | correct: the ground footprint at ~176 m/px holds very few named features |
| 120 km over Tranquillitatis | 1 | the mare label under the cursor |

A prior record (`verify-11.md`) logged 116 shown at 3.5 × 10⁶ m; live gave 93. Both agree
at 84 for the deep-space case. The difference is the declutter cell size against a
648 × 786 canvas versus the 900 px the unit tests assume, and it is unresolved.

## 4. Paper mode, and a crash found and fixed on the way

The first live pass crashed: React's dev invariant
`The final argument passed to useEffect changed size between renders. Previous:
[globe, 0]  Incoming: [globe, 0, (out)=>{…}]` replaced the page with "Application error"
and no viewer was built. A function expression had been added to a dependency array, so
its length changed between module versions. Fixed by routing the outcome handler through
a ref and pinning the array at `[mode, modeNonce]`, with
`src/test/effectDeps.test.ts` asserting that no dependency array in `MoonMap.tsx`
contains a function expression — a check verified to detect the broken form, not a
tautology.

After the fix, driving Paper through the real state machine (`__moonHarness.requestMode`,
which goes through the latch rather than calling `setMode` directly) landed it:

- `scene.mode` → `SCENE2D`, `#cesiumContainer[data-mode="paper"]`
- computed canvas filter `sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08)`
- container background `rgb(239, 233, 220)`
- 86 labels still shown, 1 imagery layer, 0 tile errors

This resolves the item the review wave listed as open: the morph **end state** in both
directions is now observed under the shipped code, and the previous failure to reach it
had two distinct causes — `waitForSceneMode` pumping `scene.render()`, which in
Cesium 1.146 never advances morph tweens (`initializeFrame` is only called by
`CesiumWidget.render`), and the harness bypassing the latch so `data-mode` could not
change.

## 5. Still not verified

- **Screenshots.** No visible surface, so no image exists for any claim above. Nothing
  here proves what the map *looks* like to a person: maria/highland contrast under the
  paper filter, label legibility, whether the cream margin reads as paper, or whether the
  polar albedo hole (6.60 % of the L5 paper grid at DN 0, upstream source data) is
  distracting.
- **Whether a morph animates or jump-cuts.** The end state is proven; the `animated` /
  `forced` flag for each individual transition was not read at the moment of settling.
- **The three failure panels.** `NoAssets`, missing-`public/cesium`, and no-WebGL were
  never induced: inducing the first means moving 21 844 git-ignored tiles that took three
  hours to bake. Unit-tested with injected failures only.
- **Mouse drag, wheel zoom, keyboard pan** — never driven as real input events.
- **The ±180° strip and the poles as rendered pixels**; the numerical seam checks live in
  `tierA-check-transcript.txt`, not in an image.
- **Time-to-first-paint** from a cold boot is still unmeasured. The rest of spec §4.5's
  budget — latency, concurrency, memory and frame rate — was measured on 2026-10-09 and is
  recorded in §9 below, including the part that is still true: the ≤16 concurrent-request
  clause is met by Cesium's defaults, because nothing in `src/` configures the request path.
- **A cold offline clone.** `src/app/layout.tsx` loads fonts through `next/font/google`,
  so `npm run dev` / `npm run build` need network at compile time; not exercised here.
- **Tier B** (`--top 7`): never run, per the human's opt-in decision. Projected from
  measured per-band cost at 3.71 GB and 6.7–8.4 h — an extrapolation, not a measurement.

## 6. Verdict

Gate G3: **passing on every measurable claim, incomplete on every visual claim.** The
application runs, paints the baked Moon at the resolution it claims, keeps its geometry
and labels consistent with the two gates, talks to no third-party service, and switches
between Paper and Globe. It has never been looked at with human eyes.

## 7. Visual pass, 2026-10-08 — the "no screenshots" gap is closed

A real Chrome window was available this time, so `take_screenshot` worked. Three images,
all read by eye before these claims were written:

- `work/g3-globe-22000km.png` — home view at 22,000 km
- `work/g3-globe-hemisphere.png` — 3,000 km over 15°E 5°S, 117 labels shown
- `work/g3-paper-flat.png` — flat `SCENE2D`, Albedo layer, 2,600 km, 144 labels shown

**Confirmed working visually:** the Moon is recognisable and correctly oriented (Oceanus
Procellarum on the western limb, Crisium at the eastern edge, Tycho's ray system fanning
south of the centre); craters, mare boundaries and mascon swirls are legible at 4,400 m/px;
the flat mode is a true equirectangular sheet with no visible seam; the toggle, layer
chips, search box, scale bar, compass, coordinate line, `L1 of L6` level readout and the
attribution block all render.

**Five defects that only eyes could catch:**

1. **The colour layer is not visibly colour.** With `Colour relief` active the globe is
   neutral grey. The chroma transfer from the 76 px/deg SVS base is producing almost no
   saturation, so decision D2's photographic-globe half is not landing. `k` is doing
   detail work, not hue work.
2. **The paper tint is imperceptible.** `sepia(0.22) saturate(0.55) contrast(0.94)
   brightness(1.08)` over an albedo map reads as plain grey, not as paper. The cream
   `#efe9dc` sheet is never seen because the 2D map fills the viewport, so the one colour
   cue that does work is hidden behind the imagery.
3. **The default framing is wrong.** At 22,000 km the disc is ~110 px across in a
   564 × 786 canvas — most of the screen is black. `DEFAULT_VIEW.height = 2.2e7` was chosen
   analytically and never looked at.
4. **The landing-site dots are the loudest thing on screen.** Bright yellow with a dark
   halo, they dominate the subtle grey names the brief asked for.
5. **The compass rose is clipped under the top control bar** in flat mode.

None of these is a geometry or data fault — Gates G1/G2 still hold. All five are styling
and framing, and all five are cheap.

## 8. The five defects, measured and fixed — 2026-10-08

A visible surface went away again mid-session, so the pass ran through headless Chrome
instead: `work/shot.sh` captures `http://localhost:3000/<hash>` with
`--headless=new --use-angle=swiftshader` and `work/measure.py` reads the composited PNG
back. A real screenshot is required rather than `readPixels`, because every one of these
fixes is a CSS `filter` on the canvas, and canvas filters happen after WebGL — the
framebuffer probe cannot see them. `measure.py` exits non-zero unless the frame is
plausible (a square-ish, lit blob), because `--virtual-time-budget` can stop on a frame
whose labels are crisp and whose globe has not decoded yet, and that frame reproduces
itself perfectly.

### 8.1 Defect 1 was a display decision, not a bake fault

The claim in §7 — "`k` is doing detail work, not hue work" — was wrong, and the
measurement that would have settled it had not been run. Comparing
`data/raw/lroc_color_poles.tif` (76 px/deg, RGB + alpha) against the baked `photo` tiles
covering the same rectangle, at four levels:

| tile | source sat50 | tile sat50 | source R−B | tile R−B |
|---|---|---|---|---|
| L2 2/1 | 0.060 | 0.060 | 6.38 | 6.08 |
| L3 5/3 | 0.051 | 0.061 | 3.89 | 4.17 |
| L5 16/8 | 0.075 | 0.079 | 9.90 | 10.35 |
| L5 20/10 | 0.044 | 0.059 | 4.43 | 4.43 |
| L5 28/12 | 0.065 | 0.056 | 6.10 | 5.23 |
| L6 53/33 | 0.054 | 0.055 | 4.91 | 4.84 |
| L6 2/32 | 0.045 | 0.038 | 7.23 | 6.39 |

The bake reproduces the source's chroma to within about one count of R−B everywhere, so
the composite is not discarding hue and a re-bake could not add any. There simply is not
much there: the LROC colour mosaic is a 4–8-count R-over-B cast on a mean of 80–160, a
median saturation near 0.05. Fixing the defect therefore belongs at the display, and it
is a stated stretch, not a restoration: `saturate(2.6)` on the globe canvas, in
`src/lib/look.ts` as `GLOBE_SATURATE`.

Measured on the home frame, 800 × 900:

| | before | after |
|---|---|---|
| disc on screen | 114 px (14 % of the short side) | 731 px (91 %) |
| median saturation inside the disc | 0.050 | 0.109 |
| mean R−B inside the disc | +10.6 | +13.3 |
| the same view with the **Albedo** layer | — | sat50 0.000, R−B +0.73 |

That last row is the check that the stretch is honest: `saturate()` scales chroma about
each pixel's own grey, so the grayscale layer it produces is still exactly grayscale on
screen.

### 8.2 Paper, framing, markers, names

- **Paper (defect 2).** `sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08)` over
  an albedo map whose mean is 64/255 produced warm *grey*: measured R−B of +2.66. The
  filter now runs `contrast(0.72) brightness(1.55) sepia(0.42) saturate(1.25)` — the
  contrast/brightness pair is the affine floor-plus-scale that lifts a dark albedo map
  into a light sheet (CSS filters are affine; no gamma is claimed). Same 2,600 km flat
  view: mean L 61.7 → 123.1, R−B +2.66 → +24.2, p05 38.1 → 94.6, p95 99.0 → 169.0. The
  relief spread survives, which is the part a naive brightness push would lose.
- **Framing (defect 3).** `HOME` was `cameraHeightForLevel(5, 900, 60)` = 259,659 m, a
  close-up of one quadrangle; the §7 run asked for 2.2e7 by hand and got a 110 px disc.
  Neither was a framing of the globe. `globeFitHeightMeters()` in
  `src/lib/cesium/moon.ts` now solves the limb relation `asin(R/(R+h))` against
  `HOME_MARGIN` (0.86) times the half-field of the *narrower* screen axis, so the answer
  follows the viewport instead of a constant. 2.64 Mm on an 800 × 900 canvas, 3.51 Mm on
  the 564 × 786 tab §7 used. Five cases in `src/test/framing.test.ts`, including the
  portrait/landscape axis switch and the clamp that keeps a slit viewport honest.
- **Landing sites (defect 4).** `pixelSize` 6 → 4, fill alpha 0.85 → 0.3, outline
  `Color.BLACK` → rgba(0,0,0,0.8) at width 1.5. The alpha is the part that matters in
  globe mode: the canvas `saturate()` amplifies whatever chroma a pixel already carries,
  so a saturated amber disc at 0.85 composites to a clipped orange blob.
- **Names (defect 5a).** Fill 0.62 → 0.94 alpha, outline 1.5 → 2 px at 0.86, font weight
  500 → 600, and the distance pair moved from `(2e4, 1.0, 2.2e6, 0.6)` to
  `(2e4, 1.0, 6e6, 0.8)`. The old far stop sat *below* the new whole-globe home height, so
  the default view showed every name at its dimmest — the fade was tuned against a
  framing nobody was looking at.

### 8.3 There is no compass rose

§7 defect 5 and amendment 2 §3 both record a "compass rose" clipped under the top control
bar. There is no compass in this app: `grep -i compass src/` is empty, Cesium's toolbar
renders empty, and `document.elementFromPoint()` at the spot in question returns
`NEXTJS-PORTAL`. It is the **Next.js dev-mode indicator**, a floating circular badge that
development builds place over the map chrome. It does not exist in `next build`. The
correction is recorded rather than argued: `devIndicators: false` in `next.config.mjs`
takes it out of every dev capture, so what `npm run dev` shows is what ships.

### 8.4 What is still open

Amendment 2 §5 item 5 — the declutter cell assuming a 900 px viewport that is never read
from the canvas — is untouched by this wave, and now more visible rather than less: the
default view shows the whole disc with every tier on screen.

## 9. Spec §4.5's performance budget, measured — 2026-10-09

Produced by `work/perf_budget_probe.mjs` against `npm run dev` on localhost in headless
Chrome with SwiftShader (`--enable-unsafe-swiftshader --use-angle=swiftshader`). The
peak/median/p95 arithmetic lives in `src/lib/perfBudget.ts` — the probe imports it, so
there is one implementation of the math and `src/test/perfBudget.test.ts` (21 tests)
drives it with hand-built intervals. Raw runs: `work/perf-budget-baseline.json` (8),
`work/perf-budget-sweep.json` (20), `work/perf-budget-memory.json` (4 steps).

**Two different quantities get confused, so they are reported separately.** *Wire*
concurrency is the maximum number of overlapping `[startTime, responseEnd]` windows in
`PerformanceResourceTiming` — what actually reached the network. *Issued* concurrency is
the same overlap computed over Cesium's own request records, so it includes requests the
scheduler has opened but the browser is still holding behind a socket limit. The clause
about "no more than 16 simultaneous tile requests" is a statement about the wire, and the
issued number is printed next to it because a gap between the two is the queue backing up.

| §4.5 clause | spec | measured | verdict |
|---|---|---|---|
| median tile response | < 150 ms | **0.5–3.3 ms** across all 28 conditions; worst p95 42.5 ms (`globe-home` at SSE 1) | **met**, 45× margin at the median |
| ≤ 16 simultaneous tile requests | enforced, not hoped for | wire peak **1–8** (max 8, `globe-home` at SSE 1); issued peak reached exactly **16** at SSE 1, 11 at the default SSE 2 | **met in practice, not enforced by this app** — see below |
| tab < 1.2 GB after 50 tile fetches | 50 fetches | 60 tiles fetched: JS heap peak **113 MB**, renderer working set **749–766 MB**, process working set **1,184–1,254 MB** | **met on the heap and the renderer**; the process total is reported and *not* claimed as the clause's answer |
| L0 globe painted < 3 s after first paint | 3 s | never captured. What was captured is settling after a camera move: **627–917 ms** over 16 conditions, `moveToSettledMs` 785 ms inside a deep region | **not answered** |
| frame rate during drag-rotate | reported, not asserted | rAF gaps with `requestRenderMode` temporarily off: globe p50 **68.9–94.8 ms**, p95 75.4–111.6 ms; paper p50 **109.9–137.2 ms**, p95 up to 177.2 ms | reported: **7–14 fps on a software rasteriser**, and paper is the slower mode |

Three things that only say something if you read the numbers, so they are said plainly:

1. **Nothing in `src/` sets `maximumScreenSpaceError`.** The probe read the effective
   value back as `2`, which is Cesium's default, and
   `Cesium.RequestScheduler.maximumRequestsPerServer` read back as `null` — the property
   the spec names as the enforcement point was not observable through the path the probe
   used. So the ≤16 clause is satisfied by the default's arithmetic, not by a decision
   recorded in this repository. The sweep forced SSE to 1/1.5/2/3 at runtime to get the
   curve; that is a measurement, not a configuration.
2. **The budget is not the binding constraint at any of these settings — the declutter
   and the screen are.** Tightening `maximumScreenSpaceError` from 3 to 1 at
   `globe-home` raises wire requests from 2 to 18 and wire peak from 3 to 8, while globe
   frame time moves 68.9 → 93.0 ms p50: the cost is real and it is mostly request count,
   not pixels. In paper mode the same sweep goes 16 → 48 requests and 110 → 137 ms p50,
   which is why paper is the slower of the two modes despite having no sphere to shade.
   Note that Cesium's own `tilesToRender` counter moves the *other* way over the same
   sweep (16 at SSE 3 down to 4 at SSE 1). It is a settled-frame quantity and the probe
   reads it once, after settling, so a tighter tolerance finds fewer tiles still pending
   rather than fewer tiles on screen — the request count is the number to reason from, and
   this is why the table above does not quote `tiles-to-render` at all.
3. **`tiles-to-render` and `tiles-painted` differ by design, and only in one row.** At
   `inside-region-8km` with SSE 2 the base layer had 5 tiles in the queue and 10 were
   painted, because the `ortho` overlay paints on top of the base tiles it is stacked
   over. Every other row agrees. A future reader should not spend time on it.

What this changes about the two claims that used to point here: gate G3 §5's "every figure
in spec §4.5 … never measured" and amendment 2 §3's "no latency or memory measurement" are
both superseded by this section. What survives them, and is now the open item, is the
*normative* half: this app does not configure the request path at all, so if a deployment
serves tiles from a distant CDN instead of localhost, the 0.5–3.3 ms median becomes an
unmeasured number and the default that happens to keep concurrency under 16 is the only
thing standing between the client and a queue. That is a decision to make before a
deployment that needs it, not a defect to fix in this branch.
