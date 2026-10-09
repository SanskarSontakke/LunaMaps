"""Band-based tile bake (spec §3.1, as amended by plan amendment A).

Task 17 made three things true of this module, all of them guards rather than
features, because the thing being guarded against is a multi-hour run that
should never have started:

  * Stage 0 is not opt-in any more. `main()` runs `contract.assert_contract`
    over both sources *before* the output directory is touched, so neither a
    wrong grid nor a missing file can spend three hours or delete a finished
    layer (`--force` rmtree's the layer it is about to bake). A missing source
    is a hard error, not a skip that reports green.
  * the disk guard measures the volume `--out` resolves to, not the current
    working directory, and refuses with the numbers a human needs to decide
    (needed bytes, the measured Tier A total, the cheaper subset command, and
    the wall clock at the *measured* per-band cost).
  * `baked` (new top-level tiles) and `derived` (parents re-encoded from
    children) are counted separately. A resume bakes 0 tiles and re-encodes
    every parent; conflating those two printed a resume as if it had done work.

The 2026-10-09 whole-branch review added two more, both for the same reason: a
run must never publish a record that is false of the pixels it delivered.

  * a resume is checked against the ENCODER PARAMETERS the delivered record says
    produced the tree (`check_encoder_params`). `save_tile` skips a tile when the
    file EXISTS, not when it exists with the parameters this run asks for, and
    `derive.derive_levels` re-encodes every parent, so `--top 7 --layer photo
    --quality 30` over the q85 tree would keep 32,768 children at q85, re-encode
    10,922 parents at q30, and publish `quality = 30`. That run now refuses,
    naming the recorded value, the requested value, and `--force` as the escape.
  * `generatedAt` dates the PIXELS, not the rewrite: a run that wrote no tile
    carries the delivered stamp rather than re-dating 87,380 files it never
    touched, which is the rule `--reindex` already follows because `Attribution`
    shows that field to the user as the bake date.

Everything time- and byte-related here is anchored to measurements recorded in
docs/superpowers/specs/bake-log.md, not to the spec's original estimates.
"""
from __future__ import annotations
import argparse
import json
import math
import shutil
import sys
import time
from datetime import datetime, timezone
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
# The two product layers the app requires a record for (`assets.ts` validates
# both, and `LayerName` in src/types.ts is exactly this pair). `probe` is the
# Task 2 gate fixture, not a product layer, and is never baked through here.
PRODUCT_LAYERS = ('paper', 'photo')

# Written by `fetch_data.py`, gitignored, and only complete once the whole download
# loop has finished -- so "tiles on disk, no digest file" is a state this branch has
# actually been in (three background jobs were killed mid-run). See `source_records`.
SHA_PATH = Path('data/raw/sha256.json')
CAPS_PATH = Path('data/raw/capabilities.json')
# MEASURED, not guessed: Tier A both layers at q85, from the committed
# public/tiles/manifest.json written by the 2 h 58 min bake recorded in
# docs/superpowers/specs/bake-log.md §4. bits = bytes * 8 / (512 * 512) over the
# whole layer (paper 472,094,745 B / 10,922 tiles = 43,224 B/tile; photo
# 455,311,811 B / 10,922 = 41,688 B/tile). The previous placeholders (0.55 /
# 1.35) predicted 0.68 GB against a measured 0.93 GB, i.e. they under-called
# Tier A by 36% because paper was 2.4x too low; Task 17's disk guard scales off
# these numbers, so they are the real ones now. Averaging over all levels makes
# a marginal level like L7 slightly over-estimated (L6 alone is 1.22 bits/px),
# which is the safe direction for a disk guard.
BITS_PER_PIXEL = {'paper': 1.3191, 'photo': 1.2722}

# ---------------------------------------------------------------------------
# Measured anchors (bake-log.md §4). The guard and the time projection below
# read these, so a future re-measurement has exactly one place to change.
# ---------------------------------------------------------------------------
TIER_A_TOP = 6
# Both layers, L0..L6, as recorded by the bake itself and confirmed byte-for-
# byte by `du -sb` (bake-log.md §4.3).
TIER_A_BYTES_MEASURED = 927_406_556
TIER_A_SECONDS_MEASURED = 10_680.5          # timings.bakeSeconds (§4.1)
TIER_A_BANDS = 64                           # 32 bands/layer x 2 layers (§4.1)
# Observed per-band cost at L6, one layer: paper 150-195 s, photo 150-200 s
# (§4.1). Band-dominated because the JP2's block geometry is (54582, 20000) --
# full image height -- so every band read decodes the whole 5.96 GPix
# codestream regardless of how short the band is (§2).
BAND_SECONDS_MEASURED = (150.0, 200.0)
# Parents re-encoded from decoded children, measured off §4.0's polling
# timeline: paper reached its last band at 09:50 and its full 10,922 tiles at
# ~10:00, i.e. ~600 s for 2,730 parents.
PARENT_SECONDS_MEASURED = 0.22
# The guard asks for this multiple of the planned bytes. Kept at 1.5 because
# plan Task 17 pins `needed == int(1.5 * est['bytes'])`.
DISK_HEADROOM = 1.5


class SourceError(RuntimeError):
    """A bake input is absent or is not the grid the spec claims.

    Both conditions stop the run. Before Task 17 a missing source printed
    'absent', `continue`d, and let a --dry-run report green on an empty stage 0.
    """


class EncoderMismatchError(RuntimeError):
    """This run's encoder flags are not the ones that produced the tiles a resume
    would keep, so publishing them would mislabel the delivered tree.

    The hole the 2026-10-09 whole-branch review measured: `save_tile` skips a
    tile when the FILE exists, not when the file exists *with the parameters this
    run is asking for*, and `derive.derive_levels` re-encodes every parent
    unconditionally. So `bake.py --top 7 --layer photo --quality 30` over the
    delivered q85 tree keeps all 32,768 L7 children at q85, re-encodes the
    10,922 derived parents at q30, and writes `layers.photo.quality = 30`: one
    number describing a tree holding two. `quality` is not a label -- the same
    pixels measure 165,079 B at q85 and 83,555 B at q30 -- so no re-labeling can
    make the artifact true. The only honest answer is to refuse and name --force.
    """


def requested_encoder_params(layer: str, quality: int, k) -> dict:
    """What this run's flags say the pixels are, for the layer it is writing.

    `paper` is the raw detail band, so it has no detail gain whatever `--k` says;
    claiming one would refuse a paper resume for a parameter that cannot change
    its pixels (see `test_a_paper_resume_is_not_refused_for_the_photos_detail_gain`).
    """
    return {'quality': quality,
            'detailGain': None if layer == 'paper' else k}


def _encoder_values_differ(have, want) -> bool:
    """Float-tolerant on purpose: `0.4` round-trips through JSON and CLI args, and
    a binary `!=` would refuse a run whose flags are the recorded ones."""
    if have is None or want is None:
        return have is not want
    try:
        return abs(float(have) - float(want)) > 1e-9
    except (TypeError, ValueError):
        return have != want


def _fmt_param(v) -> str:
    return 'not set' if v is None else repr(v)


def encoder_mismatches(prev_layers: dict, layers, quality: int, k) -> list[str]:
    """One line per recorded parameter this run contradicts, naming both values.

    Only the layers THIS run writes are considered: an unbaked layer's tiles are
    neither skipped-and-mislabelled nor re-encoded here, and its own record is
    carried with its own values, so it is not evidence about this run's flags.

    Only a value the record ACTUALLY STATES can be contradicted: `quality: null`
    is a state a `--reindex` of a tree that never recorded one can leave behind,
    and refusing on it would block a resume because the artifact admits it does
    not know. A run that asks for no detail gain over a tree recorded WITH one is
    the opposite case -- the record states 0.4, this run states none -- and is a
    real mismatch, so `want is None` still counts.
    """
    lines = []
    for layer in layers:
        rec = prev_layers.get(layer) or {}
        if not rec:
            continue
        for key, want in requested_encoder_params(layer, quality, k).items():
            have = rec.get(key)
            if key not in rec or have is None:
                continue
            if _encoder_values_differ(have, want):
                lines.append(
                    f'layers.{layer}.{key}: the delivered record says '
                    f'{_fmt_param(have)}, this run asks for {_fmt_param(want)}, '
                    f'and {rec.get("tiles", "the existing")} {layer} tiles on '
                    f'disk keep {_fmt_param(have)}')
    return lines


def check_encoder_params(prev_layers: dict, layers, quality: int, k,
                         force: bool) -> None:
    """Refuse a resume whose encoder flags differ from the recorded ones.

    Runs BEFORE the first write and before the first `--force` delete would be
    needed, so a refusal leaves the delivered tree byte-for-byte as it found it.
    """
    if force:
        return
    lines = encoder_mismatches(prev_layers, layers, quality, k)
    if not lines:
        return
    raise EncoderMismatchError('\n'.join([
        "REFUSING TO RESUME: this run's encoder flags are not the ones that "
        'produced the tiles that are already on disk.',
        *[f'  {line}' for line in lines],
        '  A resume SKIPS the files it finds (`save_tile` tests existence, not '
        'parameters) while every derived parent is re-encoded, so the manifest '
        'this run publishes would state one value for a tree holding two -- and '
        'quality changes the bytes, not just the label.',
        '  Either re-run with the recorded flags, or pass --force, which deletes '
        'the layer it is about to bake and re-bakes all of it at the flags given '
        'here so the record it writes is true of every tile in the tree.',
    ]))


def validate_band_rows(band_rows: int) -> None:
    """`--band-rows 0` used to die inside `range()`; a negative value used to
    bake nothing at all and still return success. Both are argument errors."""
    if band_rows <= 0:
        raise ValueError(f'--band-rows must be a positive multiple of {TILE} '
                         f'pixels (tile rows), got {band_rows}')
    if band_rows % TILE:
        raise ValueError(f'--band-rows must be a multiple of {TILE}, got '
                         f'{band_rows}')


def check_sources(detail: str, color: str, quiet: bool = False) -> list[dict]:
    """Stage 0 for a real bake *and* for --dry-run: the same asserts, no skips.

    Every problem is collected so one command reports both sources, then the
    whole thing raises. Callers must run this before the output directory is
    created or, under `--force`, deleted.
    """
    records, problems = [], []
    for role, path, exp in ((
            'detail', detail, contract.EXPECTED_DETAIL),
            ('colour', color, contract.EXPECTED_COLOR)):
        p = Path(path)
        if not p.exists():
            problems.append(
                f'{role} source {p} is ABSENT — run `npm run fetch` first; '
                f'nothing can be baked against a file that is not there')
            continue
        try:
            c = contract.read_grid_contract(str(p))
            contract.assert_contract(c, exp)
        except (AssertionError, RuntimeError, OSError) as exc:
            problems.append(f'{role} source {p} FAILS the stage 0 grid '
                            f'contract: {exc}')
            continue
        records.append(c)
        if not quiet:
            # The pixel size a source does not state cannot be verified, so it
            # must not be printed as if it were: `read_grid_contract` sets
            # `pxPerDeg = width/360` (contract.py:88), which for an ungridded file
            # -- exactly the delivered colour TIFF's case -- is a value this
            # pipeline ASSIGNED from the pixel count. The stage 0 log is the only
            # place a human reads whether the grid was measured or assumed.
            if c['gridReadFrom'] == 'assigned':
                print(f'  {p.name}: OK {c["width"]}x{c["height"]}, '
                      f'{c["pxPerDeg"]:.4f} px/deg ASSIGNED from width/360 -- '
                      f'this file carries no georeference, so its resolution was '
                      f'not read and is not verified here (only its pixel count '
                      f'and its 2:1 aspect are)')
            else:
                print(f'  {p.name}: OK {c["width"]}x{c["height"]}, grid '
                      f'{c["pxPerDeg"]:.4f} px/deg (canonical width/360); the '
                      f'file states {c["pxPerDegDeclared"]:.4f} px/deg and was '
                      f'checked against it')
    if problems:
        for line in problems:
            print(f'  {line}', file=sys.stderr)
        raise SourceError(' | '.join(problems))
    return records


def tiles_at_level(L: int) -> int:
    return grid.level_cols(L) * grid.level_rows(L)


def tiles_through_top(top: int) -> int:
    """Tiles in ONE layer summed over every level 0..top.

    This is what the old `estimate()['tilesPerLayer'] key meant; the name said
    "per layer at one level" and the number was the whole pyramid, which is how
    a 4x error hides in plain sight (bake-log.md §4.4).
    """
    return sum(tiles_at_level(L) for L in range(top + 1))


def estimate(top: int, layers) -> dict:
    per_layer = tiles_through_top(top)
    files = per_layer * len(layers)
    bytes_ = int(sum(per_layer * TILE * TILE * BITS_PER_PIXEL[l] / 8.0
                     for l in layers))
    return {'top': top, 'layers': list(layers),
            'tilesAtTop': tiles_at_level(top),
            'tilesThroughTopPerLayer': per_layer,
            'tiles': files, 'files': files, 'bytes': bytes_}


def bands_per_layer(top: int, band_rows: int) -> int:
    return math.ceil(grid.world_px_height(top) / band_rows)


def project_seconds(top: int, layers, band_rows: int) -> tuple[float, float]:
    """Wall-clock range from the MEASURED per-band cost, not from the plan's
    'a couple of minutes'. Sanity anchor: at L6/both/1024 this brackets the
    measured Tier A figure (10,680.5 s) from above."""
    bands = bands_per_layer(top, band_rows) * len(layers)
    parents = (tiles_through_top(top) - tiles_at_level(top)) * len(layers)
    lo = bands * BAND_SECONDS_MEASURED[0] + parents * PARENT_SECONDS_MEASURED
    hi = bands * BAND_SECONDS_MEASURED[1] + parents * PARENT_SECONDS_MEASURED
    return lo, hi


def free_bytes_at(path) -> int:
    """Free bytes on the VOLUME `path` resolves to, without creating `path`.

    The guard used to call `shutil.disk_usage('.')`, which measured whatever
    directory happened to be current -- in this repo always C:, even for
    `--out D:/tiles`. A non-existent --out is legal (the bake creates it), so
    walk up to the nearest ancestor that exists and ask that volume.
    """
    p = Path(path)
    while not p.exists():
        parent = p.parent
        if parent == p:
            raise SystemExit(f'cannot find an existing parent for --out {path}')
        p = parent
    return shutil.disk_usage(str(p)).free


def check_disk_or_abort(est: dict, free: int,
                        headroom: float = DISK_HEADROOM) -> tuple[bool, int]:
    """(ok, needed): does `free` cover `headroom` x the planned bytes?

    Returns rather than raises so the caller can print a decision-quality
    message instead of a bare exception, and so the rule is testable without a
    filesystem.
    """
    needed = int(headroom * est['bytes'])
    return free >= needed, needed


def disk_refusal(est: dict, needed: int, free: int, out_dir: str,
                 band_rows: int) -> str:
    """The refusal, with the three figures a human needs to choose otherwise.

    Tier B is opt-in, so "no" is a legitimate answer; the point of printing the
    measured Tier A total, the cheaper subset command and the hours is that the
    answer can be given from this message without re-deriving anything.
    """
    top = est['top']
    bands = bands_per_layer(top, band_rows) * len(est['layers'])
    lo, hi = project_seconds(top, est['layers'], band_rows)
    subset = estimate(top, ('photo',))
    s_needed = int(DISK_HEADROOM * subset['bytes'])
    s_lo, s_hi = project_seconds(top, ('photo',), band_rows)
    ratio = est['bytes'] / TIER_A_BYTES_MEASURED
    return '\n'.join([
        f'REFUSING TO BAKE: L{top} into {out_dir} needs more free space than '
        f'that volume has.',
        f'  needed  {needed:,} B ({needed / 1e9:.2f} GB) = '
        f'{DISK_HEADROOM:g}x the planned {est["bytes"]:,} B; '
        f'{free:,} B ({free / 1e9:.2f} GB) available',
        f'  planned {est["files"]:,} tiles in {bands} bands '
        f'({bands_per_layer(top, band_rows)}/layer x '
        f'{len(est["layers"])} layers) = {lo / 3600:.1f}-{hi / 3600:.1f} h at '
        f'the measured {BAND_SECONDS_MEASURED[0]:.0f}-'
        f'{BAND_SECONDS_MEASURED[1]:.0f} s/band (bake-log.md §4.1)',
        f'  measured Tier A for comparison (L0..L{TIER_A_TOP}, both layers) = '
        f'{TIER_A_BYTES_MEASURED:,} B in {TIER_A_SECONDS_MEASURED:,.1f} s '
        f'(2 h 58 m 03 s); this plan is {ratio:.2f}x those bytes',
        f'  cheaper subset that fits the same rule: '
        f'npm run bake -- --top {top} --layer photo --band-rows {band_rows} '
        f'-> {subset["bytes"]:,} B, needs {s_needed:,} B '
        f'({s_needed / 1e9:.2f} GB), {s_lo / 3600:.1f}-{s_hi / 3600:.1f} h',
        f'    (that command leaves the tiles of the layer it does not bake alone '
        f'and carries that layer\'s record forward, so the manifest the app '
        f'validates stays complete -- see run())',
        f'  or keep this plan and point --out at a volume with at least '
        f'{needed / 1e9:.2f} GB free.',
        f'  Tier B is opt-in: declining it is a valid answer. L7 (83.29 m/px) is '
        f'what the delivered manifest ships, verified by Gate G2 against it.',
    ])


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
    """Write one tile, unless it already exists and `--force` was not given.

    Existence is the whole of the resume test -- the `quality` this call would
    encode at is NOT compared against the quality the existing file was encoded
    at, and JPEG does not carry a quality field back. That is why
    `check_encoder_params` refuses a changed-flag resume up front instead of
    letting this line quietly keep the old file.
    """
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
    validate_band_rows(band_rows)
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


def carried_layers(out: Path, baked) -> tuple:
    """The product layers that are on disk but were NOT baked by this run.

    A one-layer run still delivers a two-layer pyramid, and `assets.ts` refuses a
    manifest that does not record both layers, so these records are measured from
    the tree and carried forward (see `run`). Order is `PRODUCT_LAYERS`'s, so the
    manifest's key order stays stable whichever layer was baked.
    """
    return tuple(l for l in PRODUCT_LAYERS
                 if l not in baked and (out / l).is_dir())


# The manifest keys a bake run produces itself. Anything else in a delivered
# manifest belongs to another stage and is carried, not rebuilt.
MANIFEST_OWNED = frozenset(('schema', 'generatedAt', 'grid', 'levels', 'sources',
                            'layers', 'timings', 'capabilities', 'reindex'))


def carry_foreign(prev: dict, m: dict, baked) -> list:
    """Carry the parts of a delivered manifest this run did not produce.

    Both write paths rebuild from `manifest.base_manifest()`, which starts at
    `layers: {}`. `carried_layers` is limited to `PRODUCT_LAYERS`, and the top-level
    carry was a whitelist of two names, so anything another stage added disappeared:
    the next `--reindex` or one-layer bake deleted the availability-gated `ortho`
    record that `stream_bake.py --publish` wrote, taking the deep-zoom layer down with
    it while every test stayed green. `geometryProof` survived that defect class only
    because someone added it to the whitelist by hand after it went missing once.

    The rule is therefore structural -- carry what you do not own -- so a record added
    by a stage nobody has written yet cannot be silently dropped either. Returns the
    names carried, which `--reindex` prints: a manifest edit that cannot say what it
    left alone is not auditable.
    """
    carried = []
    for name, rec in (prev.get('layers') or {}).items():
        if name not in baked and name not in m['layers']:
            m['layers'][name] = rec
            carried.append(f'layers.{name}')
    for key, value in prev.items():
        if key not in MANIFEST_OWNED and key not in m:
            m[key] = value
            carried.append(key)
    return carried


def source_records(path, prev: dict, key: str):
    """The record `fetch_data.py` wrote if it is there, else the one already in the
    delivered manifest -- never an empty stand-in.

    `carry_foreign` is told `sources` and `capabilities` are keys this run owns, and
    that is only true when the fetch that produces them completed. Writing
    `sources: []` bricks the app rather than degrading it: `assets.ts:115` refuses a
    manifest with no sources, so the recovery bake a user runs after an interrupted
    fetch -- the exact state the three killed background jobs on this branch left
    behind -- produced "manifest.json is not compatible with this build" for a pyramid
    that was fine, and `--reindex` could not undo it because the empty list was already
    the value this run "owned".
    """
    p = Path(path)
    if p.exists():
        return json.loads(p.read_text(encoding='utf-8'))
    return prev.get(key)


def layer_record(out: Path, layer: str, quality, detail_gain,
                 top: int | None = None,
                 counts: tuple[int, int] | None = None) -> dict:
    """What the delivered layer measures, counted from disk.

    `counts` is (baked, derived) for the run that just happened. A re-index has
    no such knowledge and passes None, which omits the keys rather than
    inventing zeroes -- 0 baked would read as "this layer is empty".
    """
    files = sorted((out / layer).rglob('*.jpg'))
    levels = [int(p.parent.parent.name) for p in files]
    rec = {'top': top if top is not None else (max(levels) if levels else None),
           'tiles': len(files),
           'bytes': sum(f.stat().st_size for f in files),
           'quality': quality,
           'photometric': 'MINISBLACK' if layer == 'paper' else 'YCbCr',
           'detailGain': detail_gain}
    if counts is not None:
        rec['baked'], rec['derived'] = counts
    return rec


def run(detail: str, color: str, layers=PRODUCT_LAYERS, top: int = 6,
        quality: int = 85, band_rows: int = 1024, k=0.4,
        out_dir: str = OUT_DEFAULT, force: bool = False, sigma: float = 2.5,
        radius: int = 8, quiet: bool = False) -> int:
    """Bake and derive the pyramid, then write the manifest. Returns the number
    of tiles this call wrote (baked + re-derived), nothing more.

    Two rules decide what the call may say when it finishes:

      * it refuses (`EncoderMismatchError`, nothing written) when its `quality` or
        detail gain contradicts the `layers.<name>` record of the tree it is
        resuming, because a resume keeps the files it finds;
      * `generatedAt` is carried when this call wrote 0 tiles and restamped when
        it wrote any, because the stamp dates the pixels and `Attribution` shows
        it to the user as the bake date.

    The Stage 0 grid-contract gate lives in `main()`, in front of this call,
    which is what a real bake runs; `run()` itself stays usable against the
    1024x512 synthetic rasters in scripts/tests, which could never satisfy the
    109164x54582 grid the real spec claims.
    """
    out = Path(out_dir)
    layers = tuple(layers)
    # Read the record that is already there BEFORE writing the new one: a
    # single-layer run carries the other layer's record out of it (MUST FIX 5),
    # and `layer_record` cannot recover `quality`/`detailGain` off a JPEG.
    mp = out / 'manifest.json'
    prev_manifest = json.loads(mp.read_text(encoding='utf-8')) if mp.exists() else {}
    prev_layers = prev_manifest.get('layers', {})
    # MUST FIX 1 (2026-10-09 review): refuse a resume whose encoder flags are not
    # the ones that produced the files it is about to skip, BEFORE the first byte
    # is written and before the first parent is re-encoded. `quality` and
    # `detailGain` are the two flags that change pixels, and both are recorded in
    # `layers.<name>`, so the delivered artifact itself says whether this run can
    # describe it.
    check_encoder_params(prev_layers, layers, quality, k, force)
    t0 = time.time()
    baked = derived = 0
    counts: dict[str, tuple[int, int]] = {}
    for layer in layers:
        if force and (out / layer).exists():
            doomed = len(list((out / layer).rglob('*.jpg')))
            if not quiet:
                print(f'{layer}: --force deletes {doomed} existing tiles in '
                      f'{out / layer} before re-baking (re-run without '
                      f'--force to resume instead)')
            shutil.rmtree(out / layer)
        n_baked = bake_top(detail, color, layer, top, band_rows, k, out_dir,
                           quality, force, sigma, radius)
        n_derived = derive.derive_levels(out_dir, layer, top, quality, save_tile)
        counts[layer] = (n_baked, n_derived)
        baked += n_baked
        derived += n_derived
        if not quiet:
            print(f'{layer}: {n_baked} tiles baked at level {top}')
            if top:
                print(f'{layer}: {n_derived} parent tiles derived '
                      f'L{top-1}..L0')
    m = manifest_mod.base_manifest(manifest_mod.baked_levels(
        out, layers + carried_layers(out, layers)),
        # MUST FIX 2 (2026-10-09 review) -- THE RULE, stated once:
        # `generatedAt` dates the PIXELS, not the moment the record was rewritten.
        # A run that wrote nothing changed no pixel, so it carries the delivered
        # stamp; a run that wrote any tile -- children, parents, or a --force
        # re-bake -- changed the artifact, so it restamps. `Attribution` renders
        # this field to the user as "the bake date", and `reindex()` already
        # carries it for exactly that reason; before this, a resume that baked 0
        # tiles re-dated 87,380 files it never touched.
        generated_at=(prev_manifest.get('generatedAt')
                      if (prev_manifest and not (baked or derived)) else None))
    for layer in layers:
        m['layers'][layer] = layer_record(
            out, layer, quality, None if layer == 'paper' else k, top,
            counts.get(layer))
    # MUST FIX 5: a run that bakes ONE layer must not delete the OTHER layer's
    # record. `base_manifest()` starts with `layers: {}`, so the old code wrote a
    # manifest holding only `photo`, `assets.ts` then refused the whole file (its
    # `isRecord(paper)` check), and the user landed on "manifest.json is not
    # compatible with this build" -- for following the advice the disk refusal
    # itself prints (`npm run bake -- --top 7 --layer photo`). The unbaked layer's
    # record is therefore carried forward exactly the way `--reindex` carries it:
    # measured from the tiles that are actually on disk, with the two values a
    # JPEG cannot give back (`quality`, `detailGain`) taken from the record that
    # is already there, and the carried record says which bake it came from.
    for layer in carried_layers(out, layers):
        prev_rec = prev_layers.get(layer, {})
        rec = layer_record(
            out, layer, prev_rec.get('quality'),
            prev_rec.get('detailGain', None if layer == 'paper' else 0.4))
        if prev_manifest.get('generatedAt'):
            rec['carriedFrom'] = prev_manifest['generatedAt']
        m['layers'][layer] = rec
    # Layers and keys this run has no business rebuilding (see `carry_foreign`).
    carry_foreign(prev_manifest, m, layers)
    m['sources'] = source_records(SHA_PATH, prev_manifest, 'sources') or []
    caps = source_records(CAPS_PATH, prev_manifest, 'capabilities')
    if caps:
        m['capabilities'] = caps
    # Timings accumulate: `bakeSeconds` is this run, and whatever an earlier stage
    # measured (a deep-stream time, a proof duration) belongs to the artifact, not to
    # the run that last happened to rewrite the file.
    m['timings'] = {**(prev_manifest.get('timings') or {}),
                    'bakeSeconds': round(time.time() - t0, 1)}
    manifest_mod.write_manifest(out / 'manifest.json', m)
    if not quiet:
        print(f'baked {baked} new tiles + {derived} derived parents = '
              f'{baked + derived} writes in {m["timings"]["bakeSeconds"]}s '
              f'-> {out}')
    return baked + derived


def reindex(out_dir: str = OUT_DEFAULT, layers=PRODUCT_LAYERS,
             quiet: bool = False) -> int:
    """Rewrite manifest.json from the tiles on disk. Writes no tiles, reads no
    sources, deletes nothing -- the way to correct a manifest without a bake.

    A re-index measures the delivered tree, so it can only report what is
    measurable: per-level counts and byte sums. What it cannot know (bake wall
    clock, JPEG quality, the gate verdicts, the source digests) is carried
    forward from the manifest already there, and the carry is recorded so the
    provenance is legible rather than implied.
    """
    out = Path(out_dir)
    mp = out / 'manifest.json'
    prev = json.loads(mp.read_text(encoding='utf-8')) if mp.exists() else {}
    levels = manifest_mod.baked_levels(out, layers)
    m = manifest_mod.base_manifest(levels, generated_at=prev.get('generatedAt'))
    prev_layers = prev.get('layers', {})
    for layer in layers:
        if not (out / layer).is_dir():
            continue
        carried = prev_layers.get(layer, {})
        # `top` is measured from the tree, not carried: it is a property of the
        # tiles that exist. `quality` and `detailGain` are inputs to a bake and
        # cannot be read back off a JPEG, so those are carried forward.
        rec = layer_record(
            out, layer, carried.get('quality'),
            carried.get('detailGain', None if layer == 'paper' else 0.4))
        m['layers'][layer] = rec
    m['sources'] = source_records(SHA_PATH, prev, 'sources') or []
    caps = source_records(CAPS_PATH, prev, 'capabilities')
    if caps:
        m['capabilities'] = caps
    m['timings'] = prev.get('timings', {})
    carried = carry_foreign(prev, m, layers)
    m['reindex'] = {
        'at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'command': f'npm run bake -- --reindex --out {out_dir}',
        'bakedAt': m['generatedAt'],
        'rebuilt': ['levels (only those with tiles on disk)', 'layers.top',
                    'layers.tiles', 'layers.bytes', 'sources', 'capabilities'],
        'carriedForward': ['generatedAt', 'timings', 'layers.quality',
                           'layers.detailGain', *carried],
        'note': ('written by --reindex, which counts the delivered tree and '
                 'bakes nothing; `baked`/`derived` are per-run write counts and '
                 'so only a real bake records them'),
    }
    manifest_mod.write_manifest(mp, m)
    if not quiet:
        for layer, rec in m['layers'].items():
            print(f'reindexed {layer}: {rec["tiles"]:,} tiles / '
                  f'{rec["bytes"]:,} B across levels {levels}')
    return sum(r['tiles'] for r in m['layers'].values())


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
    ap.add_argument('--reindex', action='store_true',
                    help='rewrite manifest.json from the tiles on disk; '
                         'bakes nothing, deletes nothing')
    a = ap.parse_args()
    if a.reindex:
        layers = PRODUCT_LAYERS if a.layer == 'both' else (a.layer,)
        reindex(a.out, layers)
        return 0
    if not 0 <= a.top <= grid.MAX_TOP_LEVEL:
        raise SystemExit(f'--top must be 0..{grid.MAX_TOP_LEVEL}')
    try:
        validate_band_rows(a.band_rows)
    except ValueError as exc:
        raise SystemExit(str(exc))
    layers = ('paper', 'photo') if a.layer == 'both' else (a.layer,)
    est = estimate(a.top, layers)
    # The volume --out lives on, not the volume the shell happens to be in.
    free = free_bytes_at(a.out)
    lo, hi = project_seconds(a.top, layers, a.band_rows)
    print(f'top=L{a.top} ({grid.m_per_px(a.top):.1f} m/px) layers={list(layers)}')
    print(f'planned files={est["files"]:,} bytes~={est["bytes"]/1e9:.2f} GB '
          f'disk free={free/1e9:.1f} GB at {a.out}')
    print(f'projected {bands_per_layer(a.top, a.band_rows) * len(layers)} bands '
          f'= {lo/3600:.1f}-{hi/3600:.1f} h at the measured per-band cost')

    # Stage 0, in front of every write and every `--force` delete. A wrong grid
    # costs milliseconds to discover here and three hours to discover later.
    # `check_sources` prints each problem line itself (both sources reported in
    # one run), so this header must NOT re-echo the exception text -- doing so
    # printed every 'ABSENT' twice and turned a clear message into noise.
    try:
        check_sources(a.detail, a.color, quiet=False)
    except SourceError:
        print('STAGE 0 FAILED — refusing to bake; fix the source problems '
              'listed above before running this again.', file=sys.stderr)
        return 2

    # The same refusal `run()` is about to make, told at PLANNING time: a resume
    # that is going to stop at the encoder guard must not be started to discover
    # it, because "started" here is a multi-hour read of a 3.04 GB JP2. Cheap
    # (one small JSON read) and it is the only guard here that a --dry-run can
    # answer at all, since a dry run writes nothing.
    delivered = Path(a.out) / 'manifest.json'
    prev_layers = (json.loads(delivered.read_text(encoding='utf-8'))
                   .get('layers', {}) if delivered.exists() else {})
    try:
        check_encoder_params(prev_layers, layers, a.quality,
                             None if a.no_detail else a.k, a.force)
    except EncoderMismatchError as exc:
        print(str(exc), file=sys.stderr)
        return 4

    if a.dry_run:
        print('dry run: nothing written')
        return 0

    ok, needed = check_disk_or_abort(est, free)
    if not ok:
        print(disk_refusal(est, needed, free, a.out, a.band_rows),
              file=sys.stderr)
        return 3

    try:
        run(detail=a.detail, color=a.color, layers=layers, top=a.top,
            quality=a.quality, band_rows=a.band_rows,
            k=None if a.no_detail else a.k, out_dir=a.out, force=a.force)
    except EncoderMismatchError as exc:
        # Exit 4, and nothing written: the tree that is on disk is still exactly
        # the tree the delivered record describes. `main()` catches rather than
        # letting the traceback through because the message IS the decision --
        # it names the recorded value, the requested value and the --force escape.
        print(str(exc), file=sys.stderr)
        return 4
    return 0


if __name__ == '__main__':
    sys.exit(main())
