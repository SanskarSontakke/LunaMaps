import { describe, expect, it } from 'vitest';
import {
  FALLBACK_HOME_HEIGHT,
  HOME_MARGIN,
  MOON_RADIUS_M,
  MAX_H,
  MIN_H,
  globeFitHeightMeters,
} from '@/lib/cesium/moon';

const FOV60 = Math.PI / 3;

/** The limb of a sphere sits at asin(R / (R + h)) from the camera axis, so this
 *  is the on-screen angular radius of the whole disc at height `h`. */
const limbRadians = (h: number) => Math.asin(MOON_RADIUS_M / (MOON_RADIUS_M + h));

const horizontalHalfRadians = (widthPx: number, heightPx: number) =>
  Math.atan(Math.tan(FOV60 / 2) * (widthPx / heightPx));

describe('globeFitHeightMeters', () => {
  it('puts the limb at exactly the margin fraction of the narrower axis', () => {
    // 800x900 is portrait, so width is the binding axis: 27.16 deg half-angle.
    const h = globeFitHeightMeters(800, 900, FOV60);
    const limit = horizontalHalfRadians(800, 900);
    expect(limbRadians(h)).toBeCloseTo(HOME_MARGIN * limit, 10);
    expect(h).toBeCloseTo(2.6437e6, -3);
  });

  it('switches to the vertical axis once the canvas is wide', () => {
    const wide = globeFitHeightMeters(1600, 900, FOV60);
    // aspect 1.78 opens the horizontal half-angle to 45.8 deg, past the 30 deg
    // vertical, so the vertical fov binds and the disc is framed tighter.
    expect(horizontalHalfRadians(1600, 900)).toBeGreaterThan(FOV60 / 2);
    expect(limbRadians(wide)).toBeCloseTo(HOME_MARGIN * (FOV60 / 2), 10);
    expect(wide).toBeLessThan(globeFitHeightMeters(800, 900, FOV60));
  });

  it('keeps the whole disc inside a slit viewport by clamping, not by failing', () => {
    // 100x4000 leaves a 0.82 deg horizontal half-angle; the honest answer is
    // 139 Mm, which is past the controller's ceiling.
    expect(globeFitHeightMeters(100, 4000, FOV60)).toBe(MAX_H);
  });

  it('never returns a height the camera controller would refuse', () => {
    for (const [w, h] of [[1, 1], [4000, 1], [320, 240], [3840, 2160]] as const) {
      const got = globeFitHeightMeters(w, h, FOV60);
      expect(got).toBeGreaterThanOrEqual(MIN_H);
      expect(got).toBeLessThanOrEqual(MAX_H);
    }
  });

  it('falls back to the square-viewport answer for a frustum it cannot read', () => {
    const expected =
      MOON_RADIUS_M / Math.sin(HOME_MARGIN * (FOV60 / 2)) - MOON_RADIUS_M;
    expect(FALLBACK_HOME_HEIGHT).toBeCloseTo(expected, 6);
    for (const [w, h, f] of [
      [0, 900, FOV60],
      [800, NaN, FOV60],
      [800, 900, 0],
      [800, 900, Math.PI],
      [800, 900, NaN],
    ]) {
      expect(globeFitHeightMeters(w, h, f)).toBe(FALLBACK_HOME_HEIGHT);
    }
  });
});
