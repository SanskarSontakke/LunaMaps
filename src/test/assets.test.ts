import { readFileSync } from 'node:fs';
import { MAX_TOP_LEVEL } from '@/lib/grid';
import { describe, expect, it, vi } from 'vitest';
import { layerTop, parseManifest, probeAssets } from '@/lib/assets';

// A complete manifest the app actually depends on. `parseManifest` validates
// every field it returns, so this is the minimum a good manifest needs.
const GOOD = {
  schema: 1,
  generatedAt: '2026-10-07T05:55:25+00:00',
  grid: {
    tileSize: 512,
    colsFactor: '2^(L+1)',
    rowsFactor: '2^L',
    yOrigin: 'north',
    lonDomain: '180',
    latitudeType: 'planetocentric',
    radiusMeters: 1_737_400,
    flattening: 0,
    prjWkt: 'GEOGCS["GCS_Moon_2000"]',
  },
  sources: [
    {
      name: 'LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
      role: 'detail',
      bytes: 2_500_331_610,
      sha256: '3c0bf3c5e34d52ec95633b960c92ddd97024eca168c0d5bc41e84862d6c05e95',
    },
    {
      name: 'lroc_color_poles.tif',
      role: 'color',
      bytes: 1,
      sha256: 'x',
    },
    {
      name: 'MOON_nomenclature_center_pts.zip',
      role: 'labels',
      bytes: 1,
      sha256: 'x',
    },
  ],
  layers: { paper: { top: 6 }, photo: { top: 6 } },
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(GOOD);
    expect(m).not.toBeNull();
    expect(layerTop(m!, 'photo')).toBe(6);
  });
  it('rejects a foreign tile size instead of silently mis-rendering', () => {
    expect(
      parseManifest({ ...GOOD, grid: { ...GOOD.grid, tileSize: 256 } }),
    ).toBeNull();
  });
  it('rejects a missing layer record', () => {
    expect(parseManifest({ ...GOOD, layers: { paper: { top: 6 } } })).toBeNull();
  });
  it('rejects garbage', () => {
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest('x')).toBeNull();
  });

  // Every field the app flows into Cesium must be refused, not just tileSize,
  // or a foreign manifest reaches maximumLevel and requests nonexistent tiles.
  it('rejects a foreign schema version', () => {
    expect(parseManifest({ ...GOOD, schema: 2 })).toBeNull();
    expect(parseManifest({ ...GOOD, schema: undefined })).toBeNull();
  });
  it("rejects a south-origin grid (Gate G1's exact failure)", () => {
    expect(
      parseManifest({ ...GOOD, grid: { ...GOOD.grid, yOrigin: 'south' } }),
    ).toBeNull();
  });
  it('rejects a foreign moon radius', () => {
    expect(
      parseManifest({
        ...GOOD,
        grid: { ...GOOD.grid, radiusMeters: 6_371_000 },
      }),
    ).toBeNull();
  });
  it('rejects a foreign longitude domain', () => {
    expect(
      parseManifest({ ...GOOD, grid: { ...GOOD.grid, lonDomain: '360' } }),
    ).toBeNull();
  });
  it('rejects a non-planetocentric latitude type', () => {
    expect(
      parseManifest({ ...GOOD, grid: { ...GOOD.grid, latitudeType: 'geodetic' } }),
    ).toBeNull();
  });
  it('rejects a layer with no top', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: {}, photo: { top: 6 } } }),
    ).toBeNull();
  });
  it('rejects a non-integer or non-finite top', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 6.5 }, photo: { top: 6 } } }),
    ).toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: NaN }, photo: { top: 6 } } }),
    ).toBeNull();
    expect(
      parseManifest({
        ...GOOD,
        layers: { paper: { top: Infinity }, photo: { top: 6 } },
      }),
    ).toBeNull();
  });
  // 11, not 8: the grid cap moved to L10 with the deep-zoom source, so the
  // out-of-range probe has to move with it or the test proves nothing.
  it('rejects a top outside 0..MAX_TOP_LEVEL', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 11 }, photo: { top: 6 } } }),
    ).toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: -1 }, photo: { top: 6 } } }),
    ).toBeNull();
  });
  it('validates BOTH layers, not just paper', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 6 }, photo: { top: 11 } } }),
    ).toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 6 }, photo: {} } }),
    ).toBeNull();
  });
  it('accepts the ends of the valid top range (0 and the cap)', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 0 }, photo: { top: MAX_TOP_LEVEL } } }),
    ).not.toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 0 }, photo: { top: MAX_TOP_LEVEL + 1 } } }),
    ).toBeNull();
  });

  // The two fields the review called out as asserted-but-unchecked: `generatedAt`
  // is printed verbatim by the attribution panel, and `sources` is where it gets
  // the product filenames from. A `as Manifest` cast over an unvalidated record
  // promised both. They are validated now, and nothing unvalidated survives.
  it('rejects a missing or malformed generatedAt (Attribution prints it verbatim)', () => {
    expect(parseManifest({ ...GOOD, generatedAt: undefined })).toBeNull();
    expect(parseManifest({ ...GOOD, generatedAt: 1737 })).toBeNull();
    expect(parseManifest({ ...GOOD, generatedAt: '   ' })).toBeNull();
  });
  it('rejects missing or malformed sources (the panel reads name + role)', () => {
    expect(parseManifest({ ...GOOD, sources: undefined })).toBeNull();
    expect(parseManifest({ ...GOOD, sources: 'detail' })).toBeNull();
    expect(parseManifest({ ...GOOD, sources: [] })).toBeNull();
    expect(parseManifest({ ...GOOD, sources: [{ name: 'a', role: 'detail' }] })).toBeNull();
    expect(
      parseManifest({
        ...GOOD,
        sources: [{ name: 'a', role: 'detail', bytes: 'many', sha256: 'x' }],
      }),
    ).toBeNull();
    expect(
      parseManifest({
        ...GOOD,
        sources: [{ name: 'a', role: 'detail', bytes: NaN, sha256: 'x' }],
      }),
    ).toBeNull();
    expect(
      parseManifest({
        ...GOOD,
        sources: [{ name: '', role: 'detail', bytes: 1, sha256: 'x' }],
      }),
    ).toBeNull();
  });
  it('rejects a grid whose unchecked strings are absent or wrong-typed', () => {
    expect(parseManifest({ ...GOOD, grid: { ...GOOD.grid, prjWkt: 512 } })).toBeNull();
    expect(
      parseManifest({ ...GOOD, grid: { ...GOOD.grid, flattening: 'zero' } }),
    ).toBeNull();
    expect(
      parseManifest({
        ...GOOD,
        grid: { ...GOOD.grid, radiusMeters: Infinity },
      }),
    ).toBeNull();
  });

  it('returns ONLY validated keys, so no cast can assert an unvalidated field', () => {
    const m = parseManifest({
      ...GOOD,
      // Fields the bake writes but this build never reads: they must not be
      // carried into the typed manifest, because nothing validates them.
      levels: [{ L: 0, cols: 2, rows: 1, mPerPx: 10660.55 }],
      timings: { bakeSeconds: 10680.5 },
      geometryProof: { passed: true, failures: [] },
      albedoHistogram: { level: 3 },
      labels: { total: 9087 },
    })!;
    expect(Object.keys(m).sort()).toEqual([
      'generatedAt',
      'grid',
      'layers',
      'schema',
      'sources',
    ]);
    expect(Object.keys(m.layers).sort()).toEqual(['paper', 'photo']);
    expect(Object.keys(m.layers.paper)).toEqual(['top']);
    expect(m.sources.map((s) => s.role)).toEqual(['detail', 'color', 'labels']);
  });

  it('accepts the REAL baked manifest on disk (validation is not over-strict)', () => {
    const m = parseManifest(JSON.parse(readFileSync('public/tiles/manifest.json', 'utf8')));
    expect(m).not.toBeNull();
    expect(layerTop(m!, 'paper')).toBe(6);
    expect(layerTop(m!, 'photo')).toBe(6);
    expect(m!.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(m!.sources.map((s) => s.role)).toEqual(['detail', 'color', 'labels']);
  });
});

describe('probeAssets', () => {
  it('probes each layer at its own top and the real bottom row', async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        seen.push(path);
        return Promise.resolve({ ok: true, status: 200 });
      }),
    );
    // Distinct tops so a copy/paste of one layer's top onto the other is caught.
    const m = parseManifest({
      ...GOOD,
      layers: { paper: { top: 3 }, photo: { top: 5 } },
    })!;
    await probeAssets(m);

    // 1. unbaked: level 0 exists at all.
    expect(seen).toContain('/tiles/photo/0/0/0.jpg');
    // 2. wrong top level + east seam: PAPER's own top (3) => 2^4=16 cols,
    //    east column 15, and the ACTUAL bottom row 2^3-1 = 7 (not row 0).
    expect(seen).toContain('/tiles/paper/3/15/7.jpg');
    // 3. antimeridian column: PHOTO's own top (5), bottom row 2^5-1 = 31
    //    (the old Math.min(...) collapsed to the equator row 2^4 = 16).
    expect(seen).toContain('/tiles/photo/5/0/31.jpg');

    expect(seen).toHaveLength(3);
    vi.unstubAllGlobals();
  });
});
