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
 * One merged block of tiles that exists on disk: `[x0, x1, y0, y1]`, INCLUSIVE,
 * x growing east and y growing south (row 0 is north) — the reading
 * `scripts/grid.py` gives and the shape `manifest.validate_availability` accepts.
 * Ranges rather than tile lists so the block stays small enough to travel with
 * the manifest.
 */
export type TileRange = [number, number, number, number];

/**
 * `{"<level>": [range, ...]}` — where a region-limited layer's tiles actually
 * are. Keys are canonical level numbers (`"9"`, never `"09"`); a level with no
 * key has no tiles at all. An empty object is a legal answer and means
 * "unavailable"; it is never read as "the whole globe".
 */
export type Availability = Record<string, TileRange[]>;

/**
 * What the app keeps of `layers.ortho`. `top` and `availability` are what the
 * renderer reads; `source` is the product the pixels came from, kept because the
 * control's wording has to name the source it is showing rather than recite a literal
 * that outlived the bake (`kaguya-tc` today; see `orthoSourcePhrase`).
 */
export interface OrthoLayerRecord {
  top: number;
  availability: Availability;
  source?: string;
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
   * `paper` and `photo` are the two BASE layers this build renders, each with
   * only `top` — the one field the renderer reads (as Cesium's maximumLevel).
   * `ortho` is not a base layer: it is an availability-gated overlay, so it
   * carries `availability` as well, and it is OPTIONAL — the delivered manifest
   * has no ortho record until the streaming bake writes one, and its absence
   * means the overlay is unavailable, never that the manifest is broken.
   *
   * Not a `Record<string, …>`: an indexable type would claim that *any* layer
   * name resolves to a validated record, which is a promise the validator does
   * not make.
   */
  layers: {
    paper: { top: number };
    photo: { top: number };
    ortho?: OrthoLayerRecord;
  };
  /**
   * Something in the file was not usable and was therefore dropped. Present only
   * when `parseManifest` actually discarded something.
   *
   * This exists because an optional block used to be able to refuse the whole
   * manifest: one out-of-range rectangle in `layers.ortho` took `paper` and `photo`
   * down with it and the panel told the user imagery had not been baked, pointing
   * them at a command that could not fix it. A bad optional layer now degrades to
   * "deep zoom off" and leaves the reason here, so the degradation is stated rather
   * than silent — and a manifest that says `layers.ortho` exists while this build
   * discarded it is a contradiction a test can catch.
   */
  warnings?: string[];
}

export const DEFAULT_MODE: Mode = 'globe';
export const DEFAULT_LAYER: LayerName = 'photo';
