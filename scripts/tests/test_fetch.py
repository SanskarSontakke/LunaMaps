"""Tests for the fetch/provenance layer of scripts/fetch_data.py.

No network, and nothing is read from or written to the real data/raw: every
test points `fetch_data.RAW` at a tmp_path and replaces the transport with a
fake urlopen, so the resumable / force / merge logic is exercised against
kilobytes instead of gigabytes.
"""
import hashlib
import io
import json
import struct
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fetch_data

URL = 'https://example.invalid/src.bin'
SPEC = {'role': 'testraster', 'name': 'src.bin', 'url': URL,
        'bytes': 100, 'sidecars': []}
SIDECAR = 'https://example.invalid/src.bin.aux.xml'
SIDECAR_BODY = b'<AuxiliaryMetadata/>'
LABELS_SPEC = next(s for s in fetch_data.SOURCE_SPECS if s['role'] == 'labels')


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200):
        self._body, self.status, self._pos = body, status, 0

    def read(self, n: int = -1) -> bytes:
        chunk = self._body[self._pos:self._pos + n]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def install_transport(monkeypatch, payload: bytes, total: int | None = None):
    """Serve `payload` for GET/Range requests; no socket is ever opened."""
    announced = len(payload) if total is None else total
    calls = []

    def fake_urlopen(req, timeout=None):
        calls.append(req)
        rng = req.headers.get('Range')
        start = int(rng.split('=')[1].split('-')[0]) if rng else 0
        return FakeResponse(payload[start:], status=206 if rng else 200)

    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: announced)
    monkeypatch.setattr(fetch_data.urllib.request, 'urlopen', fake_urlopen)
    return calls


def no_network(monkeypatch):
    def boom(*a, **k):
        raise AssertionError('must not touch the network')
    monkeypatch.setattr(fetch_data.urllib.request, 'urlopen', boom)


@pytest.fixture
def raw(tmp_path, monkeypatch):
    root = tmp_path / 'raw'
    root.mkdir(parents=True)
    monkeypatch.setattr(fetch_data, 'RAW', root)
    return root


# ------------------------------------------------------------- I3: partials --

def test_download_finalises_only_the_exact_size(raw, monkeypatch):
    install_transport(monkeypatch, bytes(range(100)))
    dest = fetch_data.download(URL, raw / 'src.bin')
    assert dest.read_bytes() == bytes(range(100))
    assert not (raw / 'src.bin.part').exists()


def test_a_partial_is_resumed_with_a_range_header(raw, monkeypatch):
    (raw / 'src.bin.part').write_bytes(bytes(range(40)))
    calls = install_transport(monkeypatch, bytes(range(100)))
    assert fetch_data.download(URL, raw / 'src.bin').read_bytes() == bytes(range(100))
    assert calls[-1].headers.get('Range') == 'bytes=40-'


def test_an_exactly_complete_partial_is_promoted_without_the_network(raw, monkeypatch):
    """Proved resume behaviour must survive the force changes."""
    (raw / 'src.bin.part').write_bytes(b'x' * 100)
    no_network(monkeypatch)
    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: 100)
    assert fetch_data.download(URL, raw / 'src.bin').stat().st_size == 100


def test_an_oversized_partial_is_refused_not_promoted(raw, monkeypatch):
    """A .part bigger than the object is corrupt evidence, not a finished file."""
    (raw / 'src.bin.part').write_bytes(b'x' * 180)
    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: 100)
    no_network(monkeypatch)
    with pytest.raises(SystemExit, match='more than'):
        fetch_data.download(URL, raw / 'src.bin')
    assert not (raw / 'src.bin').exists(), 'oversized partial was promoted'


def test_a_truncated_transfer_never_reaches_the_final_name(raw, monkeypatch):
    """Content-Length 100 but a 60-byte body: refuse to promote, keep resuming."""
    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: 100)
    monkeypatch.setattr(fetch_data.urllib.request, 'urlopen',
                        lambda req, timeout=None: FakeResponse(b'y' * 60))
    with pytest.raises(SystemExit, match='truncated'):
        fetch_data.download(URL, raw / 'src.bin')
    assert not (raw / 'src.bin').exists()
    assert (raw / 'src.bin.part').stat().st_size == 60, 'partial must stay resumable'


def test_force_uses_its_own_part_path_and_ignores_a_stale_partial(raw, monkeypatch):
    (raw / 'src.bin.part').write_bytes(b'\x00' * 60)      # stale, wrong content
    calls = install_transport(monkeypatch, bytes(range(100)))
    dest = fetch_data.download(URL, raw / 'src.bin', force=True)
    assert dest.read_bytes() == bytes(range(100))
    assert calls[-1].headers.get('Range') is None, 'force must not resume'
    assert (raw / 'src.bin.part').read_bytes() == b'\x00' * 60, 'stale part clobbered'
    assert not (raw / 'src.bin.force.part').exists()


def test_force_starting_against_an_oversized_partial_still_succeeds(raw, monkeypatch):
    (raw / 'src.bin.part').write_bytes(b'x' * 180)
    install_transport(monkeypatch, bytes(range(100)))
    assert fetch_data.download(URL, raw / 'src.bin', force=True).stat().st_size == 100


def test_fetch_reports_a_stale_part_and_force_discards_it(raw, monkeypatch):
    (raw / 'src.bin.part').write_bytes(b'x' * 180)
    install_transport(monkeypatch, bytes(range(100)))
    with pytest.raises(SystemExit, match='more than'):
        fetch_data.fetch(SPEC)
    rec = fetch_data.fetch(SPEC, force=True)
    assert rec['bytes'] == 100
    assert not rec.get('reused')


# ------------------------------------------------ I6: spec vs Content-Length --

def test_content_length_disagreement_proceeds_and_is_recorded(raw, monkeypatch):
    """The server wins, but the disagreement is written to provenance."""
    install_transport(monkeypatch, bytes(range(90)), total=90)
    rec = fetch_data.fetch(dict(SPEC, bytes=100))
    assert rec['bytes'] == 90
    assert rec['specMismatch'] is True


def test_agreeing_sizes_record_no_mismatch(raw, monkeypatch):
    install_transport(monkeypatch, bytes(range(100)), total=100)
    assert fetch_data.fetch(SPEC)['specMismatch'] is False


def test_a_size_matching_neither_the_spec_nor_the_server_fails(raw, monkeypatch):
    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: 90)

    def bogus_download(url, dest, total=None, force=False):
        dest.write_bytes(b'z' * 77)
        return dest

    monkeypatch.setattr(fetch_data, 'download', bogus_download)
    with pytest.raises(SystemExit, match='neither'):
        fetch_data.fetch(SPEC)


# ---------------------------------------------------------- I2: merge by role --

def test_records_merge_by_role_and_stamp_only_this_run():
    prior = [{'role': 'detail', 'name': 'd.jp2', 'bytes': 1, 'sha256': 'aa',
              'fetchedAt': 'OLD'},
             {'role': 'labels', 'name': 'l.zip', 'bytes': 2, 'sha256': 'bb',
              'fetchedAt': 'OLD'}]
    current = [{'role': 'labels', 'name': 'l.zip', 'bytes': 3, 'sha256': 'cc'}]
    merged = fetch_data.merge_records(prior, current, fetched_at='NEW')
    assert [r['role'] for r in merged] == ['detail', 'labels'], \
        'roles must survive in SOURCE_SPECS order'
    by_role = {r['role']: r for r in merged}
    assert by_role['detail']['bytes'] == 1, 'prior role was dropped'
    assert by_role['detail']['fetchedAt'] == 'OLD'
    assert by_role['labels']['bytes'] == 3, 'this run did not win'
    assert by_role['labels']['sha256'] == 'cc'
    assert by_role['labels']['fetchedAt'] == 'NEW'


def test_merge_records_appends_an_unknown_role():
    merged = fetch_data.merge_records([], [{'role': 'other', 'bytes': 1}],
                                      fetched_at='NEW')
    assert [r['role'] for r in merged] == ['other']


def test_write_records_merges_into_the_existing_file(raw, monkeypatch):
    path = raw / 'sha256.json'
    path.write_text(json.dumps([{'role': 'detail', 'name': 'd.jp2', 'bytes': 1,
                                 'sha256': 'aa', 'fetchedAt': 'OLD'}]))
    monkeypatch.setattr(fetch_data, 'utc_now', lambda: 'NEW')
    fetch_data.write_records(path, [{'role': 'color', 'name': 'c.tif',
                                     'bytes': 2, 'sha256': 'bb'}])
    out = {r['role']: r for r in json.loads(path.read_text())}
    assert set(out) == {'detail', 'color'}
    assert out['detail']['fetchedAt'] == 'OLD'
    assert out['color']['fetchedAt'] == 'NEW'


def test_a_corrupt_or_absent_history_is_tolerated(raw, monkeypatch):
    path = raw / 'sha256.json'
    path.write_text('not json at all')
    monkeypatch.setattr(fetch_data, 'utc_now', lambda: 'NEW')
    fetch_data.write_records(path, [{'role': 'labels', 'name': 'l.zip', 'bytes': 1}])
    assert json.loads(path.read_text())[0]['role'] == 'labels'


def test_main_keeps_provenance_for_roles_it_did_not_fetch(raw, monkeypatch):
    """The --only labels run must not delete detail's or color's record."""
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'detail', 'name': 'LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
          'url': 'u', 'bytes': 2_500_331_610, 'sha256': 'aa', 'fetchedAt': 'OLD'},
         {'role': 'color', 'name': 'lroc_color_poles.tif', 'url': 'u',
          'bytes': 518_090_428, 'sha256': 'bb', 'fetchedAt': 'OLD'}]))
    monkeypatch.setattr(fetch_data, 'utc_now', lambda: 'NEW')
    monkeypatch.setattr(
        fetch_data, 'fetch',
        lambda spec, force=False, verify=False: {'role': spec['role'],
                                                 'name': spec['name'], 'bytes': 7})
    monkeypatch.setattr(fetch_data, 'probe_capabilities',
                        lambda: {'rasterio': '0', 'drivers': {}})
    monkeypatch.setattr(sys, 'argv', ['fetch_data.py', '--only', 'labels'])
    assert fetch_data.main() == 0
    out = {r['role']: r for r in json.loads((raw / 'sha256.json').read_text())}
    assert set(out) == {'detail', 'color', 'labels'}, 'a role was dropped'
    assert out['detail']['sha256'] == 'aa'
    assert out['labels']['fetchedAt'] == 'NEW'
    assert out['detail']['fetchedAt'] == 'OLD', 'partial run not visible'


# ---------------------------------------------------- Minor 9: cached digests --

def test_reuse_rehashes_by_default(raw, monkeypatch):
    """Always-verify is the default: name + size is not proof of content.

    The measured cost of re-hashing is ~2.5 s for the whole 3 GB of sources, so
    the reuse path re-reads them and reports what they actually contain.
    """
    body = b'q' * 100
    digest = hashlib.sha256(body).hexdigest()
    (raw / 'src.bin').write_bytes(body)
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'testraster', 'name': 'src.bin', 'bytes': 100,
          'sha256': digest}]))
    calls = []
    real_sha256 = fetch_data.sha256
    monkeypatch.setattr(fetch_data, 'sha256',
                        lambda p: calls.append(p) or real_sha256(p))
    no_network(monkeypatch)
    rec = fetch_data.fetch(SPEC)
    assert calls == [raw / 'src.bin'], 'the default did not re-hash'
    assert rec['sha256'] == digest
    assert rec['sha256Source'] == 'computed'
    assert rec['sha256Verified'] is True


def test_skip_verify_copies_the_recorded_digest_without_rehashing(raw, monkeypatch):
    """The escape hatch stays honest about not having hashed anything."""
    (raw / 'src.bin').write_bytes(b'q' * 100)
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'testraster', 'name': 'src.bin', 'bytes': 100,
          'sha256': 'rec' + '0' * 61}]))
    calls = []
    monkeypatch.setattr(fetch_data, 'sha256',
                        lambda p: calls.append(p) or 'computed')
    no_network(monkeypatch)
    rec = fetch_data.fetch(SPEC, verify=False)
    assert rec['sha256'] == 'rec' + '0' * 61
    assert rec['sha256Source'] == 'recorded'
    assert rec['sha256Verified'] is False
    assert calls == [], 'hashed a file it did not need to'


def test_skip_verify_still_hashes_when_nothing_is_recorded(raw, monkeypatch):
    """An escape hatch with no history must not report a digest it invented."""
    body = b'q' * 100
    digest = hashlib.sha256(body).hexdigest()
    (raw / 'src.bin').write_bytes(body)
    no_network(monkeypatch)
    rec = fetch_data.fetch(SPEC, verify=False)
    assert rec['sha256'] == digest
    assert rec['sha256Source'] == 'computed'
    assert rec['sha256Verified'] is True


def test_a_rehash_that_disagrees_with_the_record_fails_loud(raw, monkeypatch):
    """Verification that never compares the two digests verifies nothing.

    The file is silently re-labelled with a new digest otherwise, and the
    2.5 GB source that changed under us would reach the bake unremarked.
    """
    (raw / 'src.bin').write_bytes(b'q' * 100)
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'testraster', 'name': 'src.bin', 'bytes': 100,
          'sha256': 'dead' + '0' * 58}]))
    no_network(monkeypatch)
    with pytest.raises(SystemExit, match='digest'):
        fetch_data.fetch(SPEC)


def test_reuse_rehashes_when_the_record_does_not_match(raw, monkeypatch):
    """A record for a *different* file is no record at all -- and no mismatch."""
    (raw / 'src.bin').write_bytes(b'q' * 100)
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'testraster', 'name': 'other.bin', 'bytes': 100,
          'sha256': 'stale' + '0' * 59}]))
    monkeypatch.setattr(fetch_data, 'sha256', lambda p: 'computed' + '0' * 58)
    rec = fetch_data.fetch(SPEC)
    assert rec['sha256'] == 'computed' + '0' * 58
    assert rec['sha256Source'] == 'computed'
    assert rec['sha256Verified'] is True


def test_verify_rehashes_even_when_a_digest_is_recorded(raw, monkeypatch):
    body = b'q' * 100
    digest = hashlib.sha256(body).hexdigest()
    (raw / 'src.bin').write_bytes(body)
    (raw / 'sha256.json').write_text(json.dumps(
        [{'role': 'testraster', 'name': 'src.bin', 'bytes': 100,
          'sha256': digest}]))
    monkeypatch.setattr(fetch_data, 'sha256',
                        lambda p: hashlib.sha256(p.read_bytes()).hexdigest())
    rec = fetch_data.fetch(SPEC, verify=True)
    assert rec['sha256'] == digest
    assert rec['sha256Source'] == 'computed'
    assert rec['sha256Verified'] is True


def test_main_verifies_by_default_and_only_skips_on_request(raw, monkeypatch):
    seen = []

    def fake_fetch(spec, force=False, verify=True):
        seen.append(verify)
        return {'role': spec['role'], 'name': spec['name'], 'bytes': 7,
                'sha256': 'x' * 64}

    monkeypatch.setattr(fetch_data, 'fetch', fake_fetch)
    monkeypatch.setattr(fetch_data, 'probe_capabilities',
                        lambda: {'rasterio': '0', 'drivers': {'detail': {'open': True}}})
    monkeypatch.setattr(sys, 'argv', ['fetch_data.py', '--only', 'color'])
    assert fetch_data.main() == 0
    assert seen == [True], 'the default run did not verify'

    seen.clear()
    monkeypatch.setattr(sys, 'argv', ['fetch_data.py', '--only', 'color',
                                     '--skip-verify'])
    assert fetch_data.main() == 0
    assert seen == [False], '--skip-verify did not reach fetch()'


# --------------------------------------------------------------- I3: sidecars --

def test_sidecars_are_size_checked_too(raw, monkeypatch):
    (raw / 'src.bin').write_bytes(b'q' * 100)
    (raw / 'src.bin.aux.xml.part').write_bytes(b'x' * 80)
    monkeypatch.setattr(fetch_data, 'remote_size', lambda url: 50)
    no_network(monkeypatch)
    out = fetch_data.fetch_sidecars(dict(SPEC, sidecars=[SIDECAR]))
    assert out['src.bin.aux.xml']['ok'] is False
    assert 'more than' in out['src.bin.aux.xml']['error']
    assert not (raw / 'src.bin.aux.xml').exists(), 'oversized sidecar part promoted'


def test_sidecar_success_records_its_verified_size(raw, monkeypatch):
    install_transport(monkeypatch, SIDECAR_BODY)
    out = fetch_data.fetch_sidecars(dict(SPEC, sidecars=[SIDECAR]))
    assert out['src.bin.aux.xml'] == {'ok': True, 'bytes': len(SIDECAR_BODY)}


def test_force_gives_the_sidecar_its_own_part_path(raw, monkeypatch):
    (raw / 'src.bin.aux.xml.part').write_bytes(b'x' * len(SIDECAR_BODY))
    install_transport(monkeypatch, SIDECAR_BODY)
    out = fetch_data.fetch_sidecars(dict(SPEC, sidecars=[SIDECAR]), force=True)
    assert out['src.bin.aux.xml']['ok'] is True
    assert (raw / 'src.bin.aux.xml').read_bytes() == SIDECAR_BODY
    assert (raw / 'src.bin.aux.xml.part').read_bytes() == b'x' * len(SIDECAR_BODY)


# -------------------------------------------------- I5: archive integrity -----

def test_archive_probe_reports_crc_status(raw):
    (raw / LABELS_SPEC['name']).write_bytes(_zip_bytes(b'hello' * 40))
    rec = _probe_labels()
    assert rec['archive'] is True
    assert rec['crcOk'] is True
    assert rec['badFile'] is None


def test_archive_probe_catches_a_corrupt_member(raw):
    (raw / LABELS_SPEC['name']).write_bytes(_corrupt_zip_bytes(b'hello' * 40))
    rec = _probe_labels()
    assert rec['crcOk'] is False
    assert rec['badFile'] == 'a.txt'


def _probe_labels():
    return fetch_data.probe_capabilities()['drivers']['labels']


def _zip_bytes(body: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_STORED) as z:
        z.writestr('a.txt', body.decode())
    return buf.getvalue()


def _corrupt_zip_bytes(body: bytes) -> bytes:
    """Flip one stored-data byte so only a CRC read (testzip) can see it."""
    data = _zip_bytes(body)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        info = z.getinfo('a.txt')
    name_len, extra_len = struct.unpack_from('<HH', data, info.header_offset + 26)
    pos = info.header_offset + 30 + name_len + extra_len + 5
    assert bytes([data[pos]]) != b'@'
    return data[:pos] + b'@' + data[pos + 1:]
