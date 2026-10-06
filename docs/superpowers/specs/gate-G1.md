# Gate G1 — Cesium boot + geodetic `y` origin

**Task:** 2 of 18 (`task-2-brief.md`)
**Run by:** the Task 2 implementation agent, 2026-10-06
**Verdict: G1 PASSES all four criteria.** Criteria 3 and 4 are proven twice (headless Node
and a live browser page). Criteria 1 and 2 are proven with real rendered pixels plus a
numeric camera/projection cross-check that makes the reading of those pixels
camera-independent. No criterion is left unverified.

| # | Criterion | Result | How it was proven |
|---|---|---|---|
| 1 | A sphere painted with imagery (not a black globe, no ion 401) | **PASS** | Live Chromium page: `canvas` sized to the viewport, `globe.tilesLoaded === true`, imagery bands visible in screenshots, console contains no errors/warnings at all, and every request the browser reported is same-origin |
| 2 | Black above the red stripe, white below it, stripe on the visible equator | **PASS** | `work/g1/gate-G1-sphere.png` (L0 render: black cap, red stripe, white — stripe on the equator) and `work/g1/gate-G1-sphere-fullframe.png` (L1 render: the 6-band pattern). Screen-up is geographic north for that camera, proven numerically (below) |
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

## Step 2 — asymmetric probe tiles: PASS

`.venv/Scripts/python.exe scripts/gen_probe_tiles.py` → exit 0, verbatim:

```
wrote 10 probe tiles to public\tiles\probe
```

2 tiles at L0 (`0/0/0.jpg`, `0/1/0.jpg`) and 8 at L1 (`1/{0..3}/{0,1}.jpg`).

Pixel spot-check of `public/tiles/probe/1/0/0.jpg` with PIL (row 0 = top of the image):

```
size (512, 512)
row 0   (0, 0, 0)       # northern half of the tile is BLACK
row 200 (0, 0, 0)
row 252 (49, 0, 0)      # red stripe (JPEG ringing around the 4-row band)
row 255 (205, 37, 36)
row 256 (171, 51, 52)
row 300 (255, 255, 255)
row 511 (255, 255, 255) # southern half is WHITE
```

Served over HTTP: `GET /tiles/probe/0/0/0.jpg → 200, 4035 bytes, image/jpeg`.

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
3. **`scripts/g1_tiling_probe.mjs`** is an extra file the brief does not list: the throwaway
   headless proof for criteria 3/4. It is **intentionally left untracked** — delete or
   commit it as you prefer. Re-run with `node scripts/g1_tiling_probe.mjs`.

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

**Screenshots** — real renders of `http://localhost:3001/`, saved to a gitignored
directory, so they are local evidence rather than committed artifacts:

- `work/g1/gate-G1-sphere.png` (and the identical earlier `work/g1/external-tab.png`) —
  pre-canvas-fix: the whole globe drawn at 300×150 in the top-left corner, but already
  **black above the red stripe, white below it, one red stripe on the visible equator**.
  Only the L0 tile is legible at that size, which is precisely the picture criterion 2
  asks for.
- `work/g1/gate-G1-sphere-fullframe.png` — after the fix: the globe fills the frame and
  **L1** tiles are used, which is the stronger picture.

Why the L1 picture can only mean row 0 = north: each probe tile is black in its own
northern half and white in its own southern half, so if Cesium places row 0 in the north
the globe must read

| band (top → bottom) | latitude | colour | source |
|---|---|---|---|
| 1 | 90 → 45 N | black | row 0, northern half |
| 2 | 45 N | red stripe | row 0's own mid-line |
| 3 | 45 N → 0 | white | row 0, southern half |
| 4 | 0 → 45 S | black | row 1, northern half |
| 5 | 45 S | red stripe | row 1's own mid-line |
| 6 | 45 S → 90 S | white | row 1, southern half |

That is exactly the order in the screenshot. TMS order would mirror it — a **white** polar
cap at the top. Note the two stripes sit at ±45°, not on the equator, **by construction of
the L1 probe tiles**; the "single red stripe on the visible equator" reading belongs to the
L0 render. Both are recorded separately instead of being blended into one claim.

**No ion traffic / no 401.** The page's only console message is React's DevTools info
banner — zero errors, zero warnings. Every request the browser reported
(`performance.getEntriesByType('resource')`, filtered) is same-origin:
`offsiteRequests: []`, `ionRequests: 0`. An explicit `baseLayer` is passed, so Cesium never
resolves the ion default imagery. The Cesium ion logo in the credit bar is a self-hosted
static image. The tile fetch itself is proven independently of the request list, in-page:

```json
{"plainCreateImageBitmap":{"top":[0,0,0,255],"mid":[171,51,52,255],"bottom":[255,255,255,255]},
 "htmlImageElement":     {"top":[0,0,0,255],"mid":[171,51,52,255],"bottom":[255,255,255,255]},
 "cesiumRequestImage":   {"top":[255,255,255,255],"mid":[205,37,36,255],"bottom":[0,0,0,255]}}
```

i.e. `fetch('/tiles/probe/0/0/0.jpg')` → blob → decode gives black-top/white-bottom,
matching the file and PIL exactly.

### ⚠ Trap found for later tasks: `provider.requestImage()` returns a Y-FLIPPED bitmap

The last line of the block above is not a mistake. Cesium's
`UrlTemplateImageryProvider.requestImage()` hands back an `ImageBitmap` whose top row is
the **file's bottom row**, while a plain browser decode of the same bytes does not flip.
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
- Harness note: the in-app tab's camera **drifted** during a long inspection session
  (observed at `lat -82°, lon -153°, h 1.98e6 m` after several tool calls). Nothing in the
  app moves the camera; treat stale camera readings in a hidden tab as suspect and
  re-measure on a fresh load.

## How to reproduce / re-verify

```bash
npm run postinstall                                   # self-host Cesium assets
.venv/Scripts/python.exe scripts/gen_probe_tiles.py   # 10 probe tiles
node scripts/g1_tiling_probe.mjs                      # criteria 3 + 4, headless
npm run dev                                           # then open the printed URL
```

**Port caveat:** port 3000 is already held by an unrelated process on this machine
(PID 28812, not started by this task and deliberately left alone), so `next dev` falls back
to **http://localhost:3001**. A dev server is still running in the background from this
session (log: `/tmp/next-dev.log`). To close the one-page visual gap yourself, open 3001 in
a *visible* browser window, wait for the globe, and run the brief's Step 5 snippet with the
two accessor names swapped as documented above.

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
