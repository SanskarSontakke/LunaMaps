export type Tier = 0 | 1 | 2 | 3;
/** Owned here, not by moon.ts. `probe` is the Task 2 gate fixture. */
export type LayerName = 'paper' | 'photo' | 'probe';
export type Mode = 'globe' | 'paper';

export interface FeatureProps {
  name: string;
  gloss: string;
  type: string;
  code: string;
  tier: Tier;
  diameterKm: number | null;
  bbox: [number, number, number, number] | null;
  quad: string;
  approval: string;
  /** Set only for tier 3 astronaut-named features, e.g. 'Apollo 11'. */
  mission: string | null;
  url: string;
}

export interface Feature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: FeatureProps;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
}

export interface SourceRecord {
  name: string;
  bytes: number;
  sha256: string;
  url?: string;
  role: string;
  reused?: boolean;
}

/**
 * The frontend's contract with the baked `manifest.json`. Every field modelled
 * here is verified by `parseManifest` (src/lib/assets.ts) before the value
 * reaches a component, so no consumer can read an asserted-but-unchecked field.
 *
 * The bake writes more keys — `levels`, `timings`, `geometryProof`,
 * `albedoHistogram`, `labels`, and per-layer `tiles` / `bytes` / `quality` /
 * `photometric` / `detailGain`. This build never reads them, so they are
 * deliberately NOT modelled (an `as Manifest` cast over them would have been a
 * promise nobody checked). A consumer that starts reading one must add the field
 * to this type AND to the validator, in the same change.
 */
export interface Manifest {
  schema: number;
  /**
   * The bake's stamp, printed verbatim by the attribution panel. `parseManifest`
   * guarantees a non-blank string and nothing more — the panel shows whatever
   * format `scripts/manifest.py` writes, so no date format is asserted here.
   */
  generatedAt: string;
  grid: {
    tileSize: number;
    colsFactor: string;
    rowsFactor: string;
    yOrigin: 'north';
    lonDomain: '180';
    latitudeType: 'planetocentric';
    radiusMeters: number;
    flattening: number;
    prjWkt: string;
  };
  sources: SourceRecord[];
  /**
   * Exactly the two layers this build renders, each with only `top` — the one
   * field the renderer reads (as Cesium's maximumLevel). Not a `Record<string,
   * …>`: an indexable type would claim that *any* layer name resolves to a
   * validated `{ top }`, which is a promise the validator does not make.
   */
  layers: { paper: { top: number }; photo: { top: number } };
}

export const DEFAULT_MODE: Mode = 'globe';
export const DEFAULT_LAYER: LayerName = 'photo';
