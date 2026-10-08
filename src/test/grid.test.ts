import { readFileSync } from 'node:fs';
import { expect, it, describe } from 'vitest';
import {
  MAX_TOP_LEVEL,
  MOON_RADIUS_M,
  TILE_SIZE,
  levelCols, levelRows, mPerPx, tileBounds, lonToTileX, latToTileY,
  cameraHeightForLevel, worldPxOf, worldPxWidth,
} from '@/lib/grid';
import { MOON_RADIUS_M as CESIUM_MOON_RADIUS_M, TILE_SIZE as CESIUM_TILE_SIZE } from
  '@/lib/cesium/moon';

const vecs = JSON.parse(readFileSync('test-vectors/grid.json', 'utf8'));

/**
 * MUST FIX 4: the constants the app gates Cesium's `maximumLevel`, the ellipsoid
 * and the manifest validator on used to exist as independent literals in three
 * files (`assets.ts`'s `MAX_TOP = 7`, `moon.ts`'s `MOON_RADIUS_M`/`TILE_SIZE`,
 * `grid.ts`'s copies). Nothing compared them, so a change in one was silent.
 *
 * They are pinned here against `test-vectors/grid.json`, which
 * `scripts/gen_grid_vectors.py` generates from the PYTHON grid (`grid.TILE`,
 * `grid.MOON_RADIUS_M`, and the levels of `grid.MAX_TOP_LEVEL`), i.e. the same
 * anchor the numeric grid mirror is tested against — so these assertions compare
 * the constants to the contract, not to each other.
 */
describe('single-source constants', () => {
  it('MAX_TOP_LEVEL is the depth of the golden vectors (Python MAX_TOP_LEVEL)', () => {
    const levels = Object.keys(vecs.mPerPx).map(Number);
    expect(Math.max(...levels)).toBe(MAX_TOP_LEVEL);
    expect(levels.length).toBe(MAX_TOP_LEVEL + 1);
    expect(MAX_TOP_LEVEL).toBe(10);
  });
  it('the Cesium module and the grid module hold the same radius and tile size', () => {
    expect(CESIUM_MOON_RADIUS_M).toBe(MOON_RADIUS_M);
    expect(CESIUM_TILE_SIZE).toBe(TILE_SIZE);
    expect(vecs.moonRadiusM).toBe(MOON_RADIUS_M);
    expect(vecs.tileSize).toBe(TILE_SIZE);
  });
  it('the radius is the one the CRS string states, to the metre', () => {
    // Same check the Python suite runs on `contract.MOON_WKT`'s SPHEROID radius.
    const wkt = String(
      JSON.parse(readFileSync('public/tiles/manifest.json', 'utf8')).grid.prjWkt,
    );
    const m = /SPHEROID\["[^"]+",([\d.]+),/.exec(wkt);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MOON_RADIUS_M);
  });
});

describe('TS grid matches the Python implementation', () => {
  it('level shapes', () => {
    expect([0, 1, 2, 3].map((L) => [levelCols(L), levelRows(L)])).toEqual([
      [2, 1], [4, 2], [8, 4], [16, 8],
    ]);
  });
  it('bounds vectors', () => {
    for (const v of vecs.bounds) {
      const b = tileBounds(v.L, v.x, v.y);
      const got = [b.west, b.south, b.east, b.north] as number[];
      got.forEach((value, i) => {
        expect(Math.abs(value - v.bounds[i])).toBeLessThan(1e-8);
      });
    }
  });
  it('index vectors', () => {
    for (const v of vecs.index) {
      expect(lonToTileX(v.lon, v.L)).toBe(v.x);
      expect(latToTileY(v.lat, v.L)).toBe(v.y);
    }
  });
  it('metres per pixel', () => {
    for (const [L, m] of Object.entries(vecs.mPerPx) as [string, number][]) {
      expect(mPerPx(Number(L))).toBeCloseTo(m, 1);
    }
  });
  it('world is 2:1 at every level', () => {
    for (const L of [0, 3, 6, 7]) {
      expect(worldPxWidth(L)).toBe(2 * (512 * levelRows(L)));
      expect(worldPxOf(0, 0, L)).toEqual({ x: worldPxWidth(L) / 2, y: 512 * levelRows(L) / 2 });
    }
  });
  it('throws on out-of-range tiles', () => {
    expect(() => tileBounds(2, 8, 4)).toThrow();
  });
});

describe('cameraHeightForLevel', () => {
  it('is the nadir height whose vertical footprint matches the level', () => {
    const h = cameraHeightForLevel(6, 900, 60);
    const span = mPerPx(6) * 900;
    expect(h).toBeCloseTo(span / 2 / Math.tan(30 * (Math.PI / 180)), 0);
  });
});
