'use client';
import { useEffect, useState } from 'react';
import type { Manifest } from '@/types';
import { MOON_RADIUS_M, TILE_SIZE } from '@/lib/grid';

const EXPECTED_SCHEMA = 1;
// The baked pyramids span levels 0..7. A layer's `top` becomes Cesium's
// maximumLevel (moon.ts), so an out-of-range or non-integer value makes the
// renderer request tiles that were never written. Refuse the whole manifest.
const MAX_TOP = 7;

const isBakedTop = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_TOP;

export function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<Manifest>;
  if (m.schema !== EXPECTED_SCHEMA) return null;
  const grid = m.grid;
  if (!grid) return null;
  if (grid.tileSize !== TILE_SIZE) return null;
  if (grid.yOrigin !== 'north') return null;
  if (grid.radiusMeters !== MOON_RADIUS_M) return null;
  if (grid.lonDomain !== '180') return null;
  if (grid.latitudeType !== 'planetocentric') return null;
  if (!m.layers) return null;
  if (!isBakedTop(m.layers.paper?.top)) return null;
  if (!isBakedTop(m.layers.photo?.top)) return null;
  return m as Manifest;
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
