"""Region geometry for the deep-zoom `ortho` layer (plan step 1).

A region is a box on the grid plus the levels that are worth baking inside it.
Nothing here touches the network: the point of computing regions in Python first
is that the *cost* of the deep bake is known before anyone spends a byte of
bandwidth, and `tile_count` is what the plan's "about 15,500 tiles" claim becomes.

A region's COST is a union, never a sum. `tile_count` answers "what does this one
region cost", and regions overlap: Apollo 15's site box lies inside Rima Hadley's.
Summing per-region counts over the plan charged the shared tiles once per region and
shipped 7,132 tiles for a 7,106-tile plan, so `cost` now reads the distinct tile sets
from `distinct_tiles_by_level`, keeps `perRegion` as the per-region truth it is, and
states the gap as `cost.overlap`. The other half is `merge`: each level's rectangle
block is a non-overlapping cover, and `main` refuses to write a plan where it is not.

Two rules learned the hard way from the gazetteer this module reads:

* A polar feature's bbox is not a region. Shackleton is 20.9 km across and its
  stored box spans 169 degrees of longitude, because every meridian meets at the
  pole. `derive` falls back to centre + diameter and records that it did.
* A landing site's box comes from the *median* of its traverse features, not their
  extent: Apollo 11 has four named features and one of them sits at lon 40.0
  while the site is at 23.48, so "the box around all of them" is 16 degrees wide.

The longitude convention is the gazetteer's own, east-positive, which
`test_the_longitude_convention_is_east_positive_in_the_shipped_data` pins against
mare coordinates nobody would dispute. Where a published figure disagrees with it
-- Apollo 16's Descartes site, +15.48 here against 15.4 deg W in NASA's landing
tables -- the region follows the data the app itself draws its label from, so
clicking a name cannot fly to a box that does not contain it. The disagreement is
recorded in `NOTES`, not resolved in silence.

`views` is a SECOND collection in the same artifact, and the separation is the
point of it. A region is a box plus the levels worth baking, so it carries a
tile-count promise -- `cost.tiles`, `cost.tilesPerLevel` and `availability` are all
computed from it, and `test_disk_guard` asserts plan == delivery against the 7,106
tiles on disk. A view is `{id, name, kind, boxes, derivedFrom}` and nothing else:
no `minLevel`, no `maxLevel`, no `source`, which is what keeps it out of that
arithmetic and what lets the south polar cap -- the user's own example of an area
to select -- be selectable on 2026-10-09 even though neither measured source could
bake it honestly (docs/superpowers/specs/2026-10-08-amendment-2-resolution-and-browsing.md
§7). Selecting an area draws its outline, tints its interior and frames the camera
(amendment 2 D11); none of that needs a baked tile. `cost`, `availability`,
`tile_count` and the printed summary must not move by one tile when `views` is
added, and `test_adding_views_leaves_the_bake_arithmetic_exactly_where_it_was` plus
`test_the_views_key_does_not_change_the_printed_summary` are the loud version of
that rule.

A view's `boxes` is a LIST because an area is not always one rectangle: the far side
is lon [-180,-90] and [90,180], and a footprint that straddles the antimeridian is
one set of tiles but two drawable halves. So `west > east` never appears in an
emitted view box -- that form is correct as a set and undrawable as an outline --
and `src/lib/viewRegions.ts` refuses it rather than drawing the complement.

Where the view path reads a gazetteer bbox it does so with `derive`'s guard, with
one deliberate difference: `MAX_BBOX_SPAN_DEG` is a COST ceiling, and 26 of the 57
mare-class areas are wider than 8 deg (Mare Imbrium is 46.9 deg of longitude
across), so carrying that ceiling into the view path would frame every great mare
as a 1-degree box at its own centre. A view costs nothing to state, so its ceiling
is `VIEW_MAX_BBOX_SPAN_DEG` -- half the globe, which no named area spans unless the
record is broken -- while the geometry trap that ceiling was never about, the pole,
stays exactly where `derive` puts it: `POLAR_LAT_LIMIT`, plus
`labels.KNOWN_BBOX_DEFECTS`, whose bboxes ship as `null` in `features.json` and are
therefore untrusted here too. Both fall back to centre+size and say so.
"""
from __future__ import annotations

import json
import statistics
import sys
import unicodedata
from pathlib import Path

import grid
import labels

OUT = Path('public/data/regions.json')

# What each deep-zoom source actually is, so a region can never cite a file that
# does not exist. URLs and geometry were streamed on 2026-10-08; see
# docs/superpowers/specs/2026-10-08-amendment-2-resolution-and-browsing.md §6.
SOURCES = {
    'kaguya-tc': {
        'url': ('https://asc-pds-services.s3.us-west-2.amazonaws.com/wms_basemaps3/'
                'Moon/Kaguya_TCortho_Mosaic_Global_4096ppd_cog.tif'),
        'pxPerDeg': 4096.09,
        'projection': 'equirectangular',       # matches this grid, no resampling
        'shaded': True,                        # so it may not mix with WAC albedo
        'bytes': 78_252_302_973,
    },
    'nac-spole': {
        'url': ('https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/'
                'Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_'
                'controlled_cog.tif'),
        # Measured 2026-10-09 by /vsicurl header read: 364,214 px square at a 1 m
        # pixel, polar stereographic on latitude of origin -90, so it reaches from the
        # pole to exactly -84.0 -- and no further, which is the only reason the plan
        # ever drew the cap there. `pxPerDeg` is the figure that probe put on the
        # file's own grid; it is not this pyramid's sampling, which is why the
        # projection refusal below has to fire before any resolution comparison.
        'pxPerDeg': 1011.71,
        'projection': 'polar-stereographic',   # must be resampled into this grid
        'shaded': True,
        'bytes': 77_174_580_438,
    },
}

# No shipped region cites `nac-spole`, and it stays in the table for one reason: the
# refusal it exists to prove. Two sources were measured against the south polar cap
# (docs/superpowers/specs/2026-10-08-amendment-2-resolution-and-browsing.md §7):
#
#   * `kaguya-tc` declares +-90 and is empty there. Over a 16-longitude sweep at a
#     64 px box, the fraction with data falls from 15/16 at -82 to 12/16 at -85,
#     10/16 at -87 and 6/16 at -89; `nodata` is 0, so those holes would bake as
#     black terrain, which is the lie this project already refuses in a COG read.
#   * `nac-spole` covers the cap completely, but a geographic grid cannot express it:
#     an L9 tile samples 20.8 m per pixel in latitude and L10 10.4 m, so 1 m/px
#     arrives downsampled 20:1 in latitude while the innermost rows want more than
#     1 m/px in longitude and would be upsampled. The 1 m/px pole is unreachable in
#     this tiling scheme at any level, and the source is a second shaded illumination
#     within one pyramid, which the mixing ban forbids.
#
# The cap was therefore dropped from the plan on 2026-10-09 rather than baked from
# either source. A real sub-20 m/px south pole is a polar-stereographic *view*, which
# is an architecture question, not a bake. The row stays because
# `test_a_polar_stereographic_source_is_refused_by_name` needs a real projection to
# refuse.

NOTES = {
    'apollo-16': ('Gazetteer centre is lon +15.48; NASA landing tables give the '
                  'Descartes site at 15.4 deg W. The region follows the gazetteer '
                  'because that is where the app draws the Apollo 16 names. '
                  'Unresolved upstream question, not a typo to "fix" here.'),
}

# Landing-site centres are the median of each mission's astronaut-named traverse
# features in the shipped gazetteer, to three decimals. 0.5 deg = 87 km, which at
# L10 is a 3x3 tile block: enough context to be a map, small enough that six of
# them cost less than one mare.
_LANDING_SITES = [
    ('apollo-11', 'Apollo 11', 23.483, 0.674),
    ('apollo-12', 'Apollo 12', -23.430, -3.020),
    ('apollo-14', 'Apollo 14', -17.450, -3.640),
    ('apollo-15', 'Apollo 15', 3.638, 26.049),
    ('apollo-16', 'Apollo 16', 15.481, -8.976),
    ('apollo-17', 'Apollo 17', 30.732, 20.185),
]

# Named features get a box from their own gazetteer bbox when that box is sane
# (see `derive`), padded to at least `min_size_deg`.
_FEATURES = [
    ('tycho', 'Tycho', 2.0),
    ('copernicus', 'Copernicus', 3.0),
    ('aristarchus', 'Aristarchus', 2.5),
    ('rima-hadley', 'Rima Hadley', 3.0),
    ('mons-rumker', 'Mons Rümker', 4.0),
    ('mare-orientale', 'Mare Orientale', 10.0),
]

SITE_SIZE_DEG = 0.5


def slug(name: str) -> str:
    """'Mons Rümker' -> 'mons-rumker'. NFD then strip combining marks, so the
    id is ASCII while `name` keeps the IAU spelling."""
    decomposed = unicodedata.normalize('NFD', name)
    ascii_name = ''.join(c for c in decomposed if not unicodedata.combining(c))
    return '-'.join(ascii_name.lower().replace('(', ' ').split()).strip('-')


def box_of(region):
    """A region's [west, south, east, north], from centre+size or as declared."""
    if 'box' in region:
        return list(region['box'])
    lon, lat = region['centre']
    half = region['sizeDeg'] / 2.0
    w, e = lon - half, lon + half
    # Longitude wraps; latitude clamps. A box that crosses the seam keeps west >
    # east, the same convention `labels.bbox_contains` reads.
    if w < -180.0:
        w += 360.0
    if e > 180.0:
        e -= 360.0
    return [w, max(lat - half, -90.0), e, min(lat + half, 90.0)]


def tile_ranges(box, L: int):
    """Inclusive [x0, x1, y0, y1] tile ranges covering `box` at level L.

    west > east means the box crosses the antimeridian and yields TWO ranges, one
    at each edge of the row -- the reading `labels.bbox_contains` already gives a
    gazetteer bbox. Coordinates outside the domain clamp rather than raising: a
    polar cap legitimately reaches +/-90.
    """
    west, south, east, north = box
    cols, rows = grid.level_cols(L), grid.level_rows(L)
    y0 = grid.lat_to_tile_y(min(north, 90.0), L)
    y1 = grid.lat_to_tile_y(max(south, -90.0), L)
    if y0 > y1:
        y0, y1 = y1, y0
    if west <= east:
        return [[_x(west, cols), _x(east, cols), y0, y1]]
    # crossing: [west, 180] and [-180, east]
    return [[_x(west, cols), cols - 1, y0, y1], [0, _x(east, cols), y0, y1]]


def _x(lon: float, cols: int) -> int:
    lon = max(min(lon, 180.0), -180.0)
    return min(max(int((lon + 180.0) / 360.0 * cols), 0), cols - 1)


def _band_merge(ranges):
    """Pass 1 of `merge`: coalesce ranges that share an identical y band and touch or
    overlap in x, so the manifest carries a few rectangles per level instead of a
    tile list."""
    by_band: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for x0, x1, y0, y1 in ranges:
        by_band.setdefault((y0, y1), []).append((x0, x1))
    out = []
    for (y0, y1), xs in sorted(by_band.items()):
        for x0, x1 in sorted(xs):
            if out and out[-1][:2] == [y0, y1] and x0 <= out[-1][3] + 1:
                out[-1][3] = max(out[-1][3], x1)
            else:
                out.append([y0, y1, x0, x1])
    return [[x0, x1, y0, y1] for y0, y1, x0, x1 in out]


def _subtract(a, b):
    """The parts of `a` that `b` does not cover, as up to four disjoint rectangles:
    the columns left of `b`, the columns right of it, and the two strips above and
    below the overlap. `a` untouched when the two never met, nothing at all when `a`
    sits inside `b` -- which is the absorption pass 1 could not do."""
    ax0, ax1, ay0, ay1 = a
    bx0, bx1, by0, by1 = b
    if ax1 < bx0 or bx1 < ax0 or ay1 < by0 or by1 < ay0:
        return [list(a)]
    out = []
    if ax0 <= bx0 - 1:
        out.append([ax0, bx0 - 1, ay0, ay1])
    if bx1 + 1 <= ax1:
        out.append([bx1 + 1, ax1, ay0, ay1])
    mx0, mx1 = max(ax0, bx0), min(ax1, bx1)
    if ay0 <= by0 - 1:
        out.append([mx0, mx1, ay0, by0 - 1])
    if by1 + 1 <= ay1:
        out.append([mx0, mx1, by1 + 1, ay1])
    return out


def _disjoint_cover(rects):
    """Pass 2: resolve the overlaps pass 1 leaves -- nested rectangles, and
    rectangles whose y bands cross without being identical -- into rectangles that
    cover exactly the same tiles and share none.

    The largest rectangle claims its space first (area, then row, then column, so the
    answer is a property of the geometry and not of the order the regions were
    iterated), and every other rectangle is cut by it. Nothing is emitted until every
    already-emitted rectangle has been subtracted from it, so no two outputs can
    name the same tile; nothing is dropped, so the tile set is preserved. Both facts
    are what `availability` is read for: see `distinct_tiles_by_level`."""
    remaining = [list(r) for r in rects]
    out: list[list[int]] = []
    while remaining:
        remaining.sort(key=lambda r: (-_area(r), r[2], r[0]))
        claim = remaining.pop(0)
        out.append(claim)
        remaining = [piece for r in remaining
                     for piece in _subtract(r, claim)]
    return sorted(out, key=lambda r: (r[2], r[0]))


def merge(ranges):
    """A non-overlapping cover of `ranges`, as `[x0, x1, y0, y1]` inclusive bounds
    sorted by row then column.

    Two passes: `_band_merge` coalesces ranges that share a y band and touch in x, so
    a wide box stays one rectangle and a region's own antimeridian pair stays TWO --
    the gap between the two halves of a seam box is real, and merging across it would
    promise a whole row of tiles nothing asked for. `_disjoint_cover` then handles
    what a band key cannot: rectangles sharing no y band at all.

    The guarantee is `sum(_area(r) for r in merge(rs)) == len(tiles(rs))`, which
    `test_disk_guard` has always pinned for the delivered manifest and
    `test_regions` now pins for the plan. Before pass 2 existed, a plan whose L8 block
    held `[258,262,89,93]` *and* `[260,261,90,91]` inside it was not a cover, and the
    cost summed from it double-counted.
    """
    return _disjoint_cover(_band_merge(ranges))


def levels_of(region):
    return range(region['minLevel'], region['maxLevel'] + 1)


def tile_count(region) -> int:
    return sum(_area(r) for L in levels_of(region)
               for r in tile_ranges(box_of(region), L))


def _area(r) -> int:
    return (r[1] - r[0] + 1) * (r[3] - r[2] + 1)


def availability(regions) -> dict:
    """{level: [x0, x1, y0, y1, ...]} merged across every region at that level.

    Each level's block is a NON-OVERLAPPING cover: every tile any region reaches at
    that level is named exactly once, so the block's own area is the plan's cost at
    that level and `cost.tilesPerLevel` can be read off it. `merge` is what makes
    that true, and `main` refuses to write a plan where it is not."""
    per_level: dict[int, list] = {}
    for reg in regions:
        for L in levels_of(reg):
            per_level.setdefault(L, []).extend(tile_ranges(box_of(reg), L))
    return {str(L): merge(rs) for L, rs in sorted(per_level.items())}


def distinct_tiles_by_level(regions) -> dict[int, set]:
    """{level: every (x, y) tile any region reaches at that level}, counted once.

    A set rather than a sum, because `tile_count` is per region by construction and
    adding it over regions charges a shared tile once per region. That is how the
    shipped plan came to state 7,132 tiles for the 7,106 it covers: Apollo 15's
    0.5 deg site box lies inside Rima Hadley's 3 deg box and shares 26 tiles with it
    (4 at L8, 6 at L9, 16 at L10). This is the function that cannot make that
    mistake, so `cost` is read from it and the per-region total is reported beside it
    as `cost.overlap` rather than quietly added to it.

    The sets are bounded by the plan's own tile count -- the number under test -- so
    this costs no more than the rectangles `availability` returns."""
    reached: dict[int, set] = {}
    for reg in regions:
        for L in levels_of(reg):
            at = reached.setdefault(L, set())
            for x0, x1, y0, y1 in tile_ranges(box_of(reg), L):
                at.update((x, y) for x in range(x0, x1 + 1)
                          for y in range(y0, y1 + 1))
    return reached


def median_centre(points):
    return (statistics.median(p[0] for p in points),
            statistics.median(p[1] for p in points))


def derive(records, names, min_size_deg: float, min_level: int, max_level: int):
    """Regions whose geometry comes from the gazetteer's own bbox (D8).

    A bbox is used only when it is plausibly the feature's footprint: at most
    `MAX_BBOX_SPAN_DEG` wide and not reaching a pole, because every meridian
    converges there and a 21 km crater at -89.9 lat stores a 169-degree box.
    Otherwise the centre and diameter are used, and `derivedFrom` says which.
    """
    by_name = {r['name']: r for r in records}
    out = []
    for name in names:
        rec = by_name.get(name)
        if rec is None:
            raise KeyError(f'{name!r} is not in the gazetteer')
        lon = labels.wrap_lon(rec['center_lon'])
        lat = rec['center_lat']
        span = None
        if rec.get('min_lon') is not None and abs(lat) < POLAR_LAT_LIMIT:
            w, e = labels.wrap_lon(rec['min_lon']), labels.wrap_lon(rec['max_lon'])
            span = (360.0 - w + e) if w > e else (e - w)
            if span <= MAX_BBOX_SPAN_DEG:
                box = _pad([w, rec['min_lat'], e, rec['max_lat']], min_size_deg)
                source = 'bbox'
            else:
                box = None
        else:
            box = None
        if box is None:
            half = max(min_size_deg,
                       ((rec.get('diameter') or 0.0)
                        / grid.ARC_METRES_PER_DEGREE) * 1.5) / 2
            box = [lon - half, lat - half, lon + half, lat + half]
            source = 'centre+size'
        out.append({
            'id': slug(name), 'name': name, 'kind': 'feature',
            'box': box, 'minLevel': min_level, 'maxLevel': max_level,
            'source': 'kaguya-tc', 'derivedFrom': source,
            'diameterKm': rec.get('diameter'),
        })
    return out


MAX_BBOX_SPAN_DEG = 8.0
POLAR_LAT_LIMIT = 85.0


def _pad(box, min_size_deg):
    w, s, e, n = box
    if e - w < min_size_deg:
        cx = (w + e) / 2
        w, e = cx - min_size_deg / 2, cx + min_size_deg / 2
    if n - s < min_size_deg:
        cy = (s + n) / 2
        s, n = cy - min_size_deg / 2, cy + min_size_deg / 2
    return [w, max(s, -90.0), e, min(n, 90.0)]


def curated(records):
    """The shipped region set: the landing sites and the named features.

    Nothing else is in it, and the south polar cap is the case that proved the rule:
    a region belongs here only when a source that was measured on the network can pay
    for it honestly (the `nac-spole` note above)."""
    kept = labels.curate(records)
    by_mission = {}
    for r in kept:
        if r['tier'] == 3:
            m = labels.mission_of(r)
            if m:
                by_mission.setdefault(m, []).append(
                    (labels.wrap_lon(r['center_lon']), r['center_lat']))
    out = []
    for rid, name, lon, lat in _LANDING_SITES:
        out.append({
            'id': rid, 'name': name, 'kind': 'landing-site',
            'mission': name, 'centre': [lon, lat], 'sizeDeg': SITE_SIZE_DEG,
            'minLevel': 8, 'maxLevel': 10, 'source': 'kaguya-tc',
            'derivedFrom': 'gazetteer-median',
            'crossCheck': median_centre(by_mission[name]),
        })
    feats = derive(records, [n for _, n, _ in _FEATURES],
                   min_size_deg=1.0, min_level=8, max_level=10)
    for reg in feats:
        want = next(sz for _, n, sz in _FEATURES if n == reg['name'])
        reg['box'] = _pad(reg['box'], want)
    out.extend(feats)
    for reg in out:
        if reg['id'] in NOTES:
            reg['note'] = NOTES[reg['id']]
    return out


# --- browsable views (amendment 2 D11) ---------------------------------------

#: The latitude a polar cap starts at. 60 deg is the usual definition of a polar
#: cap and, at this grid, the row band whose tiles the global L0-L7 layers still
#: cover honestly -- a cap is a *view*, so nothing here is paying for it either way.
POLAR_CAP_LAT_DEG = 60.0

#: A view box is drawn and framed, so a record whose footprint is a point (IAU
#: stores `Planitia Descensus` with min_lon == max_lon and a 0.00 km diameter)
#: still needs an outline with an inside. Same floor `derive` is called with.
VIEW_MIN_SIZE_DEG = 1.0

#: The view path's sanity ceiling on a gazetteer bbox's longitude span, in place of
#: `MAX_BBOX_SPAN_DEG` and for the reason in the module docstring: 8 deg is what a
#: deep bake may not afford, not what a named area may be. Half the globe is the
#: honest form of "no named area is this wide unless the record is broken"; the
#: pole, which is the case that actually lies, is still `POLAR_LAT_LIMIT`'s.
VIEW_MAX_BBOX_SPAN_DEG = 180.0

#: The IAU descriptor codes that name an AREA rather than a point: the mare-class
#: types D11 asks to be selectable. `PR` (promontorium, a 11-70 km headland) is
#: deliberately out -- it is a point on a coast, not a box a user means by "the
#: area of".
VIEW_AREA_CODES = {'ME': 'mare', 'OC': 'oceanus', 'SI': 'sinus', 'LC': 'lacus',
                   'PL': 'planitia'}

#: `view_of_record`'s answer for a record outside `VIEW_AREA_CODES`. Reachable only
#: from a direct call -- `view_regions` filters -- and present so the guard tests
#: can aim the documented polar case at the same code path the mare views use.
VIEW_KIND_FALLBACK = 'area'

#: Keys that belong to a region and may never appear on a view. `main()` refuses to
#: write an artifact that mixes them, because a view with a level range or a source
#: is a bake promise nobody costed: `availability` and `cost` would stay at 7,106
#: while the artifact claimed tiles for an outline. `src/lib/viewRegions.ts` refuses
#: the same list, so writer and reader cannot disagree about which key put a view
#: back into the bake. (`note` is not in it: prose promises no tiles, and the reader
#: drops it like any other unmodelled key.)
VIEW_BAKE_KEYS = frozenset({'minLevel', 'maxLevel', 'source', 'levels',
                            'sizeDeg', 'centre', 'box', 'diameterKm'})


def _split_seam(box):
    """A lon/lat box as up to two rectangles that never run backwards.

    Coordinates off the end of the domain fold the way `box_of` folds them (a west
    edge below -180 comes back at +180), which is what a box padded around the
    sub-antimeridian centre does. What is left over is the documented `west > east`
    crossing: one set of tiles, two halves of a map, and an outline cannot be drawn
    through either end, so the pair is returned instead. Every box this emits has
    `west < east` and is inside -180..180 / -90..90, which is the promise
    `src/lib/viewRegions.ts` refuses to take on trust.
    """
    west, south, east, north = box
    if west < -180.0:
        west += 360.0
    if east > 180.0:
        east -= 360.0
    if west <= east:
        return [[west, south, east, north]]
    return [[west, south, 180.0, north], [-180.0, south, east, north]]


def view_of_record(rec) -> dict:
    """One selectable area, from a gazetteer record, read the way `derive` reads one.

    The bbox is the footprint when it can be: not at the pole (`POLAR_LAT_LIMIT`,
    the trap in the module docstring -- Shackleton stores 169 degrees of longitude
    for a 20.9 km crater), not a record USGS got wrong (`KNOWN_BBOX_DEFECTS`, whose
    bbox ships as `null` in features.json and is therefore untrusted here too), and
    not wider than the globe-half ceiling. Otherwise the centre and diameter are
    used, at the same size floor, and `derivedFrom` says which of the two it was --
    so a cap drawn from a centre can never be mistaken for a mapped outline.
    """
    name = rec['name']
    lon = labels.wrap_lon(rec['center_lon'])
    lat = rec['center_lat']
    boxes = None
    source = 'centre+size'
    usable = (rec.get('min_lon') is not None and rec.get('max_lon') is not None
              and rec.get('min_lat') is not None and rec.get('max_lat') is not None
              and abs(lat) < POLAR_LAT_LIMIT
              and name not in labels.KNOWN_BBOX_DEFECTS)
    if usable:
        w, e = labels.wrap_lon(rec['min_lon']), labels.wrap_lon(rec['max_lon'])
        span = (360.0 - w + e) if w > e else (e - w)
        if span <= VIEW_MAX_BBOX_SPAN_DEG:
            s, n = rec['min_lat'], rec['max_lat']
            if n - s < VIEW_MIN_SIZE_DEG:
                cy = (s + n) / 2.0
                s, n = cy - VIEW_MIN_SIZE_DEG / 2, cy + VIEW_MIN_SIZE_DEG / 2
            if span < VIEW_MIN_SIZE_DEG:
                # The centre of the footprint, not of the west/east pair: on a
                # crossing box the pair's mean is lon 0, the far side of the map.
                cx = labels.wrap_lon(w + span / 2.0)
                w, e = cx - VIEW_MIN_SIZE_DEG / 2, cx + VIEW_MIN_SIZE_DEG / 2
            boxes = _split_seam([w, max(s, -90.0), e, min(n, 90.0)])
            source = 'bbox'
    if boxes is None:
        half = max(VIEW_MIN_SIZE_DEG,
                   ((rec.get('diameter') or 0.0)
                    / grid.ARC_METRES_PER_DEGREE) * 1.5) / 2
        boxes = _split_seam([lon - half, max(lat - half, -90.0),
                             lon + half, min(lat + half, 90.0)])
    return {
        'id': slug(name), 'name': name,
        'kind': VIEW_AREA_CODES.get((rec.get('code') or '').strip(),
                                    VIEW_KIND_FALLBACK),
        'boxes': boxes, 'derivedFrom': source,
    }


def constructed_views():
    """The four areas a user names directly and the gazetteer has no record of.

    The poles and the tidally-locked pair. Each is declared in the gazetteer's own
    east-positive convention, in the -180..180 form, never as 0-360: the far side is
    two boxes because its longitude really is [-180,-90] and [90,180], and the gap
    between them is the near side, which the app must not paint twice.
    """
    cap = POLAR_CAP_LAT_DEG
    return [
        {'id': 'south-polar-cap', 'name': 'South Polar Cap', 'kind': 'polar-cap',
         'boxes': [[-180.0, -90.0, 180.0, -cap]], 'derivedFrom': 'declared'},
        {'id': 'north-polar-cap', 'name': 'North Polar Cap', 'kind': 'polar-cap',
         'boxes': [[-180.0, cap, 180.0, 90.0]], 'derivedFrom': 'declared'},
        {'id': 'near-side', 'name': 'Near Side', 'kind': 'hemisphere',
         'boxes': [[-90.0, -90.0, 90.0, 90.0]], 'derivedFrom': 'declared'},
        {'id': 'far-side', 'name': 'Far Side', 'kind': 'hemisphere',
         'boxes': [[-180.0, -90.0, -90.0, 90.0], [90.0, -90.0, 180.0, 90.0]],
         'derivedFrom': 'declared'},
    ]


def view_regions(records):
    """The browsable collection: the four declared areas plus every mare-class name
    the app already ships in `features.json`.

    Built from `labels.curate`, not from the raw gazetteer, so a view can never name
    an area the app cannot label, search for or credit. Sorted by name, so the
    artifact's diff is a property of the geometry and not of the shapefile's row
    order.
    """
    out = constructed_views()
    kept = [r for r in labels.curate(records)
            if (r.get('code') or '').strip() in VIEW_AREA_CODES
            and r.get('name') and r.get('center_lat') is not None
            and r.get('center_lon') is not None]
    for rec in sorted(kept, key=lambda r: r['name']):
        out.append(view_of_record(rec))
    return out


def main() -> int:
    zip_path = Path('public/data/MOON_nomenclature_center_pts.zip')
    if not zip_path.exists():
        zip_path = Path('tests/fixtures/moon_nomenclature_fixture.zip')
    records = labels.load_records(str(zip_path))
    regs = curated(records)
    views = view_regions(records)
    avail = availability(regs)
    per_region = {r['id']: tile_count(r) for r in regs}
    union = distinct_tiles_by_level(regs)
    tiles_per_level = {str(L): len(at) for L, at in sorted(union.items())}
    distinct = sum(tiles_per_level.values())
    # The plan is the artifact every future cost estimate is read from, so it does
    # not get to state a number its own rectangles contradict: an availability block
    # whose areas add up to more than the tiles it names is a block that double-counts.
    for level, rects in avail.items():
        claimed = sum(_area(r) for r in rects)
        if claimed != tiles_per_level[level]:
            raise AssertionError(
                f'L{level}: the merged block names {tiles_per_level[level]} distinct '
                f'tiles but its {len(rects)} rectangles add up to {claimed}. merge() '
                f'is no longer a non-overlapping cover, so the plan cannot state a '
                f'cost.')
    for view in views:
        stray = sorted(VIEW_BAKE_KEYS & set(view))
        if stray:
            raise AssertionError(
                f'view {view["id"]!r} carries the region key(s) {stray}: a view is '
                f'outline and framing geometry only, and a view with a level range '
                f'or a source is a tile count nobody paid for.')
    data = {
        'schema': 1,
        'grid': {'tileSize': grid.TILE, 'yOrigin': 'north',
                 'latitudeType': 'planetocentric',
                 'radiusMeters': grid.MOON_RADIUS_M},
        'regions': regs,
        # The browsable collection (D11). Deliberately after `regions` and before
        # `availability`, and deliberately without a level range or a source: the
        # two blocks below are computed from `regs` alone, so a view cannot be
        # charged for a tile. Guarded rather than trusted -- see the note above.
        'views': views,
        'availability': avail,
        'cost': {'tiles': distinct,
                 'overlap': sum(per_region.values()) - distinct,
                 'perRegion': per_region,
                 'tilesPerLevel': tiles_per_level,
                 'note': ('tiles and tilesPerLevel are the DISTINCT UNION of the '
                          'region boxes: availability is a non-overlapping cover per '
                          'level, so a tile two regions share is charged once. '
                          'perRegion is each region on its own and therefore sums to '
                          'more; overlap is the difference, named instead of hidden '
                          '(Apollo 15 inside Rima Hadley). What the app may request '
                          'is derived from the tiles actually on disk, the same way '
                          'manifest.baked_levels asks the filesystem.')},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((json.dumps(data, indent=1, ensure_ascii=False) + '\n')
                    .encode('utf-8'))
    print(f'{len(regs)} regions, {distinct} tiles planned '
          f'({sum(per_region.values())} counted per region, '
          f'{data["cost"]["overlap"]} shared), {len(avail)} levels')
    for rid, n in sorted(per_region.items(), key=lambda kv: -kv[1]):
        print(f'  {rid:16} {n:6d} tiles')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
