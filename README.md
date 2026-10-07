# Lunar Map Explorer

An interactive, Google-Maps-like view of the Moon in two modes driven by **one tile pyramid and one coordinate frame**: a flat equirectangular "Paper" map and a zoomable/rotatable "Globe". Rendered with CesiumJS alone - `SCENE2D` for paper, `SCENE3D` for globe - served from `public/` by Next.js. Local-first by decision: no tile server, no object storage, no public deploy, no Cesium ion account or asset. Curated IAU place names tier in and out with
zoom. Every number below is copied from the plan and spec in `docs/superpowers/{plans,specs}/` and their
`fetch-log.md`, `bake-log.md`, `gate-G1.md`, `gate-G2.md`, `tierA-check-transcript.txt`, `verify-10.md`,
`verify-16.md` records, plus `public/tiles/manifest.json`.

## Quickstart

```bash
npm install                                              # also runs scripts/postinstall_cesium.mjs
python -m venv .venv && .venv/Scripts/python.exe -m pip install -r scripts/requirements.txt
npm run fetch    # 3.04 GB of sources into gitignored data/raw, sha256-verified
npm run bake     # Tier A pyramid, 2 h 58 m measured, into gitignored public/tiles
npm run labels   # regenerates public/data/features.json
npm run dev
```

A fresh clone has **no imagery**: `.gitignore` excludes `public/tiles/*` except `manifest.json`, and all of
`data/raw/`, so the bake is mandatory - without it there is nothing to draw, and `npm run proof` stops with
`SystemExit: no paper tiles at level 5 under public/tiles`. `public/cesium/` is ignored too, which is why the
postinstall copier matters. The pipeline scripts are spelled `.venv\Scripts\python.exe scripts/foo.py` (backslashes, doubled because this is JSON) because npm runs package scripts through `cmd.exe`, not your Git Bash: a forward-slash venv path fails with "not recognized" before Python starts. From Git Bash itself, `.venv/Scripts/python.exe` remains correct.

## Measured pipeline cost

Measured, not estimated. Windows / Git Bash, Samsung 980 PRO SSD, 15.8 GiB RAM, rasterio 1.5.2 / GDAL 3.12.2,
Node 24 (`bake-log.md` §1-§4).

| Role | File | Bytes on disk | Licence recorded in this repo |
|---|---|---|---|
| detail | `LRO_WAC_Mosaic_Global_303ppd_v3.jp2` | 2,500,331,610 | none shipped; metadata credits `LROC Team, ASU` |
| colour | `lroc_color_poles.tif` | 518,090,428 | none shipped; `TIFFTAG_DOCUMENTNAME` = `/svs/data/lunar/lroc/albedo/hapke/lroc_color_poles.tif` |
| labels | `MOON_nomenclature_center_pts.zip` | 23,845,070 | `Public domain.` (`useconst` in `metadata_nomenclature_points_MOON.xml`) |

Sources total 3,042,272,356 B (with the 5,248 B `.aux.xml` sidecar); re-hashing all of it costs 2.48 s, so `npm run fetch` verifies by digest by default, and the 5,959,263,751 B `.tif` fallback was not downloaded because the `JP2OpenJPEG` driver worked. Only the gazetteer carries a written use constraint: check upstream terms before redistributing derived imagery.

Tier A (`--top 6`, both layers), tiles per level and measured bytes:

| Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | total |
|---|---|---|---|---|---|---|---|---|
| tiles / layer | 2 | 8 | 32 | 128 | 512 | 2,048 | 8,192 | 10,922 |
| paper bytes | 164,203 | 662,536 | 2,516,933 | 9,064,997 | 31,103,905 | 102,435,356 | 326,146,815 | 472,094,745 |
| photo bytes | 96,309 | 374,036 | 1,459,101 | 5,994,331 | 25,654,549 | 97,605,343 | 324,128,142 | 455,311,811 |

- **21,844 JPEGs, 927,406,556 B = 0.927 GB (0.864 GiB)**, 42,456 B/tile average (paper 43,224, photo 41,688;
  1.3191 and 1.2722 bits/px).
- **Wall clock 2 h 58 m 03 s** (`real 178m3.232s`; `timings.bakeSeconds` = 10,680.5 s), 150-200 s per full-width band. The cost is JP2 decoding, not resampling: the source's block geometry is `54,582 x 20,000` (full image height), so every band read decodes the whole 5.96 GPix codestream - an L2 smoke bake cost 38 minutes for 84 tiles.
- Design spec §3's "1.0-1.8 GB" is superseded by the measurement; `bake.py`'s estimator now carries the measured bits/px and predicts 927,405,788 B, an error of -0.00%.
- **Tier B (`--top 7`) was NOT run, so the next figures are extrapolations**, not measurements (`bake-log.md` §5, §5.1): `project_seconds(7, both, 1024)` puts it at **6.7-8.4 hours** from the measured 150-200 s/band (§5's looser band: 6-12 h) over 128 bands and **87,380 files**, with the estimator at **3.71 GB = 4.00x the measured Tier A total** and the guard asking **5.56 GB** free. It stays opt-in; `--top 6` is the shipped state.

## Grid contract, as measured

`512 x 512` px tiles; level `L` has `2^(L+1)` columns x `2^L` rows; **row 0 is north** (`y` increases
southward, no TMS reversal anywhere); longitude `−180…180`; **planetocentric** latitude `±90`; Moon sphere
radius **1,737,400 m**, flattening `0.0` - so planetographic and planetocentric coincide and no latitude
conversion is done. Row 0 = north was measured, not assumed: `tileXYToRectangle(0, 0, 1).north === 90`, headless and in the live page. m/px runs 10,660.55 (L0) → 333.14 (L5) → **166.57 (L6)**, exact `m_per_px(6)` = 166.57113880453207 (`--dry-run` prints 166.6).

The detail source's native grid is **303.2333 px/deg** (109,164 x 54,582) and falls *between* levels: L6 is
182.04 px/deg, L7 would be 364.09 px/deg. No power-of-two level equals it, because
`pxPerDeg = 512·2^(L+1)/360` only yields powers of two times 2.8444. **Level 6 at 166.57 m/px is the last
true downsample; level 7 at 83.3 m/px is a 1.2x upsample of a 100 m/px source.** Stage 0 also gates the
file's declared pixel size against the canonical one: 303.23337750432864 vs 303.23333333333335, drift `-0.015902 px` inside a 0.1 px tolerance.

## Re-running the gates

```bash
npm run test    # vitest then pytest
npm run proof   # Gate G2; reads public/tiles + public/data/features.json
node scripts/g1_tiling_probe.mjs                        # Gate G1 criteria 3+4, headless
.venv/Scripts/python.exe scripts/g2_geometry_probe.py   # G2 mis-registration tables
.venv/Scripts/python.exe scripts/g2_geometry_probe.py --sources   # + source-vs-tile check
```

The probes print and always exit 0: diagnostics, not tests. `npm run proof` still records the gate by
updating `albedoHistogram` and `geometryProof` in the tracked `public/tiles/manifest.json`, but since
`334b6bb` it writes through `manifest.write_manifest` - the one writer this repo has for that artifact, which
emits LF bytes plus a final newline - instead of `Path.write_text`, so it no longer re-typesets the whole
tracked file to CRLF. It changes only those two keys: run on this tree it left `manifest.json` byte-identical
(md5 `721e29a91a8dac525557fc03d144f456` before and after) and `git status` empty, so the tree is dirtied only
when the gate's numbers actually move. `npm run test` at this commit: vitest **222 passed / 15 files**, pytest
**178 passed**, `npx tsc --noEmit` clean (209 / 168 was the state when Task 15 landed).

**Gate G1** proves Cesium boots on self-hosted assets and that the geodetic `y` origin is what the bake
writes: `row0north = 90.000°`, `row1north = 0°`, L1 grid `4 x 2`, L2 `8 x 4`, `tileWidth = 512`, radii
`1737400 1737400 1737400`, zero off-site requests, no ion 401 - so **no `{reverseY}` and no `--y-flip`
anywhere**. It says nothing about real imagery, and a per-row `y` error in a real bake is not
browser-detectable: that is G2's job.

**Gate G2** proves the tile grid and the label coordinates agree, using USGS shapefile geometry as an
independent check of a NASA raster. Measured on level 5 `paper` (raw albedo DN, no gain): mare median
**33.5** vs highland median **80.5**, contrast **47.0 DN** against a 25 DN floor; histogram over
536,870,912 pixels in 2,048 tiles, mean 64.34, p33 47, p67 76; **20/20** mare and **16/16** highland
markers resolved (floor 15); and the four Apollo 11 traverse features (West 23.4908, 0.6705; Little West
23.4756, 0.6743; Double 23.4727, 0.6738; Mount Marilyn 40.0000, 1.1300) inside the Mare Tranquillitatis
bbox (lat `−4.0512…19.3748`, lon `16.924…45.4903`) and reading dark: **28, 28, 28, 57** against p67 = 76.
The pass is falsifiable, which is the only reason it means anything. Same tiles, lookup deliberately
mis-registered (`gate-G2.md`):

| registration | mare median | highland median | contrast |
|---|---|---|---|
| true | 33.5 | 80.5 | **+47.0 DN** |
| latitude mirrored (`lat → −lat`, the `y`-flip signature) | 51.5 | 50.0 | **−1.5 DN** |
| longitude rotated (`lon → lon+180`, the far-side signature) | 76.5 | 60.0 | **−16.5 DN** |

A footprint version over whole bboxes agrees: +33.0 / −7.0 / −15.0 DN. A flipped or rotated map inverts the
sign instead of merely weakening it. Honest scope: G2's floor is ~333 m (one L5 pixel), so it catches
whole-tile errors and not sub-pixel offsets; it says nothing about the `photo` layer's chroma transfer; and
it proves the two datasets *agree*, not that either is independently right. The delivered pyramid separately passed 54/54 region-scale checks (five maria dark, Tycho and Copernicus bright, orientation, antimeridian seam) in `tierA-check-transcript.txt`.

## What the imagery is, and its resolution ceiling

- **LROC WAC morphology mosaic**: global illumination-normalized albedo, 100 m/px (303.233 px/deg), one
  band - the only source of sharpness.
- **NASA SVS CGI Moon Kit** `lroc_color_poles.tif`: 27,360 x 13,680 at 76 px/deg (~399 m/px), poles filled.
  Hue only, through a chromaticity transfer (`chi = B/mean(B)`, detail gain `k = 0.4`) into which the WAC's
  high frequencies are injected.
- **IAU Gazetteer of Planetary Nomenclature** (USGS Astrogeology): 9,087 records, curated to the 600 in
  `public/data/features.json` (tiers 0/1/2/3 = 17/134/368/81; tier 3 = the 81 astronaut-named traverse
  features).

Plainly: **nothing human-made is visible at any public global resolution** - no lander, no descent stage, no
tracks - because no such product exists, not because the renderer is soft. The colour is **a chromaticity
transfer from a 76 px/deg base, not a calibrated mosaic**: hue is smooth and plausible, not spectrally
quantitative, and real 118 m/px colour (GLD100) was dropped because it stops at `±79°` and would need a
second shading source. **Craters below roughly a kilometre are blobs** at the default tier: 166.57 m/px
resolves crater floors of about `≥1 km` and major rilles. Sub-metre imagery exists for **exactly one site**
(Apollo 17, an official 0.5 m/px orthomosaic), not as a global product, so per-site zoom is a v2 item. There
is also no live public Moon tile service (USGS WMS dead, `map.lunarmap.org` no DNS, LROC Quick Map
HTML-only, ArcGIS MoonBMap 404, NASA GIBS Earth-only), which is why this repo bakes its own.

## Attribution

Rendered by the app as `src/lib/cesium/moon.ts`'s exported `CREDIT` (imported, never retyped; the apostrophe
is U+2019 on purpose):

> NASA/GSFC/Arizona State University (LROC WAC mosaic) · NASA’s Scientific Visualization Studio (CGI Moon Kit) · USGS Astrogeology Science Center · IAU Gazetteer of Planetary Nomenclature

## Known limits and open items

- **Polar albedo hole (upstream, not a bake defect).** 35,454,232 of 536,870,912 level-5 `paper` pixels -
  **6.6039%** - read DN 0, concentrated above `|lat| 73°` (rows 0-2 and 29-31; 68 tiles more than 50% black,
  all there). Sampling the source confirms it: 13x13 windows at 0°E / `±89.5°` are **100.0%** and **95.9%**
  exact zeros against 0.0% at the equator. Per hemisphere, counted off the delivered tiles with the same read
  `scripts/proof.py` uses (`Image.open(...).convert('L')`): the north's rows 0-15 hold 15,622,097 zero pixels
  of 268,435,456 = **5.8%**, the south's rows 16-31 hold 19,832,135 = **7.4%**, and the dense cap alone (rows
  0-2, `|lat| >= 73.1°`) is **4.9%** of a hemisphere. An earlier revision of this bullet said "~10% of each
  hemisphere's disc" - the same wording sits at `gate-G2.md` line 442 and in `verify-16.md` - and **no
  measurement supports it**: 10.9% only appears if you divide *both* polar caps (rows 0-2 + 29-31) by *one*
  hemisphere, which is not a per-disc statement, so the figure is dropped. So **in paper mode the poles look
  punched out** - black fields in a cream sheet, denser above `|lat| 73°` - while globe mode loses detail
  instead of going black, because the colour base fills the poles. Deliberately not muted:
  a veil lifting black toward cream would fabricate albedo the source does not have.
- **20 pinned gazetteer geometry defects.** 19 of the 9,087 records have a centre outside their own bbox
  (18 sub-half-degree precision mismatches plus `Statio Tianhe`'s genuine 90.9° sign error) and `Brill`
  straddles the `±180` vs `0-360` convention. `scripts/labels.py` ships those with `bbox: null` so nothing
  downstream trusts them, names the set, and exits nonzero only if it *grows* (`bbox defects: 19 found, 20
  known, 0 new`) - a guard on our regressions, not a claim that USGS data is perfect. 12 of them are curated
  tier-3 traverse features, hence the 12 nulls in `features.json`. Legitimate seam-crossing bboxes
  (`west > east`, 10 curated near-0° features) are not defects, and `bbox_contains` is the only legal
  containment test.
- **The paper tint is decor.** Paper mode's warm cast is a CSS `sepia/saturate/contrast/brightness` filter plus a `#efe9dc` base colour: no hypsometric tints, contours, relief shading or elevation layer of any kind.
- **Not yet verified in a browser.** No visible browser surface existed during implementation
  (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, viewport `0x0`, `visibilityState=hidden`), so each item below is
  unit-tested or numerically probed and still needs a real tab:
  - the **Paper↔Globe morph, in whole and in part**: nothing about it has been observed under the code that
    ships today. What `verify-10.md` records - every toggle finishing through the `completeMorph()` fallback
    in 4.0-8.7 s, and the camera-preservation table - was measured against the *previous* build, whose pump
    called `scene.render(wallClock)` under a 4 s deadline. That pump advanced nothing: in Cesium 1.146 the
    morph tweens are updated only by `Scene.initializeFrame()`, whose sole caller in the render path is
    `CesiumWidget.render()`; the fix pumps through `viewer.cesiumWidget.render()` on a `setTimeout` loop and
    adds a wall-clock watchdog on the morph **queue** (`MORPH_QUEUE_DEADLINE_MS`), commit `13322e9`, with the
    harness made to drive a mode change through the same latch a click does in `b1623f2`. The one live probe
    made before that fix saw `scene.mode` hold `MORPHING` for minutes. So the transition is open, and the
    **end state is open too** - the old 4 s-deadline measurements do not transfer to the shipped mechanism.
    To close it: `npm run dev` (not a built `start` - the harness globals are dev-only), a **visible** tab,
    **one click on Paper**, then read `__moonHarness.sceneMode()` (must become `SCENE2D`) and
    `document.querySelector('#cesiumContainer').dataset.mode` (must follow it to `paper`), and say out loud
    whether it animated or snapped. The deadline now sits at 15 s, which makes a jump-cut in a visible tab
    less likely, not impossible; and `CesiumWidget.render()` is gated on `_canRender` (canvas size non-zero),
    so a 0x0 tab still cannot animate a morph at all.
  - the **three failure panels** of plan Task 15 and spec §4.4 (unbaked tiles/manifest, missing Cesium
    static assets, no WebGL2) have never been forced in a real tab. `docs/superpowers/specs/verify-15.md`
    says so itself: the boot order and the panels' text are proven with injected fakes and
    `react-dom/server` renders, and the three real paths are listed as owed to the Task 18 sweep. The
    WebGL2 path cannot even be provoked in this harness.
  - the **four per-mode screenshots** owed by `verify-16.md` (globe+photo, globe+paper, paper+paper,
    paper+photo at L2 and L6) do not exist, so no claim is made about how either mode looks.
  - also owed: label subtlety and overlap in a real view, real mouse-drag behaviour, the `±180` strip and
    the poles viewed as pixels, and frame rate during drag-rotate (GPU-dependent, reported not asserted).
- **Spec §4.5's performance budget is neither implemented nor measured.** The budget asks for at most 16
  simultaneous tile requests (enforced "through Cesium's `maximumScreenSpaceErrors` / imagery request
  scheduling rather than by hoping the browser queues politely"), median tile response < 150 ms, L0 painted
  < 3 s after first paint, and a tab under 1.2 GB after 50 tile fetches. None of it exists in this build:
  `grep -rn "maximumScreenSpaceError" src/` returns no hits; `makeProvider` (`src/lib/cesium/moon.ts`) passes
  only `url`/`tilingScheme`/`tileWidth`/`tileHeight`/`minimumLevel`/`maximumLevel`/`rectangle`/`credit` to
  `UrlTemplateImageryProvider`, so Cesium's own default error threshold and default request scheduling decide
  how many tiles are in flight; and `createMoonViewer` sets no imagery request limit at all (its scene knobs
  are `requestRenderMode: true`, `maximumRenderTimeChange: Infinity` and the camera controller's zoom
  bounds). Nothing on either side has been timed either - no tile-response measurement, no in-flight request
  count and no memory sample appears in `gate-G1.md`, `gate-G2.md`, any `verify-*.md`, or the controller's
  sweep. This is an unstarted requirement, not a passing one.
- **`npm run dev` and `npm run build` require network at compile time.** `src/app/layout.tsx` imports `Geist`
  and `Geist_Mono` from `next/font/google`, so the Next compiler fetches those font files from Google on
  every `dev` and `build` and self-hosts the result. That cuts directly against the local-first decision this
  file opens with: an offline fresh clone cannot compile the app, it fails on the font fetch instead of
  degrading to a system font. It is also paying that cost for nothing - the only consumers of the emitted
  `--font-geist-sans` / `--font-geist-mono` variables are in `src/app/page.module.css`, which
  `grep -rn "page.module" src/` shows nothing imports (gate-G1's consequences list already records it as
  orphaned), while `globals.css` sets `system-ui` stacks directly. Recorded, not fixed, in this pass: the fix
  is a code change (a `next/font/local` swap with a vendored font, or dropping the import), and because no
  build in this repo's evidence was ever run offline, the offline failure itself is inferred from how
  `next/font/google` works rather than observed here.
- **Open:** Gate G3 (Task 18 sweep) has not been run; the Tier B decision stands as declined.
