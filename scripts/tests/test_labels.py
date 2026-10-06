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


def test_lon_wraps_to_signed_180(records):
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
    # This test names the crater-diameter FLOOR, so isolate it from the label
    # BUDGET: at min_crater_km=15 there are 1,584 candidates, so the default 600
    # budget prunes the smallest tier-2 entries -- including Shackleton (20.9 km).
    # An unbinding budget makes the assertion measure the floor, which is the point.
    names = lambda m: {r['name'] for r in labels.curate(records, m, budget=10_000)}
    assert 'Shackleton' not in names(70.0)
    assert 'Shackleton' in names(15.0)


def test_centre_is_inside_its_own_bbox_for_every_record(records):
    """spec 5.1 check 1, over all 9,087 records at the strict 1e-6 tolerance.

    The tolerance is NOT loosened. The shipped USGS nightly export stores the
    centre at coarser precision than the bbox, so 20/9,087 records miss a strict
    1e-6 containment: 19 by <0.03 deg (12 astronaut-named LF features that ARE
    curated, plus tiny non-curated ones; Brill records its bbox lon in +/-180
    while the centre is 0-360) and one genuine sign error, Statio Tianhe (centre
    -45.45 vs bbox +45.45, 90.9 deg). main()'s strict guard therefore returns
    nonzero on this file -- the guard working, not a code bug. We pin the exact
    offending set so any NEW geometry defect fails loudly, and the invariant
    holds for the other 9,067 records."""
    TOL = 1e-6
    KNOWN_DEFECTS = {
        'Mons Agnes', 'Jaci', 'Masina', 'Brill', 'Middle Crescent', 'Surveyor',
        'Flank', 'Bench', 'Block', 'Weird', 'Head', 'Halo', 'Little West',
        'Double', 'Statio Tianhe', 'Doublet', 'Nansen-Apollo', 'Lev', 'Ballet',
        'Statio Tianchuan',
    }

    def _wl(v):
        v = float(v) % 360.0
        return v - 360.0 if v > 180.0 else v

    def off_by(r):
        dlat = max(r['min_lat'] - r['center_lat'], r['center_lat'] - r['max_lat'], 0.0)
        a, b, c = _wl(r['min_lon']), _wl(r['max_lon']), _wl(r['center_lon'])
        dlon = max(a - c, c - b, 0.0) if a <= b else 0.0  # antimeridian bbox: treat as inside
        return max(dlat, dlon)

    def inside(r):
        lat_ok = r['min_lat'] - TOL <= r['center_lat'] <= r['max_lat'] + TOL
        lon_ok = (r['min_lon'] - TOL <= r['center_lon'] <= r['max_lon'] + TOL
                  or r['min_lon'] - 360.0 <= r['center_lon'] <= r['max_lon'] - 360.0)
        return lat_ok and lon_ok

    offenders = {r['name'] for r in records if not inside(r)}
    assert offenders == KNOWN_DEFECTS, offenders ^ KNOWN_DEFECTS
    # Pin the separation: every defect is sub-half-degree gazetteer rounding
    # EXCEPT Statio Tianhe, whose 90.9 deg centre is a genuine sign error.
    by_name = {r['name']: r for r in records}
    devs = {n: off_by(by_name[n]) for n in offenders}
    assert devs['Statio Tianhe'] > 45.0
    assert all(d < 0.5 for n, d in devs.items() if n != 'Statio Tianhe')


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
    # Chang Heng is a 42.7 km AA crater (named for a Chinese astronomer, not the
    # mission) -- below the default 70 km floor, so it is not curated at all. Its
    # tier is proven directly on the raw record: assign_tier never reaches the
    # tier-3 branch, which is exactly the "heuristic stays out" claim.
    chang = next(r for r in records if r['name'] == 'Chang Heng')
    assert labels.assign_tier(chang, 70.0) != 3
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
