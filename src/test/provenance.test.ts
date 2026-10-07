import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PLANTOCENTRIC_NOTE,
  cardContent,
  formatDms,
} from '@/lib/provenance';
import type { Feature, FeatureCollection } from '@/types';

const fc = JSON.parse(
  readFileSync('public/data/features.json', 'utf8'),
) as FeatureCollection;

const find = (name: string) =>
  fc.features.find((f) => f.properties.name === name) as Feature;

const value = (f: Feature, label: string) =>
  cardContent(f).rows.find((r) => r.label === label)?.value;

describe('the planetocentric note', () => {
  // The card must print this sentence; the feature card renders
  // `cardContent().note`, so pinning the string here pins what is printed.
  it('states the frame, the sphere and the radius', () => {
    expect(PLANTOCENTRIC_NOTE).toContain('planetocentric');
    expect(PLANTOCENTRIC_NOTE).toContain('IAU2000');
    expect(PLANTOCENTRIC_NOTE).toContain('1,737.4 km');
    expect(cardContent(find('Mare Tranquillitatis')).note).toBe(PLANTOCENTRIC_NOTE);
  });
});

describe('formatDms', () => {
  it('splits signed degrees into degrees and decimal minutes', () => {
    expect(formatDms(0.6705, 'lat')).toBe("0\u00b040.2\u2032N");
    expect(formatDms(23.4908, 'lon')).toBe("23\u00b029.4\u2032E");
    expect(formatDms(-4.0512, 'lat')).toBe("4\u00b003.1\u2032S");
    expect(formatDms(0, 'lat')).toBe("0\u00b000.0\u2032N");
  });
  it('carries a rounded-up minute into the degree', () => {
    expect(formatDms(0.99999, 'lat')).toBe("1\u00b000.0\u2032N");
    expect(formatDms(-89.99999, 'lat')).toBe("90\u00b000.0\u2032S");
  });
});

describe('cardContent', () => {
  it('titles the feature and subtitled its English gloss', () => {
    const c = cardContent(find('Mare Tranquillitatis'));
    expect(c.name).toBe('Mare Tranquillitatis');
    expect(c.gloss).toBe('Sea of Tranquility.');
  });
  it('prints type + descriptor code, diameter, both coordinates, quad and approval', () => {
    const c = cardContent(find('Mare Tranquillitatis'));
    expect(value(find('Mare Tranquillitatis'), 'Type')).toBe('Mare, maria (ME)');
    expect(value(find('Mare Tranquillitatis'), 'Diameter')).toBe('875.7 km');
    expect(value(find('Mare Tranquillitatis'), 'Quadrangle')).toBe('LAC-61');
    expect(value(find('Mare Tranquillitatis'), 'Approved')).toBe(
      find('Mare Tranquillitatis').properties.approval,
    );
    expect(find('Mare Tranquillitatis').properties.approval).toMatch(
      /^\d{4}[-/]\d{2}[-/]\d{2}$/,
    );
    expect(value(find('Mare Tranquillitatis'), 'Planetocentric latitude')).toBe(
      '8.3487\u00b0 (8\u00b020.9\u2032N)',
    );
    expect(value(find('Mare Tranquillitatis'), 'Planetocentric longitude')).toBe(
      '30.8346\u00b0 (30\u00b050.1\u2032E)',
    );
    expect(c.url).toBe('http://planetarynames.wr.usgs.gov/Feature/3691');
    expect(c.rows.map((r) => r.label)).not.toContain('Mission');
  });
  it('shows the mission only for visit features', () => {
    expect(value(find('West'), 'Mission')).toBe('Apollo 11');
    expect(value(find('West'), 'Diameter')).toBe('0.2 km');
    expect(value(find('West'), 'Quadrangle')).toBe('LAC-60');
    // Every Apollo 11 site coordinate is inside the mare's own bbox.
    const [lon, lat] = find('West').geometry.coordinates;
    const [w, s, e, n] = find('Mare Tranquillitatis').properties.bbox as [
      number,
      number,
      number,
      number,
    ];
    expect(lon).toBeGreaterThan(w);
    expect(lon).toBeLessThan(e);
    expect(lat).toBeGreaterThan(s);
    expect(lat).toBeLessThan(n);
  });
  it('degrades honestly when the upstream bbox or diameter is missing', () => {
    const broken = fc.features.find((f) => f.properties.bbox === null) as Feature;
    const c = cardContent(broken);
    expect(value(broken, 'Extent')).toBe('not recorded');
    expect(c.note).toBe(PLANTOCENTRIC_NOTE);
    expect(c.rows.every((r) => typeof r.value === 'string' && r.value.length > 0))
      .toBe(true);
    const noDiameter = { ...broken, properties: { ...broken.properties, diameterKm: null } };
    expect(value(noDiameter as Feature, 'Diameter')).toBe('not recorded');
  });
  it('links out to the gazetteer record', () => {
    const c = cardContent(find('Double'));
    const link = c.rows.find((r) => r.href);
    expect(link?.href).toBe('http://planetarynames.wr.usgs.gov/Feature/15616');
    expect(link?.value).toBe('http://planetarynames.wr.usgs.gov/Feature/15616');
    expect(c.url).toBe('http://planetarynames.wr.usgs.gov/Feature/15616');
  });
});
