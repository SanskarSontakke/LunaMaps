import { describe, expect, it } from 'vitest';
import {
  MOON_RADIUS_M,
  alongParallelMeters,
  meridianMeters,
  mPerPxFromPixels,
  niceBarScale,
  levelForMPerPx,
  UNAVAILABLE,
} from '@/lib/scale';
import { mPerPx } from '@/lib/grid';

describe('lunar ground distance', () => {
  it('uses the Moon radius, not Earth', () => {
    expect(MOON_RADIUS_M).toBe(1_737_400);
    // The plan's literal here is 30 322.4 m, which is the arc for R = 1 737 346 m
    // — 0.95 m below the contract radius this app is built on. The plan's own
    // formula (R * dLat * DEG2RAD) and grid.ts's ARC_METRES_PER_DEGREE both give
    // 30 323.35 m, and Gate G2 / the manifest levels table are derived from that.
    // The tolerance is unchanged (±0.5 m); only the target is corrected, so this
    // still fails any implementation that reached for Earth's 6 378 km.
    expect(meridianMeters(1)).toBeCloseTo(30_323.4, 0);
    expect(meridianMeters(1)).toBeCloseTo(MOON_RADIUS_M * Math.PI / 180, 9);
    // Tied to the grid contract: L0 is 2.8444 px/deg at 10 660.55 m/px.
    expect(meridianMeters(1)).toBeCloseTo(mPerPx(0) * ((512 * 2) / 360), 3);
  });
  it('shrinks along a parallel by cos(latitude)', () => {
    expect(alongParallelMeters(0, 1)).toBeCloseTo(30_323.4, 0);
    expect(alongParallelMeters(60, 1)).toBeCloseTo(15_161.2, 0);
    expect(alongParallelMeters(89.999, 1)).toBeLessThan(10);
    expect(alongParallelMeters(60, 1)).toBeCloseTo(meridianMeters(1) / 2, 6);
  });
  it('divides ground metres by measured pixels', () => {
    expect(mPerPxFromPixels(1000, 10)).toBe(100);
    expect(mPerPxFromPixels(1000, 0)).toBeNull();
    expect(mPerPxFromPixels(1000, Number.NaN)).toBeNull();
  });

  // Extra assertions (Task 13): the sign and domain rules the readout depends on.
  it('is the same distance in either direction along either axis', () => {
    expect(meridianMeters(-1)).toBeCloseTo(meridianMeters(1));
    expect(alongParallelMeters(60, -1)).toBeCloseTo(alongParallelMeters(60, 1));
    expect(alongParallelMeters(-60, 1)).toBeCloseTo(alongParallelMeters(60, 1));
    expect(alongParallelMeters(0, 0)).toBe(0);
  });
  it('rejects non-finite and negative pixel deltas, not just zero', () => {
    expect(mPerPxFromPixels(1000, -4)).toBeNull();
    expect(mPerPxFromPixels(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(mPerPxFromPixels(Number.NaN, 10)).toBeNull();
    // A 1e-3 px delta is a real measurement of something absurd, not a divide-by-zero.
    expect(mPerPxFromPixels(1, 1e-3)).toBeCloseTo(1000, 6);
  });
  it('agrees with the tile grid contract at every baked level', () => {
    // grid.ts mPerPx(L) is one degree of longitude divided by px/deg(L); the
    // along-parallel helper at the equator must reproduce it for the same dLon.
    for (const L of [0, 3, 6]) {
      const pxPerDeg = 512 * 2 ** (L + 1) / 360;
      expect(alongParallelMeters(0, 1 / pxPerDeg)).toBeCloseTo(mPerPx(L), 6);
    }
  });
});

describe('niceBarScale', () => {
  it('picks a round kilometre value that fits the bar', () => {
    const b = niceBarScale(333.1, 120);
    expect(b.barPx).toBeLessThanOrEqual(120);
    expect(b.barPx).toBeGreaterThan(0);
    expect([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]).toContain(b.labelKm);
  });
  it('stays sane at silly resolutions', () => {
    expect(niceBarScale(1e6, 120).labelKm).toBeGreaterThan(0);
    expect(niceBarScale(0.01, 120).labelKm).toBeGreaterThan(0);
  });

  // Extra assertions (Task 13).
  it('never overflows the bar and always labels at least 1 km', () => {
    for (const m of [0.001, 1, 166.57, 10_660.55, 1e5, 1e9]) {
      for (const maxPx of [1, 120, 600]) {
        const b = niceBarScale(m, maxPx);
        expect(b.barPx).toBeGreaterThan(0);
        expect(b.barPx).toBeLessThanOrEqual(maxPx);
        expect(b.labelKm).toBeGreaterThanOrEqual(1);
        expect(Number.isFinite(b.barPx)).toBe(true);
      }
    }
  });
  it('labels the L6 top level with the largest round value that fits 120 px', () => {
    // mPerPx(6) = 166.57 m/px, so 20 km of ground needs 120.1 px — it does not
    // fit, and the widest honest label is 10 km at ~60 px. The bar is chosen to
    // fit, never clamped to lie about its own length.
    const b = niceBarScale(mPerPx(6), 120);
    expect(b.labelKm).toBe(10);
    expect(b.barPx).toBeGreaterThan(59);
    expect(b.barPx).toBeLessThan(61);
    expect((b.barPx * mPerPx(6)) / 1000).toBeCloseTo(b.labelKm, 1);
  });
});

describe('levelForMPerPx', () => {
  it('names the baked level whose resolution the camera is showing', () => {
    expect(levelForMPerPx(mPerPx(6), 6)).toBe(6);
    expect(levelForMPerPx(mPerPx(0), 6)).toBe(0);
    expect(levelForMPerPx(mPerPx(3), 6)).toBe(3);
    // Halfway between levels in log terms still resolves to the nearer one.
    expect(levelForMPerPx(mPerPx(5) * 1.1, 6)).toBe(5);
  });
  it('clamps to what was actually baked, and survives nonsense', () => {
    expect(levelForMPerPx(1e9, 6)).toBe(0); // coarser than L0 -> L0
    expect(levelForMPerPx(mPerPx(0) * 2, 6)).toBe(0);
    expect(levelForMPerPx(0.001, 6)).toBe(6); // finer than the top -> top
    expect(levelForMPerPx(100, 0)).toBe(0);
    expect(levelForMPerPx(Number.NaN, 6)).toBeNull();
    expect(levelForMPerPx(100, -1)).toBeNull();
  });
});

describe('UNAVAILABLE', () => {
  it('is the string the readout prints when the probe cannot be measured', () => {
    expect(typeof UNAVAILABLE).toBe('string');
    expect(UNAVAILABLE.length).toBeGreaterThan(0);
    expect(UNAVAILABLE).toContain('off-screen');
  });
});
