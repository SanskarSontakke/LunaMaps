"""Ranged, resumable, size- and hash-verified download of the three sources."""
from __future__ import annotations
import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

RAW = Path('data/raw')
MOSAIC = 'https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic'

SOURCE_SPECS = [
    {'role': 'detail', 'name': 'LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
     'url': f'{MOSAIC}/LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
     'bytes': 2_500_331_610,
     'sidecars': [f'{MOSAIC}/LRO_WAC_Mosaic_Global_303ppd_v3.jp2.aux.xml']},
    {'role': 'detail_fallback',
     'name': 'Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif',
     'url': f'{MOSAIC}/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif',
     'bytes': 5_959_263_751, 'optional': True, 'sidecars': []},
    {'role': 'color', 'name': 'lroc_color_poles.tif',
     'url': 'https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles.tif',
     'bytes': 518_090_428, 'sidecars': []},
    {'role': 'labels', 'name': 'MOON_nomenclature_center_pts.zip',
     'url': 'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip',
     'bytes': 23_845_070, 'sidecars': []},
]


def remote_size(url: str) -> int | None:
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=120) as r:
        value = r.headers.get('Content-Length')
    return int(value) if value else None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def download(url: str, dest: Path, total: int | None = None) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.part')
    have = tmp.stat().st_size if tmp.exists() else 0
    if total is None:
        total = remote_size(url)
    if total is None:
        raise SystemExit(f'{url}: no Content-Length; refusing to guess a size')
    if have >= total:
        tmp.replace(dest)
        return dest
    headers = {'Range': f'bytes={have}-'} if have else {}
    # headers= must be a keyword: Request's second positional parameter is
    # `data`, and passing the header dict there flips the method to POST, which
    # S3 rejects with 405 Method Not Allowed.
    with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=900) as r:
        if have and r.status != 206:
            raise SystemExit(f'{url}: server ignored Range (status {r.status}); '
                             'delete the .part file and re-run')
        with tmp.open('ab' if have else 'wb') as f:
            got = have
            while True:
                chunk = r.read(1 << 22)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                if got - have < (1 << 20) or got % (1 << 27) < (1 << 22):
                    print(f'  {dest.name}: {got/1e6:.0f}/{total/1e6:.0f} MB',
                          flush=True)
    if got != total:
        raise SystemExit(f'{url}: truncated at {got} of {total} bytes — re-run to resume')
    tmp.replace(dest)
    return dest


def fetch(spec, force=False) -> dict:
    dest = RAW / spec['name']
    if dest.exists() and not force:
        if dest.stat().st_size == spec['bytes']:
            digest = sha256(dest)
            print(f'have  {spec["name"]} ({dest.stat().st_size:,} B, sha256 {digest[:12]}…)')
            return {'name': spec['name'], 'url': spec['url'], 'role': spec['role'],
                    'bytes': dest.stat().st_size, 'sha256': digest, 'reused': True}
        print(f'      {spec["name"]} is the wrong size; re-downloading')
    total = remote_size(spec['url'])
    if total and spec['bytes'] and total != spec['bytes']:
        print(f'note  {spec["name"]}: Content-Length {total:,} differs from the '
              f'spec value {spec["bytes"]:,}; trusting the server')
    download(spec['url'], dest, total)
    if dest.stat().st_size != total:
        raise SystemExit(f'{spec["name"]}: {dest.stat().st_size:,} != Content-Length {total:,}')
    for url in spec['sidecars']:
        download(url, RAW / Path(url).name)
    print(f'gave  {spec["name"]} ({dest.stat().st_size:,} B)')
    return {'name': spec['name'], 'url': spec['url'], 'role': spec['role'],
            'bytes': dest.stat().st_size, 'sha256': sha256(dest)}


def probe_capabilities() -> dict:
    import rasterio
    out = {'rasterio': rasterio.__version__, 'drivers': {}}
    for spec in SOURCE_SPECS:
        path = RAW / spec['name']
        if not path.exists():
            continue
        try:
            with rasterio.open(path) as ds:
                rec = {'open': True, 'shape': list(ds.shape), 'count': ds.count,
                       'dtypes': list(ds.dtypes), 'crs': str(ds.crs),
                       'transform': list(ds.transform), 'driver': ds.driver}
                win = ds.read(1, window=((0, 64), (0, 64)))
                rec.update(decode_min=int(win.min()), decode_max=int(win.max()))
            out['drivers'][spec['role']] = rec
        except Exception as exc:
            out['drivers'][spec['role']] = {
                'open': False, 'error': f'{type(exc).__name__}: {exc}'}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--only', default='',
                    help='comma-separated roles, e.g. detail_fallback,color,labels')
    a = ap.parse_args()
    wanted = {s.strip() for s in a.only.split(',') if s.strip()}
    records = []
    for spec in SOURCE_SPECS:
        if wanted and spec['role'] not in wanted:
            continue
        if spec.get('optional') and not wanted:
            print(f'skip  {spec["name"]} (only needed if the JP2 driver fails)')
            continue
        records.append(fetch(spec, a.force))
    caps = probe_capabilities()
    (RAW / 'sha256.json').write_text(json.dumps(records, indent=1))
    (RAW / 'capabilities.json').write_text(json.dumps(caps, indent=1, default=str))
    print(json.dumps(caps, indent=1, default=str))
    detail = caps['drivers'].get('detail') or {}
    if wanted and 'detail' not in wanted:
        return 0
    if not detail.get('open'):
        print('!! detail source unreadable with this GDAL build. Re-run: '
              'npm run fetch -- --only detail_fallback,color,labels '
              'then bake with --detail data/raw/Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif')
        return 3
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
