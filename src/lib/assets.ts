'use client';
import { useEffect, useState } from 'react';
import type {
  Availability,
  Manifest,
  OrthoLayerRecord,
  SourceRecord,
  TileRange,
} from '@/types';
import {
  MAX_TOP_LEVEL,
  MOON_RADIUS_M,
  TILE_SIZE,
  levelCols,
  levelRows,
} from '@/lib/grid';
import { manifestUrl, tilePath } from '@/lib/tileSource';
import { ManifestError } from '@/lib/manifestError';

const EXPECTED_SCHEMA = 1;
// The baked pyramids span levels 0..MAX_TOP_LEVEL. A layer's `top` becomes
// Cesium's maximumLevel (moon.ts), so an out-of-range or non-integer value makes
// the renderer request tiles that were never written. Refuse the whole manifest.
// This used to be a local `const MAX_TOP = 7`, a second copy of `grid.MAX_TOP_LEVEL`
// (which is `scripts/grid.py`'s MAX_TOP_LEVEL) with nothing comparing them; the
// number now has one source and `src/test/grid.test.ts` pins it to the golden
// vectors the Python grid generates.
const MAX_TOP = MAX_TOP_LEVEL;

const isBakedTop = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOP;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Non-blank string: `generatedAt` and the source filenames are printed as-is. */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
/** A tile index: an actual integer, not a boolean or a numeric string. */
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
/** `[x0, x1, y0, y1]`, inclusive — see `TileRange` in src/types.ts. */
const isTileRange = (v: unknown): v is TileRange =>
  Array.isArray(v) && v.length === 4 && v.every(isInt);

/**
 * Validate one `layers.<name>.availability` block, mirroring
 * `manifest.validate_availability` in `scripts/manifest.py` refusal for refusal:
 * canonical integer level keys, no level above the layer's own `top` or the grid
 * cap, a non-empty list of ranges per level, four integers per range, no
 * inverted bounds, and every range inside that level's `2^(L+1) x 2^L` grid.
 *
 * Why the duplication is deliberate: this is the app's only gate, and a range
 * that names a tile outside the grid is a 404 on every frame — the exact failure
 * availability exists to prevent. `scripts/tests/test_disk_guard.py` keeps the
 * Python side honest by re-validating the shipped manifest against a
 * transcription of this function and comparing against `validate_availability`.
 *
 * Returns `null` for "this record is unusable". Since the fix for the review's
 * malformed-optional-block finding, the caller does not refuse the manifest on that
 * answer — it drops `layers.ortho`, keeps `paper`/`photo`, and records the reason in
 * `warnings`. An absent block is `{}` — a layer with no recorded availability, which
 * the UI reports as unavailable (never as "assume the whole globe").
 */
function parseAvailability(value: unknown, top: number): Availability | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const out: Availability = {};
  for (const [key, ranges] of Object.entries(value)) {
    const level = Number(key);
    if (!Number.isInteger(level) || String(level) !== key) return null;
    if (level < 0 || level > Math.min(top, MAX_TOP_LEVEL)) return null;
    if (!Array.isArray(ranges) || ranges.length === 0) return null;
    const cols = levelCols(level);
    const rows = levelRows(level);
    const checked: TileRange[] = [];
    for (const r of ranges) {
      if (!isTileRange(r)) return null;
      const [x0, x1, y0, y1] = r;
      if (x0 > x1 || y0 > y1) return null;
      if (x0 < 0 || x1 > cols - 1 || y0 < 0 || y1 > rows - 1) return null;
      checked.push([x0, x1, y0, y1]);
    }
    out[key] = checked;
  }
  return out;
}

/**
 * Validate every field the app reads, and return only those fields.
 *
 * The previous version checked a handful of keys and then said `return m as
 * Manifest`, which asserted a type over `levels`, `sources`, `timings` and
 * `geometryProof` that nothing had verified — `Attribution` renders
 * `generatedAt` and `manifest.sources[].name` straight to the screen, so an
 * unchecked value there is a checked-looking lie. There is no cast any more: the
 * returned object is built field by field out of values that each passed a
 * predicate, so the type cannot claim more than was checked (the unread bake keys
 * are no longer in `Manifest` either — see src/types.ts).
 */
export function parseManifest(value: unknown): Manifest | null {
  if (!isRecord(value)) return null;
  if (value.schema !== EXPECTED_SCHEMA) return null;
  if (!isText(value.generatedAt)) return null;

  const grid = value.grid;
  if (!isRecord(grid)) return null;
  const { tileSize, colsFactor, rowsFactor, yOrigin, lonDomain } = grid;
  const { latitudeType, radiusMeters, flattening, prjWkt } = grid;
  if (!isNum(tileSize) || tileSize !== TILE_SIZE) return null;
  if (!isText(yOrigin) || yOrigin !== 'north') return null;
  if (!isNum(radiusMeters) || radiusMeters !== MOON_RADIUS_M) return null;
  if (!isText(lonDomain) || lonDomain !== '180') return null;
  if (!isText(latitudeType) || latitudeType !== 'planetocentric') return null;
  if (!isText(colsFactor) || !isText(rowsFactor)) return null;
  if (!isText(prjWkt)) return null;
  if (!isNum(flattening)) return null;

  const sources = value.sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const checked: SourceRecord[] = [];
  for (const s of sources) {
    if (!isRecord(s)) return null;
    if (!isText(s.name) || !isText(s.role)) return null;
    if (!isNum(s.bytes) || !isText(s.sha256)) return null;
    checked.push({
      name: s.name,
      role: s.role,
      bytes: s.bytes,
      sha256: s.sha256,
      ...(isText(s.url) ? { url: s.url } : {}),
      ...(typeof s.reused === 'boolean' ? { reused: s.reused } : {}),
    });
  }

  const layers = value.layers;
  if (!isRecord(layers)) return null;
  const paper = layers.paper;
  const photo = layers.photo;
  if (!isRecord(paper) || !isBakedTop(paper.top)) return null;
  if (!isRecord(photo) || !isBakedTop(photo.top)) return null;

  // Optional by design: the delivered manifest carries no ortho record until the
  // streaming bake writes one, and `paper`/`photo` must keep booting either way.
  //
  // A present but *malformed* record degrades instead of refusing the file. The old
  // behaviour returned `null` for the whole manifest, so one bad optional block took
  // the base layers down with it and the panel told the user imagery had not been
  // baked at all -- a misdiagnosis that sends them to `npm run bake` when the real
  // problem is one range in one optional block. Deep zoom goes off, with the reason
  // carried forward in `warnings` so the interface can say it out loud.
  let ortho: OrthoLayerRecord | undefined;
  const warnings: string[] = [];
  if (layers.ortho !== undefined) {
    if (!isRecord(layers.ortho) || !isBakedTop(layers.ortho.top)) {
      warnings.push('layers.ortho is present but its shape or top level is not valid');
    } else {
      const availability = parseAvailability(layers.ortho.availability, layers.ortho.top);
      if (availability === null) {
        warnings.push(
          `layers.ortho.availability names tiles outside the level grid at L${layers.ortho.top}`,
        );
      } else {
        ortho = {
          top: layers.ortho.top,
          availability,
          // Which product the pixels came from, if the record says. The control's
          // wording is built from this so it cannot name a mission the layer does not
          // have; see `orthoSourcePhrase`.
          ...(typeof layers.ortho.source === 'string' && layers.ortho.source !== ''
            ? { source: layers.ortho.source }
            : {}),
        };
      }
    }
  }

  return {
    schema: EXPECTED_SCHEMA,
    generatedAt: value.generatedAt,
    grid: {
      tileSize,
      colsFactor,
      rowsFactor,
      yOrigin: 'north',
      lonDomain: '180',
      latitudeType: 'planetocentric',
      radiusMeters,
      flattening,
      prjWkt,
    },
    sources: checked,
    // Only `top` survives on the base layers: it is the field moon.ts feeds to
    // Cesium. `ortho` also keeps `availability`, because that is the field that
    // decides which tiles the overlay may request.
    layers: {
      paper: { top: paper.top },
      photo: { top: photo.top },
      ...(ortho ? { ortho } : {}),
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export const layerTop = (m: Manifest, layer: 'paper' | 'photo') =>
  m.layers[layer].top;

/**
 * Re-exported so existing imports keep working. The class itself lives in
 * `src/lib/manifestError.ts`: `diagnostics.ts` must be able to test for it without
 * importing this module, which carries React and `fetch`.
 */
export { ManifestError } from '@/lib/manifestError';
export type { ManifestErrorKind } from '@/lib/manifestError';

export async function loadManifest(): Promise<Manifest> {
  const url = manifestUrl();
  let r: Response;
  try {
    r = await fetch(url, { cache: 'no-store' });
  } catch (e: unknown) {
    // A transport failure is not "the imagery is not baked" — on a deployment whose
    // tiles live on a CDN it is usually CORS or the store being unreachable, and the
    // panel has to say which. Throwing the untyped error let `classifyBootError` decide
    // from the message, which is exactly the wording-coupling this refactor removed.
    throw new ManifestError('http', `manifest request failed: ${String(e)}`, { url });
  }
  if (!r.ok) {
    throw new ManifestError('http', `manifest.json HTTP ${r.status}`, {
      status: r.status,
      url,
    });
  }
  const m = parseManifest(await r.json());
  if (!m) {
    throw new ManifestError('incompatible', `${url} is not compatible with this build`, {
      url,
    });
  }
  return m;
}

export function useManifest(): {
  manifest: Manifest | null;
  error: string | null;
} {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    loadManifest()
      .then((m) => {
        if (alive) setManifest(m);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);
  return { manifest, error };
}

export interface Probe {
  path: string;
  ok: boolean;
  status: number;
}

/** Level L of the grid contract has 2**(L+1) columns and 2**L rows (grid.ts),
 *  so the *actual* bottom row index is 2**L - 1. */
const colsAt = (top: number) => 2 ** (top + 1);
const bottomRowAt = (top: number) => 2 ** top - 1;

/** Three fetches that catch the usual mistakes: unbaked, wrong top level,
 *  and a broken antimeridian column. Each path uses its *own* layer's top and
 *  probes the real bottom row. */
export async function probeAssets(m: Manifest): Promise<Probe[]> {
  const photoTop = layerTop(m, 'photo');
  const paperTop = layerTop(m, 'paper');
  const paths = [
    // unbaked: does the pyramid exist at all?
    tilePath('photo', 0, 0, 0),
    // wrong top level + the east seam, at the deepest *paper* row. The old code
    // applied photo's top to this paper URL and probed row 0 (north).
    tilePath('paper', paperTop, colsAt(paperTop) - 1, bottomRowAt(paperTop)),
    // the antimeridian column, at the deepest *photo* row. The old
    // `Math.min(2**top - 1, 2**(top - 1))` always resolved to `2**(top - 1)`
    // (the equator), so the intended bottom row was dead code.
    tilePath('photo', photoTop, 0, bottomRowAt(photoTop)),
  ];
  return Promise.all(
    paths.map(async (path) => {
      try {
        const r = await fetch(path, { method: 'GET' });
        return { path, ok: r.ok, status: r.status };
      } catch {
        return { path, ok: false, status: 0 };
      }
    }),
  );
}
