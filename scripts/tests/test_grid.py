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
