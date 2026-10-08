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
- **Frame rate during rotation**, and every figure in spec §4.5's performance budget:
  ≤16 concurrent tile requests is not implemented (no `maximumScreenSpaceError` or
  scheduling config anywhere in `src/`), and median tile latency, time-to-paint and tab
  memory were never measured.
- **A cold offline clone.** `src/app/layout.tsx` loads fonts through `next/font/google`,
  so `npm run dev` / `npm run build` need network at compile time; not exercised here.
- **Tier B** (`--top 7`): never run, per the human's opt-in decision. Projected from
  measured per-band cost at 3.71 GB and 6.7–8.4 h — an extrapolation, not a measurement.

## 6. Verdict

Gate G3: **passing on every measurable claim, incomplete on every visual claim.** The
application runs, paints the baked Moon at the resolution it claims, keeps its geometry
and labels consistent with the two gates, talks to no third-party service, and switches
between Paper and Globe. It has never been looked at with human eyes.
