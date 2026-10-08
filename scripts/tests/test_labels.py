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
    assert by['Kepler']['tier'] == 1              # 29 km, survives every cut
    # D9 lowered the shipped crater floor to 15 km, so Shackleton (20.9 km, the
    # south-pole PSR site) is now a tier-2 name. The boundary case moved below it.
    assert by['Shackleton']['tier'] == 2          # 20.9 km
    assert 'C. Herschel' not in by                # 13.7 km, below the floor
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
    """spec 5.1 check 1, reclassified as a PINNED-REGRESSION GUARD.

    The 1e-6 tolerance is NOT loosened and the pinned set is NOT a tolerance:
    `labels.KNOWN_BBOX_DEFECTS` is a literal, reviewable list, and it lives in
    the pipeline so guard and test cannot drift (the containment logic used to
    be re-implemented here -- it now comes from the single `bbox_defects()`
    helper that `main()` runs).

    The shipped USGS nightly export genuinely carries 20 records whose centre
    cannot be trusted against its own bbox: 19 sub-half-degree centre/bbox
    precision mismatches (12 of them curated tier-3 traverse features) and
    `Brill`, whose bbox is stored +/-180 while its centre is 0-360. Comparing in
    one wrapped frame resolves Brill, so `bbox_defects()` reports 19 and the
    pinned 20 = those 19 + Brill. Every one of them ships `bbox = null`.
    """
    defects = labels.bbox_defects(records)
    assert set(defects) == set(labels.KNOWN_BBOX_DEFECTS) - {'Brill'}, \
        set(defects) ^ set(labels.KNOWN_BBOX_DEFECTS)
    assert len(labels.KNOWN_BBOX_DEFECTS) == 20
    # main()'s guard condition: nothing outside the pinned list, so it exits 0.
    assert set(defects) - set(labels.KNOWN_BBOX_DEFECTS) == set()
    # ...and no pinned name is a phantom that can silently stop matching.
    assert set(labels.KNOWN_BBOX_DEFECTS) <= {r['name'] for r in records}
    # Pin the separation: every defect is sub-half-degree gazetteer rounding
    # EXCEPT Statio Tianhe, whose 90.9 deg centre is a genuine sign error.
    assert defects['Statio Tianhe'] == pytest.approx(90.9, abs=1e-3)
    assert all(d < 0.5 for n, d in defects.items() if n != 'Statio Tianhe')
    # the 12 curated ones are exactly the astronaut-named traverse features
    curated = {r['name'] for r in labels.curate(records)}
    assert {n for n in defects if n in curated} == {
        'Bench', 'Block', 'Double', 'Doublet', 'Flank', 'Halo', 'Head',
        'Little West', 'Middle Crescent', 'Nansen-Apollo', 'Surveyor', 'Weird'}


def test_brill_is_a_longitude_convention_artefact_not_a_geometry_defect(records):
    """C1: compare in one wrapped frame so `Brill` is not reported as bad geometry."""
    b = next(r for r in records if r['name'] == 'Brill')
    assert not (b['min_lon'] - 1e-6 <= b['center_lon'] <= b['max_lon'] + 1e-6)
    assert 'Brill' not in labels.bbox_defects(records)
    assert labels.bbox_contains([labels.wrap_lon(b['min_lon']), b['min_lat'],
                                 labels.wrap_lon(b['max_lon']), b['max_lat']],
                                labels.wrap_lon(b['center_lon']), b['center_lat'])


def test_bbox_contains_honours_the_wrap_convention():
    """I2: the one containment helper downstream gates must use (Task 9 proof)."""
    seam = [170.0, -10.0, -170.0, 10.0]      # west > east -> crosses +180/-180
    assert labels.bbox_contains(seam, 179.0, 0.0)
    assert labels.bbox_contains(seam, -179.0, 0.0)
    assert not labels.bbox_contains(seam, 0.0, 0.0)      # the middle is outside
    assert not labels.bbox_contains(seam, 179.0, 20.0)   # latitude still binds
    plain = [10.0, -10.0, 20.0, 10.0]
    assert labels.bbox_contains(plain, 15.0, 0.0)
    assert not labels.bbox_contains(plain, 25.0, 0.0)
    assert not labels.bbox_contains(plain, 0.0, 0.0)
    assert not labels.bbox_contains(None, 15.0, 0.0)     # null is never trusted
    assert not labels.bbox_contains([], 15.0, 0.0)


def test_pinned_records_ship_a_null_bbox_and_the_rest_contain_their_centre(records):
    """I2: features.json carries its own bbox-integrity signal."""
    feats = labels.to_features(labels.curate(records))
    props = [f['properties'] for f in feats['features']]
    nulled = [p for p in props if p['bbox'] is None]
    pinned_curated = [p for p in props if p['name'] in labels.KNOWN_BBOX_DEFECTS]
    # 13, not 12: 'Brill' (17.0 km) crossed the lowered crater floor, which is
    # exactly what its pin was for -- labels.py promises its bbox is nulled "on
    # the day it is curated", and this is that day.
    assert len(nulled) == len(pinned_curated) == 13
    assert 'Brill' in {p['name'] for p in nulled}
    assert {p['name'] for p in nulled} == {p['name'] for p in pinned_curated}
    for f in feats['features']:
        if f['properties']['bbox'] is None:
            continue
        lon, lat = f['geometry']['coordinates']
        assert labels.bbox_contains(f['properties']['bbox'], lon, lat), \
            f['properties']['name']
    # west > east is the documented antimeridian convention, not a defect. The
    # set is measured, not remembered: the 15 km floor admitted four more
    # near-0-degree craters (Dante, Dunár, Racah, Ricco) plus Shackleton, whose
    # 20.9 km box straddles the seam, so 10 became 15.
    crossing = {p['name'] for p in props
                if p['bbox'] is not None and p['bbox'][0] > p['bbox'][2]}
    assert crossing == {'Daedalus', 'Dante', 'Dunér', 'Emden', 'Larmor', 'Leeuwenhoek', 'Leibnitz', 'Lipskiy', 'Minnaert', 'Plaskett', 'Racah', 'Ricco', 'Rozhdestvenskiy', 'Shackleton', 'Von Kármán'}
    for f in feats['features']:
        if f['properties']['name'] in crossing:
            lon, lat = f['geometry']['coordinates']
            assert labels.bbox_contains(f['properties']['bbox'], lon, lat)


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
    # I3: prove the promotion is dead at a floor where the crater WOULD be
    # labelled, not only at the default 70 km floor (where Chang Heng and
    # Chang-Ngo are filtered out for size and a tier-3 claim would be vacuous).
    for name in ('Chang Heng', 'Chang-Ngo', 'Apollo'):
        rec = next(r for r in records if r['name'] == name)
        assert rec['code'] == 'AA', name
        assert labels.assign_tier(rec, 70.0) != 3, name
        assert labels.assign_tier(rec, 15.0) != 3, name
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
    # Kept as a regression pin on the *explicit* old setting, not the default:
    # the shipped default moved to 15 km / no budget with amendment 2 D9.
    unpruned = labels.curate(records, 70.0, budget=10_000)
    assert sum(1 for r in unpruned if r['tier'] == 3) == 81
    assert stats['by_tier']['3'] == 81
    assert stats['curated'] == 600
    # The prune must come out of tier 2 only, and must take the smallest first.
    dropped = [r for r in unpruned if r not in kept]
    assert all(r['tier'] == 2 for r in dropped)
    assert max(r['diameter'] or 0 for r in dropped) <= min(
        r['diameter'] or 0 for r in kept if r['tier'] == 2)


def test_every_hardcoded_name_exists_in_the_gazetteer(records):
    """I1: a name that is not in the DBF is a DEAD override, not a label.

    'Mons Rumker' lived here for a whole review round while the gazetteer says
    'Mons Rümker' (u-umlaut); because the MO branch needs >= 100 km and Rümker is
    73.2 km, the feature vanished from the label set silently.
    """
    names = {r['name'] for r in records}
    assert {*labels.TIER0_NAMES, *labels.TIER1_ALWAYS} <= names
    assert 'Mons Rümker' in labels.TIER1_ALWAYS and 'Mons Rumker' not in names


def test_tier1_overrides_are_live_and_land_in_tier_1(records):
    """I1: per-name tier assertions, so an override can never match nothing again."""
    by = {r['name']: r for r in labels.curate(records, budget=10_000)}
    for name in sorted(labels.TIER1_ALWAYS):
        assert name in by, f'{name} is a dead override: it is not curated at all'
        assert by[name]['tier'] == 1, name
    rumker = by['Mons Rümker']
    assert rumker['code'] == 'MO'
    assert rumker['diameter'] == pytest.approx(73.24858, abs=1e-3)


def test_the_historical_70km_600_setting_still_reproduces(records):
    """I1 count shift, recorded not regretted: the live override adds one tier-1.

    T1 133 -> 134, candidates 728 -> 729, pruned 128 -> 129, final 600 =
    17/134/368/81. The budget and the tier rules are unchanged.
    """
    # Kept as a regression pin on the *explicit* old setting, not the default:
    # the shipped default moved to 15 km / no budget with amendment 2 D9.
    unpruned = labels.curate(records, 70.0, budget=10_000)
    kept, stats = labels.curate(records, 70.0, budget=600, return_stats=True)
    assert len(unpruned) == 729
    assert stats['by_tier'] == {'0': 17, '1': 134, '2': 368, '3': 81}
    assert stats['curated'] == len(kept) == 600
    assert len(unpruned) - len(kept) == 129


def test_mission_regex_keeps_every_documented_mission_family():
    """M1: the Chang'e alternative lost its 'e' and silently stopped matching."""
    ce = 'Chang\u2019e'          # U+2019, the way USGS writes the mission
    for origin, want in (('Astronaut-named feature, Apollo 17 site.', 'Apollo 17'),
                         ('Astronaut-named feature, Surveyor 3 site.', 'Surveyor 3'),
                         ('Luna 16 landing site.', 'Luna 16'),
                         (f'{ce} 4 landing site.', f'{ce} 4')):
        assert labels.mission_of({'origin': origin}) == want
    # the crater-name trap stays out: no mission in an astronomer's etymology
    assert labels.mission_of({'origin': 'Named for Guo Shoujing.'}) is None
    assert labels.mission_of({'origin': 'Astronaut-named feature, Apollo 11 site.'})\
        == 'Apollo 11'


def test_the_guard_still_fails_on_an_unpinned_defect():
    """The pin is a regression guard, not a permission slip: a NEW offender must
    reach main()'s `return 2` branch, and it must do so before any write."""
    bogus = [{'name': 'Not In The Gazetteer', 'min_lon': 10.0, 'max_lon': 20.0,
              'min_lat': 0.0, 'max_lat': 5.0, 'center_lon': 15.0, 'center_lat': 9.0}]
    defects = labels.bbox_defects(bogus)
    assert defects == {'Not In The Gazetteer': pytest.approx(4.0)}
    assert set(defects) - set(labels.KNOWN_BBOX_DEFECTS) == {'Not In The Gazetteer'}


def test_main_exits_zero_and_writes_the_task_artifact(monkeypatch):
    """C1: the point of the task -- `npm run labels` exits 0 and emits features.json."""
    root = Path(__file__).resolve().parents[2]
    monkeypatch.chdir(root)
    assert labels.main() == 0                       # the guard must not abort
    out = root / 'public' / 'data' / 'features.json'
    assert out.exists(), 'features.json is this task\'s primary artifact'
    data = json.loads(out.read_text(encoding='utf-8'))
    assert data['type'] == 'FeatureCollection'
    assert len(data['features']) == 1585
    assert sum(1 for f in data['features']
               if f['properties']['bbox'] is None) == 13


def test_main_refuses_to_write_when_the_defect_set_grows(monkeypatch, tmp_path):
    """Same guard, other branch: exit 2 and no artifact, on an unpinned offender."""
    bogus = [{'name': 'Not In The Gazetteer', 'type': 'Crater, craters',
              'code': 'LF', 'diameter': 10.0, 'origin': 'Astronaut-named feature.',
              'center_lon': 15.0, 'center_lat': 9.0, 'min_lon': 10.0,
              'max_lon': 20.0, 'min_lat': 0.0, 'max_lat': 5.0, 'approvaldt': '',
              'quad_code': '', 'link': ''}]
    monkeypatch.setattr(labels, 'load_records', lambda zip_path: list(bogus))
    monkeypatch.chdir(tmp_path)                      # cannot touch the repo output
    assert labels.main() == 2
    assert not (tmp_path / 'public' / 'data' / 'features.json').exists()

