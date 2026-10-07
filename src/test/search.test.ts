import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { fuzzySearch, score } from '@/lib/search';
import {
  MAX_H,
  MIN_H,
  clampHeight,
  flyToFeature,
  flyToHeightMeters,
} from '@/lib/cesium/morph';
import { MOON_ELLIPSOID } from '@/lib/cesium/moon';
import type { Feature, FeatureCollection } from '@/types';

const fc = JSON.parse(
  readFileSync('public/data/features.json', 'utf8'),
) as FeatureCollection;

describe('score', () => {
  it('ranks exact above prefix above substring above subsequence', () => {
    expect(score('tycho', 'Tycho')).toBeGreaterThan(score('tycho', 'Tycho Kraemer'));
    expect(score('tycho', 'Tycho Kraemer')).toBeGreaterThanOrEqual(score('tycho', 'ATYCHOX'));
    expect(score('tycho', 'ATYCHOX')).toBeGreaterThan(score('tyc', 'Tycho') * 0 + 1);
    expect(score('zzz', 'Tycho')).toBe(0);
  });
  it('is case-insensitive and punctuation-insensitive', () => {
    expect(score('TYCHO', 'Tycho')).toBe(score('tycho', 'Tycho'));
    expect(score("mare's", "Mare's")).toBeGreaterThan(0);
  });
  // Extra assertions (Task 12): the subsequence fallback is the only branch that
  // can fire on unrelated text, so it is pinned rather than left implicit.
  it('does not score an empty query or an empty candidate', () => {
    expect(score('', 'Tycho')).toBe(0);
    expect(score('tycho', '')).toBe(0);
    expect(score('   ', 'Tycho')).toBe(0);
  });
  it('scores a real subsequence and rejects a scattered one', () => {
    // Tight: every query character is present in order, with no digits faked up.
    expect(score('tco', 'Tycho')).toBeGreaterThan(0);
    // A long eponym gloss is *technically* a scattered subsequence of
    // "apollo 11"; the token guard below must score it 0.
    const scattered =
      'Jean Louis Rodolphe; Swiss zoologist, geologist (1807-1873).';
    expect(score('apollo 11', scattered)).toBe(0);
    expect(score('apollo 11', 'Astronaut-named feature, Apollo 11 site.'))
      .toBeGreaterThan(0);
  });
});

describe('fuzzySearch over the real curated label set', () => {
  it('finds the Sea of Tranquility by latin name', () => {
    expect(fuzzySearch('tranq', fc)[0].properties.name).toBe('Mare Tranquillitatis');
  });
  it('finds it by the English gloss too', () => {
    expect(fuzzySearch('sea of tranquility', fc)[0].properties.name)
      .toBe('Mare Tranquillitatis');
  });
  it('finds the famous craters', () => {
    for (const q of ['tycho', 'copern', 'arista']) {
      expect(fuzzySearch(q, fc)[0].properties.name.length).toBeGreaterThan(3);
    }
  });
  it('finds Apollo 11 by mission, not by a landing-site name', () => {
    const hits = fuzzySearch('apollo 11', fc);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.properties.mission === 'Apollo 11')).toBe(true);
    expect(hits.map((h) => h.properties.name)).toEqual(
      expect.arrayContaining(['West', 'Little West', 'Double', 'Mount Marilyn']),
    );
  });
  it('returns nothing for nonsense and respects the limit', () => {
    expect(fuzzySearch('qxzvjw', fc)).toEqual([]);
    expect(fuzzySearch('mare', fc, 3)).toHaveLength(3);
  });
  it('prefers an important feature for an ambiguous prefix', () => {
    expect(fuzzySearch('m', fc, 5)[0].properties.tier).toBeLessThanOrEqual(1);
  });

  // Extra assertions (Task 12): the mission path is the only route to the
  // Apollo 11 site, so the result set must be *exactly* the four records and
  // nothing else may leak in through the loose matcher.
  it('returns the four Apollo 11 records and nothing else', () => {
    expect(fuzzySearch('apollo 11', fc).map((h) => h.properties.name).sort()).toEqual(
      ['Double', 'Little West', 'Mount Marilyn', 'West'],
    );
    expect(fc.features.filter((f) => f.properties.mission === 'Apollo 11')).toHaveLength(4);
  });

  // Cross-check demanded by the Task 12 dispatch: every Apollo 11 hit must sit
  // inside the bbox of the mare it is named for, and the mare record itself must
  // still carry that bbox.
  it('places every Apollo 11 hit inside Mare Tranquillitatis', () => {
    const mare = fc.features.find(
      (f) => f.properties.name === 'Mare Tranquillitatis',
    ) as Feature;
    const [west, south, east, north] = mare.properties.bbox as [
      number,
      number,
      number,
      number,
    ];
    expect(west).toBeCloseTo(16.924, 3);
    expect(south).toBeCloseTo(-4.0512, 3);
    expect(east).toBeCloseTo(45.4903, 3);
    expect(north).toBeCloseTo(19.3748, 3);
    const hits = fuzzySearch('apollo 11', fc);
    expect(hits).toHaveLength(4);
    for (const h of hits) {
      const [lon, lat] = h.geometry.coordinates;
      expect(lon).toBeGreaterThanOrEqual(west);
      expect(lon).toBeLessThanOrEqual(east);
      expect(lat).toBeGreaterThanOrEqual(south);
      expect(lat).toBeLessThanOrEqual(north);
    }
  });

  // 12 of the 600 records have `bbox: null` (upstream defects). They must stay
  // searchable — the card renders without a bbox row rather than throwing.
  it('searches features whose bbox is null without dropping them', () => {
    const nullBbox = fc.features.filter((f) => f.properties.bbox === null);
    expect(nullBbox.length).toBe(12);
    for (const f of nullBbox.slice(0, 3)) {
      const hit = fuzzySearch(f.properties.name, fc)[0];
      expect(hit.properties.name).toBe(f.properties.name);
      expect(hit.properties.bbox).toBeNull();
    }
  });
});

describe('flyToHeightMeters', () => {
  it('is four diameters, with a 20 km floor', () => {
    expect(flyToHeightMeters(0.1882)).toBe(20_000);
    expect(flyToHeightMeters(60)).toBe(240_000);
    expect(flyToHeightMeters(null)).toBe(240_000); // default diameter 60 km
    expect(flyToHeightMeters(875.74884)).toBeCloseTo(3_502_995, 0);
  });
  it('never leaves the controller limits', () => {
    for (const d of [0, 1, 5_000, 1e6]) {
      const h = flyToHeightMeters(d);
      expect(h).toBeGreaterThanOrEqual(MIN_H);
      expect(h).toBeLessThanOrEqual(MAX_H);
      expect(h).toBe(clampHeight(h));
    }
  });
});

describe('flyToFeature', () => {
  it('flies to the feature position, nadir, on the moon ellipsoid', () => {
    const calls: {
      destination?: Cesium.Cartesian3;
      orientation?: { heading: number; pitch: number; roll: number };
      duration?: number;
    }[] = [];
    const viewer = {
      camera: { flyTo: (opts: (typeof calls)[number]) => calls.push(opts) },
    } as unknown as Cesium.Viewer;
    flyToFeature(viewer, { coordinates: [23.4908, 0.6705], diameterKm: 0.1882 });
    expect(calls).toHaveLength(1);
    const dest = calls[0].destination as Cesium.Cartesian3;
    const cart = MOON_ELLIPSOID.cartesianToCartographic(dest);
    expect(Cesium.Math.toDegrees(cart.longitude)).toBeCloseTo(23.4908, 4);
    expect(Cesium.Math.toDegrees(cart.latitude)).toBeCloseTo(0.6705, 4);
    // 20 km floor for a 188 m crater, measured on the moon radius (1,737.4 km),
    // not WGS84's 6,378 km.
    expect(cart.height).toBeCloseTo(20_000, 3);
    expect(MOON_ELLIPSOID.maximumRadius).toBe(1_737_400);
    expect(calls[0].orientation?.pitch).toBeCloseTo(-Math.PI / 2);
    expect(calls[0].orientation?.heading).toBe(0);
    expect(calls[0].duration).toBeGreaterThan(0);
  });
});
