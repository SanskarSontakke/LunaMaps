"""The delivered pyramid's own record: what was baked, at what grid, from
which sources.

`levels` used to be hard-coded to `range(8)` -- the whole grid contract rather
than the tree on disk -- so the Tier A manifest advertised an L7 that had never
been baked (bake-log.md §6, Task 17 finding 10). It is now built from
`baked_levels()`, which asks the filesystem.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone
from pathlib import Path
import grid


def baked_levels(out_dir, layers) -> list[int]:
    """Levels that actually hold tiles for one of `layers`, ascending.

    A level directory counts only if it has at least one JPEG under
    `<out>/<layer>/<L>/<x>/<y>.jpg`, which is the shape `save_tile` writes. The
    probe tiles in `public/tiles/probe` are not a baked layer and are never
    passed in `layers`, so they cannot leak into the record.
    """
    out = Path(out_dir)
    found = set()
    for layer in layers:
        d = out / layer
        if not d.is_dir():
            continue
        for sub in d.iterdir():
            if sub.is_dir() and sub.name.isdigit() and any(sub.glob('*/*.jpg')):
                found.add(int(sub.name))
    return sorted(found)


def base_manifest(levels, generated_at: str | None = None) -> dict:
    """A manifest skeleton for exactly the `levels` that exist.

    `generated_at` is the pyramid's bake stamp. Callers that rebuild a manifest
    without baking pass the stamp they carried forward, so the attribution panel
    keeps reporting the bake date rather than the date the record was rewritten.
    """
    return {
        'schema': 1,
        'generatedAt': generated_at or datetime.now(
            timezone.utc).isoformat(timespec='seconds'),
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
                    'mPerPx': round(grid.m_per_px(L), 2)} for L in levels],
        'sources': [],
        'layers': {},
        'timings': {},
    }


def write_manifest(path, data: dict) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Trailing newline, and an LF terminator forced through the bytes: on
    # Windows `write_text` in text mode would translate '\n' to os.linesep, so
    # a "clean" manifest would end `}\r\n` and a fresh checkout on a different
    # platform would end `}` or `}\r\n` at the writer's whim. This is a tracked
    # text file (Task 17 finding 13); every diff of it was advertising the
    # missing newline. Write the bytes and let git's normalisation decide the
    # checkout, but always give it a single trailing LF to normalise from.
    p.write_bytes((json.dumps(data, indent=1) + '\n').encode('utf-8'))
    return p
