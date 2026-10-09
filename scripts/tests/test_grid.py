import json
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid


def test_level_shapes():
    assert [(grid.level_cols(L), grid.level_rows(L)) for L in range(4)] == [
        (2, 1), (4, 2), (8, 4), (16, 8)]


def test_world_is_always_two_to_one():
    for L in range(8):
        assert grid.world_px_width(L) == 2 * grid.world_px_height(L)


def test_metres_per_pixel_table():
    assert grid.m_per_px(5) == pytest.approx(333.1, abs=0.6)
    assert grid.m_per_px(6) == pytest.approx(166.6, abs=0.6)
    assert grid.m_per_px(7) == pytest.approx(83.3, abs=0.6)


# ==========================================================================
# MUST FIX 3 (2026-10-09 whole-branch review): pins that cannot fail.
#
# Two numbers decide what the delivered artifact is allowed to claim -- the level
# ceiling and the resolution per level -- and until now neither had an external
# check anywhere in Python:
#   * `grid.MAX_TOP_LEVEL` is used only RELATIVELY (its `--top` gate in `bake.py`,
#     `manifest.py:116`, `test_regions.py`, `test_disk_guard.py`'s
#     `APP_MAX_TOP == grid.MAX_TOP_LEVEL`), and the single literal 10 in the
#     repository is in TypeScript (src/test/grid.test.ts:32). Changing grid.py to 9
#     and regenerating the vectors kept the whole Python suite green while the app's
#     ceiling and the pipeline's disagreed.
#   * `levels[].mPerPx` was compared only against `grid.m_per_px`, the very
#     function that wrote it (test_bake_synthetic.py:311), which is a tautology
#     and cannot fail.
# ==========================================================================

def test_max_top_level_is_the_literal_the_app_is_built_with():
    """Absolute pin, deliberately redundant with `grid.py`.

    10 is Kaguya TC ortho's 4096 px/deg (7.4 m/px) global coverage: L10 is 10.41
    m/px, measured ground; L11 would be 5.2 m/px, interpolation. If this number
    ever changes, the TypeScript ceiling, `test-vectors/grid.json`, `regions.py`'s
    plan, the delivered `layers.ortho.top` and every published availability block
    have to change with it -- which is why the pin has to be a literal, not a
    reference back to the module it is checking."""
    assert grid.MAX_TOP_LEVEL == 10


# ---------------------------------------------------------------------------
# The resolution table, computed from first principles and written as literals.
#
#   arc metres per degree   = 1,737,400 m x pi / 180  = 30,323.350424 m
#   pixels per degree at L  = 512 x 2^(L+1) / 360     = 2.844444 x 2^L
#   m/px at L               = 30,323.350424 / (512 x 2^(L+1) / 360)
#
# Nothing here calls grid.m_per_px to produce a number: the values below were
# worked out by hand from the two lines above (and halve exactly at every level,
# which is the arithmetic check that they were not read back off the module).
# The four anchors the review quotes -- L5 333.14, L6 166.57, L7 83.29,
# L10 10.41 -- are reproduced by this table, so the table is tied to the artifact
# and not only to the formula.
# ---------------------------------------------------------------------------
EXPECTED_M_PER_PX = {
    0: 10660.55,     # 30323.350424 / 2.844444
    1: 5330.28,
    2: 2665.14,
    3: 1332.57,
    4: 666.28,
    5: 333.14,
    6: 166.57,
    7: 83.29,
    8: 41.64,
    9: 20.82,
    10: 10.41,       # the delivered deep layer's own claim
}
ARC_METRES_PER_DEGREE_FIRST_PRINCIPLES = 1737400.0 * 3.141592653589793 / 180.0


@pytest.mark.parametrize('L', sorted(EXPECTED_M_PER_PX))
def test_m_per_px_matches_a_table_written_from_the_definition(L):
    got = grid.m_per_px(L)
    # tol 0.005: the literals are rounded to the 2 dp the manifest publishes.
    assert got == pytest.approx(EXPECTED_M_PER_PX[L], abs=0.005), (
        f'L{L}: grid says {got:.6f} m/px, first principles say '
        f'{EXPECTED_M_PER_PX[L]}')
    # Independent of the module: the same number from the hand-written formula.
    from_formula = ARC_METRES_PER_DEGREE_FIRST_PRINCIPLES / (
        512 * 2 ** (L + 1) / 360.0)
    assert from_formula == pytest.approx(EXPECTED_M_PER_PX[L], abs=0.005)


def test_the_resolution_table_halves_at_every_level():
    """The structural half of the pin: 2x the pixels per degree is half the
    ground per pixel, so a table that does not halve is a table someone retyped.

    tol 0.01, not 0.005: BOTH entries are rounded to 2 dp, so a correctly
    computed table can be up to one rounding unit (0.005 + 0.005) off the exact
    half, and a check that fails on its own arithmetic would only teach the next
    reader to loosen it."""
    for L in range(grid.MAX_TOP_LEVEL):
        assert EXPECTED_M_PER_PX[L + 1] == pytest.approx(
            EXPECTED_M_PER_PX[L] / 2.0, abs=0.01), L


def test_the_anchors_the_project_quotes_are_the_anchors_this_table_has():
    """bake.py's disk refusal quotes L7 as 83.29 m/px and grid.py quotes L10 as
    10.4; both sentences are checked against the first-principles literals."""
    assert EXPECTED_M_PER_PX[7] == 83.29
    assert EXPECTED_M_PER_PX[10] == 10.41
    assert grid.m_per_px(7) == pytest.approx(83.29, abs=0.005)
    assert grid.m_per_px(10) == pytest.approx(10.41, abs=0.005)


MANIFEST_PATH = Path(__file__).resolve().parents[2] / 'public' / 'tiles' / \
    'manifest.json'


@pytest.mark.skipif(not MANIFEST_PATH.exists(),
                    reason='no delivered manifest in this checkout')
def test_the_delivered_manifests_own_resolution_table_is_the_first_principles_one():
    """The external check `levels[].mPerPx` never had: the artifact's numbers are
    compared with a table that was written from the definition, not with the
    function that wrote them. Read-only -- no test may write this file."""
    m = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    assert m['grid']['tileSize'] == 512
    assert m['grid']['radiusMeters'] == 1737400.0
    rows = {lv['L']: lv for lv in m['levels']}
    for L, want in EXPECTED_M_PER_PX.items():
        if L not in rows:
            continue                     # the pyramid stops at its own top
        assert rows[L]['mPerPx'] == pytest.approx(want, abs=0.005), (L, rows[L])
        assert rows[L]['cols'] == 2 ** (L + 1), L
        assert rows[L]['rows'] == 2 ** L, L


def test_native_detail_sits_between_levels():
    native = 303.233
    assert grid.px_per_deg(6) < native < grid.px_per_deg(7)


def test_level0_is_two_tiles_side_by_side():
    assert grid.tile_bounds(0, 0, 0) == pytest.approx((-180.0, -90.0, 0.0, 90.0))
    assert grid.tile_bounds(0, 1, 0) == pytest.approx((0.0, -90.0, 180.0, 90.0))


def test_row_zero_is_the_north():
    _, s, _, n = grid.tile_bounds(1, 0, 0)
    assert (n, s) == pytest.approx((90.0, 0.0))


def test_edges_are_clamped():
    assert grid.lon_to_tile_x(180.0, 3) == grid.level_cols(3) - 1
    assert grid.lon_to_tile_x(-180.0, 3) == 0
    assert grid.lat_to_tile_y(90.0, 3) == 0
    assert grid.lat_to_tile_y(-90.0, 3) == grid.level_rows(3) - 1


def test_out_of_range_tile_raises():
    with pytest.raises(ValueError):
        grid.tile_bounds(2, 8, 4)


def test_world_px_of_corners():
    assert grid.world_px_of(-180.0, 90.0, 4) == pytest.approx((0.0, 0.0))
    w, s, e, n = grid.tile_bounds(4, 0, 0)
    wx, wy = grid.world_px_of(e, n, 4)
    assert wx == pytest.approx(float(grid.TILE))
    assert wy == pytest.approx(0.0)


def test_golden_vectors_from_disk():
    vecs = json.loads(Path('test-vectors/grid.json').read_text())
    assert vecs['tileSize'] == grid.TILE
    assert vecs['moonRadiusM'] == grid.MOON_RADIUS_M
    for v in vecs['bounds']:
        assert grid.tile_bounds(v['L'], v['x'], v['y']) == pytest.approx(
            tuple(v['bounds']), abs=1e-9), v
    for v in vecs['index']:
        assert grid.lon_to_tile_x(v['lon'], v['L']) == v['x']
        assert grid.lat_to_tile_y(v['lat'], v['L']) == v['y']
