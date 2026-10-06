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

export interface Manifest {
  schema: number;
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
  levels: { L: number; cols: number; rows: number; mPerPx: number }[];
  sources: SourceRecord[];
  layers: Record<string, {
    top: number;
    tiles: number;
    bytes: number;
    quality: number;
    photometric: string;
    detailGain: number | null;
  }>;
  albedoHistogram?: {
    level: number; mean: number; p33: number; p67: number; samples: number;
  };
  labels?: {
    total: number; curated: number; min_crater_km: number; budget: number;
    by_tier: Record<string, number>; by_code: Record<string, number>;
  };
  geometryProof?: {
    passed: boolean; mareMedian: number; highlandMedian: number;
    checks: Record<string, string>; failures: string[];
  };
  timings: Record<string, number>;
}

export const DEFAULT_MODE: Mode = 'globe';
export const DEFAULT_LAYER: LayerName = 'photo';
