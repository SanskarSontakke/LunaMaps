from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
import grid


def base_manifest() -> dict:
    return {
        'schema': 1,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'grid': {
            'tileSize': grid.TILE,
            'colsFactor': '2^(L+1)',
            'rowsFactor': '2^L',
            'yOrigin': 'north',
            'lonDomain': '180',
            'latitudeType': 'planetocentric',
            'radiusMeters': grid.MOON_RADIUS_M,
            'flattening': 0.0,
            'prjWkt': (
                'GEOGCS["GCS_Moon_2000",DATUM["D_Moon_2000",'
                'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0],'
                'PRIMEM["Reference_Meridian",0.0],'
                'UNIT["Degree",0.0174532925199433]]'),
        },
        'levels': [{'L': L, 'cols': grid.level_cols(L), 'rows': grid.level_rows(L),
                    'mPerPx': round(grid.m_per_px(L), 2)} for L in range(8)],
        'sources': [],
        'layers': {},
        'timings': {},
    }


def write_manifest(path, data: dict) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=1))
    return p
