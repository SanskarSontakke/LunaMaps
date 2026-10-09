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


# ------------------------------------------------------------------ MUST FIX 3
# The test above is a CONSISTENCY check: it re-derives its expectation with
# `derive.parent_from_children`, the function under test, so a quadrant swap in
# `derive.py` (`nw, ne, sw, se`) or a wrong `reshape` axis order leaves it green.
# Spec §5.3 asked for BOTH the exact tile pixel values AND the averaging
# identity, and neither was asserted anywhere in this suite. The two tests below
# hand-write both expectations from the source definition instead.

def _kid(a, b, c, d):
    """A 4x4 child built from four *uniform* 2x2 sub-blocks.

    That layout is what makes the expectation hand-writable: every parent pixel
    is the average of four equal values, so it is exactly that value -- no
    rounding, no clipping, no arithmetic to re-derive. `a`..`d` are unique across
    all four children (1..16), so the parent matrix is a permutation-sensitive
    fingerprint of the quadrant order.
    """
    return np.array([[a, a, b, b], [a, a, b, b],
                     [c, c, d, d], [c, c, d, d]], np.uint8)


NW, NE, SW, SE = _kid(1, 2, 3, 4), _kid(5, 6, 7, 8), _kid(9, 10, 11, 12), \
    _kid(13, 14, 15, 16)
# Hand-written, from `nw, ne, sw, se = kids` and a 2x2 box average of the stitched
# 8x8 image. Nothing here calls derive.
EXPECTED_PARENT = np.array([[1, 2, 5, 6],
                            [3, 4, 7, 8],
                            [9, 10, 13, 14],
                            [11, 12, 15, 16]], np.uint8)


def test_parent_is_the_hand_written_quadrant_matrix_not_a_recomputed_one():
    """`parent_from_children` must place nw top-left, ne top-right, sw bottom-left
    and se bottom-right, and average 2x2 blocks -- each expectation written by hand
    above, so the function is not its own oracle."""
    assert np.array_equal(derive.parent_from_children([NW, NE, SW, SE]),
                          EXPECTED_PARENT)
    # The fixture discriminates order: every one of these is a plausible mistake
    # (transposed quadrants, a vertical or horizontal mirror, a swapped pair) and
    # none of them may produce the hand-written matrix.
    for wrong_order, label in [
        ([NW, SW, SE, NE], 'rotated quadrants'),
        ([NE, NW, SE, SW], 'mirrored east-west'),
        ([SW, SE, NW, NE], 'mirrored north-south'),
        ([SE, SW, NE, NW], 'rotated 180'),
        ([NW, NE, SE, SW], 'sw and se swapped'),
    ]:
        got = derive.parent_from_children(wrong_order)
        assert not np.array_equal(got, EXPECTED_PARENT), f'{label} passed'
    # And a transposed *assembly* (concatenating along the other axis first) is a
    # different image, so the axis order in the concat is being checked too.
    transposed = np.concatenate([np.concatenate([NW, SW], axis=1),
                                 np.concatenate([NE, SE], axis=1)], axis=0)
    assert not np.array_equal(transposed,
                              np.concatenate([np.concatenate([NW, NE], axis=1),
                                              np.concatenate([SW, SE], axis=1)],
                                             axis=0))


def test_parent_averages_each_colour_channel_separately():
    """The ndim==3 branch of `parent_from_children` (the `photo` layer's RGB) has
    the same hand-written expectation, per channel, and must not collapse,
    reorder or reshape the channel axis. Each child carries a per-channel offset
    (0, 1, 2, 3) so a channel mix-up changes which matrix comes out, while the
    block-uniform layout keeps every parent pixel exact."""
    kids = [np.stack([k + np.uint8(0), k + np.uint8(1), k + np.uint8(2)], axis=-1)
            for k in (NW, NE, SW, SE)]
    got = derive.parent_from_children(kids)
    assert got.shape == (4, 4, 3)
    for ch in range(3):
        assert np.array_equal(got[..., ch], EXPECTED_PARENT + np.uint8(ch)), \
            f'channel {ch} is not the hand-written parent'


def test_baked_tile_pixels_and_the_derived_parent_are_exact(tmp_path):
    """Exact pixel values, end to end, asserted against the SOURCE definition
    rather than against a function in this repo.

    The fixture raster is sized to the L1 world grid (2048 x 1024), so the level
    read is 1:1 and `paper` -- the raw detail band, no composite, no blur -- has
    to reproduce it DN for DN. Its value pattern is a banded gradient
    (20 + 24 * columnBand + 3 * rowBand, bands 256 x 128 px) chosen so that no
    2x2 parent block can straddle a band edge: a block starts at an even world
    column/row and the bands are even and 2-aligned, so every parent pixel is the
    average of four equal values, i.e. exactly the source value two pixels over.
    A vertical flip, a 180 deg longitude rotation or a quadrant swap in `derive`
    each changes at least one of the pixels asserted."""
    import bake
    W, H = grid.world_px_width(1), grid.world_px_height(1)
    assert (W, H) == (2048, 1024), (W, H)
    col_band = np.arange(W) // 256
    row_band = (np.arange(H) // 128)[:, None]
    detail = (20 + 24 * col_band + 3 * row_band).astype(np.uint8)
    colour = np.dstack([np.full((H, W), v, np.uint8)
                        for v in (190, 170, 150, 255)])
    d = write_raster(tmp_path / 'detail.tif', detail)
    c = write_raster(tmp_path / 'colour.tif', colour)
    out = tmp_path / 'tiles'
    bake.run(detail=d, color=c, layers=('paper',), top=1, quality=100,
             band_rows=1024, k=None, out_dir=str(out), force=True, quiet=True)

    def source_value(row, col):
        """The DN the contract says world pixel (row, col) of the L1 grid holds.
        Accepts broadcastable row/column arrays."""
        return (20 + 24 * (col // 256) + 3 * (row // 128)).astype(np.uint8)

    # L1: every tile, at columns and rows that are not near a band edge, is the
    # source exactly (equal arrays, not "within a tolerance").
    idx = np.arange(4, 508)
    for y in range(grid.level_rows(1)):
        for x in range(grid.level_cols(1)):
            im = np.array(Image.open(out / 'paper' / '1' / str(x) / f'{y}.jpg'))
            want = source_value(y * 512 + idx[:, None], x * 512 + idx[None, :])
            assert np.array_equal(im[np.ix_(idx, idx)], want), \
                f'L1 tile ({x},{y}) is not the source pixel for pixel'

    # L0: the parent derived from those tiles, at the same hand-written values.
    # A parent pixel (r, c) of tile (tx, ty) is world L0 (ty*512+r, tx*512+c),
    # i.e. world L1 (2*(ty*512+r), 2*(tx*512+c)).
    for y in range(grid.level_rows(0)):
        for x in range(grid.level_cols(0)):
            im = np.array(Image.open(out / 'paper' / '0' / str(x) / f'{y}.jpg'))
            want = source_value(2 * (y * 512 + idx[:, None]),
                                2 * (x * 512 + idx[None, :]))
            assert np.array_equal(im[np.ix_(idx, idx)], want), \
                f'L0 parent tile ({x},{y}) is not the box average of its children'


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


def test_the_band_blur_is_periodic_across_a_step_at_the_seam(tmp_path):
    """Continuity is not periodicity, so this is the test that proves the wrap.

    The fixture above puts a 256 px-wide (at L1) dark band *around* lon=+-180,
    which means both the periodic and the edge-clamped blur see nothing but
    dark pixels at columns 0 and W-1 -- they agree there, and the assertion
    cannot tell the two boundary conditions apart. A step exactly at the
    antimeridian is the layout where they differ: with `wrap_x=True` the kernel
    at column 0 reads the far side's dark pixels and overshoots bright, and the
    kernel at column W-1 reads the bright side and undershoots dark. With
    `wrap_x=False` both edges stay flat at the base colour and the antimeridian
    shows the classic 1-tile-wide streak.

    Measured (work/wrap_probe.py, red channel, L1 tile edges vs a flat reference
    64 px inside the same tile): periodic 237 (+46) and 124 (-67); edge-clamped
    191 (+0) and 191 (+0). The thresholds below are that gap, not a guess.
    """
    yy, xx = np.mgrid[0:SRC_H, 0:SRC_W]
    detail = np.where(xx < SRC_W // 2, 200, 30).astype(np.uint8)
    colour = np.dstack([
        np.full((SRC_H, SRC_W), 190, np.uint8),
        np.full((SRC_H, SRC_W), 170, np.uint8),
        np.full((SRC_H, SRC_W), 150, np.uint8),
        np.full((SRC_H, SRC_W), 255, np.uint8),
    ])
    d = write_raster(tmp_path / 'step.tif', detail)
    c = write_raster(tmp_path / 'colour.tif', colour)
    out = tmp_path / 'tiles'
    import bake
    bake.run(detail=d, color=c, layers=('photo',), top=1, quality=95,
             band_rows=512, k=1.0, out_dir=str(out), force=True)
    cols = grid.level_cols(1)
    left = np.array(Image.open(out / 'photo' / '1' / '0' / '0.jpg'))[..., 0]
    right = np.array(Image.open(out / 'photo' / '1' / str(cols - 1) / '0.jpg'))[..., 0]
    # 96 px inside the tile: outside the 8 px kernel's reach, so the composite
    # of a flat detail region is exactly the base colour (red channel 190).
    flat = int(left[:, 96:160].mean())
    assert abs(flat - 190) <= 2, flat
    assert int(left[:, :4].mean()) - flat > 30
    assert flat - int(right[:, -4:].mean()) > 30


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
    # Finding 10 of Task 7/8 review: `levels` used to be `range(8)` -- the whole
    # grid contract -- so a top=0 pyramid claimed L1..L7. It now lists exactly
    # what was baked, and nothing else.
    assert [lv['L'] for lv in m['levels']] == [0]
    # The old `m['levels'][6]` index only worked because the list was the grid
    # table, not the pyramid. The L6 resolution is still pinned, on the source
    # of truth rather than on a manifest row that need not exist.
    assert grid.m_per_px(6) == pytest.approx(166.571, abs=0.001)


def test_manifest_lists_exactly_the_levels_the_pyramid_has(sources, tmp_path):
    """A top=2 pyramid has L0/L1/L2 on disk and no L3, in the manifest and in
    the directory tree alike."""
    out = tmp_path / 'tiles'
    import bake
    import manifest
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=2))
    m = json.loads((out / 'manifest.json').read_text())
    assert [lv['L'] for lv in m['levels']] == [0, 1, 2]
    assert manifest.baked_levels(out, ('photo',)) == [0, 1, 2]
    for lv in m['levels']:
        assert lv['cols'] == grid.level_cols(lv['L'])
        assert lv['rows'] == grid.level_rows(lv['L'])
        assert lv['mPerPx'] == pytest.approx(grid.m_per_px(lv['L']), abs=0.01)
    assert m['levels'][2]['mPerPx'] == pytest.approx(2665.14, abs=0.01)
    # The whole grid table (L0..L7) is still available to a caller that wants
    # it; it is simply no longer the default claim of a manifest.
    full = manifest.base_manifest(range(grid.MAX_TOP_LEVEL + 1))
    assert [lv['L'] for lv in full['levels']] == list(range(grid.MAX_TOP_LEVEL + 1))


def test_manifest_bakes_and_derives_are_counted_separately(sources, tmp_path):
    """Finding 3: one conflated `written` counter made a resume look like work.

    top=1 on a 1024x512 synthetic source: 8 tiles at L1, 2 parents at L0.
    """
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1))
    m = json.loads((out / 'manifest.json').read_text())
    assert m['layers']['photo']['baked'] == 8
    assert m['layers']['photo']['derived'] == 2
    assert m['layers']['photo']['tiles'] == 10
    # A resume of the same tree bakes nothing at the top and re-encodes the
    # parents it always re-encodes; the two numbers stay honest.
    again = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                                   force=False))
    m2 = json.loads((out / 'manifest.json').read_text())
    assert m2['layers']['photo']['baked'] == 0
    assert m2['layers']['photo']['derived'] == 2
    assert m2['layers']['photo']['tiles'] == 10
    assert again == 2, 'return value is this call write count, baked + derived'


def test_manifest_file_ends_with_a_newline(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    raw = (out / 'manifest.json').read_bytes()
    assert raw.endswith(b'}\n'), 'finding 13: no tracked text file should ' \
                                 'end mid-line'



def test_estimate_grows_superlinearly():
    import bake
    a = bake.estimate(6, ('paper', 'photo'))
    b = bake.estimate(7, ('paper', 'photo'))
    assert b['files'] == a['files'] + 2 * grid.level_cols(7) * grid.level_rows(7)
    assert b['bytes'] > a['bytes'] * 2


# ==========================================================================
# MUST FIX 1 (2026-10-09 whole-branch review): a resume ignores the encoder
# parameters that produced the files.
#
# `save_tile` skips a tile when the FILE exists, not when the file exists WITH
# THE PARAMETERS THIS RUN IS ASKING FOR, and `derive.derive_levels` re-encodes
# every parent unconditionally. The reviewer's reproduction over the delivered
# q85 tree is `bake.py --top 7 --layer photo --quality 30`: the 32,768 L7
# children keep q85, the 10,922 derived parents come back at q30, and `run()`
# then publishes `layers.photo.quality = 30` -- a manifest that mislabels the
# majority of its own tree. The fix is to REFUSE, not to silently re-encode.
# ==========================================================================

def tree_state(out):
    """Every delivered byte: per-tile size, per-tile mtime, manifest text.

    A refusal has to be proved to have written NOTHING, and "the sizes look the
    same" is not that proof -- a re-encode can land on the same size.
    """
    return ({str(p.relative_to(out)).replace('\\', '/'):
             (p.stat().st_size, p.stat().st_mtime_ns)
             for p in sorted(out.rglob('*.jpg'))},
            (out / 'manifest.json').read_text(encoding='utf-8'))


def test_a_resume_with_a_changed_quality_refuses_and_writes_nothing(sources,
                                                                    tmp_path):
    """The defect, end to end: the second run asks for q30 over a tree the first
    run wrote at q85, so it must stop before writing a byte rather than publish
    one `quality` for a tree holding two."""
    import bake
    out = tmp_path / 'tiles'
    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                                   quality=85))
    assert wrote == 10, wrote                 # 8 children + 2 parents
    before = tree_state(out)

    with pytest.raises(bake.EncoderMismatchError) as exc:
        bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                               quality=30, force=False))
    msg = str(exc.value)
    assert 'layers.photo.quality' in msg, msg
    assert '85' in msg and '30' in msg, 'must name the recorded AND the requested'
    assert '--force' in msg, 'must name the escape hatch'
    assert tree_state(out) == before, 'the refusal wrote something'


def test_a_resume_with_a_changed_detail_gain_refuses(sources, tmp_path):
    """`detailGain` is an encoder parameter too: k changes every photo pixel, so
    a resume that keeps the old children and re-encodes the parents at a new k
    mislabels the tree in exactly the same way, and the record carries the value
    (`layers.photo.detailGain`) needed to notice it."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1, quality=85,
                           k=0.4))
    before = tree_state(out)
    with pytest.raises(bake.EncoderMismatchError) as exc:
        bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                               quality=85, k=0.9, force=False))
    msg = str(exc.value)
    assert 'detailGain' in msg, msg
    assert '0.4' in msg and '0.9' in msg, msg
    assert '--force' in msg, msg
    assert tree_state(out) == before


def test_a_no_detail_resume_refuses_when_the_tree_was_baked_with_detail(
        sources, tmp_path):
    """`--no-detail` is a real encoder change (k: 0.4 -> None), and the guard has
    to read a recorded `None` as "this tree was baked without the composite",
    not as "the record says nothing"."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1, quality=85,
                           k=0.4))
    with pytest.raises(bake.EncoderMismatchError, match='detailGain'):
        bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                               quality=85, k=None, force=False))


def test_a_paper_resume_is_not_refused_for_the_photos_detail_gain(sources,
                                                                  tmp_path):
    """The guard must not over-refuse. `paper` is the raw detail band: its record
    has no detail gain at all, so this run's `--detail-gain` cannot contradict
    it, and a paper-only resume with a k nobody uses has to be allowed."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('paper', 'photo'), top=0,
                           quality=85, k=0.4))
    again = bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0,
                                   quality=85, k=0.0, force=False))
    assert again == 0, again                  # a genuine zero-write resume


def test_a_resume_of_a_layer_the_run_does_not_write_is_never_blocked(
        sources, tmp_path):
    """The guard must not over-refuse across layers. `paper` is delivered at q85
    and is CARRIED by a photo-only run, not re-encoded, so a first-ever
    `--layer photo --quality 30` (no photo record to contradict) has to be
    allowed -- that is the command the disk refusal itself advises, and blocking
    it would make the advice unfollowable even under --force.
    """
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0, quality=85,
                           k=0.4))
    first_stamp = json.loads((out / 'manifest.json').read_text(
        encoding='utf-8'))['generatedAt']

    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=0, quality=30,
                           k=0.4, force=False))
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['layers']['photo']['quality'] == 30      # this run, q30
    assert m['layers']['paper']['quality'] == 85      # carried, still q85
    assert m['layers']['paper']['carriedFrom'] == first_stamp


def test_force_is_the_escape_hatch_and_rebakes_the_layer_consistently(
        sources, tmp_path):
    """With --force the layer is deleted and re-baked, so every file in it really
    is q30 and the record saying 30 is then true."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1, quality=85))
    before = tree_state(out)
    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                                   quality=30, force=True))
    assert wrote == 10, wrote
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['layers']['photo']['quality'] == 30
    after = tree_state(out)
    assert after[0] != before[0], '--force re-baked nothing'
    assert all(v[1] > b[1] for (v, b) in
               zip(after[0].values(), before[0].values())), \
        'every delivered photo tile must have been rewritten'


def test_a_record_that_states_no_quality_cannot_be_contradicted(sources, tmp_path):
    """`quality: null` is a state a `--reindex` of a tree that never recorded one
    can leave behind. The guard refuses when the delivered record CONTRADICTS this
    run; it must not refuse because the artifact admits it does not know, because
    that would block the very run that could put a true value in the record."""
    import bake
    import manifest
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1, quality=85))
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    m['layers']['photo']['quality'] = None
    manifest.write_manifest(out / 'manifest.json', m)
    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                                   quality=30, force=False))
    assert wrote == 2, wrote      # the top tiles exist; the parents are re-encoded
    after = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert after['layers']['photo']['quality'] == 30, \
        'a run that cannot be contradicted still records what it encoded at'


def test_the_recorded_and_requested_qualities_measurably_encode_differently(
        tmp_path):
    """The premise of the refusal, measured here rather than quoted: JPEG
    `quality` is not a label, it changes the bytes, so one number cannot describe
    a tree encoded with two.

    The review measured the same pixels at 165,079 B (q85) and 83,555 B (q30);
    this fixture is a 512x512 tile, so only the RATIO is comparable, and the
    assertion is that q30 costs under 70% of q85 -- far outside any noise.
    """
    from PIL import Image
    import numpy as _np
    rng = _np.random.default_rng(20261009)
    grad = _np.add.outer(rng.integers(0, 60, 512), rng.integers(0, 60, 512))
    arr = _np.clip(grad + _np.arange(512)[None, :] // 4, 0,
                   255).astype(_np.uint8)
    sizes = {}
    for q in (85, 30):
        p = tmp_path / f'q{q}.jpg'
        Image.fromarray(arr).save(p, quality=q, optimize=True)
        sizes[q] = p.stat().st_size
    assert sizes[30] < 0.7 * sizes[85], sizes


# ==========================================================================
# MUST FIX 2 (2026-10-09 whole-branch review): a zero-write resume restamps the
# whole pyramid.
#
# `run()` called `base_manifest()` WITHOUT `generated_at`, so `manifest.py`
# stamped `now()`: a resume that baked 0 tiles re-dated 87,380 files it never
# touched, while `reindex()` deliberately carries the stamp forward because
# `Attribution` renders `generatedAt` to the user as the bake date.
#
# THE RULE (chosen and implemented in `bake.run`): `generatedAt` dates the
# PIXELS. Carry it when the run wrote nothing; restamp when it wrote anything.
# ==========================================================================

FROZEN_STAMP = '2026-01-01T00:00:00+00:00'


def freeze_stamp(out, stamp=FROZEN_STAMP):
    """Pin the delivered stamp to a date the run cannot coincide with, so
    'carried' and 'restamped' are distinguishable in a millisecond."""
    import manifest
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    m['generatedAt'] = stamp
    manifest.write_manifest(out / 'manifest.json', m)
    return stamp


def test_a_zero_write_resume_keeps_the_delivered_bake_stamp(sources, tmp_path):
    """0 writes == 0 pixels changed == nothing honest to re-date."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    stamp = freeze_stamp(out)
    before = tree_state(out)

    wrote = bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0,
                                   force=False))
    assert wrote == 0, wrote
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['generatedAt'] == stamp, \
        'a run that wrote no tile re-dated the whole pyramid'
    assert tree_state(out)[0] == before[0], 'the resume rewrote a tile anyway'


def test_a_run_that_writes_a_single_tile_restamps(sources, tmp_path):
    """The other half of the rule: the stamp describes the artifact, so a run
    that changed any pixel restamps. A parent-only resume (top=1: 0 baked, 2
    parents re-encoded) is a run that wrote, and must move the date -- which is
    exactly why `derived` is counted and printed separately from `baked`."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1, quality=85))
    stamp = freeze_stamp(out)

    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=1,
                                   quality=85, force=False))
    assert wrote == 2, wrote
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['layers']['photo']['baked'] == 0
    assert m['layers']['photo']['derived'] == 2
    assert m['generatedAt'] != stamp, 'a run that wrote 2 tiles kept the old date'
    from datetime import datetime
    assert datetime.fromisoformat(m['generatedAt']) > \
        datetime.fromisoformat(stamp), m['generatedAt']


def test_a_force_rebake_restamps(sources, tmp_path):
    """--force deletes the layer and bakes a new one: the artifact changed, so
    the date changes with it."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=0, quality=85))
    stamp = freeze_stamp(out)
    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=0,
                                   quality=85, force=True))
    assert wrote == 2, wrote
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['generatedAt'] != stamp


def test_the_stamp_rule_matches_the_one_reindex_already_follows(sources, tmp_path,
                                                                monkeypatch):
    """The two zero-write paths -- `--reindex` and a 0-tile resume -- must not
    disagree about what `generatedAt` means, because both face the user through
    `Attribution`."""
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out, layers=('photo',), top=0, quality=85))
    stamp = freeze_stamp(out)
    wrote = bake.run(**bake_kwargs(sources, out, layers=('photo',), top=0,
                                   quality=85, force=False))
    assert wrote == 0
    after_bake = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert after_bake['generatedAt'] == stamp

    monkeypatch.setattr(sys, 'argv', ['bake.py', '--reindex', '--out', str(out)])
    assert bake.main() == 0
    after_reindex = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert after_reindex['generatedAt'] == stamp, \
        'reindex carries the stamp but a zero-write bake does not'
