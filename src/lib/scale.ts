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

/**
 * The deepest level of a served-level list, or `null` for an empty one.
 *
 * Written as a fold rather than `Math.max(...levels)` on the caller's assumption
 * that the list is sorted: the ceiling the readout advertises has to be right for
 * a list in any order, and `null` has to be the answer for the empty case so the
 * caller cannot mistake "no deep layer" for "level 0".
 */
export function deepestLevel(levels: readonly number[]): number | null {
  if (levels.length === 0) return null;
  let deepest = levels[0];
  for (const level of levels) if (level > deepest) deepest = level;
  return Number.isInteger(deepest) && deepest >= 0 ? deepest : null;
}

/**
 * The level ceiling the scale readout is allowed to name.
 *
 * `top` on its own is the *base* pyramid's ceiling. When the `ortho` overlay is
 * attached the pixels on screen come from a deeper layer, so clamping the level
 * to the base top printed "L7 of L7" at the overlay's 10.4 m/px: an honest m/px
 * under a false ceiling claim. The ceiling therefore follows the stack that is
 * actually serving, and `attachedOverlayTop` is the caller's answer to "is the
 * overlay attached, and how deep does it go" — `null` for both "not asked for"
 * and "asked for but refused" (no record, nothing inside the envelope, or the
 * recorded tiles not on this machine).
 *
 * Never lower than the base top: an attached overlay can only add depth, and a
 * readout whose ceiling dropped below the base's own would be a new lie.
 */
export function stackTop(
  baseTop: number,
  attachedOverlayTop: number | null | undefined,
): number {
  if (!Number.isInteger(baseTop) || baseTop < 0) return baseTop;
  if (
    attachedOverlayTop === null ||
    attachedOverlayTop === undefined ||
    !Number.isInteger(attachedOverlayTop) ||
    attachedOverlayTop < 0
  ) {
    return baseTop;
  }
  return Math.max(baseTop, attachedOverlayTop);
}
