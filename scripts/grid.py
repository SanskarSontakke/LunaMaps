"""Geodetic tile grid contract.

Mirrored by src/lib/grid.ts; both are tested against the shared golden vectors
in test-vectors/grid.json. Level L has 2^(L+1) columns and 2^L rows of 512 px
square tiles, y increasing southward (row 0 at the north), which is exactly
Cesium's GeographicTilingScheme.
"""
from __future__ import annotations
import math

TILE = 512
MOON_RADIUS_M = 1_737_400.0
# The deepest level the grid defines. It is a statement about the *sources*, not
# about the maths: Kaguya TC ortho is 4096 px/deg (7.4 m/px) global, so L10
# (10.4 m/px) is measured ground and L11 (5.2) would be interpolation. Raising
# this number does not bake anything -- `bake.py` still takes `--top`, and the
# disk guard still refuses a plan it cannot pay for.
MAX_TOP_LEVEL = 10
DEG2RAD = math.pi / 180.0
ARC_METRES_PER_DEGREE = MOON_RADIUS_M * DEG2RAD  # 30,323.35 m of arc per degree


def level_cols(L: int) -> int:
    return 2 ** (L + 1)


def level_rows(L: int) -> int:
    return 2 ** L


def world_px_width(L: int) -> int:
    return TILE * level_cols(L)


def world_px_height(L: int) -> int:
    return TILE * level_rows(L)


def px_per_deg(L: int) -> float:
    return world_px_width(L) / 360.0


def m_per_px(L: int) -> float:
    return ARC_METRES_PER_DEGREE / px_per_deg(L)


def tile_bounds(L: int, x: int, y: int):
    cols, rows = level_cols(L), level_rows(L)
    if not (0 <= x < cols and 0 <= y < rows):
        raise ValueError(f'tile {L}/{x}/{y} outside {cols}x{rows}')
    dlon = 360.0 / cols
    dlat = 180.0 / rows
    west = -180.0 + x * dlon
    north = 90.0 - y * dlat
    return west, north - dlat, west + dlon, north


def lon_to_tile_x(lon: float, L: int) -> int:
    cols = level_cols(L)
    x = math.floor((lon + 180.0) / 360.0 * cols)
    return min(max(int(x), 0), cols - 1)


def lat_to_tile_y(lat: float, L: int) -> int:
    rows = level_rows(L)
    y = math.floor((90.0 - lat) / 180.0 * rows)
    return min(max(int(y), 0), rows - 1)


def world_px_of(lon: float, lat: float, L: int):
    wx = (lon + 180.0) / 360.0 * world_px_width(L)
    wy = (90.0 - lat) / 180.0 * world_px_height(L)
    return wx, wy


def tile_path(layer: str, L: int, x: int, y: int) -> str:
    return f'{layer}/{L}/{x}/{y}.jpg'
