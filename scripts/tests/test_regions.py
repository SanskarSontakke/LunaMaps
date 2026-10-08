"""Region geometry for the deep-zoom `ortho` layer (plan step 1).

Nothing here touches the network: a region is a box on the grid, and the point of
getting it right in Python first is that the *cost* of the deep bake is computable
before anyone spends a byte of bandwidth on it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid    # noqa: E402
import labels   # noqa: E402
import regions  # noqa: E402

FIX = 'tests/fixtures/moon_nomenclature_fixture.zip'


@pytest.fixture(scope='module')
def records():
    return labels.load_records(FIX)


# --- tile_ranges: hand-computed against the grid, not against the code --------

def test_a_one_degree_box_at_l10_is_seven_by_seven_tiles():
    # L10: 2048 x 1024 tiles, 360/2048 = 0.17578125 deg per tile.
    # x: floor((23+180)*2048/360) = 1154, floor((24+180)*2048/360) = 1160.
    # y: floor((90-1)*1024/180) = 506, floor((90-0)*1024/180) = 512.
    # A 1 deg box is 5.69 tiles wide, so 7 inclusive columns is right: it
    # includes the partially-covered tile at each edge.
    assert regions.tile_ranges([23.0, 0.0, 24.0, 1.0], 10) == [[1154, 1160, 506, 512]]


def test_the_same_box_at_l7_spans_two_tiles_each_way():
    # L7: 256 x 128 tiles of 1.40625 deg. A 1 deg box is 0.71 tiles wide, so it
    # straddles a column and a row boundary here: 2 x 2, not 1.
    # x: floor(203*256/360) = 144, floor(204*256/360) = 145
    # y: floor(89*128/180) = 63, floor(90*128/180) = 64
    assert regions.tile_ranges([23.0, 0.0, 24.0, 1.0], 7) == [[144, 145, 63, 64]]


def test_ranges_are_clamped_to_the_levels_own_grid():
    for L in range(8):
        cols, rows = grid.level_cols(L), grid.level_rows(L)
        for r in regions.tile_ranges([-180.0, -90.0, 180.0, 90.0], L):
            x0, x1, y0, y1 = r
            assert 0 <= x0 <= x1 <= cols - 1
            assert 0 <= y0 <= y1 <= rows - 1
    # and a box that overshoots the pole is not an error, just the whole column
    assert regions.tile_ranges([0.0, -95.0, 1.0, 95.0], 8)[0][2:] == [0, 255]


def test_an_antimeridian_box_yields_two_ranges_that_together_cover_the_seam():
    # straddles +/-180: the tile column containing 179.9 and the one containing
    # -179.9 are the two ends of the row, and neither range may wrap.
    box = [179.5, -0.5, -179.5, 0.5]      # west > east, 1 deg wide across the seam
    rs = regions.tile_ranges(box, 10)
    assert len(rs) == 2
    cols = grid.level_cols(10)
    spans = [(r[0], r[1]) for r in rs]
    assert all(x0 <= x1 for x0, x1 in spans)          # no inverted range
    # order is east-edge then west-edge; assert the pair, not the order
    assert sorted(spans) == [(0, regions._x(-179.5, cols)),
                             (regions._x(179.5, cols), cols - 1)]


def test_the_two_halves_of_a_non_crossing_box_are_never_split():
    assert len(regions.tile_ranges([10.0, 20.0, 11.0, 21.0], 9)) == 1


# --- merging keeps the manifest small ----------------------------------------

def test_adjacent_ranges_in_the_same_band_merge_into_one():
    merged = regions.merge([[10, 12, 5, 5], [13, 15, 5, 5]])
    assert merged == [[10, 15, 5, 5]]


def test_overlapping_ranges_merge_and_a_gap_does_not():
    assert regions.merge([[0, 5, 0, 0], [3, 9, 0, 0]]) == [[0, 9, 0, 0]]
    assert regions.merge([[0, 5, 0, 0], [7, 9, 0, 0]]) == [[0, 5, 0, 0], [7, 9, 0, 0]]


def test_different_y_bands_are_never_merged():
    m = regions.merge([[0, 3, 0, 0], [0, 3, 1, 1]])
    assert m == [[0, 3, 0, 0], [0, 3, 1, 1]]


def test_availability_merges_every_region_at_a_level():
    regs = [
        {'box': [23.0, 0.0, 24.0, 1.0], 'minLevel': 10, 'maxLevel': 10},
        {'box': [24.0, 0.0, 25.0, 1.0], 'minLevel': 10, 'maxLevel': 10},
    ]
    at10 = regions.availability(regs)['10']
    # two 1 deg boxes side by side share their boundary column, so the merged
    # set is smaller than the sum of the two -- which is the whole reason the
    # manifest carries ranges instead of tile lists.
    assert sum((x1 - x0 + 1) * (y1 - y0 + 1) for x0, x1, y0, y1 in at10) < 2 * 49


# --- the curated set: what actually ships ------------------------------------

def test_every_curated_region_is_well_formed_and_inside_the_grid(records):
    for r in regions.curated(records):
        w, s, e, n = regions.box_of(r)      # centre+size or an explicit box
        assert -180.0 <= w <= 180.0 and -180.0 <= e <= 180.0
        assert -90.0 <= s <= 90.0 and -90.0 <= n <= 90.0
        assert n > s, r['name']
        assert r['minLevel'] <= r['maxLevel'] <= grid.MAX_TOP_LEVEL
        assert r['minLevel'] >= 8, f"{r['name']}: L7 is already a global layer"
        assert r['source'] in regions.SOURCES


def test_region_ids_are_unique(records):
    ids = [r['id'] for r in regions.curated(records)]
    assert len(ids) == len(set(ids))


def test_the_deep_bake_cost_is_bounded_and_measured(records):
    """The plan's promise was ~15,500 tiles for ten 6 deg boxes. Assert the real
    number stays under the ceiling that makes the bake worth running at all, and
    report it rather than asserting a magic figure blindly."""
    total = sum(regions.tile_count(r) for r in regions.curated(records))
    assert total < 40_000, f'{total} tiles is a day of streaming, not a step'
    assert total > 1_000, 'a plan this small is not worth a new layer'


def test_landing_site_centres_agree_with_the_gazetteer_to_half_a_degree(records):
    """A curated site with a transposed sign bakes a beautiful 10 m/px tile of
    absolutely nothing, so each centre is checked against data the app already
    ships against: the median of that mission's astronaut-named traverse
    features.

    Median, not bounding box. Apollo 11 has four traverse features, one of them
    at lon 40.0 while the site is at 23.47, so "the box around all of them" is
    16 deg wide. That is why `derive` cannot own the landing sites and this test
    measures a centre rather than a spread.
    """
    kept = labels.curate(records)
    by_mission = {}
    for r in kept:
        if r['tier'] == 3 and labels.mission_of(r):
            by_mission.setdefault(labels.mission_of(r), []).append(
                (labels.wrap_lon(r['center_lon']), r['center_lat']))
    sites = [r for r in regions.curated(records) if r['kind'] == 'landing-site']
    assert len(sites) >= 6
    for site in sites:
        pts = by_mission.get(site['mission'])
        assert pts, f"no traverse features for {site['mission']}"
        med = regions.median_centre(pts)
        lon, lat = site['centre']
        assert abs(lon - med[0]) < 0.5 and abs(lat - med[1]) < 0.5, \
            f'{site["name"]}: declared {lon},{lat} vs gazetteer {med}'


def test_a_polar_features_bbox_span_is_not_a_region(records):
    """Shackleton is 20.9 km across and its gazetteer bbox reads 169 degrees of
    longitude, because every meridian meets at the pole. Deriving a deep-zoom box
    from that would bake a fifth of the hemisphere at L10, so `derive` falls back
    to the feature's own centre and diameter and records that it did."""
    got = regions.derive(records, ['Shackleton'], min_size_deg=1.0,
                         min_level=8, max_level=10)
    w, s, e, n = got[0]['box']
    assert e - w <= 2.0 and n - s <= 2.0, got[0]
    assert got[0]['derivedFrom'] == 'centre+size', got[0]['derivedFrom']


# --- derived geometry (D8) ---------------------------------------------------

def test_derived_regions_use_the_features_own_bbox_and_pad_to_the_floor(records):
    got = regions.derive(records, ['Mare Tranquillitatis'], min_size_deg=1.0,
                         min_level=8, max_level=10)
    assert len(got) == 1
    w, s, e, n = got[0]['box']
    assert e - w >= 1.0 and n - s >= 1.0
    assert got[0]['id'] == 'mare-tranquillitatis'


def test_derive_refuses_a_name_that_is_not_in_the_gazetteer(records):
    with pytest.raises(KeyError):
        regions.derive(records, ['Mare Aestuum'], min_size_deg=1.0,
                       min_level=8, max_level=10)


def test_a_derived_region_crossing_the_seam_keeps_the_documented_convention(records):
    """Von Karman straddles 0 deg and Plaskett/Rozhdestvenskiy sit on the +/-180
    seam; a derived box must not silently re-order them into an empty box."""
    seam = [r for r in labels.curate(records)
            if r['name'] in ('Plaskett', 'Rozhdestvenskiy', 'Von Kármán')
            and r.get('min_lon') is not None]
    assert seam, 'the fixture lost its seam-crossing features'
    for rec in seam:
        got = regions.derive(records, [rec['name']], min_size_deg=1.0,
                             min_level=8, max_level=10)
        w, _, e, _ = got[0]['box']
        # the derived box must keep the source's sense: a feature whose own bbox
        # crosses the seam must not be re-ordered into a 358-degree box
        crosses = (rec['min_lon'] or 0.0) > (rec['max_lon'] or 0.0)
        assert (w > e) == crosses, rec['name']


# --- the artifact ------------------------------------------------------------

def test_main_writes_a_manifest_shaped_regions_file(tmp_path, monkeypatch,
                                                 records):
    monkeypatch.setattr(regions, 'OUT', tmp_path / 'regions.json')
    assert regions.main() == 0
    data = json.loads((tmp_path / 'regions.json').read_text(encoding='utf-8'))
    assert data['schema'] == 1
    assert data['grid']['yOrigin'] == 'north'
    assert len(data['regions']) == len(regions.curated(records))
    assert data['availability']['8'], 'every level from min to max must be listed'
    for level, rng in data['availability'].items():
        assert int(level) <= grid.MAX_TOP_LEVEL
        for x0, x1, y0, y1 in rng:
            assert 0 <= x0 <= x1 <= grid.level_cols(int(level)) - 1
            assert 0 <= y0 <= y1 <= grid.level_rows(int(level)) - 1


# --- the manifest schema that carries availability ---------------------------

def test_validate_availability_accepts_the_generated_plan():
    import manifest
    plan = json.loads(Path('public/data/regions.json').read_text(encoding='utf-8'))
    top = max(int(k) for k in plan['availability'])
    assert manifest.validate_availability(plan['availability'], top) == []


def test_validate_availability_refuses_a_tile_outside_its_level_grid():
    import manifest
    # L8 is 512 x 256 tiles, so x=512 is one past the seam and y=-1 is above north
    assert manifest.validate_availability({'8': [[512, 513, 0, 1]]}, 8)
    assert manifest.validate_availability({'8': [[0, 1, -1, 1]]}, 8)
    assert manifest.validate_availability({'8': [[3, 1, 0, 0]]}, 8)      # inverted
    assert manifest.validate_availability({'9': [[0, 1, 0, 1]]}, 8)      # above top
    assert manifest.validate_availability({'8': []}, 8)                  # empty band
    assert manifest.validate_availability({'8': 'nope'}, 8)
    assert manifest.validate_availability({'x': [[0, 1, 0, 1]]}, 8)


def test_validate_availability_is_green_on_an_empty_plan():
    """A layer with no `availability` key is a global layer, which is the common
    case; the caller only validates a block it actually found."""
    import manifest
    assert manifest.validate_availability({}, 7) == []
