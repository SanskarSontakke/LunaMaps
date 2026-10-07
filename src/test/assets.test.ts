import { describe, expect, it, vi } from 'vitest';
import { layerTop, parseManifest, probeAssets } from '@/lib/assets';

// A complete manifest the app actually depends on. `parseManifest` validates
// every field the renderer reads, so this is the minimum a good manifest needs.
const GOOD = {
  schema: 1,
  grid: {
    tileSize: 512,
    yOrigin: 'north',
    radiusMeters: 1_737_400,
    lonDomain: '180',
    latitudeType: 'planetocentric',
  },
  layers: { paper: { top: 6 }, photo: { top: 6 } },
};

describe('parseManifest', () => {
  it('accepts a well-formed manifest', () => {
    const m = parseManifest(GOOD);
    expect(m).not.toBeNull();
    expect(layerTop(m!, 'photo')).toBe(6);
  });
  it('rejects a foreign tile size instead of silently mis-rendering', () => {
    expect(parseManifest({ ...GOOD, grid: { tileSize: 256, yOrigin: 'north' } }))
      .toBeNull();
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
  it('rejects a top outside 0..7', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 8 }, photo: { top: 6 } } }),
    ).toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: -1 }, photo: { top: 6 } } }),
    ).toBeNull();
  });
  it('validates BOTH layers, not just paper', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 6 }, photo: { top: 8 } } }),
    ).toBeNull();
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 6 }, photo: {} } }),
    ).toBeNull();
  });
  it('accepts the ends of the valid top range (0 and 7)', () => {
    expect(
      parseManifest({ ...GOOD, layers: { paper: { top: 0 }, photo: { top: 7 } } }),
    ).not.toBeNull();
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
