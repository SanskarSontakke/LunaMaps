'use client';
import { UNAVAILABLE, levelForMPerPx, niceBarScale } from '@/lib/scale';

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
 * Deliberately *not* `aria-live`: this updates on every rendered frame while
 * the camera moves, which would make a screen reader unreadable. It is labelled
 * instead, so it is announced on focus.
 */
export default function ScaleReadout({
  readout,
  top,
}: {
  readout: ReadoutState;
  top: number;
}) {
  const { mPerPx, latDeg, lonDeg } = readout;
  const measured = mPerPx !== null && Number.isFinite(mPerPx);
  const bar = measured ? niceBarScale(mPerPx as number, BAR_MAX_PX) : null;
  const level = measured ? levelForMPerPx(mPerPx as number, top) : null;
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
        <span>{level === null ? '—' : `L${level} of L${top}`}</span>
      </div>
    </div>
  );
}
