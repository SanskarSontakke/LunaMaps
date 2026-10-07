import { DEG2RAD, MOON_RADIUS_M as R, mPerPx as gridMPerPx } from '@/lib/grid';

// One radius for the whole app: re-exported from the grid contract so the
// readout and the tile pyramid can never disagree about what a metre means.
export { R as MOON_RADIUS_M };

/** Ground metres covered by `dLatDeg` degrees of latitude on the moon sphere. */
export const meridianMeters = (dLatDeg: number) =>
  R * Math.abs(dLatDeg) * DEG2RAD;

/**
 * Ground distance along a small parallel. The map is equirectangular, so this
 * is the axis whose ground scale shrinks with cos(latitude) while its pixel
 * scale does not — which is why the readout reports the along-parallel value.
 */
export const alongParallelMeters = (latDeg: number, dLonDeg: number) =>
  R * Math.cos(latDeg * DEG2RAD) * Math.abs(dLonDeg) * DEG2RAD;

/**
 * Ground metres divided by *measured* pixels. Null when the pixel delta is not
 * a usable positive number — i.e. when either probe point projected off-screen
 * or both landed on the same pixel. The caller prints `UNAVAILABLE` then; it
 * must never print 0 or NaN, which would read as a real resolution.
 */
export function mPerPxFromPixels(
  groundMeters: number,
  pixelDelta: number,
): number | null {
  if (!Number.isFinite(pixelDelta) || pixelDelta <= 0) return null;
  if (!Number.isFinite(groundMeters)) return null;
  return groundMeters / pixelDelta;
}

/** What the readout shows in place of a number when the probe cannot measure. */
export const UNAVAILABLE = 'no scale readout — the surface point is off-screen';

const NICE_KM = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

export function niceBarScale(
  mPerPx: number,
  maxPx: number,
): { barPx: number; labelKm: number } {
  const maxKm = (mPerPx * maxPx) / 1000;
  const labelKm =
    [...NICE_KM].reverse().find((k) => k <= maxKm) ?? NICE_KM[0];
  const barPx = Math.max(1, Math.min((labelKm * 1000) / mPerPx, maxPx));
  return { barPx, labelKm };
}

/**
 * The baked tile level the camera is currently resolving, by nearest ground
 * resolution in log space (levels halve per step, so a linear nearest search
 * would always pick the coarser one). Clamped to `[0, top]` — `top` comes from
 * the manifest, so the readout can never name a level that was not baked.
 */
export function levelForMPerPx(value: number, top: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!Number.isInteger(top) || top < 0) return null;
  let best = 0;
  let bestErr = Number.POSITIVE_INFINITY;
  for (let L = 0; L <= top; L += 1) {
    const err = Math.abs(Math.log(gridMPerPx(L) / value));
    if (err < bestErr) {
      bestErr = err;
      best = L;
    }
  }
  return best;
}
