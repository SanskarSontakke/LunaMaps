import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GAZETTEER_HTTP_HOSTS,
  parseFeatureCollection,
  safeGazetteerUrl,
  validateFeatureCollection,
  type FeaturesResult,
} from '@/lib/features';
import { fuzzySearch } from '@/lib/search';
import { cardContent } from '@/lib/provenance';
import type { Feature, FeatureCollection } from '@/types';

/**
 * `features.json` is the last product input that reached a component on a cast.
 * `manifest.json` has `parseManifest`; the gazetteer had `.json()` plus
 * `(fc: FeatureCollection) =>`, which asserts a type instead of earning one.
 * These tests are the predicate's own contract, and they are written to fail for
 * any value — the mistake `urlState.test.ts` made with `DEFAULT_VIEW.height`.
 */

/** The file the app actually fetches, parsed as the browser would get it. */
const shipped = JSON.parse(
  readFileSync('public/data/features.json', 'utf8'),
) as unknown;

/** One complete, legal feature: the baseline every case below mutates. */
const goodProperties = {
  name: 'Tycho',
  gloss: 'Crater named for Tycho Brahe.',
  type: 'Crater, crateres',
  code: 'CR',
  tier: 1,
  diameterKm: 85.0,
  bbox: [-18.0, -45.5, -14.0, -41.5],
  quad: 'LAC-78',
  approval: '1973/01/01',
  mission: null,
  url: 'https://planetarynames.wr.usgs.gov/Feature/6009',
};

const goodFeature = (over: Record<string, unknown> = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-16.0, -43.5] },
  properties: { ...goodProperties, ...over },
});

/** Generic so a test that reaches into the *input* still has a type to reach
 *  with — the copy/no-alias assertions below are about the input's identity. */
const collection = <T extends unknown[]>(features: T) => ({
  type: 'FeatureCollection',
  features,
});

const accepted = (value: unknown): FeatureCollection | null =>
  parseFeatureCollection(value);

const refusal = (value: unknown): string | null => {
  const result = validateFeatureCollection(value);
  return result.ok ? null : result.reason;
};

describe('the shipped gazetteer passes, and comes out https', () => {
  it('is accepted whole, with every feature kept', () => {
    const result = validateFeatureCollection(shipped);
    if (!result.ok) throw new Error(result.reason);
    const raw = shipped as { features: unknown[] };
    expect(raw.features.length).toBeGreaterThan(1_000);
    expect(result.value.features).toHaveLength(raw.features.length);
  });

  it('upgrades the http record it is given, and only that record', () => {
    // The input really is plain http (that is the string the IAU shapefile's
    // `link` column carries), so the upgrade is what makes 1,585 gazetteer links
    // safe to render instead of a reason to refuse all of them.
    const raw = shipped as {
      features: { properties: { url: string } }[];
    };
    expect(raw.features.every((f) => f.properties.url.startsWith('http://'))).toBe(
      true,
    );
    const result = validateFeatureCollection(shipped);
    if (!result.ok) throw new Error(result.reason);
    expect(
      result.value.features.every((f) => f.properties.url.startsWith('https://')),
    ).toBe(true);
    // The host that earns the upgrade is named, not inferred from the data.
    expect(GAZETTEER_HTTP_HOSTS).toEqual(['planetarynames.wr.usgs.gov']);
  });

  it('still feeds the search and the card the shape they expect', () => {
    const fc = accepted(shipped);
    if (!fc) throw new Error('the shipped gazetteer must validate');
    const hits = fuzzySearch('tycho', fc);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].properties.name).toMatch(/Tycho/);
    const card = cardContent(hits[0]);
    expect(card.url.startsWith('https://')).toBe(true);
    // The card's only link is the row provenance.ts gives an `href` — that is the
    // `<a href>` the scheme check exists to protect.
    const link = card.rows.find((r) => r.href !== undefined);
    expect(link?.href).toBe(card.url);
  });
});

describe('the url predicate: only https reaches an href', () => {
  it.each([
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['\x09javascript:alert(1)'],
    [' javascript:alert(1)'],
    // Browsers strip control characters from a URL *before* resolving it, so a
    // string-level check passes this and an href-level one runs it. Parsing first
    // is what makes the refused thing the executed thing.
    ['java\nscript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox'],
    ['file:///C:/Windows/win.ini'],
    ['//evil.example/x'],
    ['/Feature/6009'],
    ['planetarynames.wr.usgs.gov/Feature/6009'],
    [''],
    ['   '],
    // Plain http on a host nobody verified: refused, not rewritten.
    ['http://evil.example/Feature/1'],
    // The suffix attack on the allowlisted host.
    ['http://planetarynames.wr.usgs.gov.evil.example/Feature/1'],
    ['http://evil.example/?redirect=http://planetarynames.wr.usgs.gov/Feature/1'],
    // Credentials in an "https" URL are not a citation, they are a leak.
    ['https://admin:pw@planetarynames.wr.usgs.gov/Feature/1'],
  ])('refuses %s', (raw) => {
    expect(safeGazetteerUrl(raw)).toBeNull();
    expect(refusal(collection([goodFeature({ url: raw })]))).toContain('properties.url');
  });

  it('accepts https anywhere and upgrades http only where it is verified', () => {
    expect(safeGazetteerUrl('https://planetarynames.wr.usgs.gov/Feature/5566')).toBe(
      'https://planetarynames.wr.usgs.gov/Feature/5566',
    );
    expect(safeGazetteerUrl('http://planetarynames.wr.usgs.gov/Feature/5566')).toBe(
      'https://planetarynames.wr.usgs.gov/Feature/5566',
    );
    expect(safeGazetteerUrl('HTTP://PlanetaryNames.wr.usgs.gov/Feature/5566')).toBe(
      'https://planetarynames.wr.usgs.gov/Feature/5566',
    );
    expect(safeGazetteerUrl('  https://example.org/a  ')).toBe('https://example.org/a');
    // The string emitted is the parsed URL's own serialisation, so it is the value
    // that was checked rather than the value that was typed.
    expect(safeGazetteerUrl('https://example.org/a%20b?q=1#f')).toBe(
      'https://example.org/a%20b?q=1#f',
    );
  });

  it('refuses a non-string url at all', () => {
    for (const bad of [undefined, null, 42, {}, ['https://a.example']]) {
      expect(safeGazetteerUrl(bad)).toBeNull();
    }
  });
});

describe('the fields every downstream consumer reads', () => {
  it('accepts the untouched baseline', () => {
    expect(accepted(collection([goodFeature()]))).not.toBeNull();
  });

  it('rejects a geometry the renderer cannot place', () => {
    for (const coordinates of [
      [200, 0],
      [0, 91],
      [-181, 0],
      [10, 20, 30],
      [10],
      ['10', '20'],
      [Number.NaN, 20],
      [Number.POSITIVE_INFINITY, 20],
      null,
    ]) {
      expect(
        parseFeatureCollection(
          collection([
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates },
              properties: { ...goodProperties },
            },
          ]),
        ),
      ).toBeNull();
    }
    expect(
      refusal(
        collection([
          { type: 'Feature', geometry: { type: 'Polygon', coordinates: [] }, properties: { ...goodProperties } },
        ]),
      ),
    ).toContain('geometry.type');
    expect(
      refusal(collection([{ type: 'Feature', properties: { ...goodProperties } }])),
    ).toContain('geometry');
  });

  it('rejects a name the labels and the URL would route on', () => {
    for (const name of ['', '   ', undefined, 42, null]) {
      expect(refusal(collection([goodFeature({ name })]))).toContain('name');
    }
  });

  it('rejects a tier outside 0..3, which is what search ranks and tiers gate on', () => {
    for (const tier of [-1, 4, 1.5, '1', null, undefined, true]) {
      expect(refusal(collection([goodFeature({ tier })]))).toContain('tier');
    }
    expect(refusal(collection([goodFeature({ tier: 0 })]))).toBeNull();
    expect(refusal(collection([goodFeature({ tier: 3 })]))).toBeNull();
  });

  it('rejects the type and code the result list prints', () => {
    for (const type of ['', '  ', null, 7, undefined]) {
      expect(refusal(collection([goodFeature({ type })]))).toContain('type');
    }
    expect(refusal(collection([goodFeature({ code: '' })]))).toContain('code');
  });

  it('accepts nulls that are real gazetteer states and rejects ones that are not', () => {
    expect(refusal(collection([goodFeature({ diameterKm: null, bbox: null })]))).toBeNull();
    expect(refusal(collection([goodFeature({ mission: null })]))).toBeNull();
    expect(refusal(collection([goodFeature({ diameterKm: 0 })]))).toBeNull();
    expect(refusal(collection([goodFeature({ diameterKm: -1 })]))).toContain('diameterKm');
    expect(refusal(collection([goodFeature({ diameterKm: '85' })]))).toContain('diameterKm');
    expect(refusal(collection([goodFeature({ bbox: [1, 2, 3] })]))).toContain('bbox');
    expect(refusal(collection([goodFeature({ bbox: [200, 0, 0, 0] })]))).toContain('bbox');
    expect(refusal(collection([goodFeature({ mission: 'Apollo 11' })]))).toBeNull();
    expect(refusal(collection([goodFeature({ mission: '' })]))).toContain('mission');
    expect(refusal(collection([goodFeature({ quad: '' })]))).toContain('quad');
    expect(refusal(collection([goodFeature({ approval: '' })]))).toContain('approval');
    expect(refusal(collection([goodFeature({ gloss: '' })]))).toContain('gloss');
  });

  it('rejects a feature that is not a Feature', () => {
    expect(refusal(collection([{ ...goodFeature(), type: 'feature' }]))).toContain('type is not "Feature"');
    expect(refusal(collection(['nope']))).toContain('not an object');
    expect(refusal(collection([null]))).toContain('not an object');
  });
});

describe('a broken gazetteer is refused whole, never partly', () => {
  it('refuses the collection because of one unusable feature', () => {
    const mixed = collection([
      goodFeature(),
      goodFeature({ name: 'Tycho Brahe' }),
      goodFeature(),
      goodFeature({ name: 'Bad Link', url: 'javascript:alert(1)' }),
      goodFeature(),
    ]);
    expect(accepted(mixed)).toBeNull();
    // Named and indexed, so the dev console points at the line that broke rather
    // than at "the file was invalid".
    expect(refusal(mixed)).toContain('feature 3');
    expect(refusal(mixed)).toContain('"Bad Link"');
    expect(refusal(mixed)).toContain('properties.url');
  });

  it('refuses the shapes a wrong pipeline step would produce', () => {
    expect(refusal(collection([]))).toContain('empty');
    expect(refusal({ features: [] })).toContain('FeatureCollection');
    expect(refusal({ type: 'FeatureCollection', features: 'x' })).toContain('array');
    expect(refusal(null)).toContain('not an object');
    expect(refusal([])).toContain('not an object');
    // A bare feature where a collection was expected: the type is the failure.
    expect(refusal(goodFeature())).toContain('FeatureCollection');
  });
});

describe('the returned object is built from what passed', () => {
  it('copies rather than casts: no alias, no extra keys', () => {
    const input = collection([goodFeature({ note: 'a key nothing declared' })]);
    const result = validateFeatureCollection(input) as Extract<
      FeaturesResult,
      { ok: true }
    >;
    expect(result.ok).toBe(true);
    const out = result.value.features[0];
    expect(result.value).not.toBe(input);
    expect(result.value.features).not.toBe(input.features);
    expect(out).not.toBe(input.features[0]);
    expect(out.properties).not.toBe(input.features[0].properties);
    expect(out.geometry.coordinates).not.toBe(input.features[0].geometry.coordinates);
    expect(Object.keys(out.properties)).toEqual(Object.keys(goodProperties));
    expect('note' in out.properties).toBe(false);
    // Mutating the parsed input afterwards cannot reach the checked copy.
    (input.features[0].geometry.coordinates as number[])[0] = 123;
    (input.features[0].properties as Record<string, unknown>).name = 'Rewritten';
    expect(out.geometry.coordinates[0]).toBe(-16.0);
    expect(out.properties.name).toBe('Tycho');
  });

  it('MoonMap reads the gazetteer through the validator, not through a cast', () => {
    const src = readFileSync(
      resolve(__dirname, '../components/MoonMap.tsx'),
      'utf8',
    );
    expect(src).toMatch(/validateFeatureCollection\(json\)/);
    expect(src).toMatch(/\.then\(\(json: unknown\) =>/);
    // The assertion this replaces. A `: FeatureCollection` parameter annotation on
    // the `.json()` body is the same lie as a cast.
    expect(src).not.toMatch(/as FeatureCollection/);
    expect(src).not.toMatch(/\(fc: FeatureCollection\)/);
  });
});

/** Keeps the type import honest: the tests above speak in the app's own types. */
describe('the checked collection satisfies the app types', () => {
  it('hands a Feature whose declared fields the consumers can read', () => {
    const fc = accepted(shipped);
    const first: Feature | undefined = fc?.features[0];
    expect(first?.type).toBe('Feature');
    const props: Feature['properties'] | undefined = first?.properties;
    expect(typeof props?.tier).toBe('number');
    expect((fc as FeatureCollection | null)?.features.length).toBeGreaterThan(0);
  });
});
