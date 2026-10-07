"""Gate G2 tests: the lookup index math, and the gate's falsifiability.

Two fixture pyramids are used. `indexed_pyramid` fills every L1 tile with a
distinct constant (10*x + y) so a lookup error shows up as the wrong number
rather than as noise. `synthetic_globe` builds an L4 pyramid whose tile values
stand for mare (dark), ray-crater (bright) and non-marker terrain (mid), and
then rebuilds it mirrored in latitude and rotated 180 deg in longitude, so the
gate is shown to PASS on registered imagery and to FAIL on the two geometry
errors it claims to detect.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid
import proof
from labels import bbox_contains

REPO = Path(__file__).resolve().parents[2]
SHIPPED_LABELS = REPO / 'public' / 'data' / 'features.json'

# Synthetic-globe fixture constants. L4 is the coarsest level at which no tile
# is claimed by both a mare and a highland marker, which is what makes the
# registered case pass and the mis-registered cases fail (asserted below).
GLOBE_LEVEL = 4
MARE_DN, HIGH_DN, OTHER_DN = 30, 200, 120


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


def _markers_fc():
    """The shipped label set filtered to the gate's own inputs, so the synthetic
    globe is tested against real gazetteer coordinates."""
    fc = json.loads(SHIPPED_LABELS.read_text(encoding='utf-8'))
    want = set(proof.MARE_CENTRES) | set(proof.HIGHLAND_CENTRES) | {'Mare Tranquillitatis'}
    feats = [f for f in fc['features']
             if f['properties']['name'] in want
             or (f['properties'].get('mission') or '') == 'Apollo 11']
    return {'type': 'FeatureCollection', 'features': feats}


def _tile_of(lon, lat, L):
    return (grid.lon_to_tile_x(lon, L), grid.lat_to_tile_y(lat, L))


def _globe_values(L):
    """tile -> DN for a *correctly registered* synthetic Moon."""
    feats = _markers_fc()['features']
    by_name = {f['properties']['name']: f for f in feats}
    mare = {_tile_of(*by_name[n]['geometry']['coordinates'], L) for n in proof.MARE_CENTRES}
    high = {_tile_of(*by_name[n]['geometry']['coordinates'], L) for n in proof.HIGHLAND_CENTRES}
    a11 = sorted(f['properties']['name'] for f in feats
                 if (f['properties'].get('mission') or '') == 'Apollo 11')
    a11_tiles = {_tile_of(*by_name[n]['geometry']['coordinates'], L) for n in a11}
    # The premise of the registered globe is that it agrees with the labels: the
    # Apollo 11 points sit inside the Tranquillitatis bbox, so their terrain is
    # mare and they read dark. They are merged into the dark set rather than
    # assumed to share a tile with a mare centroid.
    assert not (mare & high), 'mare and highland markers share tiles at this level'
    assert not (a11_tiles & high), 'an Apollo 11 point falls on a highland tile'
    dark = mare | a11_tiles
    values = {}
    for x in range(grid.level_cols(L)):
        for y in range(grid.level_rows(L)):
            values[(x, y)] = MARE_DN if (x, y) in dark else \
                HIGH_DN if (x, y) in high else OTHER_DN
    return values, a11


def _write_globe(root, L, values):
    for (x, y), v in values.items():
        d = Path(root) / 'paper' / str(L) / str(x)
        d.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.full((grid.TILE, grid.TILE), v, np.uint8)) \
            .save(d / f'{y}.jpg', quality=90)


def _globe(tmp_path, transform):
    """Build an L4 pyramid and its label file; `transform` mis-registers the
    imagery the way the two geometry errors do."""
    L = GLOBE_LEVEL
    truth, a11 = _globe_values(L)
    cols, rows = grid.level_cols(L), grid.level_rows(L)
    if transform == 'identity':
        moved = dict(truth)
    elif transform == 'flip-y':
        # row 0 must be north; mirroring puts the northern maria in the south.
        moved = {(x, y): truth[(x, rows - 1 - y)] for (x, y) in truth}
    elif transform == 'rot-180':
        half = cols // 2
        moved = {(x, y): truth[((x + half) % cols, y)] for (x, y) in truth}
    else:
        raise ValueError(transform)
    root = tmp_path / transform
    root.mkdir(parents=True)
    _write_globe(str(root), L, moved)
    fp = root / 'features.json'
    fp.write_text(json.dumps(_markers_fc()), encoding='utf-8')
    return str(root), str(fp), sorted(a11)


# ---------------------------------------------------------------- lookup math

def test_lookup_follows_the_documented_grid(indexed_pyramid):
    # L1 is 4 columns x 2 rows: x = floor((lon+180)/360*4), y = floor((90-lat)/180*2)
    # so the columns are [-180,-90) [-90,0) [0,90) [90,180) and row 0 is north.
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -170.0, 80.0) == 0
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -10.0, 80.0) == 10
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 10.0, 80.0) == 20
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 100.0, 80.0) == 30
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -170.0, -10.0) == 1
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 170.0, -10.0) == 31


def test_lookup_is_continuous_across_the_seam(indexed_pyramid):
    # +180 and -180 are the same meridian, so they must resolve to the same
    # pixel rather than to the east end and the west end of the world.
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 180.0, 80.0) == \
           proof.tile_pixel(indexed_pyramid, 'paper', 1, -180.0, 80.0)
    # Either side of the seam the two flanking tiles are the world's last and
    # first columns; a wrap that folds the wrong way swaps them.
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, -179.9, 80.0) == 0
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 179.9, 80.0) == 30


def test_lookup_clamps_the_poles(indexed_pyramid):
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 0.0, 90.0) == 20
    assert proof.tile_pixel(indexed_pyramid, 'paper', 1, 0.0, -90.0) == 21


def test_percentiles_come_from_the_requested_level(indexed_pyramid):
    h = proof.albedo_percentiles(indexed_pyramid, 'paper', 1)
    assert h['level'] == 1 and h['samples'] == 8 * grid.TILE * grid.TILE
    assert h['p33'] < h['p67']


def test_percentiles_are_the_measured_distribution(indexed_pyramid):
    # The 8 tiles are 0,1,10,11,20,21,30,31 in equal parts: mean 124/8 = 15.5
    # exactly, and the percentiles are real quantiles of that distribution.
    h = proof.albedo_percentiles(indexed_pyramid, 'paper', 1)
    assert h['mean'] == pytest.approx(15.5)
    assert h['p33'] == 10 and h['p67'] == 21


def test_missing_tile_is_an_error_not_a_zero(indexed_pyramid):
    with pytest.raises(FileNotFoundError):
        proof.tile_pixel(indexed_pyramid, 'paper', 4, 0.0, 0.0)


# ------------------------------------------------------------- the marker lists

def test_check_lists_are_long_enough_to_be_evidence():
    assert len(proof.MARE_CENTRES) >= 15
    assert len(proof.HIGHLAND_CENTRES) >= 15
    assert 'Mare Tranquillitatis' in proof.MARE_CENTRES
    assert 'Tycho' in proof.HIGHLAND_CENTRES


def test_gate_constants_are_the_planned_ones():
    # Lowering either of these to get a pass would gut the gate; pinning them
    # here means the change has to be a decision, not a fix.
    assert proof.MIN_CONTRAST_DN == 25.0
    assert proof.MIN_SAMPLES == 15
    assert proof.PROBE_LEVEL == 5


def test_every_marker_resolves_in_the_shipped_label_set():
    """A marker absent from features.json is a silent no-op that can never be
    looked up, so it is not evidence. Selection is by presence and class only."""
    feats = proof._by_name(str(SHIPPED_LABELS))
    missing = [n for n in proof.MARE_CENTRES + proof.HIGHLAND_CENTRES if n not in feats]
    assert missing == []


def test_marker_lists_are_class_pure():
    feats = proof._by_name(str(SHIPPED_LABELS))
    assert {feats[n]['properties']['code'] for n in proof.MARE_CENTRES} <= \
        proof.MARE_CODES
    assert all(feats[n]['properties']['code'] == 'AA' for n in proof.HIGHLAND_CENTRES)
    # Dark-floored craters are legitimately dark and must not pose as bright
    # markers; conversely nothing in the mare list is a crater.
    for dark in ('Plato', 'Grimaldi', 'Wargentin', 'Posidonius', 'Gassendi'):
        assert dark not in proof.HIGHLAND_CENTRES
        assert dark not in proof.MARE_CENTRES


def test_trannquillitatis_bbox_is_usable():
    feats = proof._by_name(str(SHIPPED_LABELS))
    bbox = feats['Mare Tranquillitatis']['properties']['bbox']
    assert bbox == [16.924, -4.051200000000001, 45.490300000000005, 19.3748]
    lon, lat = feats['Mare Tranquillitatis']['geometry']['coordinates']
    assert bbox_contains(bbox, lon, lat)


# ------------------------------------------------------------------- the gate

def test_gate_passes_on_correctly_registered_imagery(tmp_path):
    root, fp, _ = _globe(tmp_path, 'identity')
    res = proof.run_proof(root, fp, level=GLOBE_LEVEL)
    assert res['failures'] == [], res['failures']
    assert res['passed'] is True
    assert res['mareMedian'] == MARE_DN and res['highlandMedian'] == HIGH_DN
    assert res['highlandMedian'] - res['mareMedian'] >= proof.MIN_CONTRAST_DN
    assert res['mareMedian'] < res['histogram']['mean'] < res['highlandMedian']


@pytest.mark.parametrize('transform', ['flip-y', 'rot-180'])
def test_gate_detects_a_flipped_or_rotated_map(tmp_path, transform):
    root, fp, _ = _globe(tmp_path, transform)
    res = proof.run_proof(root, fp, level=GLOBE_LEVEL)
    assert res['passed'] is False
    assert any('not darker' in f or 'contrast' in f for f in res['failures']), \
        res['failures']


def test_gate_records_every_apollo_11_feature(tmp_path):
    root, fp, a11 = _globe(tmp_path, 'identity')
    res = proof.run_proof(root, fp, level=GLOBE_LEVEL)
    seen = [k.split(':', 1)[1] for k in res['checks'] if k.startswith('apollo11:')]
    assert sorted(seen) == a11


def test_run_proof_reports_failures_not_exceptions_on_synthetic_data(indexed_pyramid):
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [0.0, 0.0]},
         'properties': {'name': 'Mare Tranquillitatis', 'bbox': [-10, -10, 10, 10]}}]}
    fp = Path(indexed_pyramid) / 'features.json'
    fp.write_text(json.dumps(fc))
    res = proof.run_proof(indexed_pyramid, str(fp), level=1)
    assert res['passed'] is False
    assert any('Apollo 11' in f for f in res['failures'])


def test_apollo_containment_uses_the_wrap_aware_bbox(indexed_pyramid):
    """A west > east bbox crosses the antimeridian, so a point at 179.5E is
    INSIDE it. A naive `w <= lon <= e` would report the Apollo 11 feature as
    misplaced, so this pins that the proof calls labels.bbox_contains."""
    def feat(name, lon, lat):
        return {'type': 'Feature', 'geometry': {'type': 'Point',
                'coordinates': [lon, lat]},
                'properties': {'name': name, 'mission': 'Apollo 11'}}
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [180.0, 0.0]},
         'properties': {'name': 'Mare Tranquillitatis',
                        'bbox': [170.0, -5.0, -170.0, 5.0]}},
        feat('West', 179.5, 0.0),        # inside, across the seam
        feat('Double', -160.0, 0.0)]}    # outside: the box covers lon>=170 or lon<=-170
    fp = Path(indexed_pyramid) / 'features.json'
    fp.write_text(json.dumps(fc))
    res = proof.run_proof(indexed_pyramid, str(fp), level=1)
    outside = [f for f in res['failures'] if 'is outside' in f]
    assert len(outside) == 1, res['failures']
    assert 'Double' in outside[0]
    assert 'West' not in outside[0]


def test_run_proof_fails_on_too_few_samples(indexed_pyramid):
    """The 15-sample floor is checked before the medians are believed."""
    fc = {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [0.0, 0.0]},
         'properties': {'name': 'Mare Tranquillitatis', 'bbox': [-10, -10, 10, 10],
                        'code': 'ME', 'tier': 0, 'mission': 'Apollo 11'}}]}
    fp = Path(indexed_pyramid) / 'features.json'
    fp.write_text(json.dumps(fc))
    res = proof.run_proof(indexed_pyramid, str(fp), level=1)
    assert res['passed'] is False
    assert any('samples too small' in f and 'mare=1' in f and 'highland=0' in f
               for f in res['failures']), res['failures']
