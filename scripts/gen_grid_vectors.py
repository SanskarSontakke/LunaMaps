import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grid

LON_LAT = [
    (0.0, 0.0), (-180.0, 90.0), (180.0, -90.0), (-179.9999, 89.9999),
    (23.4731, 0.6746),          # Apollo 11 landing site
    (-11.2153, -43.2958),       # Tycho, already wrapped to -180..180
    (100.0, 89.9), (-100.0, -89.9), (179.99999, 0.0), (-0.0001, -0.0001),
]


def main():
    bounds = []
    for L in range(grid.MAX_TOP_LEVEL + 1):
        for x, y in [(0, 0), (0, grid.level_rows(L) - 1),
                     (grid.level_cols(L) - 1, 0),
                     (grid.level_cols(L) - 1, grid.level_rows(L) - 1)]:
            bounds.append({'L': L, 'x': x, 'y': y,
                           'bounds': list(grid.tile_bounds(L, x, y))})
    index = [{'lon': lon, 'lat': lat, 'L': L,
              'x': grid.lon_to_tile_x(lon, L),
              'y': grid.lat_to_tile_y(lat, L)}
             for L in range(grid.MAX_TOP_LEVEL + 1) for (lon, lat) in LON_LAT]
    Path('test-vectors').mkdir(exist_ok=True)
    out = {'tileSize': grid.TILE, 'moonRadiusM': grid.MOON_RADIUS_M,
           'mPerPx': {str(L): grid.m_per_px(L) for L in range(grid.MAX_TOP_LEVEL + 1)},
           'bounds': bounds, 'index': index}
    p = Path('test-vectors/grid.json')
    p.write_text(json.dumps(out, indent=1))
    print(f'wrote {p}: {len(bounds)} bounds, {len(index)} index vectors')


if __name__ == '__main__':
    main()
