import type { Feature, FeatureCollection, FeatureProps, Tier } from '@/types';

/**
 * The validator for `public/data/features.json` — the one product input this app
 * reads that had no predicate at all.
 *
 * `src/types.ts` promises that "every field modelled here is verified before the
 * value reaches a component, so no consumer can read an asserted-but-unchecked
 * field". `manifest.json` had that (`parseManifest`, src/lib/assets.ts).
 * `features.json` did not: `MoonMap` did `.json()` and a typed `.then((fc:
 * FeatureCollection) => …)`, which is an assertion, not a check. Every field of
 * `FeatureProps` is read somewhere — `labels/entities.ts` destructures
 * `geometry.coordinates` into `Cesium.Cartesian3.fromDegrees`, `search.ts` scores
 * `name`/`gloss`/`type`/`mission` and sorts on `tier`, `provenance.ts` prints
 * `diameterKm`/`bbox`/`quad`/`approval` and puts `url` into an `<a href>` — so
 * every one of them is checked here, and the returned object is built field by
 * field out of values that each passed a predicate. There is no cast, so the type
 * cannot claim more than was verified (the same discipline `assets.ts` uses).
 *
 * Two rules decide the shape:
 *
 * 1. **Refuse the collection, not the feature.** `features.json` is one file the
 *    bake writes; a half-accepted gazetteer is a partial lie — labels that skip
 *    names the user can see on the map, a search that cannot find a crater that is
 *    drawn. `MoonMap` already degrades honestly when this returns null (the
 *    "place names unavailable" status, search and labels off, map still usable),
 *    and that is a truer answer than a silent subset.
 * 2. **Nothing reaches an `<a href>` unless it is https.** `provenance.ts` renders
 *    `properties.url` as the *only* link in the card. `javascript:alert(1)` is a
 *    legal JSON string and a live XSS through `<a href>`; so is
 *    `java\nscript:alert(1)`, because browsers strip control characters from URLs
 *    *after* a string-level check has passed. That is why the check parses with
 *    `URL` first (so the scheme it inspects is the one the browser would use) and
 *    then emits the parsed URL's own serialisation, never the input text.
 */

/** The tiers `search.ts` ranks on and `labels/tiers.ts` gates visibility by. */
export const TIER_MIN: Tier = 0;
export const TIER_MAX: Tier = 3;

/**
 * Hosts whose plain-`http` gazetteer record may be upgraded to `https`.
 *
 * The shipped file is 1,585 `http://planetarynames.wr.usgs.gov/Feature/<id>`
 * links, because that is the string the IAU shapefile's `link` field carries.
 * Requiring https outright would therefore refuse the whole gazetteer — the app
 * would lose every place name to satisfy a rule about a host that does serve
 * https. So the upgrade is explicit, host-by-host, and verified: this host
 * answers `200` directly over https (its `http` form answers `301` to the same
 * URL). A plain-`http` link to any other host is refused, not rewritten, because
 * "we upgraded it and it worked" is a claim nobody here can make.
 */
export const GAZETTEER_HTTP_HOSTS: readonly string[] = ['planetarynames.wr.usgs.gov'];

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string that is not blank: every text field this file renders or searches. */
const isText = (v: unknown): v is string =>
  typeof v === 'string' && v.trim() !== '';

/** A real finite number — not a numeric string, not NaN, not an Infinity. */
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A lon/lat pair in the ranges the app's tiling scheme can place. */
const isLonLat = (v: unknown): v is [number, number] =>
  Array.isArray(v) &&
  v.length === 2 &&
  isNum(v[0]) &&
  isNum(v[1]) &&
  Math.abs(v[0]) <= 180 &&
  Math.abs(v[1]) <= 90;

/** `[west, south, east, north]` — the extent `provenance.ts` prints. */
const isBbox = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) &&
  v.length === 4 &&
  v.every((n) => isNum(n)) &&
  Math.abs(v[0]) <= 180 &&
  Math.abs(v[2]) <= 180 &&
  Math.abs(v[1]) <= 90 &&
  Math.abs(v[3]) <= 90;

const isTier = (v: unknown): v is Tier =>
  isInt(v) && v >= TIER_MIN && v <= TIER_MAX;

/**
 * The one field with a security consequence: the card's `href`.
 *
 * Returns the URL to render, or `null` for "this feature cannot be shown". The
 * parse happens first so the scheme compared is the scheme a browser would use
 * (control characters and surrounding whitespace are removed by the URL parser
 * itself), credentials are refused, and the emitted string is the parsed URL's
 * serialisation rather than the input, so what was checked is what is written.
 */
export function safeGazetteerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    // Relative, protocol-relative, or not a URL at all. The card must never turn
    // a bare word into a link, and this app is local-first: a link it cannot name
    // absolutely is not a citation.
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.href;
  if (
    url.protocol === 'http:' &&
    GAZETTEER_HTTP_HOSTS.includes(url.hostname.toLowerCase())
  ) {
    url.protocol = 'https:';
    return url.href;
  }
  // `javascript:`, `data:`, `vbscript:`, `file:`, `blob:`, `about:`, any other
  // scheme, and plain http on a host nobody verified: refused.
  return null;
}

export interface FeaturesAccepted {
  ok: true;
  value: FeatureCollection;
}

export interface FeaturesRefused {
  ok: false;
  /** Why the file was refused, naming the feature and the field, so the dev
   *  console can say which line of the gazetteer broke rather than "it failed". */
  reason: string;
}

export type FeaturesResult = FeaturesAccepted | FeaturesRefused;

/** The guard that keeps `validateFeatureCollection` cast-free: a refused feature
 *  is a branch, and anything left over is one the validator itself built. */
const isRefused = (v: Feature | FeaturesRefused): v is FeaturesRefused =>
  'ok' in v && v.ok === false;

const refuse = (index: number | null, field: string, name?: string): FeaturesRefused => ({
  ok: false,
  reason:
    `features.json: ${index === null ? 'the collection' : `feature ${index}${
      name ? ` "${name}"` : ''
    }`} — ${field}`,
});

/** Validate one feature and return the checked copy, or a refusal. */
function checkFeature(raw: unknown, index: number): Feature | FeaturesRefused {
  if (!isRecord(raw)) return refuse(index, 'is not an object');
  if (raw.type !== 'Feature') return refuse(index, 'type is not "Feature"');

  const geometry = raw.geometry;
  if (!isRecord(geometry)) return refuse(index, 'has no geometry object');
  if (geometry.type !== 'Point') return refuse(index, 'geometry.type is not "Point"');
  const { coordinates } = geometry;
  if (!isLonLat(coordinates)) {
    return refuse(index, 'geometry.coordinates is not a finite lon/lat pair');
  }

  const properties = raw.properties;
  if (!isRecord(properties)) return refuse(index, 'has no properties object');
  const { name, gloss, type, code, tier, quad, approval } = properties;
  const { diameterKm, bbox, mission, url } = properties;

  if (!isText(name)) return refuse(index, 'properties.name is missing or blank');
  if (!isText(gloss)) return refuse(index, 'properties.gloss is missing or blank', name);
  // `search.ts` scores this field and `SearchBox` shows it as the result kind.
  if (!isText(type)) return refuse(index, 'properties.type is missing or blank', name);
  if (!isText(code)) return refuse(index, 'properties.code is missing or blank', name);
  // `search.ts` ranks on it and `labels/tiers.ts` gates who may be drawn at all.
  if (!isTier(tier)) {
    return refuse(index, `properties.tier ${JSON.stringify(tier)} is not an integer 0..3`, name);
  }

  // A crater with no recorded diameter is a real gazetteer state, so null is
  // legal; a negative or non-numeric one is not. Both `tierPriority` and the
  // importance term in `fuzzySearch` do arithmetic on this value.
  let diameter: number | null;
  if (diameterKm === null) diameter = null;
  else if (!isNum(diameterKm)) {
    return refuse(index, 'properties.diameterKm is neither null nor a number', name);
  } else if (diameterKm < 0) {
    return refuse(index, 'properties.diameterKm is negative', name);
  } else diameter = diameterKm;

  let extent: [number, number, number, number] | null;
  if (bbox === null) extent = null;
  else if (!isBbox(bbox)) {
    return refuse(index, 'properties.bbox is neither null nor 4 finite lon/lat values', name);
  } else extent = bbox;

  let missionName: string | null;
  if (mission === null) missionName = null;
  else if (!isText(mission)) {
    return refuse(index, 'properties.mission is neither null nor text', name);
  } else missionName = mission;

  if (!isText(quad)) return refuse(index, 'properties.quad is missing or blank', name);
  if (!isText(approval)) return refuse(index, 'properties.approval is missing or blank', name);

  const checkedUrl = safeGazetteerUrl(url);
  if (checkedUrl === null) {
    return refuse(
      index,
      'properties.url is not an https link (only https reaches the card’s href)',
      name,
    );
  }

  // Built from the values that passed, in the order `FeatureProps` declares, and
  // from no other source: the bake writes more keys than this and they are
  // dropped rather than asserted. `coordinates` is copied rather than passed
  // through, so the returned geometry cannot alias the parsed input.
  const checked: FeatureProps = {
    name,
    gloss,
    type,
    code,
    tier,
    diameterKm: diameter,
    bbox: extent,
    quad,
    approval,
    mission: missionName,
    url: checkedUrl,
  };
  const [lon, lat] = coordinates;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: checked,
  };
}

/**
 * Validate a parsed `features.json` body. Returns the reason on refusal, so the
 * caller can log which feature broke the file, and the checked collection on
 * success.
 */
export function validateFeatureCollection(value: unknown): FeaturesResult {
  if (!isRecord(value)) return refuse(null, 'is not an object');
  if (value.type !== 'FeatureCollection') {
    return refuse(null, 'type is not "FeatureCollection"');
  }
  const raw = value.features;
  if (!Array.isArray(raw)) return refuse(null, 'features is not an array');
  // An empty gazetteer means the labels step did not run, not that the Moon has
  // no names on it. `SearchBox` would read "Search 0 names" and every place name
  // would vanish with no error anywhere — refuse it and take the honest
  // "place names unavailable" path instead.
  if (raw.length === 0) return refuse(null, 'features is empty');

  const features: Feature[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const checked = checkFeature(raw[i], i);
    if (isRefused(checked)) return checked;
    features.push(checked);
  }
  return { ok: true, value: { type: 'FeatureCollection', features } };
}

/** The one-call form the app uses: the checked collection, or `null`. */
export function parseFeatureCollection(value: unknown): FeatureCollection | null {
  const result = validateFeatureCollection(value);
  return result.ok ? result.value : null;
}
