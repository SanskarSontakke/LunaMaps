"""Ranged, resumable, size- and hash-verified download of the three sources.

Provenance lives in `data/raw/sha256.json`, one record per *role*, merged rather
than rewritten: a `--only color,labels` run must not erase the detail source's
history. Every record carries the `fetchedAt` timestamp of the run that last
touched that role, so a partial run is visible in the file.

Integrity note, stated plainly: the reuse path verifies *size*, and by default
copies the digest recorded by an earlier run instead of re-hashing 2.5 GB each
time (`sha256Source: 'recorded'`, `sha256Verified: false`). A file of the right
name and size but wrong contents would only be caught by `--verify`, which
re-hashes, or by `--force`, which re-downloads.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
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
     'kind': 'archive',
     'url': 'https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/MOON_nomenclature_center_pts.zip',
     'bytes': 23_845_070, 'sidecars': []},
]


def _content_range_total(header: str | None) -> int | None:
    # 'bytes 0-0/2500331610' -> 2500331610
    if header and '/' in header:
        try:
            return int(header.rsplit('/', 1)[1])
        except ValueError:
            return None
    return None


def remote_size(url: str) -> int | None:
    """Content-Length from HEAD, falling back to a 1-byte ranged GET.

    S3 answers HEAD with 405 on some endpoints, and a request past the end of a
    small object with 416, so a probe that cannot be served is not treated as a
    download failure -- it is retried as a GET before giving up.
    """
    try:
        req = urllib.request.Request(url, method='HEAD')
        with urllib.request.urlopen(req, timeout=120) as r:
            value = r.headers.get('Content-Length')
        if value:
            return int(value)
    except (urllib.error.HTTPError, urllib.error.URLError, ValueError) as exc:
        print(f'note  HEAD {url} failed ({exc}); probing with a ranged GET',
              flush=True)
    req = urllib.request.Request(url, headers={'Range': 'bytes=0-0'})
    with urllib.request.urlopen(req, timeout=120) as r:
        total = _content_range_total(r.headers.get('Content-Range'))
        if total:
            return total
        value = r.headers.get('Content-Length')
    return int(value) if value else None


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def _part_path(dest: Path, force: bool = False) -> Path:
    """`<name>.part`, or `<name>.force.part` when --force must not resume.

    A forced run has to start from zero. Sharing one partial path would have it
    resume exactly the stale bytes --force exists to discard -- and a partial
    left larger than the object would then be promoted as a completed transfer.
    """
    return dest.with_suffix(dest.suffix + ('.force.part' if force else '.part'))


def _promote(tmp: Path, dest: Path, total: int, url: str) -> Path:
    """Rename a partial to the final name only if it really is `total` bytes."""
    size = tmp.stat().st_size
    if size != total:
        raise SystemExit(f'{url}: {tmp.name} holds {size:,} B, expected {total:,} B; '
                         'refusing to promote it to the final name')
    tmp.replace(dest)
    return dest


def download(url: str, dest: Path, total: int | None = None,
             force: bool = False) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = _part_path(dest, force)
    have = tmp.stat().st_size if tmp.exists() else 0
    if total is None:
        total = remote_size(url)
    if total is None:
        raise SystemExit(f'{url}: no Content-Length; refusing to guess a size')
    if have > total:
        raise SystemExit(f'{url}: {tmp.name} holds {have:,} B, more than the '
                         f'{total:,} B object; delete it or re-run with --force')
    if have == total:
        return _promote(tmp, dest, total, url)
    headers = {'Range': f'bytes={have}-'} if have else {}
    # headers= must be a keyword: Request's second positional parameter is
    # `data`, and passing the header dict there flips the method to POST, which
    # S3 rejects with 405 Method Not Allowed.
    try:
        handle = urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=900)
    except urllib.error.HTTPError as exc:
        # 416 with a non-empty .part means the partial already covers the
        # object: finish it instead of calling it a failed transfer.
        if exc.code == 416 and have and total and have >= total:
            return _promote(tmp, dest, total, url)
        raise
    with handle as r:
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
    return _promote(tmp, dest, total, url)


def fetch_sidecars(spec, force: bool = False) -> dict:
    """Fetch PAM/metadata sidecars next to the main file -- best effort.

    They must land beside the raster because GDAL resolves a .aux.xml by
    location. A failure here is deliberately non-fatal: the detail JP2 embeds
    its own georeference (GMLJP2 box plus a GeoTIFF uuid box), so the deciding
    evidence is Stage 0's gridReadFrom == 'raster', not the sidecar's presence.
    Size is still checked -- `download` refuses to promote a partial that is not
    exactly the advertised length, and the outcome is recorded per sidecar.
    """
    out = {}
    for url in spec['sidecars']:
        name = Path(url).name
        dest = RAW / name
        try:
            got = download(url, dest, force=force)
            out[name] = {'ok': True, 'bytes': got.stat().st_size}
            print(f'      sidecar {name} ({got.stat().st_size:,} B)', flush=True)
        except (Exception, SystemExit) as exc:
            # SystemExit is a BaseException, so listing it explicitly is what
            # keeps "no Content-Length" from aborting a finished 2.5 GB fetch.
            out[name] = {'ok': False, 'error': f'{type(exc).__name__}: {exc}'}
            print(f'note  sidecar {name} not fetched ({exc}); non-fatal -- the '
                  f'georeference is embedded in the source itself', flush=True)
    return out


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def read_records(path: Path) -> list:
    """Previously recorded provenance; a missing or corrupt history is empty."""
    try:
        data = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return []
    if isinstance(data, dict):
        data = data.get('records', [])
    return [rec for rec in data if isinstance(rec, dict) and rec.get('role')]


def merge_records(prior, current, fetched_at: str | None = None) -> list:
    """Merge this run's records into the previous ones, keyed by role.

    Rewriting the file from `current` alone lost the provenance of every role a
    partial run skipped, so roles not fetched keep their earlier record and
    their earlier `fetchedAt`, which is what makes a partial run legible.
    """
    by_role = {rec['role']: dict(rec) for rec in prior}
    stamp = fetched_at if fetched_at is not None else utc_now()
    for rec in current:
        merged = dict(by_role.get(rec['role'], {}))
        merged.update(rec)
        merged['fetchedAt'] = stamp
        by_role[rec['role']] = merged
    order = [spec['role'] for spec in SOURCE_SPECS]
    return ([by_role[role] for role in order if role in by_role]
            + [by_role[role] for role in by_role if role not in order])


def write_records(path: Path, current, fetched_at: str | None = None) -> list:
    """Merge by role and write the whole provenance file back."""
    merged = merge_records(read_records(path), current, fetched_at=fetched_at)
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(merged, indent=1), encoding='utf-8')
    return merged


def _digest_for(spec, dest: Path, size: int, verify: bool = False):
    """(digest, hashed_now) for an already-present file of the expected size."""
    if not verify:
        for rec in read_records(RAW / 'sha256.json'):
            if (rec.get('role') == spec['role'] and rec.get('name') == spec['name']
                    and rec.get('bytes') == size and rec.get('sha256')):
                return rec['sha256'], False
    return sha256(dest), True


def _record(spec, size, digest, hashed, reused, spec_mismatch, sidecars) -> dict:
    return {'name': spec['name'], 'url': spec['url'], 'role': spec['role'],
            'bytes': size, 'sha256': digest,
            'sha256Source': 'computed' if hashed else 'recorded',
            'sha256Verified': bool(hashed), 'reused': reused,
            'specMismatch': spec_mismatch, 'sidecars': sidecars}


def fetch(spec, force=False, verify=False) -> dict:
    dest = RAW / spec['name']
    if dest.exists() and not force:
        size = dest.stat().st_size
        if size == spec['bytes']:
            digest, hashed = _digest_for(spec, dest, size, verify)
            print(f'have  {spec["name"]} ({size:,} B, sha256 {digest[:12]}… '
                  f'{"re-hashed" if hashed else "as recorded, --verify to re-hash"})',
                  flush=True)
            return _record(spec, size, digest, hashed, True, False,
                           fetch_sidecars(spec, force))
        print(f'      {spec["name"]} is the wrong size; re-downloading')
    total = remote_size(spec['url'])
    mismatch = bool(total and spec['bytes'] and total != spec['bytes'])
    if mismatch:
        print(f'note  {spec["name"]}: Content-Length {total:,} differs from the '
              f'spec value {spec["bytes"]:,}; proceeding on Content-Length and '
              f'recording specMismatch', flush=True)
    download(spec['url'], dest, total, force=force)
    size = dest.stat().st_size
    if size != spec['bytes'] and size != total:
        raise SystemExit(f'{spec["name"]}: {size:,} B on disk matches neither the '
                         f'spec value {spec["bytes"]:,} nor Content-Length {total:,}')
    sidecars = fetch_sidecars(spec, force)
    print(f'gave  {spec["name"]} ({size:,} B)')
    return _record(spec, size, sha256(dest), True, False, mismatch, sidecars)


def probe_capabilities() -> dict:
    import rasterio
    out = {'rasterio': rasterio.__version__, 'drivers': {}}
    for spec in SOURCE_SPECS:
        path = RAW / spec['name']
        if not path.exists():
            continue
        if spec.get('kind') == 'archive':
            # The gazetteer is a shapefile zip, not a raster: probing it with
            # rasterio produced a bogus open:false + RasterioIOError that read
            # like a driver failure. Verify it as an archive instead -- and
            # verify it *fully*: namelist() only reads the central directory,
            # so it proves nothing about the member data. testzip() inflates
            # every member and checks its CRC-32, and the result is recorded.
            import zipfile
            try:
                with zipfile.ZipFile(path) as z:
                    names = z.namelist()
                    bad_file = z.testzip()
                out['drivers'][spec['role']] = {
                    'archive': True, 'entries': len(names),
                    'members': names, 'crcOk': bad_file is None,
                    'badFile': bad_file, 'isRaster': False,
                    'note': 'shapefile bundle consumed by scripts/labels.py; '
                            'not a raster, so no GDAL driver is involved. crcOk '
                            'is ZipFile.testzip(): every member inflated and '
                            'CRC-32 checked'}
            except Exception as exc:
                out['drivers'][spec['role']] = {
                    'archive': False, 'isRaster': False,
                    'error': f'{type(exc).__name__}: {exc}'}
            continue
        try:
            with rasterio.open(path) as ds:
                rec = {'open': True, 'shape': list(ds.shape), 'count': ds.count,
                       'dtypes': list(ds.dtypes), 'crs': str(ds.crs),
                       'transform': list(ds.transform), 'driver': ds.driver,
                       'nodata': list(ds.nodatavals)}
                win = ds.read(1, window=((0, 64), (0, 64)))
                rec.update(decode_min=int(win.min()), decode_max=int(win.max()))
            out['drivers'][spec['role']] = rec
        except Exception as exc:
            out['drivers'][spec['role']] = {
                'open': False, 'isRaster': True,
                'error': f'{type(exc).__name__}: {exc}'}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--verify', action='store_true',
                    help='re-hash files already on disk instead of trusting the '
                         'digest recorded in sha256.json (costs a 2.5 GB read)')
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
        records.append(fetch(spec, a.force, a.verify))
    caps = probe_capabilities()
    # Merge by role: `--only labels` must leave detail's and color's provenance
    # intact, with their older fetchedAt showing which roles this run skipped.
    write_records(RAW / 'sha256.json', records)
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
