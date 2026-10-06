# Lunar Map Explorer — design

Date: 2026-10-06
Status: §1 approved in chat 2026-10-06. §2 and §3 written but **not yet reviewed**.
Owner: Sanskar Sontakke. Implementation delegated to a coding agent.

## 0. What we are building

An interactive, Google-Maps-feeling view of the Moon in a Next.js app, with two
modes driven by **one tile pyramid and one coordinate frame**:

- **Paper** — flat, equirectangular, low-contrast cartographic map.
- **Globe** — zoomable and rotatable sphere with continuous level-of-detail.

Both modes show subtle place names (Sea of Tranquility, Tycho, Apollo landing
sites) that tier in and out with zoom.

## 1. Decisions already taken (approved)

| # | Decision | Choice |
|---|---|---|
| D1 | Detail tier | Tiered: always bake to 167 m/px; optional deeper tier behind a flag |
| D2 | Layers | Two: fine grayscale (paper) + colour relief (globe) |
| D3 | Deployment | Local-first only. No public host, no object storage, no tile server |
| D4 | Renderer | CesiumJS alone — `SceneMode.SCENE2D` for Paper, `SCENE3D` for Globe |
| D5 | Imagery strategy | Use authoritative pre-stitched global mosaics; **do not stitch camera frames** |

### 1.1 Why not stitching (D5)

LROC NAC is pushbroom: ~0.5–2 m/px across a ~5 km swath, panchromatic, and
illumination varies frame to frame. LROC's own mosaicking rule requires **<5°
difference in incidence angle and the same sun direction** within a mosaic.
Combining raw frames therefore produces exactly the seam/FOV artefacts the brief
rejects, and needs ISIS photogrammetric control. The products below are already
controlled, map-projected, illumination-normalized global mosaics, so geometry
is inherited rather than manufactured.

### 1.2 Why not MapLibre or three.js

- MapLibre's style spec states that for raster sources "the global-mercator
  (aka Spherical Mercator) profile is assumed" (`scheme` accepts only `xyz` /
  `tms`). Web Mercator cannot represent |lat| > 85° and inflates polar area
  without bound, which destroys the polar regions.
- A three.js sphere is limited by one texture: a 16384 × 8192 ceiling is
  ~45 px/deg ≈ 670 m/px, so the globe would be visibly softer than the flat
  map. Adding LOD sphere tiling means writing a globe engine.
- Cesium `GeographicTilingScheme` *is* our grid: level 0 = 2 × 1 square tiles,
  level N = 2·2^N across by 2^N down, default rectangle = whole world, tile
  counts independent of ellipsoid radius.

## 2. Data contract

### 2.1 Sources (all verified reachable from this machine, 2026-10-06)

| Role | Product | Grid | Bytes |
|---|---|---|---|
| Detail | LROC WAC morphology global mosaic — `LRO_WAC_Mosaic_Global_303ppd_v3.jp2` | 109,164 × 54,582 · 303.233 px/deg (≈100 m/px) · SimpleCylindrical · lat ±90 · lon −180…180 · `PositiveEast` · `LongitudeDomain=180` · planetocentric · R = 1,737,400 m · 1 band | 2,500,331,610 |
| Detail fallback | `Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif` — identical grid, 1 band uint8 | same | 5,959,263,751 |
| Colour + relief base | NASA SVS CGI Moon Kit — `lroc_color_poles.tif` | 27,360 × 13,680 · 76 px/deg (≈399 m/px) · 4 band LZW · poles filled | 518,090,428 |
| Labels | USGS IAU Gazetteer of Planetary Nomenclature, Moon centre points — `MOON_nomenclature_center_pts.zip` | 9,087 records | 23,845,070 |

Canonical fetch form: `https://planetarymaps.usgs.gov/mosaic/<file>` → 302 →
`https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/<file>` (200,
`Accept-Ranges: bytes`). Gazetteer:
`https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip`.

Dropped on purpose: `Lunar_LROC_WAC_GLD100_ClrShade_79s79n_118m_v1_1.tif`
(11.2 GB, true 118 m/px colour) because it covers only ±79° and would need a
second relief model to fill the poles, putting two different draping suns
side by side. Shaded relief and hue are low-frequency signals — the base needs
only 76 px/deg, and the fine structure comes from the 303 px/deg detail mosaic.
One shading source means no latitude seam.

### 2.2 Composite recipe

Per output pixel, with base `B` (colour, drop the alpha band) and detail `D`
(grayscale), both resampled to the output grid. Upsampling from either native
grid uses bilinear; decimation uses GDAL's `-r average` overviews (Stage 1).

```
chi_i   = B_i / mean(B)                    # chromaticity: hue, brightness-free
highpass = D - LP(D)                       # LP = Gaussian, sigma ~2.5 px
L_out   = mean(B) * (1 + k * highpass / mu_D)   # mu_D = mean of D over the window
RGB_out = clamp(L_out * chi_i, 0, max)
```

`k = 0.4` default, `--detail-gain` to change, `--no-detail` to fall back to the
bare colour base. `mu_D` floored at an epsilon. Note the exact identity the test
suite asserts: at `k = 0`, `L_out = mean(B)` and `RGB_out` returns `B_i`
bit-for-bit. Because both inputs are single
global mosaics on registered grids, this is a per-pixel raster composite, not
an image stitch — no field-of-view or illumination mixing is possible.

The paper layer is `D` alone: a 1-band grayscale JPEG, with the paper tint
applied by the renderer (CSS filter on the canvas), not baked in, so tint can
change without a re-bake.

### 2.3 Coordinate conventions (the part that must not be wrong)

- No EPSG code exists for the Moon. Pipeline writes a custom `.prj` =
  `GEOGCS["GCS_Moon_2000", DATUM["D_Moon_2000",
  SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]], PRIMEM["Reference_Meridian",0],
  UNIT["Degree",0.0174532925199433]]` (same WKT the gazetteer shapefile ships).
- Flattening is **zero** in both label and image products, so
  planetographic ≡ planetocentric here. The ~2 km shift that would otherwise
  apply at mid-latitudes does **not** arise, and no latitude conversion is
  performed. This corrects an earlier warning in the design conversation.
- Longitude is the only transform: gazetteer `center_lon` is 0–360 positive
  east; imagery is −180…180. Apply `lon - 360 if lon > 180`.
- Sample rows verified in the actual DBF: Tycho `348.7847 / -43.2958` →
  `-11.2153 / -43.2958`; Mare Tranquillitatis `30.8346 / 8.3487`, diameter
  875.75 km, `origin` = `"Sea of Tranquility."`, bbox lat −4.0512…19.3748,
  lon 16.924…45.4903; Shackleton `-89.67`; Oceanus Procellarum
  `303.3226 / 20.6714`, diameter 2592 km.
- Half-pixel convention: GeoTIFF rasters are pixel-**corner** referenced
  (pixel *i* spans `[lon0 + i·res, lon0 + (i+1)·res]`), and Cesium tiling is
  corner-based too. Used everywhere, with a unit test that asserts a known
  meridian does **not** land half a pixel off (50 m at native resolution).

## 3. Tile pyramid (Tier A / Tier B)

Numbering is **Cesium-native** (`L`), which differs by one from the `z` labels
used during the chat discussion: chat `z7` (167 m/px) = `L6` here, chat `z8`
(83 m/px) = `L7` here.

Grid: 512 × 512 px square tiles, `y` increases **southward** (row 0 = north).
Level `L`: `cols = 2^(L+1)`, `rows = 2^L`, world width `512·2^(L+1)` px,
`pxPerDeg = 512·2^(L+1)/360`, `mPerPx = (pi/180 · 1737400) / pxPerDeg`.

| L | cols × rows | tiles | px/deg | m/px | notes |
|---|---|---|---|---|---|
| 0 | 2 × 1 | 2 | 2.84 | 10,661 | |
| 1 | 4 × 2 | 8 | 5.69 | 5,331 | |
| 2 | 8 × 4 | 32 | 11.38 | 2,665 | |
| 3 | 16 × 8 | 128 | 22.76 | 1,333 | |
| 4 | 32 × 16 | 512 | 45.51 | 666 | |
| 5 | 64 × 32 | 2,048 | 91.02 | 333 | |
| **6** | 128 × 64 | 8,192 | 182.0 | **166.5** | **Tier A top (D1)** — Σ L0–L6 = 10,922 |
| **7** | 256 × 128 | 32,768 | 364.1 | **83.3** | **Tier B** — Σ L0–L7 = 43,690 per layer |

Native resolution is 303.233 px/deg, which falls between L6 and L7. **No
power-of-two level equals native.** L7 oversamples by 1.2×; that is the closest
representable tier and it is the last level at which real detail is gained.

**Volume estimate, stated as an estimate.** Measured empirically during the
plan's first bake, then the `manifest.json` records the truth.

- Tier A, two layers: ~21,844 files, ~1.0–1.8 GB.
- Tier B adds ~65,536 files, ~4–6 GB (colour tiles at L7 dominate).
- **Open knob for review:** Tier B is 3–4× Tier A on disk. It is opt-in and the
  app must be fully usable without it.

Disk guard: the bake refuses to start if free space is below 1.5× the estimate
above, and prints the numbers it used.

### 3.0 Encoding and command surface

Tiles are encoded as JPEG, `--quality` default 85, `optimize_coding` on, no
EXIF/thumbnails, non-progressived. The paper layer is written as single-band
grayscale JPEG (`PHOTOMETRIC=MINISBLACK`, no chroma to subsample); the photo
layer as 4:2:0 YCbCr. WebP is deferred — it would cut ~30% of Tier B's bytes but
adds a format variable to a pipeline whose job is geometry.

| Command | Maps to | Key flags |
|---|---|---|
| `npm run fetch` | `scripts/fetch_data.py` | `--force`, `--only detail,color,labels` |
| `npm run bake` | `scripts/bake.py` | `--top 6\|7` (default 6), `--detail-gain k`, `--no-detail`, `--quality`, `--layer paper\|photo\|both`, `--force`, `--dry-run` (prints the disk/time estimate and the grid contract, writes nothing) |
| `npm run labels` | `scripts/labels.py` | `--min-crater-km` (default 70), `--out` |
| `npm run dev` / `npm run start` | Next.js | — |
| `npm run test` | vitest + pytest | — |

`--dry-run` exists because the expensive path must be inspectable before it runs.

### 3.0.1 Local environment setup

`python -m venv .venv` then `pip install rasterio numpy pillow pyshp pytest`.
Node 24 and npm 11 are already present; Git Bash is the shell. GDAL arrives via
rasterio's wheels (no system GDAL install, and nothing is installed globally).
Which raster driver is actually usable is probed, not assumed (§3.1 dependency
note).

### 3.1 Bake algorithm

1. **Stage 0 — contract check (fail loud).** Open each source with GDAL;
   assert width/height/bands/dtype, `px/deg`, projection name, latitude type,
   longitude domain and sign, and radius. Print the actual label/GeoTIFF tag
   values next to the expected ones. If the JP2 driver is unavailable, switch to
   the `.tif` fallback and log which was used.
2. **Stage 1 — block-tiled working copies.** `gdal_translate -of GTiff
   -co TILED=YES -co COMPRESS=DEFLATE` for each source, then `gdaladdo -r
   average` with factors 2…64. Every later read then comes from a matching
   overview, which is what keeps the bake O(total tile pixels) instead of
   O(native × levels).
3. **Stage 2 — top level.** For each tile at the top level, read a window of
   `(512 + 2m)²` px with `m = 8` bleed, composite (§2.2), crop to 512, encode.
   Memory bounded to one window. Padding is **periodic in longitude** (columns 0
   and `cols-1` wrap) and **clamped in latitude** (poles). Without periodic
   padding the local blur produces a visible 1-tile-wide streak at the
   antimeridian — the classic global-map bug, so it is specified, not discovered.
4. **Stage 3 — derive lower levels from the level above** by 2×2 box averages of
   four neighbouring tiles plus their margins. Guarantees parent/child geometric
   consistency (no cross-level flicker). Cost: parents are averages of decoded
   JPEG, slightly softer than re-reading source overviews; accepted trade-off.
5. **Stage 4 — labels.** Parse the shapefile (DBF + SHP) with `pyshp`; apply the
   curation and tiering in §4.1; emit `public/data/features.json` with
   planetocentric ±180 lon, tier, diameter, gloss, gazetteer URL.
6. **Stage 5 — manifest.** Write `public/tiles/manifest.json`: source URLs,
   sha256 + byte size of each raw file, grid contract as read, bake parameters
   (`top`, `k`, tile size, quality), tile counts per level per layer, elapsed
   time, measured bytes on disk. Committed to git; tiles are not.

Resumability: a tile is skipped if it exists and its `(L,x,y)` is recorded in a
sidecar index; `--force` re-bakes. Changing `--top` rebuilds the whole pyramid
below it and says so before starting.

Dependency note: `rasterio` is the intended windowed-read path (wheels bundle
GDAL, JP2 support varies by build). If `rasterio` cannot open JP2, the fallback
is GDAL CLI (`gdal_translate`) for Stage 1 plus rasterio on the resulting
GeoTIFF, and finally the uncompressed `.tif` source. Decided by probe, recorded
in the manifest — not guessed.

### 3.2 Fetch policy

`npm run fetch` → `scripts/fetch_data.py`: ranged downloads with resume, sha256
recorded, size verified against `Content-Length`, never overwrite a matching
file, `--force` to re-download. Downloads go to `data/raw/` (git-ignored).

## 4. Application

### 4.1 Label curation and tiering

From 9,087 records, drop the 7,064 satellite craters (`code = SF`). The real IAU
descriptor codes in the shipped DBF, with counts read from the file: `AA` crater
1,615 · `RI` rima 112 · `LF` astronaut-named 81 · `MO` mons 58 · `DO` dorsum 39 ·
`ME` mare 22 · `LC` lacus 21 · `CA` catena 20 · `VA` vallis 14 · `SI` sinus 12 ·
`PR` promontorium 9 · `RU` rupes 8, plus `OC` oceanus and `PL` planitia. Curation
keys on `code`, not on the display `type` string, and craters pass a diameter cut.

| Tier | Content | Shown from | Measured |
|---|---|---|---|
| T0 | named oceanus/mare set (17 verified IAU entries) | always | 17 |
| T1 | other mare/sinus/lacus/promontorium, craters ≥150 km, montes ≥200 km, plus a short famous-but-small override list | tile level 1 | 133 |
| T2 | craters ≥70 km, rimae / dorsa / catenae / valles ≥100 km | tile level 3 | 497 |
| T3 | `LF` astronaut-named traverse features, tagged with `mission` | always | 81 |

Those four columns are what `scripts/labels.py` produced against the shipped
gazetteer at `--min-crater-km 70`: 728 candidates, pruned to the 600-label budget
by removing the 128 smallest tier-2 entries — the prune never touches T0, T1 or
T3.

**There are no landing sites in the gazetteer.** No record is named "Apollo 11",
"Luna 16" or "Surveyor 1", and matching mission names as substrings would wrongly
promote the crater *Apollo*, the crater *Surveyor* and the craters *Chang Heng*
and *Chang-Ngo* (named for astronomers, not missions). T3 is therefore the 81
IAU astronaut-named traverse features whose `origin` reads
`Astronaut-named feature, Apollo 17 site.` — the mission is parsed out of that
string into a `mission` property. Four of them (West, Little West, Double, Mount
Marilyn) are the Apollo 11 site, and they do sit inside Mare Tranquillitatis.
Actual landing-site markers need a different source and are a v2 item (§6).

Subtlety is rendered, not baked: `rgba(238,238,238,0.62)` fill, black
silhouette 1.5 px, `scaleByDistance`, `translucencyByDistance`,
`distanceDisplayCondition` per tier. Cesium has no label collision avoidance,
so `lib/labels/declutter.ts` runs a debounced screen-space overlap pass on camera
move and hides lower-priority labels inside a cell grid. It is a pure function
(units: boxes + priorities → visible set) so it can be tested without a GPU.

### 4.2 Stack and integration

- Next.js (App Router) + TypeScript + `cesium` from npm. No Cesium ion account,
  no ion asset: viewer constructed with an explicit `baseLayer` from our own
  `UrlTemplateImageryProvider`, `baseLayerPicker: false`,
  `ion.defaultAccessToken` never used.
- `scripts/postinstall_cesium.mjs` copies
  `node_modules/cesium/Build/Cesium/{Workers,Widgets,Assets,ThirdParty}` →
  `public/cesium/`; the client entry sets
  `globalThis.CESIUM_BASE_URL = '/cesium'` before importing Cesium, so no
  bundler-specific `DefinePlugin` is required. Map component loaded with
  `next/dynamic(..., { ssr: false })`.
- **Gate G1 (first, before any UI):** prove Cesium boots under `npm run dev`
  and renders one Tier A tile in `SCENE3D`. G1 also **settles the `y`-origin
  question empirically**: Cesium's `GeographicTilingScheme.tileYToLatitude` is
  read as north-first (row 0 = north, the "xyz" convention), but that reading is
  confirmed by rendering a deliberately asymmetric test tile (north half black,
  south half white) and screenshotting it, before any UI is built on top of the
  assumption. If Cesium turns out to want TMS order, the fix is one `--y-flip`
  bake flag, not a rewrite. If bundling fights us, fall back in
  order: (a) verify under `next build && next start`; (b) load the
  self-hosted UMD `public/cesium/Cesium.js` with a script tag, no bundler
  involvement. Escape hatch (b) is a supported path, not a hack.
- Globe radius: Cesium's visual geometry is scale-free for our purposes; the
  ellipsoid is set to a 1,737,400 m sphere so altitudes, `pickPosition` and the
  scale readout are in true lunar metres. If a Cesium API resists a non-WGS84
  ellipsoid, the documented concession is a WGS84 globe with metre conversion
  applied only in the readout — flagged if it happens.

### 4.3 Interface

Full-bleed canvas, minimal chrome.

- **Mode toggle** Paper | Globe → `morphTo2D` / `morphTo3D`, camera centre and
  height preserved across the morph (snapshot and restore; asserted by test).
- **Layer chips** Albedo (paper) / Colour relief — swaps `imageryLayers`.
- **Search** — hand-rolled subsequence matcher over `features.json` (no new
  dependency). Enter → `camera.flyTo` with height `max(20 km, 4 × diameter)`.
- **Feature card** on click/hover — name, English gloss from `origin`, type and
  descriptor code, diameter km, planetocentric lat/lon in signed decimal and
  °/′, `quad_code` (LAC-xx), approval date, link to the gazetteer feature page.
- **Scale readout** — metres/pixel and a km bar. Computed by projecting two
  nearby surface points through the live camera, so it is correct in both 2D and
  3D and includes the `cos(lat)` along-parallel factor. No analytic guesswork.
- **URL state** `#lon/lat/height/mode/layer` for shareable views (also used by
  the browser verification).
- Keyboard: arrows pan, `+/-` zoom, `1`/`2` modes, `/` search, `Esc` close.
- Attribution, always visible in small type plus an info popover:
  NASA/GSFC/Arizona State University (LROC WAC mosaic); NASA's Scientific
  Visualization Studio (CGI Moon Kit); USGS Astrogeology Science Center; IAU
  Gazetteer of Planetary Nomenclature.

### 4.4 Failure modes

| Condition | Behaviour |
|---|---|
| Tiles not yet baked | `NoAssets` screen with the exact `npm run bake` command |
| Startup tile probe fails (3 tiles: L0, top-level corner, antimeridian) | Banner naming which asset is missing |
| `manifest.json` absent | Same as unbaked; also surfaces the expected grid |
| `features.json` absent | Map works; search and labels disabled with a note |
| WebGL2 unavailable | Panel with the actual error, no blank canvas |
| Cesium worker/asset 404 | Detect the pattern, print the `CESIUM_BASE_URL` fix |
| Individual tile 404 at runtime | Cesium shows parent level; counted and logged, surfaced in a dev overlay |
| Source grid mismatch in Stage 0 | Bake aborts with expected-vs-actual printed; nothing written |
| Download size/hash mismatch | Re-fetch; `--force` required to overwrite |

### 4.5 Performance budget

Local static file serving, so these are tight: L0 globe visibly painted < 3 s
after `npm run dev` first paint; median tile response < 150 ms; browser tab <
1.2 GB after 50 tile fetches; no more than 16 simultaneous tile requests,
enforced through Cesium's `maximumScreenSpaceErrors` / imagery request
scheduling rather than by hoping the browser queues politely. Frame rate during
drag-rotate is reported, not asserted, since it is GPU-dependent.

## 5. Verification

### 5.1 Geometry proof (falsifiable, no external truth needed)

The gazetteer rows carry both a centre and a bbox, and the imagery carries
albedo. So:

1. Every curated feature's centre lies inside its own bbox (9,087-record check).
2. **Median contrast, not per-feature thresholds.** The median paper-layer albedo
   of ≥15 mare centroids must be lower than the median of ≥15 ray/highland
   craters by at least 25 DN, and the mare median must sit below the global mean
   while the highland median sits above it. The histogram is computed once over
   the paper layer's **L5 tiles** (2,048 tiles, whole globe at 333 m/px) and
   written to `manifest.json`, so the mean is measured, not hand-picked. Per
   marker values are printed for diagnosis but are not individually gating,
   because basalt-flooded craters (Plato, Grimaldi, Wargentin) are legitimately
   dark and a gate on each of them would be noise. Which markers go in the two
   lists is decided by *presence in the gazetteer* — a fact — never by their
   measured albedo, which is the thing under test.
3. The four `LF` traverse features whose `origin` names the Apollo 11 site (West,
   Little West, Double, Mount Marilyn) fall inside the Tranquillitatis bbox and
   on dark pixels.
4. A vertical flip, a ±180° longitude error, or misplaced labels break checks 2
   and 3 — a flip inverts the sign of the contrast, a 180° shift puts the maria
   on highlands. This is the test that protects the thing you asked not to break.
   A half-pixel offset does *not* break it (100 m of a 333 m sample moves one
   third of a pixel), and is instead pinned by the corner-origin tests in Task 3.

### 5.2 Unit tests (vitest, node)

`grid.ts` lat/lon ↔ (L, x, y) round-trip; antimeridian, poles, negative
longitude; row 0 = north; `cols = 2^(L+1)`/`rows = 2^L` consistency; m/px
table matches §3. `labels.ts` curation counts (mare == 22, etc.), tier
assignment, 0–360 → ±180 wrap. `declutter.ts` overlap resolution.

### 5.3 Pipeline integration (pytest)

Composite on synthetic numpy arrays: hue preserved, `k = 0` returns the base
exactly, flat detail returns the base, no NaN, clamp respected, periodic-in-x vs
clamp-in-y padding. Synthetic 1024 × 512 GeoTIFF with a known gradient → bake 2
levels → assert exact tile pixel values and the 2×2 averaging identity; assert
tile file counts and manifest contents; resumability (second run writes 0 tiles).

### 5.4 Browser verification (actually run, reported honestly)

Dev server driven through Chrome via the browser connector: globe at L0, flat at
L0, flat at L5, Tier B if baked; mode toggle preserves the camera; click Sea of
Tranquility; search `Tycho`; screenshot the antimeridian strip for a seam;
screenshot the pole for a wrap artefact; console checked for tile 404s; first
paint and per-tile latency recorded. Anything not verifiable is stated as not
verified rather than assumed.

## 6. Non-goals for v1

DEM/hypsometric/contour layer (D2 chose two layers); terrain relief and vertical
exaggeration; illumination or time-of-day slider; per-site sub-metre zoom (only
Apollo 17 has an official 0.5 m/px orthomosaic — v2 candidate); public
deployment; mobile layout; measurement/drawing tools beyond the scale bar;
multi-planet support even though the pipeline would generalise. True
**landing-site markers** (Apollo/Surveyor/Luna/Chang'e touchdown coordinates) are
also out of scope: the IAU gazetteer contains no such records (§4.1), so they need
a separate authoritative source in v2.

## 7. Stated limitations

- 167 m/px (Tier A) resolves crater floors of roughly ≥1 km and major rilles.
  Tier B (83 m/px) is a 1.2× upsample of a 100 m/px mosaic: as sharp as the
  source allows, no sharper. Nothing human-made is visible at any public global
  resolution.
- Colour is a chromaticity transfer from a 76 px/deg base. Hue is smooth and
  plausible, not spectrally calibrated. It is a map, not a science product.
  Real 118 m/px colour exists (GLD100) but reintroduces the ±79° seam.
- There is no live public Moon tile service (verified: legacy USGS WMS dead,
  `map.lunarmap.org` no DNS, LROC Quick Map HTML-only with timestamped
  non-reusable tokens, Zoomify 404, ArcGIS MoonBMap 404, NASA GIBS is
  Earth-only). Self-baking is the only path, which is why §3 exists.
- Kaguya's nominal 4096 px/deg global ortho-mosaic is a 195 TB listing, not a
  fetchable product. No 45 m/px global mosaic exists.
- Total download **3.04 GB** (2.500 + 0.518 + 0.024 GB), plus `work/` staging
  roughly equal to the sources. If the JP2 driver is unavailable the detail
  fallback is 5.96 GB instead of 2.50 GB, so budget up to **6.5 GB** of download.
  Plus 1.0–1.8 GB of Tier A tiles, or ~6–8 GB total with Tier B. A several-hour
  Tier B build on a laptop.

## 8. Layout

```
package.json  next.config.mjs  tsconfig.json  vitest.config.ts  .gitignore  README.md
scripts/{fetch_data.py,bake.py,labels.py,postinstall_cesium.mjs}
data/raw/            git-ignored: 3 sources + sha256
work/                git-ignored: GDAL tiled copies + overviews
public/tiles/{paper,photo}/<L>/<x>/<y>.jpg
public/tiles/manifest.json          committed
public/data/features.json           committed (~a few hundred KB)
src/app/{layout.tsx,page.tsx,globals.css}
src/components/{MoonMap,ModeToggle,LayerChips,SearchBox,FeatureCard,ScaleReadout,Attribution,NoAssets}.tsx
src/lib/{grid.ts,cesium/{viewer,imagery,camera,morph}.ts,labels/{tiers,entities,declutter}.ts,search.ts}
src/test/*.test.ts   scripts/tests/test_*.py
docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md
```

The working directory is not a git repository yet (`create-next-app`
initialises one). `manifest.json` is committed; all binary assets are ignored.
