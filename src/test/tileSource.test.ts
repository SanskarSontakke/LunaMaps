import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_TILES_BASE,
  TILES_BASE,
  manifestUrl,
  resolveTilesBase,
  tilePath,
  tileTemplate,
  tilesAreRemote,
} from '@/lib/tileSource';
import { ManifestError } from '@/lib/manifestError';
import { parseManifest } from '@/lib/assets';

/**
 * Where the imagery lives is one question with one answer, and the answer is built
 * from a build-time environment variable — which means the wrong value does not fail
 * loudly at build time, it fails as 404s in front of a user. So the normalisation is
 * tested directly, including the two rejections that matter: `http:` under an `https:`
 * page (mixed content, blocked mid-render) and any other scheme.
 */
describe('the tile base resolves from one env var and nothing else', () => {
  it('defaults to the same-origin local pyramid, which is how the app was designed', () => {
    expect(TILES_BASE).toBe(LOCAL_TILES_BASE);
    expect(tilesAreRemote()).toBe(false);
    expect(resolveTilesBase(undefined)).toBe('/tiles');
    expect(resolveTilesBase('')).toBe('/tiles');
    expect(resolveTilesBase('   ')).toBe('/tiles');
  });

  it('keeps a root-relative prefix and trims trailing slashes', () => {
    expect(resolveTilesBase('/cdn/tiles')).toBe('/cdn/tiles');
    expect(resolveTilesBase('  /cdn/tiles/  ')).toBe('/cdn/tiles');
    expect(resolveTilesBase('/')).toBe(LOCAL_TILES_BASE);
  });

  it('keeps an https store origin, with or without a path', () => {
    expect(resolveTilesBase('https://tiles.example.test/moon')).toBe(
      'https://tiles.example.test/moon',
    );
    expect(resolveTilesBase('https://tiles.example.test/')).toBe(
      'https://tiles.example.test',
    );
  });

  it('refuses http and any other scheme rather than letting the browser block it later', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['http://tiles.example.test', 'javascript:alert(1)', 'tiles.example.com']) {
      expect(resolveTilesBase(bad)).toBe(LOCAL_TILES_BASE);
    }
    expect(warn).toHaveBeenCalledTimes(3);
    // The warning names the bad value and the fallback, because a silent fallback is
    // indistinguishable from "there is no imagery" once the map is blank.
    expect(warn.mock.calls[0][0]).toContain('http://tiles.example.test');
    expect(warn.mock.calls[0][0]).toContain('/tiles');
    warn.mockRestore();
  });

  it('builds the three shapes every consumer needs, all from the same base', () => {
    expect(manifestUrl()).toBe('/tiles/manifest.json');
    expect(tilePath('photo', 7, 100, 64)).toBe('/tiles/photo/7/100/64.jpg');
    expect(tileTemplate('ortho')).toBe('/tiles/ortho/{z}/{x}/{y}.jpg');
    // The template is Cesium's substitution syntax; the path is what a probe fetches.
    // They must agree on layout or `probeAssets` checks a different file than the
    // provider requests, which is how "available" and "404" end up both true.
    expect(tileTemplate('ortho').replace('{z}', '9').replace('{x}', '1').replace('{y}', '2'))
      .toBe(tilePath('ortho', 9, 1, 2));
  });
});

describe('the manifest error carries the routing decision, not a sentence', () => {
  it('records kind, status and the URL that was asked for', () => {
    const e = new ManifestError('http', 'manifest.json HTTP 404', {
      status: 404,
      url: 'https://tiles.example.test/manifest.json',
    });
    expect(e.kind).toBe('http');
    expect(e.status).toBe(404);
    expect(e.url).toBe('https://tiles.example.test/manifest.json');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ManifestError');
  });

  it('does not invent fields nobody passed', () => {
    const e = new ManifestError('incompatible', 'nope');
    expect('status' in e).toBe(false);
    expect('url' in e).toBe(false);
  });
});

/**
 * A malformed OPTIONAL block must not take the base layers with it. This is the defect
 * the whole-branch review found and the reason `parseManifest` no longer returns null
 * for a bad `layers.ortho`: one out-of-range range meant "manifest.json is not
 * compatible with this build", and the panel offered `npm run bake` as the cure for a
 * file that was baked and merely misspelled.
 */
describe('a bad ortho record degrades the overlay instead of bricking the map', () => {
  const base = () => ({
    schema: 1,
    generatedAt: '2026-10-09T00:00:00+00:00',
    grid: {
      tileSize: 512,
      colsFactor: '2^(L+1)',
      rowsFactor: '2^L',
      yOrigin: 'north',
      lonDomain: '180',
      latitudeType: 'planetocentric',
      radiusMeters: 1737400,
      flattening: 0,
      prjWkt: 'GEOGCS[Moon]',
    },
    sources: [{ name: 'x', role: 'detail', sha256: 'a'.repeat(64), bytes: 1 }],
    layers: {
      paper: { top: 7 },
      photo: { top: 7 },
      ortho: { top: 10, availability: { '10': [[0, 1, 0, 1]] }, source: 'kaguya-tc' },
    },
  });

  it('keeps the record when it is well formed, and carries its source', () => {
    const m = parseManifest(base());
    expect(m).not.toBeNull();
    expect(m?.layers.ortho).toEqual({ top: 10, availability: { '10': [[0, 1, 0, 1]] }, source: 'kaguya-tc' });
    expect(m?.warnings).toBeUndefined();
  });

  it('drops an unusable record but boots the base layers, saying why', () => {
    const broken = [
      { top: 10, availability: { '10': [[0, 99999, 0, 1]] } }, // outside the L10 grid
      { top: 10, availability: { '9': [] } },                   // level with no tiles
      { top: 42, availability: {} },                            // top above the ceiling
      { availability: { '8': [[0, 1, 0, 1]] } },                // no top at all
      'not a record',
    ];
    for (const ortho of broken) {
      const m = parseManifest({ ...base(), layers: { ...base().layers, ortho } });
      expect(m, JSON.stringify(ortho)).not.toBeNull();
      expect(m?.layers.paper).toEqual({ top: 7 });
      expect(m?.layers.photo).toEqual({ top: 7 });
      expect(m?.layers.ortho).toBeUndefined();
      expect(m?.warnings?.length, JSON.stringify(ortho)).toBe(1);
    }
  });

  it('does not claim a layer the build threw away', () => {
    // The contradiction worth pinning: `warnings` without an `ortho`, and an `ortho`
    // without a warning, are both states a later reader would misread as intent.
    const m = parseManifest({
      ...base(),
      layers: { ...base().layers, ortho: { top: 10, availability: { '10': [] } } },
    });
    expect(m?.layers.ortho).toBeUndefined();
    expect(m?.warnings).toBeDefined();
    const good = parseManifest(base());
    expect(good?.warnings).toBeUndefined();
    expect(good?.layers.ortho).toBeDefined();
  });

  it('leaves an absent record silent, which is the local-first default', () => {
    const none = { ...base(), layers: { paper: { top: 7 }, photo: { top: 7 } } };
    const m = parseManifest(none);
    // Explicitly non-null: every `m?.` assertion below would otherwise pass on a
    // manifest the validator refused outright, which is how this fixture's own
    // missing `role` field made three of these tests green while proving nothing.
    expect(m).not.toBeNull();
    expect(m?.layers.ortho).toBeUndefined();
    expect(m?.warnings).toBeUndefined();
  });

  it('refuses the file for a broken BASE contract, as it always did', () => {
    // The degradation is scoped to the optional layer: `paper`/`photo` are not
    // optional, and a manifest missing or misspelling one must be refused outright,
    // not half-loaded.
    const boots = [
      { paper: { top: 7 }, photo: { top: 7 }, ortho: { top: 10, availability: {} } },
    ];
    for (const layers of boots) {
      const m = parseManifest({ ...base(), layers });
      expect(m).not.toBeNull();
      expect(m?.warnings).toBeUndefined(); // an empty record is empty, not broken
    }
    for (const layers of [
      { photo: { top: 7 } },
      { paper: { top: 7 } },
      { paper: { top: 99 }, photo: { top: 7 } },
      { paper: { top: 7 }, photo: { top: null } },
      {},
    ]) {
      expect(parseManifest({ ...base(), layers }), JSON.stringify(layers)).toBeNull();
    }
  });
});
