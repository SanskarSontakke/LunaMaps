# Gate G1 — Cesium boot + geodetic `y` origin

**Task:** 2 of 18 (`task-2-brief.md`)
**Run by:** the Task 2 implementation agent, 2026-10-06
**Verdict: G1 PASSES all four criteria.** Criterion 3 and 4 are proven twice (headless
Node and a real browser page); criteria 1 and 2 are proven in a real browser with
screenshots plus a numeric screen-projection cross-check.

| # | Criterion | Result | How it was proven |
|---|---|---|---|
| 1 | A sphere painted with imagery (not a black globe, no ion 401) | **PASS** | Real Chromium page: `canvas` present, `globe.tilesLoaded === true`, 6-band imagery visible in the screenshot, zero console errors, zero network requests to any `ion.cesium.com` host |
| 2 | Black above the red stripe, white below it, stripe on the visible equator | **PASS** | Two screenshots (below) + north-pole / equator / south-pole projected to screen `y` 153 / 393 / 633, i.e. north is up and the band order matches row-0-north exactly |
| 3 | `tileYToLatitude(0,1) === +90°`, `tileYToLatitude(1,1) === 0°` | **PASS** (via public API — the brief's method names do not exist in Cesium 1.146, see "API drift") | Headless `node scripts/g1_tiling_probe.mjs` **and** in-page `tilingScheme.tileXYToRectangle(...)` |
| 4 | `levelMaximumTileCount(1) === [4, 2]` | **PASS** (via public API, same caveat) | Headless probe **and** in-page `getNumberOfXTilesAtLevel(1)`/`getNumberOfYTilesAtLevel(1)` → `[4, 2]` |

Because criterion 2 and 3 both pass, **Cesium wants plain `y = 0 = north`, not TMS order.
`makeProvider` needs no `{reverseY}` and the bake must not be given `--y-flip`.**

---

## Environment

- Node `v24.19.0`, npm package `cesium@1.146.0` (`Cesium.VERSION` printed `1.146.0`), `next@15.5.27`, `vitest@4.1.11`.
- Python: `.venv/Scripts/python.exe` (rasterio/numpy/pillow/pyshp/pytest from Task 1).
- Branch `feat/lunar-map-explorer`.

## Step 1 — Cesium static-asset copier: PASS

`npm run postinstall` (verbatim):

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
`GET /cesium/Assets/approximateTerrainHeights.json → 200` and
`globalThis.CESIUM_BASE_URL === '/cesium'`.

## Step 2 — asymmetric probe tiles: PASS

`.venv/Scripts/python.exe scripts/gen_probe_tiles.py` → exit 0, verbatim:

```
wrote 10 probe tiles to public\tiles\probe
```

2 tiles at L0 (`0/0/0.jpg`, `0/1/0.jpg`) and 8 at L1 (`1/{0..3}/{0,1}.jpg`).
Pixel spot-check of `public/tiles/probe/1/0/0.jpg` (image row 0 = top of image):

```
size (512, 512)
row 0   (0, 0, 0)      # north half of the tile is BLACK
row 200 (0, 0, 0)
row 252 (49, 0, 0)     # red stripe (JPEG ringing around the 4-row band)
row 255 (205, 37, 36)
row 256 (171, 51, 52)
row 300 (255, 255, 255)
row 511 (255, 255, 255) # south half is WHITE
```

Served over HTTP: `GET /tiles/probe/0/0/0.jpg → 200, 4035 bytes, image/jpeg`.

## Step 3 / 4 — viewer factory, component, page, CSS: created

`src/types.ts`, `src/lib/cesium/moon.ts`, `src/components/MoonMap.tsx`,
`src/app/page.tsx`, `src/app/globals.css`. All exported names the brief promises exist
with the same signatures: `MOON_RADIUS_M`, `MOON_ELLIPSOID`, `TILE_SIZE`, `CREDIT`,
`LayerName` (re-exported), `makeProvider`, `MoonViewerOptions`, `createMoonViewer`.
`npx tsc --noEmit` → exit 0.

### Bundling proof (the point of this task)

Plain `npm run dev` — **no ladder rung was needed**:

```
 ✓ Compiled / in 14.4s (3851 modules)
 GET / 200 in 14792ms
```

`npm run build && (production)` also passes, so Cesium survives both pipelines:

```
 ✓ Compiled successfully in 13.3s
┌ ○ /                    1.28 kB    104 kB
```

### Three deliberate deviations from the brief's code

The brief's snippets do not run as written against Cesium 1.146. Each fix is the
smallest one that keeps the brief's intent; all three are commented in place.

1. **`moon.ts` — `scene.skyAtmosphere.show = false` threw a `TypeError`** and blanked the
   page with Next's "Application error: a client-side exception". In 1.146
   `Scene#skyAtmosphere`, `#sun`, `#moon` and `#skyBox` are typed
   `… | undefined` and are only created for the **default WGS84 ellipsoid**; with
   `MOON_ELLIPSOID` they are `undefined` (measured in-page:
   `skyAtmosphere=undefined`, `sun=[object Object]`). They are now guarded with `if (…)`.
   Intent unchanged — with a custom ellipsoid they are absent, i.e. already off.
   **Later tasks must not assume `scene.skyAtmosphere` is non-null.**
2. **`globals.css` — the canvas never grew past the HTML default 300×150.** Widgets.css
   is not imported (the brief never imports it), so nothing stretched the div chain
   Cesium builds (`.cesium-viewer > .cesium-viewer-cesiumWidgetContainer >
   .cesium-widget > canvas`); measured before the fix: `canvas=300x150` inside
   `host=831x786`, so the globe rendered as a 150 px ball in the top-left corner.
   The `.map-host` subtree now carries `width/height: 100%` and `overflow: hidden`.
   After the fix: `canvasAttr=831x786 | css=831x786 | host=831x786`.
   **This is the shape every later hit-test, label-placement and screenshot task
   depends on, so it had to be fixed here rather than inherited.**
3. **`scripts/g1_tiling_probe.mjs`** is an extra file the brief does not list. It is the
   throwaway headless proof for criteria 3/4 and is **intentionally left untracked** —
   delete or commit it as you prefer. Re-run: `node scripts/g1_tiling_probe.mjs`.

## Step 5 — the gate evidence

### API drift: the brief's two method names do not exist in Cesium 1.146

`ts.tileYToLatitude(...)` and `ts.levelMaximumTileCount(...)` are **not** public API in
1.146. Both are `undefined` on the instance, in the browser and in Node:

```
tileYToLatitude=undefined | levelMaximumTileCount=undefined
THROWS: ts.tileYToLatitude is not a function
THROWS: ts.levelMaximumTileCount is not a function
```

They are also absent from `node_modules/cesium/Source/Cesium.d.ts` and from the built
bundle. `GeographicTilingScheme`'s public surface is
`tileXYToRectangle(x, y, level)`, `getNumberOfXTilesAtLevel(level)`,
`getNumberOfYTilesAtLevel(level)`, `positionToTileXY`, `rectangle`, `ellipsoid`.
**The claims are the same; only the accessors differ**, so the equivalents used here are
`tileXYToRectangle(0, y, 1).north` for `tileYToLatitude(y, 1)` and
`[getNumberOfXTilesAtLevel(1), getNumberOfYTilesAtLevel(1)]` for
`levelMaximumTileCount(1)`. Task 3's grid-contract tests must use the public names.

### Criterion 3 + 4, headless (no DOM needed) — PASS

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
parts had to go through a browser. No headless-gl setup was used or needed.

### Criteria 1–4, in a real browser — PASS

`globalThis.__moonViewer` was exposed by `MoonMap.tsx` as the brief intends and read back
from a live page (`mode=3` is `SceneMode.SCENE3D`):

```
canvasAttr=831x786 | css=831x786 | host=831x786 | win=831x786 | dpr=1 | mode=3 | tilesRendered=true
canvasAttr=831x786 | css=831x786 | host=831x786 | win=831x786 | mode=3
maxLevel=1 | tileW=512 | url=/tiles/probe/{z}/{x}/{y}.jpg | radii=1737400 | skyAtm=undefined
row0north=90 | row0south=0 | row1north=0 | row1south=-90
L0=2,1 | L1=4,2 | L2=8,4
credit: "Data provided by: NASA/GSFC/Arizona State University (LROC WAC mosaic) · NASA's
         Scientific Visualization Studio (CGI Moon Kit) · USGS Astrogeology …"
```

Criterion 4 as the brief spells it: `level1Counts === [4, 2]` ✔ (and L2 = 8×4 confirms
`cols = 2^(L+1)`, `rows = 2^L` beyond the probe levels).

**Screenshots** (both real renders of `http://localhost:3001/`; the directory is
gitignored, so these are local evidence, not committed artifacts):

- `work/g1/external-tab.png` and `work/g1/gate-G1-sphere.png` — the pre-fix render: the
  whole globe drawn at 300×150 in the top-left corner, but already **black above the red
  stripe, white below it, stripe on the visible equator** (only the L0 tile fits that
  small viewport, so it shows the single equatorial stripe the criterion asks for).
- `work/g1/gate-G1-sphere-fullframe.png` — after the canvas fix: the globe fills the
  frame and the **L1** tiles are used, which is the stronger picture.

Reading the full-frame screenshot top → bottom, and why it can only mean row 0 = north:
each probe tile is black in its own northern half and white in its own southern half, so
if Cesium places row 0 in the north the globe must read

| band | latitude | colour |
|---|---|---|
| 1 | 90 → 45 N | black (row 0, northern half) |
| 2 | 45 N | red stripe (row 0's own mid-line) |
| 3 | 45 N → 0 | white (row 0, southern half) |
| 4 | 0 → 45 S | black (row 1, northern half) |
| 5 | 45 S | red stripe (row 1's own mid-line) |
| 6 | 45 S → 90 S | white (row 1, southern half) |

That is exactly what the screenshot shows. TMS order would mirror it (white cap on top).
Note the two stripes are at ±45°, not on the equator, **by construction of the probe
tiles at L1** — the "one red stripe on the visible equator" reading belongs to the L0
render, and both are recorded above rather than blended into one claim.

Cross-check that north really is up on screen (not just in the tile maths): projecting
(0°E) onto the live canvas gave

```json
{"northPole":[416,153],"lat45N":[416,171],"equator":[416,393],"lat45S":[416,615],"southPole":[416,633],"canvas":[831,786]}
```

so the pole is at the top of the disk, the equator at its vertical centre, and the band
boundaries land on 171/393/615 as the table predicts.

**Console / network:** the only console message on the page is React's DevTools info
banner — no errors, no warnings, no ion 401. Every request is same-origin
(`localhost:3001`); nothing touches `ion.cesium.com`. The Cesium ion logo in the credit
bar is a static self-hosted image, not a service call.

## How to reproduce / re-verify

```bash
npm run postinstall                                   # self-host Cesium assets
.venv/Scripts/python.exe scripts/gen_probe_tiles.py   # 10 probe tiles
node scripts/g1_tiling_probe.mjs                      # criteria 3 + 4, headless
npm run dev                                           # then open the printed URL
```

**Port caveat:** port 3000 is already held by an unrelated process on this machine
(PID 28812, not started by this task and deliberately left alone), so `next dev` falls
back to **http://localhost:3001**. The dev server is still running in the background from
this session; its log is `/tmp/next-dev.log`. To close the visual gap yourself, open
3001, wait for the globe, and run the brief's Step 5 snippet with the two accessor names
swapped as documented above.

## Consequences for later tasks

1. No `{reverseY}` anywhere; the bake stays un-flipped. `y = 0` is north end to end.
2. Cesium 1.146 gives **no** `tileYToLatitude` / `levelMaximumTileCount`; use
   `tileXYToRectangle` / `getNumberOf{X,Y}TilesAtLevel` in Task 3's tests and in
   `moon.ts` consumers.
3. `scene.skyAtmosphere` / `sun` / `moon` / `skyBox` are `undefined` under a custom
   ellipsoid — never dereference them unguarded.
4. Canvas sizing lives in `globals.css` because Widgets.css is not imported. Task 13
   (attribution) should decide whether to import Widgets.css for the credit bar chrome;
   today the credit renders as unstyled text at the top-left and the compass at the
   bottom-left. That is cosmetic and does not affect G1.
5. `src/app/page.module.css` is now orphaned — `page.tsx` no longer imports it. Left in
   place because the brief does not authorise deleting it; safe to remove.
