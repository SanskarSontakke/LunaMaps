"""Gate G2 probe: the real-imagery half of the G2 evidence, made reproducible.

`scripts/proof.py` decides PASS/FAIL on correctly registered imagery. This
script answers the other half of the question -- what the SAME measurements look
like when the lookup is deliberately mis-registered -- because a gate that has
never been seen to fail is not evidence. It prints; it never asserts, and it
always exits 0. Committed as a diagnostic in the same role as
`scripts/g1_tiling_probe.mjs`, so a fresh clone can re-derive the numbers quoted
in `docs/superpowers/specs/gate-G2.md` instead of trusting a transcript.

    .venv/Scripts/python.exe scripts/g2_geometry_probe.py [--sources]

`--sources` adds the source-raster cross-check (reads data/raw/*.jp2 through
rasterio, ~2 min) that separates "the tile says 0" from "the tile was indexed at
the wrong place".
"""
from __future__ import annotations
import argparse
import math
import sys
from pathlib import Path
import numpy as np
from PIL import Image

import grid
import proof
from labels import bbox_contains, wrap_lon

OUT = Path('public/tiles')
LEVEL = proof.PROBE_LEVEL
MODES = ('true', 'flip', 'rot')


def _shift(lon: float, lat: float, mode: str):
    """The coordinate a *mis-registered* map would show at (lon, lat)."""
    if mode == 'flip':
        return lon, -lat                      # y-flip: row 0 is the south pole
    if mode == 'rot':
        return wrap_lon(lon + 180.0), lat     # 180 deg longitude error
    return lon, lat


def histogram_stats():
    """Stream the level's tiles into a 256-bin DN histogram, plus the share of
    exactly-black pixels per latitude band (the WAC polar data defect)."""
    counts = np.zeros(256, dtype=np.int64)
    rows = grid.level_rows(LEVEL)
    zero_by_row = np.zeros(rows, dtype=np.int64)
    px_by_row = np.zeros(rows, dtype=np.int64)
    black_tiles = 0
    for p in sorted((OUT / 'paper' / str(LEVEL)).glob('*/*.jpg')):
        im = np.asarray(Image.open(p).convert('L'))
        counts += np.bincount(im.ravel(), minlength=256)
        z = int((im == 0).sum())
        zero_by_row[int(p.stem)] += z
        px_by_row[int(p.stem)] += im.size
        if z > im.size // 2:
            black_tiles += 1
    n = int(counts.sum())
    xs = np.arange(256, dtype=np.float64)
    mean = float((xs * counts).sum() / n)
    sd = math.sqrt(float(((xs ** 2 * counts).sum() / n) - mean ** 2))
    return counts, n, mean, sd, zero_by_row, px_by_row, black_tiles


def point_medians(counts, mean, sd):
    feats = proof._by_name('public/data/features.json')
    print(f'global L{LEVEL} paper: pixels={int(counts.sum()):,} mean={mean:.2f} '
          f'sd={sd:.2f} DN')
    print('\npoint lookups (the gate\'s own method: one pixel per marker centroid)')
    print(f'{"mode":6} {"mare":>7} {"high":>7} {"contrast":>10} {"sigma":>7}')
    for mode in MODES:
        m = [proof.tile_pixel(str(OUT), 'paper', LEVEL,
                              *_shift(*feats[k]['geometry']['coordinates'], mode))
             for k in proof.MARE_CENTRES]
        h = [proof.tile_pixel(str(OUT), 'paper', LEVEL,
                              *_shift(*feats[k]['geometry']['coordinates'], mode))
             for k in proof.HIGHLAND_CENTRES]
        mm, hm = float(np.median(m)), float(np.median(h))
        print(f'{mode:6} {mm:7.1f} {hm:7.1f} {hm - mm:+10.1f} '
              f'{(hm - mm) / sd:+7.2f}')
        if mode == 'true':
            print(f'       mare n={len(m)} sorted={sorted(m)}')
            print(f'       high n={len(h)} sorted={sorted(h)}')


def apollo_reads():
    feats = proof._by_name('public/data/features.json')
    hist = proof.albedo_percentiles(str(OUT), 'paper', LEVEL)
    names = [f['properties']['name'] for f in feats.values()
             if (f['properties'].get('mission') or '') == 'Apollo 11']
    inside = feats['Mare Tranquillitatis']['properties']['bbox']
    print('\nApollo 11 traverse reads (the gate requires each <= '
          f'p67={hist["p67"]}, and containment in the Tranquillitatis bbox)')
    for mode in MODES:
        row = []
        for name in names:
            lon, lat = feats[name]['geometry']['coordinates']
            v = proof.tile_pixel(str(OUT), 'paper', LEVEL, *_shift(lon, lat, mode))
            row.append(f'{name}={v}')
        cont = [f'{name}={"in" if bbox_contains(inside, *feats[name]["geometry"]["coordinates"]) else "OUT"}'
                for name in names]
        print(f'  {mode:5} albedo {" ".join(row):<58} bbox {" ".join(cont)}')


def _bbox_pixels(w, s, e, n):
    """Every world pixel inside a bbox, wrap-aware in longitude."""
    wx0, wy0 = grid.world_px_of(w, n, LEVEL)
    wx1, wy1 = grid.world_px_of(e, s, LEVEL)
    if wx1 < wx0:                       # the box crosses the antimeridian
        wx1 += grid.world_px_width(LEVEL)
    cols, rows = grid.level_cols(LEVEL), grid.level_rows(LEVEL)
    cache = {}
    out = []
    for wc in range(int(math.floor(wx0)), int(math.ceil(wx1)) + 1):
        for wr in range(int(math.floor(wy0)), int(math.ceil(wy1)) + 1):
            x, y = ((wc // grid.TILE) % cols,
                    min(max(wr // grid.TILE, 0), rows - 1))
            if (x, y) not in cache:
                cache[(x, y)] = np.asarray(
                    Image.open(OUT / 'paper' / str(LEVEL) / str(x) / f'{y}.jpg')
                    .convert('L'))
            out.append(int(cache[(x, y)][wr % grid.TILE, wc % grid.TILE]))
    return np.array(out, dtype=np.float32)


def footprint_medians():
    """A much larger sample than the gate uses: every pixel inside each trusted
    bbox. Same statistic direction, independent of any single pixel."""
    feats = proof._by_name('public/data/features.json')
    print('\nfootprint lookups (median of every L5 pixel inside each gazetteer bbox)')
    for mode in MODES:
        m, h = [], []
        for name in proof.MARE_CENTRES + proof.HIGHLAND_CENTRES:
            bb = feats[name]['properties']['bbox']
            if bb is None:
                continue
            w, s, e, n = bb
            if mode == 'flip':
                s, n = -n, -s
            elif mode == 'rot':
                w, e = wrap_lon(w + 180.0), wrap_lon(e + 180.0)
            v = _bbox_pixels(w, s, e, n)
            if v.size == 0:
                continue
            (m if name in proof.MARE_CENTRES else h).append(float(np.median(v)))
        print(f'  {mode:5} mare={np.median(m):6.1f} (n={len(m)})  '
              f'high={np.median(h):6.1f} (n={len(h)})  '
              f'contrast={np.median(h) - np.median(m):+6.1f} DN')


def source_crosscheck():
    """Is a surprising tile value a lookup error or the source's own value?"""
    src = Path('data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2')
    if not src.exists():
        print('\nsource cross-check skipped (no data/raw detail jp2)')
        return
    import rasterio
    ds = rasterio.open(src)
    A, _, C, _, E, F = [float(v) for v in ds.transform[:6]]
    pts = [('Lacus Mortis', 27.3191, 45.1348, 0), ('Piccolomini', 32.1986, -29.6998, 6),
           ('Hermite', -93.3152, 86.1659, 8), ('Tycho', -11.2153, -43.2958, 54),
           ('Apollo11 West', 23.4908, 0.6705, 28),
           ('Mare Orientale', -94.6703, -19.8655, 56)]
    print('\nsource-vs-tile cross-check (13x13 source window ~ one L5 pixel)')
    for name, lon, lat, expected in pts:
        c0 = int(round((lon - C) / A))
        r0 = int(round((lat - F) / E))
        w = ds.read(1, window=rasterio.windows.Window(max(c0 - 6, 0), max(r0 - 6, 0),
                                                      13, 13))
        v = proof.tile_pixel(str(OUT), 'paper', LEVEL, lon, lat)
        print(f'  {name:16} tile={v:3} (expected {expected:3})  '
              f'src mean={w.mean():6.1f} min={w.min():3} max={w.max():3}')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--sources', action='store_true',
                    help='also read the source jp2 (slow)')
    args = ap.parse_args()
    counts, n, mean, sd, zero_by_row, px_by_row, black_tiles = histogram_stats()
    print(f'Gate G2 probe: paper layer, level {LEVEL}, {n:,} pixels')
    frac = zero_by_row / np.maximum(px_by_row, 1)
    print(f'exact-black pixels: {int(zero_by_row.sum()):,} '
          f'({100 * zero_by_row.sum() / n:.2f}% of the layer), '
          f'{black_tiles} tiles more than 50% black')
    band = [f'row {y} ({90 - (y + 1) * 180 / grid.level_rows(LEVEL):6.1f}..'
            f'{90 - y * 180 / grid.level_rows(LEVEL):5.1f} deg) {100 * frac[y]:5.2f}%'
            for y in range(grid.level_rows(LEVEL)) if frac[y] > 0.02]
    print('  latitude bands over 2% black: ' + ', '.join(band))
    point_medians(counts, mean, sd)
    apollo_reads()
    footprint_medians()
    if args.sources:
        source_crosscheck()
    print('\nG2 itself is decided by `npm run proof`; this probe only shows what a '
          'flipped or rotated map would have measured.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
