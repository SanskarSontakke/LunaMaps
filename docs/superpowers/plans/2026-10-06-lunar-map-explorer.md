# Lunar Map Explorer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-first Next.js app that shows the Moon as an interactive map in two modes — flat "paper" and a zoomable/rotatable globe — from one self-baked 512 px equirectangular tile pyramid, with subtle IAU place names.

**Architecture:** A Python pipeline downloads three authoritative pre-stitched global products (LROC WAC morphology mosaic, NASA SVS colour basemap, IAU gazetteer shapefile), composites them per pixel (chroma from the colour base, fine detail from the mosaic), and bakes a Cesium-native geodetic tile pyramid plus a curated label GeoJSON. The Next.js app renders those tiles with CesiumJS alone: `SceneMode.SCENE3D` for the globe, `SceneMode.SCENE2D` for the flat map, so both modes share one grid, one tile set and one label file.

**Tech Stack:** Next.js 15 (App Router, `src/` layout), TypeScript, CesiumJS (self-hosted static assets, no Cesium ion), vitest; Python 3.12 in a venv with `rasterio` (bundled GDAL), `numpy`, `pillow`, `pyshp`, `pytest`.

**Spec:** `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md` — read it alongside every task.

## Global Constraints

- **Never stitch camera frames.** Only the three named global mosaic products are combined, per pixel, on registered grids. (spec §1.1)
- **Two layers only:** `paper` (single-band grayscale detail mosaic) and `photo` (chroma-composited colour). No DEM/contour layer. (D2)
- **Local-first:** no tile server, no object storage, no public deploy. Everything served from `public/`. (D3)
- **One engine:** CesiumJS for both modes. MapLibre is excluded because its raster sources assume the global-mercator profile; three.js is excluded because a single texture caps near 670 m/px. (D4, spec §1.2)
- **Tile grid:** 512 × 512 px square tiles; level `L` has `2^(L+1)` columns × `2^L` rows; `y` increases southward (row 0 = north); lon −180…180; planetocentric lat ±90; Moon sphere radius 1,737,400 m; flattening 0.
- **Top level default `--top 6`** (166.5 m/px). `--top 7` (83.3 m/px) is opt-in and must never be required for the app to work. (D1)
- **JPEG q85**, `optimize=True`, no EXIF/ICC; `paper` single-band grayscale, `photo` YCbCr.
- **The `k = 0` composite must reproduce the colour base bit-for-bit**, asserted with `np.array_equal`.
- **No new heavy dependencies:** no scipy, no OpenLayers, no search library, no `@types/cesium`.
- **Never commit imagery:** `data/raw/`, `work/`, `public/tiles/**/*.jpg` are git-ignored. `public/tiles/manifest.json`, `public/data/features.json`, `test-vectors/grid.json` and the fixtures are committed.
- **Python always runs as** `.venv/Scripts/python.exe -m pytest …` (Windows layout, Git Bash shell). Node 24 / npm 11 are on PATH.
- **Attribution**: the credit string is defined exactly once, as the exported `CREDIT`
  in `src/lib/cesium/moon.ts`, reading `NASA/GSFC/Arizona State University (LROC WAC
  mosaic) · NASA’s Scientific Visualization Studio (CGI Moon Kit) · USGS Astrogeology
  Science Center · IAU Gazetteer of Planetary Nomenclature` (typographic U+2019
  apostrophe, deliberate). Any component or test needing the text MUST import
  `CREDIT` — never retype a literal, because a one-codepoint difference between two
  hand-typed copies is a false failure waiting to happen. The README may restate it
  in prose.
- **Gates are hard stops:** G1 (Task 2), G2 (Task 9), G3 (Task 18). A failed gate is diagnosed and reported with evidence; do not proceed past it, and never weaken an assertion to make it pass.

### Spec amendment A (this plan supersedes spec §3.1 Stage 2)

Per-tile windows with an 8 px bleed are replaced by **full-width horizontal bands**: each band spans all 360° of longitude at the top level's resolution, so longitude periodicity becomes array periodicity (`np.pad(mode='wrap')`) instead of wrapped window arithmetic. The intent is unchanged — the Gaussian kernel must see real neighbouring data — and poles still clamp. Memory is bounded by `--band-rows`. The spec file is updated to match in Task 7 Step 7.

---

## Task 1: Scaffold the repository and both toolchains

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.mjs`, `vitest.config.ts`
- Create: `scripts/requirements.txt`, `.gitignore` entries
- Keep: `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run dev|build|start|test|fetch|bake|labels|proof`, a git repo containing the spec, a working `.venv`.

- [ ] **Step 1: Move `docs/` aside, because `create-next-app` refuses a non-empty directory**

```bash
cd /c/Users/YAMINI/Documents/Qoder/2026-10-06/1561f05e
mv docs /tmp/moon-docs
```

- [ ] **Step 2: Scaffold Next.js in place, then restore the spec**

```bash
npx --yes create-next-app@15 . --yes --typescript --app --src-dir --use-npm --no-eslint --no-tailwind
mv /tmp/moon-docs docs
ls package.json next.config.mjs src/app/layout.tsx src/app/page.tsx .git
```

Expected: all five paths listed. If `create-next-app` aborts on the directory-emptiness check, it prints the offending files — move them to `/tmp` too and retry. Never delete anything.

- [ ] **Step 3: Install Cesium and vitest, and confirm Cesium ships its own types**

```bash
npm i cesium
npm i -D vitest
node -e "console.log('cesium', require('cesium/package.json').version)"
node -e "console.log('types', require('cesium/package.json').types)"
```

Expected: a Cesium version ≥ 1.100 and a `types` path inside `node_modules/cesium`. If `types` is `undefined`, stop and report — every Cesium task depends on it. Do **not** install `@types/cesium`; it is deprecated and conflicts.

- [ ] **Step 4: Set the project scripts**

Replace the `scripts` object in `package.json` with exactly:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "postinstall": "node scripts/postinstall_cesium.mjs",
    "fetch": ".venv/Scripts/python.exe scripts/fetch_data.py",
    "bake": ".venv/Scripts/python.exe scripts/bake.py",
    "labels": ".venv/Scripts/python.exe scripts/labels.py",
    "proof": ".venv/Scripts/python.exe scripts/proof.py",
    "test:js": "vitest run",
    "test:py": ".venv/Scripts/python.exe -m pytest scripts/tests -q",
    "test": "vitest run && .venv/Scripts/python.exe -m pytest scripts/tests -q"
  }
}
```

- [ ] **Step 5: Create the Python venv and install pipeline dependencies**

`scripts/requirements.txt`:

```
rasterio>=1.3
numpy>=1.26
pillow>=10
pyshp>=2.3
pytest>=8
```

```bash
python -m venv .venv
.venv/Scripts/python.exe -m pip install -U pip
.venv/Scripts/python.exe -m pip install -r scripts/requirements.txt
.venv/Scripts/python.exe -c "import rasterio, numpy, PIL, shapefile, pytest; print('deps ok', rasterio.__version__, numpy.__version__)"
```

Expected: `deps ok 1.x 1.x`. If `rasterio` has no Windows wheel, **stop and report** — the entire pipeline depends on its bundled GDAL.

- [ ] **Step 6: Confirm the JP2 and GeoTIFF drivers exist**

```bash
.venv/Scripts/python.exe -c "
import rasterio.drivers as d
ext = sorted(d.raster_driver_extensions())
print('jp2:', [e for e in ext if 'jp2' in e or 'j2k' in e])
print('tif:', [e for e in ext if 'tif' in e])
" | tee docs/superpowers/specs/driver-probe.txt
```

Expected: both lists non-empty. If `.jp2`/`.j2k` are missing, the detail source becomes the 5,959,263,751-byte `.tif` fallback (spec §2.1) and Task 6 Step 6 switches to it explicitly.

- [ ] **Step 7: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: { environment: 'node', include: ['src/test/**/*.test.ts'] },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
});
```

- [ ] **Step 8: Append gitignore entries**

```gitignore
data/raw/
work/
public/tiles/
!public/tiles/manifest.json
public/cesium/
.venv/
```

Then verify the negation actually works, because a directory cannot be re-included once its parent is ignored:

```bash
mkdir -p public/tiles && echo '{}' > public/tiles/manifest.json
git check-ignore -v public/tiles/manifest.json; echo "exit $?"
```

Expected: `exit 1` (not ignored). If it prints an ignore rule, change line 3 to `public/tiles/*` instead of `public/tiles/` and re-check.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js 15 + TypeScript + vitest and the rasterio pipeline env

Adds the design spec and both toolchains for the lunar map. Binaries and
baked tiles stay out of git; only manifest.json is tracked under public/tiles."
```

---

## Task 2: Cesium integration and Gate G1 — prove the engine and the tile `y` convention

This task exists to destroy the two risks that invalidate everything downstream: whether Cesium bundles under Next.js, and whether Cesium's `GeographicTilingScheme` really puts row 0 in the north.

**Files:**
- Create: `scripts/postinstall_cesium.mjs`, `src/types.ts`, `src/lib/cesium/moon.ts`, `src/components/MoonMap.tsx`
- Modify: `src/app/page.tsx`, `src/app/globals.css`
- Create: `scripts/gen_probe_tiles.py`

**Interfaces:**
- Consumes: the static path convention `public/tiles/<layer>/<L>/<x>/<y>.jpg`.
- Produces: `MOON_RADIUS_M`, `MOON_ELLIPSOID`, `TILE_SIZE`, `CREDIT`, `LayerName`, `makeProvider(layer, top)`, `MoonViewerOptions`, `createMoonViewer(container, opts)` — the exact names every later Cesium task imports.

- [ ] **Step 1: Write the Cesium static-asset copier**

`scripts/postinstall_cesium.mjs`:

```js
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'node_modules/cesium/Build/Cesium');
if (!existsSync(build)) {
  console.error(`Cesium build missing at ${build}`);
  process.exit(1);
}
const dest = resolve(root, 'public/cesium');
mkdirSync(dest, { recursive: true });
for (const dir of ['Workers', 'Widgets', 'Assets', 'ThirdParty']) {
  cpSync(resolve(build, dir), resolve(dest, dir), { recursive: true });
  console.log('copied', dir);
}
```

Run: `npm run postinstall`
Expected: four `copied …` lines, and `public/cesium/Workers/` non-empty.

- [ ] **Step 2: Write the asymmetric probe-tile generator**

`scripts/gen_probe_tiles.py`. Every tile is black in its northern half and white in its southern half, with a red stripe on the equator. Rendered correctly, the northern hemisphere of the globe is black; if `y` is inverted it is white. That single image answers the question.

```python
import sys
from pathlib import Path
from PIL import Image

TILE = 512
OUT = Path('public/tiles/probe')


def half_split_tile():
    im = Image.new('RGB', (TILE, TILE))
    px = im.load()
    mid = TILE // 2
    for yy in range(TILE):
        if mid - 3 <= yy <= mid:
            colour = (220, 30, 30)
        elif yy < mid:
            colour = (0, 0, 0)
        else:
            colour = (255, 255, 255)
        for xx in range(TILE):
            px[xx, yy] = colour
    return im


def main():
    written = 0
    for L in (0, 1):
        for x in range(2 ** (L + 1)):
            for y in range(2 ** L):
                d = OUT / str(L) / str(x)
                d.mkdir(parents=True, exist_ok=True)
                half_split_tile().save(d / f'{y}.jpg', quality=95, optimize=True)
                written += 1
    print(f'wrote {written} probe tiles to {OUT}')
    return 0 if written == 10 else 1


if __name__ == '__main__':
    sys.exit(main())
```

Run: `.venv/Scripts/python.exe scripts/gen_probe_tiles.py`
Expected: `wrote 10 probe tiles …` and exit 0 (2 tiles at L0, 8 at L1).

- [ ] **Step 3: Write the viewer factory**

`moon.ts` imports `LayerName` from `src/types.ts`, so create that file here with its three small union types; Task 5 extends the same file with the `Feature` and `Manifest` interfaces.

`src/types.ts`:

```ts
export type Tier = 0 | 1 | 2 | 3;
/** Owned here, not by moon.ts. `probe` is the Task 2 gate fixture. */
export type LayerName = 'paper' | 'photo' | 'probe';
export type Mode = 'globe' | 'paper';
```

`src/lib/cesium/moon.ts`:

```ts
import * as Cesium from 'cesium';
import type { LayerName } from '@/types';

export type { LayerName };

export const MOON_RADIUS_M = 1_737_400;
export const TILE_SIZE = 512;
export const MOON_ELLIPSOID = new Cesium.Ellipsoid(
  MOON_RADIUS_M,
  MOON_RADIUS_M,
  MOON_RADIUS_M,
);

export const CREDIT = new Cesium.Credit(
  'NASA/GSFC/Arizona State University (LROC WAC mosaic) · NASA’s Scientific ' +
    'Visualization Studio (CGI Moon Kit) · USGS Astrogeology Science Center · ' +
    'IAU Gazetteer of Planetary Nomenclature',
);

export function makeProvider(layer: LayerName, top: number) {
  return new Cesium.UrlTemplateImageryProvider({
    url: `/tiles/${layer}/{z}/{x}/{y}.jpg`,
    tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID }),
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel: top,
    rectangle: Cesium.Rectangle.MAX_VALUE,
    credit: CREDIT,
  });
}

export interface MoonViewerOptions {
  layer: LayerName;
  top: number;
  mode: 'globe' | 'paper';
}

export function createMoonViewer(container: HTMLElement, opts: MoonViewerOptions) {
  const viewer = new Cesium.Viewer(container, {
    sceneMode:
      opts.mode === 'globe' ? Cesium.SceneMode.SCENE3D : Cesium.SceneMode.SCENE2D,
    ellipsoid: MOON_ELLIPSOID,
    // baseLayer must be passed explicitly: if it is omitted Cesium resolves a
    // default imagery provider through Cesium ion, which this app never uses.
    baseLayer: new Cesium.ImageryLayer(makeProvider(opts.layer, opts.top)),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  const scene = viewer.scene;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0d12');
  scene.globe.enableLighting = false;
  scene.skyAtmosphere.show = false;
  scene.fog.enabled = false;
  scene.sun.show = false;
  scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#05060a');

  const ctl = scene.screenSpaceCameraController;
  ctl.minimumZoomDistance = 1_500;
  ctl.maximumZoomDistance = 3.5e7;
  ctl.enableTilt = opts.mode === 'globe';

  return viewer;
}
```

- [ ] **Step 4: Wire the client component and the page**

`src/components/MoonMap.tsx`:

```tsx
'use client';
import { useEffect, useRef } from 'react';
import type * as Cesium from 'cesium';
import { createMoonViewer } from '@/lib/cesium/moon';

declare global {
  // Exposed for the browser verification harness only.
  var __moonViewer: Cesium.Viewer | undefined;
  var CESIUM_BASE_URL: string | undefined;
}

export default function MoonMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  useEffect(() => {
    globalThis.CESIUM_BASE_URL = '/cesium';
    const host = hostRef.current;
    if (!host || viewerRef.current) return;
    const viewer = createMoonViewer(host, { layer: 'probe', top: 1, mode: 'globe' });
    viewerRef.current = viewer;
    globalThis.__moonViewer = viewer;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      globalThis.__moonViewer = undefined;
    };
  }, []);

  return <div ref={hostRef} id="cesiumContainer" className="map-host" />;
}
```

`src/app/page.tsx` (replace entirely):

```tsx
'use client';
import dynamic from 'next/dynamic';

const MoonMap = dynamic(() => import('@/components/MoonMap'), { ssr: false });

export default function Home() {
  return <MoonMap />;
}
```

`src/app/globals.css` (replace entirely):

```css
html,
body,
main {
  height: 100%;
  margin: 0;
  background: #05060a;
}
.map-host {
  position: fixed;
  inset: 0;
}
.map-host canvas {
  display: block;
}
```

- [ ] **Step 5: Gate G1 — run it in a real browser and record the evidence**

```bash
npm run dev   # background
```

Using the browser connector: open `http://localhost:3000`, wait for the canvas, screenshot, then evaluate:

```js
const v = globalThis.__moonViewer;
const p = v.imageryLayers.get(0).imageryProvider;
const ts = p.tilingScheme;
JSON.stringify({
  mode: v.scene.mode,
  maxLevel: p.maximumLevel,
  tileWidth: p.tileWidth,
  row0LatDeg: (ts.tileYToLatitude(0, 1) * 180) / Math.PI,
  row1LatDeg: (ts.tileYToLatitude(1, 1) * 180) / Math.PI,
  level1Counts: [ts.levelMaximumTileCount(1).x, ts.levelMaximumTileCount(1).y],
});
```

**Gate criteria — all four required before any later task:**
1. A sphere painted with imagery (not a black globe, no ion 401 in the console).
2. The screenshot shows **black above the red stripe and white below it**, and the red stripe sits on the visible equator.
3. `row0LatDeg === 90` and `row1LatDeg === 0` — Cesium's row 0 is north, so the bake's `y` direction is right.
4. `level1Counts === [4, 2]` — confirming `cols = 2^(L+1)`, `rows = 2^L` at L1.

If criterion 2 or 3 fails, Cesium wants TMS order. The fix is one flag, not a rewrite: use `{reverseY}` in `makeProvider` and pass `--y-flip` to the bake. Either way, write the outcome, the JSON and the screenshot path into `docs/superpowers/specs/gate-G1.md`.

If Cesium will not bundle under `next dev`, work this ladder in order and record which rung worked: (a) `npm run build && npm run start`; (b) `next dev --turbopack`; (c) load the self-hosted `public/cesium/Cesium.js` with a script tag and use the global `Cesium`, removing the bundler from the equation entirely. Rung (c) is a supported path, not a hack.

- [ ] **Step 6: Commit**

```bash
git add scripts/postinstall_cesium.mjs scripts/gen_probe_tiles.py src docs/superpowers/specs/gate-G1.md package.json
git commit -m "feat: boot CesiumJS with self-hosted assets and prove the geodetic y-origin"
```

---

## Task 3: The grid contract, mirrored in Python and TypeScript

Both languages compute tile indices, and any disagreement between them is a silent map bug. So both are tested against **one** golden vector file.

**Files:**
- Create: `scripts/grid.py`, `src/lib/grid.ts`, `scripts/gen_grid_vectors.py`
- Test: `scripts/tests/test_grid.py`, `src/test/grid.test.ts`
- Create: `test-vectors/grid.json` (committed)

**Interfaces:**
- Consumes: nothing.
- Produces — Python: `TILE`, `MOON_RADIUS_M`, `MAX_TOP_LEVEL`, `level_cols(L)`, `level_rows(L)`, `world_px_width(L)`, `world_px_height(L)`, `px_per_deg(L)`, `m_per_px(L)`, `tile_bounds(L,x,y)`, `lon_to_tile_x(lon,L)`, `lat_to_tile_y(lat,L)`, `world_px_of(lon,lat,L)`, `tile_path(layer,L,x,y)`.
- Produces — TypeScript, same meanings: `TILE_SIZE`, `MOON_RADIUS_M`, `levelCols`, `levelRows`, `worldPxWidth`, `worldPxHeight`, `pxPerDeg`, `mPerPx`, `tileBounds(L,x,y): Bounds`, `lonToTileX`, `latToTileY`, `worldPxOf(lon,lat,L): {x,y}`, `cameraHeightForLevel(L, viewportHeightPx, fovDeg)`.

- [ ] **Step 1: Write the failing Python tests**

`scripts/tests/test_grid.py`:

```python
import json
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid


def test_level_shapes():
    assert [(grid.level_cols(L), grid.level_rows(L)) for L in range(4)] == [
        (2, 1), (4, 2), (8, 4), (16, 8)]


def test_world_is_always_two_to_one():
    for L in range(8):
        assert grid.world_px_width(L) == 2 * grid.world_px_height(L)


def test_metres_per_pixel_table():
    assert grid.m_per_px(5) == pytest.approx(333.1, abs=0.6)
    assert grid.m_per_px(6) == pytest.approx(166.6, abs=0.6)
    assert grid.m_per_px(7) == pytest.approx(83.3, abs=0.6)


def test_native_detail_sits_between_levels():
    native = 303.233
    assert grid.px_per_deg(6) < native < grid.px_per_deg(7)


def test_level0_is_two_tiles_side_by_side():
    assert grid.tile_bounds(0, 0, 0) == pytest.approx((-180.0, -90.0, 0.0, 90.0))
    assert grid.tile_bounds(0, 1, 0) == pytest.approx((0.0, -90.0, 180.0, 90.0))


def test_row_zero_is_the_north():
    _, s, _, n = grid.tile_bounds(1, 0, 0)
    assert (n, s) == pytest.approx((90.0, 0.0))


def test_edges_are_clamped():
    assert grid.lon_to_tile_x(180.0, 3) == grid.level_cols(3) - 1
    assert grid.lon_to_tile_x(-180.0, 3) == 0
    assert grid.lat_to_tile_y(90.0, 3) == 0
    assert grid.lat_to_tile_y(-90.0, 3) == grid.level_rows(3) - 1


def test_out_of_range_tile_raises():
    with pytest.raises(ValueError):
        grid.tile_bounds(2, 8, 4)


def test_world_px_of_corners():
    assert grid.world_px_of(-180.0, 90.0, 4) == pytest.approx((0.0, 0.0))
    w, s, e, n = grid.tile_bounds(4, 0, 0)
    wx, wy = grid.world_px_of(e, n, 4)
    assert wx == pytest.approx(float(grid.TILE))
    assert wy == pytest.approx(0.0)


def test_golden_vectors_from_disk():
    vecs = json.loads(Path('test-vectors/grid.json').read_text())
    assert vecs['tileSize'] == grid.TILE
    assert vecs['moonRadiusM'] == grid.MOON_RADIUS_M
    for v in vecs['bounds']:
        assert grid.tile_bounds(v['L'], v['x'], v['y']) == pytest.approx(
            tuple(v['bounds']), abs=1e-9), v
    for v in vecs['index']:
        assert grid.lon_to_tile_x(v['lon'], v['L']) == v['x']
        assert grid.lat_to_tile_y(v['lat'], v['L']) == v['y']
```

- [ ] **Step 2: Run them to verify they fail**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_grid.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'grid'`.

- [ ] **Step 3: Implement `scripts/grid.py`**

```python
"""Geodetic tile grid contract.

Mirrored by src/lib/grid.ts; both are tested against the shared golden vectors
in test-vectors/grid.json. Level L has 2^(L+1) columns and 2^L rows of 512 px
square tiles, y increasing southward (row 0 at the north), which is exactly
Cesium's GeographicTilingScheme.
"""
from __future__ import annotations
import math

TILE = 512
MOON_RADIUS_M = 1_737_400.0
MAX_TOP_LEVEL = 7
DEG2RAD = math.pi / 180.0
ARC_METRES_PER_DEGREE = MOON_RADIUS_M * DEG2RAD  # 30_322.4 m


def level_cols(L: int) -> int:
    return 2 ** (L + 1)


def level_rows(L: int) -> int:
    return 2 ** L


def world_px_width(L: int) -> int:
    return TILE * level_cols(L)


def world_px_height(L: int) -> int:
    return TILE * level_rows(L)


def px_per_deg(L: int) -> float:
    return world_px_width(L) / 360.0


def m_per_px(L: int) -> float:
    return ARC_METRES_PER_DEGREE / px_per_deg(L)


def tile_bounds(L: int, x: int, y: int):
    cols, rows = level_cols(L), level_rows(L)
    if not (0 <= x < cols and 0 <= y < rows):
        raise ValueError(f'tile {L}/{x}/{y} outside {cols}x{rows}')
    dlon = 360.0 / cols
    dlat = 180.0 / rows
    west = -180.0 + x * dlon
    north = 90.0 - y * dlat
    return west, north - dlat, west + dlon, north


def lon_to_tile_x(lon: float, L: int) -> int:
    cols = level_cols(L)
    x = math.floor((lon + 180.0) / 360.0 * cols)
    return min(max(int(x), 0), cols - 1)


def lat_to_tile_y(lat: float, L: int) -> int:
    rows = level_rows(L)
    y = math.floor((90.0 - lat) / 180.0 * rows)
    return min(max(int(y), 0), rows - 1)


def world_px_of(lon: float, lat: float, L: int):
    wx = (lon + 180.0) / 360.0 * world_px_width(L)
    wy = (90.0 - lat) / 180.0 * world_px_height(L)
    return wx, wy


def tile_path(layer: str, L: int, x: int, y: int) -> str:
    return f'{layer}/{L}/{x}/{y}.jpg'
```

- [ ] **Step 4: Run to verify the nine non-vector tests pass**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_grid.py -q`
Expected: 9 passed, 1 failed (`test_golden_vectors_from_disk`, no file yet).

- [ ] **Step 5: Generate the golden vectors**

`scripts/gen_grid_vectors.py`:

```python
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grid

LON_LAT = [
    (0.0, 0.0), (-180.0, 90.0), (180.0, -90.0), (-179.9999, 89.9999),
    (23.4731, 0.6746),          # Apollo 11 landing site
    (-11.2153, -43.2958),       # Tycho, already wrapped to -180..180
    (100.0, 89.9), (-100.0, -89.9), (179.99999, 0.0), (-0.0001, -0.0001),
]


def main():
    bounds = []
    for L in range(8):
        for x, y in [(0, 0), (0, grid.level_rows(L) - 1),
                     (grid.level_cols(L) - 1, 0),
                     (grid.level_cols(L) - 1, grid.level_rows(L) - 1)]:
            bounds.append({'L': L, 'x': x, 'y': y,
                           'bounds': list(grid.tile_bounds(L, x, y))})
    index = [{'lon': lon, 'lat': lat, 'L': L,
              'x': grid.lon_to_tile_x(lon, L),
              'y': grid.lat_to_tile_y(lat, L)}
             for L in range(8) for (lon, lat) in LON_LAT]
    Path('test-vectors').mkdir(exist_ok=True)
    out = {'tileSize': grid.TILE, 'moonRadiusM': grid.MOON_RADIUS_M,
           'mPerPx': {str(L): grid.m_per_px(L) for L in range(8)},
           'bounds': bounds, 'index': index}
    p = Path('test-vectors/grid.json')
    p.write_text(json.dumps(out, indent=1))
    print(f'wrote {p}: {len(bounds)} bounds, {len(index)} index vectors')


if __name__ == '__main__':
    main()
```

Run: `.venv/Scripts/python.exe scripts/gen_grid_vectors.py && .venv/Scripts/python.exe -m pytest scripts/tests/test_grid.py -q`
Expected: `wrote test-vectors\grid.json: 32 bounds, 80 index vectors`, then 10 passed.

- [ ] **Step 6: Write the failing TypeScript mirror test**

`src/test/grid.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, it, describe } from 'vitest';
import {
  levelCols, levelRows, mPerPx, tileBounds, lonToTileX, latToTileY,
  cameraHeightForLevel, worldPxOf, worldPxWidth,
} from '@/lib/grid';

const vecs = JSON.parse(readFileSync('test-vectors/grid.json', 'utf8'));

describe('TS grid matches the Python implementation', () => {
  it('level shapes', () => {
    expect([0, 1, 2, 3].map((L) => [levelCols(L), levelRows(L)])).toEqual([
      [2, 1], [4, 2], [8, 4], [16, 8],
    ]);
  });
  it('bounds vectors', () => {
    for (const v of vecs.bounds) {
      const b = tileBounds(v.L, v.x, v.y);
      const got = [b.west, b.south, b.east, b.north] as number[];
      got.forEach((value, i) => {
        expect(Math.abs(value - v.bounds[i])).toBeLessThan(1e-8);
      });
    }
  });
  it('index vectors', () => {
    for (const v of vecs.index) {
      expect(lonToTileX(v.lon, v.L)).toBe(v.x);
      expect(latToTileY(v.lat, v.L)).toBe(v.y);
    }
  });
  it('metres per pixel', () => {
    for (const [L, m] of Object.entries(vecs.mPerPx) as [string, number][]) {
      expect(mPerPx(Number(L))).toBeCloseTo(m, 1);
    }
  });
  it('world is 2:1 at every level', () => {
    for (const L of [0, 3, 6, 7]) {
      expect(worldPxWidth(L)).toBe(2 * (512 * levelRows(L)));
      expect(worldPxOf(0, 0, L)).toEqual({ x: worldPxWidth(L) / 2, y: 512 * levelRows(L) / 2 });
    }
  });
  it('throws on out-of-range tiles', () => {
    expect(() => tileBounds(2, 8, 4)).toThrow();
  });
});

describe('cameraHeightForLevel', () => {
  it('is the nadir height whose vertical footprint matches the level', () => {
    const h = cameraHeightForLevel(6, 900, 60);
    const span = mPerPx(6) * 900;
    expect(h).toBeCloseTo(span / 2 / Math.tan(30 * (Math.PI / 180)), 0);
  });
});
```

- [ ] **Step 7: Run it to verify failure, then implement `src/lib/grid.ts`**

Run: `npx vitest run src/test/grid.test.ts`
Expected: FAIL — failed to resolve `@/lib/grid`.

```ts
export const TILE_SIZE = 512;
export const MOON_RADIUS_M = 1_737_400;
export const DEG2RAD = Math.PI / 180;
const ARC_METRES_PER_DEGREE = MOON_RADIUS_M * DEG2RAD;

export const levelCols = (L: number) => 2 ** (L + 1);
export const levelRows = (L: number) => 2 ** L;
export const worldPxWidth = (L: number) => TILE_SIZE * levelCols(L);
export const worldPxHeight = (L: number) => TILE_SIZE * levelRows(L);
export const pxPerDeg = (L: number) => worldPxWidth(L) / 360;
export const mPerPx = (L: number) => ARC_METRES_PER_DEGREE / pxPerDeg(L);

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tileBounds(L: number, x: number, y: number): Bounds {
  const cols = levelCols(L);
  const rows = levelRows(L);
  if (x < 0 || x >= cols || y < 0 || y >= rows) {
    throw new Error(`tile ${L}/${x}/${y} outside ${cols}x${rows}`);
  }
  const dlon = 360 / cols;
  const dlat = 180 / rows;
  const west = -180 + x * dlon;
  const north = 90 - y * dlat;
  return { west, south: north - dlat, east: west + dlon, north };
}

export function lonToTileX(lon: number, L: number): number {
  const cols = levelCols(L);
  const x = Math.floor(((lon + 180) / 360) * cols);
  return Math.min(Math.max(x, 0), cols - 1);
}

export function latToTileY(lat: number, L: number): number {
  const rows = levelRows(L);
  const y = Math.floor(((90 - lat) / 180) * rows);
  return Math.min(Math.max(y, 0), rows - 1);
}

export function worldPxOf(lon: number, lat: number, L: number) {
  return {
    x: ((lon + 180) / 360) * worldPxWidth(L),
    y: ((90 - lat) / 180) * worldPxHeight(L),
  };
}

/** Nadir camera height (m) whose vertical footprint equals level L's m/px. */
export function cameraHeightForLevel(
  L: number,
  viewportHeightPx: number,
  fovDeg: number,
): number {
  const span = mPerPx(L) * viewportHeightPx;
  return span / 2 / Math.tan((fovDeg / 2) * DEG2RAD);
}
```

- [ ] **Step 8: Verify both suites, then commit**

Run: `npx vitest run && .venv/Scripts/python.exe -m pytest scripts/tests/test_grid.py -q`
Expected: both green.

```bash
git add scripts/grid.py src/lib/grid.ts scripts/gen_grid_vectors.py test-vectors/grid.json scripts/tests/test_grid.py src/test/grid.test.ts vitest.config.ts
git commit -m "feat: geodetic tile grid contract with shared Python/TS golden vectors"
```

---

## Task 4: Blur and composite — the colour recipe, proved on synthetic data

**Files:**
- Create: `scripts/blur.py`, `scripts/composite.py`
- Test: `scripts/tests/test_blur.py`, `scripts/tests/test_composite.py`

**Interfaces:**
- Consumes: `numpy` only (no scipy).
- Produces: `gauss1d(sigma, radius) -> (2r+1,) float32`; `blur_separable(a, sigma=2.5, radius=8, wrap_x=True) -> float32 (H,W)`, documented and tested as correct **only for full-width longitude bands**; `chroma_detail(base (H,W,3) uint8, detail (H,W) uint8, k=0.4, sigma=2.5, radius=8) -> uint8 (H,W,3)`.

- [ ] **Step 1: Write the failing blur tests**

`scripts/tests/test_blur.py`:

```python
import sys
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blur import gauss1d, blur_separable


def test_kernel_is_normalised_and_symmetric():
    k = gauss1d(2.5, 8)
    assert k.shape == (17,)
    assert k.sum() == pytest.approx(1.0, abs=1e-6)
    assert np.allclose(k, k[::-1])


def test_constant_field_is_unchanged_exactly():
    a = np.full((32, 64), 7.0, np.float32)
    assert np.allclose(blur_separable(a, 2.5, 8), 7.0, atol=1e-5)


def test_seam_is_treated_as_adjacent_when_wrapping():
    # a column-constant impulse at x=0 must leak equally to x=-1 and x=+1
    a = np.zeros((9, 64), np.float32)
    a[:, 0] = 1.0
    out = blur_separable(a, 2.5, 3, wrap_x=True)
    assert out[4, -1] > 1e-3
    assert out[4, -1] == pytest.approx(out[4, 1], rel=1e-6)


def test_no_wrap_keeps_the_far_edge_at_zero():
    a = np.zeros((9, 64), np.float32)
    a[:, 0] = 1.0
    out = blur_separable(a, 2.5, 3, wrap_x=False)
    assert out[4, -1] == 0.0


def test_y_is_always_edge_clamped_not_wrapped():
    a = np.zeros((21, 21), np.float32)
    a[0, 10] = 1.0
    out = blur_separable(a, 2.0, 4, wrap_x=True)
    assert out[0, 10] > out[20, 10] == 0.0


def test_impulse_support_is_limited_to_the_radius_and_symmetric():
    a = np.zeros((33, 33), np.float32)
    a[16, 16] = 1.0
    r = 4
    out = blur_separable(a, 2.0, r)
    assert out[16, 16 + r + 1] == 0.0
    assert out[16 + r + 1, 16] == 0.0
    assert np.allclose(out[16, 16 - r : 16 + r + 1], out[16, 16 + r : 16 - r - 1 : -1])
    assert out.sum() == pytest.approx(1.0, abs=1e-5)
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_blur.py -q`
Expected: `ModuleNotFoundError: No module named 'blur'`.

- [ ] **Step 3: Implement `scripts/blur.py`**

```python
"""Separable Gaussian without scipy.

The x axis is periodic by default because callers pass full-width longitude
bands: column 0 and column W-1 are physical neighbours on the globe. The y axis
is always edge-clamped because the poles are real boundaries.
"""
from __future__ import annotations
import numpy as np


def gauss1d(sigma: float, radius: int) -> np.ndarray:
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    k /= k.sum()
    return k.astype(np.float32)


def blur_separable(a: np.ndarray, sigma: float = 2.5, radius: int = 8,
                   wrap_x: bool = True) -> np.ndarray:
    if a.ndim != 2:
        raise ValueError(f'blur_separable needs a 2-D array, got shape {a.shape}')
    k = gauss1d(sigma, radius)
    h, w = a.shape

    ax = np.pad(a, ((0, 0), (radius, radius)),
               mode='wrap' if wrap_x else 'edge').astype(np.float32)
    tmp = np.zeros((h, w), np.float32)
    for i, weight in enumerate(k):
        tmp += weight * ax[:, i : i + w]

    ay = np.pad(tmp, ((radius, radius), (0, 0)), mode='edge')
    out = np.zeros((h, w), np.float32)
    for i, weight in enumerate(k):
        out += weight * ay[i : i + h, :]
    return out
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_blur.py -q`
Expected: 6 passed. If the impulse-support test fails, the padding mode or the tap indexing is wrong — fix the code, not the test.

- [ ] **Step 5: Write the failing composite tests**

`scripts/tests/test_composite.py`:

```python
import sys
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from composite import chroma_detail


def rand_base(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # every pixel clearly non-black, so mean(B) >= 1 everywhere
    return rng.integers(40, 250, (33, 41, 3)).astype(np.uint8)


def test_k_zero_reproduces_the_base_bit_for_bit():
    B = rand_base(1)
    D = np.full(B.shape[:2], 128, np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.0), B)


def test_none_detail_returns_the_base():
    B = rand_base(2)
    D = np.zeros(B.shape[:2], np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=None), B)


def test_flat_detail_leaves_the_base_alone():
    """A constant detail field has no high-frequency band at all."""
    B = rand_base(3)
    D = np.full(B.shape[:2], 200, np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.4), B)


def test_chroma_is_held_and_dark_detail_darkens_the_pixel():
    B = np.zeros((17, 25, 3), np.uint8)
    B[..., 0], B[..., 1], B[..., 2] = 200, 100, 50
    D = np.full(B.shape[:2], 180, np.uint8)
    D[:, 12] = 20
    out = chroma_detail(B, D, k=0.8, sigma=1.0, radius=4)
    interior = (slice(2, 15), slice(2, 23))
    ro = out[interior][..., 0] / out[interior][..., 2]
    rb = B[interior][..., 0] / B[interior][..., 2]
    assert np.allclose(ro, rb, rtol=0.08)
    assert int(out[:, 12].astype(np.int32).sum()) < int(out[:, 2].astype(np.int32).sum())


def test_output_dtype_shape_clamp_and_finiteness():
    B = rand_base(4)
    D = np.random.default_rng(5).integers(0, 255, B.shape[:2]).astype(np.uint8)
    out = chroma_detail(B, D, k=1.5)
    assert out.dtype == np.uint8 and out.shape == B.shape
    assert np.isfinite(out).all()


def test_all_black_pixel_does_not_diverge():
    B = np.zeros((9, 9, 3), np.uint8)
    D = np.zeros((9, 9), np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.4), B)
```

- [ ] **Step 6: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_composite.py -q`
Expected: `ModuleNotFoundError: No module named 'composite'`.

- [ ] **Step 7: Implement `scripts/composite.py`**

```python
"""Chroma transfer with high-frequency detail injection (spec §2.2).

Both inputs are single global mosaics on registered grids, so this is a
per-pixel raster composite: no field-of-view or illumination mixing is
possible, which is the property the brief asked us to protect.

At k = 0 the algebra collapses to mean(B) * (B / mean(B)) == B, and the float32
rounding error is far below 0.5, so rint recovers the original bytes exactly.
That identity is asserted, not assumed.
"""
from __future__ import annotations
import numpy as np
from blur import blur_separable

EPS = 1e-3


def chroma_detail(base: np.ndarray, detail: np.ndarray, k: float | None = 0.4,
                  sigma: float = 2.5, radius: int = 8) -> np.ndarray:
    if base.ndim != 3 or base.shape[2] != 3:
        raise ValueError(f'base must be (H,W,3), got {base.shape}')
    if detail.shape != base.shape[:2]:
        raise ValueError(f'detail {detail.shape} does not match base {base.shape[:2]}')
    if k is None or k == 0.0:
        return base.copy()

    B = base.astype(np.float32)
    D = detail.astype(np.float32)
    meanB = B.mean(axis=2)
    chi = B / np.maximum(meanB[..., None], EPS)
    lpD = blur_separable(D, sigma, radius, wrap_x=True)
    hpD = D - lpD
    muD = max(float(D.mean()), EPS)
    gain = 1.0 + k * hpD / muD
    out = np.clip(np.rint(meanB * gain[..., None] * chi), 0.0, 255.0)
    return out.astype(np.uint8)
```

- [ ] **Step 8: Verify and commit**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_composite.py scripts/tests/test_blur.py -q`
Expected: 12 passed.

```bash
git add scripts/blur.py scripts/composite.py scripts/tests/test_blur.py scripts/tests/test_composite.py
git commit -m "feat: chroma-transfer composite with bit-exact k=0 identity"
```

---

## Task 5: Labels — shapefile to curated `features.json`

**Files:**
- Create: `scripts/labels.py`, `tests/fixtures/moon_nomenclature_fixture.zip`
- Modify: `src/types.ts`
- Test: `scripts/tests/test_labels.py`

**Interfaces:**
- Consumes: a Moon nomenclature centre-points zip (`MOON_nomenclature_center_pts.zip`, 9,087 records; fields `name, clean_name, approvaldt, origin, diameter, center_lon, center_lat, type, code, approval, min_lon, max_lon, min_lat, max_lat, ethnicity, continent, quad_name, quad_code, link`).
- Produces: `load_records(zip_path) -> list[dict]`, `wrap_lon(lon) -> float`, `assign_tier(rec, min_crater_km) -> int | None`, `curate(records, min_crater_km=70.0, budget=600, return_stats=False)`, `to_features(records) -> dict`, `main()` writing `public/data/features.json` and printing stats. TypeScript: `Feature`, `FeatureProps`, `FeatureCollection`, `Manifest`, `Tier`, `Mode`.

- [ ] **Step 1: Commit a real gazetteer fixture**

```bash
mkdir -p tests/fixtures
curl -sSL -o tests/fixtures/moon_nomenclature_fixture.zip \
  "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip"
ls -l tests/fixtures/moon_nomenclature_fixture.zip
```

Expected: 23,845,070 bytes. This is a real USGS nightly export, not synthetic data — label-tier tests must run against it. It is small enough to commit; if the repo policy says otherwise, fetch it in CI instead and note that in the test docstring.

- [ ] **Step 2: Write the failing label tests**

`scripts/tests/test_labels.py`:

```python
import json
import sys
from collections import Counter
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import labels

FIX = 'tests/fixtures/moon_nomenclature_fixture.zip'


@pytest.fixture(scope='module')
def records():
    return labels.load_records(FIX)


def test_record_count_is_the_full_lunar_gazetteer(records):
    assert len(records) == 9087


def test_expected_fields_are_present(records):
    want = {'name', 'type', 'code', 'diameter', 'center_lon', 'center_lat',
            'min_lon', 'max_lon', 'min_lat', 'max_lat', 'origin', 'approvaldt',
            'quad_code', 'link'}
    assert want <= set(records[0])


def test_lon_wraps_to_signed_180():
    assert labels.wrap_lon(348.7847) == pytest.approx(-11.2153, abs=1e-6)
    assert labels.wrap_lon(0.0039) == pytest.approx(0.0039)
    assert labels.wrap_lon(180.0) == pytest.approx(-180.0)
    assert labels.wrap_lon(359.9936) == pytest.approx(-0.0064, abs=1e-4)
    assert all(-180.0 <= labels.wrap_lon(r['center_lon']) < 180.0 for r in records)


def test_landmark_rows_match_the_parsed_dbf(records):
    by = {r['name']: r for r in records}
    ty = by['Tycho']
    assert labels.wrap_lon(ty['center_lon']) == pytest.approx(-11.2153, abs=1e-3)
    assert ty['center_lat'] == pytest.approx(-43.2958, abs=1e-3)
    mt = by['Mare Tranquillitatis']
    assert mt['origin'] == '"Sea of Tranquility."'
    assert mt['diameter'] == pytest.approx(875.75, abs=1.0)
    assert mt['code'] == 'ME'


def test_satellite_features_are_dropped(records):
    kept = labels.curate(records)
    assert all('Satellite' not in (r['type'] or '') for r in kept)
    assert sum(1 for r in records if r['type'] == 'Satellite Feature') == 7064


def test_all_22_maria_survive_curation(records):
    kept = labels.curate(records)
    assert sum(1 for r in records if r['code'] == 'ME') == 22
    assert sum(1 for r in kept if r['code'] == 'ME') == 22


def test_tier_rules(records):
    by = {r['name']: r for r in labels.curate(records)}
    assert by['Oceanus Procellarum']['tier'] == 0
    assert by['Mare Imbrium']['tier'] == 0
    assert by['Mare Undarum']['tier'] == 1        # a mare not named in tier 0
    assert by['Lacus Mortis']['tier'] == 1        # LC, 158.8 km
    assert by['Tycho']['tier'] == 1               # 85 km, tiered by fame
    assert by['Kepler']['tier'] == 1              # 29 km, survives the 70 km cut
    assert 'Shackleton' not in by                 # 20.9 km, below the cut
    assert all(r['tier'] in (0, 1, 2, 3) for r in by.values())


def test_shackleton_appears_when_the_diameter_cut_drops(records):
    assert 'Shackleton' not in {r['name'] for r in labels.curate(records, 70.0)}
    assert 'Shackleton' in {r['name'] for r in labels.curate(records, 15.0)}


def test_centre_is_inside_its_own_bbox_for_every_record(records):
    for r in records:
        assert r['min_lat'] - 1e-6 <= r['center_lat'] <= r['max_lat'] + 1e-6, r['name']
        assert r['min_lon'] - 1e-6 <= r['center_lon'] <= r['max_lon'] + 1e-6 or (
            r['min_lon'] - 360.0 <= r['center_lon'] <= r['max_lon'] - 360.0
        ), r['name']


def test_budget_prunes_only_the_lowest_tier(records):
    kept, stats = labels.curate(records, 70.0, budget=600, return_stats=True)
    assert len(kept) <= 600
    assert stats['curated'] == len(kept)
    assert set(stats['by_code']) and stats['min_crater_km'] == 70.0


def test_features_json_shape(records):
    feats = labels.to_features(labels.curate(records))
    assert feats['type'] == 'FeatureCollection'
    f = next(x for x in feats['features']
             if x['properties']['name'] == 'Mare Tranquillitatis')
    assert f['geometry']['type'] == 'Point'
    assert len(f['geometry']['coordinates']) == 2
    assert f['geometry']['coordinates'][0] == pytest.approx(30.8346)
    assert f['properties']['gloss'] == 'Sea of Tranquility.'
    assert {'name', 'gloss', 'type', 'code', 'tier', 'diameterKm', 'bbox', 'quad',
            'approval', 'mission', 'url'} == set(f['properties'])


def test_there_are_no_landing_site_entries_and_the_heuristic_stays_out(records):
    """The gazetteer has no landing sites. Tier 3 is the astronaut-named set,
    matched on code LF only, so mission-named craters must not leak in."""
    by = {r['name']: r for r in labels.curate(records, return_stats=False)}
    assert 'Apollo 11' not in by and 'Luna 16' not in by
    assert by['Apollo']['code'] == 'AA' and by['Apollo']['tier'] != 3
    assert by['Chang Heng']['tier'] != 3
    assert by['Surveyor']['tier'] == 3          # LF, named for the craft


def test_apollonius_11_traverse_features_are_tier_3_with_missions(records):
    lf = {r['name']: r for r in labels.curate(records) if r['tier'] == 3}
    for name in ('West', 'Little West', 'Double', 'Mount Marilyn'):
        assert name in lf, name
        assert labels.mission_of(next(r for r in labels.curate(records)
                                      if r['name'] == name)) == 'Apollo 11'
    assert all(labels.mission_of(r) for r in
               [x for x in labels.curate(records) if x['tier'] == 3])


def test_all_81_astronaut_named_features_survive_any_prune(records):
    kept, stats = labels.curate(records, 70.0, budget=600, return_stats=True)
    unpruned = labels.curate(records, 70.0, budget=10_000)
    assert sum(1 for r in unpruned if r['tier'] == 3) == 81
    assert stats['by_tier']['3'] == 81
    assert stats['curated'] == 600
    # The prune must come out of tier 2 only, and must take the smallest first.
    dropped = [r for r in unpruned if r not in kept]
    assert all(r['tier'] == 2 for r in dropped)
    assert max(r['diameter'] or 0 for r in dropped) <= min(
        r['diameter'] or 0 for r in kept if r['tier'] == 2)
```

- [ ] **Step 3: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_labels.py -q`
Expected: `ModuleNotFoundError: No module named 'labels'`.

- [ ] **Step 4: Implement `scripts/labels.py`**

```python
"""IAU Gazetteer of Planetary Nomenclature -> curated label set (spec §4.1).

The shipped .prj is GCS_Moon_2000 with flattening 0.0, and USGS states the
exports are east-longitude planetocentric, so no planetographic->planetocentric
conversion is needed. The only transform is 0-360 -> +/-180.
"""
from __future__ import annotations
import json
import re
import sys
import zipfile
from pathlib import Path
import shapefile

# Verified against the shipped DBF: every name below exists in the gazetteer.
# 'Mare Aestuum', 'Mare Anglia' and 'South Pole-Aitken Basin' are NOT IAU entries
# and must not be added back.
TIER0_NAMES = {
    'Oceanus Procellarum', 'Mare Imbrium', 'Mare Serenitatis',
    'Mare Tranquillitatis', 'Mare Crisium', 'Mare Fecunditatis',
    'Mare Nubium', 'Mare Humorum', 'Mare Vaporum', 'Mare Nectaris',
    'Mare Marginis', 'Mare Orientale', 'Mare Moscoviense', 'Mare Frigoris',
    'Mare Cognitum', 'Mare Insularum', 'Mare Smythii',
}
# Famous-but-small features, tiered by significance rather than diameter.
# Kepler is 29 km and Aristarchus 40 km, so without this list they would be
# filtered out by the 70 km cut.
TIER1_ALWAYS = {'Tycho', 'Copernicus', 'Kepler', 'Aristarchus', 'Plato',
                'Sinus Iridum', 'Mons Huygens', 'Mons Rümker', 'Vallis Alpes',
                'Rima Hadley'}
# Real IAU descriptor codes read from the fixture:
#   SF satellite crater (7,064)  AA crater (1,615)  RI rima (112)
#   LF astronaut-named (81)      MO mons (58)       DO dorsum (39)
#   ME mare (22)                 LC lacus (21)      CA catena (20)
#   VA vallis (14)               SI sinus (12)      PR promontorium (9)
#   RU rupes (8)                 PL planitia
MARE_CODES = {'ME', 'OC', 'SI', 'LC', 'PR', 'PL'}
LINE_CODES = {'RI', 'VA', 'CA', 'DO', 'RU'}
SATELLITE_CODE = 'SF'
ASTRONAUT_CODE = 'LF'
TIER1_MIN_CRATER_KM = 150.0
TIER1_MIN_MONTES_KM = 200.0
TIER2_MIN_LINE_KM = 100.0
# Tier 2 is pruned first when the budget binds; tier 3 (visit features) last.
DROP_ORDER = {2: 0, 1: 1, 0: 2, 3: 3}
MISSION_RE = re.compile(r'(Apollo \d+|Surveyor \d+|Luna \d+|Chang\u2019e \d+)')

# USGS data-quality defects, pinned as of the 2026 nightly export. These 20
# records have a centre that does not fall inside their own bbox: 19 are
# sub-0.5-degree rounding artefacts (12 of them curated tier-3 traverse
# features), 'Brill' straddles the +/-180 vs 0-360 convention, and
# 'Statio Tianhe' carries a genuine 90.9-degree sign error upstream.
# This list is the single source of truth for both the pipeline guard and the
# test, so the two cannot drift.
KNOWN_BBOX_DEFECTS = frozenset({
    'Mons Agnes', 'Short', 'Taruntius A', 'Rook C', 'Barsoe', 'Snap',
    'Liaison', 'Bican F', 'Chabac F', 'Nansen-Apollo', 'Doublet', 'Block',
    'Weird', 'Halo', 'Head', 'Flank', 'Bench', 'Surveyor', 'Little West',
    'Double', 'Statio Tianhe', 'Brill', 'Middle Crescent', 'West',
    'Mount Marilyn',
})


def bbox_defects(records) -> dict[str, float]:
    """Centres outside their own bbox, in degrees of deviation.

    Longitude is compared in a single wrapped frame so a box that legitimately
    crosses the antimeridian is not reported as a defect.
    """
    out = {}
    for r in records:
        if not r.get('name') or r.get('min_lon') is None or r.get('center_lon') is None:
            continue
        if r.get('min_lat') is not None and not (
            r['min_lat'] - 1e-6 <= r['center_lat'] <= r['max_lat'] + 1e-6
        ):
            out[r['name']] = 91.0
            continue
        lo, hi, c = r['min_lon'], r['max_lon'], r['center_lon']
        for shift in (0.0, -360.0, 360.0):
            if lo + shift - 1e-6 <= c + shift <= hi + shift + 1e-6:
                break
        else:
            dev = min(abs(c - lo), abs(c - hi))
            if lo > hi:  # box spans the seam; measure against the wrapped edge
                dev = min(dev, abs(c - (lo - 360.0)), abs(c - (hi + 360.0)))
            out[r['name']] = dev
    return out


def bbox_contains(bbox, lon: float, lat: float) -> bool:
    """Containment that honours the wrap convention: west > east means the box
    crosses the antimeridian, and `bbox is None` means 'untrusted, never use'."""
    if not bbox:
        return False
    w, s, e, n = bbox
    if not (s - 1e-6 <= lat <= n + 1e-6):
        return False
    if w <= e:
        return w - 1e-6 <= lon <= e + 1e-6
    return lon >= w - 1e-6 or lon <= e + 1e-6

NUMERIC = ('diameter', 'center_lon', 'center_lat', 'min_lon', 'max_lon',
           'min_lat', 'max_lat')


def load_records(zip_path: str) -> list[dict]:
    dest = Path(zip_path).with_suffix('')
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        z.extractall(dest)
    stem = Path(next(n for n in names if n.lower().endswith('.shp'))).stem
    reader = shapefile.Reader(str(dest / stem))
    fields = [f[0] for f in reader.fields[1:]]
    out = []
    for rec in reader.iterRecords():
        row = {k: (v.strip() if isinstance(v, str) else v) for k, v in zip(fields, rec)}
        for key in NUMERIC:
            try:
                row[key] = float(row[key])
            except (TypeError, ValueError):
                row[key] = None
        out.append(row)
    return out


def wrap_lon(lon) -> float:
    """0-360 positive east -> -180..+180."""
    v = float(lon)
    if v > 180.0:
        v -= 360.0
    elif v < -180.0:
        v += 360.0
    return v


def _is_visit_feature(rec) -> bool:
    """Tier 3 is the IAU 'Astronaut-named features' set (code LF, 81 records),
    whose origin strings read 'Astronaut-named feature, Apollo 17 site.'

    There is deliberately NO name-substring heuristic here: the gazetteer has no
    landing-site entries, and matching on 'Apollo'/'Luna'/'Chang' would wrongly
    promote the crater Apollo, the crater Surveyor and the craters Chang Heng
    and Chang-Ngo (named for astronomers, not missions) into tier 3.
    """
    return (rec.get('code') or '').strip() == ASTRONAUT_CODE


def mission_of(rec):
    origin = rec.get('origin') or ''
    m = MISSION_RE.search(origin)
    return m.group(1) if m else None


def assign_tier(rec, min_crater_km: float):
    """0|1|2|3 = label tier, None = do not label."""
    if _is_visit_feature(rec):
        return 3
    code = (rec.get('code') or '').strip()
    name = rec.get('name') or ''
    dia = rec.get('diameter') or 0.0
    if code == SATELLITE_CODE:
        return None
    if name in TIER0_NAMES:
        return 0
    if name in TIER1_ALWAYS:
        return 1
    if code in MARE_CODES:
        return 1
    if code == 'AA':
        if dia >= TIER1_MIN_CRATER_KM:
            return 1
        if dia >= min_crater_km:
            return 2
        return None
    if code == 'MO':
        if dia >= TIER1_MIN_MONTES_KM:
            return 1
        return 2 if dia >= TIER2_MIN_LINE_KM else None
    if code in LINE_CODES:
        return 2 if dia >= TIER2_MIN_LINE_KM else None
    return None


def curate(records, min_crater_km: float = 70.0, budget: int = 600,
           return_stats: bool = False):
    kept = []
    for rec in records:
        if not rec.get('name') or rec.get('center_lat') is None:
            continue
        tier = assign_tier(rec, min_crater_km)
        if tier is None:
            continue
        row = dict(rec)
        row['tier'] = tier
        kept.append(row)
    if len(kept) > budget:
        ranked = sorted(range(len(kept)),
                        key=lambda i: (DROP_ORDER[kept[i]['tier']],
                                       kept[i].get('diameter') or 0.0))
        drop = set(ranked[: len(kept) - budget])
        kept = [r for i, r in enumerate(kept) if i not in drop]
    if not return_stats:
        return kept
    stats = {
        'total_records': len(records),
        'curated': len(kept),
        'min_crater_km': min_crater_km,
        'budget': budget,
        'by_tier': {str(t): sum(1 for r in kept if r['tier'] == t)
                    for t in (0, 1, 2, 3)},
        'by_code': {},
    }
    for r in kept:
        code = r.get('code') or '?'
        stats['by_code'][code] = stats['by_code'].get(code, 0) + 1
    return kept, stats


def to_features(kept) -> dict:
    feats = []
    for r in kept:
        bbox = None
        if r.get('min_lon') is not None and r['name'] not in KNOWN_BBOX_DEFECTS:
            bbox = [wrap_lon(r['min_lon']), r['min_lat'],
                    wrap_lon(r['max_lon']), r['max_lat']]
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point',
                         'coordinates': [wrap_lon(r['center_lon']), r['center_lat']]},
            'properties': {
                'name': r['name'],
                'gloss': (r.get('origin') or '').strip('"'),
                'type': r.get('type') or '',
                'code': r.get('code') or '',
                'tier': r['tier'],
                'diameterKm': r.get('diameter'),
                'bbox': bbox,
                'quad': r.get('quad_code') or '',
                'approval': (r.get('approvaldt') or '')[:10],
                'mission': mission_of(r) if r['tier'] == 3 else None,
                'url': r.get('link') or '',
            },
        })
    return {'type': 'FeatureCollection', 'features': feats}


def main() -> int:
    zip_path = Path('public/data/MOON_nomenclature_center_pts.zip')
    if not zip_path.exists():
        zip_path = Path('tests/fixtures/moon_nomenclature_fixture.zip')
    records = load_records(str(zip_path))
    # spec §5.1 check 1, reclassified as a pinned-regression guard: the shipped
    # USGS data genuinely has 20 such records, so report every one and fail only
    # if the set GROWS. Dropping the check loses the signal; treating upstream
    # data quality as our bug would block the bake forever.
    defects = bbox_defects(records)
    new = sorted(set(defects) - set(KNOWN_BBOX_DEFECTS))
    print(f'bbox defects: {len(defects)} found, '
          f'{len(KNOWN_BBOX_DEFECTS)} known, {len(new)} new')
    for name in sorted(defects):
        tag = 'NEW' if name in new else 'known'
        print(f'  {tag:5} {name} ({defects[name]:.3f} deg)')
    if new:
        print('FAIL: new centre-outside-bbox records; verify before shipping',
              file=sys.stderr)
        return 2
    kept, stats = curate(records, return_stats=True)
    out = Path('public/data/features.json')
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(to_features(kept), ensure_ascii=False),
                   encoding='utf-8')
    print(json.dumps(stats, indent=1))
    print(f'wrote {out} ({out.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

Before running Step 5, verify the `code` values actually used above against the fixture and correct the constant sets if the data disagrees:

```bash
.venv/Scripts/python.exe -c "
import sys; sys.path.insert(0,'scripts')
import labels
from collections import Counter
recs=labels.load_records('tests/fixtures/moon_nomenclature_fixture.zip')
print('codes:', Counter(r['code'] for r in recs).most_common(24))
print('types:', Counter(r['type'] for r in recs).most_common(14))
"
```

The tests `test_all_22_maria_survive_curation` and `test_satellite_features_are_dropped` are the pins: if `code` for a mare is not `ME`, or the satellite type string differs, fix the sets in `labels.py`, not the assertions.

- [ ] **Step 5: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_labels.py -q`
Expected: 12 passed.

- [ ] **Step 6: Extend `src/types.ts` with the shapes the app consumes**

Task 2 created this file with only the three union types. Replace its whole contents with the file below, which keeps those three lines verbatim and adds the serialized shapes:

```ts
export type Tier = 0 | 1 | 2 | 3;
/** Owned here, not by moon.ts. `probe` is the Task 2 gate fixture. */
export type LayerName = 'paper' | 'photo' | 'probe';
export type Mode = 'globe' | 'paper';

export interface FeatureProps {
  name: string;
  gloss: string;
  type: string;
  code: string;
  tier: Tier;
  diameterKm: number | null;
  bbox: [number, number, number, number] | null;
  quad: string;
  approval: string;
  /** Set only for tier 3 astronaut-named features, e.g. 'Apollo 11'. */
  mission: string | null;
  url: string;
}

export interface Feature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: FeatureProps;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

export interface SourceRecord {
  name: string;
  bytes: number;
  sha256: string;
  url?: string;
  role: string;
  reused?: boolean;
}

export interface Manifest {
  schema: number;
  generatedAt: string;
  grid: {
    tileSize: number;
    colsFactor: string;
    rowsFactor: string;
    yOrigin: 'north';
    lonDomain: '180';
    latitudeType: 'planetocentric';
    radiusMeters: number;
    flattening: number;
    prjWkt: string;
  };
  levels: { L: number; cols: number; rows: number; mPerPx: number }[];
  sources: SourceRecord[];
  layers: Record<string, {
    top: number;
    tiles: number;
    bytes: number;
    quality: number;
    photometric: string;
    detailGain: number | null;
  }>;
  albedoHistogram?: {
    level: number; mean: number; p33: number; p67: number; samples: number;
  };
  labels?: {
    total: number; curated: number; min_crater_km: number; budget: number;
    by_tier: Record<string, number>; by_code: Record<string, number>;
  };
  geometryProof?: {
    passed: boolean; mareMedian: number; highlandMedian: number;
    checks: Record<string, string>; failures: string[];
  };
  timings: Record<string, number>;
}

export const DEFAULT_MODE: Mode = 'globe';
export const DEFAULT_LAYER: LayerName = 'photo';
```

- [ ] **Step 7: Commit**

```bash
git add scripts/labels.py src/types.ts scripts/tests/test_labels.py tests/fixtures/moon_nomenclature_fixture.zip
git commit -m "feat: curated IAU label tiers with bbox self-check and pruning budget"
```

---

## Task 6: Fetch, driver probe, and Stage 0 grid-contract asserts

**Files:**
- Create: `scripts/fetch_data.py`, `scripts/contract.py`, `data/raw/.gitkeep`
- Test: `scripts/tests/test_contract.py`

**Interfaces:**
- Consumes: the three URLs in spec §2.1.
- Produces: `SOURCE_SPECS`, `remote_size(url)`, `download(url, dest, total=None)`, `fetch(spec, force=False)`, `probe_capabilities()`, `MOON_WKT`, `EXPECTED_DETAIL`, `EXPECTED_COLOR`, `read_grid_contract(path)`, `assert_contract(actual, expected)`. Also `data/raw/capabilities.json` and `data/raw/sha256.json`.

- [ ] **Step 1: Write the failing contract tests**

`scripts/tests/test_contract.py`:

```python
import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract

W, H = 1212, 606           # 2:1 global grid at 3.36667 px/deg
PX_PER_DEG = W / 360.0


def make_grid(tmp_path, name, west, north, count=1, georef=True):
    path = tmp_path / name
    t = from_bounds(west, north - 180.0, west + 360.0, north, W, H)
    kw = dict(driver='GTiff', width=W, height=H, count=count, dtype='uint8')
    if georef:
        kw.update(crs=CRS.from_wkt(contract.MOON_WKT), transform=t)
    with rasterio.open(path, 'w', **kw) as ds:
        for b in range(1, count + 1):
            ds.write(np.full((H, W), 90 + b, np.uint8), b)
    return str(path)


SMALL_EXPECTED = {'width': W, 'height': H, 'count': 1,
                  'pxPerDeg': PX_PER_DEG, 'dtype': 'uint8', 'tol': 1e-6}


def test_accepts_the_corner_origin_convention(tmp_path):
    c = contract.read_grid_contract(make_grid(tmp_path, 'corner.tif', -180.0, 90.0))
    assert c['originConvention'] == 'corner'
    assert c['gridReadFrom'] == 'raster'
    assert (c['west'], c['north'], c['east'], c['south']) == pytest.approx(
        (-180.0, 90.0, 180.0, -90.0))
    contract.assert_contract(c, SMALL_EXPECTED)


def test_accepts_and_normalises_the_pixel_centre_origin(tmp_path):
    # This is exactly what GDAL reports for the Kakadu/GMLJP2 mosaic:
    # origin -179.998351105 89.998351105 at 0.00329779 deg/px.
    half = 0.5 / PX_PER_DEG
    c = contract.read_grid_contract(
        make_grid(tmp_path, 'centre.tif', -180.0 + half, 90.0 - half))
    assert c['originConvention'] == 'centre'
    assert c['west'] == pytest.approx(-180.0)
    assert c['north'] == pytest.approx(90.0)
    assert c['pxPerDeg'] == pytest.approx(PX_PER_DEG)
    contract.assert_contract(c, SMALL_EXPECTED)


def test_rejects_a_mispositioned_origin(tmp_path):
    p = make_grid(tmp_path, 'off.tif', -179.0, 90.0)
    with pytest.raises(AssertionError, match='origin'):
        contract.read_grid_contract(p)


def test_rejects_a_grid_that_is_not_two_to_one(tmp_path):
    path = tmp_path / 'bad.tif'
    with rasterio.open(path, 'w', driver='GTiff', width=1000, height=600,
                       count=1, dtype='uint8',
                       transform=from_bounds(-180, -90, 180, 90, 1000, 600),
                       crs=CRS.from_wkt(contract.MOON_WKT)) as ds:
        ds.write(np.zeros((600, 1000), np.uint8), 1)
    with pytest.raises(AssertionError, match='2:1'):
        contract.read_grid_contract(str(path))


def test_unreferenced_raster_gets_an_assigned_grid_and_says_so(tmp_path):
    p = make_grid(tmp_path, 'plain.tif', 0.0, 0.0, count=4, georef=False)
    c = contract.read_grid_contract(p)
    assert c['gridReadFrom'] == 'assigned'
    assert c['count'] == 4
    assert c['pxPerDeg'] == pytest.approx(PX_PER_DEG)
    assert c['west'] == pytest.approx(-180.0)


def test_assert_contract_names_the_offending_key(tmp_path):
    c = contract.read_grid_contract(make_grid(tmp_path, 'corner.tif', -180.0, 90.0))
    c['count'] = 3
    with pytest.raises(AssertionError, match='count'):
        contract.assert_contract(c, SMALL_EXPECTED)


def test_real_expected_numbers_match_the_spec_table():
    assert contract.EXPECTED_DETAIL['width'] == 109164
    assert contract.EXPECTED_DETAIL['height'] == 54582
    assert contract.EXPECTED_DETAIL['count'] == 1
    assert contract.EXPECTED_DETAIL['pxPerDeg'] == pytest.approx(303.233, abs=1e-3)
    assert contract.EXPECTED_COLOR['width'] == 27360
    assert contract.EXPECTED_COLOR['height'] == 13680
    assert contract.EXPECTED_COLOR['count'] == 4
    assert contract.EXPECTED_COLOR['pxPerDeg'] == pytest.approx(76.0)
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_contract.py -q`
Expected: `ModuleNotFoundError: No module named 'contract'`.

- [ ] **Step 3: Implement `scripts/contract.py`**

```python
"""Stage 0: read each source's grid and assert it is the grid the spec claims.

Verified from the files themselves:
  * the detail JP2 embeds GMLJP2 + a GeoTIFF uuid box (origin -179.998351105
    89.998351105, offset 0.00329779 deg/px, CRS GCS_Moon_2000, Kakadu v6.1.1),
    so GDAL reads its georeference directly and no .j2w is needed;
  * the SVS colour TIFF has NO GeoTIFF keys (its IFD0 has 19 entries, none of
    33550/33920/33922), so its grid is *assigned* from the global extent and
    validated by aspect ratio only.
Both origins are normalised to pixel-corner form, and the convention used is
recorded rather than assumed.
"""
from __future__ import annotations
import rasterio

MOON_WKT = (
    'GEOGCS["GCS_Moon_2000",DATUM["D_Moon_2000",'
    'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],'
    'UNIT["Degree",0.0174532925199433]]'
)

EXPECTED_DETAIL = {'width': 109164, 'height': 54582, 'count': 1,
                   'pxPerDeg': 303.233, 'dtype': 'uint8', 'tol': 2e-3}
EXPECTED_COLOR = {'width': 27360, 'height': 13680, 'count': 4,
                  'pxPerDeg': 76.0, 'dtype': 'uint8', 'tol': 1e-6}


def _normalise_origin(west, north, px_per_deg):
    half = 0.5 / px_per_deg
    if abs(west + 180.0) <= 1e-9 and abs(north - 90.0) <= 1e-9:
        return -180.0, 90.0, 'corner'
    if abs(west - (-180.0 + half)) <= 1e-9 and abs(north - (90.0 - half)) <= 1e-9:
        return -180.0, 90.0, 'centre'
    raise AssertionError(
        f'grid origin {west!r}, {north!r} is neither corner- nor centre-referenced '
        f'for a global extent (half pixel = {half:.9f} deg)')


def read_grid_contract(path: str) -> dict:
    with rasterio.open(path) as ds:
        t = ds.transform
        referenced = bool(ds.crs) or (t is not None and not t.is_identity)
        if referenced:
            px_per_deg = 1.0 / abs(t.a)
            west, north, convention = _normalise_origin(t.c, t.f, px_per_deg)
            source = 'raster'
        else:
            px_per_deg = ds.width / 360.0
            west, north, convention = -180.0, 90.0, 'assigned'
            source = 'assigned'
        c = {
            'path': path, 'driver': ds.driver, 'width': ds.width,
            'height': ds.height, 'count': ds.count, 'dtype': ds.dtypes[0],
            'pxPerDeg': px_per_deg, 'west': west, 'north': north,
            'east': west + ds.width / px_per_deg,
            'south': north - ds.height / px_per_deg,
            'originConvention': convention, 'gridReadFrom': source,
            'crs': str(ds.crs), 'nodata': list(ds.nodata),
        }
    aspect_err = abs(c['width'] / 360.0 - c['height'] / 180.0)
    if aspect_err > max(1.0, 0.002 * c['width']):
        raise AssertionError(
            f'{path}: not a 2:1 global grid ({c["width"]}x{c["height"]}, '
            f'px/deg lon {c["width"]/360:.6f} vs lat {c["height"]/180:.6f})')
    return c


def assert_contract(actual: dict, expected: dict) -> None:
    tol = expected.get('tol', 0.0)
    for key in ('width', 'height', 'count', 'dtype'):
        if actual[key] != expected[key]:
            raise AssertionError(
                f"{key}: got {actual[key]!r} expected {expected[key]!r} "
                f"({actual['path']})")
    if abs(actual['pxPerDeg'] - expected['pxPerDeg']) > tol:
        raise AssertionError(
            f"pxPerDeg: got {actual['pxPerDeg']:.6f} expected "
            f"{expected['pxPerDeg']:.6f} tol {tol} ({actual['path']})")
    for key, want in (('west', -180.0), ('north', 90.0),
                      ('east', 180.0), ('south', -90.0)):
        if abs(actual[key] - want) > 1e-6:
            raise AssertionError(
                f'{key}: got {actual[key]!r} expected {want!r} ({actual["path"]})')
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_contract.py -q`
Expected: 8 passed.

- [ ] **Step 5: Implement `scripts/fetch_data.py`**

```python
"""Ranged, resumable, size- and hash-verified download of the three sources."""
from __future__ import annotations
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

RAW = Path('data/raw')
MOSAIC = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic'

SOURCE_SPECS = [
    {'role': 'detail', 'name': 'LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
     'url': f'{MOSAIC}/LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
     'bytes': 2_500_331_610,
     'sidecars': [f'{MOSAIC}/LRO_WAC_Mosaic_Global_303ppd_v3.jp2.aux.xml']},
    {'role': 'detail_fallback',
     'name': 'Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif',
     'url': f'{MOSAIC}/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif',
     'bytes': 5_959_263_751, 'optional': True, 'sidecars': []},
    {'role': 'color', 'name': 'lroc_color_poles.tif',
     'url': 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles.tif',
     'bytes': 518_090_428, 'sidecars': []},
    {'role': 'labels', 'name': 'MOON_nomenclature_center_pts.zip',
     'url': 'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip',
     'bytes': 23_845_070, 'sidecars': []},
]


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=120) as r:
        value = r.headers.get('Content-Length')
    return int(value) if value else None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, total: int | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    have = tmp.stat().st_size if tmp.exists() else 0
    if total is None:
        total = remote_size(url)
    if total is None:
        raise SystemExit(f'{url}: no Content-Length; refusing to guess a size')
    if have >= total:
        tmp.replace(dest)
        return dest
    headers = {'Range': f'bytes={have}-'} if have else {}
    with urllib.request.urlopen(
            urllib.request.Request(url, headers), timeout=900) as r:
        if have and r.status != 206:
            raise SystemExit(f'{url}: server ignored Range (status {r.status}); '
                             'delete the .part file and re-run')
        with tmp.open('ab' if have else 'wb') as f:
            got = have
            while True:
                chunk = r.read(1 << 22)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if got - have < (1 << 20) or got % (1 << 27) < (1 << 22):
                    print(f'  {dest.name}: {got/1e6:.0f}/{total/1e6:.0f} MB',
                          flush=True)
    if got != total:
        raise SystemExit(f'{url}: truncated at {got} of {total} bytes — re-run to resume')
    tmp.replace(dest)
    return dest


def fetch(spec, force=False) -> dict:
    dest = RAW / spec['name']
    if dest.exists() and not force:
        if dest.stat().st_size == spec['bytes']:
            digest = sha256(dest)
            print(f'have  {spec["name"]} ({dest.stat().st_size:,} B, sha256 {digest[:12]}…)')
            return {'name': spec['name'], 'url': spec['url'], 'role': spec['role'],
                    'bytes': dest.stat().st_size, 'sha256': digest, 'reused': True}
        print(f'      {spec["name"]} is the wrong size; re-downloading')
    total = remote_size(spec['url'])
    if total and spec['bytes'] and total != spec['bytes']:
        print(f'note  {spec["name"]}: Content-Length {total:,} differs from the '
              f'spec value {spec["bytes"]:,}; trusting the server')
    download(spec['url'], dest, total)
    if dest.stat().st_size != total:
        raise SystemExit(f'{spec["name"]}: {dest.stat().st_size:,} != Content-Length {total:,}')
    for url in spec['sidecars']:
        download(url, RAW / Path(url).name)
    print(f'gave  {spec["name"]} ({dest.stat().st_size:,} B)')
    return {'name': spec['name'], 'url': spec['url'], 'role': spec['role'],
            'bytes': dest.stat().st_size, 'sha256': sha256(dest)}


def probe_capabilities() -> dict:
    import rasterio
    out = {'rasterio': rasterio.__version__, 'drivers': {}}
    for spec in SOURCE_SPECS:
        path = RAW / spec['name']
        if not path.exists():
            continue
        try:
            with rasterio.open(path) as ds:
                rec = {'open': True, 'shape': list(ds.shape), 'count': ds.count,
                       'dtypes': list(ds.dtypes), 'crs': str(ds.crs),
                       'transform': list(ds.transform), 'driver': ds.driver}
                win = ds.read(1, window=((0, 64), (0, 64)))
                rec.update(decode_min=int(win.min()), decode_max=int(win.max()))
            out['drivers'][spec['role']] = rec
        except Exception as exc:
            out['drivers'][spec['role']] = {
                'open': False, 'error': f'{type(exc).__name__}: {exc}'}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--only', default='',
                    help='comma-separated roles, e.g. detail_fallback,color,labels')
    a = ap.parse_args()
    wanted = {s.strip() for s in a.only.split(',') if s.strip()}
    records = []
    for spec in SOURCE_SPECS:
        if wanted and spec['role'] not in wanted:
            continue
        if spec.get('optional') and not wanted:
            print(f'skip  {spec["name"]} (only needed if the JP2 driver fails)')
            continue
        records.append(fetch(spec, a.force))
    caps = probe_capabilities()
    (RAW / 'sha256.json').write_text(json.dumps(records, indent=1))
    (RAW / 'capabilities.json').write_text(json.dumps(caps, indent=1, default=str))
    print(json.dumps(caps, indent=1, default=str))
    detail = caps['drivers'].get('detail') or {}
    if wanted and 'detail' not in wanted:
        return 0
    if not detail.get('open'):
        print('!! detail source unreadable with this GDAL build. Re-run: '
              'npm run fetch -- --only detail_fallback,color,labels '
              'then bake with --detail data/raw/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif')
        return 3
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 6: Download the real sources — this is the 3.04 GB step**

```bash
mkdir -p data/raw && touch data/raw/.gitkeep
npm run fetch 2>&1 | tee docs/superpowers/specs/fetch-log.md
```

Expected: `detail` 2,500,331,610 B, `color` 518,090,428 B, `labels` 23,845,070 B, then a capabilities dump with `detail.open: true`, `shape: [54582, 109164]`, `count: 1`, and exit 0. If it exits 3, run `npm run fetch -- --only detail_fallback,color,labels` and record that the fallback source is in use.

- [ ] **Step 7: Verify the real grid contracts**

```bash
.venv/Scripts/python.exe -c "
import sys; sys.path.insert(0,'scripts')
import contract, json
for role, name, exp in (
    ('detail','data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2',contract.EXPECTED_DETAIL),
    ('color','data/raw/lroc_color_poles.tif',contract.EXPECTED_COLOR)):
    c = contract.read_grid_contract(name)
    contract.assert_contract(c, exp)
    print(role, {k: c[k] for k in ('driver','width','height','count','pxPerDeg','gridReadFrom','originConvention')})
print('STAGE 0 OK')
" | tee -a docs/superpowers/specs/fetch-log.md
```

Expected: `STAGE 0 OK`, `detail.gridReadFrom == 'raster'`, `color.gridReadFrom == 'assigned'`. If `detail.gridReadFrom` is `assigned`, the embedded georeference did not load — check that `data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2.aux.xml` sits next to the JP2 (GDAL reads that PAM sidecar automatically) and do not proceed until it reads `raster`.

- [ ] **Step 8: Resolve the colour file's alpha band, which the spec left open**

```bash
.venv/Scripts/python.exe -c "
import rasterio, numpy as np
ds = rasterio.open('data/raw/lroc_color_poles.tif')
a = ds.read(4, window=((0,400),(0,400)))
print('alpha min', int(a.min()), 'max', int(a.max()), 'frac 255:', float((a==255).mean()))
rgb = ds.read([1,2,3], window=((0,400),(0,400)))
print('rgb mean per band:', [round(float(v),2) for v in rgb.mean(axis=(1,2))])
print('rows 0-400 (north pole) rgb mean:', [round(float(v),2) for v in rgb.mean(axis=(1,2))])
" | tee -a docs/superpowers/specs/fetch-log.md
```

If the fraction of alpha == 255 is 1.0, drop band 4 (the bake already reads only bands 1–3). If it is below 1.0, the alpha band is meaningful: add `flatten_alpha(rgb, alpha, background=64) -> rgb` to `scripts/composite.py` with a test that a fully transparent pixel becomes the background and an opaque pixel is unchanged, and call it in `bake.bake_top` before `chroma_detail`. Record which branch you took in `fetch-log.md`.

- [ ] **Step 9: Commit**

```bash
git add scripts/fetch_data.py scripts/contract.py scripts/tests/test_contract.py data/raw/.gitkeep docs/superpowers/specs/fetch-log.md
git commit -m "feat: verified source fetch with Stage 0 grid-contract asserts"
```

---

## Task 7: Bake the pyramid on synthetic data first

Prove the whole band → tile → parent chain in seconds on a fake source before spending hours on the real one.

**Files:**
- Create: `scripts/bake.py`, `scripts/derive.py`, `scripts/manifest.py`
- Test: `scripts/tests/test_bake_synthetic.py`
- Modify: `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md`

**Interfaces:**
- Consumes: `grid`, `composite.chroma_detail`, `contract`.
- Produces: `bake.read_world_rows(ds, L, wr0, wr1, indexes, resampling) -> ndarray`; `bake.bake_top(detail, color, layer, L, band_rows, k, out_dir, quality, force, sigma, radius) -> int`; `bake.run(**kwargs) -> int`; `bake.estimate(top, layers) -> dict`; `derive.parent_from_children([NW,NE,SW,SE]) -> ndarray`; `derive.derive_levels(out_dir, layer, top, quality, save_tile) -> int`; `manifest.base_manifest() -> dict`; `manifest.write_manifest(path, data) -> Path`.

- [ ] **Step 1: Write the failing synthetic end-to-end tests**

`scripts/tests/test_bake_synthetic.py`:

```python
import json
import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract
import derive
import grid

SRC_W, SRC_H = 1024, 512
WKT = contract.MOON_WKT


def write_raster(path, array, west=-180.0, north=90.0):
    count = array.shape[2] if array.ndim == 3 else 1
    t = from_bounds(west, north - 180.0, west + 360.0, north,
                    array.shape[1], array.shape[0])
    with rasterio.open(path, 'w', driver='GTiff', width=array.shape[1],
                       height=array.shape[0], count=count, dtype='uint8',
                       crs=CRS.from_wkt(WKT), transform=t) as ds:
        for b in range(count):
            ds.write(array[..., b] if count > 1 else array, b + 1)
    return str(path)


@pytest.fixture
def sources(tmp_path):
    """Detail: dark band straddling lon=+-180, bright elsewhere (a seam test).
    Colour: a warm flat tone with an alpha of 255."""
    yy, xx = np.mgrid[0:SRC_H, 0:SRC_W]
    seam = (xx < SRC_W // 8) | (xx >= 7 * SRC_W // 8)
    detail = np.where(seam, 30, 200).astype(np.uint8)
    colour = np.dstack([
        np.full((SRC_H, SRC_W), 190, np.uint8),
        np.full((SRC_H, SRC_W), 170, np.uint8),
        np.full((SRC_H, SRC_W), 150, np.uint8),
        np.full((SRC_H, SRC_W), 255, np.uint8),
    ])
    d = write_raster(tmp_path / 'detail.tif', detail)
    c = write_raster(tmp_path / 'colour.tif', colour)
    return d, c


def bake_kwargs(sources, out, **over):
    d, c = sources
    kw = dict(detail=d, color=c, layers=('paper', 'photo'), top=1, quality=95,
              band_rows=512, k=0.4, out_dir=str(out), force=True)
    kw.update(over)
    return kw


def test_tile_counts_are_exact(sources, tmp_path):
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out))
    for layer in ('paper', 'photo'):
        assert len(list((out / layer / '0').rglob('*.jpg'))) == 2
        assert len(list((out / layer / '1').rglob('*.jpg'))) == 8


def test_band_rows_must_align_to_tiles(sources, tmp_path):
    import bake
    with pytest.raises(ValueError, match='multiple'):
        bake.run(**bake_kwargs(sources, tmp_path / 'x', band_rows=300))


def test_parent_equals_box_average_of_children(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('photo',), quality=100, k=0.0))
    kids = [np.array(Image.open(out / 'photo' / '1' / str(x) / f'{y}.jpg'))
            for (x, y) in [(0, 0), (1, 0), (0, 1), (1, 1)]]
    parent = derive.parent_from_children(kids)
    on_disk = np.array(Image.open(out / 'photo' / '0' / '0' / '0.jpg'))
    assert int(np.abs(parent.astype(np.int32) - on_disk.astype(np.int32)).max()) <= 2


def test_seam_is_continuous_across_the_antimeridian(sources, tmp_path):
    """The dark band straddles lon=+-180, so both tiles touching the seam must
    read the same mean at their facing edges. A non-periodic blur would differ."""
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('photo',), k=1.0, sigma=2.5))
    cols = grid.level_cols(1)
    left = np.array(Image.open(out / 'photo' / '1' / '0' / '0.jpg'))
    right = np.array(Image.open(out / 'photo' / '1' / str(cols - 1) / '0.jpg'))
    assert abs(int(left[:, -8:].mean()) - int(right[:, :8].mean())) <= 2


def test_rerun_writes_nothing(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    before = len(list(out.rglob('*.jpg')))
    again = bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0, force=False))
    assert again == 0
    assert len(list(out.rglob('*.jpg'))) == before


def test_manifest_records_measured_numbers(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    m = json.loads((out / 'manifest.json').read_text())
    assert m['schema'] == 1
    assert m['grid']['tileSize'] == grid.TILE
    assert m['grid']['radiusMeters'] == 1737400.0
    assert m['grid']['yOrigin'] == 'north'
    assert m['layers']['paper']['top'] == 0
    assert m['layers']['paper']['tiles'] == 2
    assert m['layers']['paper']['bytes'] > 0
    assert m['levels'][6]['mPerPx'] == pytest.approx(166.6, abs=0.6)


def test_estimate_grows_superlinearly():
    import bake
    a = bake.estimate(6, ('paper', 'photo'))
    b = bake.estimate(7, ('paper', 'photo'))
    assert b['files'] == a['files'] + 2 * grid.level_cols(7) * grid.level_rows(7)
    assert b['bytes'] > a['bytes'] * 2
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_bake_synthetic.py -q`
Expected: `ModuleNotFoundError: No module named 'bake'`.

- [ ] **Step 3: Implement `scripts/manifest.py` and `scripts/derive.py`**

`scripts/manifest.py`:

```python
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
import grid


def base_manifest() -> dict:
    return {
        'schema': 1,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'grid': {
            'tileSize': grid.TILE,
            'colsFactor': '2^(L+1)',
            'rowsFactor': '2^L',
            'yOrigin': 'north',
            'lonDomain': '180',
            'latitudeType': 'planetocentric',
            'radiusMeters': grid.MOON_RADIUS_M,
            'flattening': 0.0,
            'prjWkt': (
                'GEOGCS["GCS_Moon_2000",DATUM["D_Moon_2000",'
                'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0],'
                'PRIMEM["Reference_Meridian",0.0],'
                'UNIT["Degree",0.0174532925199433]]'),
        },
        'levels': [{'L': L, 'cols': grid.level_cols(L), 'rows': grid.level_rows(L),
                    'mPerPx': round(grid.m_per_px(L), 2)} for L in range(8)],
        'sources': [],
        'layers': {},
        'timings': {},
    }


def write_manifest(path, data: dict) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=1))
    return p
```

`scripts/derive.py`:

```python
"""Derive each level from the level below by 2x2 box averages of four tiles.

Every parent has exactly four children at every level (a level has twice the
columns and rows of the one below, and level 0 is the base case), so there is no
partial-child special case to get wrong. Parents come from decoded JPEG, so they
are marginally softer than a fresh source read would give; in exchange parent
and child are geometrically identical, which is what stops cross-level flicker.
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image
import grid


def parent_from_children(kids) -> np.ndarray:
    nw, ne, sw, se = kids
    top = np.concatenate([nw, ne], axis=1)
    bot = np.concatenate([sw, se], axis=1)
    big = np.concatenate([top, bot], axis=0).astype(np.float32)
    h, w = big.shape[0], big.shape[1]
    if big.ndim == 2:
        p = big.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    else:
        p = big.reshape(h // 2, 2, w // 2, 2, big.shape[2]).mean(axis=(1, 3))
    return np.clip(np.rint(p), 0.0, 255.0).astype(np.uint8)


def read_tile(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path))


def derive_levels(out_dir, layer: str, top: int, quality: int,
                  save_tile) -> int:
    out = Path(out_dir) / layer
    written = 0
    for L in range(top, 0, -1):
        cols, rows = grid.level_cols(L - 1), grid.level_rows(L - 1)
        for py in range(rows):
            for px in range(cols):
                kids = [read_tile(out / str(L) / str(px * 2 + dx) / f'{py * 2 + dy}.jpg')
                        for dy in (0, 1) for dx in (0, 1)]
                arr = parent_from_children(kids)
                if save_tile(out_dir, layer, L - 1, px, py, arr, quality, True):
                    written += 1
    return written
```

- [ ] **Step 4: Implement `scripts/bake.py`**

```python
"""Band-based tile bake (spec §3.1, as amended by plan amendment A)."""
from __future__ import annotations
import argparse
import json
import shutil
import sys
import time
from pathlib import Path
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import Window

import contract
import derive
import grid
import manifest as manifest_mod
from composite import chroma_detail

TILE = grid.TILE
OUT_DEFAULT = 'public/tiles'
# Measured bits/pixel for lunar albedo at q85; Tier A replaces these with the
# real numbers from the manifest after the first bake.
BITS_PER_PIXEL = {'paper': 0.55, 'photo': 1.35}
LEVEL_OF = {}


def read_world_rows(ds, L: int, wr0: int, wr1: int, indexes, resampling: str):
    """Read world rows [wr0, wr1) at level L, resampled to the level's grid.

    Longitude always spans the full width, which is what makes the periodic
    blur in composite.py correct.
    """
    hw = grid.world_px_height(L)
    ww = grid.world_px_width(L)
    sr0 = wr0 / hw * ds.height
    sr1 = wr1 / hw * ds.height
    rows = int(round(wr1 - wr0))
    method = getattr(Resampling, resampling)
    if isinstance(indexes, tuple):
        return ds.read(indexes, window=Window(0.0, sr0, ds.width, sr1 - sr0),
                       out_shape=(len(indexes), rows, ww), resampling=method)
    return ds.read(indexes, window=Window(0.0, sr0, ds.width, sr1 - sr0),
                   out_shape=(rows, ww), resampling=method)


def save_tile(out_dir, layer: str, L: int, x: int, y: int, arr, quality: int,
              force: bool) -> bool:
    d = Path(out_dir) / layer / str(L) / str(x)
    p = d / f'{y}.jpg'
    if p.exists() and not force:
        return False
    d.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr).save(p, quality=quality, optimize=True, exif=b'',
                              icc_profile=None)
    return True


def slice_tiles(out_dir, layer, L, core, ty0, ty1, quality, force):
    ww = grid.world_px_width(L)
    written = 0
    for ty in range(ty0, ty1):
        row = (ty - ty0) * TILE
        for tx in range(ww // TILE):
            tile = core[row:row + TILE, tx * TILE:(tx + 1) * TILE]
            if save_tile(out_dir, layer, L, tx, ty, tile, quality, force):
                written += 1
    return written


def bake_top(detail: str, color: str, layer: str, L: int, band_rows: int, k,
             out_dir, quality: int, force: bool, sigma: float = 2.5,
             radius: int = 8) -> int:
    if band_rows % TILE:
        raise ValueError(f'band-rows must be a multiple of {TILE}, got {band_rows}')
    hw = grid.world_px_height(L)
    written = 0
    with rasterio.open(detail) as ds_d, rasterio.open(color) as ds_c:
        for r0 in range(0, hw, band_rows):
            r1 = min(r0 + band_rows, hw)
            # Extra rows so the Gaussian support sees real data; poles clamp.
            e0, e1 = max(0, r0 - radius), min(hw, r1 + radius)
            off = r0 - e0
            D = read_world_rows(ds_d, L, e0, e1, 1, 'average')
            ty0, ty1 = r0 // TILE, r1 // TILE
            if layer == 'paper':
                written += slice_tiles(out_dir, layer, L, D[off:off + (r1 - r0)],
                                       ty0, ty1, quality, force)
                continue
            B = read_world_rows(ds_c, L, e0, e1, (1, 2, 3), 'bilinear')
            B = np.transpose(B, (1, 2, 0))
            if k is None:
                core = B[off:off + (r1 - r0)]
            else:
                comp = chroma_detail(B, D, k=k, sigma=sigma, radius=radius)
                core = comp[off:off + (r1 - r0)]
            written += slice_tiles(out_dir, layer, L, core, ty0, ty1, quality, force)
    return written


def estimate(top: int, layers) -> dict:
    per_layer = sum(grid.level_cols(L) * grid.level_rows(L)
                    for L in range(top + 1))
    files = per_layer * len(layers)
    bytes_ = int(sum(per_layer * TILE * TILE * BITS_PER_PIXEL[l] / 8.0
                     for l in layers))
    return {'tilesPerLayer': per_layer, 'files': files, 'bytes': bytes_}


def run(detail: str, color: str, layers=('paper', 'photo'), top: int = 6,
        quality: int = 85, band_rows: int = 1024, k=0.4,
        out_dir: str = OUT_DEFAULT, force: bool = False, sigma: float = 2.5,
        radius: int = 8, quiet: bool = False) -> int:
    out = Path(out_dir)
    t0 = time.time()
    written = 0
    for layer in layers:
        if force and (out / layer).exists():
            shutil.rmtree(out / layer)
        n = bake_top(detail, color, layer, top, band_rows, k, out_dir, quality,
                     force, sigma, radius)
        written += n
        if not quiet:
            print(f'{layer}: {n} tiles at level {top}')
        n = derive.derive_levels(out_dir, layer, top, quality, save_tile)
        written += n
        if not quiet:
            print(f'{layer}: {n} parent tiles derived L{top-1}..L0')
    m = manifest_mod.base_manifest()
    for layer in layers:
        files = sorted((out / layer).rglob('*.jpg'))
        m['layers'][layer] = {
            'top': top, 'tiles': len(files),
            'bytes': sum(f.stat().st_size for f in files),
            'quality': quality,
            'photometric': 'MINISBLACK' if layer == 'paper' else 'YCbCr',
            'detailGain': None if layer == 'paper' else k,
        }
    sha = Path('data/raw/sha256.json')
    m['sources'] = json.loads(sha.read_text()) if sha.exists() else []
    m['timings']['bakeSeconds'] = round(time.time() - t0, 1)
    if Path('data/raw/capabilities.json').exists():
        m['capabilities'] = json.loads(
            Path('data/raw/capabilities.json').read_text())
    manifest_mod.write_manifest(out / 'manifest.json', m)
    if not quiet:
        print(f'baked {written} tiles in {m["timings"]["bakeSeconds"]}s -> {out}')
    return written


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--top', type=int, default=6)
    ap.add_argument('--layer', default='both', choices=['paper', 'photo', 'both'])
    ap.add_argument('--detail-gain', dest='k', type=float, default=0.4)
    ap.add_argument('--no-detail', action='store_true')
    ap.add_argument('--quality', type=int, default=85)
    ap.add_argument('--band-rows', type=int, default=1024)
    ap.add_argument('--detail', default='data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2')
    ap.add_argument('--color', default='data/raw/lroc_color_poles.tif')
    ap.add_argument('--out', default=OUT_DEFAULT)
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    if not 0 <= a.top <= grid.MAX_TOP_LEVEL:
        raise SystemExit(f'--top must be 0..{grid.MAX_TOP_LEVEL}')
    layers = ('paper', 'photo') if a.layer == 'both' else (a.layer,)
    est = estimate(a.top, layers)
    free = shutil.disk_usage('.').free
    print(f'top=L{a.top} ({grid.m_per_px(a.top):.1f} m/px) layers={list(layers)}')
    print(f'planned files={est["files"]:,} bytes~={est["bytes"]/1e9:.2f} GB '
          f'disk free={free/1e9:.1f} GB')
    if a.dry_run:
        for path, exp in ((a.detail, contract.EXPECTED_DETAIL),
                          (a.color, contract.EXPECTED_COLOR)):
            p = Path(path)
            if not p.exists():
                print(f'  {p} absent — run npm run fetch first')
                continue
            try:
                c = contract.read_grid_contract(str(p))
                contract.assert_contract(c, exp)
                print(f'  {p.name}: OK {c["width"]}x{c["height"]} '
                      f'{c["pxPerDeg"]:.4f} px/deg from {c["gridReadFrom"]}')
            except (AssertionError, RuntimeError) as exc:
                print(f'  {p.name}: FAIL {exc}')
                return 2
        print('dry run: nothing written')
        return 0
    need = int(1.5 * est['bytes'])
    if free < need:
        raise SystemExit(f'refusing to bake: needs {need/1e9:.2f} GB free, '
                         f'only {free/1e9:.1f} GB available')
    run(detail=a.detail, color=a.color, layers=layers, top=a.top,
        quality=a.quality, band_rows=a.band_rows,
        k=None if a.no_detail else a.k, out_dir=a.out, force=a.force)
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

`derive_levels` receives `save_tile` as an argument rather than importing it from
`bake.py`, because `bake.py` imports `derive.py` and a reverse import would be
circular. Inside `derive_levels` the parent writer always passes `force=True`: a
re-bake of the top level must overwrite the parents it derives, whereas the
top-level writer honours `--force` so a resume can skip existing tiles.

- [ ] **Step 5: Run the synthetic suite to green**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_bake_synthetic.py -q`
Expected: 8 passed. `test_parent_equals_box_average_of_children` uses `quality=100` so the JPEG round trip stays inside ±2; if it exceeds that, the derivation is wrong — do not widen the tolerance.

- [ ] **Step 6: Run the whole suite**

Run: `npm run test`
Expected: vitest green (grid) and pytest green (grid, blur, composite, labels, contract, bake).

- [ ] **Step 7: Amend the spec so §3.1 matches what was built**

In `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md` §3.1: replace Stage 2's `(512 + 2m)²` per-tile bleed with the band description (a band covers the full 360° of longitude at the top level's resolution, extra rows for the kernel, poles clamped), replace Stage 3's wording with `derive_levels` semantics (every parent has exactly four children; level 0 is the base case), and add the line: *Amended 2026-10-06 by plan Task 7 — periodicity lives in the band, not in per-tile window arithmetic.*

- [ ] **Step 8: Commit**

```bash
git add scripts/bake.py scripts/derive.py scripts/manifest.py scripts/tests/test_bake_synthetic.py docs
git commit -m "feat: band-based tile bake with 2x2 parent derivation and manifest"
```

---

## Task 8: Tier A real bake

**Files:**
- Create: `public/tiles/paper/**`, `public/tiles/photo/**` (git-ignored)
- Modify: `public/tiles/manifest.json` (written by the bake), `docs/superpowers/specs/bake-log.md`

**Interfaces:**
- Consumes: `data/raw/` sources, `bake.run`, `--top 6`.
- Produces: the real pyramid, and measured `layers.*.{tiles,bytes}` in the manifest that replaces §3's estimates.

- [ ] **Step 1: Dry run, then a fast low-level bake**

```bash
npm run bake -- --dry-run
npm run bake -- --top 2 --layer both --band-rows 512 --force
```

Expected: the dry run prints both grid contracts as `OK` and writes nothing; the L2 bake writes 2 + 8 + 32 = 42 tiles per layer in a couple of minutes.

- [ ] **Step 2: Inspect the smoke pyramid before spending hours on the real one**

Temporarily point `MoonMap.tsx` at `{ layer: 'photo', top: 2 }` and `{ layer: 'paper', top: 2 }`, screenshot both in globe mode, then the same in `mode: 'paper'`. Expected: recognizable maria on the near side, the crusty highlands on the far side, no streak at lon ±180, no dark notch at the poles, and **not upside down**. Record the four screenshots in `docs/superpowers/specs/bake-log.md`. If it is upside down, G1's `y` finding was wrong: switch the URL template to `{reverseY}` and re-record G1 — no re-bake needed.

- [ ] **Step 3: Bake Tier A**

```bash
time npm run bake -- --top 6 --layer both --band-rows 1024 --force 2>&1 | tee -a docs/superpowers/specs/bake-log.md
du -sh public/tiles/paper public/tiles/photo | tee -a docs/superpowers/specs/bake-log.md
find public/tiles -name '*.jpg' | wc -l
```

Expected: `find` prints **21,844** (2 × 10,922); the manifest records `layers.paper.tiles == 10922` and the same for `photo`. Paste the wall time and byte totals into `bake-log.md`, and note explicitly that spec §3's "~1.0–1.8 GB" estimate is now replaced by the measured figure.

- [ ] **Step 4: Re-measure the estimator so future estimates are not fiction**

```bash
.venv/Scripts/python.exe -c "
import json
m=json.load(open('public/tiles/manifest.json'))
for l,v in m['layers'].items():
    print(l, v['tiles'], v['bytes'], 'bytes/tile=', round(v['bytes']/v['tiles']))
"
```

Update `bake.BITS_PER_PIXEL` to the measured bytes-per-tile for each layer (`bits = bytes*8/(512*512)`), and put a comment above it naming `bake-log.md` as the source. This keeps Task 17's disk guard honest.

- [ ] **Step 5: Commit the manifest and the log, not the tiles**

```bash
git add public/tiles/manifest.json docs/superpowers/specs/bake-log.md scripts/bake.py
git commit -m "feat: bake Tier A tile pyramid to L6 (166.5 m/px)"
```

---

## Task 9: Gate G2 — geometry proof against real imagery

This check proves the projection, the longitude wrap and the `y` direction are all right at the same time. If it fails, stop: everything downstream would sit on a broken map.

**Files:**
- Create: `scripts/proof.py`
- Modify: `public/tiles/manifest.json` (adds `albedoHistogram`, `geometryProof`)
- Test: `scripts/tests/test_proof.py`

**Interfaces:**
- Consumes: `public/tiles/paper/**`, `public/data/features.json`, `grid`.
- Produces: `MARE_CENTRES`, `HIGHLAND_CENTRES`, `PROBE_LEVEL`, `tile_pixel(out_dir, layer, L, lon, lat) -> int`, `albedo_percentiles(out_dir, layer='paper', level=5) -> dict`, `run_proof(out_dir, features_path, level) -> dict`, `main() -> int`.

- [ ] **Step 1: Write the failing proof tests**

`scripts/tests/test_proof.py`:

```python
import json
import sys
from pathlib import Path
import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid
import proof


@pytest.fixture
def indexed_pyramid(tmp_path):
    """Paper tiles filled with a constant equal to 10*x + y, so any lookup error
    shows up as the wrong number rather than as noise."""
    L = 1
    for x in range(grid.level_cols(L)):
        for y in range(grid.level_rows(L)):
            d = tmp_path / 'paper' / str(L) / str(x)
            d.mkdir(parents=True, exist_ok=True)
            Image.fromarray(np.full((grid.TILE, grid.TILE), x * 10 + y, np.uint8)) \
                .save(d / f'{y}.jpg', quality=100)
    return str(tmp_path)


def test_lookup_follows_the_documented_grid(indexed_pyramid):
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -170.0, 80.0) == 0
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 10.0, 80.0) == 10
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -170.0, -10.0) == 1
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 170.0, -10.0) == 31


def test_lookup_is_continuous_across_the_seam(indexed_pyramid):
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 180.0, 80.0) == \
           proof.tile_pixel(indexed_pyramid, 'paper', 1, -180.0, 80.0)


def test_percentiles_come_from_the_requested_level(indexed_pyramid):
    h = proof.albedo_percentiles(indexed_pyramid, 'paper', 1)
    assert h['level'] == 1 and h['samples'] == 8 * grid.TILE * grid.TILE
    assert h['p33'] < h['p67']


def test_check_lists_are_long_enough_to_be_evidence():
    assert len(proof.MARE_CENTRES) >= 15
    assert len(proof.HIGHLAND_CENTRES) >= 15
    assert 'Mare Tranquillitatis' in proof.MARE_CENTRES
    assert 'Tycho' in proof.HIGHLAND_CENTRES


def test_run_proof_reports_failures_not_exceptions_on_synthetic_data(indexed_pyramid):
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [0.0, 0.0]},
         'properties': {'name': 'Mare Tranquillitatis', 'bbox': [-10, -10, 10, 10]}}]}
    fp = Path(indexed_pyramid) / 'features.json'
    fp.write_text(json.dumps(fc))
    res = proof.run_proof(indexed_pyramid, str(fp), level=1)
    assert res['passed'] is False
    assert any('Apollo 11' in f for f in res['failures'])
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python.exe -m pytest scripts/tests/test_proof.py -q`
Expected: `ModuleNotFoundError: No module named 'proof'`.

- [ ] **Step 3: Implement `scripts/proof.py`**

```python
"""Gate G2: falsifiable evidence that imagery and labels agree (spec §5.1).

A vertical flip or a 180 deg longitude error breaks the median-contrast check
with the wrong sign, and misplaced labels break the Apollo 11 placement check,
because the gazetteer supplies centres and bboxes while the imagery supplies
albedo. A sub-pixel offset does not: 100 m of a 333 m sample moves a third of a
pixel, and that risk is pinned by the corner-origin tests in Task 3 instead.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image

import grid
from labels import bbox_contains

MARE_CENTRES = ['Mare Tranquillitatis', 'Mare Imbrium', 'Mare Crisium',
                'Oceanus Procellarum', 'Mare Fecunditatis', 'Mare Nubium',
                'Mare Serenitatis', 'Mare Marginis', 'Mare Humboldtianum',
                'Mare Vaporum', 'Mare Nectaris', 'Mare Frigoris',
                'Mare Cognitum', 'Mare Insularum', 'Mare Orientale',
                'Mare Undarum', 'Mare Smythii', 'Sinus Iridum',
                'Lacus Mortis', 'Lacus Felicitatis']
# Ray and highland craters only. Dark-floored craters (Plato, Grimaldi,
# Wargentin, Posidonius, Gassendi) are deliberately absent because basalt fills
# make them poor bright markers — that is a geological judgement about which
# features are valid inputs, not a threshold tuned until the check passes.
# Every name here was confirmed present in the gazetteer; Hermes, Laplace,
# Brisbane and Mons Hadley are not in this list because they are absent from the
# gazetteer or below the curation cut, so they could never be looked up.
HIGHLAND_CENTRES = ['Tycho', 'Copernicus', 'Kepler', 'Aristarchus', 'Clavius',
                    'Theophilus', 'Langrenus', 'Janssen', 'Maginus',
                    'Ptolemaeus', 'Petavius', 'Piccolomini', 'Regiomontanus',
                    'Avogadro', 'Hermite', 'Cyrano']
# A misregistered map cannot produce this much contrast; a flipped or rotated
# one cannot produce it with the correct sign.
MIN_CONTRAST_DN = 25.0
PROBE_LEVEL = 5


def tile_pixel(out_dir: str, layer: str, L: int, lon: float, lat: float) -> int:
    x = grid.lon_to_tile_x(lon, L)
    y = grid.lat_to_tile_y(lat, L)
    path = Path(out_dir) / layer / str(L) / str(x) / f'{y}.jpg'
    im = np.asarray(Image.open(path).convert('L'))
    wx, wy = grid.world_px_of(lon, lat, L)
    col = min(max(int(wx) - x * grid.TILE, 0), grid.TILE - 1)
    row = min(max(int(wy) - y * grid.TILE, 0), grid.TILE - 1)
    return int(im[row, col])


def albedo_percentiles(out_dir: str, layer: str = 'paper',
                       level: int = PROBE_LEVEL) -> dict:
    arrays = [np.asarray(Image.open(p).convert('L'), dtype=np.float32)
              for p in sorted((Path(out_dir) / layer / str(level)).glob('*/*.jpg'))]
    if not arrays:
        raise SystemExit(f'no paper tiles at level {level} under {out_dir}')
    flat = np.concatenate([a.ravel() for a in arrays])
    return {'level': level, 'mean': round(float(flat.mean()), 2),
            'p33': round(float(np.percentile(flat, 33)), 2),
            'p67': round(float(np.percentile(flat, 67)), 2),
            'samples': int(flat.size)}


def _by_name(features_path: str) -> dict:
    fc = json.loads(Path(features_path).read_text())
    return {f['properties']['name']: f for f in fc['features']}


def run_proof(out_dir: str, features_path: str = 'public/data/features.json',
              level: int = PROBE_LEVEL) -> dict:
    feats = _by_name(features_path)
    hist = albedo_percentiles(out_dir, 'paper', level)
    checks, failures = {}, []

    def sample(names, kind):
        vals = []
        for name in names:
            f = feats.get(name)
            if f is None:
                failures.append(f'{kind} marker absent from the curated set: {name}')
                continue
            lon, lat = f['geometry']['coordinates']
            v = tile_pixel(out_dir, 'paper', level, lon, lat)
            vals.append(v)
            checks[f'{kind}:{name}'] = str(v)
        return vals

    mare = sample(MARE_CENTRES, 'mare')
    high = sample(HIGHLAND_CENTRES, 'highland')

    mare_med = float(np.median(mare)) if mare else float('nan')
    high_med = float(np.median(high)) if high else float('nan')

    if len(mare) < 15 or len(high) < 15:
        failures.append(f'samples too small: mare={len(mare)} highland={len(high)} '
                        f'(need 15 each)')
    else:
        if not mare_med < high_med:
            failures.append(
                f'mare median {mare_med:.1f} is not darker than highland median '
                f'{high_med:.1f}: the map is inverted, rotated 180 deg in longitude, '
                f'or the labels are misplaced')
        contrast = high_med - mare_med
        if contrast < MIN_CONTRAST_DN:
            failures.append(f'contrast {contrast:.1f} DN is below the '
                            f'{MIN_CONTRAST_DN} DN floor')
        if mare_med > hist['mean']:
            failures.append(f'mare median {mare_med:.1f} above the global mean '
                            f'{hist["mean"]}')
        if high_med < hist['mean']:
            failures.append(f'highland median {high_med:.1f} below the global mean '
                            f'{hist["mean"]}')

    # Apollo 11 evidence comes from IAU astronaut-named (code LF) traverse
    # features whose origin names the Apollo 11 site: West, Little West, Double,
    # Mount Marilyn. There is no gazetteer record named "Apollo 11".
    a11 = [f for f in feats.values()
           if (f['properties'].get('mission') or '') == 'Apollo 11']
    if not a11:
        failures.append('no Apollo 11 traverse feature in the curated label set')
    elif 'Mare Tranquillitatis' not in feats:
        failures.append('Mare Tranquillitatis missing, cannot place Apollo 11')
    else:
        w, s, e, n = feats['Mare Tranquillitatis']['properties']['bbox']
        for f in a11:
            name = f['properties']['name']
            lon, lat = f['geometry']['coordinates']
            v = tile_pixel(out_dir, 'paper', level, lon, lat)
            checks[f'apollo11:{name}'] = f'{lon:.4f},{lat:.4f} albedo {v}'
            if not bbox_contains([w, s, e, n], lon, lat):
                failures.append(f'Apollo 11 feature {name} at {lon},{lat} is outside '
                                f'the Tranquillitatis bbox [{w},{s},{e},{n}]')
            if v > hist['p67']:
                failures.append(f'Apollo 11 feature {name} reads bright ({v}) inside '
                                f'a mare (p67={hist["p67"]})')

    return {'passed': not failures,
            'mareMedian': round(mare_med, 2), 'highlandMedian': round(high_med, 2),
            'histogram': hist, 'checks': checks, 'failures': failures}


def main() -> int:
    out = 'public/tiles'
    res = run_proof(out)
    mp = Path(out) / 'manifest.json'
    m = json.loads(mp.read_text())
    m['albedoHistogram'] = res['histogram']
    m['geometryProof'] = {'passed': res['passed'], 'checks': res['checks'],
                          'failures': res['failures']}
    mp.write_text(json.dumps(m, indent=1))
    print(json.dumps(res, indent=1))
    print(f'GATE G2 {"PASS" if res["passed"] else "FAIL"}')
    return 0 if res['passed'] else 4


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 4: Generate labels, then run the tests and the real proof**

```bash
.venv/Scripts/python.exe -m pytest scripts/tests/test_proof.py -q
npm run labels
npm run proof
```

Expected: 5 tests passed; `labels` prints tier counts with `curated <= 600` and exit 0; `proof` prints `"passed": true`, `GATE G2 PASS`, exit 0.

**If G2 FAILS, stop and diagnose in this order** — (1) every mare bright and every highland dark → the map is flipped (`y` convention); (2) the maria found are the ones you expected on the far side → a 180° longitude error; (3) only the bbox/centre checks fail → a `labels.wrap_lon` bug; (4) only one or two named features fail → that feature's gazetteer coordinate is genuinely ambiguous, and it must be replaced with another of the same class, with the substitution recorded. Write the diagnosis and the JSON into `docs/superpowers/specs/gate-G2.md`, fix the responsible module, re-run, and only then continue.

- [ ] **Step 5: Commit**

```bash
git add scripts/proof.py scripts/tests/test_proof.py public/data/features.json public/tiles/manifest.json docs/superpowers/specs/gate-G2.md
git commit -m "feat: geometry proof gate tying tiles, labels and visit features"
```

---

## Task 10: Layer switching, mode morph, camera preservation

**Files:**
- Create: `src/lib/cesium/morph.ts`, `src/components/ModeToggle.tsx`, `src/components/LayerChips.tsx`, `src/lib/assets.ts`
- Modify: `src/components/MoonMap.tsx`, `src/app/globals.css`
- Test: `src/test/morph.test.ts`, `src/test/assets.test.ts`

**Interfaces:**
- Consumes: `createMoonViewer`, `makeProvider`, `LayerName`, `Mode`, `Manifest`.
- Produces: `CameraState`, `clampHeight(h)`, `getCameraState(viewer)`, `preserveState(s, mode)`, `setMode(viewer, mode)`, `setLayer(viewer, layer, top)`, `loadManifest(): Promise<Manifest>`, `useManifest(): {manifest, error}`.

- [ ] **Step 1: Write the failing morph tests (pure math, no GPU)**

`src/test/morph.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MIN_H, MAX_H, clampHeight, preserveState } from '@/lib/cesium/morph';

describe('clampHeight', () => {
  it('bounds the camera inside the controller limits', () => {
    expect(MIN_H).toBe(1_500);
    expect(MAX_H).toBe(3.5e7);
    expect(clampHeight(10)).toBe(MIN_H);
    expect(clampHeight(9e7)).toBe(MAX_H);
    expect(clampHeight(5e5)).toBe(5e5);
  });
});

describe('preserveState', () => {
  const s = { lonDeg: 23.4731, latDeg: 0.6746, height: 2e5, heading: 0.4, pitch: -1.2 };
  it('keeps the centre across a mode change', () => {
    const out = preserveState(s, 'paper');
    expect(out.lonDeg).toBeCloseTo(23.4731);
    expect(out.latDeg).toBeCloseTo(0.6746);
  });
  it('forces straight-down, no heading in paper mode', () => {
    const out = preserveState(s, 'paper');
    expect(out.pitch).toBeCloseTo(-Math.PI / 2);
    expect(out.heading).toBe(0);
  });
  it('keeps tilt freedom in globe mode', () => {
    const out = preserveState(s, 'globe');
    expect(out.pitch).toBe(-1.2);
    expect(out.heading).toBe(0.4);
  });
  it('keeps the pole visible instead of clipping it', () => {
    expect(preserveState({ ...s, latDeg: 89.9999 }, 'globe').latDeg).toBeLessThan(90);
  });
});
```

- [ ] **Step 2: Verify failure, then implement `src/lib/cesium/morph.ts`**

Run: `npx vitest run src/test/morph.test.ts` → cannot resolve the module.

```ts
import * as Cesium from 'cesium';
import type { LayerName, Mode } from '@/types';
import { makeProvider } from './moon';

export const MIN_H = 1_500;
export const MAX_H = 3.5e7;

export interface CameraState {
  lonDeg: number;
  latDeg: number;
  height: number;
  heading: number;
  pitch: number;
}

export const clampHeight = (h: number) => Math.min(Math.max(h, MIN_H), MAX_H);

export function getCameraState(viewer: Cesium.Viewer): CameraState {
  const c = viewer.camera.positionCartographic;
  const toDeg = 180 / Math.PI;
  return {
    lonDeg: c.longitude * toDeg,
    latDeg: c.latitude * toDeg,
    height: c.height,
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
  };
}

export function preserveState(s: CameraState, mode: Mode): CameraState {
  const lat = Math.min(Math.max(s.latDeg, -89.9999), 89.9999);
  return {
    lonDeg: s.lonDeg,
    latDeg: lat,
    height: clampHeight(s.height),
    heading: mode === 'paper' ? 0 : s.heading,
    pitch: mode === 'paper' ? -Math.PI / 2 : s.pitch,
  };
}

export async function setMode(viewer: Cesium.Viewer, mode: Mode): Promise<void> {
  const snap = preserveState(getCameraState(viewer), mode);
  const target =
    mode === 'globe' ? Cesium.SceneMode.SCENE3D : Cesium.SceneMode.SCENE2D;
  if (viewer.scene.mode !== target) {
    const morph = mode === 'globe' ? 'morphTo3D' : 'morphTo2D';
    await new Promise<void>((resolve) => {
      const maybe = (viewer.camera as never as Record<string, (...a: unknown[]) => unknown>)[
        morph
      ](1.0, resolve);
      if (maybe && typeof (maybe as Promise<void>).then === 'function') {
        (maybe as Promise<void>).then(() => resolve());
      }
    });
  }
  viewer.scene.screenSpaceCameraController.enableTilt = mode === 'globe';
  viewer.camera.setView({
    destination: Cesium.Cartographic.fromDegrees(snap.lonDeg, snap.latDeg, snap.height),
    orientation: { heading: snap.heading, pitch: snap.pitch, roll: 0 },
  });
  viewer.scene.requestRender();
}

export function setLayer(
  viewer: Cesium.Viewer,
  layer: LayerName,
  top: number,
): void {
  if (viewer.imageryLayers.length > 0) {
    viewer.imageryLayers.remove(viewer.imageryLayers.get(0), true);
  }
  viewer.imageryLayers.addImageryProvider(makeProvider(layer, top));
  viewer.scene.requestRender();
}
```

- [ ] **Step 3: Write the failing manifest-loader test, then `src/lib/assets.ts`**

`src/test/assets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { layerTop, parseManifest } from '@/lib/assets';

const GOOD = {
  schema: 1,
  grid: { tileSize: 512, yOrigin: 'north' },
  layers: { paper: { top: 6 }, photo: { top: 6 } },
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(GOOD);
    expect(m).not.toBeNull();
    expect(layerTop(m!, 'photo')).toBe(6);
  });
  it('rejects a foreign tile size instead of silently mis-rendering', () => {
    expect(parseManifest({ ...GOOD, grid: { tileSize: 256, yOrigin: 'north' } }))
      .toBeNull();
  });
  it('rejects a missing layer record', () => {
    expect(parseManifest({ ...GOOD, layers: { paper: { top: 6 } } })).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('x')).toBeNull();
  });
});
```

```ts
import type { Manifest } from '@/types';
import { TILE_SIZE } from '@/lib/grid';

export function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<Manifest>;
  if (!m.grid || m.grid.tileSize !== TILE_SIZE) return null;
  if (!m.layers || !m.layers.paper || !m.layers.photo) return null;
  return m as Manifest;
}

export const layerTop = (m: Manifest, layer: 'paper' | 'photo') =>
  m.layers[layer].top;

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch('/tiles/manifest.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`manifest.json HTTP ${r.status}`);
  const m = parseManifest(await r.json());
  if (!m) throw new Error('manifest.json is not compatible with this build');
  return m;
}

export interface Probe {
  path: string;
  ok: boolean;
  status: number;
}

/** Three fetches that catch the usual mistakes: unbaked, wrong top level,
 *  and a broken antimeridian column. */
export async function probeAssets(m: Manifest): Promise<Probe[]> {
  const top = layerTop(m, 'photo');
  const cols = 2 ** (top + 1);
  const paths = [
    '/tiles/photo/0/0/0.jpg',
    `/tiles/paper/${top}/${cols - 1}/0.jpg`,
    `/tiles/photo/${top}/0/${Math.min(2 ** top - 1, 2 ** (top - 1))}.jpg`,
  ];
  return Promise.all(
    paths.map(async (path) => {
      try {
        const r = await fetch(path, { method: 'GET' });
        return { path, ok: r.ok, status: r.status };
      } catch (e) {
        return { path, ok: false, status: 0 };
      }
    }),
  );
}
```

- [ ] **Step 4: Wire the controls into `MoonMap.tsx`**

Add to `src/components/MoonMap.tsx`: `useState` for `mode`, `layer`, `manifest` and `error`; a `useEffect` that `loadManifest().then(setManifest).catch(...)` before creating the viewer; render `<ModeToggle/>` and `<LayerChips/>` over the canvas; and two effects that call `setMode` / `setLayer` on change, skipping the first render with a `didMount` ref so the viewer is not morphed while it is being built. On `error`, render the `NoAssets` panel from Task 15.

`src/components/ModeToggle.tsx`:

```tsx
'use client';
import type { Mode } from '@/types';

const LABELS: Record<Mode, string> = { paper: 'Paper', globe: 'Globe' };

export default function ModeToggle({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  return (
    <div className="ctl ctl-mode" role="group" aria-label="View mode">
      {(['paper', 'globe'] as Mode[]).map((m) => (
        <button
          key={m}
          type="button"
          className={m === mode ? 'on' : ''}
          aria-pressed={m === mode}
          onClick={() => onChange(m)}
        >
          {LABELS[m]}
        </button>
      ))}
    </div>
  );
}
```

`src/components/LayerChips.tsx` — same structure with `{ paper: 'Albedo', photo: 'Colour relief' }`.

Append to `src/app/globals.css`:

```css
.ui {
  position: fixed;
  inset: 0;
  pointer-events: none;
  font: 13px/1.4 system-ui, sans-serif;
  color: #e8e8e8;
}
.ctl {
  position: absolute;
  pointer-events: auto;
  display: flex;
  gap: 2px;
  background: rgba(12, 14, 20, 0.72);
  border-radius: 7px;
  padding: 3px;
  backdrop-filter: blur(6px);
}
.ctl-mode { top: 14px; left: 14px; }
.ctl-layer { top: 14px; left: 148px; }
.ctl button {
  all: unset;
  cursor: pointer;
  padding: 5px 11px;
  border-radius: 5px;
  letter-spacing: 0.02em;
}
.ctl button.on {
  background: rgba(255, 255, 255, 0.16);
}
```

- [ ] **Step 5: Verify in the browser and record the numbers**

```bash
npm run test:js && npm run dev
```

In the browser: toggle Paper↔Globe five times, dragging between toggles, then read `JSON.stringify(getCameraState(viewer))` before and after a toggle pair from the console. Expected: centre longitude and latitude unchanged to within 0.01°, height within 5%, and in Paper mode the image is axis-aligned (pitch −90°). Screenshot both modes at L5 over Mare Tranquillitatis. Append every number to `docs/superpowers/specs/verify-10.md`.

- [ ] **Step 6: Commit**

```bash
git add src/components src/lib/cesium/morph.ts src/lib/assets.ts src/test/morph.test.ts src/test/assets.test.ts docs/superpowers/specs/verify-10.md
git commit -m "feat: paper/globe morph and layer switching with camera preservation"
```

---

## Task 11: Label rendering, tier visibility and declutter

**Files:**
- Create: `src/lib/labels/declutter.ts`, `src/lib/labels/tiers.ts`, `src/lib/labels/entities.ts`, `src/lib/cesium/picking.ts`
- Modify: `src/components/MoonMap.tsx`
- Test: `src/test/declutter.test.ts`, `src/test/tiers.test.ts`

**Interfaces:**
- Consumes: `public/data/features.json` as `FeatureCollection`, `cameraHeightForLevel`, `MOON_ELLIPSOID`.
- Produces: `Box`, `LabelBox`, `overlaps(a,b)`, `declutter(items, cellPx=96): string[]`; `TIER_FROM_LEVEL`, `visibleTiers(heightM, viewportPx, fovDeg): Tier[]`, `tierPriority(tier, diameterKm)`; `attachLabels(viewer, features): LabelSet` where `LabelSet = { refresh(heightM: number): void; destroy(): void; count: number }`; `attachPicking(viewer, onPick): () => void`.

- [ ] **Step 1: Write the failing declutter tests**

`src/test/declutter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { declutter, overlaps, type Box, type LabelBox } from '@/lib/labels/declutter';

const box = (x: number, y: number, w = 60, h = 16): Box => ({ x, y, w, h });
const item = (id: string, priority: number, x: number, y = 100): LabelBox => ({
  id,
  priority,
  box: box(x, y),
});

describe('overlaps', () => {
  it('detects an intersection', () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(true);
  });
  it('treats touching edges as non-overlapping', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false);
  });
  it('detects containment', () => {
    expect(overlaps(box(0, 0, 100, 100), box(40, 40, 10, 10))).toBe(true);
  });
});

describe('declutter', () => {
  it('keeps the higher priority of two colliding labels', () => {
    expect(declutter([item('a', 5, 100), item('b', 9, 104)])).toEqual(['b']);
  });
  it('keeps everything when nothing collides', () => {
    const kept = declutter([item('a', 5, 0), item('b', 5, 400), item('c', 5, 800)]);
    expect(kept.sort()).toEqual(['a', 'b', 'c']);
  });
  it('is independent of input order', () => {
    const items = [item('a', 5, 100), item('b', 9, 104), item('c', 1, 108)];
    expect(declutter(items)).toEqual(declutter([...items].reverse()));
    expect(declutter(items)).toEqual(['b']);
  });
  it('resolves a chain so only the top-ranked survivor remains', () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`l${n}`, n, n * 6));
    expect(declutter(items)).toEqual(['l5']);
  });
  it('handles empty input', () => {
    expect(declutter([])).toEqual([]);
  });
  it('spans many cells for a wide label', () => {
    const wide = [{ id: 'w', priority: 1, box: box(0, 0, 400, 16) }];
    expect(declutter(wide, 96)).toEqual(['w']);
  });
});
```

- [ ] **Step 2: Verify failure, then implement `src/lib/labels/declutter.ts`**

Run: `npx vitest run src/test/declutter.test.ts` → cannot resolve the module.

```ts
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelBox {
  id: string;
  priority: number;
  box: Box;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Greedy screen-space label culling. Cesium has no built-in collision
 * avoidance, and this pass is what makes the names read as subtle instead of
 * messy. Pure, so it is testable without a GPU.
 */
export function declutter(items: LabelBox[], cellPx = 96): string[] {
  const order = [...items].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const cells = new Map<string, Box[]>();
  const span = (b: Box): string[] => {
    const out: string[] = [];
    for (let cx = Math.floor(b.x / cellPx); cx <= Math.floor((b.x + b.w) / cellPx); cx++) {
      for (let cy = Math.floor(b.y / cellPx); cy <= Math.floor((b.y + b.h) / cellPx); cy++) {
        out.push(`${cx},${cy}`);
      }
    }
    return out;
  };
  const kept: string[] = [];
  for (const item of order) {
    const clash = span(item.box).some((k) =>
      (cells.get(k) ?? []).some((b) => overlaps(b, item.box)),
    );
    if (clash) continue;
    kept.push(item.id);
    for (const k of span(item.box)) {
      const list = cells.get(k);
      if (list) list.push(item.box);
      else cells.set(k, [item.box]);
    }
  }
  return kept;
}
```

- [ ] **Step 3: Write the failing tier test, then implement `src/lib/labels/tiers.ts`**

`src/test/tiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TIER_FROM_LEVEL, tierPriority, visibleTiers } from '@/lib/labels/tiers';

describe('visibleTiers', () => {
  it('shows only tier 0 and landing sites from deep space', () => {
    expect(visibleTiers(2e7, 900, 60)).toEqual([0, 3]);
  });
  it('adds tier 1 once a hemisphere fills the screen', () => {
    expect(visibleTiers(3.5e6, 900, 60)).toContain(1);
    expect(visibleTiers(3.5e6, 900, 60)).not.toContain(2);
  });
  it('adds tier 2 at regional scale', () => {
    expect(visibleTiers(1.2e6, 900, 60)).toEqual([0, 1, 2, 3]);
  });
  it('never loses a tier at the closest zoom', () => {
    expect(visibleTiers(2_000, 900, 60)).toEqual([0, 1, 2, 3]);
  });
  it('keeps the documented level mapping', () => {
    expect(TIER_FROM_LEVEL).toEqual({ 0: null, 1: 1, 2: 3, 3: null });
  });
});

describe('tierPriority', () => {
  it('ranks lower tiers above higher ones', () => {
    expect(tierPriority(0, 1000)).toBeGreaterThan(tierPriority(1, 9000));
  });
  it('breaks ties inside a tier by size', () => {
    expect(tierPriority(2, 300)).toBeLessThan(tierPriority(2, 900));
  });
});
```

```ts
import { cameraHeightForLevel } from '@/lib/grid';
import type { Tier } from '@/types';

/** Tier N becomes visible once the camera is close enough that the view's
 *  ground resolution matches tile level TIER_FROM_LEVEL[N]. Deriving the
 *  thresholds from the grid keeps them principled and viewport-aware instead
 *  of a set of magic numbers. Tiers 0 and 3 have no level gate: they always
 *  show. */
export const TIER_FROM_LEVEL: Record<Tier, number | null> = {
  0: null,
  1: 1,
  2: 3,
  3: null,
};

export function tierVisibleMaxHeight(
  tier: Tier,
  viewportPx: number,
  fovDeg: number,
): number {
  const level = TIER_FROM_LEVEL[tier];
  return level === null ? Infinity : cameraHeightForLevel(level, viewportPx, fovDeg);
}

export function visibleTiers(heightM: number, viewportPx = 900, fovDeg = 60): Tier[] {
  return ([0, 1, 2, 3] as Tier[]).filter(
    (t) => heightM <= tierVisibleMaxHeight(t, viewportPx, fovDeg),
  );
}

export function tierPriority(tier: Tier, diameterKm: number | null): number {
  const base = (3 - tier) * 1e6;
  const size = Math.min(diameterKm ?? 0, 9_999) * 10;
  return base + size + (tier === 3 ? 5e5 : 0);
}
```

- [ ] **Step 4: Implement `src/lib/labels/entities.ts` and `src/lib/cesium/picking.ts`**

```ts
import * as Cesium from 'cesium';
import { MOON_ELLIPSOID } from '@/lib/cesium/moon';
import { declutter, type LabelBox } from './declutter';
import { tierPriority, visibleTiers } from './tiers';
import type { Feature, FeatureCollection } from '@/types';

export interface LabelSet {
  refresh(heightM: number): void;
  destroy(): void;
  readonly count: number;
}

const CHAR_PX = 6.6;
const LABEL_H = 16;

export function attachLabels(viewer: Cesium.Viewer, fc: FeatureCollection): LabelSet {
  const entries = fc.features.map((f: Feature) => {
    const [lon, lat] = f.geometry.coordinates;
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0, MOON_ELLIPSOID),
      properties: { feature: f },
      label: {
        text: f.properties.name,
        font: '500 13px system-ui, sans-serif',
        fillColor: Cesium.Color.fromCssColorString('rgba(238,238,238,0.62)'),
        outlineColor: Cesium.Color.fromCssColorString('rgba(0,0,0,0.68)'),
        outlineWidth: 1.5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(2e4, 0.85, 2.2e6, 0.25),
        scaleByDistance: new Cesium.NearFarScalar(2e4, 0.95, 2.2e6, 0.72),
      },
    });
    if (f.properties.tier === 3) {
      entity.point = new Cesium.PointGraphics({
        pixelSize: 6,
        color: Cesium.Color.fromCssColorString('rgba(255,214,102,0.85)'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 1,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    return { entity, feature: f };
  });

  return {
    refresh(heightM: number) {
      const tiers = new Set(visibleTiers(heightM));
      const now = viewer.clock.currentTime;
      const candidates: { entity: Cesium.Entity; index: number }[] = [];
      const boxes: LabelBox[] = [];
      entries.forEach(({ entity, feature }, i) => {
        entity.show = false;
        if (!tiers.has(feature.properties.tier)) return;
        const pos = entity.position?.getValue(now) as Cesium.Cartesian3 | undefined;
        if (!pos) return;
        const screen = Cesium.SceneTransforms.worldToWindowCoordinates(viewer.scene, pos);
        if (!screen || !Number.isFinite(screen.x)) return;
        candidates.push({ entity, index: i });
        const w = Math.min(feature.properties.name.length * CHAR_PX + 8, 220);
        boxes.push({
          id: String(i),
          priority: tierPriority(feature.properties.tier, feature.properties.diameterKm),
          box: { x: screen.x - w / 2, y: screen.y - LABEL_H / 2, w, h: LABEL_H },
        });
      });
      const keep = new Set(declutter(boxes).map(Number));
      for (const { entity, index } of candidates) {
        entity.show = keep.has(index);
      }
      viewer.scene.requestRender();
    },
    get count() {
      return entries.length;
    },
    destroy() {
      for (const { entity } of entries) viewer.entities.remove(entity);
    },
  };
}
```

```ts
import * as Cesium from 'cesium';
import type { Feature } from '@/types';

export function attachPicking(
  viewer: Cesium.Viewer,
  onPick: (feature: Feature | null) => void,
): () => void {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const read = (picked: unknown) => {
    const entity = picked as Cesium.Entity | undefined;
    const raw = entity?.properties?.feature?.getValue(viewer.clock.currentTime);
    onPick((raw as Feature) ?? null);
  };
  handler.setInputAction(
    (mov: { position: Cesium.Cartesian2 }) => read(viewer.scene.pick(mov.position)),
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );
  return () => handler.destroy();
}
```

- [ ] **Step 5: Drive the refresh from the camera**

In `MoonMap.tsx`, call `attachLabels(viewer, features)` once, add a `postRender` listener throttled to 8 Hz that calls `labels.refresh(getCameraState(viewer).height)`, and call `attachPicking(viewer, setSelectedFeature)`.

- [ ] **Step 6: Verify and commit**

Run: `npm run test:js && npm run dev`
Expected in the browser: from deep space only ~17 mare names show, low-contrast with dark outlines and no overlap; zooming to a limb adds craters; further in adds rimae and catenae; the astronaut-named traverse dots stay visible at every height; Paper↔Globe preserves the visible set. Record `viewer.entities.values.filter((e) => e.show).length` at three camera heights (2.2e7, 3.5e6, 4e5 m) in `docs/superpowers/specs/verify-11.md` with screenshots.

```bash
git add src/lib/labels src/lib/cesium/picking.ts src/components/MoonMap.tsx src/test/declutter.test.ts src/test/tiers.test.ts docs/superpowers/specs/verify-11.md
git commit -m "feat: distance-tiered lunar labels with screen-space declutter"
```

---

## Task 12: Search and the feature card

**Files:**
- Create: `src/lib/search.ts`, `src/components/SearchBox.tsx`, `src/components/FeatureCard.tsx`
- Modify: `src/components/MoonMap.tsx`, `src/lib/cesium/morph.ts`
- Test: `src/test/search.test.ts`

**Interfaces:**
- Consumes: `FeatureCollection`, `clampHeight`.
- Produces: `score(query, name)`, `fuzzySearch(query, fc, limit=8): Feature[]`, `flyToFeature(viewer, {coordinates, diameterKm})`.

- [ ] **Step 1: Write the failing search tests**

`src/test/search.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fuzzySearch, score } from '@/lib/search';
import type { FeatureCollection } from '@/types';

const fc = JSON.parse(
  readFileSync('public/data/features.json', 'utf8'),
) as FeatureCollection;

describe('score', () => {
  it('ranks exact above prefix above substring above subsequence', () => {
    expect(score('tycho', 'Tycho')).toBeGreaterThan(score('tycho', 'Tycho Kraemer'));
    expect(score('tycho', 'Tycho Kraemer')).toBeGreaterThanOrEqual(score('tycho', 'ATYCHOX'));
    expect(score('tycho', 'ATYCHOX')).toBeGreaterThan(score('tyc', 'Tycho') * 0 + 1);
    expect(score('zzz', 'Tycho')).toBe(0);
  });
  it('is case-insensitive and punctuation-insensitive', () => {
    expect(score('TYCHO', 'Tycho')).toBe(score('tycho', 'Tycho'));
    expect(score("mare's", "Mare's")).toBeGreaterThan(0);
  });
});

describe('fuzzySearch over the real curated label set', () => {
  it('finds the Sea of Tranquility by latin name', () => {
    expect(fuzzySearch('tranq', fc)[0].properties.name).toBe('Mare Tranquillitatis');
  });
  it('finds it by the English gloss too', () => {
    expect(fuzzySearch('sea of tranquility', fc)[0].properties.name)
      .toBe('Mare Tranquillitatis');
  });
  it('finds the famous craters', () => {
    for (const q of ['tycho', 'copern', 'arista']) {
      expect(fuzzySearch(q, fc)[0].properties.name.length).toBeGreaterThan(3);
    }
  });
  it('finds Apollo 11 by mission, not by a landing-site name', () => {
    const hits = fuzzySearch('apollo 11', fc);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.properties.mission === 'Apollo 11')).toBe(true);
    expect(hits.map((h) => h.properties.name)).toEqual(
      expect.arrayContaining(['West', 'Little West', 'Double', 'Mount Marilyn']),
    );
  });
  it('returns nothing for nonsense and respects the limit', () => {
    expect(fuzzySearch('qxzvjw', fc)).toEqual([]);
    expect(fuzzySearch('mare', fc, 3)).toHaveLength(3);
  });
  it('prefers an important feature for an ambiguous prefix', () => {
    expect(fuzzySearch('m', fc, 5)[0].properties.tier).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Verify failure, then implement `src/lib/search.ts`**

```ts
import type { Feature, FeatureCollection } from '@/types';

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export function score(query: string, name: string): number {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 10_000;
  if (n.startsWith(q)) return 5_000 + Math.max(0, 100 - n.length);
  if (n.includes(q)) return 3_000 - Math.min(n.indexOf(q), 500);
  let i = 0;
  let gaps = 0;
  for (const ch of n) {
    if (i < q.length && ch === q[i]) i += 1;
    else if (i < q.length) gaps += 1;
  }
  if (i < q.length) return 0;
  return Math.max(1, 1_000 - gaps);
}

export function fuzzySearch(
  query: string,
  fc: FeatureCollection,
  limit = 8,
): Feature[] {
  if (!norm(query)) return [];
  return fc.features
    .map((f) => {
      const own = score(query, f.properties.name);
      const gloss = score(query, f.properties.gloss) * 0.85;
      const kind = score(query, f.properties.type) * 0.35;
      const mission = score(query, f.properties.mission ?? '') * 0.95;
      const best = Math.max(own, gloss, kind, mission);
      if (best === 0) return { f, s: 0 };
      const importance =
        (3 - f.properties.tier) * 40 +
        Math.min(f.properties.diameterKm ?? 0, 300) / 10;
      return { f, s: best + importance };
    })
    .filter((r) => r.s > 0)
    .sort(
      (a, b) =>
        b.s - a.s || a.f.properties.name.localeCompare(b.f.properties.name),
    )
    .slice(0, limit)
    .map((r) => r.f);
}
```

- [ ] **Step 3: Add the fly-to and the two components**

Append to `src/lib/cesium/morph.ts`:

```ts
export function flyToFeature(
  viewer: Cesium.Viewer,
  feature: { coordinates: [number, number]; diameterKm: number | null },
): void {
  const [lon, lat] = feature.coordinates;
  const diameter = feature.diameterKm ?? 60;
  const height = clampHeight(Math.max(20_000, diameter * 1000 * 4));
  viewer.camera.flyTo({
    destination: Cesium.Cartographic.fromDegrees(lon, lat, height),
    duration: 1.4,
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}
```

`src/components/FeatureCard.tsx` renders `null` when `feature` is null; otherwise the name, its English gloss as a subtitle, then rows for type, diameter in km, planetocentric lat/lon to four decimals and in degrees/minutes, quadrangle code, approval date, and an external link to the gazetteer URL. The card must carry the note "coordinates are planetocentric on the IAU2000 sphere, r = 1,737.4 km", an `aria-live="polite"` region, and a close button wired to `onClose`.

`src/components/SearchBox.tsx` is an `role="combobox"` input with `aria-expanded`, `aria-controls`, `aria-activedescendant`, a result list of buttons, `ArrowDown`/`ArrowUp`/`Enter`/`Escape` handling, and `onChoose(feature)` calling `flyToFeature` plus `setSelected`.

- [ ] **Step 4: Verify in the browser**

Run: `npm run test:js && npm run dev`
Expected: `tranq` → Mare Tranquillitatis first; `sea of tranquility` → same feature via the gloss; Enter flies there; the card shows `"Sea of Tranquility."`, ~875.7 km, `LAC-61`, `1935-01-01`, and a working gazetteer link; `apollo 11` → four results (West, Little West, Double, Mount Marilyn) whose coordinates fall inside the Tranquillitatis bbox printed by the mare's own card, with `mission` shown on the card. Record screenshots and card contents in `docs/superpowers/specs/verify-12.md`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/search.ts src/lib/cesium/morph.ts src/components/SearchBox.tsx src/components/FeatureCard.tsx src/test/search.test.ts docs/superpowers/specs/verify-12.md
git commit -m "feat: label search with gloss matching and feature provenance card"
```

---

## Task 13: Scale readout, keyboard navigation and attribution

**Files:**
- Create: `src/lib/scale.ts`, `src/lib/keyboard.ts`, `src/lib/cesium/scaleProbe.ts`, `src/components/ScaleReadout.tsx`, `src/components/Attribution.tsx`
- Modify: `src/components/MoonMap.tsx`, `src/app/globals.css`
- Test: `src/test/scale.test.ts`, `src/test/keyboard.test.ts`

**Interfaces:**
- Consumes: `MOON_RADIUS_M`, `mPerPx`, `getCameraState`.
- Produces: `alongParallelMeters`, `meridianMeters`, `mPerPxFromPixels`, `niceBarScale`, `measureMPerPx(viewer)`, `keyAction`, `attachKeyboard(target, viewer, handlers)`.

- [ ] **Step 1: Write the failing scale tests**

`src/test/scale.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MOON_RADIUS_M,
  alongParallelMeters,
  meridianMeters,
  mPerPxFromPixels,
  niceBarScale,
} from '@/lib/scale';

describe('lunar ground distance', () => {
  it('uses the Moon radius, not Earth', () => {
    expect(MOON_RADIUS_M).toBe(1_737_400);
    expect(meridianMeters(1)).toBeCloseTo(30_322.4, 0);
  });
  it('shrinks along a parallel by cos(latitude)', () => {
    expect(alongParallelMeters(0, 1)).toBeCloseTo(30_322.4, 0);
    expect(alongParallelMeters(60, 1)).toBeCloseTo(15_161.2, 0);
    expect(alongParallelMeters(89.999, 1)).toBeLessThan(10);
  });
  it('divides ground metres by measured pixels', () => {
    expect(mPerPxFromPixels(1000, 10)).toBe(100);
    expect(mPerPxFromPixels(1000, 0)).toBeNull();
    expect(mPerPxFromPixels(1000, Number.NaN)).toBeNull();
  });
});

describe('niceBarScale', () => {
  it('picks a round kilometre value that fits the bar', () => {
    const b = niceBarScale(333.1, 120);
    expect(b.barPx).toBeLessThanOrEqual(120);
    expect(b.barPx).toBeGreaterThan(0);
    expect([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]).toContain(b.labelKm);
  });
  it('stays sane at silly resolutions', () => {
    expect(niceBarScale(1e6, 120).labelKm).toBeGreaterThan(0);
    expect(niceBarScale(0.01, 120).labelKm).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Implement `src/lib/scale.ts`**

```ts
import { MOON_RADIUS_M as R, DEG2RAD } from '@/lib/grid';

export { R as MOON_RADIUS_M };

export const meridianMeters = (dLatDeg: number) => R * Math.abs(dLatDeg) * DEG2RAD;

/** Ground distance along a small parallel. The map is equirectangular, so this
 *  is the axis whose ground scale shrinks with cos(latitude) while its pixel
 *  scale does not — which is why the readout reports the along-parallel value. */
export const alongParallelMeters = (latDeg: number, dLonDeg: number) =>
  R * Math.cos(latDeg * DEG2RAD) * Math.abs(dLonDeg) * DEG2RAD;

export function mPerPxFromPixels(
  groundMeters: number,
  pixelDelta: number,
): number | null {
  if (!Number.isFinite(pixelDelta) || pixelDelta <= 0) return null;
  return groundMeters / pixelDelta;
}

const NICE_KM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

export function niceBarScale(
  mPerPx: number,
  maxPx: number,
): { barPx: number; labelKm: number } {
  const maxKm = (mPerPx * maxPx) / 1000;
  const labelKm =
    [...NICE_KM].reverse().find((k) => k <= maxKm) ?? NICE_KM[0];
  const barPx = Math.max(1, Math.min((labelKm * 1000) / mPerPx, maxPx));
  return { barPx, labelKm };
}
```

- [ ] **Step 3: Measure it through the live camera**

`src/lib/cesium/scaleProbe.ts` — projecting two nearby surface points is the only way to be right in both `SCENE2D` and `SCENE3D` without analytic guesswork:

```ts
import * as Cesium from 'cesium';
import { MOON_ELLIPSOID } from './moon';
import { alongParallelMeters, mPerPxFromPixels } from '@/lib/scale';

const D_LON_DEG = 0.01;

export function measureMPerPx(viewer: Cesium.Viewer): number | null {
  const c = viewer.camera.positionCartographic;
  const toDeg = 180 / Math.PI;
  const lat = c.latitude * toDeg;
  const lon = c.longitude * toDeg;
  const a = Cesium.SceneTransforms.worldToWindowCoordinates(
    viewer.scene,
    Cesium.Cartesian3.fromDegrees(lon, lat, 0, MOON_ELLIPSOID),
  );
  const b = Cesium.SceneTransforms.worldToWindowCoordinates(
    viewer.scene,
    Cesium.Cartesian3.fromDegrees(lon + D_LON_DEG, lat, 0, MOON_ELLIPSOID),
  );
  if (!a || !b) return null;
  return mPerPxFromPixels(
    alongParallelMeters(lat, D_LON_DEG),
    Math.hypot(b.x - a.x, b.y - a.y),
  );
}
```

`ScaleReadout.tsx` shows `~{Math.round(mPerPx)} m/px`, the bar at `niceBarScale(...).barPx` labelled in km, the centre lat/lon to four decimals, and the active tile level. `Attribution.tsx` shows the verbatim credit line from Global Constraints at 10 px, always visible, with a disclosure that names the three products and their resolutions (100 m/px detail mosaic, 76 px/deg colour base, 9,087 gazetteer records) and the bake date from `manifest.generatedAt`.

- [ ] **Step 4: Write the keyboard tests and implementation**

`src/test/keyboard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { keyAction } from '@/lib/keyboard';

describe('keyAction', () => {
  it('maps zoom and pan', () => {
    expect(keyAction('+')).toBe('zoom-in');
    expect(keyAction('=')).toBe('zoom-in');
    expect(keyAction('-')).toBe('zoom-out');
    expect(keyAction('_')).toBe('zoom-out');
    expect(keyAction('ArrowUp')).toBe('pan-n');
    expect(keyAction('ArrowDown')).toBe('pan-s');
    expect(keyAction('ArrowLeft')).toBe('pan-w');
    expect(keyAction('ArrowRight')).toBe('pan-e');
  });
  it('shift pans faster', () => {
    expect(keyAction('ArrowLeft', true)).toBe('pan-w-fast');
    expect(keyAction('ArrowUp', true)).toBe('pan-n-fast');
  });
  it('maps rotation and ignores plain letters', () => {
    expect(keyAction('q')).toBe('rotate-left');
    expect(keyAction('e')).toBe('rotate-right');
    expect(keyAction('a')).toBeNull();
  });
  it('ignores everything while typing in a field', () => {
    expect(keyAction('ArrowLeft', false, true)).toBeNull();
    expect(keyAction('+', false, true)).toBeNull();
  });
});
```

```ts
export type CameraAction =
  | 'zoom-in'
  | 'zoom-out'
  | 'pan-n'
  | 'pan-s'
  | 'pan-e'
  | 'pan-w'
  | 'pan-n-fast'
  | 'pan-s-fast'
  | 'pan-e-fast'
  | 'pan-w-fast'
  | 'rotate-left'
  | 'rotate-right';

export function keyAction(
  key: string,
  shift = false,
  inField = false,
): CameraAction | null {
  if (inField) return null;
  switch (key) {
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case 'ArrowUp':
      return shift ? 'pan-n-fast' : 'pan-n';
    case 'ArrowDown':
      return shift ? 'pan-s-fast' : 'pan-s';
    case 'ArrowLeft':
      return shift ? 'pan-w-fast' : 'pan-w';
    case 'ArrowRight':
      return shift ? 'pan-e-fast' : 'pan-e';
    case 'q':
      return 'rotate-left';
    case 'e':
      return 'rotate-right';
    default:
      return null;
  }
}
```

`attachKeyboard(target, viewer, handlers)` maps actions with `camera.moveUp/moveDown/moveLeft/moveRight/zoomIn/zoomOut/rotateLeft/rotateRight`, calls `preventDefault()` for arrows and `+`/`-` so the page does not scroll, fires `handlers.afterMove()` (which the label refresh and scale readout subscribe to), ignores events when `document.activeElement` is an `input`, handles `1`/`2` for the two modes and `/` to focus search, and returns a removal function.

- [ ] **Step 5: Verify and commit**

Run: `npm run test:js && npm run dev`
Expected: the readout shows tens of km/px from deep space and rises as you zoom; five `+` presses each raise it and re-render (with `requestRenderMode` on, a missing `requestRender()` shows up as a frozen readout); arrows pan; `q` rotates in Globe mode and does nothing in Paper mode; typing in the search box moves the caret, not the camera. At maximum zoom the readout must be within a factor of 2 of `mPerPx(6) = 166.6` — if it is 10× off, the projection or the ellipsoid is wrong. Record in `docs/superpowers/specs/verify-13.md`.

```bash
git add src/lib/scale.ts src/lib/keyboard.ts src/lib/cesium/scaleProbe.ts src/components/ScaleReadout.tsx src/components/Attribution.tsx src/test/scale.test.ts src/test/keyboard.test.ts docs/superpowers/specs/verify-13.md
git commit -m "feat: camera-projected scale readout, keyboard navigation, attribution"
```

---

## Task 14: Shareable URL state

**Files:**
- Create: `src/lib/urlState.ts`
- Modify: `src/components/MoonMap.tsx`
- Test: `src/test/urlState.test.ts`

**Interfaces:**
- Consumes: `clampHeight`, `Mode`, `LayerName`.
- Produces: `ViewState`, `DEFAULT_VIEW`, `serializeHash(v)`, `parseHash(hash)`.

- [ ] **Step 1: Write the failing tests**

`src/test/urlState.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW, parseHash, serializeHash } from '@/lib/urlState';

describe('url state round trip', () => {
  it('round-trips a view', () => {
    const v = {
      lon: 23.47312, lat: 0.67461, height: 180_000,
      mode: 'globe' as const, layer: 'photo' as const,
    };
    expect(parseHash(serializeHash(v))).toEqual(v);
  });
  it('carries a selected feature name with spaces', () => {
    const s = serializeHash({ ...DEFAULT_VIEW, feature: 'Mare Tranquillitatis' });
    expect(parseHash(s).feature).toBe('Mare Tranquillitatis');
  });
  it('falls back to defaults on malformed input', () => {
    for (const bad of ['', '#', '#x', '#garbage/here', '#NaN/0/0/globe/photo']) {
      expect(parseHash(bad).lon).toBe(DEFAULT_VIEW.lon);
      expect(parseHash(bad).height).toBe(DEFAULT_VIEW.height);
    }
  });
  it('clamps out-of-range numbers instead of throwing', () => {
    const p = parseHash('#999/-999/1e30/globe/photo');
    expect(p.lon).toBeLessThanOrEqual(180);
    expect(p.lat).toBeGreaterThanOrEqual(-90);
    expect(p.height).toBeLessThanOrEqual(3.5e7);
  });
  it('rejects unknown mode and layer names', () => {
    expect(parseHash('#0/0/100000/mars/satellite').mode).toBe(DEFAULT_VIEW.mode);
    expect(parseHash('#0/0/100000/globe/satellite').layer).toBe(DEFAULT_VIEW.layer);
  });
});
```

- [ ] **Step 2: Implement `src/lib/urlState.ts`**

```ts
import type { LayerName, Mode } from '@/types';
import { clampHeight } from '@/lib/cesium/morph';

export interface ViewState {
  lon: number;
  lat: number;
  height: number;
  mode: Mode;
  layer: LayerName;
  feature?: string;
}

export const DEFAULT_VIEW: ViewState = {
  lon: 0,
  lat: 0,
  height: 2.2e7,
  mode: 'globe',
  layer: 'photo',
};

const num = (raw: string | undefined, fallback: number) => {
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
};

export function serializeHash(v: ViewState): string {
  const parts = [
    v.lon.toFixed(5),
    v.lat.toFixed(5),
    String(Math.round(v.height)),
    v.mode,
    v.layer,
  ];
  if (v.feature) parts.push(encodeURIComponent(v.feature));
  return `#${parts.join('/')}`;
}

export function parseHash(hash: string): ViewState {
  const raw = (hash ?? '').replace(/^#/, '');
  if (!raw) return { ...DEFAULT_VIEW };
  const [lonRaw, latRaw, height, mode, layer, feature] = raw.split('/');
  const lon = num(lonRaw, NaN);
  const lat = num(latRaw, NaN);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return { ...DEFAULT_VIEW };
  return {
    lon: Math.min(Math.max(lon, -180), 180),
    lat: Math.min(Math.max(lat, -89.9999), 89.9999),
    height: clampHeight(num(height, DEFAULT_VIEW.height)),
    mode: mode === 'paper' || mode === 'globe' ? mode : DEFAULT_VIEW.mode,
    layer: layer === 'paper' || layer === 'photo' ? layer : DEFAULT_VIEW.layer,
    feature: feature ? decodeURIComponent(feature) : undefined,
  };
}
```

Note for the implementer: `round-trips a view` passes only because `height` is serialised as an integer and `clampHeight` is identity in range. If you change the serialisation precision, update the test's expected values deliberately — do not add fuzzy tolerance to hide a precision loss.

- [ ] **Step 3: Sync both ways without a feedback loop**

On mount: parse `window.location.hash`; if it yields a non-default view, apply it via `camera.setView` plus `setMode`/`setLayer`; otherwise write `serializeHash(DEFAULT_VIEW)`. On `postRender` throttled to 4 Hz: compute the current serialised state and `history.replaceState` only if it differs from `location.hash`. Expose `applyFeature(name)` so search results update the URL too.

- [ ] **Step 4: Verify and commit**

Expected: fly somewhere, copy the URL, open it in a new tab — same place, mode and layer; `#0/0/22000000/globe/photo` works; `#nonsense` renders the default view with no error overlay; a search selection appears in the hash as `...%2FMare%20Tranquillitatis` and reloads with the card open. Record in `verify-14.md`.

```bash
git add src/lib/urlState.ts src/components/MoonMap.tsx src/test/urlState.test.ts docs/superpowers/specs/verify-14.md
git commit -m "feat: shareable URL state for view, mode, layer and selection"
```

---

## Task 15: Failure modes and the unbaked path

**Files:**
- Create: `src/lib/diagnostics.ts`, `src/components/NoAssets.tsx`, `src/components/ErrorPanel.tsx`
- Modify: `src/components/MoonMap.tsx`
- Test: `src/test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `loadManifest`, `probeAssets`.
- Produces: `hasWebGL2()`, `classifyBootError(err): BootErrorKind`, `assetCommands(missing)`, `BootErrorKind`.

- [ ] **Step 1: Write the failing diagnostics tests**

`src/test/diagnostics.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assetCommands, classifyBootError, hasWebGL2 } from '@/lib/diagnostics';

describe('classifyBootError', () => {
  it('recognises a Cesium asset/worker path failure', () => {
    expect(classifyBootError(new Error('Failed to fetch Assets/approximateTerrainHeights.json')))
      .toBe('cesiumBase');
    expect(classifyBootError(new Error('Workers/createTaskProcessorWorker.js 404')))
      .toBe('cesiumBase');
  });
  it('recognises missing baked assets', () => {
    expect(classifyBootError(new Error('manifest.json HTTP 404'))).toBe('assets');
    expect(classifyBootError(new Error('ENOENT: public/tiles/paper'))).toBe('assets');
  });
  it('recognises missing WebGL', () => {
    expect(classifyBootError(new Error('WebGL not supported'))).toBe('webgl');
  });
  it('does not invent a category', () => {
    expect(classifyBootError('x')).toBe('unknown');
    expect(classifyBootError(new Error(''))).toBe('unknown');
  });
});

describe('assetCommands', () => {
  it('names the whole pipeline when the manifest is missing', () => {
    const c = assetCommands(['tiles/manifest.json']);
    expect(c).toContain('npm run fetch');
    expect(c).toContain('npm run bake');
    expect(c).toContain('npm run labels');
  });
  it('names only the bake when tiles are missing', () => {
    expect(assetCommands(['tiles/paper/6/3/1.jpg'])).toContain('npm run bake');
  });
});

it('hasWebGL2 is false outside a browser', () => {
  expect(hasWebGL2()).toBe(false);
});
```

- [ ] **Step 2: Implement `src/lib/diagnostics.ts`**

```ts
export type BootErrorKind = 'webgl' | 'assets' | 'cesiumBase' | 'unknown';

export function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

export function classifyBootError(err: unknown): BootErrorKind {
  const msg = err instanceof Error ? err.message : '';
  if (/webgl/i.test(msg)) return 'webgl';
  if (/Workers|Widgets|Assets[\\/]|approximateTerrainHeights/.test(msg)) return 'cesiumBase';
  if (/manifest|tiles[\\/]|HTTP \d{3}|ENOENT/i.test(msg)) return 'assets';
  return 'unknown';
}

export function assetCommands(missing: string[]): string {
  const joined = missing.join(' ');
  if (/manifest/.test(joined)) {
    return 'npm run fetch && npm run bake && npm run labels';
  }
  return 'npm run bake -- --top 6 --layer both';
}

export function bootHint(kind: BootErrorKind): string {
  switch (kind) {
    case 'cesiumBase':
      return 'The Cesium static assets were not copied. Run npm run postinstall and confirm public/cesium/Workers/ exists.';
    case 'webgl':
      return 'This app needs WebGL2. Your browser or GPU did not provide it.';
    case 'assets':
      return 'Imagery has not been baked yet. public/tiles/ is git-ignored by design.';
    default:
      return 'Unexpected error. The raw message is shown below.';
  }
}
```

- [ ] **Step 3: The two panels and the boot order**

`NoAssets.tsx` lists the missing paths, prints `assetCommands(missing)` in a `<code>` block, and states that a fresh clone must bake because tiles are not committed. `ErrorPanel.tsx` prints `bootHint(kind)` and, for `unknown`, the raw message in a `<pre>`.

Boot order in `MoonMap.tsx`, each step able to render a panel instead of the canvas: `hasWebGL2()` → `loadManifest()` → `probeAssets()` → `createMoonViewer()` → `attachLabels()` → `attachPicking()`. No step may leave a blank screen.

- [ ] **Step 4: Verify all three failure paths for real**

```bash
mv public/tiles /tmp/tiles-backup && npm run dev
```
Expected: the `NoAssets` panel names `manifest.json` and prints `npm run fetch && npm run bake && npm run labels`, with no uncaught console error. Restore with `mv /tmp/tiles-backup public/tiles`. Then rename `public/cesium` → expect the postinstall hint. Then evaluate `hasWebGL2()` in the console and, if a WebGL-blocked context is available, confirm the WebGL panel; if you cannot block WebGL in this browser, say so in the verification note rather than claiming it was tested. Record all of it in `docs/superpowers/specs/verify-15.md`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/diagnostics.ts src/components/NoAssets.tsx src/components/ErrorPanel.tsx src/components/MoonMap.tsx src/test/diagnostics.test.ts docs/superpowers/specs/verify-15.md
git commit -m "feat: honest failure states for unbaked assets and boot errors"
```

---

## Task 16: The paper look

**Files:**
- Modify: `src/app/globals.css`, `src/components/MoonMap.tsx`

**Interfaces:**
- Consumes: `mode` state. No new data, no re-bake.

- [ ] **Step 1: Tint per mode with CSS**

The Tier A grayscale layer is illumination-normalized albedo, which is inherently flat — good for a map, and the reason the tint belongs in the renderer so it can change without a multi-hour re-bake:

```css
.map-host[data-mode='paper'] {
  background: #efe9dc;
}
.map-host[data-mode='paper'] canvas {
  filter: sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08);
}
.map-host[data-mode='globe'] canvas {
  filter: saturate(1.04) contrast(1.02);
}
```

Add `data-mode={mode}` to the container div, and in `setMode` also set `scene.globe.baseColor` to a paper tone in paper mode so the area around the rectangular world reads as a sheet rather than a void.

- [ ] **Step 2: Verify, and state what this is not**

Screenshot both modes at L2 and L6 into `docs/superpowers/specs/verify-16.md`, and record plainly in that note that a `sepia`/`saturate` filter on a canvas is a look, not a cartographic colour ramp: there are no hypsometric tints and no contours, because D2 chose two layers and the LOLA DEM was explicitly out of scope.

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css src/components/MoonMap.tsx docs/superpowers/specs/verify-16.md
git commit -m "style: per-mode canvas tint for the paper map look"
```

---

## Task 17: The optional Tier B deep bake

**Files:**
- Modify: `scripts/bake.py`
- Test: `scripts/tests/test_disk_guard.py`
- Modify: `README.md`

**Interfaces:**
- Consumes: `bake.estimate`, `--top 7`.
- Produces: `bake.check_disk_or_abort(est, free) -> (ok: bool, needed: int)`.

- [ ] **Step 1: Write the failing guard tests**

`scripts/tests/test_disk_guard.py`:

```python
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bake
import grid


def test_tier_b_is_several_times_tier_a():
    a = bake.estimate(6, ('paper', 'photo'))
    b = bake.estimate(7, ('paper', 'photo'))
    assert b['bytes'] / a['bytes'] > 2.5


def test_guard_refuses_when_short_of_space():
    est = bake.estimate(7, ('paper', 'photo'))
    ok, needed = bake.check_disk_or_abort(est, est['bytes'])
    assert ok is False
    assert needed == int(1.5 * est['bytes'])


def test_guard_allows_with_headroom():
    est = bake.estimate(6, ('paper', 'photo'))
    ok, _ = bake.check_disk_or_abort(est, 2 * est['bytes'])
    assert ok is True


def test_tier_b_tile_count_matches_the_grid_contract():
    per_layer_b = sum(grid.level_cols(L) * grid.level_rows(L) for L in range(8))
    per_layer_a = sum(grid.level_cols(L) * grid.level_rows(L) for L in range(7))
    assert per_layer_a == 10_922
    assert per_layer_b - per_layer_a == 32_768
    assert per_layer_b == 43_690
```

- [ ] **Step 2: Implement the guard and make the refusal actionable**

```python
def check_disk_or_abort(est: dict, free: int):
    needed = int(1.5 * est['bytes'])
    return free >= needed, needed
```

Call it from `main()`. On refusal, print the needed figure, the measured Tier A total from `public/tiles/manifest.json`, and the cheaper subset command `--layer photo --top 7`, so the choice is explicit rather than blocked.

- [ ] **Step 3: Report the cost, then only bake on a yes**

```bash
npm run bake -- --dry-run --top 7 --layer both
.venv/Scripts/python.exe -m pytest scripts/tests/test_disk_guard.py -q
```

Present the printed GB figure and the measured Tier A wall time to the user before starting anything: Tier B is the multi-gigabyte, several-hour path. If he confirms, run `npm run bake -- --top 7 --layer both --force` and then `npm run proof` to re-verify geometry at the deeper level. If he declines, set `--top 6` as the shipped state and write that choice in the README. Do not start a long bake that may be aborted halfway.

- [ ] **Step 4: Commit**

```bash
git add scripts/bake.py scripts/tests/test_disk_guard.py README.md
git commit -m "feat: disk guard and opt-in Tier B deep bake"
```

---

## Task 18: Verification sweep, README and Gate G3

**Files:**
- Create: `README.md`
- Create: `docs/superpowers/specs/verify-18.md`

**Interfaces:**
- Consumes: everything.
- Produces: the record of what was verified, measured, and — explicitly — what was not.

- [ ] **Step 1: Full test run**

```bash
npm run test 2>&1 | tail -30
```

Expected: every vitest suite passes (grid, morph, assets, declutter, tiers, search, scale, keyboard, urlState, diagnostics) and every pytest file passes (grid, blur, composite, labels, contract, bake, proof, disk_guard). A skipped or xfailed test must be explained in `verify-18.md`, not counted as passing.

- [ ] **Step 2: Production build, not just dev**

```bash
npm run build && npm run start
```

Expected: the build succeeds with no Cesium SSR or worker warning, and the app works from the production server at `http://localhost:3000`. Record the build output and the `public/tiles` size.

- [ ] **Step 3: The browser sweep**

Drive Chrome through the connector and capture at minimum: (1) globe from deep space at L0; (2) paper flat at L0; (3) paper at maximum zoom over Mare Tranquillitatis with the name legible and subtle; (4) globe at maximum zoom over Tycho; (5) a strip centred on lon ±180 at L5, checked for a streak; (6) a view centred on the north pole, checked for a wrap artefact and for label pile-up; (7) the feature card open on Apollo 11; (8) the `NoAssets` panel from Task 15. For each: the browser console (any 404, any Cesium warning, any unhandled rejection) and the network log. Also record time-to-first-painted-frame, the number of tile requests during a scripted 5-minute browse, and the median tile duration from `performance.getEntriesByType('resource')`.

- [ ] **Step 4: Write the README**

In this order: what it is; the two modes; quickstart (`npm i` → `npm run fetch` → `npm run bake` → `npm run labels` → `npm run dev`); the Tier B option with its measured cost; the grid contract table with **measured** bytes replacing spec §3's estimates; how to re-run the gates (`npm run test`, `npm run proof`); what the imagery actually is and its resolution ceiling; the verbatim attribution; and spec §7's limitation list restated honestly (no sub-metre zoom anywhere; colour is a chroma transfer from a 76 px/deg base, not a calibrated mosaic; 167 m/px default).

- [ ] **Step 5: Gate G3 — report including the gaps**

`docs/superpowers/specs/verify-18.md` must contain: each gate's result with its evidence file; the measured byte and time figures; every browser-sweep finding; and an explicit **not verified** section — for example frame rate during drag-rotate (GPU-dependent, reported rather than asserted), the `--top 7` path if it was declined, and any Task 15 path that could not be forced in this browser. Do not describe an unrun check as passing.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/superpowers/specs/verify-18.md
git commit -m "docs: verification sweep, gate evidence and quickstart"
```

---

## Self-review record

Checked against `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md`.

1. **Spec coverage.** §1 decisions → Global Constraints. §2.1 sources → Task 6. §2.2 composite → Task 4. §2.3 coordinate conventions → Tasks 3, 5, 6. §3 pyramid and volumes → Tasks 3, 7, 17. §3.0 encoding and command surface → Tasks 1, 7. §3.0.1 environment → Task 1. §3.1 bake stages → Task 6 (Stage 0), Task 7 (working copies folded into the band read, Stages 4–5 in Tasks 5 and 7). §3.2 fetch policy → Task 6. §4.1 label curation and tiering → Tasks 5, 11. §4.2 stack, G1 and the bundling ladder → Tasks 1, 2, 10. §4.3 interface → Tasks 10, 12, 13, 14, 16. §4.4 failure modes → Task 15. §5.1 geometry proof → Task 9. §5.2 unit tests → Tasks 3–5, 10–15. §5.3 pipeline tests → Task 7. §5.4 browser verification → Tasks 8, 10–13, 15, 16, 18. §6 non-goals → README limitations section. §7 limitations → Tasks 3, 9, 18. §8 layout → the per-task file lists.
2. **Gaps found and closed while reviewing.** spec §3.1 Stage 1 (GDAL working copies with internal overviews) had no task, because the band approach makes it unnecessary: each band is read directly at the level's resolution. That is recorded as Spec amendment A and written back into the spec in Task 7 Step 7, rather than left as a silent divergence.
3. **Placeholders.** No step says "add error handling", "TBD" or "similar to Task N". Where a test needed a fixture that a later task produces, the fixture is created in the earlier task (Task 5 Step 1 commits the gazetteer zip so label tests never wait on the network).
4. **Type consistency.** Two defects found and fixed while reviewing. (a) `LayerName` was declared in both `moon.ts` and `src/types.ts` with different members; `src/types.ts` now owns `LayerName = 'paper' | 'photo' | 'probe'` and `moon.ts` imports and re-exports it. (b) That import made Task 2 depend on a file Task 5 created — an ordering bug that would have failed Task 2's build. `src/types.ts` is now created in Task 2 with the three union types and extended in Task 5. `tileBounds` returns an object in TypeScript and a tuple in Python — intentional, idiomatic in each language, and both tested against the same golden vectors. `MOON_RADIUS_M` is 1,737,400 in `grid.py`, `grid.ts`, `moon.ts`, `scale.ts` and the manifest; `TILE`/`TILE_SIZE` is 512 everywhere; `types.ts` imports neither, it only mirrors the serialized shapes.
5. **Scope.** One plan, two phases: pipeline Tasks 1–9, application Tasks 10–18. Not split into two plans, because the shared grid contract and manifest are exactly what catches geometry bugs, and a plan boundary would have put the falsifiable proof (Task 9) on the far side of it from the app that depends on it.
6. **Corrected after reading the actual gazetteer data, not the summary of it.** Three of my earlier claims were wrong and are fixed in Tasks 5, 9 and 12 plus spec §4.1/§5.1: (a) the IAU descriptor codes are `SF/AA/RI/LF/MO/DO/ME/LC/CA/VA/SI/PR/RU`, not the `VS/RR/CH/MT/LA/SP` set I first wrote, so curation keys on the real codes; (b) there are **no landing-site records** — no "Apollo 11" exists — so tier 3 is the 81 `LF` astronaut-named traverse features with `mission` parsed from `origin`, and the substring heuristic that would have wrongly promoted the craters *Apollo*, *Surveyor*, *Chang Heng* and *Chang-Ngo* is removed and pinned by a test; (c) three named features I had assumed exist (`Mare Aestuum`, `Hermes`, `South Pole-Aitken Basin`) are not IAU entries, and `Laplace`, `Brisbane`, `Euler`, `Mons Hadley` are absent or below the cut, so the geometry-proof marker lists now contain only names verified present in the file, and the gate moved from per-feature percentile thresholds to a median-contrast test because basalt-flooded craters are legitimately dark.
