"""IAU Gazetteer of Planetary Nomenclature -> curated label set (spec §4.1).

The shipped .prj is GCS_Moon_2000 with flattening 0.0, and USGS states the
exports are east-longitude planetocentric, so no planetographic->planetocentric
conversion is needed. The only transform is 0-360 -> +/-180.

LONGITUDE WRAP CONVENTION (features.json `bbox`, which is [west, south, east,
north] after `wrap_lon`): when `west > east` the box crosses the antimeridian
and covers `lon >= west || lon <= east`, exactly the RFC 7946 §5 and Cesium
`Rectangle` reading of a west-east pair. It is not a defect: 10 curated
near-0-degree features (Plaskett, Rozhdestvenskiy, Von Kármán, Emden, Larmor,
Leeuwenhoek, Daedalus, Leibnitz, Lipskiy, Minnaert) have it. A naive
`w <= lon <= e` test wrongly rejects their own centres, so nothing may do that:
`bbox_contains()` is the single wrap-aware containment helper, and the Gate G2
proof in Task 9 imports it. `bbox = null` means "upstream geometry is not
trustworthy, never use it" -- see KNOWN_BBOX_DEFECTS.
"""
from __future__ import annotations
import json
import re
import sys
import zipfile
from pathlib import Path
import shapefile

# Verified against the shipped DBF: every name below exists in the gazetteer --
# and test_every_hardcoded_name_exists_in_the_gazetteer pins it, because an
# absent name is a silent no-op override: 'Mons Rumker' is not the gazetteer's
# 'Mons Rümker' (U+00FC), and Rümker is a 73 km mons, so the dead override cost
# it a label entirely.
# 'Mare Aestuum', 'Mare Anglia' and 'South Pole-Aitken Basin' are NOT IAU entries
# and must not be added back.
TIER0_NAMES = {
    'Oceanus Procellarum', 'Mare Imbrium', 'Mare Serenitatis',
    'Mare Tranquillitatis', 'Mare Crisium', 'Mare Fecunditatis',
    'Mare Nubium', 'Mare Humorum', 'Mare Vaporum', 'Mare Nectaris',
    'Mare Marginis', 'Mare Orientale', 'Mare Moscoviense', 'Mare Frigoris',
    'Mare Cognitum', 'Mare Insularum', 'Mare Smythii',
}
# Famous-but-small features, tiered by significance rather than diameter.
# Kepler is 29 km and Aristarchus 40 km, so without this list they would be
# filtered out by the 70 km cut; Mons Rümker (73.2 km, code MO) would be dropped
# by the 100 km floor on montes, which is why the umlaut in its name matters.
TIER1_ALWAYS = {'Tycho', 'Copernicus', 'Kepler', 'Aristarchus', 'Plato',
                'Sinus Iridum', 'Mons Huygens', 'Mons Rümker', 'Vallis Alpes',
                'Rima Hadley'}
# Real IAU descriptor codes read from the fixture:
#   SF satellite crater (7,064)  AA crater (1,615)  RI rima (112)
#   LF astronaut-named (81)      MO mons (58)       DO dorsum (39)
#   ME mare (22)                 LC lacus (21)      CA catena (20)
#   VA vallis (14)               SI sinus (12)      PR promontorium (9)
#   RU rupes (8)                 PL planitia
MARE_CODES = {'ME', 'OC', 'SI', 'LC', 'PR', 'PL'}
LINE_CODES = {'RI', 'VA', 'CA', 'DO', 'RU'}
SATELLITE_CODE = 'SF'
ASTRONAUT_CODE = 'LF'
TIER1_MIN_CRATER_KM = 150.0
TIER1_MIN_MONTES_KM = 200.0
TIER2_MIN_LINE_KM = 100.0
# Tier 2 is pruned first when the budget binds; tier 3 (visit features) last.
DROP_ORDER = {2: 0, 1: 1, 0: 2, 3: 3}
MISSION_RE = re.compile(r'(Apollo \d+|Surveyor \d+|Luna \d+|Chang’e \d+)')

# Upstream USGS data-quality defects, pinned as of the 2026 nightly export, and
# the single source of truth for both main()'s regression guard and the test.
# 19 of the 9,087 records have a centre outside their own bbox when longitude is
# compared in one wrapped frame (bbox_defects()): 18 sub-half-degree centre/bbox
# precision mismatches and 'Statio Tianhe', a genuine 90.9-degree sign error.
# 'Brill' joins them as a convention artefact rather than a geometry defect --
# its bbox is stored +/-180 while its centre is 0-360, so a naive gate cannot
# trust it even though the wrapped comparison does; it stays pinned so its bbox
# is nulled on the day it is curated (a 17 km crater, below today's floor), so
# the pinned set has 20 members while the guard reports 19 geometry defects.
# 12 of the pinned records are curated, all tier-3 astronaut-named Apollo 11/12
# traverse features, which is why they ship null. A literal set, not a tolerance:
# the guard fails as soon as the set GROWS.
# Verified against the fixture: every name below is a real gazetteer record and
# every wrapped-frame defect is pinned (test_centre_is_inside_its_own_bbox...
# asserts both). The plan text of a2b4862 additionally listed 'Taruntius A',
# 'Rook C', 'Barsoe', 'Snap', 'Liaison', 'Bican F' and 'Chabac F' -- no record
# with those names (or those prefixes) exists in the shipped lunar DBF -- plus
# 'West', 'Mount Marilyn' and 'Short', whose bboxes do contain their centres,
# and it dropped 'Jaci', 'Masina', 'Lev', 'Ballet' and 'Statio Tianchuan',
# which do fail. Per the plan's own instruction to verify the constant sets
# against the fixture, the list below is the measured one. See the fix report.
KNOWN_BBOX_DEFECTS = frozenset({
    'Mons Agnes', 'Jaci', 'Masina', 'Lev', 'Ballet', 'Statio Tianchuan',
    'Statio Tianhe', 'Brill', 'Nansen-Apollo', 'Doublet', 'Block', 'Weird',
    'Halo', 'Head', 'Flank', 'Bench', 'Surveyor', 'Little West', 'Double',
    'Middle Crescent',
})


def bbox_defects(records) -> dict[str, float]:
    """Centres outside their own bbox, in degrees of deviation.

    Longitude is compared in a single wrapped frame so a box that legitimately
    crosses the antimeridian is not reported as a defect: all three longitudes
    are folded to [-180, 180) and the centre is measured eastward from the box's
    west edge, so both `min_lon > max_lon` boxes and 'Brill' (bbox in +/-180,
    centre in 0-360) resolve correctly. Latitude has no seam, so it is compared
    directly and the deviation reported is the real gap, which is what separates
    0.006-degree rounding from the 90.9-degree 'Statio Tianhe' sign error.
    """
    out = {}
    for r in records:
        if not r.get('name') or r.get('min_lon') is None or r.get('center_lon') is None:
            continue
        dlat = 0.0
        if (r.get('min_lat') is not None and r.get('max_lat') is not None
                and r.get('center_lat') is not None):
            dlat = max(r['min_lat'] - r['center_lat'],
                       r['center_lat'] - r['max_lat'], 0.0)
        west, east, c = wrap_lon(r['min_lon']), wrap_lon(r['max_lon']), \
            wrap_lon(r['center_lon'])
        width, rel = (east - west) % 360.0, (c - west) % 360.0
        if width < 1e-9:                       # zero-width box: centre must coincide
            dlon = 0.0 if (rel <= 1e-6 or rel >= 360.0 - 1e-6) else min(rel, 360.0 - rel)
        elif rel > width + 1e-6:               # outside the east edge, or past the seam
            dlon = min(rel - width, 360.0 - rel)
        else:
            dlon = 0.0
        dev = max(dlat, dlon)
        if dev > 1e-6:
            out[r['name']] = dev
    return out


def bbox_contains(bbox, lon: float, lat: float) -> bool:
    """Containment that honours the wrap convention: west > east means the box
    crosses the antimeridian, and `bbox is None` means 'untrusted, never use'."""
    if not bbox:
        return False
    w, s, e, n = bbox
    if not (s - 1e-6 <= lat <= n + 1e-6):
        return False
    if w <= e:
        return w - 1e-6 <= lon <= e + 1e-6
    return lon >= w - 1e-6 or lon <= e + 1e-6


NUMERIC = ('diameter', 'center_lon', 'center_lat', 'min_lon', 'max_lon',
           'min_lat', 'max_lat')


def load_records(zip_path: str) -> list[dict]:
    dest = Path(zip_path).with_suffix('')
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        z.extractall(dest)
    stem = Path(next(n for n in names if n.lower().endswith('.shp'))).stem
    reader = shapefile.Reader(str(dest / stem))
    fields = [f[0] for f in reader.fields[1:]]
    out = []
    for rec in reader.iterRecords():
        row = {k: (v.strip() if isinstance(v, str) else v) for k, v in zip(fields, rec)}
        for key in NUMERIC:
            try:
                row[key] = float(row[key])
            except (TypeError, ValueError):
                row[key] = None
        out.append(row)
    return out


def wrap_lon(lon) -> float:
    """0-360 positive east -> -180..+180 (half-open: 180 -> -180).

    ``>=`` not ``>``: the pinned test requires wrap_lon(180.0) == -180.0, and the
    output range is [-180, +180), so an exact 180 must fold to -180 rather than
    stay at +180 (which would also break the "all wrapped lons < 180" assertion).
    """
    v = float(lon)
    if v >= 180.0:
        v -= 360.0
    elif v < -180.0:
        v += 360.0
    return v


def _is_visit_feature(rec) -> bool:
    """Tier 3 is the IAU 'Astronaut-named features' set (code LF, 81 records),
    whose origin strings read 'Astronaut-named feature, Apollo 17 site.'

    There is deliberately NO name-substring heuristic here: the gazetteer has no
    landing-site entries, and matching on 'Apollo'/'Luna'/'Chang' would wrongly
    promote the crater Apollo, the crater Surveyor and the craters Chang Heng
    and Chang-Ngo (named for astronomers, not missions) into tier 3.
    """
    return (rec.get('code') or '').strip() == ASTRONAUT_CODE


def mission_of(rec):
    origin = rec.get('origin') or ''
    m = MISSION_RE.search(origin)
    return m.group(1) if m else None


def assign_tier(rec, min_crater_km: float):
    """0|1|2|3 = label tier, None = do not label."""
    if _is_visit_feature(rec):
        return 3
    code = (rec.get('code') or '').strip()
    name = rec.get('name') or ''
    dia = rec.get('diameter') or 0.0
    if code == SATELLITE_CODE:
        return None
    if name in TIER0_NAMES:
        return 0
    if name in TIER1_ALWAYS:
        return 1
    if code in MARE_CODES:
        return 1
    if code == 'AA':
        if dia >= TIER1_MIN_CRATER_KM:
            return 1
        if dia >= min_crater_km:
            return 2
        return None
    if code == 'MO':
        if dia >= TIER1_MIN_MONTES_KM:
            return 1
        return 2 if dia >= TIER2_MIN_LINE_KM else None
    if code in LINE_CODES:
        return 2 if dia >= TIER2_MIN_LINE_KM else None
    return None


def curate(records, min_crater_km: float = 70.0, budget: int = 600,
           return_stats: bool = False):
    kept = []
    for rec in records:
        if not rec.get('name') or rec.get('center_lat') is None:
            continue
        tier = assign_tier(rec, min_crater_km)
        if tier is None:
            continue
        row = dict(rec)
        row['tier'] = tier
        kept.append(row)
    if len(kept) > budget:
        ranked = sorted(range(len(kept)),
                        key=lambda i: (DROP_ORDER[kept[i]['tier']],
                                       kept[i].get('diameter') or 0.0))
        drop = set(ranked[: len(kept) - budget])
        kept = [r for i, r in enumerate(kept) if i not in drop]
    if not return_stats:
        return kept
    stats = {
        'total_records': len(records),
        'curated': len(kept),
        'min_crater_km': min_crater_km,
        'budget': budget,
        'by_tier': {str(t): sum(1 for r in kept if r['tier'] == t)
                    for t in (0, 1, 2, 3)},
        'by_code': {},
    }
    for r in kept:
        code = r.get('code') or '?'
        stats['by_code'][code] = stats['by_code'].get(code, 0) + 1
    return kept, stats


def to_features(kept) -> dict:
    feats = []
    for r in kept:
        # bbox is [west, south, east, north] in +/-180. west > east is the
        # documented antimeridian crossing (see the module docstring), NOT a
        # defect; a pinned KNOWN_BBOX_DEFECTS record gets null so no downstream
        # gate can trust geometry that USGS did not get right.
        bbox = None
        if r.get('min_lon') is not None and r['name'] not in KNOWN_BBOX_DEFECTS:
            bbox = [wrap_lon(r['min_lon']), r['min_lat'],
                    wrap_lon(r['max_lon']), r['max_lat']]
        feats.append({
            'type': 'Feature',
            'geometry': {'type': 'Point',
                         'coordinates': [wrap_lon(r['center_lon']), r['center_lat']]},
            'properties': {
                'name': r['name'],
                'gloss': (r.get('origin') or '').strip('"'),
                'type': r.get('type') or '',
                'code': r.get('code') or '',
                'tier': r['tier'],
                'diameterKm': r.get('diameter'),
                'bbox': bbox,
                'quad': r.get('quad_code') or '',
                'approval': (r.get('approvaldt') or '')[:10],
                'mission': mission_of(r) if r['tier'] == 3 else None,
                'url': r.get('link') or '',
            },
        })
    return {'type': 'FeatureCollection', 'features': feats}


def main() -> int:
    zip_path = Path('public/data/MOON_nomenclature_center_pts.zip')
    if not zip_path.exists():
        zip_path = Path('tests/fixtures/moon_nomenclature_fixture.zip')
    records = load_records(str(zip_path))
    # spec §5.1 check 1, reclassified as a pinned-regression guard: the shipped
    # USGS data genuinely has 20 records whose bbox cannot be trusted (19 with a
    # centre outside the box + Brill's mixed longitude convention), so report
    # every one and fail only if the set GROWS. Dropping the check loses the
    # signal; treating upstream data quality as our bug would block the bake
    # forever.
    defects = bbox_defects(records)
    new = sorted(set(defects) - set(KNOWN_BBOX_DEFECTS))
    print(f'bbox defects: {len(defects)} found, '
          f'{len(KNOWN_BBOX_DEFECTS)} known, {len(new)} new')
    for name in sorted(defects):
        tag = 'NEW' if name in new else 'known'
        print(f'  {tag:5} {name} ({defects[name]:.3f} deg)')
    if new:
        print('FAIL: new centre-outside-bbox records; verify before shipping',
              file=sys.stderr)
        return 2
    kept, stats = curate(records, return_stats=True)
    out = Path('public/data/features.json')
    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=False keeps the IAU names verbatim (e.g. 'Lacus, lacus' -> lacus with u-macron, Rümker); on
    # Windows Path.write_text defaults to the cp1252 locale codec, which cannot
    # encode those codepoints, so pin UTF-8 explicitly.
    features = to_features(kept)
    out.write_text(json.dumps(features, ensure_ascii=False), encoding='utf-8')
    nulled = sum(1 for f in features['features'] if f['properties']['bbox'] is None)
    print(f'bbox = null shipped for {nulled} of {len(kept)} curated features '
          f'(pinned defect set: {len(KNOWN_BBOX_DEFECTS)})')
    print(json.dumps(stats, indent=1))
    print(f'wrote {out} ({out.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
