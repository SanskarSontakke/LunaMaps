'use client';
import { attributionContent } from '@/lib/attribution';
import type { Manifest } from '@/types';

/**
 * Provenance, always on screen at 10 px. The credit line is the imported
 * `CREDIT.html` from `src/lib/cesium/moon.ts` — the single source of truth that
 * Cesium's own credit display also uses — so this panel can never drift from
 * what the engine reports (the string carries a U+2019 apostrophe, which is
 * exactly why nobody is allowed to retype it).
 *
 * It lives outside the `.ui` overlay and outside the manifest conditional on
 * purpose: the attribution must survive a failed bake, a missing manifest and a
 * lost `features.json`.
 */
export default function Attribution({ manifest }: { manifest: Manifest | null }) {
  const content = attributionContent(manifest);
  return (
    <div className="credit" role="contentinfo" aria-label="Data provenance">
      <p className="credit-text">{content.credit}</p>
      <details className="credit-more">
        <summary>Source products</summary>
        <ul>
          {content.products.map((p) => (
            <li key={p.detail}>
              <span className="credit-name">{p.name}</span>
              <span className="credit-detail">{p.detail}</span>
            </li>
          ))}
        </ul>
        <p className="credit-baked">Baked {content.baked}</p>
      </details>
    </div>
  );
}
