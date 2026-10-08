"""Region geometry for the deep-zoom `ortho` layer (plan step 1).

A region is a box on the grid plus the levels that are worth baking inside it.
Nothing here touches the network: the point of computing regions in Python first
is that the *cost* of the deep bake is known before anyone spends a byte of
bandwidth, and `tile_count` is what the plan's "about 15,500 tiles" claim becomes.

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
        'pxPerDeg': 1011.71,
        'projection': 'polar-stereographic',   # must be resampled into this grid
        'shaded': True,
        'bytes': 77_174_580_438,
    },
}

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
POLAR_CAP_MIN_LEVEL = 8
POLAR_CAP_MAX_LEVEL = 9


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


def merge(ranges):
    """Coalesce tile ranges that share a y band and touch or overlap in x, so the
    manifest carries a few rectangles per level instead of a tile list."""
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


def levels_of(region):
    return range(region['minLevel'], region['maxLevel'] + 1)


def tile_count(region) -> int:
    return sum(_area(r) for L in levels_of(region)
               for r in tile_ranges(box_of(region), L))


def _area(r) -> int:
    return (r[1] - r[0] + 1) * (r[3] - r[2] + 1)


def availability(regions) -> dict:
    """{level: [x0, x1, y0, y1, ...]} merged across every region at that level."""
    per_level: dict[int, list] = {}
    for reg in regions:
        for L in levels_of(reg):
            per_level.setdefault(L, []).extend(tile_ranges(box_of(reg), L))
    return {str(L): merge(rs) for L, rs in sorted(per_level.items())}


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
            half = max(min_size_deg, ((rec.get('diameter') or 0.0) / 30_322.4) * 1.5) / 2
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


def polar_cap(cap: str, lat_edge: float, min_level: int, max_level: int,
              source: str):
    """A whole-latitude band: every longitude, from the pole to `lat_edge`."""
    south, north = (lat_edge, -90.0) if cap == 'south' else (90.0, lat_edge)
    return {
        'id': f'{cap}-polar-cap', 'name': f'{cap.title()} pole',
        'kind': 'polar-cap', 'box': [-180.0, min(south, north),
                                     180.0, max(south, north)],
        'minLevel': min_level, 'maxLevel': max_level, 'source': source,
        'derivedFrom': 'declared',
    }


def curated(records):
    """The shipped region set: landing sites, named features, the south polar cap."""
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
    out.append(polar_cap('south', -84.0, POLAR_CAP_MIN_LEVEL,
                         POLAR_CAP_MAX_LEVEL, 'nac-spole'))
    for reg in out:
        if reg['id'] in NOTES:
            reg['note'] = NOTES[reg['id']]
    return out


def main() -> int:
    zip_path = Path('public/data/MOON_nomenclature_center_pts.zip')
    if not zip_path.exists():
        zip_path = Path('tests/fixtures/moon_nomenclature_fixture.zip')
    records = labels.load_records(str(zip_path))
    regs = curated(records)
    avail = availability(regs)
    total = sum(tile_count(r) for r in regs)
    data = {
        'schema': 1,
        'grid': {'tileSize': grid.TILE, 'yOrigin': 'north',
                 'latitudeType': 'planetocentric',
                 'radiusMeters': grid.MOON_RADIUS_M},
        'regions': regs,
        'availability': avail,
        'cost': {'tiles': total,
                 'perRegion': {r['id']: tile_count(r) for r in regs},
                 'tilesPerLevel': {L: sum(_area(r) for r in rs)
                                   for L, rs in avail.items()},
                 'note': ('availability is the PLAN. What the app may request is '
                          'derived from the tiles actually on disk, the same way '
                          'manifest.baked_levels asks the filesystem.')},
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes((json.dumps(data, indent=1, ensure_ascii=False) + '\n')
                    .encode('utf-8'))
    print(f'{len(regs)} regions, {total} tiles planned, '
          f'{len(avail)} levels')
    for rid, n in sorted(data['cost']['perRegion'].items(),
                         key=lambda kv: -kv[1]):
        print(f'  {rid:16} {n:6d} tiles')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
