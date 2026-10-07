export const TILE_SIZE = 512;
export const MOON_RADIUS_M = 1_737_400;
/**
 * The deepest level the grid defines and the delivered pyramids can span: levels
 * 0..7. It is `scripts/grid.py`'s `MAX_TOP_LEVEL`, and the one number `assets.ts`
 * uses to refuse a `layers.<name>.top` that Cesium would turn into requests for
 * tiles no bake ever wrote. `src/test/grid.test.ts` pins it to
 * `test-vectors/grid.json` (generated from the Python module) so the two mirrors
 * cannot drift apart silently.
 */
export const MAX_TOP_LEVEL = 7;
export const DEG2RAD = Math.PI / 180;
const ARC_METRES_PER_DEGREE = MOON_RADIUS_M * DEG2RAD;

export const levelCols = (L: number) => 2 ** (L + 1);
export const levelRows = (L: number) => 2 ** L;
export const worldPxWidth = (L: number) => TILE_SIZE * levelCols(L);
export const worldPxHeight = (L: number) => TILE_SIZE * levelRows(L);
export const pxPerDeg = (L: number) => worldPxWidth(L) / 360;
export const mPerPx = (L: number) => ARC_METRES_PER_DEGREE / pxPerDeg(L);

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export function tileBounds(L: number, x: number, y: number): Bounds {
  const cols = levelCols(L);
  const rows = levelRows(L);
  if (x < 0 || x >= cols || y < 0 || y >= rows) {
    throw new Error(`tile ${L}/${x}/${y} outside ${cols}x${rows}`);
  }
  const dlon = 360 / cols;
  const dlat = 180 / rows;
  const west = -180 + x * dlon;
  const north = 90 - y * dlat;
  return { west, south: north - dlat, east: west + dlon, north };
}

export function lonToTileX(lon: number, L: number): number {
  const cols = levelCols(L);
  const x = Math.floor(((lon + 180) / 360) * cols);
  return Math.min(Math.max(x, 0), cols - 1);
}

export function latToTileY(lat: number, L: number): number {
  const rows = levelRows(L);
  const y = Math.floor(((90 - lat) / 180) * rows);
  return Math.min(Math.max(y, 0), rows - 1);
}

export function worldPxOf(lon: number, lat: number, L: number) {
  return {
    x: ((lon + 180) / 360) * worldPxWidth(L),
    y: ((90 - lat) / 180) * worldPxHeight(L),
  };
}

/** Nadir camera height (m) whose vertical footprint equals level L's m/px. */
export function cameraHeightForLevel(
  L: number,
  viewportHeightPx: number,
  fovDeg: number,
): number {
  const span = mPerPx(L) * viewportHeightPx;
  return span / 2 / Math.tan((fovDeg / 2) * DEG2RAD);
}
