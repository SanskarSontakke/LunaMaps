'use client';
import { cardContent } from '@/lib/provenance';
import type { Feature } from '@/types';

/**
 * Provenance card for the selected (searched or picked) feature. Renders
 * nothing while nothing is selected. All content comes from `cardContent`,
 * the pure view model that `src/test/provenance.test.ts` pins: name, English
 * gloss, type + descriptor code, diameter, planetocentric lat/lon (decimal and
 * degrees/minutes), extent, quadrangle, approval date, mission for visit
 * sites, and the gazetteer link — plus the coordinate-frame note.
 */
export default function FeatureCard({
  feature,
  onClose,
}: {
  feature: Feature | null;
  onClose: () => void;
}) {
  if (!feature) return null;
  const c = cardContent(feature);
  return (
    <aside
      className="ctl card"
      role="region"
      aria-live="polite"
      aria-label={`Feature card: ${c.name}`}
    >
      <button
        type="button"
        className="card-close"
        aria-label="Close feature card"
        onClick={onClose}
      >
        Close
      </button>
      <h2 className="card-name">{c.name}</h2>
      <p className="card-gloss">{c.gloss}</p>
      <dl className="card-rows">
        {c.rows.map((row) => (
          <div className="card-row" key={row.label}>
            <dt>{row.label}</dt>
            <dd>
              {row.href ? (
                <a href={row.href} target="_blank" rel="noreferrer noopener">
                  {row.value}
                </a>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="card-note">{c.note}</p>
    </aside>
  );
}
