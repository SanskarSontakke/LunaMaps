# Gate G1 — Cesium boot + geodetic `y` origin

**Task:** 2 of 18 (`task-2-brief.md`)
**Run by:** the Task 2 implementation agent, 2026-10-06; re-verified in the Task 2 review
fix round the same day (fixture rebuilt, render re-measured, `scripts/g1_tiling_probe.mjs`
committed).
**Verdict: G1 PASSES all four criteria.** Criteria 3 and 4 are proven twice (headless Node
and a live browser page). Criteria 1 and 2 are proven with real rendered pixels plus a
numeric camera/projection cross-check that makes the reading of those pixels
camera-independent. No criterion is left unverified.

**What each piece of evidence proves — and what it does not** (corrected in the Task 2
review round; the first revision of this file credited the screenshot with more than the
fixture could support):

- The render proves **texture orientation** (a JPEG's top row lands at the tile's northern
  edge) and **screen-up = geographic north** for the default camera.
- It also proves the **row order** — but only because the fixture was rebuilt in the fix
  round so that every tile's picture is a function of its own `(L, x, y)` (see "Step 2" and
  "What the render proves — and what the original fixture could not"). The *original*
  fixture wrote the same in-tile split for every x/y, so all 10 JPEGs were byte-identical
  and the render was **y-order invariant**: swapping which row index is north produced
  exactly the same picture.
- The y-index convention itself rests on **criterion 3 alone**
  (`tileXYToRectangle(0, 0, 1).north === 90`), which is a direct read of the tiling scheme
  and does not depend on any image. The rebuilt fixture corroborates it visually; criterion
  3 remains the load-bearing proof.

| # | Criterion | Result | How it was proven |
|---|---|---|---|
| 1 | A sphere painted with imagery (not a black globe, no ion 401) | **PASS** | Live Chromium page: `canvas` sized to the viewport, `globe.tilesLoaded === true`, imagery bands visible in screenshots, console contains no errors/warnings at all, and every request the browser reported is same-origin |
| 2 | Black above the red stripe, white below it, stripe on the visible equator | **PASS** | `work/g1/gate-G1-sphere.png` (L0 render: black cap, red stripe, white — stripe on the equator) and `work/g1/fix-g1-sphere-l1-v2.png` (L1 render with the rebuilt fixture: black/white/red per tile **plus** 1 grey band north of the equator and 2 south of it, i.e. row 0 above row 1). Screen-up is geographic north for that camera, proven numerically (below) |
| 3 | `tileYToLatitude(0,1) === +90°`, `tileYToLatitude(1,1) === 0°` | **PASS** — via the public API, because the brief's method names do not exist in Cesium 1.146 (see "API drift") | Headless `node scripts/g1_tiling_probe.mjs` **and** in-page `tileXYToRectangle` |
| 4 | `levelMaximumTileCount(1) === [4, 2]` | **PASS** — via the public API, same caveat | Headless probe **and** in-page `getNumberOfXTilesAtLevel(1)` / `getNumberOfYTilesAtLevel(1)` → `[4, 2]` |

**Consequence, stated once because everything downstream depends on it: Cesium wants
plain `y = 0 = north`, not TMS order. `makeProvider` needs no `{reverseY}` and the bake
must not be given `--y-flip`.**

---

## Environment

- Node `v24.19.0`, `cesium@1.146.0` (in-page `Cesium.VERSION` printed `1.146.0`),
  `next@15.5.27`, `vitest@4.1.11`.
- Python: `.venv/Scripts/python.exe` (rasterio / numpy / pillow / pyshp / pytest from Task 1).
- Branch `feat/lunar-map-explorer`.

## Step 1 — Cesium static-asset copier: PASS

`npm run postinstall`, verbatim:

```
> 1561f05e@0.1.0 postinstall
> node scripts/postinstall_cesium.mjs

copied Workers
copied Widgets
copied Assets
copied ThirdParty
```

Exit 0. `public/cesium/Workers/` holds 63 entries (e.g. `chunk-6FYG4X2F.js`).
`public/cesium/` is gitignored, so this is a per-checkout step, not a committed artifact.

The self-hosted base URL is live: the page fetched
`GET /cesium/Assets/approximateTerrainHeights.json → 200` (seen in the browser's request
list as `.../cesium/Assets/approximateTerrainHeights.json [200] xhr`) and
`globalThis.CESIUM_BASE_URL === '/cesium'`.

## Step 2 — asymmetric probe tiles: PASS (fixture rebuilt in the review round)

`.venv/Scripts/python.exe scripts/gen_probe_tiles.py` → exit 0, verbatim:

```
wrote 10 probe tiles to public\tiles\probe
```

2 tiles at L0 (`0/0/0.jpg`, `0/1/0.jpg`) and 8 at L1 (`1/{0..3}/{0,1}.jpg`).

**What the fixture encodes.** Every tile keeps the asymmetric half-split — northern half
BLACK, southern half WHITE, a 4-row red stripe on the tile's own mid-line — and additionally
draws, per tile identity `(L, x, y)`:

- `y + 1` horizontal light-grey bands in the white half (row 0 → 1 band, row 1 → 2 bands);
- `x` vertical dark bars in the black half (column 0 → none, column 3 → three);
- a level-dependent tone/thickness (`+18` grey and `+6 px` per level) so no two
  `(L, x, y)` triples collide.

The grey bands are packed into the **upper 45 %** of the white half — the side facing the
tile's own equator — on purpose. Spread over the whole half (the first attempt,
`work/g1/fix-g1-sphere-l1.png`), the southern row's second band fell at ~76° S, where the
whole-globe projection crushes it to a single antialiased pixel and it stops being readable.

**Why the rebuild was necessary.** The first revision of this script called
`half_split_tile()` with no arguments for every tile, so all 10 JPEGs were byte-identical
(md5 `7841518cedef0f589614ac7d765fa4f4` for every one of them). A fixture that is invariant
under `y` cannot discriminate `y`: swapping which row index is north rendered the identical
picture. That is fixed: `find public/tiles/probe -name '*.jpg' -exec md5sum {} \; | awk
'{print $1}' | sort -u | wc -l` → **10**.

PIL audit of all 10 regenerated tiles (centre-column grey-band count, centre-row dark-bar
count, `x` = column, `y` = row):

```
0/0/0  north(0,0)=0    south_end=255  grey_bands=1 (expect y+1=1) [(310, 324)]  dark_bars=0 (expect x=0) []
0/1/0  north(0,0)=68   south_end=255  grey_bands=1 (expect y+1=1) [(310, 324)]  dark_bars=1 (expect x=1) [(243, 269)]
1/0/0  north(0,0)=0    south_end=255  grey_bands=1 (expect y+1=1) [(307, 327)]  dark_bars=0 (expect x=0) []
1/0/1  north(0,0)=0    south_end=255  grey_bands=2 (expect y+1=2) [(279, 299), (334, 354)]  dark_bars=0 (expect x=0) []
1/1/0  north(0,0)=86   south_end=255  grey_bands=1 (expect y+1=1) [(307, 327)]  dark_bars=1 (expect x=1) [(240, 272)]
1/1/1  north(0,0)=86   south_end=255  grey_bands=2 (expect y+1=2) [(279, 299), (334, 354)]  dark_bars=1 (expect x=1) [(240, 272)]
1/2/0  north(0,0)=0    south_end=255  grey_bands=1 (expect y+1=1) [(307, 327)]  dark_bars=2 (expect x=2) [(112, 144), (368, 400)]
1/2/1  north(0,0)=0    south_end=255  grey_bands=2 (expect y+1=2) [(279, 299), (334, 354)]  dark_bars=2 (expect x=2) [(112, 144), (368, 400)]
1/3/0  north(0,0)=86   south_end=255  grey_bands=1 (expect y+1=1) [(307, 327)]  dark_bars=3 (expect x=3) [(69, 101), (240, 272), (410, 442)]
1/3/1  north(0,0)=86   south_end=255  grey_bands=2 (expect y+1=2) [(279, 299), (334, 354)]  dark_bars=3 (expect x=3) [(69, 101), (240, 272), (410, 442)]
```

`north(0,0)` is `0` (pure black) or the bar tone where the sample column happens to cross a
bar; `south_end=255` is white in every tile, and the red stripe stays at rows 253-256.

Served over HTTP: `GET /tiles/probe/1/0/1.jpg → 200, image/jpeg`, and the served bytes equal
the file on disk (`curl … | md5sum` = `9ba3783eaaa610cfd9ae460758214cff` = local md5).

## Step 3 / 4 — viewer factory, component, page, CSS: created

`src/types.ts`, `src/lib/cesium/moon.ts`, `src/components/MoonMap.tsx`,
`src/app/page.tsx`, `src/app/globals.css`. Every name the brief promises exists with the
same signature: `MOON_RADIUS_M`, `MOON_ELLIPSOID`, `TILE_SIZE`, `CREDIT`, `LayerName`
(re-exported), `makeProvider`, `MoonViewerOptions`, `createMoonViewer`.
`npx tsc --noEmit` → exit 0.

### Bundling proof — this is the question the task exists to answer

Plain `npm run dev`. **No rung of the fallback ladder was needed:**

```
 ✓ Compiled / in 14.4s (3851 modules)
 GET / 200 in 14792ms
```

`npm run build` also passes, so Cesium survives the production pipeline too:

```
 ✓ Compiled successfully in 13.3s
┌ ○ /                    1.28 kB         104 kB
```

### Three deliberate deviations from the brief's code

The brief's snippets do not run as written against Cesium 1.146. Each fix is the smallest
one that keeps the brief's intent, and each is commented in place in the source.

1. **`moon.ts` — `scene.skyAtmosphere.show = false` threw `TypeError`** and blanked the
   page behind Next's "Application error: a client-side exception". In 1.146
   `Scene#skyAtmosphere`, `#sun`, `#moon` and `#skyBox` are typed `… | undefined` and are
   only created for the **default WGS84 ellipsoid**; with `MOON_ELLIPSOID`,
   `skyAtmosphere` is `undefined` (measured in-page) while `sun` is a real object. The
   three assignments are now guarded with `if (…)`. Intent unchanged — under a custom
   ellipsoid they are absent, i.e. already off.
   **Later tasks must never dereference `scene.skyAtmosphere` unguarded.**
2. **`globals.css` — the canvas never grew past the HTML default 300×150.** Widgets.css is
   not imported (the brief never imports it), so nothing stretched the div chain Cesium
   builds (`.cesium-viewer > .cesium-viewer-cesiumWidgetContainer > .cesium-widget >
   canvas`). Measured before the fix: `canvas=300x150` inside `host=831x786`, so the globe
   drew as a 150 px ball in the top-left corner. `.map-host`'s subtree now carries
   `width/height: 100%` plus `overflow: hidden`. After: `canvas=831x786`, `host=831x786`.
   **This is the geometry every later hit-test, label-placement and screenshot task
   depends on, so it had to be fixed here rather than inherited.**
3. **`scripts/g1_tiling_probe.mjs`** is an extra file the brief does not list: the headless
   proof for criteria 3/4. It is **committed as a diagnostic, not a test** — the first
   revision left it untracked on purpose, which made criteria 3/4 unreproducible from a
   fresh clone and risked a later `git add -A` sweeping it into an unrelated commit.
   Re-run with `node scripts/g1_tiling_probe.mjs`.

## Step 5 — the gate evidence

### API drift: the brief's two method names do not exist in Cesium 1.146

`ts.tileYToLatitude(...)` and `ts.levelMaximumTileCount(...)` are **not** public API in
1.146. Both are `undefined` on the instance, in the browser and in Node:

```
tileYToLatitude=undefined | levelMaximumTileCount=undefined
THROWS: ts.tileYToLatitude is not a function
THROWS: ts.levelMaximumTileCount is not a function
```

They are absent from `node_modules/cesium/Source/Cesium.d.ts` and from the built bundle.
`GeographicTilingScheme`'s public surface is `tileXYToRectangle(x, y, level)`,
`getNumberOfXTilesAtLevel(level)`, `getNumberOfYTilesAtLevel(level)`, `positionToTileXY`,
`rectangle`, `ellipsoid`. **The claims are identical; only the accessors differ**, so what
was evaluated is `tileXYToRectangle(0, y, 1).north` for `tileYToLatitude(y, 1)` and
`[getNumberOfXTilesAtLevel(1), getNumberOfYTilesAtLevel(1)]` for
`levelMaximumTileCount(1)`. **Task 3's grid-contract tests must use the public names.**

### Criteria 3 + 4, headless, no DOM — PASS

`node scripts/g1_tiling_probe.mjs`, verbatim:

```
Cesium.VERSION 1.146.0
tilingScheme ctor      : GeographicTilingScheme
tileYToLatitude exists : undefined
levelMaximumTileCount  : undefined

L1 rowCount            : 2
L1 colCount            : 4
L0 col x row           : 2 x 1
L1 row 0 north deg     : 90 <= brief criterion 3 (row 0 = +90 = NORTH)
L1 row 0 south deg     : 0
L1 row 1 north deg     : 0 <= brief criterion 3 second half (row 1 = 0)
L1 row 1 south deg     : -90
L0 row 0 north/south   : 90 / -90

rectangle (deg)          : -180, -90, 180, 90
ellipsoid radii        : 1737400 1737400 1737400
```

Importing `cesium` in bare Node **works** (`await import('cesium')` resolves and the
tiling math runs); only `new Cesium.Viewer(...)` needs a DOM, so the Viewer-dependent
parts went through a browser. No headless-gl setup was used or needed.

### Criteria 3 + 4 again, in the live page — PASS

```
maxLevel=1 | tileW=512 | url=/tiles/probe/{z}/{x}/{y}.jpg | radii=1737400 | skyAtm=undefined
row0north=90 | row0south=0 | row1north=0 | row1south=-90
L0=2,1 | L1=4,2 | L2=8,4
```

`L1=4,2` is criterion 4 verbatim; `L2=8,4` confirms `cols = 2^(L+1)`, `rows = 2^L` one
level beyond the probe fixture.

### Criteria 1 + 2, in the live page — PASS

Fresh load of the app, measured atomically so camera and projections agree:

```json
{"canvas":[831,786],"cam":{"latDeg":0,"lonDeg":0,"heightM":3479936},
 "headingDeg":360,"pitchDeg":-90,"rollDeg":0,
 "pole90":[416,153],"lat45N":[416,171],"equator":[416,393],"lat45S":[416,615],"poleS":[416,633],
 "tilesLoaded":true,"mode":3}
```

- `mode=3` is `SceneMode.SCENE3D`; `heightM=3479936` = 2 × Moon radius, Cesium's default
  globe view; `tilesLoaded=true` means the probe JPEGs really decoded and uploaded.
- `heading 0 (360) / pitch -90 / roll 0` at `lat 0, lon 0` is a straight-down, north-up,
  unrotated view. Projecting (0°E, φ) onto the canvas confirms it numerically: **+90° lands
  at screen y=153 (top of the disk), 0° at y=393 (the exact vertical centre of the 786 px
  canvas), −90° at y=633 (bottom)**. So in a fresh-load screenshot the top of the disk *is*
  geographic north, and the band boundaries fall at y=171 (45 N) and y=615 (45 S).

**Screenshots** — real renders of the dev server, saved to a gitignored directory, so they
are local evidence rather than committed artifacts:

- `work/g1/gate-G1-sphere.png` (and the identical earlier `work/g1/external-tab.png`) —
  pre-canvas-fix, **original fixture**: the whole globe drawn at 300×150 in the top-left
  corner, but already **black above the red stripe, white below it, one red stripe on the
  visible equator**. Only the L0 tile is legible at that size, which is precisely the
  picture criterion 2 asks for.
- `work/g1/gate-G1-sphere-fullframe.png` — after the canvas fix, **original fixture**: the
  globe fills the frame and **L1** tiles are used.
- `work/g1/fix-g1-sphere-l1-v2.png` — **rebuilt fixture**, re-rendered in the review round
  on a fresh load of `http://localhost:3100/`. This is the only screenshot that can
  discriminate row order, and it is the one to trust for that claim.
- `work/g1/fix-g1-sphere-l1.png` — an intermediate rebuild that spread the grey bands over
  the whole white half; kept because it shows the failure mode (the southern row's second
  band crushed at the limb, only one band readable). Superseded by `-v2`.

Measured off the centre line of `fix-g1-sphere-l1-v2.png` (x=959 of a 1920 px image, top →
bottom, PIL):

```
BLACK y    0..170   page background + the northern black cap
RED   y  172..174   45 N stripe = row 0's own mid-line
WHITE y  175..447   contains exactly ONE grey band, y 215..233 (193,193,193)
BLACK y  449..719   0..45 S, tile black (0,0,0)
RED   y  721..723   45 S stripe = row 1's own mid-line
WHITE y  724..787   contains exactly TWO grey bands, y 738..749 and y 766..772
```

The equator (white → black boundary) falls at y=448 and the disk spans y≈87..809, so the
equator sits at the disk's vertical centre — the same geometry the projection numbers above
predict.

### What the render proves — and what the original fixture could not

Every probe tile is black in its own northern half and white in its own southern half, so if
Cesium places row 0 in the north the globe must read

| band (top → bottom) | latitude | colour | source |
|---|---|---|---|
| 1 | 90 → 45 N | black | row 0, northern half |
| 2 | 45 N | red stripe | row 0's own mid-line |
| 3 | 45 N → 0 | white, **1 grey band** | row 0, southern half (`y + 1` = 1) |
| 4 | 0 → 45 S | black | row 1, northern half |
| 5 | 45 S | red stripe | row 1's own mid-line |
| 6 | 45 S → 90 S | white, **2 grey bands** | row 1, southern half (`y + 1` = 2) |

That is the order measured above, and that is the full extent of what the picture proves:
**texture orientation** (the file's top row lands at the tile's northern edge), **screen-up =
geographic north** for this camera, and — only after the fixture was rebuilt — **row order**:
1 band north of the equator and 2 south. TMS order would mirror it (2 bands north, 1 south)
and put a **white** polar cap at the top.

**The correction this review round forced.** The first version of this section claimed the
6-band pattern "can only mean row 0 = north". That was false as written: the tiles then on
disk were all byte-identical (md5 `7841518cedef0f589614ac7d765fa4f4`, ×10), because the
generator called `half_split_tile()` with no arguments for every `x`/`y`. **The L0/L1 fixture
was y-order-invariant, so it could not discriminate row order at all** — swapping which row
index is north rendered the identical picture. What that screenshot did prove is texture
orientation and screen-up = north; the y-index convention rested, and still formally rests,
solely on criterion 3's `tileXYToRectangle(0, 0, 1).north === 90`. The `(L, x, y)`-dependent
band/bar encoding was added so the fixture can discriminate, and the render above is the
re-verification.

**Consequence for later tasks — this is why the overstatement mattered:** the browser is not
the detector for a per-row `y` error in the real bake. Such an error reorders rows that look
locally plausible either way, so no screenshot of the paper or photo layer will flag it the
way a black/white split flags a whole-globe flip. It is caught by **Task 9's albedo proof**
— mare reads dark, highland reads bright, and the Apollo 11 traverse features land inside the
Mare Tranquillitatis bbox — not by eyeballing a rendered globe. Do not cite this screenshot
as evidence that a per-row bake error is browser-detectable.

Note the two stripes sit at ±45°, not on the equator, **by construction of the L1 probe
tiles**; the "single red stripe on the visible equator" reading belongs to the L0 render.
Both are recorded separately instead of being blended into one claim.

**No ion traffic / no 401.** The page's only console message is React's DevTools info
banner — zero errors, zero warnings. Every request the browser reported
(`performance.getEntriesByType('resource')`, filtered) is same-origin:
`offsiteRequests: []`, `ionRequests: 0`. An explicit `baseLayer` is passed, so Cesium never
resolves the ion default imagery. The Cesium ion logo in the credit bar is a self-hosted
static image. The tile fetch itself is proven independently of the request list, in-page —
re-run against the **rebuilt** fixture in the review round (`fetch` → blob →
`createImageBitmap` → `OffscreenCanvas`, over HTTP from the dev server):

```json
{"/tiles/probe/0/0/0.jpg": {"bytes":5301,"top":[0,0,0],"stripe":[171,51,52],"bottom":[255,255,255],"greyBandsSouth":1,"bandRuns":[[310,324]]},
 "/tiles/probe/1/0/0.jpg": {"bytes":4748,"top":[0,0,0],"stripe":[171,51,52],"bottom":[255,255,255],"greyBandsSouth":1,"bandRuns":[[307,327]]},
 "/tiles/probe/1/0/1.jpg": {"bytes":6479,"top":[0,0,0],"stripe":[171,51,52],"bottom":[255,255,255],"greyBandsSouth":2,"bandRuns":[[279,299],[334,354]]},
 "/tiles/probe/1/2/1.jpg": {"bytes":7336,"top":[0,0,0],"stripe":[171,51,52],"bottom":[255,255,255],"greyBandsSouth":2,"bandRuns":[[279,299],[334,354]]},
 "/tiles/probe/1/3/0.jpg": {"bytes":6832,"top":[86,86,86],"stripe":[171,51,52],"bottom":[255,255,255],"greyBandsSouth":1,"bandRuns":[[307,327]]}}
```

Every tile decodes black-top / red-mid / white-bottom, the differing `bytes` and band counts
match the PIL audit exactly, and `1/3/0`'s `[86,86,86]` sample is the column-3 bar tone. The
re-check on the rebuilt fixture also re-confirmed the flip trap below verbatim.

### ⚠ Trap found for later tasks: `provider.requestImage()` returns a Y-FLIPPED bitmap

Cesium's `UrlTemplateImageryProvider.requestImage()` hands back an `ImageBitmap` whose top
row is the **file's bottom row**, while a plain browser decode of the same bytes does not
flip. Re-measured in the review round against the **rebuilt** fixture, same page, same
tile, side by side:

```json
{"cesiumRequestImage":     {"top":[255,255,255,255],"mid":[205,37,36,255],"bottom":[0,0,0,255]},
 "plainCreateImageBitmap": {"top":[0,0,0,255],"mid":[171,51,52,255],"bottom":[255,255,255,255]}}
```

The composition still renders correctly (the globe's texture mapping flips once more, so
the file's top row lands at the tile's northern edge, as the screenshots show), but **any
debug harness or test that samples `requestImage()` and compares it to the file on disk
will read the opposite answer.** Compare rendered output or use a plain `fetch` +
`createImageBitmap`, never `requestImage`, when checking tile orientation.

## What could not be done, and why (no gaps left to inference)

- The screenshots come from the connector's **external Chrome** tab, and the
  camera/projection numbers from the **in-app** tab. Both are fresh loads of the same URL
  and build with the same default camera, and the band order is camera-independent once
  screen-up is north — but they are two pages, not one.
- They could not be merged into one annotated image: the external connector's
  `evaluate_script` is a **no-op in this environment** (it returns `{}` and does not
  execute — an injected overlay never appeared in the screenshot), and the in-app tab
  cannot be screenshotted (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE … visibilityState=hidden`)
  nor its pixels read (`canvas.toDataURL()` returns a uniform `#05060a` because
  `preserveDrawingBuffer` is false and `requestAnimationFrame` never fires in a hidden
  tab).
- **Re-confirmed in the review round:** the same split still applies. The external tab
  renders and can be screenshotted but cannot be scripted (`evaluate_script` → `{}`); the
  in-app tab can be scripted but never becomes visible (its canvas reports `0x0`), so no
  single page yields both an image and live numbers. The review round's render evidence is
  therefore a real screenshot **measured pixel-by-pixel with PIL** (the centre-line table in
  "What the render proves"), which does not depend on anyone's reading of the image.
- **No camera control from the harness:** `PageUp` sent to the external tab left the page
  byte-for-byte identical (screenshot md5 unchanged), so the view cannot be zoomed or
  tilted from here. That is why the fixture, not the camera, had to be changed to make the
  row order readable: the bands are packed into the equator-facing part of each white half
  so they survive the polar foreshortening of the default whole-globe view.
- Harness note: the in-app tab's camera **drifted** during a long inspection session
  (observed at `lat -82°, lon -153°, h 1.98e6 m` after several tool calls). Nothing in the
  app moves the camera; treat stale camera readings in a hidden tab as suspect and
  re-measure on a fresh load.

## How to reproduce / re-verify

```bash
npm run postinstall                                   # self-host Cesium assets
.venv/Scripts/python.exe scripts/gen_probe_tiles.py   # 10 probe tiles, one picture per (L,x,y)
node scripts/g1_tiling_probe.mjs                      # criteria 3 + 4, headless (committed diagnostic)
npm run dev -- -p 3100                                # then open http://localhost:3100
```

`scripts/g1_tiling_probe.mjs` is tracked as of the review round, so a fresh clone can
reproduce criteria 3 and 4 without it. It is a **diagnostic, not a test**: it prints values
and exits 0; Task 3 turns the same claims into assertions.

Expected output of the generator and the probe: `wrote 10 probe tiles to public\tiles\probe`
(exit 0), and `L1 row 0 north deg : 90` / `L1 rowCount 2 / colCount 4`. To confirm the
fixture really does discriminate:

```bash
find public/tiles/probe -name '*.jpg' -exec md5sum {} \; | awk '{print $1}' | sort -u | wc -l   # → 10
```

**Port caveat:** port 3000 is already held by an unrelated process on this machine (not
started by this task and deliberately left alone), and the Task 2 session left a server on
3001, so the review round ran its own on **http://localhost:3100**. To re-do the visual
check yourself, open that URL in a *visible* browser window, wait for the globe, and confirm
one grey band above the equator and two below it; run the brief's Step 5 snippet with the two
accessor names swapped as documented above.

## Consequences for later tasks

1. No `{reverseY}` anywhere; the bake stays un-flipped. `y = 0` is north end to end.
2. Cesium 1.146 exposes **no** `tileYToLatitude` / `levelMaximumTileCount`. Use
   `tileXYToRectangle` / `getNumberOf{X,Y}TilesAtLevel` in Task 3's tests and everywhere else.
3. `scene.skyAtmosphere` / `sun` / `moon` / `skyBox` are `undefined` under a custom
   ellipsoid — never dereference them unguarded.
4. Never use `provider.requestImage()` to check tile orientation (see the flip trap).
5. Canvas sizing lives in `globals.css` because Widgets.css is not imported. Task 13
   (attribution) should decide whether to import Widgets.css for the credit-bar and compass
   chrome; today the credit renders as unstyled text at the top-left and the compass at the
   bottom-left. Cosmetic, and it does not affect G1.
6. `src/app/page.module.css` is now orphaned — `page.tsx` no longer imports it. Left in
   place because the brief does not authorise deleting it; safe to remove.
7. **A per-row `y` error in the real bake is not browser-detectable.** The G1 fixture is
   synthetic; nothing in a rendered lunar mosaic says "row 37 landed where row 12 belonged"
   to a harness that has no ground truth. That class of bug is caught by **Task 9's albedo
   proof** — mare reads dark, highland reads bright, and the Apollo 11 traverse features land
   inside the Mare Tranquillitatis bbox — so do not treat a screenshot of the paper or photo
   layer as evidence about row order.
8. Any future probe fixture must vary with its own tile identity, or it cannot prove an
   index convention. The G1 fixture now encodes `y + 1` bands and `x` bars for exactly this
   reason; keep that property if the fixture is regenerated for higher levels.
