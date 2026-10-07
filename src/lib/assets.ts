'use client';
import { useEffect, useState } from 'react';
import type { Manifest } from '@/types';
import { TILE_SIZE } from '@/lib/grid';

export function parseManifest(value: unknown): Manifest | null {
  if (typeof value !== 'object' || value === null) return null;
  const m = value as Partial<Manifest>;
  if (!m.grid || m.grid.tileSize !== TILE_SIZE) return null;
  if (!m.layers || !m.layers.paper || !m.layers.photo) return null;
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

/** Three fetches that catch the usual mistakes: unbaked, wrong top level,
 *  and a broken antimeridian column. */
export async function probeAssets(m: Manifest): Promise<Probe[]> {
  const top = layerTop(m, 'photo');
  const cols = 2 ** (top + 1);
  const paths = [
    '/tiles/photo/0/0/0.jpg',
    `/tiles/paper/${top}/${cols - 1}/0.jpg`,
    `/tiles/photo/${top}/0/${Math.min(2 ** top - 1, 2 ** (top - 1))}.jpg`,
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
