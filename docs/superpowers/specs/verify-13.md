# Verify 13 — scale readout, keyboard navigation, attribution

**Task:** 13 of 18 (plan §Task 13).

Status: **implemented and unit-verified, including a real (headless) Cesium
projection measurement. No browser surface was driven by this run** — the in-app
tab reports a 0×0 viewport and the external tab cannot be scripted — so **no
visual or interactive result is claimed here.** Everything requiring a real tab
is listed under *Owed to the Task 18 sweep* with steps and console snippets.

## Commands and real output

| command | result |
|---|---|
| `npx vitest run` | **119 passed / 11 files** (scale 13, keyboard 13, scaleProbe 9, attribution 9, search 16, provenance 8, morph 13, assets 15, declutter 9, tiers 7, grid 7) |
| `npx tsc --noEmit` | **exit 0, no diagnostics** |
| `.venv/Scripts/python.exe -m pytest scripts/tests -q` | **134 passed** |
| `npm run build` | **`✓ Compiled successfully in 7.8s`**, lint/type check passed, 5 static pages, `/` = 1.28 kB + 104 kB First Load JS |

TDD order followed: `scale.test.ts`, `keyboard.test.ts`, `scaleProbe.test.ts` and
`attribution.test.ts` were written first and run together. All four failed with
`Cannot find package '@/lib/scale'`, `'@/lib/keyboard'`, `'@/lib/cesium/scaleProbe'`,
`'@/lib/attribution'` — the modules did not exist. Then they were implemented; two
genuine assertion failures were found and diagnosed (see *Deviations*), not loosened.

## Measured through the live camera (this run, headless but real Cesium maths)

`src/test/scaleProbe.test.ts` builds a real `Cesium.Camera` on `MOON_ELLIPSOID` with a
`PerspectiveFrustum` (`fov 60°`, `aspectRatio 1`, 900×900 canvas) and a scene-shaped
object, then calls `measureMPerPx`, which goes through the public
`Cesium.SceneTransforms.worldToWindowCoordinates` — i.e. the actual projection, not a
formula. A square canvas is used on purpose so Cesium's "fov spans the longer side" rule
cannot move the answer, and 900 px is the viewport height `grid.ts`
(`cameraHeightForLevel`) and the label tiers already assume.

| camera height (m) | measured m/px | `mPerPx(L)` from the grid contract | grid level reported |
|---|---|---|---|
| 8 309 079 (`cameraHeightForLevel(0, 900, 60)`) | **10 660.553** | 10 660.55 (L0) | L0 |
| 1 038 635 (L3 height) | **1 332.569** | 1 332.57 | L3 |
| 259 659 (L5 height = the app's HOME view) | **333.142** | 333.14 | L5 |
| 129 829 (L6 height, the deepest baked level) | **166.571** | 166.57 | L6 |
| 1 500 (`MIN_H`, maximum zoom) | **1.925** | — | clamped to L6 |
| 35 000 000 (`MAX_H`, minimum zoom) | **44 905** | — | clamped to L0 |

The agreement is to three decimals, far inside the plan's "within a factor of 2"
acceptance, which is the falsifiable check that the ellipsoid and the projection are both
right (a WGS84 radius would be 3.7× off; a Y-flipped or 2D-only transform would show up
as a wrong ratio). Also proven by that file:

- **linearity in height**: measured(1e6) / measured(5e5) = 2.00 — a pinhole must be
  proportional, and it is.
- **nadir globe views are latitude-invariant**: measured at lat 60 / lat 0 = **1.000000**,
  while the ground probe distance itself halves
  (`alongParallelMeters(60, 0.01) = 151.61 m` vs `303.22 m` at the equator). On a sphere
  seen straight down the cos(lat) factor cancels between ground and image — which is
  exactly why the value has to be *measured* instead of looked up.
- **the cos(lat) factor must appear when the pixel grid is equirectangular** (paper mode):
  asserted with an injected projector that models `x ∝ lon` independent of latitude at
  L6's 182.04 px/deg — the reading at 60° is `cos(60°)` = 0.500 of the equatorial reading,
  and the equatorial reading is `mPerPx(6)`. **This models the 2D pixel grid, it is not a
  measurement of Cesium's SCENE2D camera** (that needs a real WebGL scene — owed below).
- **off-screen handling**: with a zenith-looking camera (`pitch = +90°`) the surface point
  under the camera is behind the view plane and `worldToWindowCoordinates` returns
  `undefined` → `measureMPerPx` returns **null** (not 0, not NaN). Same for a stub that
  drops the second probe point, and for both points landing on one pixel
  (`mPerPxFromPixels` rejects `pixelDelta ≤ 0`, `NaN`, `∞`).
  **What the readout shows then:** `ScaleReadout` prints
  `no scale readout — the surface point is off-screen` (`UNAVAILABLE` from `scale.ts`) and
  prints **no bar and no level** (`—`), instead of a stale or zero number.
- `PROBE_D_LON_DEG = 0.01` → a 303.22 m chord at the equator: small enough that chord-vs-arc
  and off-centre perspective errors are ≪ the readout's rounding to whole m/px.

## Keyboard: what the tests prove

`src/test/keyboard.test.ts` (13 tests) — plan-verbatim `keyAction` cases plus
`attachKeyboard` behaviour against a fake target/viewer:

- one `keydown` listener registered, and the returned function removes it (a key after
  `detach()` fires nothing);
- pans, zooms, rotates map to `camera.moveUp/moveDown/moveLeft/moveRight/zoomIn/zoomOut/
  rotateLeft/rotateRight`, and **every accepted move is followed by exactly one
  `scene.requestRender()`** — the viewer runs with `requestRenderMode: true`, so the missing
  call would be a frozen readout, not an error (plan Step 5's trap);
- step is scale-invariant: 8 % of camera altitude, floor 500 m; shift × 3 (asserted as a
  3.000 ratio on the emitted metres); rotation step 0.08 rad, shift × 3;
- **the controller limits are enforced in code**, not assumed: at `MIN_H` `+` does nothing,
  at `MAX_H` `-` does nothing, and at `MIN_H + 200` the zoom is truncated to exactly 200 m
  (programmatic camera moves bypass `screenSpaceCameraController` clamping);
- `preventDefault()` for arrows, `+`, `-`, `_`, `/`; **not** for unhandled keys;
- while `isTyping()` is true every key is left completely alone — no camera call *and* no
  `preventDefault()`, so the caret in the search field still moves and the field's own
  Escape handler still closes its list;
- `1` → `setMode('paper')`, `2` → `setMode('globe')`, `/` → `focusSearch()`, `Escape` →
  `close()`; `afterMove` fires for camera actions only (2 of 5 keys in the mixed test).

## Attribution: how `CREDIT` was reused, and the singleton question

- `src/components/Attribution.tsx` renders `{content.credit}` and `attributionContent()`
  returns **`CREDIT.html` imported from `src/lib/cesium/moon.ts`** — no component, test or
  constant retypes the string. `src/test/attribution.test.ts` asserts
  `attributionContent(manifest).credit === CREDIT.html` and that `CREDIT` is the
  `Cesium.Credit` instance itself.
- The U+2019 apostrophe is pinned *as a code point*: exactly one `'’'` in the string, and
  `CREDIT.html` must **not** contain the ASCII `"NASA's"`. This is the one-codepoint class
  of false failure the Global Constraints warn about.
- **Singleton evidence gathered this run (static, in 1.146 sources):**
  `makeProvider('photo'|'paper')` hands every provider the *identical* object
  (`a.credit === b.credit === CREDIT`); `Cesium.Credit` exposes **no `destroy()`** in
  1.146 (`typeof CREDIT.destroy === 'undefined'`, asserted), and `ImageryLayer.destroy()`
  is `destroyObject(this)` — it poisons the layer, not the credit it referenced. After
  `layer.destroy()` the test re-reads `CREDIT.html` unchanged, with its single U+2019.
  Cesium's own per-frame `updateCredits()` re-reads
  `layer.imageryProvider.credit` from the **live** layer list and `setCredit()` dedupes by
  `credit.id`, so a `setLayer` swap re-registers the same credit rather than losing it.
  **What was NOT observed:** the rendered credit line in a real tab after several swaps —
  owed below (item 7). One caveat to look at there: this app does not import Cesium's
  `Widgets.css`, so the engine's own `.cesium-widget-credits` container is **unstyled**; it
  may paint a second, unpositioned copy of the same line under the canvas. The visible
  attribution is the 10 px panel; whether to hide the engine's duplicate is a Task 18
  observation + a Task 16 styling call, so nothing was suppressed here.
- `attributionContent(manifest)` names the three products **from the manifest's own
  `sources[]`** (by role `detail` / `color` / `labels`, in that order) with the spec §2
  resolution facts `detail mosaic, 100 m/px` · `colour base, 76 px/deg` ·
  `9,087 gazetteer records`, and `baked` is `manifest.generatedAt`
  (`2026-10-07T05:55:25+00:00`) — never `new Date()`. With `manifest === null` it still
  returns the credit plus three `not baked yet` rows, which is the design §6 path.

## Deviations from the plan (deliberate, documented)

1. **The plan's `30 322.4 m` test constant is 0.95 m low.** `R * DEG2RAD` at the contract
   radius 1 737 400 m is **30 323.35 m** (the arc for 30 322.4 would need R = 1 737 346 m),
   and `grid.ts` / the manifest `levels[]` / Gate G2 all use 30 323.35. The plan's formula
   and the plan's literal contradict each other; the literal was corrected to `30_323.4`
   **with the plan's ±0.5 m tolerance unchanged**, plus two new assertions that pin it to
   `MOON_RADIUS_M * π/180` (9 decimals) and to `mPerPx(0) × pxPerDeg(0)`. Nothing was
   weakened: an Earth-radius implementation still fails, by 81 km.
2. **`niceBarScale(mPerPx(6), 120)` labels 10 km, not 20 km.** 20 km of ground needs
   120.1 px at 166.57 m/px, so with the plan's own "largest nice value that fits" rule the
   answer is 10 km ≈ 60 px. The test asserts that (59 < barPx < 61) and the invariant
   `barPx × mPerPx / 1000 === labelKm`, i.e. the bar is never clamped into lying about its
   own length.
3. **`measureMPerPx(viewer, project?)` takes an injectable projector** (default
   `SceneTransforms.worldToWindowCoordinates`). Without it the off-screen/same-pixel null
   paths and the equirectangular cos(lat) case could only be reached from a WebGL tab.
   Production callers (`MoonMap`) never pass it.
4. **Files beyond the plan's list:** `src/lib/attribution.ts` and
   `src/test/{scaleProbe,attribution}.test.ts` (the same reason as Task 12's
   `provenance.ts`: vitest runs in a `node` environment with no DOM and no new
   dependencies, so panel content is tested through a pure view model).
5. **`ScaleReadout` is deliberately not `aria-live`.** It updates on every rendered frame
   while the camera moves; a live region would make a screen reader unreadable. It is
   labelled instead. Rotation in Paper mode is left to Cesium (the plan expects `q` to do
   nothing there) and is unverified — see below.

## Not verified (honest list)

- That the readout, bar, panel or credit line **render** or are legible: no screenshot, no
  DOM. `ScaleReadout`/`Attribution` are typechecked and compiled into the production bundle
  (`npm run build` ✓), which is not the same as being seen.
- Any real keyboard event: `attachKeyboard` was exercised against a fake target, and
  `window`/`document.getElementById` paths in `MoonMap` were never run.
- The **SCENE2D (paper) projection** of a live camera: `measureMPerPx` is mode-agnostic and
  the equirectangular behaviour is proven against a modelled grid, but Cesium's 2D camera
  uses an orthographic frustum built by its own controller, which cannot be stood up
  headlessly without faking engine internals.
- Tile-level reporting under a real camera: `levelForMPerPx` is unit-tested against
  `mPerPx(L)`, but "the level the camera is actually resolving" depends on Cesium's tile
  selection (which oversamples below 166.6 m/px), not on the measured m/px alone.
- That five `+` presses visibly raise the number, that arrows pan, that `q` rotates in Globe
  and not in Paper, that `/` focuses the field, `1`/`2` switch modes, `Escape` closes the
  card, or that the page does not scroll.
- That Cesium's own credit container still shows the line after N layer swaps (analysis
  above; not observed), and whether it renders an unstyled duplicate.

## Owed to the Task 18 sweep

Precondition: `npm run dev`, a **visible** tab, real viewport (record `w × h` — the numbers
below depend on it, and the headless harness used 900×900).

1. **Readout vs analytic ground truth, Globe mode.** Centre the camera and go straight down:
   ```js
   __moonHarness.setCamera(0, 0, 259659);            // L5 height for a 900 px span
   __moonHarness.scale();                             // { mPerPx, canvas: [w, h] }
   const v = __moonViewer, h = v.camera.positionCartographic.height;
   const long = Math.max(v.canvas.clientWidth, v.canvas.clientHeight);
   ({ expected: 2 * h * Math.tan(Math.PI / 6) / long, measured: __moonHarness.scale().mPerPx });
   ```
   Expect `measured / expected ≈ 1.00` (Cesium's 60° fov spans the *longer* canvas side).
   Then press `+` five times: the printed `~N m/px` must fall every time and re-render
   (a frozen number means a missing `requestRender()`), and `__moonHarness.scale().mPerPx`
   must track it. Zoom to the floor and note that the readout keeps going below the tile
   resolution: at `MIN_H` it reads ≈ 1.9 m/px while the baked imagery stops at 166.6 m/px —
   the panel is honest about pixels, not about information content.
2. **The plan's level check.** At the L6 camera height (`129 829` m for 900 px)
   the readout must be within a factor of 2 of `mPerPx(6) = 166.57` and the panel must say
   `L6 of L6`. If it is ~10× off, the ellipsoid or the projection is wrong.
3. **Paper mode cos(lat).** Switch to Paper (`1`), then compare lat 0 and lat 60 at the same
   height:
   ```js
   __moonHarness.setCamera(0, 0, 259659); const a = __moonHarness.scale().mPerPx;
   __moonHarness.setCamera(0, 60, 259659); const b = __moonHarness.scale().mPerPx; b / a;
   ```
   Expect `b/a ≈ 0.5` (equirectangular pixels, shrinking ground). In Globe mode the same
   pair must give ≈ **1.00** — that contrast is the point of the measurement-based readout.
4. **Off-screen path.** Tilt the globe camera toward the limb (`drag`, or
   `__moonHarness.setCamera(0, 0, 259659, -0.15)`), and confirm the panel prints
   `no scale readout — the surface point is off-screen`, with no bar and `—` where the
   level is, and that it comes back on a straightened view. Also confirm a 0×0 canvas
   (hidden tab) never throws.
5. **Keyboard, for real:** arrows pan (shift = ~3× farther, by eye), `+`/`-` zoom, `q`/`e`
   rotate in Globe and do nothing visible in Paper, `1`/`2` morph, `/` focuses search,
   `Escape` closes the card, and the **page does not scroll** on arrows/`+`/`-`.
6. **Typing must not move the camera:** focus search, type `apollo 11`, and assert
   `__moonHarness.camera()` is byte-identical before and after; the caret must move.
7. **Attribution.** Screenshot the 10 px line, open the `Source products` disclosure and
   check the three file names, the three resolution notes and `Baked 2026-10-07…`. Then the
   singleton check the review asked for:
   ```js
   const before = document.querySelector('.cesium-widget-credits')?.textContent;
   ['paper','photo','paper','photo','photo'].forEach((l) => __moonHarness.setLayer(l));
   setTimeout(() => console.log({
     before, after: document.querySelector('.cesium-widget-credits')?.textContent,
     same: before === document.querySelector('.cesium-widget-credits')?.textContent,
     imageryLayers: __moonViewer.imageryLayers.length,   // must be 1
   }), 2000);
   ```
   Record whether Cesium's credit text survived the five swaps, how many copies of the
   sentence are on screen (ours + possibly an unstyled engine one), and whether the engine's
   container pushes the canvas or overflows the page. If a duplicate is confirmed, hide
   `.cesium-widget-credits` in `globals.css` **only while** the 10 px panel keeps the
   verbatim text.
8. Screenshots: deep zoom (readout ≤ 200 m/px), full-disc view (readout in the tens of
   km/px), Paper at lat 60, and the credit panel with the disclosure open.
