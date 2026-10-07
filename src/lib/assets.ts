'use client';
import { useEffect, useState } from 'react';
import type { Manifest, SourceRecord } from '@/types';
import { MOON_RADIUS_M, TILE_SIZE } from '@/lib/grid';

const EXPECTED_SCHEMA = 1;
// The baked pyramids span levels 0..7. A layer's `top` becomes Cesium's
// maximumLevel (moon.ts), so an out-of-range or non-integer value makes the
// renderer request tiles that were never written. Refuse the whole manifest.
const MAX_TOP = 7;

const isBakedTop = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOP;

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Non-blank string: `generatedAt` and the source filenames are printed as-is. */
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

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
    // Only `top` survives: it is the field moon.ts feeds to Cesium.
    layers: { paper: { top: paper.top }, photo: { top: photo.top } },
  };
}

export const layerTop = (m: Manifest, layer: 'paper' | 'photo') =>
  m.layers[layer].top;

export async function loadManifest(): Promise<Manifest> {
  const r = await fetch('/tiles/manifest.json', { cache: 'no-store' });
  if (!r.ok) throw new Error(`manifest.json HTTP ${r.status}`);
  const m = parseManifest(await r.json());
  if (!m) throw new Error('manifest.json is not compatible with this build');
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
    '/tiles/photo/0/0/0.jpg',
    // wrong top level + the east seam, at the deepest *paper* row. The old code
    // applied photo's top to this paper URL and probed row 0 (north).
    `/tiles/paper/${paperTop}/${colsAt(paperTop) - 1}/${bottomRowAt(paperTop)}.jpg`,
    // the antimeridian column, at the deepest *photo* row. The old
    // `Math.min(2**top - 1, 2**(top - 1))` always resolved to `2**(top - 1)`
    // (the equator), so the intended bottom row was dead code.
    `/tiles/photo/${photoTop}/0/${bottomRowAt(photoTop)}.jpg`,
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
