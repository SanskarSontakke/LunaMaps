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
