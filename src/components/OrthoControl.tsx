'use client';
import { orthoControlCopy } from '@/lib/cesium/ortho';
import type { Availability } from '@/types';

/**
 * The `ortho` overlay control.
 *
 * It is a toggle and never a third layer chip, because the overlay is stacked
 * above whichever base is active (see `enableOrthoOverlay` in
 * `src/lib/cesium/morph.ts`). All of its wording comes from `orthoControlCopy`
 * — one exported function, tested in `src/test/ortho.test.ts` — so the source
 * and the radiometry ("Kaguya TC orthophoto, shaded relief, not albedo") can
 * never be edited into something the layer is not, and an unavailable overlay
 * says so instead of pretending to cover the globe.
 *
 * `top` is the manifest's own ceiling for this layer and it goes into the copy:
 * the level span, the m/px and the availability the button shows are all derived
 * from the envelope-filtered list the provider is built from, so a label cannot
 * quote a depth the provider will not serve.
 */
export default function OrthoControl({
  availability,
  top,
  onDisk = true,
  enabled,
  onToggle,
}: {
  availability: Availability | undefined;
  top?: number;
  /** Whether the recorded tiles exist on this machine. False is a third state, not
   *  the same as "no record": the manifest promises deep tiles and `public/tiles/`
   *  does not hold them, which is the normal state of a fresh clone. */
  onDisk?: boolean;
  enabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const copy = orthoControlCopy(availability, top, onDisk);
  return (
    <div
      className="ctl ctl-ortho"
      role="group"
      aria-label="Deep-zoom orthophoto overlay"
    >
      <button
        type="button"
        className={copy.unavailable ? '' : enabled ? 'on' : ''}
        aria-pressed={enabled && !copy.unavailable}
        disabled={copy.unavailable}
        onClick={() => onToggle(!enabled)}
      >
        {copy.title}
      </button>
      <span className="ortho-gloss">{copy.gloss}</span>
    </div>
  );
}
