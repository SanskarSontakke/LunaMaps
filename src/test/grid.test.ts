import { readFileSync } from 'node:fs';
import { expect, it, describe } from 'vitest';
import {
  levelCols, levelRows, mPerPx, tileBounds, lonToTileX, latToTileY,
  cameraHeightForLevel, worldPxOf, worldPxWidth,
} from '@/lib/grid';

const vecs = JSON.parse(readFileSync('test-vectors/grid.json', 'utf8'));

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
