"""Baking region boxes out of a remote cloud-optimised GeoTIFF, without downloading it.

Nothing here opens a socket. The source opener is injected, and every fixture is a
synthetic raster whose value at each pixel is a deterministic function of its
longitude and latitude, so a wrong y-origin, a swapped antimeridian half or an
off-by-one tile column shows up as a *wrong number* rather than an implausible
image.

Why the fixtures are shaped like this:

* `global_path` is 2048 x 1024 px -- exactly the L1 world grid -- so an L1 read is
  1:1 and an L0 read is a 2x2 box average, and its pattern is constant on a
  256 x 128 px block grid. That makes it 8-aligned (so it survives a JPEG
  round-trip bit-exactly) *and* invariant under the box averages those two levels
  perform; `test_the_fixture_pattern_survives...` proves the invariance instead of
  assuming it. A fixture that read the same value in every row could not see a
  flipped y-origin, which is the bug this project has already been bitten by.
* `crop_path` is a *cropped* raster at 3000 px/deg with an origin away from the
  world corners, so the geometry is checked against the source's own transform
  rather than against a lucky round number.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.enums import Resampling
from rasterio.errors import WindowError
from rasterio.transform import from_bounds
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bake            # noqa: E402
import contract        # noqa: E402
import grid            # noqa: E402
import manifest        # noqa: E402
import regions         # noqa: E402
import stream_bake     # noqa: E402

TEST_URL = 'example.invalid/Kaguya_like_cog.tif'
GW, GH = 2048, 1024                      # == the L1 world grid
PX0 = GW / 360.0                         # the global fixture's own px/deg
SITE_BOX = [23.1, 0.2, 23.4, 0.5]


# ---------------------------------------------------------------------------
# fixtures and helpers
# ---------------------------------------------------------------------------

def block_pattern(width, height):
    """value = 1 + 8*(col//256) + (row//128).

    Unique per (column band, row band) inside 2048 x 1024, so it fingerprints both
    axes: longitude in the eights, latitude in the units.
    """
    cols = np.arange(width)[None, :]
    rows = np.arange(height)[:, None]
    return (1 + 8 * (cols // 256) + (rows // 128)).astype(np.uint8)


def write_geotiff(path, array, west, south, east, north):
    h, w = array.shape
    with rasterio.open(str(path), 'w', driver='GTiff', width=w, height=h,
                       count=1, dtype='uint8', crs=CRS.from_wkt(contract.MOON_WKT),
                       transform=from_bounds(west, south, east, north, w, h)) as ds:
        ds.write(array, 1)
    return str(path)


@pytest.fixture(scope='module')
def global_array():
    return block_pattern(GW, GH)


@pytest.fixture(scope='module')
def global_path(tmp_path_factory, global_array):
    return write_geotiff(tmp_path_factory.mktemp('src') / 'global.tif',
                         global_array, -180.0, -90.0, 180.0, 90.0)


@pytest.fixture(scope='module')
def crop_array():
    return block_pattern(1800, 2100)


@pytest.fixture(scope='module')
def crop_path(tmp_path_factory, crop_array):
    """0.6 deg x 0.7 deg at 3000 px/deg, north-west corner at lon 23.0 / lat 0.7.

    0.6 deg, not 0.5, because the box it has to serve costs three L10 columns:
    SITE_BOX [23.1, 0.2, 23.4, 0.5] is covered by columns 1155..1157, which run
    from 1155's west edge -180 + 1155 * 360/2048 = 23.02734375 to column 1158's
    west edge -180 + 1158 * 360/2048 = 23.5546875. That is 0.52734375 deg of
    longitude, so a 0.5 deg crop would be asked to read geometry it does not
    contain. The origin stays off every world corner and off every tile edge, so
    the fractions below are the fixture's own georeference, not a round number.
    """
    return write_geotiff(tmp_path_factory.mktemp('crop') / 'crop.tif',
                         crop_array, 23.0, 0.0, 23.6, 0.7)


class Spy:
    """A dataset-like wrapper around a real reader.

    It records every read the module asks for (so geometry is asserted on the
    numbers actually issued), can fail the first N of them or any window a test
    names (so the retry path needs no network), can answer with a short array
    (so a partly-read chunk is testable), and can raise something that is not an
    `OSError` (`fail_exc`) -- which is how a `rasterio.errors.RasterioError` like
    `WindowError` gets simulated without a broken file.
    """

    def __init__(self, ds, fail_first=0, fail_when=None, short_at=None,
                 fail_exc=None):
        self.ds = ds
        self.fail_first = fail_first
        self.fail_when = fail_when
        self.short_at = short_at
        self.fail_exc = fail_exc
        self.calls = []

    def read(self, indexes=1, window=None, out_shape=None, resampling=None, **kw):
        self.calls.append({'indexes': indexes, 'window': window,
                           'out_shape': out_shape, 'resampling': resampling})
        n = len(self.calls) - 1
        if n < self.fail_first or (self.fail_when and self.fail_when(window)):
            raise self.fail_exc if self.fail_exc else OSError(
                'simulated /vsicurl stream reset')
        arr = self.ds.read(indexes, window=window, out_shape=out_shape,
                           resampling=resampling)
        if self.short_at == n:
            arr = arr[:max(1, arr.shape[0] - 7)]
        return arr

    def close(self):
        self.ds.close()

    def __getattr__(self, name):
        return getattr(self.ds, name)


class Stub:
    """A dataset-like object that is deliberately NOT the source this path bakes:
    wrong band count, wrong dtype, or a transform in metres rather than degrees.
    Each is a thing the gate has to catch from the file alone, and all three carry
    a transform fine enough to clear the resolution gate, so the guard under test
    is the one that is supposed to speak."""

    transform = from_bounds(-180.0, -90.0, 180.0, 90.0, 1_474_560, 737_280)
    width = 1_474_560
    height = 737_280

    def __init__(self, count=3, dtype='uint8', transform=None):
        self.count = count
        self.dtypes = [dtype] * count
        if transform is not None:
            self.transform = transform

    def read(self, *a, **kw):
        raise AssertionError('a refused source must never be read')

    def close(self):
        pass


def opener_for(path, **spy_kw):
    """An injectable opener, plus the URLs it was asked for and the datasets it made."""
    seen, made = [], []

    def open_(url):
        seen.append(url)
        made.append(Spy(rasterio.open(path), **spy_kw))
        return made[-1]
    return open_, seen, made


def source_table(px_per_deg, extra=None):
    table = {'test-cog': {'url': TEST_URL, 'pxPerDeg': px_per_deg,
                          'projection': 'equirectangular', 'shaded': True}}
    table.update(extra or {})
    return table


def region(rid='wide', box=(-100.0, -50.0, 100.0, 50.0), lo=0, hi=1,
           source='test-cog'):
    return {'id': rid, 'name': rid.title(), 'kind': 'feature', 'box': list(box),
            'minLevel': lo, 'maxLevel': hi, 'source': source}


def expected_tile(global_array, L, x, y):
    """Hand-computed from the contract, never from stream_bake.

    The fixture IS the L1 world grid (2048 x 1024), so world pixel (col, row) of
    level L sits at source pixel (col * 2^(1-L), row * 2^(1-L)).
    """
    step = 2 ** (1 - L)
    rows = (np.arange(grid.TILE) + y * grid.TILE) * step
    cols = (np.arange(grid.TILE) + x * grid.TILE) * step
    return global_array[np.ix_(rows, cols)]


def tile_names(out_dir):
    return sorted(p.relative_to(Path(out_dir)).as_posix()
                  for p in Path(out_dir).rglob('*.jpg'))


def argv(monkeypatch, *args):
    monkeypatch.setattr(sys, 'argv', ['stream_bake.py', *args])


def plan_of(*regs, px_per_deg=PX0):
    return stream_bake.plan(list(regs), sources=source_table(px_per_deg))


# ---------------------------------------------------------------------------
# the plan: what a run costs, before anyone spends a byte
# ---------------------------------------------------------------------------

def test_the_plan_counts_each_region_and_each_level():
    regs = [region('a', box=(-100.0, -50.0, 100.0, 50.0), lo=0, hi=1),
            region('b', box=(23.0, 0.0, 24.0, 1.0), lo=7, hi=8)]
    by_id = {e['id']: e for e in plan_of(*regs, px_per_deg=4096.09)}
    # Task 1 owns the tile arithmetic; the plan has to agree with it exactly.
    for reg in regs:
        assert by_id[reg['id']]['tiles'] == regions.tile_count(reg)
    # b is [23.0, 0.0, 24.0, 1.0]. At L7 a tile is 360/256 = 1.40625 deg:
    #   lon_to_tile_x(23.0, 7) = floor(203 * 256/360) = floor(144.355) = 144
    #   lon_to_tile_x(24.0, 7) = floor(204 * 256/360) = floor(145.022) = 145
    #   lat_to_tile_y(1.0, 7)  = floor(89 * 128/180)  = floor(63.288)  = 63
    #   lat_to_tile_y(0.0, 7)  = floor(90 * 128/180)  = floor(64.000)  = 64  -> 2x2
    # At L8 a tile is 360/512 = 0.703125 deg, so each axis gains one column:
    #   lon_to_tile_x(23.0, 8) = floor(203 * 512/360) = floor(288.711) = 288
    #   lon_to_tile_x(24.0, 8) = floor(204 * 512/360) = floor(290.133) = 290
    #   lat_to_tile_y(1.0, 8)  = floor(89 * 256/180)  = floor(126.577) = 126
    #   lat_to_tile_y(0.0, 8)  = floor(90 * 256/180)  = floor(128.000) = 128  -> 3x3
    # Doubling the column count does not double a count that is already rounded
    # down to a whole tile: L8 is 9, not 16.
    assert by_id['b']['tilesPerLevel'] == {7: 4, 8: 9}
    assert sum(by_id['b']['tilesPerLevel'].values()) == by_id['b']['tiles'] == 13
    assert by_id['b']['perLevel'][7] == [[144, 145, 63, 64]]


def test_only_selects_one_region_by_id():
    got = stream_bake.plan([region('a'), region('b')], only='b',
                           sources=source_table(PX0))
    assert [e['id'] for e in got] == ['b']


def test_an_unknown_source_key_is_a_named_problem():
    problems = stream_bake.check_plan(plan_of(region('a', source='kaguya-tcp')))
    assert len(problems) == 1
    assert 'a' in problems[0] and 'kaguya-tcp' in problems[0]


def test_a_polar_stereographic_source_is_refused_by_name():
    """A polar-stereographic mosaic read with this grid's maths would bake a
    pretty, precise lie, so the plan refuses it before opening anything.

    `pxPerDeg` is the figure measured off the real SPOLE header (1011.71), not a
    generous stand-in: at 30,000 the resolution comparison below the projection
    refusal cannot fire, so the fixture used to guarantee that only ONE problem was
    ever reported. 1011.71 is below L9's 1456.36, so this now proves the projection
    refusal is the only message a non-equirectangular source ever gets -- comparing
    degrees-per-pixel of a projected pixel against this grid's is dimensionally
    meaningless, and saying so twice is worse than saying the true thing once.
    """
    entries = stream_bake.plan(
        [region('cap', box=[-180.0, -90.0, 180.0, -84.0], lo=8, hi=9,
                source='stereo')],
        sources=source_table(PX0, extra={'stereo': {
            'url': TEST_URL, 'pxPerDeg': 1011.71,
            'projection': 'polar-stereographic', 'shaded': True}}))
    problems = stream_bake.check_plan(entries)
    assert len(problems) == 1, problems
    assert 'stereo' in problems[0] and 'polar-stereographic' in problems[0]


def test_baking_into_a_product_layer_is_refused_by_name(global_path, tmp_path):
    """`--layer` is free text, so `--layer paper` streams Kaguya TC's SHADED
    orthophoto pixels into the WAC albedo pyramid and writes them into the tree the
    app shows as flat relief. The illumination-mixing ban -- the standing rule this
    whole layer exists to respect -- was enforced by nothing but the operator typing
    the default. The pipeline would only notice afterwards, through
    `test_disk_guard.py`'s pinned paper.bytes."""
    entries = plan_of(region('wide', lo=1, hi=1))
    open_, _, _ = opener_for(global_path)
    for product in ('paper', 'photo'):
        with pytest.raises(stream_bake.Refusal) as raised:
            stream_bake.bake_all(entries, tmp_path / 'tiles', opener=open_,
                                 layer=product, quality=100)
        assert product in str(raised.value) and 'shaded' in str(raised.value)
    assert not (tmp_path / 'tiles').exists(), 'a refused layer still wrote a tree'


def test_publishing_onto_a_product_layer_is_refused(global_path, tmp_path):
    """The same door on the other side: `publish(out, 'paper')` overwrites the bake
    record with an availability block and `source: null`, destroying quality,
    photometric, detailGain and the baked/derived write counts. Every guard in
    publish stayed green doing it -- the presence check only asks that `paper`
    EXISTS, and the post-write comparison exempts the very layer being written."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    raw = (out / 'manifest.json').read_bytes()
    for product in ('paper', 'photo'):
        with pytest.raises(stream_bake.PublishRefusal) as raised:
            stream_bake.publish(out, product, regions_file=tmp_path / 'nope.json')
        assert product in str(raised.value)
    assert (out / 'manifest.json').read_bytes() == raw, 'a refused publish wrote'


def test_the_streaming_run_checks_free_space_before_it_opens_anything(
        tmp_path, monkeypatch, capsys, cli_plan):
    """Amendment §4 tells the operator "the bake guard already refuses to run without
    1.5x its estimate", and for `bake.py` that is true. `stream_bake.py` could not
    reach it: it imports `bake` only for `save_tile`, and its own plan report prints
    tile counts with no bytes and no volume. A `--regions` file is operator-editable
    JSON, so enlarging it toward a polar cap or a global L10 would start writing and
    fill the disk mid-run -- and rule 4 would then honestly publish the partial tree.
    """
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path)
    monkeypatch.setattr(stream_bake, 'default_opener', open_)
    monkeypatch.setattr(stream_bake.bake, 'free_bytes_at', lambda p: 1)
    argv(monkeypatch, '--regions', str(cli_plan), '--out', str(out))
    assert stream_bake.main() == 2
    err = capsys.readouterr().err.lower()
    assert 'free' in err and 'gb' in err.replace(' ', '')
    assert not out.exists(), 'the disk guard ran after the writes'


def test_the_plan_reports_its_byte_estimate_and_the_volume_it_writes_to(
        tmp_path, monkeypatch, capsys, global_path):
    """Bytes, not just tiles: 7,106 tiles was a 195 MB run and a cap-shaped plan is
    gigabytes, and the only number that decides whether to press enter is the one
    that used to be missing."""
    plan_file = tmp_path / 'regions.json'
    plan_file.write_text(json.dumps({'schema': 1, 'regions': [
        region('wide', lo=1, hi=1)]}), encoding='utf-8')
    monkeypatch.setitem(regions.SOURCES, 'test-cog', source_table(PX0)['test-cog'])
    argv(monkeypatch, '--regions', str(plan_file), '--out', str(tmp_path / 'tiles'),
         '--dry-run')
    assert stream_bake.main() == 0
    printed = capsys.readouterr().out
    assert 'B est.' in printed and 'free' in printed, printed


def test_the_resolution_gate_refuses_a_level_the_source_cannot_pay_for():
    """L10 is 2912.71 px/deg -- `grid.px_per_deg(10)` is 512 * 2^11 / 360 =
    131072/45 = 2912.7111..., and the assertion below quotes it from `grid` rather
    than from this sentence. A 2500 px/deg source would have to invent 1.165x of
    every pixel, so the run is refused and the message names the level.
    """
    problems = stream_bake.check_plan(
        stream_bake.plan([region('x', lo=10, hi=10)], sources=source_table(2500.0)))
    assert len(problems) == 1
    assert 'L10' in problems[0] and 'upsampl' in problems[0]
    assert f'{grid.px_per_deg(10):.2f}' in problems[0]
    assert f'{grid.px_per_deg(10):.2f}' == '2912.71', \
        "grid.py's own L10 answer -- the brief quotes 2913.6 for this number, and " \
        'that figure is not what 512 * 2^11 / 360 is'


def test_l11_is_refused_by_name_even_though_the_label_is_4096():
    """The brief's own example: 4096.09 px/deg pays for L10 but not for L11."""
    problems = stream_bake.check_plan(
        stream_bake.plan([region('x', lo=10, hi=11)],
                         sources=source_table(4096.09)))
    assert problems and any('L11' in p for p in problems)
    assert not any('L10' in p for p in problems), 'L10 is real data, not a lie'


def test_l8_through_l10_are_all_admissible_from_4096():
    entries = stream_bake.plan([region('x', lo=8, hi=10)],
                               sources=source_table(4096.09))
    assert stream_bake.check_plan(entries) == []


# ---------------------------------------------------------------------------
# where the source's identity comes from
# ---------------------------------------------------------------------------

def test_the_module_hardcodes_no_url():
    text = Path(stream_bake.__file__).read_text(encoding='utf-8')
    assert 'amazonaws' not in text and '://' not in text


def test_the_source_record_is_the_one_in_regions_sources():
    entry = stream_bake.plan([region('a', source='kaguya-tc')])[0]
    assert entry['src'] is regions.SOURCES['kaguya-tc']
    assert entry['src']['pxPerDeg'] == regions.SOURCES['kaguya-tc']['pxPerDeg']


def test_the_url_that_gets_opened_is_the_one_in_regions_sources(global_path,
                                                               tmp_path,
                                                               monkeypatch):
    """A region citing kaguya-tc is read from the kaguya-tc URL -- whatever that
    record says, never a URL this module invented.

    The region has to cite `source='kaguya-tc'`: `region()`'s default is the test
    table's key, and this call deliberately passes no `sources=` at all so it reads
    the shipped `regions.SOURCES` -- a region citing 'test-cog' has no record there
    to have a URL at all, which is the case the unknown-source test owns.
    """
    real, seen, _ = opener_for(global_path)
    monkeypatch.setitem(regions.SOURCES, 'kaguya-tc',
                        {**regions.SOURCES['kaguya-tc'], 'pxPerDeg': PX0})

    def fake_open(url):
        assert url == regions.SOURCES['kaguya-tc']['url'], url
        return real(url)

    entries = stream_bake.plan([region('a', lo=1, hi=1, source='kaguya-tc')])
    written, failed = stream_bake.bake_all(entries, tmp_path / 'tiles',
                                          opener=fake_open, quality=100)
    assert failed == [] and written == 8
    assert seen == [regions.SOURCES['kaguya-tc']['url']]


def test_the_streamed_path_is_a_vsicurl_prefix_plus_the_source_url(monkeypatch):
    """The one thing this module adds to a URL is GDAL's streaming prefix."""
    opened = []
    monkeypatch.setattr(rasterio, 'open', lambda p, *a, **k: opened.append(p))
    stream_bake.default_opener(TEST_URL)
    assert opened == [stream_bake.VSICURL_PREFIX + TEST_URL]


# ---------------------------------------------------------------------------
# geometry: exactly the grid contract's
# ---------------------------------------------------------------------------

def test_the_fixture_pattern_survives_a_two_by_two_box_average(global_array):
    """Without this, the exact L0 assertion below would be luck.

    Widened to uint16 first, on purpose: the pattern's largest value is
    1 + 8*7 + 7 = 64, and a uint8 sum of four of them is 256, which is 0. The
    overflow lands exactly on the last column band and the last row band, so a
    uint8 version of this proof fails only in the corner -- the kind of bug that
    reads as "the fixture is wrong" and gets the fixture weakened instead.
    """
    g = global_array.astype(np.uint16)
    every_other = g[0::2, 0::2]
    avg = (g[0::2, 0::2] + g[0::2, 1::2] + g[1::2, 0::2] + g[1::2, 1::2]) / 4
    assert np.array_equal(every_other, np.rint(avg).astype(np.uint16))
    assert len(np.unique(global_array)) == 64, 'the pattern must stay identifiable'


def test_a_baked_tile_is_the_hand_computed_window_of_the_source(global_path,
                                                               global_array,
                                                               tmp_path):
    out = tmp_path / 'tiles'
    open_, seen, made = opener_for(global_path)
    written, failed = stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)),
                                          out, opener=open_, quality=100)
    assert failed == [] and written == 8, 'L1 is 4 columns x 2 rows'
    assert len(made[0].calls) == 1, 'eight tiles out of one bulk read, not eight'
    assert seen == [TEST_URL]
    for y in range(grid.level_rows(1)):
        for x in range(grid.level_cols(1)):
            got = np.array(Image.open(out / grid.tile_path('ortho', 1, x, y)))
            want = expected_tile(global_array, 1, x, y)
            assert np.array_equal(got, want), f'L1 tile ({x},{y}) is not its window'


def test_an_l0_tile_is_the_source_at_half_resolution(global_path, global_array,
                                                     tmp_path):
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path)
    written, failed = stream_bake.bake_all(plan_of(region('wide', lo=0, hi=0)),
                                          out, opener=open_, quality=100)
    assert failed == [] and written == 2
    for x in range(grid.level_cols(0)):
        got = np.array(Image.open(out / grid.tile_path('ortho', 0, x, 0)))
        assert np.array_equal(got, expected_tile(global_array, 0, x, 0))


def test_row_zero_is_the_north(global_path, tmp_path):
    """An inverted y-origin still bakes a plausible moon, so this names the values.

    Row bands are 128 px of 1024, so L1 row 0 reads 1,2,3,4 down its first column
    and L1 row 1 reads 5,6,7,8. A flip swaps them; a fixture whose rows all read
    the same would not notice.
    """
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), out, opener=open_,
                        quality=100)
    north = np.array(Image.open(out / 'ortho' / '1' / '0' / '0.jpg'))
    south = np.array(Image.open(out / 'ortho' / '1' / '0' / '1.jpg'))
    assert [int(north[r, 0]) for r in (0, 128, 256, 384)] == [1, 2, 3, 4]
    assert [int(south[r, 0]) for r in (0, 128, 256, 384)] == [5, 6, 7, 8]


def test_the_written_tile_is_grayscale_at_the_contract_path(global_path, tmp_path):
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), out, opener=open_,
                        quality=100)
    p = out / grid.tile_path('ortho', 1, 2, 1)
    assert p.exists()
    assert Image.open(p).mode == 'L', 'a shaded gray source bakes gray tiles'


def test_the_source_rectangle_is_the_transform_answer(crop_path, tmp_path):
    """Hand-computed from the fixture's own georeference (west 23.0, north 0.7,
    3000 px/deg) and the L10 grid (2048 x 1024 tiles of 360/2048 = 0.17578125 deg):

      lon_to_tile_x(23.1, 10) = floor(203.1 * 2048/360) = floor(1155.4133) = 1155
      lon_to_tile_x(23.4, 10) = floor(203.4 * 2048/360) = floor(1157.1200) = 1157
      lat_to_tile_y(0.5, 10)  = floor( 89.5 * 1024/180) = floor( 509.1556) = 509
      lat_to_tile_y(0.2, 10)  = floor( 89.8 * 1024/180) = floor( 510.8578) = 510

    so the box costs 3 columns x 2 rows = 6 tiles, and the tile rectangle they
    cover runs from column 1155's west edge -180 + 1155 * 0.17578125 =
    23.02734375 to column 1157's east edge -180 + 1158 * 0.17578125 = 23.5546875,
    and from row 509's north edge 90 - 509 * 0.17578125 = 0.52734375 down to row
    510's south edge 90 - 511 * 0.17578125 = 0.17578125. In the fixture's pixels:

      col_off = (23.02734375 - 23.0) * 3000 =  82.03125
      row_off = (0.7 - 0.52734375)   * 3000 = 517.96875
      width   =  3 * 0.17578125 deg  * 3000 = 1582.03125
      height  =  2 * 0.17578125 deg  * 3000 = 1054.6875

    One chunk of 2 tile rows therefore reads 1582.03125 x 1054.6875 source px into
    a 1024 x 1536 buffer. The fractions are kept because the source grid does not
    divide the level grid: snapping them would slide every tile by up to a source
    pixel, which at L10 is most of a pixel.
    """
    out = tmp_path / 'tiles'
    entries = stream_bake.plan([region('site', box=SITE_BOX, lo=10, hi=10)],
                              sources=source_table(3000.0))
    assert entries[0]['perLevel'][10] == [[1155, 1157, 509, 510]]
    assert entries[0]['tiles'] == 6, '3 columns x 2 rows, not 2 x 2'
    open_, _, made = opener_for(crop_path)
    written, failed = stream_bake.bake_all(entries, out, opener=open_, quality=100)
    assert failed == [] and written == 6
    call = made[0].calls[0]
    w = call['window']
    assert (w.col_off, w.row_off) == pytest.approx((82.03125, 517.96875))
    assert (w.width, w.height) == pytest.approx((1582.03125, 1054.6875))
    assert call['out_shape'] == (1024, 1536)
    assert call['resampling'] is Resampling.average
    assert call['indexes'] == 1, 'one band in'
    oracle = rasterio.open(crop_path).read(
        1, window=Window(82.03125, 517.96875, 1582.03125, 1054.6875),
        out_shape=(1024, 1536), resampling=Resampling.average)
    for x, y in [(1155, 509), (1156, 509), (1157, 509),
                 (1155, 510), (1156, 510), (1157, 510)]:
        got = np.array(Image.open(out / grid.tile_path('ortho', 10, x, y)))
        block = oracle[(y - 509) * 512:(y - 508) * 512,
                       (x - 1155) * 512:(x - 1154) * 512]
        # The only thing between a tile and its window is one JPEG encode at
        # quality 100, measured here at max 1. A wrong window is not inside that
        # margin: the fixture pattern steps by 8 across a column band, and one
        # column of L10 is 248.6 buffer px, so a slid read moves values by 8.
        assert np.abs(got.astype(np.int16) - block.astype(np.int16)).max() <= 2, \
            f'L10 tile ({x},{y}) is not the window the contract asks for'


def test_chunks_are_bounded_in_source_rows_and_cover_the_box_exactly(crop_path,
                                                                    tmp_path):
    """Row chunks: whole tile rows, bounded height, contiguous, no gap, no overlap.

    One L10 tile row is 512 level px, which is 512 / px_per_deg(10) degrees, and the
    fixture is 3000 px/deg, so in source rows it is

      512 * 3000 / 2912.711...  =  512 * 3000 * 360 / (512 * 2048)
                               =  16875 / 32        =  527.34375   exactly

    (px_per_deg(10) = 512 * 2^11 / 360 = 131072/45). The budget asked here is 512
    source rows, which a single tile row already exceeds, so the floor applies: one
    tile row per chunk, and the box's 2 tile rows become 2 chunks of 527.34375 rows
    -- not 4 half rows, because a tile that straddles two reads cannot be assembled.
    """
    out = tmp_path / 'tiles'
    entries = stream_bake.plan([region('site', box=SITE_BOX, lo=10, hi=10)],
                              sources=source_table(3000.0))
    open_, _, made = opener_for(crop_path)
    written, failed = stream_bake.bake_all(entries, out, opener=open_, quality=100,
                                          chunk_source_rows=512)
    assert failed == [] and written == 6
    calls = made[0].calls
    assert len(calls) == 2, '2 tile rows, one per chunk'
    h = 527.34375                       # 512 level px at 1.0299682 src px each
    budget = 512
    assert calls[0]['window'].row_off == pytest.approx(517.96875)
    assert calls[1]['window'].row_off == pytest.approx(517.96875 + h)
    assert [c['window'].height for c in calls] == [pytest.approx(h)] * 2
    assert sum(c['window'].height for c in calls) == pytest.approx(1054.6875)
    # the invariant a row-chunked reader actually owes: every chunk is a whole
    # number of tile rows, and no chunk is taller than the budget unless one tile
    # row alone already is (then that row is the floor, once, not split).
    for c in calls:
        assert c['out_shape'][0] % grid.TILE == 0, 'whole tile rows only'
        assert c['window'].height <= max(budget, h) + 1e-9, 'budget, floored at 1 row'
    assert all(c['out_shape'] == (512, 1536) for c in calls), '3 columns wide'
    assert all(c['window'].col_off == pytest.approx(82.03125) for c in calls)
    # contiguity read off the source rather than off the arithmetic above: the two
    # recorded windows, stacked, must equal the one-shot read of the whole contract
    # rectangle. A gap or an overlap shifts a row of tiles by a whole tile row.
    with rasterio.open(crop_path) as ds:
        whole = ds.read(1, window=Window(82.03125, 517.96875, 1582.03125, 1054.6875),
                        out_shape=(1024, 1536), resampling=Resampling.average)
        stacked = np.vstack([ds.read(1, window=c['window'], out_shape=c['out_shape'],
                                    resampling=Resampling.average) for c in calls])
        assert np.array_equal(stacked, whole), 'chunks overlap or leave a gap'


def test_an_antimeridian_box_is_read_as_two_source_rectangles(global_path,
                                                            global_array,
                                                            tmp_path):
    """west > east is the seam convention. Both halves must land in the correct
    columns at both edges, proved against a pattern that depends on longitude."""
    out = tmp_path / 'tiles'
    entries = plan_of(region('seam', box=[170.0, -45.0, -170.0, 45.0], lo=1, hi=1))
    assert entries[0]['perLevel'][1] == [[3, 3, 0, 1], [0, 0, 0, 1]]
    open_, _, made = opener_for(global_path)
    written, failed = stream_bake.bake_all(entries, out, opener=open_, quality=100)
    assert failed == [] and written == 4
    rects = {(c['window'].col_off, c['window'].width) for c in made[0].calls}
    assert rects == {(1536.0, 512.0), (0.0, 512.0)}, 'two rects, one per half'
    for y in (0, 1):
        for x in (0, 3):
            got = np.array(Image.open(out / grid.tile_path('ortho', 1, x, y)))
            assert np.array_equal(got, expected_tile(global_array, 1, x, y)), \
                f'seam tile ({x},{y}) holds the wrong half of the world'
    for x in (1, 2):
        assert not (out / 'ortho' / '1' / str(x)).exists(), 'no filler columns'


# ---------------------------------------------------------------------------
# failure handling: bounded retry, loud failure, no half-written tiles
# ---------------------------------------------------------------------------

def test_a_flake_that_clears_still_bakes_the_whole_region(global_path, tmp_path):
    out = tmp_path / 'tiles'
    sleeps = []
    open_, _, made = opener_for(global_path, fail_first=1)
    written, failed = stream_bake.bake_all(
        plan_of(region('wide', lo=1, hi=1)), out, opener=open_, quality=100,
        chunk_source_rows=512, sleep=sleeps.append)
    assert failed == [] and written == 8
    assert [c['window'].height for c in made[0].calls] == [512, 512, 512]
    assert sleeps == [stream_bake.BACKOFF_SECONDS], 'one failure, one backoff'


def test_a_read_that_never_clears_fails_that_region_only(global_path, tmp_path):
    """Two regions share one source; the poisoned one is reported, the healthy one
    finishes, and the run exits non-zero naming what failed."""
    out = tmp_path / 'tiles'
    entries = plan_of(region('east', box=(0.0, -50.0, 100.0, 50.0), lo=1, hi=1),
                      region('west', box=(-100.0, -50.0, 0.0, 50.0), lo=1, hi=1))
    open_, _, made = opener_for(global_path,
                                fail_when=lambda w: w.col_off >= 512.0)
    written, failed = stream_bake.bake_all(entries, out, opener=open_, quality=100,
                                          sleep=lambda s: None)
    assert [f['id'] for f in failed] == ['east']
    assert 'simulated /vsicurl stream reset' in failed[0]['error']
    assert written == 6, 'the healthy region baked all six of its tiles'
    poisoned = [c for c in made[0].calls if c['window'].col_off == 1024.0]
    assert len(poisoned) == stream_bake.ATTEMPTS, 'bounded, not infinite'
    assert len(list((out / 'ortho' / '1' / '0').glob('*.jpg'))) == 2


def test_a_non_oserror_rasterio_error_fails_its_region_and_not_the_run(global_path,
                                                                       tmp_path):
    """`WindowError` is a `rasterio.errors.RasterioError` and NOT an `OSError`.

    Requirement 6 is "report it and continue with the others". The region-level
    catch used to be `(OSError, ShortRead)`, so any rasterio error that is not an
    `OSError` -- a `WindowError`, an aborted terminal read -- escaped `bake_all`
    and killed the whole run with a traceback, the healthy regions unbaked. It is
    also not worth retrying: three attempts at a deterministic library error is
    three backoffs for the same answer, so `read_chunk` keeps its retry on
    `OSError` and this one is asked exactly once.
    """
    out = tmp_path / 'tiles'
    entries = plan_of(region('east', box=(0.0, -50.0, 100.0, 50.0), lo=1, hi=1),
                      region('west', box=(-100.0, -50.0, 0.0, 50.0), lo=1, hi=1))
    open_, _, made = opener_for(global_path,
                                fail_when=lambda w: w.col_off >= 512.0,
                                fail_exc=WindowError('simulated abort'))
    written, failed = stream_bake.bake_all(entries, out, opener=open_, quality=100,
                                          sleep=lambda s: None)
    assert [f['id'] for f in failed] == ['east']
    assert 'simulated abort' in failed[0]['error']
    assert written == 6, 'the healthy region baked all six of its tiles'
    assert len([c for c in made[0].calls
                if c['window'].col_off == 1024.0]) == 1, 'not retried'
    assert len(tile_names(out)) == 6


def test_a_partly_read_chunk_writes_no_tiles(global_path, tmp_path):
    """A short read is a failed read; the rows that did arrive are not tiles."""
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path, short_at=0)
    written, failed = stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), out,
                                          opener=open_, quality=100,
                                          chunk_source_rows=512,
                                          sleep=lambda s: None)
    assert failed and failed[0]['id'] == 'wide'
    assert written == 0, 'part of a chunk is not a tile'
    assert tile_names(out) == []


def test_the_gate_uses_the_file_s_own_transform_not_the_label(global_path, tmp_path):
    """4096.09 px/deg on the label, 5.69 in the raster. The label is a claim; the
    grid in the file is the fact, and the fact decides what may be baked."""
    out = tmp_path / 'tiles'
    entries = stream_bake.plan([region('wide', lo=8, hi=8)],
                              sources=source_table(4096.09))
    assert stream_bake.check_plan(entries) == [], 'the label alone looks fine'
    open_, _, _ = opener_for(global_path)
    with pytest.raises(stream_bake.Refusal) as raised:
        stream_bake.bake_all(entries, out, opener=open_, quality=100)
    assert 'L8' in str(raised.value)
    assert tile_names(out) == []


def test_a_box_the_source_does_not_cover_is_refused_before_it_is_read(crop_path,
                                                                      tmp_path):
    """The coverage guard, with an oracle that cannot share the failure it detects.

    An out-of-range window is not an error to GDAL. With the default
    `boundless=False` -- the one `read_chunk` uses -- rasterio crops the window to
    the dataset extent, allocates the *requested* `out_shape` from `np.empty` and
    warps the cropped pixels into it. Measured on this fixture: a window asking
    2191.4 of a 1800-column file answers `(1024, 2048)`, full size, values 5..69 of
    the real pattern, stretched. `arr.shape == out_shape` so `ShortRead` cannot
    fire, `save_tile` succeeds, the region reports success and `availability_from_disk`
    advertises the box. That is why this test's expectation is read from the file's
    *metadata* and `grid.py`, never from reading the same window -- an oracle built
    on that read gets the same plausible buffer and passes.

    Both boxes are themselves inside the file; the whole tiles needed to cover them
    are not. That is exactly the defect the handover named ("the fixture covers
    23.0-23.5 but the box needs 23.027-23.554") and, before the guard, no test in
    this file failed for either case.

      crop fixture: 1800 x 2100 px, origin (23.0, 0.7), 0.00033333333333333414
      deg/px, so it covers lon up to 23.6 and lat down to 0.0 exactly.
      east case  [23.1, 0.2, 23.6, 0.5] -> columns 1155..1158; column 1158's EAST
        edge is -180 + 1159 * 360/2048 = 23.73046875, 0.13 deg past the raster.
      south case [23.1, 0.0, 23.4, 0.5] -> rows 509..512; row 512's SOUTH edge is
        90 - 513 * 360/2048 = -0.17578125, a whole tile row past the raster.
    """
    out = tmp_path / 'tiles'
    with rasterio.open(crop_path) as ds:
        t = ds.transform
        covers_east = t.c + ds.width * t.a          # 23.6
        covers_south = t.f + ds.height * t.e        # 0.0

    for box, word in (([23.1, 0.2, 23.6, 0.5], 'column'),
                      ([23.1, 0.0, 23.4, 0.5], 'row')):
        west, south, east, north = box
        # The contract's own answer for the tiles that must cover the box edges.
        far_x = grid.lon_to_tile_x(east, 10)
        far_y = grid.lat_to_tile_y(south, 10)
        need_east = grid.tile_bounds(10, far_x, 0)[2]
        need_south = grid.tile_bounds(10, 0, far_y)[1]
        assert (need_east > covers_east) == (word == 'column'), \
            'one axis over the extent at a time, so the message names the right one'
        assert (need_south < covers_south) == (word == 'row'), \
            'and the fixture really is too small, not merely awkward'

        entries = stream_bake.plan([region('site', box=box, lo=10, hi=10)],
                                   sources=source_table(3000.0))
        assert entries[0]['perLevel'][10] == [[grid.lon_to_tile_x(west, 10), far_x,
                                              grid.lat_to_tile_y(north, 10), far_y]], \
            'the refusal has to be for the range the plan actually asked for'
        open_, _, made = opener_for(crop_path)
        with pytest.raises(stream_bake.Refusal) as raised:
            stream_bake.bake_all(entries, out, opener=open_, quality=100)
        msg = str(raised.value)
        assert word in msg, f'expected the {word} edge to be named, got: {msg}'
        assert 'site' in msg, 'a refusal has to say which region cannot be served'
        assert made[0].calls == [], 'refused before a single byte was requested'
        assert tile_names(out) == [], 'an under-covering box writes no tiles'


def test_a_metre_scaled_source_is_refused_as_not_in_degrees(tmp_path):
    """A projected file whose pixel size looks fine passes every other gate.

    This path turns degrees into pixels with `1 / t.a`, so the units of the
    georeference are what make that number mean anything. Here is the file that is
    genuinely dangerous rather than merely silly: a UTM strip (origin easting
    500000.0, northing 5100000.28 -- metres, four orders outside any lon/lat) whose
    pixel size was written as one arc-second, 0.0002777778, on each axis. Read as
    degrees,

      1 / 0.0002777778 = 3599.9997 "px/deg"  >  px_per_deg(10) = 2912.71

    so the resolution gate *passes* it at L8, L9 and L10, and so does the label.
    Without the units check the run reaches the read stage on such a file (proved by
    disabling the guard: `Stub.read` is what raises, not a refusal). The check is on
    the origin rather than on `ds.crs.is_geographic` because this module's maths
    never reads the CRS -- the extents are the fact, the metadata spelling is not.
    """
    out = tmp_path / 'tiles'
    projected = from_bounds(500_000.0, 5_100_000.0, 500_000.2777778,
                            5_100_000.2777778, 1000, 1000)
    stub = Stub(count=1, dtype='uint8', transform=projected)
    assert min(1.0 / projected.a, -1.0 / projected.e) > grid.px_per_deg(10), \
        'the scale alone looks deep enough to pay for L10'
    entries = stream_bake.plan([region('x', lo=8, hi=10)],
                              sources=source_table(4096.09))
    assert stream_bake.check_plan(entries) == [], 'the label looks fine too'
    with pytest.raises(stream_bake.Refusal) as raised:
        stream_bake.bake_all(entries, out, opener=lambda u: stub)
    assert 'not in degrees' in str(raised.value)
    assert tile_names(out) == []


def test_main_reports_a_coarse_file_as_a_refusal_and_writes_nothing(global_path,
                                                                   tmp_path,
                                                                   monkeypatch,
                                                                   capsys):
    out = tmp_path / 'tiles'
    plan_file = tmp_path / 'regions.json'
    plan_file.write_text(json.dumps({'schema': 1, 'regions': [
        region('wide', lo=8, hi=8)]}), encoding='utf-8')
    monkeypatch.setitem(regions.SOURCES, 'test-cog',
                        {**source_table(4096.09)['test-cog']})
    open_, _, _ = opener_for(global_path)
    monkeypatch.setattr(stream_bake, 'default_opener', open_)
    argv(monkeypatch, '--regions', str(plan_file), '--out', str(out), '--layer',
         'ortho')
    assert stream_bake.main() == 2
    assert 'L8' in capsys.readouterr().err
    assert not out.exists(), 'refused after creating the output tree'


def test_a_source_that_is_not_single_band_uint8_is_refused(tmp_path):
    """Kaguya TC is one band of uint8 and this layer is one band in, one band out.
    Anything else means the URL changed under us; quietly baking band 1 of a colour
    cube into a grayscale layer is exactly the lie the plan bans."""
    entries = stream_bake.plan([region('x', lo=10, hi=10)],
                              sources=source_table(4096.09))
    # tmp_path, not a relative literal: the guard is what stops this writing, and a
    # repo-relative 'never-written' would become a real tile tree in the cwd the
    # moment the guard regressed -- the same tree the live L7 bake owns.
    out = tmp_path / 'never-written'
    for stub, want in ((Stub(count=3), 'band'),
                       (Stub(count=1, dtype='uint16'), 'uint8')):
        with pytest.raises(stream_bake.Refusal) as raised:
            stream_bake.bake_all(entries, out, opener=lambda u: stub)
        assert want in str(raised.value)
    assert tile_names(out) == []


# ---------------------------------------------------------------------------
# availability comes from the disk, not from the plan
# ---------------------------------------------------------------------------

def test_availability_from_disk_agrees_with_the_plan_for_a_finished_box(
        global_path, tmp_path):
    out = tmp_path / 'tiles'
    regs = [region('wide', lo=0, hi=1)]
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(*regs), out, opener=open_, quality=100)
    avail = stream_bake.availability_from_disk(out, 'ortho', [0, 1])
    assert avail == {'0': [[0, 1, 0, 0]], '1': [[0, 3, 0, 1]]}
    assert manifest.validate_availability(avail, 1) == []
    # the plan for this box is the same shape -- but this answer came off disk
    assert json.dumps(avail) == json.dumps(regions.availability(regs))


def test_availability_shrinks_when_a_tile_is_missing(global_path, tmp_path):
    out = tmp_path / 'tiles'
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), out, opener=open_,
                        quality=100)
    (out / 'ortho' / '1' / '0' / '0.jpg').unlink()
    avail = stream_bake.availability_from_disk(out, 'ortho', [0, 1])
    assert avail['1'] == [[1, 3, 0, 0], [0, 3, 1, 1]], 'a hole splits the range'
    assert '0' not in avail, 'a level with no tiles is not listed'
    assert manifest.validate_availability(avail, 1) == []


def test_availability_merges_rows_that_share_a_span(global_path, tmp_path):
    """Two boxes side by side become one range; the two halves of a seam box stay
    two ranges, because the gap between them is real."""
    out = tmp_path / 'tiles'
    entries = plan_of(region('a', box=(-100.0, -50.0, -10.0, 50.0), lo=1, hi=1),
                      region('b', box=(-10.0, -50.0, 100.0, 50.0), lo=1, hi=1))
    open_, _, _ = opener_for(global_path)
    written, _ = stream_bake.bake_all(entries, out, opener=open_, quality=100)
    assert written == 8, 'the shared column is written once'
    assert stream_bake.availability_from_disk(out, 'ortho', [1]) == {
        '1': [[0, 3, 0, 1]]}
    seam = tmp_path / 'seam'
    open2, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('seam', box=[170.0, -45.0, -170.0, 45.0],
                                       lo=1, hi=1)), seam, opener=open2, quality=100)
    assert stream_bake.availability_from_disk(seam, 'ortho', [1]) == {
        '1': [[0, 0, 0, 1], [3, 3, 0, 1]]}


# ---------------------------------------------------------------------------
# the encoder, resume and --force come from bake.py
# ---------------------------------------------------------------------------

def test_resume_skips_and_force_rewrites(global_path, tmp_path):
    out = tmp_path / 'tiles'
    entries = plan_of(region('wide', lo=1, hi=1))
    open_, _, _ = opener_for(global_path)
    assert stream_bake.bake_all(entries, out, opener=open_, quality=100)[0] == 8
    victim = out / 'ortho' / '1' / '0' / '0.jpg'
    victim.write_bytes(b'not-a-tile')
    assert stream_bake.bake_all(entries, out, opener=open_, quality=100)[0] == 0
    assert victim.read_bytes() == b'not-a-tile', 'a resume overwrote finished work'
    assert stream_bake.bake_all(entries, out, opener=open_, quality=100,
                               force=True)[0] == 8
    assert victim.read_bytes() != b'not-a-tile'


def test_the_quality_reaches_the_encoder(global_path, tmp_path, monkeypatch):
    seen = []
    real = bake.save_tile

    def spy(out_dir, layer, L, x, y, arr, quality, force):
        seen.append((quality, arr.ndim))
        return real(out_dir, layer, L, x, y, arr, quality, force)

    monkeypatch.setattr(bake, 'save_tile', spy)
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), tmp_path / 'tiles',
                        opener=open_, quality=77)
    assert len(seen) == 8 and set(seen) == {(77, 2)}, \
        'the encoder is bake.save_tile, called with our quality, 2-D in'


# ---------------------------------------------------------------------------
# the CLI
# ---------------------------------------------------------------------------

@pytest.fixture
def cli_plan(tmp_path, monkeypatch, global_path):
    """A regions.json on tmp_path and an opener that answers the URL it cites."""
    monkeypatch.setitem(regions.SOURCES, 'test-cog', source_table(PX0)['test-cog'])
    plan_file = tmp_path / 'regions.json'
    plan_file.write_text(json.dumps({'schema': 1, 'regions': [
        region('wide', lo=1, hi=1),
        region('site', box=SITE_BOX, lo=1, hi=1)]}), encoding='utf-8')
    open_, _, _ = opener_for(global_path)
    monkeypatch.setattr(stream_bake, 'default_opener', open_)
    return plan_file


def test_dry_run_prints_the_plan_and_touches_nothing(tmp_path, monkeypatch, capsys,
                                                    cli_plan):
    out = tmp_path / 'tiles'

    def nope(url):
        raise AssertionError(f'--dry-run opened {url}')

    monkeypatch.setattr(stream_bake, 'default_opener', nope)
    argv(monkeypatch, '--regions', str(cli_plan), '--out', str(out), '--dry-run')
    assert stream_bake.main() == 0
    printed = capsys.readouterr().out
    assert 'wide' in printed and 'site' in printed
    assert 'total 9 tiles' in printed, 'the wide box is 8, the site box is 1'
    assert 'L1: 9' in printed
    assert 'layer=ortho' in printed
    assert 'dry run: nothing written' in printed
    assert not out.exists()


def test_only_bakes_one_region_and_its_help_says_why(tmp_path, monkeypatch, capsys,
                                                     cli_plan):
    out = tmp_path / 'tiles'
    argv(monkeypatch, '--regions', str(cli_plan), '--out', str(out), '--only',
         'site', '--quality', '100')
    assert stream_bake.main() == 0
    assert tile_names(out) == ['ortho/1/2/0.jpg']
    assert 'availab' in capsys.readouterr().out.lower()
    help_text = ' '.join(stream_bake.parser().format_help().split())
    assert '22-tile' in help_text and '7,132' in help_text, \
        '--only exists so the first real run is one small box, not the whole plan'


def test_a_run_bakes_every_region_and_reports_availability(tmp_path, monkeypatch,
                                                           capsys, cli_plan):
    """The plan costs 9 tiles; the tree holds 8 files. Both numbers are asserted.

    `cli_plan` is wide [0..3] x [0..1] at L1 (8 tiles) plus site = SITE_BOX at L1.
    The site's one L1 tile is (2, 0), because
      lon_to_tile_x(23.1, 1) = floor(203.1 * 4/360) = floor(2.2567) = 2
      lon_to_tile_x(23.4, 1) = floor(203.4 * 4/360) = floor(2.2600) = 2
      lat_to_tile_y(0.5, 1)  = floor( 89.5 * 2/180) = floor(0.9944) = 0
      lat_to_tile_y(0.2, 1)  = floor( 89.8 * 2/180) = floor(0.9978) = 0
    and (2, 0) is inside wide's set, so the two boxes are NOT disjoint.

    Chosen deliberately, and this is the distinction the test pins: the plan is
    counted per region (writes, and it says 9 -- a region's cost must not depend on
    what another region already did), while the tree is counted per file (8, because
    `bake.save_tile` skips a tile that exists). Making the boxes disjoint would
    collapse those two numbers into one and delete the thing worth proving.
    """
    out = tmp_path / 'tiles'
    argv(monkeypatch, '--regions', str(cli_plan), '--out', str(out))
    assert stream_bake.main() == 0
    printed = capsys.readouterr().out
    assert 'total 9 tiles' in printed, 'the plan is per region, not per file'
    assert len(tile_names(out)) == 8, 'two regions, one shared tile, eight files'
    assert 'wrote 8 tiles' in printed and '9 planned' in printed
    assert 'availability' in printed and 'L1' in printed
    assert 'manifest' in printed, 'a live bake owns the manifest; say so'
    assert not (out / 'manifest.json').exists()


def test_main_exits_nonzero_naming_every_failed_region(tmp_path, monkeypatch,
                                                      capsys, global_path):
    plan_file = tmp_path / 'regions.json'
    plan_file.write_text(json.dumps({'schema': 1, 'regions': [
        region('wide', lo=1, hi=1), region('site', box=SITE_BOX, lo=1, hi=1)]}),
        encoding='utf-8')
    monkeypatch.setitem(regions.SOURCES, 'test-cog', source_table(PX0)['test-cog'])
    open_, _, _ = opener_for(global_path, fail_first=10 ** 6)
    monkeypatch.setattr(stream_bake, 'default_opener', open_)
    monkeypatch.setattr(stream_bake, '_sleep', lambda s: None)
    argv(monkeypatch, '--regions', str(plan_file), '--out', str(tmp_path / 'tiles'))
    assert stream_bake.main() == 1
    err = capsys.readouterr().err
    assert 'wide' in err and 'site' in err
    assert tile_names(tmp_path / 'tiles') == []


def test_an_unknown_only_id_is_refused_with_the_list(tmp_path, monkeypatch, capsys,
                                                     cli_plan):
    argv(monkeypatch, '--regions', str(cli_plan), '--out', str(tmp_path / 'tiles'),
         '--only', 'no-such-region')
    assert stream_bake.main() == 2
    err = capsys.readouterr().err
    assert 'no-such-region' in err and 'wide' in err


def test_a_bad_plan_is_refused_before_anything_is_opened(tmp_path, monkeypatch,
                                                         capsys):
    plan_file = tmp_path / 'regions.json'
    plan_file.write_text(json.dumps({'schema': 1, 'regions': [
        region('cap', box=[-180.0, -90.0, 180.0, -84.0], lo=8, hi=9,
               source='nac-spole')]}), encoding='utf-8')

    def nope(url):
        raise AssertionError(f'a refused plan must not open {url}')

    monkeypatch.setattr(stream_bake, 'default_opener', nope)
    argv(monkeypatch, '--regions', str(plan_file), '--out', str(tmp_path / 'tiles'),
         '--dry-run')
    assert stream_bake.main() == 2
    err = capsys.readouterr().err
    assert 'L9' in err and 'nac-spole' in err
    assert not (tmp_path / 'tiles').exists()


# ---------------------------------------------------------------------------
# publish: merging the ortho record into the delivered manifest
#
# Everything here lives on tmp_path: a manifest hand-written by the test, an ortho
# tree baked from the injected fixture, and a regions file that deliberately does
# not exist so provenance is empty and no bake is implied. Nothing reads or writes
# the real public/tiles/.
# ---------------------------------------------------------------------------

def make_manifest(out):
    """A minimal delivered manifest: paper, photo and geometryProof, the three
    things the app boots on and the three a careless rewriter has dropped before."""
    manifest.write_manifest(Path(out) / 'manifest.json', {
        'schema': 1,
        'generatedAt': '2026-10-08T00:00:00+00:00',
        'grid': {'tileSize': 512, 'prjWkt': contract.MOON_WKT},
        'levels': [], 'sources': [], 'timings': {'bakeSeconds': 1.0},
        'layers': {'paper': {'top': 7, 'tiles': 43690, 'quality': 85},
                   'photo': {'top': 7, 'tiles': 43690, 'quality': 85}},
        'geometryProof': {'passed': True, 'level': 5, 'contrast': 48.0},
    })


def bake_wide_l1(out, global_path):
    """The 8-tile L1 wide box: L1 is the only level with tiles, so top == 1."""
    open_, _, _ = opener_for(global_path)
    stream_bake.bake_all(plan_of(region('wide', lo=1, hi=1)), out, opener=open_,
                         quality=100)


NO_REGIONS = 'a regions file that is not there, so publish derives no provenance'


def test_publishing_after_a_bake_writes_a_record_matching_the_files(
        global_path, tmp_path):
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    rec = stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    disk = stream_bake.availability_from_disk(out, 'ortho', [1])
    assert rec['availability'] == disk, 'the record promises exactly the files'
    assert rec['top'] == 1, 'top is the deepest level with tiles, off the disk'
    assert manifest.validate_availability(rec['availability'], rec['top']) == []
    written = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert written['layers']['ortho'] == rec


def test_publishing_after_a_deleted_tile_does_not_promise_it(global_path, tmp_path):
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    (out / 'ortho' / '1' / '0' / '0.jpg').unlink()
    rec = stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    # The record came off the disk after the deletion, so (0,0) is in no range.
    assert rec['availability'] == stream_bake.availability_from_disk(out, 'ortho',
                                                                     [1])
    assert not any(r[0] <= 0 <= r[1] and r[2] <= 0 <= r[3]
                   for r in rec['availability']['1']), 'a deleted tile is not a promise'


def test_publishing_carries_every_other_key_and_layer_intact(global_path, tmp_path):
    """Compare the untouched keys before and after, not merely that they exist.

    The historical defect this guards is bake.py silently dropping geometryProof on
    a manifest rewrite; a test that only asserted 'geometryProof' in manifest would
    still pass after the merge lost the paper record's tiles/quality fields.
    """
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    before = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    after = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert set(after) - set(before) == {'layers'} or 'ortho' in after['layers']
    for key in before:
        if key == 'layers':
            continue
        assert after[key] == before[key], f'publish changed top-level key {key!r}'
    for name in ('paper', 'photo'):
        assert after['layers'][name] == before['layers'][name], \
            f'publish changed the {name} record'
    assert after['geometryProof'] == before['geometryProof'], \
        'geometryProof dropped -- the exact defect this pins'


def test_an_empty_ortho_tree_refuses_and_leaves_the_manifest_untouched(tmp_path):
    out = tmp_path / 'tiles'
    make_manifest(out)
    raw = (out / 'manifest.json').read_bytes()
    with pytest.raises(stream_bake.PublishRefusal):
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert (out / 'manifest.json').read_bytes() == raw, 'a refused publish writes nothing'


def test_publish_writes_lf_only_with_a_single_trailing_newline(global_path, tmp_path):
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    data = (out / 'manifest.json').read_bytes()
    assert b'\r' not in data, 'the manifest is LF-only, whatever the platform'
    assert data.endswith(b'\n') and not data.endswith(b'\n\n'), \
        'exactly one trailing newline'


def test_publish_refuses_when_validate_availability_is_unhappy(global_path, tmp_path):
    """The validate gate is consulted, not decorative: feed it a real disk state
    it rejects (a level deeper than grid.MAX_TOP_LEVEL) and assert the refusal."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    stray = out / 'ortho' / str(grid.MAX_TOP_LEVEL + 1) / '0'
    stray.mkdir(parents=True)
    (stray / '0.jpg').write_bytes(b'\xff\xd8\xff\xd9')   # a jpeg at a level no bake wrote
    make_manifest(out)
    raw = (out / 'manifest.json').read_bytes()
    bad = stream_bake.availability_from_disk(out, 'ortho', [1, grid.MAX_TOP_LEVEL + 1])
    assert manifest.validate_availability(bad, grid.MAX_TOP_LEVEL + 1), \
        'the fed state is one validate rejects'
    with pytest.raises(stream_bake.PublishRefusal):
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert (out / 'manifest.json').read_bytes() == raw, 'a refused publish writes nothing'


def test_publish_cli_writes_and_dry_run_does_not(global_path, tmp_path, monkeypatch,
                                                 capsys):
    """--publish on its own publishes; --publish --dry-run only reports."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    argv(monkeypatch, '--out', str(out), '--regions', str(tmp_path / 'nope.json'),
         '--publish', '--dry-run')
    assert stream_bake.main() == 0
    printed = capsys.readouterr().out.lower()
    assert 'dry run' in printed
    assert 'ortho' not in json.loads(
        (out / 'manifest.json').read_text(encoding='utf-8'))['layers'], \
        '--publish --dry-run must not write'

    argv(monkeypatch, '--out', str(out), '--regions', str(tmp_path / 'nope.json'),
         '--publish')
    assert stream_bake.main() == 0
    rec = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))['layers']['ortho']
    assert rec['top'] == 1


def test_republishing_updates_the_record_in_place(global_path, tmp_path):
    """A second --publish over an already-published layer must not trip the
    guard that protects the *other* layers: `ortho` is the record being rewritten,
    so it is exempt, while `paper`/`photo` still have to survive untouched."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    before = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    first = stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    (out / 'ortho' / '1' / '0' / '0.jpg').unlink()   # a tile goes missing between runs
    second = stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert second['tiles'] == first['tiles'] - 1
    after = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert after['layers']['ortho'] == second
    for name in ('paper', 'photo'):
        assert after['layers'][name] == before['layers'][name], \
            f'republishing disturbed the {name} layer'
    assert after['geometryProof'] == before['geometryProof']


def test_publish_refuses_a_manifest_that_would_lose_the_base_layers(
        global_path, tmp_path):
    """A delivered manifest missing a base layer is not something to merge into:
    writing would ship a manifest the app refuses to boot."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    manifest.write_manifest(out / 'manifest.json', {
        'schema': 1, 'generatedAt': 'x', 'grid': {}, 'levels': [], 'sources': [],
        'layers': {'paper': {'top': 7}},   # no photo, no geometryProof
    })
    with pytest.raises(stream_bake.PublishRefusal):
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')


# ---------------------------------------------------------------------------
# the geometryProof guards: a presence check before the merge, a re-read after it
#
# Both of the merge's original loops compared `merged` / `layers` against the very
# dicts they were copied from (`merged = dict(prev)`), so no input could fire them
# and `geometryProof` was never named in a check. These tests are what makes the
# guard real: each fails if its half of the guard is missing.
# ---------------------------------------------------------------------------

def strip_manifest_keys(out, *keys):
    """`make_manifest(out)` with `keys` removed, rewritten through the real writer.

    Returns the bytes now on disk so a refusal can be proven to have written
    nothing.
    """
    make_manifest(out)
    data = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    for key in keys:
        del data[key]
    manifest.write_manifest(out / 'manifest.json', data)
    return (out / 'manifest.json').read_bytes()


def corrupt_writer(mutate):
    """A stand-in for `manifest.write_manifest` that writes `mutate(bytes)`.

    It is the only way to test the post-write guard without editing a forbidden
    file: the guard has to catch what actually landed on disk, and
    `write_manifest` truncates the file before rewriting it (`manifest.py:87`),
    so a half write is a real state a publish can be left holding.
    """
    def write_(path, data):
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(mutate((json.dumps(data, indent=1) + '\n').encode('utf-8')))
        return p
    return write_


def test_publish_refuses_a_manifest_with_no_geometry_proof(global_path, tmp_path):
    """Pre-merge guard: a manifest with `paper` + `photo` and no `geometryProof` is
    not something to merge into, because the file that ships afterwards would be
    the one without the proof.

    Without the guard this publishes happily -- that is the hole the review proved
    (`test_publish_refuses_a_manifest_that_would_lose_the_base_layers` only fired
    because `photo` was missing too).
    """
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    raw = strip_manifest_keys(out, 'geometryProof')
    with pytest.raises(stream_bake.PublishRefusal) as exc:
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert 'geometryProof' in str(exc.value), 'the refusal must name what it guards'
    assert (out / 'manifest.json').read_bytes() == raw, \
        'the guard is pre-merge: a refusal writes nothing'


def test_publish_refuses_when_the_written_manifest_lost_geometry_proof(
        global_path, tmp_path, monkeypatch):
    """Post-write guard: re-read the file and compare every key that was not ours
    against what we read before merging.

    The writer here is a stand-in that loses `geometryProof` after a correct merge,
    which is exactly the `bake.py` defect this brief forbids repeating -- and the
    in-memory comparison the old code made could never see it.
    """
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)

    def drop_proof(data):
        m = json.loads(data.decode('utf-8'))
        del m['geometryProof']
        return (json.dumps(m, indent=1) + '\n').encode('utf-8')

    monkeypatch.setattr(manifest, 'write_manifest', corrupt_writer(drop_proof))
    with pytest.raises(stream_bake.PublishRefusal) as exc:
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert 'geometryProof' in str(exc.value)


def test_publish_refuses_when_the_manifest_written_is_truncated(
        global_path, tmp_path, monkeypatch):
    """The same re-read catches a write that did not finish: the file on disk is not
    even parseable, and a publish that returns 0 while leaving that behind is worse
    than a refusal."""
    out = tmp_path / 'tiles'
    bake_wide_l1(out, global_path)
    make_manifest(out)
    monkeypatch.setattr(manifest, 'write_manifest',
                        corrupt_writer(lambda data: data[:len(data) // 2]))
    with pytest.raises(stream_bake.PublishRefusal) as exc:
        stream_bake.publish(out, 'ortho', regions_file=tmp_path / 'nope.json')
    assert 'manifest' in str(exc.value).lower()


# ---------------------------------------------------------------------------
# provenance, tested against a real regions fixture
#
# The publish tests above deliberately pass a nonexistent regions file, so
# `_region_provenance` always returned `(None, [])` there and the 30 lines that
# decide which regions a published record names were unexercised. These two use a
# fixture file and a hand-built tile tree at L2, where the box -> tile arithmetic is
# checkable in your head (8 columns x 4 rows, 45 deg a side):
#
#   alpha  box [-130,   5, -100,  40] -> tile (1, 1)
#   zulu   box [-130,   5, -100,  80] -> tiles (1, 0), (1, 1)
#   beta   box [  10, -40,   60, -20] -> tiles (4, 2), (5, 2)
#   cap    box [ 100, -40,  120, -20] -> tile  (6, 2)   -- never written
# ---------------------------------------------------------------------------

def write_tile_tree(out, layer, coords):
    """`<out>/<layer>/<L>/<x>/<y>.jpg` for each (L, x, y): a tree with no bake.

    Provenance reads the tree's shape and nothing else, so naming the exact tiles on
    disk here is stronger than inheriting a bake's geometry.
    """
    for L, x, y in coords:
        d = Path(out) / layer / str(L) / str(x)
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{y}.jpg').write_bytes(b'\xff\xd8\xff\xd9')


def provenance_regions_file(tmp_path, source_by_id=None):
    """The four-region fixture above as a regions.json, `source` per region."""
    boxes = {'alpha': [-130.0, 5.0, -100.0, 40.0],
             'zulu': [-130.0, 5.0, -100.0, 80.0],
             'beta': [10.0, -40.0, 60.0, -20.0],
             'south-polar-cap': [100.0, -40.0, 120.0, -20.0]}
    regs = [{'id': rid, 'name': rid, 'kind': 'polar-cap' if rid.endswith('cap')
             else 'feature', 'box': box, 'minLevel': 2, 'maxLevel': 2,
             'source': (source_by_id or {}).get(rid, 'test-cog')}
            for rid, box in boxes.items()]
    path = tmp_path / 'regions.json'
    path.write_text(json.dumps({'schema': 1, 'regions': regs}), encoding='utf-8')
    return path


def test_region_provenance_names_only_regions_with_a_tile_on_disk(tmp_path):
    out = tmp_path / 'tiles'
    write_tile_tree(out, 'ortho', [(2, 1, 1), (2, 4, 2)])
    rf = provenance_regions_file(tmp_path, {'south-polar-cap': 'nac-spole'})

    source, ids = stream_bake._region_provenance(out, 'ortho', rf)
    assert ids == ['alpha', 'beta', 'zulu'], (
        'zulu shares alpha\'s tile and beta counts one of its two, so three regions '
        'are named; the cap has no tile on disk and is not advertised')
    assert 'south-polar-cap' not in ids, 'the exclusion the record rests on'
    assert source == 'test-cog', (
        'one source across the published set is one key -- and the excluded cap\'s '
        'own source is not among the keys, which is what a stale record would leak')

    # The omitted region is omitted because nothing was written for it, not because
    # provenance lost the ability to see it: one tile in its rectangle and it is named.
    write_tile_tree(out, 'ortho', [(2, 6, 2)])
    second_source, ids_after = stream_bake._region_provenance(out, 'ortho', rf)
    assert ids_after == ['alpha', 'beta', 'south-polar-cap', 'zulu']
    assert second_source == ['test-cog', 'nac-spole'], \
        'two published sources is a list in file order, not one of them picked'


def test_publishing_records_the_regions_that_have_tiles_on_disk(tmp_path):
    """The fixture provenance reaches the record `publish` merges, not just the
    helper that computes it."""
    out = tmp_path / 'tiles'
    write_tile_tree(out, 'ortho', [(2, 1, 1), (2, 4, 2)])
    make_manifest(out)
    rec = stream_bake.publish(out, 'ortho',
                              regions_file=provenance_regions_file(tmp_path))
    assert rec['regions'] == ['alpha', 'beta', 'zulu']
    assert rec['source'] == 'test-cog'
    assert rec['tiles'] == 2 and rec['bytes'] > 0
    written = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert written['layers']['ortho']['regions'] == ['alpha', 'beta', 'zulu']
    assert written['geometryProof'], 'the fixture manifest kept its proof'
