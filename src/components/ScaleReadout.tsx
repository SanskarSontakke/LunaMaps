'use client';
import { UNAVAILABLE, levelForMPerPx, niceBarScale, stackTop } from '@/lib/scale';

const BAR_MAX_PX = 120;

export interface ReadoutState {
  mPerPx: number | null;
  latDeg: number;
  lonDeg: number;
}

/**
 * Camera-projected scale. `mPerPx` comes from `measureMPerPx` (two surface
 * points projected through the live camera), never from a table: it is the
 * along-parallel value, so it carries the cos(latitude) factor where the pixel
 * grid has it (paper mode) and stays honest in globe mode.
 *
 * When the probe cannot measure — an oblique globe view puts the ground point
 * under the camera off-screen or behind the view plane — `mPerPx` is null and
 * the panel prints `UNAVAILABLE` with no bar, rather than 0 or a stale number.
 *
 * THE LEVEL CLAIM, which is the part that used to be a lie. `top` is the *base*
 * pyramid's ceiling; the deep overlay serves below it. Clamping the level through
 * the base top alone printed "L7 of L7" while `ortho` was delivering 10.4 m/px —
 * an honest m/px under a false ceiling. So the ceiling is `stackTop(top,
 * overlayTop)`, and the three states read:
 *
 *   - overlay off                      -> `overlayTop` null  -> "of L7"
 *   - overlay attached inside a region -> `overlayTop` 10    -> "of L10"
 *   - asked for, not on this machine   -> `overlayTop` null  -> "of L7"
 *
 * The caller passes the overlay's depth only when the overlay is ACTUALLY in the
 * imagery stack, so "of N" names the deepest level the stack serving these pixels
 * can reach. Inside that stack the base still paints everywhere the recorded boxes
 * do not cover, which is why the number is a ceiling and not a promise about the
 * tile under the cursor.
 *
 * Deliberately *not* `aria-live`: this updates on every rendered frame while
 * the camera moves, which would make a screen reader unreadable. It is labelled
 * instead, so it is announced on focus.
 */
export default function ScaleReadout({
  readout,
  top,
  overlayTop = null,
}: {
  readout: ReadoutState;
  top: number;
  /** The deepest level the ATTACHED overlay serves, or null when nothing deeper
   *  is in the stack (off, unavailable, or recorded but not on this machine). */
  overlayTop?: number | null;
}) {
  const { mPerPx, latDeg, lonDeg } = readout;
  const measured = mPerPx !== null && Number.isFinite(mPerPx);
  const bar = measured ? niceBarScale(mPerPx as number, BAR_MAX_PX) : null;
  const ceiling = stackTop(top, overlayTop);
  const level = measured ? levelForMPerPx(mPerPx as number, ceiling) : null;
  return (
    <div className="ctl ctl-scale" role="group" aria-label="Scale and view">
      <div className="scale-value">
        {measured ? `~${Math.round(mPerPx as number).toLocaleString('en-US')} m/px` : UNAVAILABLE}
      </div>
      {bar && (
        <div className="scale-bar-row" aria-hidden="true">
          <span
            className="scale-bar"
            style={{ width: `${Math.round(bar.barPx)}px` }}
          />
          <span className="scale-bar-label">{bar.labelKm} km</span>
        </div>
      )}
      <div className="scale-meta">
        <span>
          {latDeg.toFixed(4)}° lat · {lonDeg.toFixed(4)}° lon
        </span>
        <span>{level === null ? '—' : `L${level} of L${ceiling}`}</span>
      </div>
    </div>
  );
}
