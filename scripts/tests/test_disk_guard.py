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
import regions     # noqa: E402  (plan geometry only: stream_bake is NOT imported)

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

# Measured from the Tier B bake, not typed. `bake.py --top 7` finished
# 2026-10-09 05:18 local; work/bake-L7.log ends "baked 36352 new tiles + 21844
# derived parents = 58196 writes in 36975.8s". The bake was resumed once (the
# first process was killed at 22% and restarted detached), which is why the
# per-layer `baked` counts below are smaller than the tiles on disk.
TIER_B_TOP = 7
TIER_B_BYTES_MEASURED = 2_819_245_403
TIER_B_TILES_MEASURED = 87_380          # == the --dry-run plan, exactly
TIER_B_SECONDS_MEASURED = 36_975.8


def test_the_shipped_manifest_matches_the_anchor_it_is_quoted_from():
    """The shipped manifest is checked against the numbers the bake logged, and
    against the level it has now actually reached.

    Task 17 finding 10 was the mirror image of the `7 in levels` assertion below:
    the Tier A manifest advertised an L7 that had never been baked. The guard is
    not "never claim L7", it is "claim exactly what is on disk".
    """
    raw = SHIPPED_MANIFEST.read_bytes()
    m = json.loads(raw.decode('utf-8'))
    assert sum(m['layers'][l]['bytes'] for l in LAYERS) == TIER_B_BYTES_MEASURED
    assert sum(m['layers'][l]['tiles'] for l in LAYERS) == TIER_B_TILES_MEASURED
    assert [lv['L'] for lv in m['levels']] == list(range(TIER_B_TOP + 1))
    assert 7 in [lv['L'] for lv in m['levels']]
    assert raw.endswith(b'\n'), 'finding 13: tracked text ends with a newline'
    assert m['timings']['bakeSeconds'] == pytest.approx(TIER_B_SECONDS_MEASURED)
    for layer in LAYERS:
        rec = m['layers'][layer]
        assert rec['top'] == TIER_B_TOP
        # A resumed bake counts only its own writes: paper says baked=3584 because
        # the killed run had already written 29,184 of its L7 tiles. `tiles` is the
        # filesystem truth, so the honest invariant is a non-negative carried
        # shortfall -- never that `baked + derived` equals the total.
        carried = rec['tiles'] - rec['baked'] - rec['derived']
        assert carried >= 0, f'{layer}: counters exceed the tiles on disk'
    assert 'reindex' not in m,         'a fresh bake writes its own counts; only --reindex adds that record'


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


def seed_layers(out, levels=(0, 1)):
    """A plausible delivered tree for `paper` and `photo`, and nothing else.

    Small on purpose: these tests are about the manifest a run writes, and a
    20-tile tree makes "the reindex wrote no tiles" checkable by counting.
    """
    import numpy as _np
    from PIL import Image
    for layer in ('paper', 'photo'):
        for level in levels:
            for x in range(grid.level_cols(level)):
                for y in range(grid.level_rows(level)):
                    d = out / layer / str(level) / str(x)
                    d.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(_np.full((512, 512), 90, _np.uint8)).save(
                        d / f'{y}.jpg', quality=85)


def ortho_record():
    """The real `layers.ortho`, as `stream_bake.py --publish` wrote it."""
    return json.loads(SHIPPED_MANIFEST.read_text(
        encoding='utf-8'))['layers']['ortho']


def test_a_reindex_carries_everything_it_does_not_own(tmp_path, monkeypatch):
    """`base_manifest()` starts from `layers: {}`, and both write paths rebuild from
    it, so anything another tool added -- the availability-gated `ortho` record, or a
    top-level key that does not exist yet -- vanished silently. That is the defect
    class that already ate `geometryProof`, and the two-name whitelist is why
    `geometryProof` survived it. The rule is now "carry what you do not own", so the
    next record added by a different stage cannot be deleted by a reindex nobody
    thought about.
    """
    out = tmp_path / 'tiles'
    seed_layers(out)
    shipped = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    shipped['labelIndex'] = {'generatedBy': 'labels.py', 'count': 1585}
    (out / 'manifest.json').write_text(json.dumps(shipped, indent=1) + '\n',
                                       encoding='utf-8')
    monkeypatch.setattr(sys, 'argv', ['bake.py', '--reindex', '--out', str(out)])
    assert bake.main() == 0
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['layers']['ortho'] == ortho_record(), \
        'the reindex deleted the deep-zoom record another tool published'
    assert m['labelIndex'] == shipped['labelIndex'], 'an unknown key was dropped'
    assert set(m['layers']) == {'paper', 'photo', 'ortho'}
    assert parse_manifest_app(m) is not None, \
        'assets.ts would refuse the manifest this reindex wrote'
    assert len(list(out.rglob('*.jpg'))) == 20, 'a reindex still writes tiles'


def test_a_one_layer_bake_carries_the_ortho_record(tmp_path):
    """Same hole in the bake path: `carried_layers` is limited to `PRODUCT_LAYERS`,
    so a `--layer photo` run re-measures `paper` from the tree and drops `ortho`
    entirely. Following the disk refusal's own advice would then take the deep-zoom
    layer down with it.
    """
    detail = fake_raster(tmp_path / 'detail.tif', count=1)
    color = fake_raster(tmp_path / 'color.tif', count=4)
    out = tmp_path / 'tiles'
    bake.run(detail=detail, color=color, layers=('paper', 'photo'), top=1,
             quality=85, band_rows=512, k=0.4, out_dir=str(out), force=True,
             quiet=True)
    record = ortho_record()
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    m['layers']['ortho'] = record
    manifest.write_manifest(out / 'manifest.json', m)

    bake.run(detail=detail, color=color, layers=('photo',), top=1, quality=85,
             band_rows=512, k=0.4, out_dir=str(out), quiet=True)
    after = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert after['layers']['ortho'] == record, \
        'a one-layer bake deleted the layer it does not own'
    assert parse_manifest_app(after) is not None
    assert 'baked' in after['layers']['photo'], \
        'carrying a foreign layer must not silence the writes this run made'


def test_a_bake_with_no_data_raw_keeps_the_records_the_fetch_wrote(tmp_path,
                                                                   monkeypatch):
    """`data/raw/` is gitignored, and `fetch_data.py` writes `sha256.json` only after
    the whole download loop -- so "tiles on disk, no digest record" is a demonstrated
    state here, not a hypothetical: three background jobs on this branch were killed
    mid-run. `run()` read that file or wrote `sources: []`, and `assets.ts:115`
    refuses a manifest with no sources, so the very bake a user runs to recover from
    an interrupted fetch would brick the app they were trying to fix -- and
    `--reindex` could not undo it, because `sources` is a key `carry_foreign` is told
    this run owns. `capabilities` and the earlier timing keys went the same way.
    """
    detail = fake_raster(tmp_path / 'detail.tif', count=1)
    color = fake_raster(tmp_path / 'color.tif', count=4)
    out = tmp_path / 'tiles'
    shipped = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    shipped['timings']['deepStreamSeconds'] = 1234.5
    manifest.write_manifest(out / 'manifest.json', shipped)
    missing = tmp_path / 'no-such-directory'
    monkeypatch.setattr(bake, 'SHA_PATH', missing / 'sha256.json')
    monkeypatch.setattr(bake, 'CAPS_PATH', missing / 'capabilities.json')

    bake.run(detail=detail, color=color, layers=('photo',), top=1, quality=85,
             band_rows=512, k=0.4, out_dir=str(out), quiet=True)
    m = json.loads((out / 'manifest.json').read_text(encoding='utf-8'))
    assert m['sources'] == shipped['sources'], \
        'a bake with no digest file on disk deleted the source audit trail'
    assert m['capabilities'] == shipped['capabilities'], 'capabilities dropped'
    assert m['timings']['deepStreamSeconds'] == 1234.5, 'an earlier timing was erased'
    assert m['timings']['bakeSeconds'] >= 0
    assert parse_manifest_app(m) is not None, \
        'assets.ts would refuse the manifest this recovery bake wrote'


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
# keeps accepting it", proved not asserted. Mirrors `parseManifest()` and
# `parseAvailability()` in src/lib/assets.ts by name, not by line number.
APP_TILE_SIZE = 512
APP_MOON_RADIUS_M = 1_737_400
APP_MAX_TOP = 10


def _app_is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) \
        and v == v and abs(v) != float('inf')


def _app_is_text(v):
    return isinstance(v, str) and v.strip() != ''


def _app_is_baked_top(v):
    return (isinstance(v, int) and not isinstance(v, bool)
            and 0 <= v <= APP_MAX_TOP)


def _app_is_int(v):
    """`assets.ts`'s `isInt`: a real number whose value is an integer. Booleans
    are excluded because JSON `true` is not a tile index, whatever Python's
    `int` subclass says about it."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) \
        and float(v).is_integer()


# `assets.ts`'s `parseAvailability` distinguishes "the key is absent" (`value ===
# undefined` -> `{}`, a layer with no recorded availability) from "the key is
# present and null" (`!isRecord(value)` -> refuse the whole manifest). Python's
# `None` is BOTH of those to a plain `.get()`, so the transcription needs its own
# "absent" that cannot be a JSON value: without it this copy accepts
# `{"availability": null}`, CI goes green, and the app bricks at boot.
_MISSING = object()


def _app_parse_availability(value, top):
    """Python transcription of `parseAvailability()` in src/lib/assets.ts.

    Returns the reduced block, `{}` for "no block recorded" -- and only for
    `_MISSING`, never for a `None` that came out of the JSON -- or None for "refuse
    the whole manifest". The refusals mirror `manifest.validate_availability`
    one for one, which `test_the_transcription_and_the_writer_gate_never_disagree`
    checks against the authoritative function instead of trusting this copy."""
    if value is _MISSING:
        return {}
    if not isinstance(value, dict):
        return None
    out = {}
    for key, ranges in value.items():
        if not isinstance(key, str):
            return None
        try:
            level = int(key)
        except (TypeError, ValueError):
            return None
        if str(level) != key:
            return None
        if level < 0 or level > min(top, APP_MAX_TOP):
            return None
        if not isinstance(ranges, list) or len(ranges) == 0:
            return None
        cols, rows = grid.level_cols(level), grid.level_rows(level)
        checked = []
        for r in ranges:
            if not isinstance(r, list) or len(r) != 4 \
                    or not all(_app_is_int(v) for v in r):
                return None
            x0, x1, y0, y1 = (int(v) for v in r)
            if x0 > x1 or y0 > y1:
                return None
            if x0 < 0 or x1 > cols - 1 or y0 < 0 or y1 > rows - 1:
                return None
            checked.append([x0, x1, y0, y1])
        out[key] = checked
    return out


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
    result = {'schema': 1, 'generatedAt': value['generatedAt'],
              'layers': {'paper': {'top': paper['top']},
                         'photo': {'top': photo['top']}}}
    # `ortho` is optional in exactly the way assets.ts makes it optional: absent
    # is legal (nothing has been baked yet), present-but-broken refuses the file.
    # `in layers` rather than `.get()`, because a JSON `null` is *present* and the
    # TS side rejects it; `is not None` would have let this copy accept a manifest
    # the app refuses, which is the drift this whole section exists to prevent.
    # `availability` gets the same treatment one level down, via `_MISSING`: the
    # only thing `parseAvailability` reads as "no block" is an absent key, so a
    # `null` there is a malformed block and refuses the file.
    if 'ortho' in layers:
        ortho = layers['ortho']
        if not isinstance(ortho, dict) or not _app_is_baked_top(ortho.get('top')):
            return None
        availability = _app_parse_availability(ortho.get('availability', _MISSING),
                                               ortho['top'])
        if availability is None:
            return None
        result['layers']['ortho'] = {'top': ortho['top'],
                                     'availability': availability}
    return result


def test_the_shipped_manifest_satisfies_every_field_the_app_validates():
    m = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    parsed = parse_manifest_app(m)
    assert parsed is not None, 'parseManifest would reject the shipped manifest'
    # src/test/assets.test.ts pins these exact values against this file.
    assert parsed['layers']['paper']['top'] == TIER_B_TOP
    assert parsed['layers']['photo']['top'] == TIER_B_TOP
    assert m['grid']['radiusMeters'] == APP_MOON_RADIUS_M
    assert m['grid']['tileSize'] == APP_TILE_SIZE
    assert m['grid']['yOrigin'] == 'north'
    import re
    assert re.match(r'^\d{4}-\d{2}-\d{2}', m['generatedAt'])


def test_parse_manifest_refuses_a_top_past_the_cap_or_a_moved_grid():
    """The transcription must actually discriminate: a top past the grid cap (a
    level the app would then request from Cesium but that no bake ever wrote) or a
    south y-origin must return None, exactly as assets.ts rejects them.

    The probe is `MAX_TOP_LEVEL + 1` rather than a literal, because a hard-coded
    8 passed straight through when the cap moved to 10 -- the test was not wrong,
    it was silently not testing the boundary any more.
    """
    good = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    bad_top = json.loads(json.dumps(good))
    bad_top['layers']['paper']['top'] = grid.MAX_TOP_LEVEL + 1
    assert parse_manifest_app(bad_top) is None
    south = json.loads(json.dumps(good))
    south['grid']['yOrigin'] = 'south'
    assert parse_manifest_app(south) is None
    empty_sources = json.loads(json.dumps(good))
    empty_sources['sources'] = []
    assert parse_manifest_app(empty_sources) is None


# --------------------------------------------------------------------------
# 9. layers.ortho.availability (Task 3). `assets.ts` is the app's only gate on
#    the manifest, so a field it parses has to be parsed HERE too -- and the copy
#    has to answer the same way the writer's own gate does.
# --------------------------------------------------------------------------

ORTHO_GOOD = {'9': [[10, 12, 5, 5]]}
_NO_ORTHO = object()


def manifest_with_ortho(ortho):
    """The shipped manifest with `layers.ortho` set to `ortho`, or removed for the
    `_NO_ORTHO` sentinel. Read from the real file so this fixture cannot drift
    from the artifact the app actually loads."""
    m = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    if ortho is _NO_ORTHO:
        m['layers'].pop('ortho', None)
    else:
        m['layers']['ortho'] = ortho
    return m


def test_the_shipped_manifest_carries_a_valid_ortho_record():
    """The tripwire Task 3 left here fired exactly as designed: `ortho` was
    optional until `stream_bake --publish` wrote the record, so this test asserted
    `ortho not in layers` and was built to fail the day one appeared, forcing the
    shape to be re-checked rather than passing silently on a stale expectation.

    It is now rewritten for the published reality, and it keeps the invariant that
    mattered all along: adding `layers.ortho` must not disturb `paper`/`photo`, and
    the record must be the availability-gated overlay the app accepts. A merge that
    dropped a base layer (the `geometryProof`/`paper`-drop defect class) fails here.
    """
    m = json.loads(SHIPPED_MANIFEST.read_text(encoding='utf-8'))
    assert 'ortho' in m['layers'], 'stream_bake --publish has not run yet'
    ortho = m['layers']['ortho']
    assert ortho['top'] == grid.MAX_TOP_LEVEL, 'the deep zoom tops out at the grid cap'
    assert manifest.validate_availability(ortho['availability'], ortho['top']) == []
    # The app's own gate carries it through, and leaves the base layers alone.
    parsed = parse_manifest_app(m)
    assert parsed is not None, 'parseManifest would refuse the shipped manifest'
    assert parsed['layers']['paper'] == {'top': TIER_B_TOP}
    assert parsed['layers']['photo'] == {'top': TIER_B_TOP}
    assert parsed['layers']['ortho'] == {'top': ortho['top'],
                                         'availability': ortho['availability']}
    # Provenance the publish records: one source, and the regions the plan shipped.
    # Which regions those are, and that they are all on disk, is re-derived from both
    # files in test_the_published_ortho_counts_are_re_derived_from_the_delivered_tree;
    # naming the cap here would only repeat a decision that test already pins.
    assert ortho['source'] == 'kaguya-tc'
    assert ortho['regions'], 'the record names no region it published'


# The one guard in this file that reads a delivered tile tree rather than a tracked
# artifact: `public/tiles/*` is gitignored with only the manifest force-added
# (.gitignore:46-47), so a fresh clone holds the record and none of the 7,106 tiles it
# describes. Skipping there keeps a clone green without relaxing a single assertion
# where the tree exists -- which is every machine that has run the bake.
ORTHO_TREE = REPO / 'public' / 'tiles' / 'ortho'


@pytest.mark.skipif(not ORTHO_TREE.exists(),
                    reason='the ortho tree is not in git; run stream_bake.py '
                           'and this test re-derives the record from it')
def test_the_published_ortho_counts_are_re_derived_from_the_delivered_tree():
    """The artifact-level oracle for `layers.ortho`, computed here rather than by the
    writer that made it: `stream_bake` is not imported by this file, so nothing in
    this test can agree with a wrong record by calling the code that produced it.

    It replaces `assert ortho['regions'] and ortho['tiles'] > 0 and
    ortho['bytes'] > 0`, which passed for `tiles: 1`. Every assertion below is a
    number the tree itself answers, and each one discriminates: a record that
    under- or over-promises, double-counts an availability rectangle, or carries a
    byte total from a different run fails here.
    """
    ortho = json.loads(SHIPPED_MANIFEST.read_text(
        encoding='utf-8'))['layers']['ortho']
    tree = ORTHO_TREE
    jpgs = sorted(tree.rglob('*.jpg'))
    assert jpgs, 'the delivered ortho tree is what this test reads'
    on_disk = {}
    for p in jpgs:
        rel = p.relative_to(tree)
        assert len(rel.parts) == 3, f'{rel} is not <level>/<x>/<y>.jpg'
        level, x, y = rel.parts
        on_disk[(int(level), int(x), int(y[:-4]))] = p
    promised = {(int(L), x, y)
                for L, ranges in ortho['availability'].items()
                for r in ranges
                for x in range(r[0], r[1] + 1)
                for y in range(r[2], r[3] + 1)}
    assert promised == set(on_disk), (
        f'{len(promised - set(on_disk))} tiles promised with no file, '
        f'{len(set(on_disk) - promised)} files the record does not promise')
    assert ortho['tiles'] == len(on_disk), 'the count is the file count'
    assert ortho['tiles'] == sum((r[1] - r[0] + 1) * (r[3] - r[2] + 1)
                                 for ranges in ortho['availability'].values()
                                 for r in ranges), \
        'availability rectangles tile-cover the tree exactly once'
    assert ortho['bytes'] == sum(p.stat().st_size for p in on_disk.values())
    assert ortho['top'] == max(L for L, _, _ in on_disk)

    # The plan and the delivery are now the same set of regions, which is what
    # dropping the south polar cap bought: the cap was the one region whose tiles
    # could not be baked honestly from any measured source (the two sources and the
    # arithmetic are in scripts/regions.py and in amendment 2 §7). A region that
    # reappears in the plan without ever reaching the disk fails here, and so does a
    # region added to the record that the plan never promised.
    plan = json.loads((REPO / 'public' / 'data' / 'regions.json').read_text(
        encoding='utf-8'))['regions']
    planned = {r['id'] for r in plan}
    assert 'south-polar-cap' not in planned, 'the cap is out of the plan, by decision'
    assert {r['source'] for r in plan} == {'kaguya-tc'}, (
        'every shipped region is served by the one source measured to cover it: a '
        'second shaded mosaic in this pyramid is the mixing ban, not a level')
    assert planned == set(ortho['regions']), (
        f'planned but not delivered: {sorted(planned - set(ortho["regions"]))}; '
        f'delivered but not planned: {sorted(set(ortho["regions"]) - planned)}')


def test_a_stale_manifest_without_ortho_still_boots():
    """`ortho` is optional by construction: strip the record and `paper`/`photo`
    must still parse, so the app is never bricked by the absence of deep zoom."""
    m = manifest_with_ortho(_NO_ORTHO)
    assert 'ortho' not in m['layers']
    parsed = parse_manifest_app(m)
    assert parsed is not None, 'parseManifest would refuse the base layers'
    assert parsed['layers'] == {'paper': {'top': TIER_B_TOP},
                               'photo': {'top': TIER_B_TOP}}


def test_a_well_formed_ortho_record_is_carried_through():
    parsed = parse_manifest_app(
        manifest_with_ortho({'top': 10, 'availability': ORTHO_GOOD}))
    assert parsed is not None
    assert parsed['layers']['ortho'] == {'top': 10, 'availability': ORTHO_GOOD}
    # The base layers are untouched by the new field -- a one-record change that
    # broke `paper`/`photo` is the failure mode the L7 bake's manifest rewrite
    # would have hit.
    assert parsed['layers']['paper'] == {'top': 7}
    assert parsed['layers']['photo'] == {'top': 7}


def test_a_missing_or_empty_availability_means_unavailable_not_global():
    """Requirement 5: no block, or an empty one, means "nothing to overlay". It
    is NOT a refusal, and it is never read as "the whole globe" -- which for a
    region-limited pyramid is a 404 on every frame."""
    for ortho in ({'top': 10}, {'top': 10, 'availability': {}}):
        parsed = parse_manifest_app(manifest_with_ortho(ortho))
        assert parsed is not None, ortho
        assert parsed['layers']['ortho'] == {'top': 10, 'availability': {}}


# Each of these is the same refusal `assets.ts` makes, and the same one
# `manifest.validate_availability` made before this task existed.
BAD_AVAILABILITY = [
    ({'9': [[0, 1024, 0, 0]]}, 'L9 has 1024 columns, so column 1024 is not a tile'),
    ({'9': [[0, 1023, 0, 512]]}, 'L9 has 512 rows, so row 512 is not a tile'),
    ({'9': [[-1, 10, 0, 0]]}, 'a negative column'),
    ({'9': [[0, 1, -1, 0]]}, 'a negative row'),
    ({'9': [[12, 10, 5, 5]]}, 'inverted x bounds'),
    ({'9': [[10, 12, 5, 4]]}, 'inverted y bounds (row 0 is north)'),
    ({'9': [[1, 2, 3, 4, 5]]}, 'a range with the wrong arity'),
    ({'9': [[1, 2.5, 3, 4]]}, 'a non-integer tile index'),
    ({'9': ['1023']}, 'a range of strings'),
    ({'9': '1023'}, 'a range list that is not a list'),
    ({'9': []}, 'a level with an empty list of ranges'),
    ({'09': [[0, 1, 0, 0]]}, 'a level key that is not its own canonical int'),
    ({'nine': [[0, 1, 0, 0]]}, 'a level key that is not a number'),
    ({'11': [[0, 1, 0, 0]]}, 'a level above MAX_TOP_LEVEL'),
    ([['0', '1', '0', '0']], 'an availability block that is a list'),
    ('availability', 'an availability block that is a string'),
]


@pytest.mark.parametrize('availability, why', BAD_AVAILABILITY,
                         ids=[b[1] for b in BAD_AVAILABILITY])
def test_a_malformed_availability_refuses_the_whole_manifest(availability, why):
    """Refuse the file rather than half-read it: a range outside the grid becomes
    a request for a file no bake wrote, and a silently-dropped block would look
    exactly like "deep zoom was never baked" on a tree where it was."""
    parsed = parse_manifest_app(
        manifest_with_ortho({'top': 10, 'availability': availability}))
    assert parsed is None, f'the transcription accepted a bad block: {why}'


def test_a_level_above_the_layers_own_top_is_refused():
    """`top` is the ceiling the manifest states; availability naming L8 under
    `top: 7` is a promise the bake could not have kept."""
    assert parse_manifest_app(manifest_with_ortho(
        {'top': 7, 'availability': {'8': [[0, 1, 0, 0]]}})) is None
    assert parse_manifest_app(manifest_with_ortho(
        {'top': 8, 'availability': {'8': [[0, 511, 0, 255]]}})) is not None


def test_an_ortho_record_with_a_top_the_grid_does_not_define_is_refused():
    for bad in ({'top': 11, 'availability': {}},
                {'top': 'ten', 'availability': {}},
                {'top': 6.5, 'availability': {}},
                {'availability': ORTHO_GOOD}):
        assert parse_manifest_app(manifest_with_ortho(bad)) is None, bad
    for not_a_record in ('ortho', [], 7):
        assert parse_manifest_app(manifest_with_ortho(not_a_record)) is None, \
            not_a_record


def test_a_null_ortho_record_is_present_and_broken_not_absent():
    """Why the transcription asks `'ortho' in layers` rather than `is not None`:
    JSON `null` is a PRESENT record of the wrong type, and `assets.ts` refuses
    it. A copy that read it as absent would accept a manifest the app rejects,
    and the drift would be invisible from both sides."""
    assert parse_manifest_app(manifest_with_ortho(None)) is None
    # The same line, one field down. `parseAvailability` treats ONLY `undefined`
    # as "no block recorded"; a JSON `null` reaches `!isRecord(value)` and refuses
    # the whole manifest. So the transcription may not read `None` as absent here
    # either -- and it cannot tell the two apart unless the caller's `.get()` hands
    # it something that is not `None` for "absent".
    assert parse_manifest_app(
        manifest_with_ortho({'top': 10, 'availability': None})) is None


def test_the_transcription_and_the_writer_gate_never_disagree():
    """The real check on a hand-made copy: `manifest.validate_availability` is
    authoritative, so for every block the writer could emit -- including the plan
    `public/data/regions.json` already carries -- the transcription and the gate
    must answer the same way."""
    plan = json.loads(
        (REPO / 'public' / 'data' / 'regions.json').read_text(encoding='utf-8')
    )['availability']
    # `None` is JSON `null`, which is PRESENT and malformed to `assets.ts`
    # (`value === undefined` means absent; a null falls to `!isRecord(value)` and
    # refuses the file) and refused by `validate_availability` for the same reason
    # it refuses any non-dict. The transcription has to land on the same side of
    # that line, which it can only do if "absent" is a value `None` cannot be --
    # see `_MISSING` and `parse_manifest_app`.
    blocks = [ORTHO_GOOD, {}, None, plan,
              {'8': [[0, 511, 0, 255]], '9': [[0, 0, 0, 0]]},
              *[a for a, _ in BAD_AVAILABILITY]]
    for top in (1, 7, 8, 10):
        for block in blocks:
            want_ok = manifest.validate_availability(block, top) == []
            got_ok = _app_parse_availability(block, top) is not None
            assert got_ok == want_ok, (top, block,
                                       manifest.validate_availability(block, top))


def test_the_regions_plan_survives_the_apps_gate():
    """`scripts/regions.py` writes the plan the bake will serve and the manifest
    will publish. If that block did not satisfy the app's parser, the streaming
    run would produce a manifest the app refuses -- so the plan is checked here,
    against both gates, rather than discovered in a browser."""
    from manifest import validate_availability
    plan = json.loads(
        (REPO / 'public' / 'data' / 'regions.json').read_text(encoding='utf-8')
    )['availability']
    assert validate_availability(plan, grid.MAX_TOP_LEVEL) == []
    parsed = parse_manifest_app(manifest_with_ortho(
        {'top': grid.MAX_TOP_LEVEL, 'availability': plan}))
    assert parsed is not None, 'assets.ts would refuse the availability regions.py plans'
    assert sorted(int(k) for k in parsed['layers']['ortho']['availability']) == [8, 9, 10]


def test_the_transcription_is_more_permissive_than_the_writer_on_two_point_zero():
    """Named rather than hidden: JSON `2.0` IS an integer to JavaScript
    (`Number.isInteger(2.0)`) and is NOT one to `validate_availability`
    (`isinstance(2.0, int)` is False). The transcription mirrors the app, so it
    agrees with the app on that value and with the writer's gate nowhere else.
    Nothing can produce it -- `regions.py` and `availability_from_disk` emit
    Python ints -- so the asymmetry has no consequence today, but a future change
    to either gate should know which side of it it is moving."""
    block = {'9': [[1, 2.0, 3, 4]]}
    assert manifest.validate_availability(block, 10) != []
    assert _app_parse_availability(block, 10) is not None
    assert parse_manifest_app(
        manifest_with_ortho({'top': 10, 'availability': block})) is not None
