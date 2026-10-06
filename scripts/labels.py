"""IAU Gazetteer of Planetary Nomenclature -> curated label set (spec §4.1).

The shipped .prj is GCS_Moon_2000 with flattening 0.0, and USGS states the
exports are east-longitude planetocentric, so no planetographic->planetocentric
conversion is needed. The only transform is 0-360 -> +/-180.
"""
from __future__ import annotations
import json
import re
import sys
import zipfile
from pathlib import Path
import shapefile

# Verified against the shipped DBF: every name below exists in the gazetteer.
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
# filtered out by the 70 km cut.
TIER1_ALWAYS = {'Tycho', 'Copernicus', 'Kepler', 'Aristarchus', 'Plato',
                'Sinus Iridum', 'Mons Huygens', 'Mons Rumker', 'Vallis Alpes',
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
MISSION_RE = re.compile(r'(Apollo \d+|Surveyor \d+|Luna \d+|Chang’ \d+)')

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
        bbox = None
        if r.get('min_lon') is not None:
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
    kept, stats = curate(records, return_stats=True)
    for r in records:  # spec §5.1 check 1, run over the full 9,087
        if r.get('min_lon') is None:
            continue
        lon = r['center_lon']
        inside = (r['min_lon'] - 1e-6 <= lon <= r['max_lon'] + 1e-6
                  and r['min_lat'] - 1e-6 <= r['center_lat'] <= r['max_lat'] + 1e-6)
        seam = (r['min_lon'] - 360.0 <= lon <= r['max_lon'] - 360.0)
        if not (inside or seam):
            print(f'BBOX FAIL {r["name"]}', file=sys.stderr)
            return 2
    out = Path('public/data/features.json')
    out.parent.mkdir(parents=True, exist_ok=True)
    # ensure_ascii=False keeps the IAU names verbatim (e.g. 'Lacus, lacus' -> lacus with u-macron, Rümker); on
    # Windows Path.write_text defaults to the cp1252 locale codec, which cannot
    # encode those codepoints, so pin UTF-8 explicitly.
    out.write_text(json.dumps(to_features(kept), ensure_ascii=False), encoding='utf-8')
    print(json.dumps(stats, indent=1))
    print(f'wrote {out} ({out.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
