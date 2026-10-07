import { CREDIT } from '@/lib/cesium/moon';
import type { Manifest, SourceRecord } from '@/types';

/** Shown in place of a manifest-derived value when the bake has not run. */
export const UNBAKED = 'not baked yet';

/**
 * The three authoritative products, in the order the disclosure lists them,
 * with the resolution facts from spec §2. These strings are the attribution the
 * plan asks for; the file *names* come from the manifest so a re-bake with a
 * different source version shows up in the panel instead of staying hidden in
 * a hardcoded label.
 */
const PRODUCTS: { role: string; detail: string }[] = [
  { role: 'detail', detail: 'detail mosaic, 100 m/px' },
  { role: 'color', detail: 'colour base, 76 px/deg' },
  { role: 'labels', detail: '9,087 gazetteer records' },
];

export interface AttributionContent {
  /** The credit line — imported from `CREDIT` in moon.ts, never retyped. */
  credit: string;
  products: { name: string; detail: string }[];
  baked: string;
}

export function attributionContent(manifest: Manifest | null): AttributionContent {
  const find = (role: string): SourceRecord | undefined =>
    manifest?.sources.find((s) => s.role === role);
  return {
    credit: CREDIT.html,
    products: PRODUCTS.map(({ role, detail }) => ({
      name: find(role)?.name ?? UNBAKED,
      detail,
    })),
    baked: manifest?.generatedAt ?? UNBAKED,
  };
}
