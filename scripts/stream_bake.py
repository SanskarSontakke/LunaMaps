"""Bake region boxes out of a remote cloud-optimised GeoTIFF, without downloading it.

The source is the SELENE/Kaguya TC orthomosaic: 78 GB, 4096 px/deg, global, tiled
512, JPEG-compressed, 9 overviews, already georeferenced to *this* grid contract
(level L = 2^(L+1) columns x 2^L rows of 512 px, row 0 at the north). Because it is
already equirectangular, the maths in `grid.py` transfers to it verbatim and no
resampling into the grid is needed -- only a downsample, which is what `average`
does here.

How it reads (plan step 2, requirement 2): one bulk pass per region, in horizontal
**row chunks** of bounded source height. A per-tile read pattern would be ~62,000
requests for the whole plan, and a 2048x2048 window read from this file measured
5.1 s, so the request count is the cost. A chunk is always a whole number of tile
rows, because a tile that straddles two reads cannot be assembled; when one tile row
alone already exceeds the budget, one tile row is the floor. A second cap bounds the
chunk in *pixels* and splits along whole tile columns, because a whole-latitude band
at L9 is 524,288 level px wide and five tile rows of that would be a 2.7 GB buffer.

What it refuses (requirements 3, 4, 7): a source that is not single-band uint8, a
source whose projection is not equirectangular, a georeference that is not in
degrees, any level shallower than the source's own resolution -- never resample
up -- and a box whose tile rectangle reaches geometry the file does not contain.
The gate reads the **file's own transform**, not the label's `pxPerDeg`, because
the label is a claim and the raster is the fact. That last refusal is the one a
green run cannot otherwise show you: rasterio crops an out-of-range window to the
dataset extent and allocates the *requested* shape from `np.empty`, so an
under-covering box answers with full-size plausible garbage, every downstream
check passes, and the availability report advertises it.

Two things this module deliberately does not do:

* It holds no URL. Every URL comes from `regions.SOURCES`, the table Task 1 ships;
  `default_opener` is the only function that touches `rasterio`, and it only
  prepends GDAL's streaming prefix to the URL it was handed. Tests inject an opener,
  so nothing here can open a socket.
* A bake run writes no manifest. Tiles go through `bake.save_tile`, which owns the
  `{layer}/{L}/{x}/{y}.jpg` layout, the skip-if-exists resume and `--force`; the
  availability answer comes back off the filesystem (`availability_from_disk`),
  because the plan says what should exist and only the disk says what does. The
  one exception is the deliberate, separate `--publish` step: it merges
  `layers.<name>` into the delivered manifest from the tiles already on disk
  (`publish`), and writes that single file and nothing else.

No box edge is padded or wrapped: reads are tile-aligned, so the periodic-padding
hazard (`wrap_x=False`) does not arise -- an antimeridian box is simply two
rectangles, each read at its own edge column.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.errors import RasterioError
from rasterio.windows import Window

import bake
import grid
import manifest
import regions

# The one thing added to a source URL: GDAL's streaming prefix, which turns an
# open-the-whole-file into ranged reads of just the overviews and blocks asked for.
VSICURL_PREFIX = '/vsicurl/'
DEFAULT_REGIONS_FILE = 'public/data/regions.json'
DEFAULT_OUT = 'public/tiles'
DEFAULT_LAYER = 'ortho'
DEFAULT_QUALITY = 85
# Row-chunk height in SOURCE pixels (requirement 2's default).
DEFAULT_CHUNK_SOURCE_ROWS = 4096
# And in buffer pixels, so a wide box costs memory it can actually pay for.
MAX_CHUNK_PIXELS = 64 * 1024 * 1024
ATTEMPTS = 3
BACKOFF_SECONDS = 2.0
# The gate is `source px/deg >= level px/deg`. `1.0 + tol` only absorbs the float
# wobble in reading a scale back off a geotransform, so a source that is exactly
# the level's grid is not refused for the crime of being representable.
RESOLUTION_TOL = 1e-9
# Same reasoning on the extent gate: a box that legitimately reaches the source
# edge lands on it exactly, and the float wobble in `degrees * px/deg` at world
# scale is ~3e-10 px. A real overrun is a whole tile edge -- hundreds of source px
# at L10 -- so 1e-6 px sits four orders above the noise and far below the defect.
COVERAGE_TOL_PX = 1e-6


class Refusal(RuntimeError):
    """The source is not the source the plan claims; stop the run.

    Raised for a plan-level impossibility (unknown or wrongly projected source,
    wrong band count or dtype, a level the raster cannot pay for), which is a
    different thing from a stream that reset: that is a per-region failure.
    """


class ShortRead(RuntimeError):
    """The read answered with fewer rows than asked for.

    Deliberately not retryable: a short answer is a wrong answer, not a late one,
    and part of a chunk is not a tile. The region fails; its tiles are not written.
    """


class PublishRefusal(RuntimeError):
    """`--publish` will not write the manifest.

    Raised for the three states where a half-written or empty `layers.ortho` is
    worse than none: no tiles to describe, an availability block
    `validate_availability` rejects (a 404 on every frame), or a merge that would
    drop a base layer or `geometryProof` the app boots on. In every case the
    manifest on disk is left byte-for-byte untouched, so a refusal is safe to
    retry once the tree or the manifest is fixed.
    """


def _area(rng) -> int:
    x0, x1, y0, y1 = rng
    return (x1 - x0 + 1) * (y1 - y0 + 1)


# ---------------------------------------------------------------------------
# the plan: what a run costs, before anyone spends a byte
# ---------------------------------------------------------------------------

def plan(regs, *, sources=None, only=None) -> list[dict]:
    """Expand region boxes into the tile ranges and source records a run will use.

    The tile arithmetic is `regions`' (Task 1), not a second copy: `tiles` is
    literally `regions.tile_count`, so a plan that disagreed with the shipped
    region cost would be caught by the tests that own that number.
    """
    table = regions.SOURCES if sources is None else sources
    entries = []
    for reg in regs:
        if only is not None and reg['id'] != only:
            continue
        box = regions.box_of(reg)
        per_level = {L: regions.tile_ranges(box, L)
                     for L in regions.levels_of(reg)}
        entries.append({
            'id': reg['id'],
            'name': reg.get('name', reg['id']),
            'box': box,
            'levels': sorted(per_level),
            'source': reg.get('source'),
            # The record itself, never a copy: the URL and pxPerDeg this run uses
            # are the ones `regions.py` ships.
            'src': table.get(reg.get('source')),
            'perLevel': per_level,
            'tilesPerLevel': {L: sum(_area(r) for r in rs)
                              for L, rs in per_level.items()},
            'tiles': regions.tile_count(reg),
        })
    return entries


def check_plan(entries) -> list[str]:
    """Every reason this plan must not run, as messages that name the region.

    Empty means admissible. Collected, not short-circuited, so one command tells
    the operator about both the projection and the resolution instead of making
    them re-run to find the second one.
    """
    problems = []
    for e in entries:
        key = e['source']
        src = e['src']
        if src is None:
            problems.append(f"{e['id']}: region cites source {key!r}, which is not "
                            f"in regions.SOURCES; there is no URL to stream from")
            continue
        projection = src.get('projection')
        if projection != 'equirectangular':
            levels = ', '.join(f'L{L}' for L in e['levels'])
            problems.append(f"{e['id']}: source {key!r} is {projection}, not "
                            f"equirectangular. This path applies the grid's own "
                            f"lon/lat maths to it, which would bake {e['id']} at "
                            f"{levels} into a precise lie; refusing.")
        for L in e['levels']:
            need = grid.px_per_deg(L)
            have = float(src['pxPerDeg'])
            if have * (1.0 + RESOLUTION_TOL) < need:
                problems.append(f"{e['id']}: L{L} needs {need:.2f} px/deg but "
                                f"source {key!r} is {have:.2f} px/deg, so baking "
                                f"L{L} would upsample {need / have:.2f}x of every "
                                f"pixel; refusing. Cap the region at the deepest "
                                f"level the source pays for.")
    return problems


# ---------------------------------------------------------------------------
# the source: identity, gate, geometry
# ---------------------------------------------------------------------------

def default_opener(url):
    """Open a remote COG for streaming range reads. The only network here.

    Tests inject an opener instead, so this function is the only one that can
    reach a socket and the only thing in the module that touches rasterio.
    """
    return rasterio.open(VSICURL_PREFIX + url)


def source_grid(ds) -> dict:
    """The source's own grid, read from the file's transform.

    Not `pxPerDeg` from the label, and not a constant typed in here: requirement 4
    says geometry comes from the georeference, and a COG whose label disagrees with
    its grid is exactly the file that bakes a shifted layer.
    """
    t = ds.transform
    if t is None:
        raise Refusal('source carries no georeference; this path maps degrees to '
                      'pixels through the file\'s own transform and will not '
                      'invent one for it')
    if abs(t.b) > 1e-12 or abs(t.d) > 1e-12:
        raise Refusal(f'source geotransform is skewed or rotated (b={t.b}, d={t.d}); '
                      f'tile slicing here assumes north-up, east-left pixels')
    if not (t.a > 0.0 and t.e < 0.0):
        raise Refusal(f'source geotransform a={t.a}, e={t.e} is not east-increasing '
                      f'and north-decreasing; row 0 must be the north')
    # And the units must be degrees. Everything downstream divides a degree span by
    # `t.a`, so a projected, metre-scaled file (origin easting/northing in the 1e5
    # to 1e7 range) reads back as an absurd "px/deg" that clears the resolution gate
    # instead of failing it. The origin is checked rather than `ds.crs.is_geographic`
    # because this path's maths only ever uses the transform, and a planetary
    # equirectangular COG can legitimately carry CRS metadata a generic reader calls
    # projected -- the extents are the fact, the CRS spelling is not. The bound is
    # the full +-360 / +-180 sweep rather than +-180 / +-90 so that a 0..360
    # longitude file is not refused *here*; it fails in `check_coverage` instead,
    # where its negative column offsets are the evidence.
    if abs(t.c) > 360.0 or abs(t.f) > 180.0:
        raise Refusal(f'source georeference is not in degrees: its north-west '
                      f'origin is ({t.c}, {t.f}), which is a projected, '
                      f'metre-scaled grid. Read as degrees it would be '
                      f'{1.0 / t.a:.6g} "px/deg", so the resolution gate below '
                      f'would be comparing nonsense; this path maps lon/lat '
                      f'through the transform and needs a degree transform')
    return {'west': t.c, 'north': t.f,
            'pxPerDegLon': 1.0 / t.a, 'pxPerDegLat': -1.0 / t.e}


def gate_source(ds, levels) -> dict:
    """Band/dtype and resolution, against the file. Raise or hand back the grid.

    `levels` is everything the region intends to bake, so a plan that asks for one
    level too deep stops before the first read rather than after a good L8.
    """
    if int(ds.count) != 1:
        raise Refusal(f'source has {ds.count} bands; this layer is one band in and '
                      f'one band out, and band 1 of a multi-band source is not '
                      f'necessarily the orthophoto the plan thinks it is')
    dtype = ds.dtypes[0]
    if dtype != 'uint8':
        raise Refusal(f'source band 1 is dtype {dtype!r}, not uint8; a shaded '
                      f'orthomosaic arrives as uint8 and anything else means the '
                      f'file changed under us')
    g = source_grid(ds)
    for L in sorted(levels):
        need = grid.px_per_deg(L)
        have = min(g['pxPerDegLon'], g['pxPerDegLat'])
        if have * (1.0 + RESOLUTION_TOL) < need:
            raise Refusal(f"the file's own transform is {have:.2f} px/deg, but L{L} "
                          f"needs {need:.2f} px/deg: baking L{L} would upsample it "
                          f"and ship interpolation as measurement")
    return g


def _col_of(g, L, x) -> float:
    """Source pixel column at the west edge of tile column `x` (contract maths).

    Every edge in this module comes from `grid.tile_bounds` on a tile that is
    actually in the level grid: the east edge of a range is read from its *last*
    column, never from `x1 + 1`, because a range that ends at the antimeridian
    legitimately ends at the last column there.
    """
    return (grid.tile_bounds(L, x, 0)[0] - g['west']) * g['pxPerDegLon']


def _row_of(g, L, y) -> float:
    """Source pixel row at the north edge of tile row `y` (row 0 is the north)."""
    return (g['north'] - grid.tile_bounds(L, 0, y)[3]) * g['pxPerDegLat']


def _east_of(g, L, x) -> float:
    """Source pixel column at the EAST edge of tile column `x`, same rectangle."""
    return (grid.tile_bounds(L, x, 0)[2] - g['west']) * g['pxPerDegLon']


def _south_of(g, L, y) -> float:
    """Source pixel row at the south edge of tile row `y` (down is +row)."""
    return (g['north'] - grid.tile_bounds(L, 0, y)[1]) * g['pxPerDegLat']


def row_chunks(g, L, rng, chunk_source_rows):
    """Plan one region-level read as (window, out_shape, tile box) chunks.

    The window is the source-pixel rectangle of the tile range it covers, and it
    stays fractional on purpose: the source grid does not divide the level grid (a
    3000 px/deg crop gives 527.34375 source rows per 512-px L10 tile row), and
    snapping to whole source pixels would slide every tile by up to a pixel -- most
    of a pixel at L10.

    A chunk is a whole number of tile rows so that no tile straddles two reads, and
    it honours `chunk_source_rows` except where a single tile row already exceeds
    it, in which case one tile row is the floor. Every boundary is derived from
    `grid.tile_bounds` for the tile rows it encloses, never by accumulating a chunk
    height, so a long box cannot drift a pixel; column segments likewise break on
    whole tile columns, so a tile is never split across reads either.
    """
    x0, x1, y0, y1 = rng
    cols = x1 - x0 + 1
    tile_row_src = _south_of(g, L, y0) - _row_of(g, L, y0)
    rows_per_chunk = max(1, int(chunk_source_rows / tile_row_src + 1e-9))
    tiles_wide = max(1, min(cols, MAX_CHUNK_PIXELS
                            // (rows_per_chunk * grid.TILE * grid.TILE)))
    chunks = []
    for ty0 in range(y0, y1 + 1, rows_per_chunk):
        ty1 = min(ty0 + rows_per_chunk - 1, y1)
        row_off, row_end = _row_of(g, L, ty0), _south_of(g, L, ty1)
        for cx in range(0, cols, tiles_wide):
            xs = x0 + cx
            xe = min(xs + tiles_wide - 1, x1)
            col_off, col_end = _col_of(g, L, xs), _east_of(g, L, xe)
            chunks.append((Window(col_off, row_off, col_end - col_off,
                                  row_end - row_off),
                           ((ty1 - ty0 + 1) * grid.TILE, (xe - xs + 1) * grid.TILE),
                           (ty0, ty1 + 1, xs, xe)))
    return chunks


def region_reads(entry, g, chunk_source_rows) -> list:
    """Every `(level, tile range, chunks)` the region will read, planned once.

    Planned up front instead of as the reads happen, for two reasons: the tiles
    this region is about to ask for are known before the first request costs one,
    and `check_coverage` has to see the whole region -- a box whose L10 rectangle
    leaves the raster must refuse before its L8 has already been written.
    """
    return [(L, rng, row_chunks(g, L, rng, chunk_source_rows))
            for L in entry['levels'] for rng in entry['perLevel'][L]]


def check_coverage(entry, ds, reads) -> None:
    """Refuse a region whose planned windows are not inside the source raster.

    This is the check rasterio will not do for you. With `boundless=False` -- the
    default, and the one `read_chunk` uses -- a window past the dataset extent is
    quietly *cropped to the extent* and the output is allocated from the *requested*
    `out_shape` with `np.empty`, into which the cropped region is warped. So an
    over-running box answers with a full-size, geometrically stretched buffer of
    plausible-looking values: `arr.shape == out_shape`, so `ShortRead` cannot fire,
    `save_tile` succeeds, the region reports success, and `availability_from_disk`
    then faithfully advertises the corruption. Nothing else in the pipeline can see
    it, so the windows are compared with `ds.width` / `ds.height` here, before a
    single byte is requested. All four edges: past the east or south edge, and
    starting left of the west or above the north edge.
    """
    over = []
    for L, _rng, chunks in reads:
        for window, _out_shape, _box in chunks:
            east = window.col_off + window.width
            south = window.row_off + window.height
            if east > ds.width + COVERAGE_TOL_PX:
                over.append(f'L{L} needs source column {east:.2f} but the raster is '
                            f'{ds.width} wide')
            if south > ds.height + COVERAGE_TOL_PX:
                over.append(f'L{L} needs source row {south:.2f} but the raster is '
                            f'{ds.height} tall')
            if window.col_off < -COVERAGE_TOL_PX:
                over.append(f'L{L} starts at source column {window.col_off:.2f}, '
                            f'left of the raster')
            if window.row_off < -COVERAGE_TOL_PX:
                over.append(f'L{L} starts at source row {window.row_off:.2f}, above '
                            f'the raster')
    if over:
        raise Refusal(f"{entry['id']} reaches geometry the source does not cover: "
                      + '; '.join(over) + '. Refusing instead of reading it: an '
                      'out-of-range window is cropped to the extent and the '
                      'requested shape filled from np.empty, so the tiles would '
                      'be complete, plausible and invented. Narrow the box to '
                      'what the file actually spans.')


def _sleep(seconds):
    """The one pause in the read path, injected so tests need no wall clock."""
    time.sleep(seconds)


def read_chunk(ds, window, out_shape, sleep=_sleep):
    """Read one chunk, retrying a stream reset, refusing a short answer.

    `ATTEMPTS` tries, `BACKOFF_SECONDS` apart, on `OSError` only (which is what a
    `/vsicurl` reset raises, and what a test's spy raises to look like one). A read
    that came back with the wrong shape is `ShortRead`: retrying it would ask the
    same question again, and part of a chunk is not a tile.

    The retry stays narrow on purpose. Anything else rasterio raises -- a
    `WindowError`, an aborted terminal read -- is a `RasterioError` that is *not* an
    `OSError`, so it leaves this loop immediately and `bake_all` fails the region
    once rather than sleeping three times over a deterministic answer.
    """
    last = None
    for attempt in range(ATTEMPTS):
        if attempt:
            sleep(BACKOFF_SECONDS)
        try:
            arr = ds.read(1, window=window, out_shape=tuple(out_shape),
                          resampling=Resampling.average)
        except OSError as exc:
            last = exc
            continue
        if arr.ndim != 2 or tuple(arr.shape) != tuple(out_shape):
            raise ShortRead(f'asked for {tuple(out_shape)} and the source answered '
                            f'{arr.shape}; a partly-read chunk writes nothing')
        return arr
    raise last


def _bake_chunks(ds, out_dir, layer, L, chunks, quality, force, sleep) -> int:
    """Read and write one tile range at one level; return the tiles written.

    Takes the chunks `region_reads` planned and `check_coverage` cleared, so the
    windows issued here are exactly the ones the extent gate looked at.
    """
    written = 0
    for window, out_shape, (ty0, ty1, xs, xe) in chunks:
        buf = read_chunk(ds, window, out_shape, sleep)
        for ty in range(ty0, ty1):
            for tx in range(xs, xe + 1):
                row = (ty - ty0) * grid.TILE
                col = (tx - xs) * grid.TILE
                tile = np.ascontiguousarray(
                    buf[row:row + grid.TILE, col:col + grid.TILE])
                if bake.save_tile(out_dir, layer, L, tx, ty, tile, quality, force):
                    written += 1
    return written


def bake_all(entries, out_dir, *, opener=None, layer=DEFAULT_LAYER,
             quality=DEFAULT_QUALITY, force=False,
             chunk_source_rows=DEFAULT_CHUNK_SOURCE_ROWS, sleep=None):
    """Bake every planned region, and return (tiles written, failed regions).

    One open per region: the request count is the cost this whole path is built
    around, and it is also what makes a flake recoverable -- the retry re-reads a
    chunk on the dataset that is already open instead of paying for a new header
    fetch. A read that never clears fails its region alone; the others finish. A
    `Refusal` (bad source, bad resolution, a box the source does not cover) is not
    per-region: it stops the run, because every region would hit the same wall.

    The region-level catch is wider than the retry's on purpose: `OSError` for the
    stream resets that are worth asking twice, `ShortRead` for a wrong answer, and
    `rasterio.errors.RasterioError` for everything else the library raises, because
    a non-`OSError` one (`WindowError`, an aborted read) escaping here would abort
    the whole run with a traceback instead of reporting one region and continuing.
    `Refusal` is a `RuntimeError` and `RasterioError` is not, so a refusal still
    stops the run rather than being filed as one region's bad luck.

    Tiles are written as each whole chunk completes, so a region that dies on its
    fifth chunk leaves four chunks of complete tiles on disk -- never a partial
    tile, and never a region reported as success. Resume and `--force` belong to
    `bake.save_tile`.
    """
    open_ = opener or default_opener
    nap = sleep or _sleep
    written, failed = 0, []
    for e in entries:
        if e['src'] is None:
            raise Refusal(f"{e['id']}: source {e['source']!r} is not in "
                          f"regions.SOURCES, so there is nothing to stream")
        ds = None
        try:
            ds = open_(e['src']['url'])
            g = gate_source(ds, e['levels'])
            reads = region_reads(e, g, chunk_source_rows)
            check_coverage(e, ds, reads)
            for L, _rng, chunks in reads:
                written += _bake_chunks(ds, out_dir, layer, L, chunks, quality,
                                        force, nap)
        except (OSError, ShortRead, RasterioError) as exc:
            failed.append({'id': e['id'], 'error': str(exc)})
        finally:
            if ds is not None:
                ds.close()
    return written, failed


# ---------------------------------------------------------------------------
# availability: the filesystem answers, not the plan
# ---------------------------------------------------------------------------

def _runs(values):
    """Maximal contiguous runs of a sorted list of ints."""
    out = []
    start = prev = values[0]
    for v in values[1:]:
        if v == prev + 1:
            prev = v
            continue
        out.append((start, prev))
        start = prev = v
    out.append((start, prev))
    return out


def ranges_from_tiles(present) -> list:
    """Tile coordinates to merged [x0, x1, y0, y1] ranges, the schema's shape.

    Rows are coalesced along x, then adjacent rows sharing an x span are coalesced
    along y, and `regions.merge` does the final pass, so a hole splits a range and
    two boxes that meet become one -- which is the difference between the app
    requesting a tile that exists and one that 404s.
    """
    by_row: dict[int, list[int]] = {}
    for x, y in present:
        by_row.setdefault(int(y), []).append(int(x))
    spans = [(x0, x1, y) for y in sorted(by_row) for x0, x1 in _runs(sorted(by_row[y]))]
    by_span: dict[tuple[int, int], list[int]] = {}
    for x0, x1, y in spans:
        by_span.setdefault((x0, x1), []).append(y)
    rects = [[x0, x1, ys[0], ys[-1]] for (x0, x1), ys in sorted(by_span.items())
             for ys in _runs(sorted(ys))]
    return regions.merge(rects)


def availability_from_disk(out_dir, layer, levels) -> dict:
    """`{level: [[x0,x1,y0,y1], ...]}` for the JPEGs that actually exist.

    `manifest.validate_availability` accepts the result. Empty levels are omitted
    rather than listed as empty, because an empty range is a promise of nothing.
    """
    out = Path(out_dir)
    avail = {}
    for L in sorted(int(v) for v in levels):
        d = out / layer / str(L)
        if not d.is_dir():
            continue
        present = {(int(x_dir.name), int(f.stem))
                   for x_dir in d.iterdir()
                   if x_dir.is_dir() and x_dir.name.isdigit()
                   for f in x_dir.glob('*.jpg') if f.stem.isdigit()}
        if present:
            avail[str(L)] = ranges_from_tiles(sorted(present))
    return avail


# ---------------------------------------------------------------------------
# publish: merge layers.<name> into the delivered manifest
#
# This is the only path in the module that writes a manifest, and it writes
# exactly one file. The rule that makes the whole step exist -- the filesystem
# answers, not the plan -- is kept: availability, `top`, the tile count and the
# byte total all come off the tiles on disk. The merge reads the delivered
# manifest, adds one key under `layers`, and writes it back through
# `manifest.write_manifest` so the LF + single-trailing-newline convention the
# tracked file is checked against is the writer's, not a hand-rolled one.
# ---------------------------------------------------------------------------

def _disk_tile_index(out_dir, layer) -> dict:
    """`{level:int -> {(x, y), ...}}` for every JPEG under `<out>/<layer>`.

    The raw coordinates behind `availability_from_disk`, so the tile count, the
    byte total and the region cross-check can read the same on-disk set instead of
    re-walking the tree. Off the filesystem only, never off the plan.
    """
    d = Path(out_dir) / layer
    idx: dict[int, set] = {}
    if not d.is_dir():
        return idx
    for sub in d.iterdir():
        if not (sub.is_dir() and sub.name.isdigit()):
            continue
        coords = idx.setdefault(int(sub.name), set())
        for x_dir in sub.iterdir():
            if not (x_dir.is_dir() and x_dir.name.isdigit()):
                continue
            x = int(x_dir.name)
            for f in x_dir.glob('*.jpg'):
                if f.stem.isdigit():
                    coords.add((x, int(f.stem)))
    return idx


def _region_provenance(out_dir, layer, regions_file):
    """`(source key, [region ids])` for the tiles that actually exist.

    A region counts as published only when at least one of its planned tiles is on
    disk, so the record names what the tree shows rather than what the plan hoped
    for -- which is why the refused `nac-spole` polar cap never appears: none of
    its tiles were written. If the regions file is absent there is nothing to
    cross-reference and provenance is empty; the availability itself does not
    depend on it.
    """
    idx = _disk_tile_index(out_dir, layer)
    path = Path(regions_file)
    if not path.exists():
        return None, []
    data = json.loads(path.read_text(encoding='utf-8'))
    ids, keys = [], []
    for reg in data.get('regions', []):
        present = False
        for L in regions.levels_of(reg):
            ranges = regions.tile_ranges(regions.box_of(reg), L)
            for (x, y) in idx.get(L, ()):
                if any(r[0] <= x <= r[1] and r[2] <= y <= r[3] for r in ranges):
                    present = True
                    break
            if present:
                break
        if present:
            ids.append(reg['id'])
            key = reg.get('source')
            if key and key not in keys:
                keys.append(key)
    source = keys[0] if len(keys) == 1 else (keys or None)
    return source, sorted(ids)


def publish(out_dir, layer=DEFAULT_LAYER, *, regions_file=DEFAULT_REGIONS_FILE,
            dry_run=False) -> dict:
    """Merge `layers.<layer>` into the delivered manifest; return the record.

    Availability and `top` are derived from the tiles on disk (never the plan),
    validated with `manifest.validate_availability` before anything is written,
    and the merge requires `paper`, `photo` and `geometryProof` to be present
    before it and verifies from the re-read file that they survived it -- the
    `geometryProof`-dropping defect that bit `bake.py` is refused here explicitly,
    and a truncated or lossy write is refused after the fact rather than reported
    as a success. `dry_run` computes, validates and reports the record but writes
    nothing.
    """
    out = Path(out_dir)
    mp = out / 'manifest.json'
    idx = _disk_tile_index(out, layer)
    levels = sorted(idx)
    if not levels:
        raise PublishRefusal(
            f'no {layer} tiles exist under {out}: there is no availability to '
            f'publish, and writing an empty layers.{layer} would advertise a '
            f'layer that serves nothing')

    availability = availability_from_disk(out, layer, levels)
    top = max(levels)
    problems = manifest.validate_availability(availability, top)
    if problems:
        raise PublishRefusal('availability from disk is not publishable: '
                             + '; '.join(problems))

    tiles = sum(len(v) for v in idx.values())
    bytes_total = 0
    for L, coords in idx.items():
        for x, y in coords:
            bytes_total += (out / layer / str(L) / str(x) / f'{y}.jpg').stat().st_size
    source, region_ids = _region_provenance(out, layer, regions_file)

    record = {
        'top': top,
        'availability': availability,
        'source': source,
        'regions': region_ids,
        'tiles': tiles,
        'bytes': bytes_total,
        'publishedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    }

    if dry_run:
        return record

    if not mp.exists():
        raise PublishRefusal(f'{mp} is missing: publish merges into the delivered '
                             f'manifest, it does not create one')
    prev = json.loads(mp.read_text(encoding='utf-8'))
    prev_layers = prev.get('layers', {})
    layers = dict(prev_layers)
    layers[layer] = record
    merged = dict(prev)
    merged['layers'] = layers

    # Refuse to write a manifest the app cannot boot: it needs both base layers and
    # the geometry proof. `geometryProof` is named here, and the check that can
    # actually fire is the post-write re-read below -- comparing `merged` against
    # the dict it was just copied out of (`merged = dict(prev)`) is true by
    # construction, protects nothing, and was the gap this guard was meant to close.
    for name in ('paper', 'photo'):
        if name not in layers:
            raise PublishRefusal(f'the merged manifest would have no {name!r} '
                                 f'layer, which the app refuses to boot without')
    if 'geometryProof' not in prev:
        raise PublishRefusal(
            "the delivered manifest has no 'geometryProof' key: publishing would "
            'ship a manifest without it, which is the exact defect this step is '
            'required to refuse')

    manifest.write_manifest(mp, merged)

    # Post-write verification: read the file back and compare everything that was
    # not ours to change against the copy taken before the merge. Falsifiable, and
    # it also catches a truncated write -- `manifest.write_manifest` overwrites the
    # file with `write_bytes` (`manifest.py:87`), so a half-finished manifest is a
    # state a publish can be left holding.
    try:
        written = json.loads(mp.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError) as exc:
        raise PublishRefusal(
            f'the manifest written to {mp} cannot be read back ({exc}): the write '
            f'did not complete, and layers.{layer} will not be advertised from it')
    if written.get('geometryProof') != prev['geometryProof']:
        raise PublishRefusal(
            "re-reading the written manifest shows 'geometryProof' is missing or "
            f'changed: {mp} no longer holds the proof the merge read')
    for key, value in prev.items():
        if key == 'layers':
            continue
        if written.get(key) != value:
            raise PublishRefusal(f'the written manifest altered top-level key {key!r}')
    written_layers = written.get('layers', {})
    for name, rec in prev_layers.items():
        # `layer` itself is the record just written, so it is exempt here and
        # checked against `record` below instead.
        if name == layer:
            continue
        if written_layers.get(name) != rec:
            raise PublishRefusal(
                f'the written manifest altered the {name!r} layer record')
    if written_layers.get(layer) != record:
        raise PublishRefusal(
            f'the written manifest does not hold the layers.{layer} record it was '
            f'handed')
    return record


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parser() -> argparse.ArgumentParser:
    # RawTextHelpFormatter keeps these help lines exactly as written below; the
    # default formatter re-wraps and would break "22-tile" across a line boundary.
    ap = argparse.ArgumentParser(
        prog='stream_bake.py',
        description=('Bake region boxes out of a remote cloud-optimised GeoTIFF by '
                     'range-reading it, never downloading it.\n'
                     'Sources and URLs come from regions.SOURCES; the grid comes '
                     'from grid.py; the encoder comes from bake.py.'),
        formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument('--regions', default=DEFAULT_REGIONS_FILE,
                    help='regions.json to read boxes and levels from')
    ap.add_argument('--out', default=DEFAULT_OUT,
                    help='tile tree to write (tests must pass a tmp dir)')
    ap.add_argument('--layer', default=DEFAULT_LAYER,
                    help='layer directory, ortho for the Kaguya TC shaded mosaic')
    ap.add_argument('--only', metavar='REGION-ID',
                    help='bake one region id only.\n'
                         'This exists so the first real run can be the 22-tile\n'
                         'apollo-11 site box rather than the 23,040-tile south\n'
                         'polar cap: --only apollo-11')
    ap.add_argument('--quality', type=int, default=DEFAULT_QUALITY,
                    help='JPEG quality handed to bake.save_tile')
    ap.add_argument('--chunk-rows', dest='chunk_source_rows', type=int,
                    default=DEFAULT_CHUNK_SOURCE_ROWS, metavar='N',
                    help='source rows per bulk read (requirement 2); smaller '
                         'costs more requests, larger costs more memory')
    ap.add_argument('--dry-run', action='store_true',
                    help='print the plan and its cost, open nothing, write nothing')
    ap.add_argument('--force', action='store_true',
                    help='re-encode tiles that already exist (default: resume)')
    ap.add_argument('--publish', action='store_true',
                    help='merge layers.ortho into manifest.json from the tiles\n'
                         'on disk, then stop. Writes the manifest and nothing\n'
                         'else; implies no bake and needs no other flag. Pair\n'
                         'with --dry-run to see the record that would be written.')
    return ap


def print_plan(entries, total, per_level, args) -> None:
    print(f'layer={args.layer} out={args.out} quality={args.quality} '
          f'force={args.force} chunk={args.chunk_source_rows} source rows')
    for e in entries:
        levels = ' '.join(f'L{L}: {e["tilesPerLevel"][L]}'
                          for L in sorted(e['tilesPerLevel']))
        print(f'  {e["id"]}: {e["tiles"]} tiles  {levels}')
    print(f'  total {total} tiles')
    print('  per level ' + ' '.join(f'L{L}: {n}'
                                    for L, n in sorted(per_level.items())))


def _publish_main(args) -> int:
    """The `--publish` branch of main: report the record and (unless dry) write it.

    Kept out of the bake path entirely, because `--publish` must not imply a bake
    and must work with no other flags: it reads only what is on disk already.
    """
    try:
        record = publish(args.out, args.layer, regions_file=args.regions,
                         dry_run=args.dry_run)
    except PublishRefusal as exc:
        print(f'REFUSED to publish layers.{args.layer}: {exc}', file=sys.stderr)
        return 2

    verb = 'would publish' if args.dry_run else 'published'
    regions_txt = ', '.join(record['regions']) or '(none matched on disk)'
    print(f'{verb} layers.{args.layer}: top={record["top"]} '
          f'tiles={record["tiles"]:,} bytes={record["bytes"]:,} '
          f'source={record["source"]!r}')
    print(f'  regions: {regions_txt}')
    print('  availability (derived from the tiles on disk, never the plan):')
    for level, ranges in sorted(record['availability'].items(), key=lambda kv: int(kv[0])):
        print(f'    L{level}: {ranges}')
    if args.dry_run:
        print('dry run: manifest.json not written')
        return 0
    print(f'wrote layers.{args.layer} to {Path(args.out) / "manifest.json"}; '
          f'every other key and layer carried forward unchanged.')
    return 0


def main(argv=None) -> int:
    args = parser().parse_args(argv)

    # --publish is a last-mile step over the finished tree: it neither plans nor
    # bakes, and works with no other flag, so it short-circuits before the plan.
    if args.publish:
        return _publish_main(args)

    data = json.loads(Path(args.regions).read_text(encoding='utf-8'))
    regs = data.get('regions', [])
    sources = data.get('sources') or regions.SOURCES
    entries = plan(regs, sources=sources, only=args.only)

    if args.only and not entries:
        known = ', '.join(r['id'] for r in regs) or '(none)'
        print(f'--only {args.only!r} is not a region id in {args.regions}; '
              f'known ids: {known}', file=sys.stderr)
        return 2

    problems = check_plan(entries)
    if problems:
        print('REFUSING: the plan does not match the sources.', file=sys.stderr)
        for p in problems:
            print(f'  {p}', file=sys.stderr)
        return 2

    total = sum(e['tiles'] for e in entries)
    per_level: dict[int, int] = {}
    for e in entries:
        for L, n in e['tilesPerLevel'].items():
            per_level[L] = per_level.get(L, 0) + n
    print_plan(entries, total, per_level, args)

    if args.dry_run:
        print('dry run: nothing written')
        return 0

    try:
        written, failed = bake_all(entries, args.out, opener=default_opener,
                                   layer=args.layer, quality=args.quality,
                                   force=args.force,
                                   chunk_source_rows=args.chunk_source_rows)
    except Refusal as exc:
        print(f'REFUSED after reading the source: {exc}', file=sys.stderr)
        return 2

    print(f'wrote {written} tiles ({total} planned) in {len(entries)} regions')
    print('availability from disk (the plan is not the evidence):')
    levels = sorted({L for e in entries for L in e['levels']})
    for level, ranges in availability_from_disk(args.out, args.layer,
                                               levels).items():
        print(f'  L{level}: {ranges}')
    print('no manifest.json written by this bake: the manifest belongs to bake.py '
          'until the L7 bake that owns public/tiles/ finishes; merge this layer in '
          'with an explicit `--publish` run over the finished tree.')

    if failed:
        for f in failed:
            print(f'REGION FAILED {f["id"]}: {f["error"]}', file=sys.stderr)
        print(f'{len(failed)} of {len(entries)} regions failed: '
              + ', '.join(f['id'] for f in failed), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
