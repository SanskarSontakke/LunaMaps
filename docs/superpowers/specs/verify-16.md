# Verify 16 — the paper look

**Task:** 16 of 18 (plan §Task 16). Per-mode CSS treatment only: no data, no re-bake.

Status: **implemented and unit-verified. No browser surface was driven by this run**
— no visible tab is available (the in-app tab reports a 0×0 viewport) — so **the
screenshots the plan's Step 2 asks for do not exist yet and no visual claim is made
here.** What is proven is listed under *What the tests prove*; everything visual is
under *Owed to the Task 18 sweep*.

## Commands and real output

| command | result |
|---|---|
| `npx vitest run` | **177 passed / 14 files** (166 before this task; +6 `paperTint`, +5 in `morph`) |
| `npx tsc --noEmit` | **exit 0, no diagnostics** |
| `npm run build` | **`✓ Compiled successfully in 3.9s`**, lint/type validity passed, 5 static pages |

TDD order: `src/test/paperTint.test.ts` and the five new `morph.test.ts` cases were
written first and run alone — **9 failed / 20 passed**. The failure shapes were the
missing implementation, not a tuned expectation: the three CSS rules resolved to `null`
(`rule()` returns null when the selector is absent, which it was), `PAPER_BASE_COLOR`
resolved to `undefined` (`expected '' to include undefined`), and `data-mode={sceneMode}`
was not in the container source. Then the implementation, then green.
No existing assertion was changed: the five pre-existing `settleMode` guard cases, the
`ModeChange` reporting cases and both deadline-path cases all still pass verbatim. The
fakes were extended (a `globe: { baseColor: 'untouched' }` field) because `settleMode`
now writes that property — adding a field a test asserts on is not weakening one.

## What this treatment IS

Three parts, all per **mode**, none touching a pixel of `public/tiles/**`:

1. **`.map-host[data-mode='paper'] { background: #efe9dc; }`** — the tone behind the
   canvas, i.e. what shows through any part of the widget that is not the globe.
2. **Canvas filter, paper:** `sepia(0.22) saturate(0.55) contrast(0.94)
   brightness(1.08)`; **globe:** `saturate(1.04) contrast(1.02)`. Plan-verbatim values.
3. **`scene.globe.baseColor` follows the mode** — `#efe9dc` in paper, `#0b0d12` in
   globe. This is the part that actually sells the sheet: in paper mode the world is
   a rectangle, and everything outside it is *globe surface with no tile loaded*. In
   the old build that margin was space-black, so the map read as a card floating in a
   void. It is set in **two** places on purpose: `createMoonViewer` (a session restored
   straight into paper by Task 14's `#/paper/` hash never morphs, so nothing else would
   paint it) and `settleMode` (every mode change that lands).

The container's `data-mode` is bound to **`sceneMode`** (the mode the latch confirmed),
not `mode` (the last one clicked) — the same rule Task 10 round 2 established for the
toggle, so a morph that failed cannot paint a warm sheet under a scene that is still a
globe.

## What this treatment is NOT — read this before calling it a colour scheme

**A `sepia`/`saturate` filter on a canvas is a look, not a cartographic colour ramp.**
It is one affine transform in display space applied to every pixel of the composited
frame — map, labels, leader lines, all of it, because Cesium draws the entities into the
same canvas. It carries **no information**: it does not encode elevation, it does not
encode slope, and it does not encode age or lithology.

Concretely, this app has:

- **no hypsometric tints** — there is no elevation look-up table, no ramp keyed to
  metres, no elevation-derived class breaks;
- **no contours or relief shading** — no hillshade, no hypsometric layer, no
  isostatic-linework;
- **no third layer** — decision **D2** in the design spec chose exactly two layers
  (`paper` = fine grayscale detail mosaic, `globe` = chroma-composited colour), and the
  **LOLA DEM was explicitly out of scope** (design spec "Out of scope":
  "DEM/hypsometric/contour layer (D2 chose two layers); terrain relief and vertical
  exaggeration"; plan Global Constraints line 16: "No DEM/contour layer. (D2)").

So the warm cast on the paper view must never be described, captioned or sold as a
thematic colour scheme. The colours in `photo` mode come from the composite recipe proved
in Task 4 (`lroc_color_poles` chroma + WAC detail, k = 0.4) — that is data. The colours
in `paper` mode come from a stylesheet — that is decor. Nothing in this task should make
a reader think elevation information is on screen, because there is none.

**Why the tint belongs in the renderer at all:** the `paper` layer is
illumination-normalized albedo, which is *inherently* flat grayscale — that flatness is
what makes it legible as a map, and it is the correct product. Baking a warm cast into
21,844 JPEGs would (a) destroy a photometric product whose DN values Gate G2 measured
(mare 33.5 vs highland 80.5, contrast 47.0 DN), (b) cost a multi-hour re-bake to change a
hue, and (c) make the albedo figures in the gate evidence unreproducible from the tiles.
Keeping it in CSS means the underlying data stays exactly what the gate proved.

## Known upstream defect being tinted over (not caused, not fixed)

**6.60% of level-5 `paper` pixels read DN 0** — 35,454,232 of 536,870,912 — and they are
concentrated **above |lat| 73°** (L5 rows 0–2 and 29–31; 48.27% zeros in row 0, 53.78% in
row 31; 68 tiles are >50% black, all in those five rows).
Source: `docs/superpowers/specs/gate-G2.md` §"Concern found (upstream data, not geometry)".

Gate G2 established this is **source data, not a bake defect**, by direct measurement
rather than inference: `scripts/g2_geometry_probe.py --sources` samples the LRO WAC v3
source raster at 0°E / ±89.5° and at the equator, and the 13×13 windows there are
**100.0%** and **95.9%** exact zeros (mean 0.0 / 0.1) against **0.0%** at the equator
(mean 38.4, where the tile reads 38). The tiles reproduce the source, holes included. The
cross-check from the other side: `photo` is `chroma_detail(base = lroc_color_poles,
detail = WAC, k = 0.4)` — the WAC supplies only injected high frequencies there — and
`photo/5/0/0.jpg` has mean 167.3 with 0.0004% exact zeros where `paper/5/0/0.jpg` has
mean 35.2 with 32.7%. The hole is in the albedo raster.

**What the paper treatment does about it: nothing, deliberately.** Gate G2 asked that
"Task 16 should decide whether to mute it." The decision is *do not mute it*, because
every renderer-side trick that would lift black toward cream (a blend overlay, a
`linear-gradient` veil, a filter that raises the floor) **fabricates albedo where the
source has none** — it would put invented pixels on a map whose DN values are the
evidence behind a geometry gate. The consequence is stated plainly instead:

> **In paper mode the polar caps will look punched out** — irregular black fields inside
> a cream sheet, roughly 10% of each hemisphere's disc in an equator-facing view at L5,
> and the contrast against the new paper tone is *worse*, not better, than it was against
> the old black background. That is the WAC albedo gap, not a rendering failure and not a
> tile-load stall. In globe/`photo` mode the same region shows a loss of detail rather
> than black, because the chroma base carries it.

Muting it honestly would need either a data-level decision (fill/hatch the no-coverage
region, which needs a source mask nobody has validated) or the out-of-scope DEM path.
Both are Task 18/README territory: the honest fix is a **caption**, not a colour.

## What the tests prove

`src/test/paperTint.test.ts` (6 tests) — no DOM exists in this environment, so the
stylesheet is read as **text** and required to carry the exact rules, which is the
strongest available claim short of a screenshot:

- `.map-host[data-mode='paper']` → `background: #efe9dc;`;
- `.map-host[data-mode='paper'] canvas` →
  `filter: sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08);` (the exact
  four-function stack and order — an dropped or reordered function is a different look);
- `.map-host[data-mode='globe'] canvas` → `filter: saturate(1.04) contrast(1.02);`
  (i.e. globe mode is **not** given the paper filter);
- the CSS tone and `PAPER_BASE_COLOR` are **one value**, and the paper rule does not
  contain the globe tone. CSS cannot import TypeScript without a build step this project
  does not have, so this is the drift guard: two literals that disagree produce a sheet
  with a differently-coloured hole in it;
- `MoonMap.tsx` contains `data-mode={sceneMode}` and **not** `data-mode={mode}` — a
  static-source assertion, deliberate, pinning the intent-vs-confirmed distinction.

`src/test/morph.test.ts` (5 new cases) — the engine-side tone:

- `settleMode` paints `baseColorFor('paper')` when the scene reached SCENE2D and
  `baseColorFor('globe')` when it reached SCENE3D;
- **the paint is under the same guard as the tilt and the camera**: a viewer destroyed
  mid-morph and a morph that never landed both leave `baseColor` untouched (`'untouched'`
  sentinel), so a failed switch cannot repaint the scene it is still showing;
- through the real entry point, `setMode(viewer, 'paper')` with a morph that lands
  resolves `applied: true` **and** leaves the globe painted paper (the whole path, not
  just the tail);
- the two tones are not equal (`baseColorFor('paper') !== baseColorFor('globe')`).

Suite-wide: 177 passed, including all 10 mode-latch tests, all 9 Task 11 declutter
tests, all 7 tiers tests and all 27 Task 14 url-state tests, unchanged.

## Not verified (honest list)

- **Anything about how it looks.** No screenshot was taken, no pixel was sampled, no
  palette was compared. The filter values are the plan's, and the plan's values were never
  reviewed against a rendered frame in this environment.
- Whether `sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08)` reads as "paper" or
  as "washed out", and whether mare/highland discrimination survives it (a 47 DN contrast
  difference becomes a *display* difference after a `contrast(0.94)`; nothing here proves
  it stays legible).
- **That `data-mode` ever changes value on screen** — the binding is proven to exist in
  source, and `sceneMode` is proven to be the confirmed mode by Task 10's tests, but the
  re-render was never observed.
- That `scene.globe.baseColor` is visible at all in paper mode (it depends on how Cesium
  clips the 2D rectangle against the viewport, and on whether out-of-rectangle space is
  globe or `scene.backgroundColor` — the latter is still `#05060a`, so the *page* margin
  outside the widget may still be dark; unresolved, see sweep item 4).
- That the filter applies to the label canvas as well as the imagery (it should — same
  canvas), and therefore that label text shifts hue with the map rather than being
  colour-managed separately.
- **UI legibility over the sheet**: `.ctl` chips, the scale readout and the credit panel
  are dark translucent fills with `#e8e8e8` text; over a cream background their backdrop
  is unchanged, but the surround is now light, so the perceived contrast of the panels
  changes. Not measured.
- That the 68 >50%-black L5 tiles are the ones the polar view actually selects at a given
  zoom (the defect's *extent on screen* is a rendering question, not a data question).
- Print/hi-DPI behaviour of the filter, and whether a GPU-composited canvas applies a CSS
  filter with tiling seams at 4K.

## Owed to the Task 18 sweep

Precondition: `npm run dev`, a **visible** tab, real viewport (record `w × h`).

1. **The four screenshots the plan's Step 2 asks for.** L2 (broad) and L6 (deepest baked
   level) in both modes. Heights for this harness' span; confirm against the readout:
   ```js
   __moonHarness.setCamera(23.4731, 0.6746, 1_038_635);  // L3-ish, then adjust
   __moonHarness.setCamera(23.4731, 0.6746, 129_829);    // L6 height for a 900 px span
   __moonHarness.setLayer('paper'); __moonHarness.setMode('paper');
   ```
   Capture: globe+photo, globe+paper layer, paper+paper layer, paper+photo. Save into
   `docs/superpowers/specs/` and reference them from this file by name. **Until then this
   note has no image and makes no claim about appearance.**
2. **The tint really follows the mode.** Toggle and confirm both the attribute and the
   computed style change, and that nothing changes while the morph is in flight:
   ```js
   // No global `Cesium` in the bundled app, so read the colour's own components.
   const tone = () => {
     const c = __moonViewer.scene.globe.baseColor;
     return [c.red, c.green, c.blue].map((v) => v.toFixed(3)).join('/');
   };
   const g = () => ({
     attr: document.querySelector('.map-host').dataset.mode,
     filter: getComputedStyle(document.querySelector('.map-host canvas')).filter,
     bg: getComputedStyle(document.querySelector('.map-host')).backgroundColor,
     base: tone(),
     scene: __moonHarness.sceneMode(),
   });
   g(); __moonHarness.setMode('paper'); setTimeout(g, 4000);
   ```
   Expect: paper → filter string containing `sepia(0.22)`, `bg` `rgb(239, 233, 220)`,
   `base` `0.937/0.929/0.863` (`#efe9dc` as 8-bit-linear floats); globe → `base`
   `0.043/0.051/0.071` (`#0b0d12`) and a filter without `sepia`, with `bg` from the page
   (`rgb(5, 6, 10)` — no `[data-mode='globe']` background rule exists by design).
   Mid-morph (`sceneMode()` still `MORPHING`), `attr` must **not** yet be `paper`.
3. **Polar defect, on screen.** Look at the poles in paper mode and record what they
   actually do:
   ```js
   __moonHarness.setMode('paper'); __moonHarness.setLayer('paper');
   __moonHarness.setCamera(0, 88, 300_000);      // north polar region at L5/L6
   __moonHarness.setCamera(0, 89.5, 300_000);    // inside the DN-0 mass
   ```
   Then in photo mode at the same place, and record the pair. Expect black fields in
   paper, detail-loss (not black) in photo — that contrast is the visible signature of
   the WAC hole Gate G2 measured. Take both screenshots.
4. **What the base colour is actually covering.** In paper mode, is the margin around the
   rectangle `scene.globe.baseColor` (paper) or `scene.backgroundColor` (`#05060a`)?
   ```js
   ({ base: __moonViewer.scene.globe.baseColor.toString(),
      sceneBg: __moonViewer.scene.backgroundColor.toString() });
   ```
   Screenshot the extreme out-zoom in paper mode (`setCamera(0, 0, 3.5e7)`), and sample the
   pixel colour at the widget's left edge vs the page edge. If the outer band is still
   dark, decide (as a styling change, not a data change) whether to also set
   `scene.backgroundColor` per mode — and record here that the 0×0 environment could not
   tell.
5. **Legibility review.** With a human looking: does the paper view read as a map or as a
   misprinted one? Are mare/highland boundaries still distinguishable after
   `contrast(0.94) brightness(1.08)`, and are the labels still readable now that they are
   tinted by the same filter as the imagery? If the filter must change, it changes **here**
   (CSS) — never in the bake — and the hex in the paper rule and `PAPER_BASE_COLOR` must be
   changed together or `paperTint.test.ts` fails.
6. **Failed-morph honesty.** In a hidden/0×0 tab, drive a morph that has to be jump-cut or
   rejected and confirm `data-mode` tracks the *confirmed* mode only, matching Task 10's
   `forced`/`failed` reporting.
7. **Cross-check with Task 14.** Reload `#23.47312/0.67461/129829/paper/paper` in a fresh
   tab: the sheet tone, the filter and the globe base colour must all be paper on first
   paint, with **no morph** (this is the case `createMoonViewer`'s initial `baseColorFor`
   exists for, and it is unverified until someone loads the URL).
