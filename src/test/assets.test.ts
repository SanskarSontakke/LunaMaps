import { describe, expect, it } from 'vitest';
import { layerTop, parseManifest } from '@/lib/assets';

const GOOD = {
  schema: 1,
  grid: { tileSize: 512, yOrigin: 'north' },
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
});
