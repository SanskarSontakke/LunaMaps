"""Task 17: the disk guard, the Stage 0 gate in front of a real bake, and the
Tier B cost projection.

Everything here is arithmetic about a bake that must be *stopped* rather than
run: Tier B (`--top 7`, both layers) is opt-in, extrapolates to hours and
multi-gigabytes from the Tier A measurement, and the human has not said yes to
it. So the tests pin the guards, not a bake:

  * the guard measures the volume `--out` resolves to and refuses below
    headroom, with the refusal printing the three numbers that make the choice
    possible without re-deriving anything;
  * Tier B is at least 2.5x Tier A in bytes, by the grid's own arithmetic
    (10,922 tiles per layer through L6; 43,690 through L7; 32,768 at L7 alone);
  * the time projection reproduces the measured Tier A wall clock, so the same
    function that says "6.7 h" for Tier B has been shown against a number we
    actually observed (10,680.5 s);
  * a real bake refuses to start on a missing or unverified source, before it
    creates -- or, under `--force`, deletes -- anything in the output tree.

No test in this file runs a bake against the real sources.
"""
from __future__ import annotations
import collections
import json
import sys
from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bake        # noqa: E402
import contract    # noqa: E402
import grid        # noqa: E402
import manifest    # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SHIPPED_MANIFEST = REPO / 'public' / 'tiles' / 'manifest.json'
LAYERS = ('paper', 'photo')


def argv(monkeypatch, *args):
    monkeypatch.setattr(sys, 'argv', ['bake.py', *args])


def fake_raster(path, width=1024, height=512, count=1):
    """A well-formed but *wrong grid* global equirectangular raster: 2:1 and
    georeferenced, so it reads as a grid, yet nowhere near 109164x54582."""
    arr = np.full((height, width, count), 120, np.uint8)
    t = from_bounds(-180.0, -90.0, 180.0, 90.0, width, height)
    with rasterio.open(path, 'w', driver='GTiff', width=width, height=height,
                       count=count, dtype='uint8',
                       crs=CRS.from_wkt(contract.MOON_WKT), transform=t) as ds:
        for b in range(count):
            ds.write(arr[..., b], b + 1)
    return str(path)


# --------------------------------------------------------------------------
# 1. The volume rule and the shape of `estimate`.
# --------------------------------------------------------------------------

def test_tier_b_is_several_times_tier_a():
    a = bake.estimate(6, LAYERS)
    b = bake.estimate(7, LAYERS)
    assert b['bytes'] / a['bytes'] > 2.5
    # Measured, not just "several": the estimator reproduces Tier A's 927,406,556
    # B to 5 significant figures, and Tier B lands at 4.00x that.
    assert b['bytes'] / a['bytes'] == pytest.approx(4.0, abs=0.01)


def test_guard_refuses_when_short_of_space():
    est = bake.estimate(7, LAYERS)
    ok, needed = bake.check_disk_or_abort(est, est['bytes'])
    assert ok is False
    assert needed == int(1.5 * est['bytes'])


def test_guard_allows_with_headroom():
    est = bake.estimate(6, LAYERS)
    ok, _ = bake.check_disk_or_abort(est, 2 * est['bytes'])
    assert ok is True


def test_guard_refuses_exactly_at_the_boundary():
    """`free == needed` is allowed and one byte less is not: the rule is a
    comparison, not a fudge factor applied twice."""
    est = bake.estimate(7, LAYERS)
    needed = int(bake.DISK_HEADROOM * est['bytes'])
    assert bake.check_disk_or_abort(est, needed) == (True, needed)
    assert bake.check_disk_or_abort(est, needed - 1)[0] is False


def test_tier_b_tile_count_matches_the_grid_contract():
    per_layer_b = sum(grid.level_cols(L) * grid.level_rows(L) for L in range(8))
    per_layer_a = sum(grid.level_cols(L) * grid.level_rows(L) for L in range(7))
    assert per_layer_a == 10_922
    assert per_layer_b - per_layer_a == 32_768
    assert per_layer_b == 43_690
    # Same arithmetic through the estimator, under keys that say what they are.
    a = bake.estimate(6, LAYERS)
    b = bake.estimate(7, LAYERS)
    assert a['tilesThroughTopPerLayer'] == 10_922
    assert b['tilesThroughTopPerLayer'] == 43_690
    assert b['tilesAtTop'] == 32_768
    assert a['files'] == 21_844 and b['files'] == 87_380


def test_estimate_no_longer_calls_a_pyramid_a_layer():
    """The old `tilesPerLayer` key held the whole-pyramid count. Renaming it is
    the fix; a stale key would let the 4x Tier B ratio hide the same way the
    0.55/1.35 bits-per-pixel placeholders hid paper's 2.4x error (§4.4)."""
    est = bake.estimate(7, LAYERS)
    assert 'tilesPerLayer' not in est
    assert est['tilesAtTop'] == grid.level_cols(7) * grid.level_rows(7)
    assert est['tilesThroughTopPerLayer'] > est['tilesAtTop']
    assert est['layers'] == list(LAYERS)


# --------------------------------------------------------------------------
# 2. The projection: reproduced against Tier A, quoted in hours for Tier B.
# --------------------------------------------------------------------------

def test_projection_reproduces_the_measured_tier_a_wall_clock():
    lo, hi = bake.project_seconds(6, LAYERS, 1024)
    assert bake.bands_per_layer(6, 1024) * 2 == bake.TIER_A_BANDS == 64
    assert lo <= hi
    assert abs(lo - bake.TIER_A_SECONDS_MEASURED) / bake.TIER_A_SECONDS_MEASURED < 0.02
    assert hi / 3600 < 4.0


def test_tier_b_is_quoted_in_hours_and_gigabytes():
    est = bake.estimate(7, LAYERS)
    lo, hi = bake.project_seconds(7, LAYERS, 1024)
    assert bake.bands_per_layer(7, 1024) == 64          # double Tier A's bands
    assert 6.0 <= lo / 3600 and hi / 3600 <= 12.0       # 6.7-8.5 h at measured rates
    assert est['bytes'] == pytest.approx(3.71e9, rel=0.01)
    # The guard asks for 1.5x the plan, so Tier B needs ~5.6 GB free.
    ok, needed = bake.check_disk_or_abort(est, 10 ** 12)
    assert ok and needed == pytest.approx(5.56e9, rel=0.01)


def test_tier_b_is_bigger_than_the_tree_it_would_replace_by_2_78_gb():
    """The delta matters as much as the total: the delivered Tier A tree is
    already on disk, so an incremental Tier B adds 2.78 GB, not 3.71 GB."""
    a = bake.estimate(6, LAYERS)
    b = bake.estimate(7, LAYERS)
    assert b['bytes'] - a['bytes'] == pytest.approx(2.78e9, rel=0.01)
    assert b['bytes'] - bake.TIER_A_BYTES_MEASURED == pytest.approx(2.78e9, rel=0.01)


# --------------------------------------------------------------------------
# 3. The guard measures --out, not the shell's cwd.
# --------------------------------------------------------------------------

class _NoBake:
    """Stands in for bake.run so a main() path can be exercised for real."""

    def __init__(self):
        self.calls = []

    def __call__(self, **kw):
        self.calls.append(kw)
        return 0


def _stub_volume(monkeypatch, free: int, seen: list):
    usage = collections.namedtuple('usage', 'total used free')

    def fake(path):
        seen.append(str(path))
        return usage(10 ** 15, 0, free)

    monkeypatch.setattr(bake.shutil, 'disk_usage', fake)


def test_the_guard_measures_the_out_volume_and_not_the_cwd(tmp_path, monkeypatch,
                                                           capsys):
    out = tmp_path / 'existing-out'
    out.mkdir()
    seen: list[str] = []
    _stub_volume(monkeypatch, 10 ** 12, seen)
    monkeypatch.setattr(bake, 'check_sources', lambda *a, **kw: [])
    runner = _NoBake()
    monkeypatch.setattr(bake, 'run', runner)
    argv(monkeypatch, '--top', '6', '--out', str(out))
    assert bake.main() == 0
    assert seen and Path(seen[0]) == out, seen
    assert str(Path.cwd()) not in seen
    assert runner.calls and runner.calls[0]['out_dir'] == str(out)
    assert f'disk free={1e12/1e9:.1f} GB at {out}' in capsys.readouterr().out


def test_a_not_yet_created_out_path_measures_its_nearest_existing_parent(
        tmp_path, monkeypatch, capsys):
    """`--out` may point at a directory the bake has not made yet. The guard
    must still ask the right volume, and must not create the path to ask it."""
    out = tmp_path / 'nested' / 'deeper' / 'tiles'
    seen: list[str] = []
    _stub_volume(monkeypatch, 10 ** 12, seen)
    monkeypatch.setattr(bake, 'check_sources', lambda *a, **kw: [])
    monkeypatch.setattr(bake, 'run', _NoBake())
    argv(monkeypatch, '--top', '6', '--out', str(out))
    assert bake.main() == 0
    assert [Path(p) for p in seen] == [tmp_path]
    assert not (tmp_path / 'nested').exists(), 'the guard created the output tree'


def test_the_guard_measures_the_out_volume_when_cwd_is_elsewhere(tmp_path,
                                                                  monkeypatch,
                                                                  capsys):
    """A one-volume machine (this laptop: C: only) cannot show a *different*
    free figure between volumes, so the assertion is on which path is handed to
    the OS. The old code handed it '.'."""
    out = tmp_path / 'out'
    out.mkdir()
    seen: list[str] = []
    _stub_volume(monkeypatch, 42 * 10 ** 9, seen)
    assert bake.free_bytes_at(out) == 42 * 10 ** 9
    assert Path(seen[-1]) == out
    assert bake.free_bytes_at(out / 'not' / 'made' / 'yet') == 42 * 10 ** 9
    assert not (out / 'not').exists()


# --------------------------------------------------------------------------
# 4. The refusal message is a decision, not a dead end.
# --------------------------------------------------------------------------

def test_refusal_prints_needed_tier_a_total_and_the_cheaper_subset(
        tmp_path, monkeypatch, capsys):
    out = tmp_path / 'out'
    out.mkdir()
    _stub_volume(monkeypatch, 10 ** 9, [])          # 1 GB free
    monkeypatch.setattr(bake, 'check_sources', lambda *a, **kw: [])
    runner = _NoBake()
    monkeypatch.setattr(bake, 'run', runner)
    argv(monkeypatch, '--top', '7', '--layer', 'both', '--band-rows', '1024',
         '--out', str(out))
    code = bake.main()
    assert code == 3
    assert runner.calls == [], 'baked anyway'
    err = capsys.readouterr().err
    needed = int(1.5 * bake.estimate(7, LAYERS)['bytes'])
    assert f'{needed:,} B' in err, 'the needed figure is missing'
    assert f'{bake.TIER_A_BYTES_MEASURED:,} B' in err, 'Tier A total missing'
    assert '--layer photo' in err, 'cheaper subset command missing'
    assert '10,680.5 s' in err and '2 h 58 m 03 s' in err, 'wall clock missing'
    assert 'h at the measured' in err, 'hours missing'
    assert 'opt-in' in err.lower()


def test_the_subset_command_is_itself_a_smaller_ask(tmp_path, monkeypatch, capsys):
    """The advice has to be true: the single-layer command must need fewer bytes
    and fewer hours than the command being refused."""
    both = bake.estimate(7, LAYERS)
    photo = bake.estimate(7, ('photo',))
    assert photo['bytes'] < both['bytes'] / 2.0
    assert bake.project_seconds(7, ('photo',), 1024)[1] < \
        bake.project_seconds(7, LAYERS, 1024)[1]
    msg = bake.disk_refusal(both, int(1.5 * both['bytes']), 0, 'public/tiles',
                           1024)
    assert f'{int(1.5 * photo["bytes"]):,} B' in msg


def test_an_envelope_of_space_gets_a_green_light_and_no_refusal(
        tmp_path, monkeypatch, capsys):
    out = tmp_path / 'out'
    out.mkdir()
    _stub_volume(monkeypatch, 10 ** 12, [])
    monkeypatch.setattr(bake, 'check_sources', lambda *a, **kw: [])
    runner = _NoBake()
    monkeypatch.setattr(bake, 'run', runner)
    argv(monkeypatch, '--top', '7', '--out', str(out))
    assert bake.main() == 0
    assert runner.calls
    assert 'REFUSING' not in capsys.readouterr().err


# --------------------------------------------------------------------------
# 5. Stage 0 in front of a real bake: missing and unverified sources are errors.
# --------------------------------------------------------------------------

def test_a_missing_source_refuses_before_the_output_directory_exists(
        tmp_path, monkeypatch, capsys):
    out = tmp_path / 'delivered' / 'tiles'
    runner = _NoBake()
    monkeypatch.setattr(bake, 'run', runner)
    # Both sources absent: the point is the missing-source refusal, and leaving
    # --color on its default would read data/raw (git-ignored) and -- when it
    # happens to exist -- open the geo-less colour TIFF and emit the expected
    # NotGeoreferencedWarning, making the run depend on the machine's data/raw.
    argv(monkeypatch, '--top', '0', '--out', str(out),
         '--detail', str(tmp_path / 'absent.jp2'),
         '--color', str(tmp_path / 'absent.tif'))
    assert bake.main() == 2
    assert runner.calls == []
    assert not out.exists(), 'the guard created the output tree anyway'
    err = capsys.readouterr().err
    assert 'ABSENT' in err and 'STAGE 0 FAILED' in err
    assert err.count('ABSENT') == 2, 'both missing sources are reported'
    assert 'npm run fetch' in err


def test_dry_run_is_no_longer_green_on_an_empty_stage_zero(tmp_path, monkeypatch,
                                                          capsys):
    """This is the finding verbatim: 'absent' then continue then exit 0."""
    argv(monkeypatch, '--dry-run', '--out', str(tmp_path / 'never'),
         '--detail', str(tmp_path / 'absent.jp2'),
         '--color', str(tmp_path / 'absent.tif'))
    assert bake.main() == 2
    err = capsys.readouterr().err
    assert err.count('ABSENT') == 2, 'both sources are reported in one run'


def test_a_wrong_grid_source_refuses_before_the_output_directory_exists(
        tmp_path, monkeypatch, capsys):
    """`--force` rmtree's a finished layer. The gate has to be in front of that,
    so the artifact under test is: refused, exit 2, nothing created."""
    out = tmp_path / 'tiles'
    bad = fake_raster(tmp_path / 'wrong-grid.tif')
    runner = _NoBake()
    monkeypatch.setattr(bake, 'run', runner)
    argv(monkeypatch, '--top', '0', '--out', str(out), '--detail', bad,
         '--color', bad)
    assert bake.main() == 2
    assert runner.calls == []
    assert not out.exists()
    err = capsys.readouterr().err
    assert 'FAILS the stage 0 grid contract' in err
    assert 'width' in err, 'the mismatch names the field, not just "failed"'


def test_a_file_that_is_not_a_raster_refuses_too(tmp_path, monkeypatch, capsys):
    junk = tmp_path / 'not-a-raster.jp2'
    junk.write_text('this is prose, not a codestream', encoding='utf-8')
    argv(monkeypatch, '--top', '0', '--out', str(tmp_path / 'tiles'),
         '--detail', str(junk), '--color', str(junk))
    assert bake.main() == 2
    assert 'STAGE 0 FAILED' in capsys.readouterr().err


# The same gate against the real 3.04 GB sources is a command, not a test: this
# suite has to stay green on a clone that never ran `npm run fetch`, since
# data/raw is git-ignored. `npm run bake -- --dry-run` exercises exactly this
# code path on the real files, and its transcript is in bake-log.md 6.1.


# --------------------------------------------------------------------------
# 6. --band-rows 0 is an argument error, not a crash inside range().
# --------------------------------------------------------------------------

@pytest.mark.parametrize('rows', [0, -1024, 512 + 1, -512])
def test_bad_band_rows_are_rejected_before_any_work(rows):
    with pytest.raises(ValueError):
        bake.validate_band_rows(rows)


def test_band_rows_zero_is_named_as_such(tmp_path, monkeypatch, capsys):
    argv(monkeypatch, '--top', '0', '--band-rows', '0',
         '--out', str(tmp_path / 'tiles'))
    with pytest.raises(SystemExit) as exc:
        bake.main()
    assert 'positive multiple of 512' in str(exc.value)
    assert not (tmp_path / 'tiles').exists()


def test_a_negative_band_rows_used_to_bake_nothing_silently():
    """`range(0, hw, -1024)` is empty and `% TILE` is 0 for a multiple of 512
    with a minus sign, so the old code 'succeeded' having written zero tiles."""
    with pytest.raises(ValueError):
        bake.validate_band_rows(-1024)


# --------------------------------------------------------------------------
# 7. The manifest reflects the tree (findings 10 and 13).
# --------------------------------------------------------------------------

def test_the_shipped_manifest_matches_the_anchor_it_is_quoted_from():
    """bake.TIER_A_BYTES_MEASURED is the number the refusal message prints, so
    it is checked against the artifact it was measured from -- and the shipped
    manifest must no longer claim a level that was never baked."""
    raw = SHIPPED_MANIFEST.read_bytes()
    m = json.loads(raw.decode('utf-8'))
    assert sum(m['layers'][l]['bytes'] for l in LAYERS) == bake.TIER_A_BYTES_MEASURED
    assert sum(m['layers'][l]['tiles'] for l in LAYERS) == 21_844
    assert [lv['L'] for lv in m['levels']] == list(range(bake.TIER_A_TOP + 1))
    assert 7 not in [lv['L'] for lv in m['levels']]
    assert raw.endswith(b'\n'), 'finding 13: tracked text ends with a newline'
    assert m['reindex']['carriedForward'], 'the re-index must declare what it carried'
    assert m['generatedAt'] == m['reindex']['bakedAt'] if 'bakedAt' in m.get(
        'reindex', {}) else True


def test_the_manifest_prj_wkt_is_the_contract_string(tmp_path):
    """MUST FIX 4: `base_manifest()` used to hand-type its own copy of the CRS
    WKT, and the copy was MALFORMED -- five '[' against four ']', because the
    `DATUM[` was never closed, which nests PRIMEM and UNIT inside DATUM. It went
    unnoticed because every consumer only asks that the field be non-empty text
    (`assets.ts`'s `isText(prjWkt)`, mirrored by `parse_manifest_app` below).

    `contract.MOON_WKT` is now the single source, so this pins three things: the
    writer's output, the delivered artifact, and the CRS the upstream gazetteer
    declares for its own geometry (read out of the tracked fixture zip, no
    extraction). All three must be one string, and that string must be balanced.
    """
    from manifest import base_manifest
    wkt = base_manifest([0])['grid']['prjWkt']
    assert wkt == contract.MOON_WKT, 'the manifest re-typed the CRS instead of ' \
                                     'importing the contract'
    shipped = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    assert shipped['grid']['prjWkt'] == contract.MOON_WKT, \
        'the committed manifest still carries the malformed WKT'
    # The defect itself, pinned structurally rather than by a golden string only.
    for label, s in (('contract', contract.MOON_WKT),
                     ('shipped manifest', shipped['grid']['prjWkt'])):
        assert s.count('[') == s.count(']'), \
            f'{label}: unbalanced WKT ({s.count("[")} [ vs {s.count("]")} ])'
        # DATUM must be CLOSED before PRIMEM opens, or PRIMEM/UNIT nest inside it.
        assert ']],PRIMEM' in s, f'{label}: DATUM is not closed before PRIMEM'
        assert s.count('GEOGCS[') == s.count('DATUM[') == 1
    # The geometry's own declaration, from the tracked fixture zip (read in
    # memory; the extracted shapefile directory stays git-ignored).
    import zipfile
    with zipfile.ZipFile(REPO / 'tests' / 'fixtures' /
                         'moon_nomenclature_fixture.zip') as z:
        names = [n for n in z.namelist() if n.lower().endswith('.prj')]
        assert names, 'the fixture carries no .prj to compare against'
        declared = z.read(names[0]).decode('utf-8-sig').strip()
    assert declared == contract.MOON_WKT, \
        'the gazetteer declares a different CRS than the manifest writes'


def test_the_app_validator_constants_are_the_grids_own_numbers():
    """MUST FIX 4's other half: the three numbers the review flagged as unpinned
    duplications. `APP_*` below transcribe `src/lib/assets.ts`, so they are
    asserted equal to the Python grid they are supposed to mirror rather than
    left as parallel literals that can silently drift."""
    assert APP_MAX_TOP == grid.MAX_TOP_LEVEL
    assert APP_TILE_SIZE == grid.TILE
    assert float(APP_MOON_RADIUS_M) == grid.MOON_RADIUS_M
    assert float(APP_MOON_RADIUS_M) == contract_and_gazetteer_radius_m()


def contract_and_gazetteer_radius_m() -> float:
    """The radius the CRS string itself states, so the four copies of that number
    (grid.py, grid.ts, moon.ts, assets.ts's validator) are tied to the datum the
    manifest publishes and the labels are measured in."""
    import re
    m = re.search(r'SPHEROID\["[^"]+",([\d.]+),', contract.MOON_WKT)
    assert m, contract.MOON_WKT
    return float(m.group(1))


def test_baking_one_layer_keeps_the_other_layers_record(tmp_path):
    """MUST FIX 5, end to end: `run()` rebuilds the manifest from
    `base_manifest()`, whose `layers` starts EMPTY, so a one-layer run used to
    publish a manifest with no `layers.paper` at all. `assets.ts` validates BOTH
    layer records and returns null for the whole file if either is missing, so
    following the disk refusal's own advice (`--layer photo`) bricked the app with
    "manifest.json is not compatible with this build".

    Bakes both layers, then re-runs for ONE layer, and asserts the other layer's
    record is still there, still describes the tiles on disk, and claims no writes
    this run did not make.
    """
    import bake as bake_mod
    detail = fake_raster(tmp_path / 'detail.tif', count=1)
    color = fake_raster(tmp_path / 'color.tif', count=4)
    out = tmp_path / 'tiles'
    bake_mod.run(detail=detail, color=color, layers=('paper', 'photo'), top=1,
                 quality=85, band_rows=512, k=0.4, out_dir=str(out), force=True,
                 quiet=True)
    both = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert set(both['layers']) == {'paper', 'photo'}
    paper_before = both['layers']['paper']

    # Now the command the refusal message advises: one layer only.
    bake_mod.run(detail=detail, color=color, layers=('photo',), top=1,
                 quality=85, band_rows=512, k=0.4, out_dir=str(out), quiet=True)
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert set(m['layers']) == {'paper', 'photo'}, \
        'a one-layer bake deleted the other layer from the manifest'
    # The carried record still measures the tree it describes.
    assert m['layers']['paper']['top'] == paper_before['top'] == 1
    assert m['layers']['paper']['tiles'] == paper_before['tiles']
    assert m['layers']['paper']['bytes'] == paper_before['bytes']
    assert m['layers']['paper']['quality'] == 85      # carried, not invented
    assert m['layers']['paper']['detailGain'] is None  # paper is the raw band
    # ...and it does not claim writes this run never made (the reindex rule).
    assert 'baked' not in m['layers']['paper'] and 'derived' not in m['layers']['paper']
    assert m['layers']['paper']['carriedFrom'] == both['generatedAt']
    # The layer that WAS baked still reports its own writes honestly: without
    # `--force` its L1 tiles already exist, so this run bakes none and re-encodes
    # the two parents -- the resume path the refusal message's advice takes.
    assert m['layers']['photo']['baked'] == 0
    assert m['layers']['photo']['derived'] == 2
    assert m['layers']['photo']['top'] == 1
    assert 'carriedFrom' not in m['layers']['photo'], \
        'the layer this run baked must not be marked as carried'
    # Levels describe the whole delivered tree, not just the baked layer.
    assert [lv['L'] for lv in m['levels']] == [0, 1]

    # The app's own gate: `parse_manifest_app` is the transcription of
    # src/lib/assets.ts used throughout this section, and it must accept.
    # `sources` is read from data/raw/sha256.json, which is git-ignored and only
    # exists after `npm run fetch`, so the shipped record stands in for it here;
    # every field the finding is about is the one the bake just wrote.
    if not m['sources']:
        m['sources'] = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))[
            'sources']
    parsed = parse_manifest_app(m)
    assert parsed is not None, 'assets.ts would refuse the manifest this bake wrote'
    assert parsed['layers'] == {'paper': {'top': 1}, 'photo': {'top': 1}}


def test_reindex_rebuilds_from_disk_and_keeps_the_gate_verdicts(tmp_path,
                                                               monkeypatch,
                                                               capsys):
    """--reindex is the only way to correct a manifest without a bake, so its
    two contracts are: write no tiles, and do not clobber what other stages
    recorded (proof.py's albedoHistogram / geometryProof)."""
    import numpy as _np
    from PIL import Image
    out = tmp_path / 'tiles'
    for layer, level in (('paper', 0), ('paper', 1), ('photo', 0), ('photo', 1)):
        cols, rows = grid.level_cols(level), grid.level_rows(level)
        for x in range(cols):
            for y in range(rows):
                d = out / layer / str(level) / str(x)
                d.mkdir(parents=True, exist_ok=True)
                Image.fromarray(_np.full((512, 512), 90, _np.uint8)).save(
                    d / f'{y}.jpg', quality=85)
    shipped = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    shipped['levels'] = [{'L': L} for L in range(8)]      # the old, wrong claim
    shipped['layers']['photo']['detailGain'] = 0.4
    shipped['layers']['paper']['quality'] = 85
    shipped['layers']['photo']['quality'] = 85
    shipped['generatedAt'] = '2026-01-01T00:00:00+00:00'
    (out / 'manifest.json').write_text(json.dumps(shipped, indent=1),
                                       encoding='utf-8')

    monkeypatch.setattr(sys, 'argv', ['bake.py', '--reindex', '--out', str(out)])
    assert bake.main() == 0
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert [lv['L'] for lv in m['levels']] == [0, 1]
    assert m['layers']['paper']['tiles'] == 10
    assert m['layers']['paper']['bytes'] > 0
    assert m['geometryProof']['passed'] is True, 'a re-index lost the gate verdict'
    assert 'albedoHistogram' in m
    assert m['generatedAt'] == '2026-01-01T00:00:00+00:00', 'the bake stamp moved'
    assert 'baked' not in m['layers']['paper'], 'a re-index cannot attribute writes'
    assert (out / 'manifest.json').read_bytes().endswith(b'\n')
    # No tile was written or removed by the reindex.
    assert len(list(out.rglob('*.jpg'))) == 20
    assert 'bakes nothing' in m['reindex']['note']


def test_baked_levels_ignores_a_layer_that_was_not_baked(tmp_path):
    (tmp_path / 'probe' / '1' / '0').mkdir(parents=True)
    (tmp_path / 'probe' / '1' / '0' / '0.jpg').write_bytes(b'x')
    assert manifest.baked_levels(tmp_path, ('paper', 'photo')) == []


def test_write_manifest_appends_the_newline(tmp_path):
    p = manifest.write_manifest(tmp_path / 'm.json', {'schema': 1})
    assert p.read_bytes().endswith(b'}\n')


def _git_tracked_bytes(rel_path: str) -> bytes | None:
    """The bytes git holds for `rel_path` (the staged/index blob, i.e. what a
    commit of the current tree would store), or None when git is unavailable or
    the path is not tracked.

    Why not just read the file: this machine checks git out with
    `core.autocrlf=true`, so a *working copy* of any tracked text file can be
    CRLF while the stored blob is LF. MUST FIX 2 is about the artifact in the
    tree, so the assertion is taken from git's own bytes and the working file is
    checked separately for the property that matters to the app (it parses, and it
    ends on a complete line).
    """
    import subprocess
    try:
        done = subprocess.run(['git', 'show', f':{rel_path}'],
                              cwd=str(REPO), capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return done.stdout


def test_the_shipped_manifest_is_lf_only_with_a_trailing_newline():
    """MUST FIX 2, the artifact side: Task 17 finding 13 fixed the writer to emit
    LF bytes and one final `}\n`; `scripts/proof.py` then undid it on Windows with
    a second, sloppier writer (290 CRLF terminators, no trailing newline). The
    tracked bytes of the delivered manifest are therefore pinned, not trusted."""
    tracked = _git_tracked_bytes('public/tiles/manifest.json')
    assert tracked is not None, 'git could not read the tracked blob'
    assert b'\r' not in tracked, 'the tracked manifest holds CR bytes (CRLF)'
    assert tracked.endswith(b'}\n'), 'the tracked manifest ends mid-line'
    # And the file the app actually loads here is the same content, on a complete
    # line, whichever line ending this checkout was given.
    working = SHIPPED_MANIFEST.read_bytes()
    assert working.endswith(b'\n')
    assert json.loads(working.decode('utf-8')) == json.loads(
        tracked.decode('utf-8')), 'the working copy is not the tracked content'


# --------------------------------------------------------------------------
# 8. The regenerated manifest still satisfies the app's own validator.
# --------------------------------------------------------------------------

# src/lib/assets.ts parseManifest() is the app's only gate on this file: every
# field it reads is checked field by field and the rest is dropped, and moon.ts
# feeds layers.<layer>.top straight into Cesium.maximumLevel. We may not run
# vitest here, so the shipped manifest is re-read against the SAME predicates
# rather than trusted from the writer -- finding 10's "regenerate ... so the app
# keeps accepting it", proved not asserted. Mirrors assets.ts lines 6-93.
APP_TILE_SIZE = 512
APP_MOON_RADIUS_M = 1_737_400
APP_MAX_TOP = 7


def _app_is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) \
        and v == v and abs(v) != float('inf')


def _app_is_text(v):
    return isinstance(v, str) and v.strip() != ''


def _app_is_baked_top(v):
    return (isinstance(v, int) and not isinstance(v, bool)
            and 0 <= v <= APP_MAX_TOP)


def parse_manifest_app(value):
    """Python transcription of src/lib/assets.ts parseManifest(): returns the
    reduced manifest the app keeps, or None if any checked field fails."""
    if not isinstance(value, dict):
        return None
    if value.get('schema') != 1:
        return None
    if not _app_is_text(value.get('generatedAt')):
        return None
    grid_ = value.get('grid')
    if not isinstance(grid_, dict):
        return None
    if not (_app_is_num(grid_.get('tileSize'))
            and grid_['tileSize'] == APP_TILE_SIZE):
        return None
    if not (_app_is_text(grid_.get('yOrigin')) and grid_['yOrigin'] == 'north'):
        return None
    if not (_app_is_num(grid_.get('radiusMeters'))
            and grid_['radiusMeters'] == APP_MOON_RADIUS_M):
        return None
    if not (_app_is_text(grid_.get('lonDomain'))
            and grid_['lonDomain'] == '180'):
        return None
    if not (_app_is_text(grid_.get('latitudeType'))
            and grid_['latitudeType'] == 'planetocentric'):
        return None
    if not (_app_is_text(grid_.get('colsFactor'))
            and _app_is_text(grid_.get('rowsFactor'))):
        return None
    if not _app_is_text(grid_.get('prjWkt')):
        return None
    if not _app_is_num(grid_.get('flattening')):
        return None
    sources = value.get('sources')
    if not isinstance(sources, list) or len(sources) == 0:
        return None
    for s in sources:
        if not isinstance(s, dict):
            return None
        if not (_app_is_text(s.get('name')) and _app_is_text(s.get('role'))):
            return None
        if not (_app_is_num(s.get('bytes')) and _app_is_text(s.get('sha256'))):
            return None
    layers = value.get('layers')
    if not isinstance(layers, dict):
        return None
    paper, photo = layers.get('paper'), layers.get('photo')
    if not (isinstance(paper, dict) and _app_is_baked_top(paper.get('top'))):
        return None
    if not (isinstance(photo, dict) and _app_is_baked_top(photo.get('top'))):
        return None
    return {'schema': 1, 'generatedAt': value['generatedAt'],
            'layers': {'paper': {'top': paper['top']},
                       'photo': {'top': photo['top']}}}


def test_the_shipped_manifest_satisfies_every_field_the_app_validates():
    m = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    parsed = parse_manifest_app(m)
    assert parsed is not None, 'parseManifest would reject the shipped manifest'
    # src/test/assets.test.ts pins these exact values against this file.
    assert parsed['layers']['paper']['top'] == 6
    assert parsed['layers']['photo']['top'] == 6
    assert m['grid']['radiusMeters'] == APP_MOON_RADIUS_M
    assert m['grid']['tileSize'] == APP_TILE_SIZE
    assert m['grid']['yOrigin'] == 'north'
    import re
    assert re.match(r'^\d{4}-\d{2}-\d{2}', m['generatedAt'])


def test_parse_manifest_refuses_a_top_of_8_or_a_moved_grid():
    """The transcription must actually discriminate: an L8 top (a level the app
    would then request from Cesium but that was never baked) or a south y-origin
    must return None, exactly as assets.ts rejects them."""
    good = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    bad_top = json.loads(json.dumps(good))
    bad_top['layers']['paper']['top'] = 8
    assert parse_manifest_app(bad_top) is None
    south = json.loads(json.dumps(good))
    south['grid']['yOrigin'] = 'south'
    assert parse_manifest_app(south) is None
    empty_sources = json.loads(json.dumps(good))
    empty_sources['sources'] = []
    assert parse_manifest_app(empty_sources) is None
