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
npm run bake     # the base pyramid into gitignored public/tiles: --top 6 is 2 h 58 m
                 # measured, and the shipped artifact is --top 7 at 10 h 16 m
npm run labels   # regenerates public/data/features.json
npm run bake:deep     # optional: streams the L8-L10 ortho boxes out of the Kaguya COG
                      # (9 min, 7,106 tiles, ~195 MB, no download of the 78 GB source)
npm run bake:publish  # and merge that layer's availability into the manifest from the disk
npm run dev
```

A fresh clone has **no imagery**: `.gitignore` excludes `public/tiles/*` except `manifest.json`, and all of
`data/raw/`, so the bake is mandatory - without it there is nothing to draw, and `npm run proof` stops with
`SystemExit: no paper tiles at level 5 under public/tiles`. `public/cesium/` is ignored too, which is why the
postinstall copier matters. The pipeline scripts are spelled `.venv\Scripts\python.exe scripts/foo.py` (backslashes, doubled because this is JSON) because npm runs package scripts through `cmd.exe`, not your Git Bash: a forward-slash venv path fails with "not recognized" before Python starts. From Git Bash itself, `.venv/Scripts/python.exe` remains correct.

## Deploying

Still local-first by default — unset everything and the app reads `/tiles` from its own
origin, exactly as above. Hosting is a separate, opt-in step, and it is only ever a
*delivery* question because of the sizes: the app is ~8 MB, the pyramids are 3.0 GB and
95,643 files, which is why they are not committed. `NEXT_PUBLIC_TILE_BASE_URL` points the
client at an `https://` store that mirrors the same layout
(`<base>/manifest.json`, `<base>/<layer>/<L>/<x>/<y>.jpg`); `vercel.json` is committed; and
[`docs/deploy.md`](docs/deploy.md) covers the store's CORS requirement (without
`Access-Control-Allow-Origin` the map renders an empty globe, not an error panel), the sync
commands, the UI-only deployment that ships no imagery at all, and the ~71 MB L0-L4 subset
that needs no store. What the pipeline cannot do is verify any of that from here: no
credentials exist in this repository, so the store-side commands are documented as the
shape of the step rather than as a tested recipe.

## Measured pipeline cost

Measured, not estimated. Windows / Git Bash, Samsung 980 PRO SSD, 15.8 GiB RAM, rasterio 1.5.2 / GDAL 3.12.2,
Node 24 (`bake-log.md` §1-§4).

| Role | File | Bytes on disk | Licence recorded in this repo |
|---|---|---|---|
| detail | `LRO_WAC_Mosaic_Global_303ppd_v3.jp2` | 2,500,331,610 | none shipped; metadata credits `LROC Team, ASU` |
| colour | `lroc_color_poles.tif` | 518,090,428 | none shipped; `TIFFTAG_DOCUMENTNAME` = `/svs/data/lunar/lroc/albedo/hapke/lroc_color_poles.tif` |
| labels | `MOON_nomenclature_center_pts.zip` | 23,845,070 | `Public domain.` (`useconst` in `metadata_nomenclature_points_MOON.xml`) |

Sources total 3,042,272,356 B (with the 5,248 B `.aux.xml` sidecar); re-hashing all of it costs 2.48 s, so `npm run fetch` verifies by digest by default, and the 5,959,263,751 B `.tif` fallback was not downloaded because the `JP2OpenJPEG` driver worked. Only the gazetteer carries a written use constraint: check upstream terms before redistributing derived imagery.

Tier A (`--top 6`, both layers) — the pyramid as it first shipped, kept because the per-level
byte table below is Tier A's measurement:

| Level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | total |
|---|---|---|---|---|---|---|---|---|
| tiles / layer | 2 | 8 | 32 | 128 | 512 | 2,048 | 8,192 | 10,922 |
| paper bytes | 164,203 | 662,536 | 2,516,933 | 9,064,997 | 31,103,905 | 102,435,356 | 326,146,815 | 472,094,745 |
| photo bytes | 96,309 | 374,036 | 1,459,101 | 5,994,331 | 25,654,549 | 97,605,343 | 324,128,142 | 455,311,811 |

- **21,844 JPEGs, 927,406,556 B = 0.927 GB (0.864 GiB)**, 42,456 B/tile average (paper 43,224, photo 41,688;
  1.3191 and 1.2722 bits/px).
- **Wall clock 2 h 58 m 03 s** (`real 178m3.232s`; `timings.bakeSeconds` = 10,680.5 s), 150-200 s per full-width band. The cost is JP2 decoding, not resampling: the source's block geometry is `54,582 x 20,000` (full image height), so every band read decodes the whole 5.96 GPix codestream - an L2 smoke bake cost 38 minutes for 84 tiles.
- Design spec §3's "1.0-1.8 GB" is superseded by the measurement; `bake.py`'s estimator now carries the measured bits/px and predicts 927,405,788 B, an error of -0.00%.
- **Tier B (`--top 7`) has since been run and is the shipped state** (`d34a505`, 2026-10-09):
  **87,380 tiles / 2,819,245,403 B** (paper 1,491,944,257, photo 1,327,301,146) in
  `timings.bakeSeconds` = **36,975.8 s (10 h 16 m)**. The file and byte counts the
  extrapolation above predicted were exact; the *time* was 24-54% low, because it carried
  Tier A's per-band rate into a run with twice the bands and a JP2 decode that does not get
  cheaper. L7 is a **1.2x upsample of the 100 m/px WAC** (px/deg 364.09 wanted against
  303.23 held) and it is shipped as that, knowingly: the scale readout will say 83 m/px and
  this README says what produced it. The levels that are *not* an upsample are the separate
  `ortho` layer.
- **`ortho` — region-limited L8-L10 from the Kaguya TC orthomosaic at 7.4 m/px: 7,106 tiles /
  187,755,158 B** inside twelve boxes, streamed out of the remote COG by
  `npm run bake:deep` in 9 minutes with zero failures and no download of the 78 GB source.
  It is a second shaded illumination, so it is an overlay with its own attribution and never
  a blend into `paper`; `public/tiles/ortho/**` is gitignored like every other tile, and the
  app now probes two tiles per level before it will offer the layer at all.

## Grid contract, as measured

`512 x 512` px tiles; level `L` has `2^(L+1)` columns x `2^L` rows; **row 0 is north** (`y` increases
southward, no TMS reversal anywhere); longitude `−180…180`; **planetocentric** latitude `±90`; Moon sphere
radius **1,737,400 m**, flattening `0.0` - so planetographic and planetocentric coincide and no latitude
conversion is done. Row 0 = north was measured, not assumed: `tileXYToRectangle(0, 0, 1).north === 90`, headless and in the live page. m/px runs 10,660.55 (L0) → 333.14 (L5) → **166.57 (L6)** → **83.29 (L7)**, exact `m_per_px(6)` = 166.57113880453207 (`--dry-run` prints 166.6), and the region-limited `ortho` continues 41.64 (L8) → 20.82 (L9) → **10.41 (L10)**.

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
(md5 `6b2c9c5558d54d6f399a7526b7408821` at the time of writing — it moves whenever the gate's numbers
do, which is the point of pinning it) and `git status` empty, so the tree is dirtied only
when the gate's numbers actually move. `npm run test` at this commit: vitest **503 passed / 26 files**, pytest
**358 passed + 1 xfailed**, `npx tsc --noEmit` clean (291 passed / 18 files was the state after Task 17;
222 / 178 at Task 17, 209 / 168 when Task 15 landed).

**Gate G1** proves Cesium boots on self-hosted assets and that the geodetic `y` origin is what the bake
writes: `row0north = 90.000°`, `row1north = 0°`, L1 grid `4 x 2`, L2 `8 x 4`, `tileWidth = 512`, radii
`1737400 1737400 1737400`, zero off-site requests, no ion 401 - so **no `{reverseY}` and no `--y-flip`
anywhere**. It says nothing about real imagery, and a per-row `y` error in a real bake is not
browser-detectable: that is G2's job.

**Gate G2** proves the tile grid and the label coordinates agree, using USGS shapefile geometry as an
independent check of a NASA raster. Measured on level 5 `paper` (raw albedo DN, no gain), re-run on
2026-10-09 against the delivered L7 pyramid: mare median **33.5** vs highland median **81.5**, contrast
**48.0 DN** against a 25 DN floor; histogram over
536,870,912 pixels in 2,048 tiles, mean 64.33, p33 47, p67 76; **20/20** mare and **16/16** highland
markers resolved (floor 15); and the four Apollo 11 traverse features (West 23.4908, 0.6705; Little West
23.4756, 0.6743; Double 23.4727, 0.6738; Mount Marilyn 40.0000, 1.1300) inside the Mare Tranquillitatis
bbox (lat `−4.0512…19.3748`, lon `16.924…45.4903`) and reading dark: **29, 30, 30, 56** against p67 = 76.
The pass is falsifiable, which is the only reason it means anything. Same tiles, lookup deliberately
mis-registered (`gate-G2.md`):

| registration | mare median | highland median | contrast |
|---|---|---|---|
| true | 33.5 | 81.5 | **+48.0 DN** |
| latitude mirrored (`lat → −lat`, the `y`-flip signature) | 54.0 | 49.5 | **−4.5 DN** |
| longitude rotated (`lon → lon+180`, the far-side signature) | 76.5 | 60.5 | **−16.0 DN** |

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
- **IAU Gazetteer of Planetary Nomenclature** (USGS Astrogeology): 9,087 records, curated to the
  1,585 in `public/data/features.json` (tiers 0/1/2/3 = 17/134/1353/81; tier 3 = the 81
  astronaut-named traverse features). Amendment 2 D9 lifted the old 600-name budget and the
  70 km crater floor to 15 km, so the search box says 1,585 and means it.

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

## License and what it does not cover

The code, tests and documentation here are MIT-licensed (`LICENSE`). **The license covers no
imagery**, because this project holds no rights to grant: `NOTICE.md` lists each product,
what its upstream actually states, and the one thing that has never been done — verifying
the redistribution terms for the LROC, SVS and Kaguya TC derived rasters before publishing
a deployment that serves them. The gazetteer is the only artifact with a written use
constraint, and it says `Public domain.`

The decision to deploy publicly is recorded in `docs/deploy.md`; the UI-only deployment it
describes serves no imagery at all and is therefore outside that question.

## Known limits and open items

- **Polar albedo hole (upstream, not a bake defect).** 35,183,101 of 536,870,912 level-5 `paper`
  pixels - **6.5534%** - read DN 0, concentrated above `|lat| 73°`; 68 tiles are more than 50%
  black, all of them in the caps. Sampling the source confirms it: 13x13 windows at 0°E /
  `±89.5°` are **100.0%** and **95.9%** exact zeros against 0.0% at the equator. Per hemisphere,
  recounted on 2026-10-09 over all 2,048 delivered tiles with the same read `scripts/proof.py`
  uses (`Image.open(...).convert('L')`, `work/polar-measure-l7.txt`): the north's rows 0-15 hold
  15,494,996 zero pixels of 268,435,456 = **5.77%**, the south's rows 16-31 hold 19,688,105 =
  **7.33%**, and the dense caps alone are **4.9%** of the north (rows 0-2) and **6.0%** of the
  south (rows 29-31). The per-row shares run 48.0 / 19.4 / 11.0 / 5.6 / 2.7% down the north and
  9.3 / 17.8 / 24.2 / 53.5% up the south. An earlier revision of this bullet said "~10% of each
  hemisphere's disc" - the same wording sat at `gate-G2.md` line 442 and in `verify-16.md`, now
  corrected - and **no measurement supports it**: 10.9% only appears if you divide *both* polar
  caps (rows 0-2 + 29-31) by *one* hemisphere, which is not a per-disc statement, so the figure
  is dropped. The pre-L7 counts (6.6039%, 5.8%, 7.4%) were also superseded by the recount:
  deriving L0-L6 from the L7 core moved them slightly. So **in paper mode the poles look
  punched out** - black fields in a cream sheet, denser above `|lat| 73°` - while globe mode loses detail
  instead of going black, because the colour base fills the poles. Deliberately not muted:
  a veil lifting black toward cream would fabricate albedo the source does not have.
- **20 pinned gazetteer geometry defects.** 19 of the 9,087 records have a centre outside their own bbox
  (18 sub-half-degree precision mismatches plus `Statio Tianhe`'s genuine 90.9° sign error) and `Brill`
  straddles the `±180` vs `0-360` convention. `scripts/labels.py` ships those with `bbox: null` so nothing
  downstream trusts them, names the set, and exits nonzero only if it *grows* (`bbox defects: 19 found, 20
  known, 0 new`) - a guard on our regressions, not a claim that USGS data is perfect. 12 of them are curated
  tier-3 traverse features and the thirteenth is `Brill`, hence the 13 nulls in `features.json`
  (`test_labels.py:154` pins it at 13). Legitimate seam-crossing bboxes
  (`west > east`, 10 curated near-0° features) are not defects, and `bbox_contains` is the only legal
  containment test.
- **The paper tint is decor.** Paper mode's warm cast is a CSS `sepia/saturate/contrast/brightness` filter plus a `#efe9dc` base colour: no hypsometric tints, contours, relief shading or elevation layer of any kind.
- **Visually verified on 2026-10-08, and only partly.** `docs/superpowers/specs/gate-G3-live.md` §7
  records a real Chrome pass with three images read by eye (`work/g3-globe-22000km.png`,
  `g3-globe-hemisphere.png`, `g3-paper-flat.png`): the Moon is recognisable and correctly oriented,
  mare boundaries and Tycho's rays are legible, flat mode is a true equirectangular sheet with no
  visible seam. That pass found **five defects no test could see** - colour that renders grey, a paper
  tint with no warm shift, a default framing that put a ~110 px disc on a 564x786 canvas, landing-site
  dots out-shining the names, and a "compass rose" that turned out to be the Next.js dev badge - and §8
  measures all five fixed. Since then the claim has been *narrowed*, not withdrawn:
  - **Whether a morph animates or jump-cuts** is still unheard of. The end state is proven and the
    mechanism changed after the old measurements - in Cesium 1.146 only `CesiumWidget.render()` advances
    the morph tweens, so the pump is `viewer.cesiumWidget.render()` on a `setTimeout` loop with a 15 s
    wall-clock watchdog on the morph queue (`13322e9`, `b1623f2`) - but every `verify-10.md` figure
    (4.0-8.7 s per toggle) was taken against the pump that advanced nothing. To close it: `npm run dev`
    (the harness globals are dev-only), a **visible** tab, one click on Paper, then read
    `__moonHarness.sceneMode()` and `#cesiumContainer`'s `data-mode`, and say out loud whether it moved.
  - **The three failure panels** of plan Task 15 and spec §4.4 have never been induced in a real tab;
    `verify-15.md` says so itself. Inducing the unbaked one means moving 87,380 git-ignored tiles.
  - **Mouse drag, wheel zoom and keyboard pan** have never been driven as real input events.
  - **The `±180°` strip and the poles as rendered pixels** are proven numerically
    (`tierA-check-transcript.txt`), not in an image; the polar hole above is 6.55% of the L5 grid.
  - **The `ortho` overlay has never been looked at.** It is verified live over CDP - tiles-to-render,
    request counts, frame cost, attach/detach, and the not-on-this-machine path - but every one of those
    is a number, not a pixel. Nobody has judged whether a 10.4 m/px Kaguya box beside a 83 m/px WAC
    surround looks like a feature or a fault. That is the first item for the Task 18 sweep.
  - **Frame rate and spec §4.5's whole performance budget** are unmeasured and largely unimplemented:
    no `maximumScreenSpaceError`, no request-concurrency cap, no latency or memory figures. The one
    exception is the overlay's cost, measured twice in `docs/.../ortho.ts`'s `minimumLevel` note:
    +21.8% frame time under software rasterisation inside a region, nothing outside it.
  - `verify-16.md`'s four per-mode screenshot combinations (globe/paper x photo/paper at L2 and L6)
    still do not exist.
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
- **~~`npm run dev` and `npm run build` require network at compile time.~~ Fixed 2026-10-09.**
  `src/app/layout.tsx` used to import `Geist` and `Geist_Mono` from `next/font/google`, so the
  compiler fetched them from Google on every `dev` and `build` — an offline fresh clone could not
  compile, and the only consumers of the emitted `--font-geist-*` variables were in
  `src/app/page.module.css`, which nothing imports, while `globals.css` sets `system-ui` stacks
  directly. The import is gone, which also removes the project's only build-time network egress;
  `page.module.css` is now dead and should be deleted with the rest of the Task 18 sweep. Note
  what the original bullet admitted and this correction does not change: the offline failure was
  *inferred* from how `next/font/google` works, never observed, because no build in this repo's
  evidence has ever been run offline.
- **Open:** Gate G3 (Task 18 sweep) is in progress — the deep-zoom layer now has its first
  composited captures (`work/ortho-shots/`, recorded in `gate-G3-live.md`), and the filter
  sidebar, framing regions and performance budget are being built on top of it. The Tier B
  decision stands as declined.
