import type { Bounds } from '@/lib/grid';

/**
 * The reader for the `views` collection of `public/data/regions.json`
 * (amendment 2 D11: selecting an area draws its outline, tints its interior and
 * frames the camera on it).
 *
 * Why a second collection exists at all: `regions` in that file is the *bake plan*.
 * A region carries a tile-count promise — `cost.tiles`, `cost.tilesPerLevel` and
 * `availability` are computed from it, and `scripts/tests/test_disk_guard.py`
 * asserts plan == delivery against the 7,106 tiles on disk — so an area no measured
 * source can bake honestly cannot be in it. That is why the south polar cap, the
 * user's own example of a thing to select, was dropped from the plan on 2026-10-09
 * (`docs/superpowers/specs/2026-10-08-amendment-2-resolution-and-browsing.md` §7).
 * Framing needs no baked tile, so `views` is the collection that promises nothing:
 * geometry and a name, and **no `minLevel`, no `maxLevel`, no `source`**. That
 * omission is the separation, so this validator refuses a view that grew one back
 * (`VIEW_FORBIDDEN_KEYS`): a view with a level range is a bake promise nobody
 * costed, and a cast over the parsed JSON would have shipped that claim to the UI
 * silently.
 *
 * The discipline is `src/lib/assets.ts`'s and `src/lib/features.ts`'s: the returned
 * objects are built field by field out of values that each passed a predicate, so
 * the type cannot claim more than was checked, and an unmodelled key is dropped
 * rather than asserted.
 *
 * And no Cesium import anywhere, so the geometry below runs in the node environment
 * `vitest.config.ts` sets, and the component that draws an outline is free to feed
 * `boxes` to polygons or to expand `viewRegionBounds` into one rectangle — its
 * choice, not this module's.
 */

/** The `schema` this build reads. Anything else is refused, not guessed at. */
export const VIEW_SCHEMA = 1;

/**
 * The kinds the emitter writes: `polar-cap` and `hemisphere` are declared geometry,
 * the rest are the IAU area classes read off a gazetteer footprint. An unknown kind
 * is refused rather than passed through, because the sidebar builds its wording from
 * this field — a kind with no wording is a label the app cannot explain.
 */
export const VIEW_KINDS = [
  'polar-cap',
  'hemisphere',
  'mare',
  'oceanus',
  'sinus',
  'lacus',
  'planitia',
] as const;

export type ViewKind = (typeof VIEW_KINDS)[number];

/**
 * How a box was obtained, straight from `scripts/regions.py`: the gazetteer's own
 * bbox, or the centre+diameter fallback a polar or upstream-defective record is
 * forced into. `declared` is the four hand-built areas. Anything else means the
 * emitter and this reader have drifted.
 */
export const VIEW_DERIVED_FROM = ['bbox', 'centre+size', 'declared'] as const;

export type ViewDerivedFrom = (typeof VIEW_DERIVED_FROM)[number];

/**
 * Keys that belong to a *region*. A view carrying any of them has been merged back
 * into the bake vocabulary, so the file is refused rather than silently stripped:
 * `regions.py`'s `main()` refuses to write the same set, and the two lists are kept
 * the same list deliberately (a human-readable `note` is not in it — that key
 * promises no tiles, and it is dropped by the builder below like any other).
 */
export const VIEW_FORBIDDEN_KEYS = [
  'minLevel',
  'maxLevel',
  'source',
  'levels',
  'sizeDeg',
  'centre',
  'box',
  'diameterKm',
  'cost',
  'tiles',
  'tilesPerLevel',
  'availability',
  'perRegion',
] as const;

/**
 * `[west, south, east, north]` in the gazetteer's east-positive +/-180 convention.
 * A view box always has `west < east`: the `west > east` antimeridian form the
 * gazetteer uses for a crater's own bbox is correct as a *set* and undrawable as an
 * outline, so `regions.py` splits those into two boxes and this module refuses a
 * pair that runs backwards.
 */
export type ViewBox = [number, number, number, number];

export interface ViewRegion {
  /** The slugged form of `name`, unique in the file, and what the UI keys on. */
  id: string;
  /** The IAU spelling, diacritics intact. */
  name: string;
  kind: ViewKind;
  /** One box for an area like a mare; two for the far side, whose longitude really
   *  is [-180,-90] and [90,180] with the near side between them. Never empty. */
  boxes: ViewBox[];
  derivedFrom: ViewDerivedFrom;
}

/** The point to frame on. Not a Cesium `Cartesian3`: this module has no Cesium. */
export interface ViewCenter {
  lon: number;
  lat: number;
}

export interface ViewRegionsAccepted {
  ok: true;
  value: ViewRegion[];
}

export interface ViewRegionsRefused {
  ok: false;
  /** Which view and which field, so a broken artifact is diagnosable from the
   *  console instead of from a diff of regions.json. */
  reason: string;
}

export type ViewRegionsResult = ViewRegionsAccepted | ViewRegionsRefused;

type Rec = Record<string, unknown>;

const isRecord = (v: unknown): v is Rec =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Four finite numbers, the shape `isTileRange` and `isBbox` check the same way. */
const isBoxShape = (v: unknown): v is ViewBox =>
  Array.isArray(v) && v.length === 4 && v.every((n) => isNum(n));

/**
 * The emitter's `regions.slug()`, mirrored: NFD, combining marks dropped,
 * parentheses treated as a space, lowercased, whitespace runs joined by one dash.
 * Checked against the shipped ids by `src/test/viewRegions.test.ts`, because the
 * day the two slugs disagree every view in the file is refused.
 */
export function slugId(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join('-');
}

/** A slugged id: lowercase ASCII words joined by single dashes, nothing else. */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** +/-180, half-open at the east end — `labels.wrap_lon`, in TypeScript. */
function wrapLon(lon: number): number {
  let v = lon;
  while (v >= 180) v -= 360;
  while (v < -180) v += 360;
  return v;
}

const refuse = (
  index: number | null,
  detail: string,
  name?: string,
): ViewRegionsRefused => ({
  ok: false,
  reason: `regions.json: ${
    index === null
      ? 'the views block'
      : `view ${index}${name ? ` "${name}"` : ''}`
  } — ${detail}`,
});

/** The guard that keeps this module cast-free, as `features.ts` does. */
const isRefused = (v: ViewRegion | ViewRegionsRefused): v is ViewRegionsRefused =>
  'ok' in v && v.ok === false;

/** The same for a box: a checked box is the tuple, a refused one is the reason. */
const isRefusedBox = (v: ViewBox | ViewRegionsRefused): v is ViewRegionsRefused =>
  !Array.isArray(v);

const isIn = <T>(value: unknown, list: readonly T[]): value is T =>
  (list as readonly unknown[]).includes(value);

/** One box, checked to the last field: four finite numbers inside the grid's own
 *  domain, a nonzero width and height, and no pair that runs backwards. */
function checkBox(
  raw: unknown,
  view: number,
  position: number,
  name?: string,
): ViewBox | ViewRegionsRefused {
  const at = `boxes[${position}]`;
  if (!isBoxShape(raw)) {
    return refuse(
      view,
      `${at} ${JSON.stringify(raw)} is not 4 finite lon/lat numbers`,
      name,
    );
  }
  const [west, south, east, north] = raw;
  if (Math.abs(west) > 180 || Math.abs(east) > 180) {
    return refuse(
      view,
      `${at} ${JSON.stringify(raw)} is outside +/-180 longitude: the convention is ` +
        'east-positive +/-180, never a 0-360 form',
      name,
    );
  }
  if (Math.abs(south) > 90 || Math.abs(north) > 90) {
    return refuse(
      view,
      `${at} ${JSON.stringify(raw)} is outside +/-90 latitude`,
      name,
    );
  }
  // The documented antimeridian reading of a west/east pair, refused here on
  // purpose: an outline drawn straight through the seam would cover the complement
  // of the area the user selected.
  if (west > east) {
    return refuse(
      view,
      `${at} ${JSON.stringify(raw)} runs backwards: a west > east pair is the ` +
        'antimeridian form, and the emitter must split it into two drawable boxes',
      name,
    );
  }
  if (east === west) {
    return refuse(view, `${at} ${JSON.stringify(raw)} has no width to outline`, name);
  }
  if (north <= south) {
    return refuse(view, `${at} ${JSON.stringify(raw)} has no height to tint`, name);
  }
  return [west, south, east, north];
}

/** One view, checked, and built out of the values that passed and no other source. */
function checkView(raw: unknown, index: number): ViewRegion | ViewRegionsRefused {
  if (!isRecord(raw)) {
    return refuse(index, 'is not an object, so there is no id, name, kind or boxes');
  }
  const grown = VIEW_FORBIDDEN_KEYS.filter((key) => key in raw);
  if (grown.length > 0) {
    return refuse(
      index,
      `carries the region key ${grown.map((k) => `"${k}"`).join(', ')}: a view is ` +
        'outline and framing geometry only, and a view with a level range or a ' +
        'source is a bake promise this file never costed',
    );
  }
  const { id, name, kind, boxes, derivedFrom } = raw;
  if (!isText(name)) return refuse(index, 'name is missing or blank');
  if (!isText(id)) {
    return refuse(index, `id ${JSON.stringify(id)} is missing or blank`, name);
  }
  if (!ID_PATTERN.test(id)) {
    return refuse(index, `id ${JSON.stringify(id)} is not a lowercase slug`, name);
  }
  if (id !== slugId(name)) {
    return refuse(
      index,
      `id ${JSON.stringify(id)} is not the slug of name ${JSON.stringify(name)}`,
      name,
    );
  }
  if (!isIn(kind, VIEW_KINDS)) {
    return refuse(
      index,
      `kind ${JSON.stringify(kind)} is not one this build has wording for ` +
        `(${VIEW_KINDS.join(', ')})`,
      name,
    );
  }
  if (!isIn(derivedFrom, VIEW_DERIVED_FROM)) {
    return refuse(
      index,
      `derivedFrom ${JSON.stringify(derivedFrom)} is not one the emitter writes ` +
        `(${VIEW_DERIVED_FROM.join(', ')})`,
      name,
    );
  }
  if (!Array.isArray(boxes) || boxes.length === 0) {
    return refuse(index, 'boxes is missing, is not an array, or is empty', name);
  }
  const checked: ViewBox[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    const box = checkBox(boxes[i], index, i, name);
    if (isRefusedBox(box)) return box;
    checked.push(box);
  }
  // Only these five fields exist on the result. `regions`, `availability` and
  // `cost` sit beside `views` in the same file and are none of this validator's
  // business: not read, not returned.
  return { id, name, kind, boxes: checked, derivedFrom };
}

/**
 * Validate a parsed `regions.json` body and return the checked `views` — or the
 * reason it refused.
 *
 * Refuses the whole file rather than dropping one view, for `features.ts`'s reason:
 * a half-accepted collection is a partial lie. A user who selects "the south pole"
 * and gets nothing would conclude the Moon has no south polar area, when the real
 * answer is that one record in one generated file is malformed.
 */
export function validateViewRegions(value: unknown): ViewRegionsResult {
  if (!isRecord(value)) {
    return refuse(null, 'is not an object, so there is no schema 1 body to read');
  }
  if (value.schema !== VIEW_SCHEMA) {
    return refuse(
      null,
      `schema ${JSON.stringify(value.schema)} is not the ${VIEW_SCHEMA} this build reads`,
    );
  }
  const raw = value.views;
  if (!Array.isArray(raw)) {
    return refuse(null, 'has no views array (this build reads views, never regions)');
  }
  // An empty list means the generator did not run, not that the Moon has no areas
  // to select: the sidebar would render an empty box and the user would have no way
  // to tell that apart from a Moon with nothing on it.
  if (raw.length === 0) return refuse(null, 'views is empty');

  const views: ViewRegion[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < raw.length; i += 1) {
    const view = checkView(raw[i], i);
    if (isRefused(view)) return view;
    const previous = seen.get(view.id);
    if (previous !== undefined) {
      return refuse(
        i,
        `has a duplicate id ${JSON.stringify(view.id)}, also at view ${previous}: ` +
          'the UI keys and routes a selection on it',
        view.name,
      );
    }
    seen.set(view.id, i);
    views.push(view);
  }
  return { ok: true, value: views };
}

/** The one-call form the app uses: the checked views, or `null`. */
export function parseViewRegions(value: unknown): ViewRegion[] | null {
  const result = validateViewRegions(value);
  return result.ok ? result.value : null;
}

/** The merged, disjoint longitude intervals of `boxes`, west to east. Boxes that
 *  touch are joined, so two halves of one area count as one arc. */
function coveredArcs(boxes: readonly ViewBox[]): [number, number][] {
  const arcs = boxes.map((b) => [b[0], b[2]] as [number, number]);
  arcs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: [number, number][] = [];
  for (const [west, east] of arcs) {
    const last = out[out.length - 1];
    if (last && west <= last[1]) last[1] = Math.max(last[1], east);
    else out.push([west, east]);
  }
  return out;
}

/**
 * The smallest CONTIGUOUS rectangle that covers every box, as a Cesium-free
 * `{west, south, east, north}` the UI can expand into an outline.
 *
 * Contiguous is the whole design: `min(west)..max(east)` over the far side's two
 * boxes is -180..180, which is the whole globe — an outline of nothing and a camera
 * parked at the wrong height. So the widest empty arc between the boxes is found and
 * its complement taken, which for the far side is the documented `west > east`
 * crossing form `{west: 90, east: -90}`: one honest 180-degree-wide rectangle instead
 * of a pretend 360. A view whose boxes sit in more than one gap has no single
 * rectangle that is exactly its extent, so draw `boxes` one at a time for the true
 * outline; this is the framing answer, and `viewRegionCenter` is read off it.
 * `null` means there is nothing to bound.
 */
export function viewRegionBounds(boxes: readonly ViewBox[]): Bounds | null {
  if (boxes.length === 0) return null;
  const arcs = coveredArcs(boxes);
  const south = Math.min(...boxes.map((b) => b[1]));
  const north = Math.max(...boxes.map((b) => b[3]));
  if (arcs.length === 1) {
    return { west: arcs[0][0], south, east: arcs[0][1], north };
  }
  // The gap that wraps the seam first, so a tie goes to the plain rectangle rather
  // than the crossing one; then the gaps between neighbouring arcs.
  const best = {
    width: arcs[0][0] + 360 - arcs[arcs.length - 1][1],
    west: arcs[0][0],
    east: arcs[arcs.length - 1][1],
  };
  for (let i = 0; i < arcs.length - 1; i += 1) {
    const width = arcs[i + 1][0] - arcs[i][1];
    if (width > best.width) {
      // Excluding this gap means covering from the next arc's west edge, eastward
      // through the seam, to this arc's east edge: the `west > east` form.
      best.width = width;
      best.west = arcs[i + 1][0];
      best.east = arcs[i][1];
    }
  }
  return { west: best.west, south, east: best.east, north };
}

/**
 * The point to frame a view on.
 *
 * Derived from `viewRegionBounds`, so the target is always inside the rectangle the
 * outline is drawn from. That matters most for the far side: the mean of its two
 * boxes' corners is lon 0, the middle of the NEAR side — inside the gap the selected
 * area does not cover — while the midpoint of the covering arc is lon +/-180, the
 * antipode of the sub-Earth point and the actual centre of what was selected.
 */
export function viewRegionCenter(boxes: readonly ViewBox[]): ViewCenter | null {
  const bounds = viewRegionBounds(boxes);
  if (!bounds) return null;
  const width =
    bounds.west <= bounds.east
      ? bounds.east - bounds.west
      : 360 - (bounds.west - bounds.east);
  return {
    lon: wrapLon(bounds.west + width / 2),
    lat: (bounds.south + bounds.north) / 2,
  };
}
