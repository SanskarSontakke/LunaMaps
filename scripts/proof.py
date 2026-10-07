"""Gate G2: falsifiable evidence that imagery and labels agree (spec §5.1).

A vertical flip or a 180 deg longitude error breaks the median-contrast check
with the wrong sign, and misplaced labels break the Apollo 11 placement check,
because the gazetteer supplies centres and bboxes while the imagery supplies
albedo. A sub-pixel offset does not: 100 m of a 333 m sample moves a third of a
pixel, and that risk is pinned by the corner-origin tests in Task 3 instead.

Index math is never re-implemented here: `tile_pixel` delegates the tile index
and the world-pixel position to `grid`, and containment delegates to
`labels.bbox_contains`, the wrap-aware helper. `tile_pixel` folds its input
longitude with `labels.wrap_lon` first, so +180 and -180 -- the same meridian
-- resolve to the same pixel instead of to the two opposite ends of the world;
`grid.lon_to_tile_x` clamps +180 into the last column, which would otherwise
read the far side of the map for a point on the seam.

MARKER LIST PROVENANCE. Membership is decided by two facts and never by a
measured albedo: presence in the shipped label set (`public/data/features.json`)
and feature class. `Cyrano` was in the plan's highland list but is absent from
the curated set -- it is a real gazetteer record (code AA, 79.58 km, tier 2) that
the 600-label budget prunes first, because DROP_ORDER drops the smallest tier-2
craters. An unresolvable name is a silent no-op marker, so it is replaced by
`Messala` (code AA, 122.4 km, 60.06E 39.31N), which is present in the curated
set and is the same class: a ray/highland crater whose floor is not basalt-
flooded. `Zeeman`, `Fracastorius`, `Mersenius` and `Van de Graaff` are also
curated AA craters and were NOT used, because a dark basalt-flooded floor makes
a poor bright marker -- the same geological rule that keeps Plato, Grimaldi,
Wargentin, Posidonius and Gassendi out of the list. `test_every_marker_resolves_
in_the_shipped_label_set` pins presence so this class of defect cannot recur.
"""
from __future__ import annotations
import json
import math
import sys
from pathlib import Path
import numpy as np
from PIL import Image

import grid
from labels import MARE_CODES, bbox_contains, wrap_lon
import manifest as manifest_mod

MARE_CENTRES = ['Mare Tranquillitatis', 'Mare Imbrium', 'Mare Crisium',
                'Oceanus Procellarum', 'Mare Fecunditatis', 'Mare Nubium',
                'Mare Serenitatis', 'Mare Marginis', 'Mare Humboldtianum',
                'Mare Vaporum', 'Mare Nectaris', 'Mare Frigoris',
                'Mare Cognitum', 'Mare Insularum', 'Mare Orientale',
                'Mare Undarum', 'Mare Smythii', 'Sinus Iridum',
                'Lacus Mortis', 'Lacus Felicitatis']
# Ray and highland craters only. Dark-floored craters (Plato, Grimaldi,
# Wargentin, Posidonius, Gassendi) are deliberately absent because basalt fills
# make them poor bright markers -- that is a geological judgement about which
# features are valid inputs, not a threshold tuned until the check passes.
# Every name here is confirmed present in the *curated* set (see the module
# docstring); Hermes, Laplace, Brisbane, Mons Hadley and Cyrano are absent from
# it -- the first four from the gazetteer itself, Cyrano through budget pruning
# -- so they could never be looked up.
HIGHLAND_CENTRES = ['Tycho', 'Copernicus', 'Kepler', 'Aristarchus', 'Clavius',
                    'Theophilus', 'Langrenus', 'Janssen', 'Maginus',
                    'Ptolemaeus', 'Petavius', 'Piccolomini', 'Regiomontanus',
                    'Avogadro', 'Hermite', 'Messala']
# A misregistered map cannot produce this much contrast; a flipped or rotated
# one cannot produce it with the correct sign.
MIN_CONTRAST_DN = 25.0
MIN_SAMPLES = 15
PROBE_LEVEL = 5


def tile_pixel(out_dir: str, layer: str, L: int, lon: float, lat: float) -> int:
    """The DN of the single world pixel that contains (lon, lat).

    A missing tile raises FileNotFoundError rather than reading as 0: a hole in
    the pyramid must show up as a crash here, not as a dark pixel that quietly
    helps the mare median.
    """
    lon = wrap_lon(lon)
    x = grid.lon_to_tile_x(lon, L)
    y = grid.lat_to_tile_y(lat, L)
    path = Path(out_dir) / layer / str(L) / str(x) / f'{y}.jpg'
    im = np.asarray(Image.open(path).convert('L'))
    wx, wy = grid.world_px_of(lon, lat, L)
    col = min(max(int(wx) - x * grid.TILE, 0), grid.TILE - 1)
    row = min(max(int(wy) - y * grid.TILE, 0), grid.TILE - 1)
    return int(im[row, col])


def _percentile(counts: np.ndarray, total: int, p: float) -> int:
    """Nearest-rank percentile from a 256-bin DN histogram."""
    rank = max(1, min(int(math.ceil(p / 100.0 * total)), total))
    return int(np.searchsorted(np.cumsum(counts), rank, side='left'))


def albedo_percentiles(out_dir: str, layer: str = 'paper',
                       level: int = PROBE_LEVEL) -> dict:
    """Mean and quantiles of every pixel of the level's tiles.

    Accumulated as a 256-bin histogram while streaming, because the L5 layer is
    2,048 tiles = 536,870,912 pixels; concatenating them as float32 would need
    ~2.2 GB, and the decoded values are uint8 so the histogram is exact.
    """
    paths = sorted((Path(out_dir) / layer / str(level)).glob('*/*.jpg'))
    if not paths:
        raise SystemExit(f'no {layer} tiles at level {level} under {out_dir}')
    counts = np.zeros(256, dtype=np.int64)
    for p in paths:
        im = np.asarray(Image.open(p).convert('L'))
        if im.dtype != np.uint8:
            im = np.clip(np.rint(im.astype(np.float64)), 0,
                         255).astype(np.uint8)
        counts += np.bincount(im.ravel(), minlength=256)
    total = int(counts.sum())
    return {'level': level,
            'mean': round(float((np.arange(256) * counts).sum()) / total, 2),
            'p33': _percentile(counts, total, 33),
            'p67': _percentile(counts, total, 67),
            'samples': total,
            'tiles': len(paths)}


def _by_name(features_path: str) -> dict:
    # UTF-8 pinned: the label set carries IAU names outside cp1252, and Windows
    # would otherwise decode with the locale codec (same defect labels.py hit).
    fc = json.loads(Path(features_path).read_text(encoding='utf-8'))
    return {f['properties']['name']: f for f in fc['features']}


def run_proof(out_dir: str, features_path: str = 'public/data/features.json',
              level: int = PROBE_LEVEL) -> dict:
    feats = _by_name(features_path)
    hist = albedo_percentiles(out_dir, 'paper', level)
    checks, failures = {}, []

    def sample(names, kind):
        vals = []
        for name in names:
            f = feats.get(name)
            if f is None:
                failures.append(f'{kind} marker absent from the curated set: {name}')
                continue
            lon, lat = f['geometry']['coordinates']
            v = tile_pixel(out_dir, 'paper', level, lon, lat)
            vals.append(v)
            checks[f'{kind}:{name}'] = str(v)
        return vals

    mare = sample(MARE_CENTRES, 'mare')
    high = sample(HIGHLAND_CENTRES, 'highland')

    mare_med = float(np.median(mare)) if mare else float('nan')
    high_med = float(np.median(high)) if high else float('nan')

    if len(mare) < MIN_SAMPLES or len(high) < MIN_SAMPLES:
        failures.append(f'samples too small: mare={len(mare)} highland={len(high)} '
                        f'(need {MIN_SAMPLES} each)')
    else:
        if not mare_med < high_med:
            failures.append(
                f'mare median {mare_med:.1f} is not darker than highland median '
                f'{high_med:.1f}: the map is inverted, rotated 180 deg in longitude, '
                f'or the labels are misplaced')
        contrast = high_med - mare_med
        if contrast < MIN_CONTRAST_DN:
            failures.append(f'contrast {contrast:.1f} DN is below the '
                            f'{MIN_CONTRAST_DN} DN floor')
        if mare_med > hist['mean']:
            failures.append(f'mare median {mare_med:.1f} above the global mean '
                            f'{hist["mean"]}')
        if high_med < hist['mean']:
            failures.append(f'highland median {high_med:.1f} below the global mean '
                            f'{hist["mean"]}')

    # Apollo 11 evidence comes from IAU astronaut-named (code LF) traverse
    # features whose origin names the Apollo 11 site: West, Little West, Double,
    # Mount Marilyn. There is no gazetteer record named "Apollo 11". Their own
    # bboxes are nulled upstream (Little West and Double are pinned defects), so
    # containment is tested against the *mare's* bbox, which is trusted.
    a11 = [f for f in feats.values()
           if (f['properties'].get('mission') or '') == 'Apollo 11']
    if not a11:
        failures.append('no Apollo 11 traverse feature in the curated label set')
    elif 'Mare Tranquillitatis' not in feats:
        failures.append('Mare Tranquillitatis missing, cannot place Apollo 11')
    else:
        w, s, e, n = feats['Mare Tranquillitatis']['properties']['bbox']
        for f in a11:
            name = f['properties']['name']
            lon, lat = f['geometry']['coordinates']
            v = tile_pixel(out_dir, 'paper', level, lon, lat)
            checks[f'apollo11:{name}'] = f'{lon:.4f},{lat:.4f} albedo {v}'
            if not bbox_contains([w, s, e, n], lon, lat):
                failures.append(f'Apollo 11 feature {name} at {lon},{lat} is outside '
                                f'the Tranquillitatis bbox [{w},{s},{e},{n}]')
            if v > hist['p67']:
                failures.append(f'Apollo 11 feature {name} reads bright ({v}) inside '
                                f'a mare (p67={hist["p67"]})')

    return {'passed': not failures,
            'level': level,
            'mareSamples': len(mare), 'highlandSamples': len(high),
            'mareMedian': round(mare_med, 2), 'highlandMedian': round(high_med, 2),
            'contrast': round(high_med - mare_med, 2),
            'histogram': hist, 'checks': checks, 'failures': failures}


def _json_safe(obj):
    """Replace every non-finite float with None, recursively.

    A FAILING gate has NaN numbers by construction: an unresolvable marker leaves
    its sample list short, `np.median([])` is NaN, and `round(nan, 2)` is still
    NaN. `json.dumps` serialises that as the bare token `NaN`, which Python reads
    back happily and a browser's `JSON.parse` refuses -- so the one command that
    reports a failure used to corrupt `public/tiles/manifest.json`, a tracked
    artifact the app loads, at exactly the moment it was most needed. Nulls keep
    the manifest parseable and keep the failure record. Pair with
    `allow_nan=False` below, which makes any value this function missed raise
    before the write rather than after it.
    """
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    return obj


def main(out: str = 'public/tiles',
         features_path: str = 'public/data/features.json',
         level: int = PROBE_LEVEL) -> int:
    """Run the gate and record the verdict in the manifest.

    The arguments exist so the failure path can be tested without writing to the
    tracked pyramid; the shipped call is `main()` from `npm run proof`. The
    record goes out through `manifest.write_manifest`, the one writer this repo
    has for this artifact, so running the gate changes only the two gate keys and
    leaves the file's line endings and trailing newline exactly as the bake
    writer made them -- on every platform.
    """
    res = _json_safe(run_proof(out, features_path, level))
    mp = Path(out) / 'manifest.json'
    m = json.loads(mp.read_text(encoding='utf-8'))
    m['albedoHistogram'] = res['histogram']
    m['geometryProof'] = {'passed': res['passed'], 'level': res['level'],
                          'mareMedian': res['mareMedian'],
                          'highlandMedian': res['highlandMedian'],
                          'contrast': res['contrast'],
                          'checks': res['checks'], 'failures': res['failures']}
    # `allow_nan=False` stays as the belt to `_json_safe`'s braces: a non-finite
    # value that function missed must raise BEFORE anything is written, not
    # corrupt the tracked artifact after. It is a check, not the writer -- the
    # bytes come from the one writer this repo has.
    json.dumps(m, indent=1, allow_nan=False)
    # MUST FIX 2: this used to be `mp.write_text(json.dumps(...), encoding='utf-8')`.
    # On Windows `write_text` translates every '\n' to CRLF, and `json.dumps`
    # emits no trailing newline, so the one command that reports the gate rewrote
    # the tracked `public/tiles/manifest.json` with 290 CRLF terminators and a
    # file ending mid-line -- undoing Task 17 finding 13's fix in
    # `manifest.write_manifest`, which writes LF bytes plus a final `}\n`
    # precisely so that artifact does not depend on the writer's platform.
    # `scripts/tests/test_proof.py::test_the_two_manifest_writers_agree_byte_for_byte`
    # pins the two writers on the same bytes.
    manifest_mod.write_manifest(mp, m)
    print(json.dumps(res, indent=1))
    print(f'GATE G2 {"PASS" if res["passed"] else "FAIL"}')
    return 0 if res['passed'] else 4


if __name__ == '__main__':
    sys.exit(main())
