import type { Feature } from '@/types';

/**
 * The coordinate frame the whole app is built on (plan Global Constraints,
 * spec §3): planetocentric latitudes on the IAU2000 moon sphere. The feature
 * card prints this sentence for every feature, and the Task 12 dispatch pins
 * it — so it is one exported constant, asserted by test, not prose in JSX.
 */
export const PLANTOCENTRIC_NOTE =
  'Coordinates are planetocentric on the IAU2000 sphere, r = 1,737.4 km.';

/** What the card shows when the gazetteer record itself has no value. */
export const UNKNOWN = 'not recorded';

const MIN = '\u2032'; // prime, for minutes
const DEG = '\u00b0';

/**
 * Signed decimal degrees -> degrees and decimal minutes with a hemisphere
 * letter: 0.6705 -> `0°40.2′N`. A rounded-up 60.0′ carries into the degree so
 * the string can never claim `0°60.0′`.
 */
export function formatDms(deg: number, axis: 'lat' | 'lon'): string {
  const abs = Math.abs(deg);
  let d = Math.floor(abs);
  let m = Math.round((abs - d) * 60 * 10) / 10;
  if (m >= 60) {
    d += 1;
    m = 0;
  }
  const hemi = axis === 'lat' ? (deg < 0 ? 'S' : 'N') : deg < 0 ? 'W' : 'E';
  return `${d}${DEG}${m.toFixed(1).padStart(4, '0')}${MIN}${hemi}`;
}

const num = (v: number, digits: number) => v.toFixed(digits);

export interface CardRow {
  label: string;
  value: string;
  href?: string;
}

export interface CardContent {
  name: string;
  gloss: string;
  rows: CardRow[];
  url: string;
  note: string;
}

/**
 * The feature card's view model, kept out of JSX so the provenance the plan
 * demands (type + descriptor, diameter, planetocentric lat/lon in decimal and
 * degrees/minutes, quadrangle, approval date, mission, gazetteer link, the
 * frame note) is unit-testable without a DOM. Every value is a string: a
 * missing gazetteer field renders as `not recorded`, never `null` or `NaN`.
 */
export function cardContent(f: Feature): CardContent {
  const p = f.properties;
  const [lon, lat] = f.geometry.coordinates;
  const rows: CardRow[] = [
    { label: 'Type', value: `${p.type} (${p.code})` },
    {
      label: 'Diameter',
      value: p.diameterKm === null ? UNKNOWN : `${num(p.diameterKm, 1)} km`,
    },
    {
      label: 'Planetocentric latitude',
      value: `${num(lat, 4)}${DEG} (${formatDms(lat, 'lat')})`,
    },
    {
      label: 'Planetocentric longitude',
      value: `${num(lon, 4)}${DEG} (${formatDms(lon, 'lon')})`,
    },
    {
      label: 'Extent',
      value: p.bbox
        ? `${num(p.bbox[0], 4)}…${num(p.bbox[2], 4)}${DEG}, ${num(p.bbox[1], 4)}…${num(p.bbox[3], 4)}${DEG}`
        : UNKNOWN,
    },
    { label: 'Quadrangle', value: p.quad || UNKNOWN },
    { label: 'Approved', value: p.approval || UNKNOWN },
  ];
  if (p.mission) rows.push({ label: 'Mission', value: p.mission });
  rows.push({ label: 'Gazetteer record', value: p.url, href: p.url });
  return {
    name: p.name,
    gloss: p.gloss,
    rows,
    url: p.url,
    note: PLANTOCENTRIC_NOTE,
  };
}
