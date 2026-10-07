# Fetch log — Task 6: sources, driver probe, Stage 0 grid contracts

Date: 2026-10-07 (IST). Environment: Windows / Git Bash, Python `.venv` with
rasterio 1.5.2 (bundled GDAL 3.12.2), numpy 2.5.3, pyshp.
Free disk at start: 183 GB on `C:` (guard is 15 GB — not close to the limit).

Everything below is pasted from the actual commands run, not from the spec.
Sections §1, §2, §3, §6 were revised in the Task 6 **fix round** (see §7): the
Stage 0 numbers there are from re-running the checks against the files already
on disk, not from the original download pass.

## 1. What was fetched, and proof it is the right bytes

```
$ npm run fetch -- --only detail           # resuming an interrupted transfer
gave  LRO_WAC_Mosaic_Global_303ppd_v3.jp2 (2,500,331,610 B)
$ npm run fetch -- --only color,labels
gave  lroc_color_poles.tif (518,090,428 B)
gave  MOON_nomenclature_center_pts.zip (23,845,070 B)
$ npm run fetch                            # consolidated pass, exit 0
have  LRO_WAC_Mosaic_Global_303ppd_v3.jp2 (2,500,331,610 B, sha256 3c0bf3c5e34d…)
      sidecar LRO_WAC_Mosaic_Global_303ppd_v3.jp2.aux.xml (5,248 B)
skip  Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif (only needed if the JP2 driver fails)
have  lroc_color_poles.tif (518,090,428 B, sha256 15a6b44b26dc…)
have  MOON_nomenclature_center_pts.zip (23,845,070 B, sha256 ac7a198add0c…)
```

| role | file | bytes on disk | spec bytes | match |
|---|---|---|---|---|
| detail | `LRO_WAC_Mosaic_Global_303ppd_v3.jp2` | 2,500,331,610 | 2,500,331,610 | yes |
| color | `lroc_color_poles.tif` | 518,090,428 | 518,090,428 | yes |
| labels | `MOON_nomenclature_center_pts.zip` | 23,845,070 | 23,845,070 | yes |
| (sidecar) | `LRO_WAC_Mosaic_Global_303ppd_v3.jp2.aux.xml` | 5,248 | — | beside the JP2 |

* No `note … Content-Length … differs from the spec value` line was printed for
  any source, so the server-advertised Content-Length equalled the spec value
  for all three. Sizes were verified against Content-Length during the transfer
  and again against the file on disk once it closed.
* **Fix round:** that "trusting the server" note is now a recorded fact, not a
  sentence in stdout. `fetch()` fails if the size on disk matches **neither**
  the spec value nor Content-Length; when the two disagree it proceeds on
  Content-Length and writes `specMismatch: true` for that role. All three roles
  here have `specMismatch: false`.
* **Fix round — partial runs no longer erase provenance.** `sha256.json` is
  merged by role and every role this run touched is stamped with `fetchedAt`.
  Evidence from a real partial run (no bytes re-downloaded, exit 0):

  ```
  $ npm run fetch -- --only labels
  have  MOON_nomenclature_center_pts.zip (23,845,070 B, sha256 ac7a198add0c… as recorded, --verify to re-hash)
  exit=0
  $ grep -c '"role"' data/raw/sha256.json
  3                       # detail + color survived a labels-only run
  $ grep -E '"role"|"fetchedAt"|"sha256Source"|"specMismatch"' data/raw/sha256.json
    "role": "detail",
    "role": "color",
    "role": "labels",
    "sha256Source": "recorded",
    "specMismatch": false,
    "fetchedAt": "2026-10-07T01:15:14+00:00",
  ```

  `detail` and `color` keep their original records with **no** `fetchedAt` —
  they were written before the stamp existed, and this run did not touch them;
  back-dating them would be a fabrication. `labels` is the only role stamped,
  which is exactly what "a partial run is visible" means. All three roles have
  `specMismatch` false or absent, and the labels digest is `sha256Source:
  recorded` (see the integrity caveat in §6).
* SHA-256 of each file is recorded in `data/raw/sha256.json` together with the
  URL, role and sidecar outcome:
  detail `3c0bf3c5e34d52ec95633b960c92ddd97024eca168c0d5bc41e84862d6c05e95`,
  color `15a6b44b26dc963123ea6e14c4e1e193daa00162d8b40ac36bf3cc0e0740d287`,
  labels `ac7a198add0cd6094ac9645d2416a8ae755869d3f7afd8a9cc01e4a6cbd780f1`.
* **Resume behaviour proved.** A previous session died at 1,191,182,336 B of the
  JP2, leaving `….jp2.part`. Re-running sent `Range: bytes=1191182336-`, got
  206, appended to 2,500,331,610 B and only then renamed `.part` → final. The
  partial was never deleted. Bytes transferred this session:
  **1,851,090,020** (1,309,149,274 JP2 remainder + 518,090,428 color +
  23,845,070 labels + 5,248 sidecar). Total source material on disk:
  **3,042,272,356 B (~3.04 GB)**.
* The labels zip is a valid archive with the 6 expected shapefile/metadata
  members, consistent with the Task 5 fixture.
* **Archive integrity, actually measured** (fix round). The §2 probe used to
  read only `namelist()`, which is a central-directory read and proves nothing
  about member data, so the `testzip()` claim below was not backed by the
  committed code. `testzip()` has now been run on the real file, and
  `probe_capabilities()` calls it so the claim stays checked by the probe:

  ```
  $ .venv/Scripts/python.exe -c "…ZipFile(path).testzip() …"
  size on disk 23845070
  members 6 uncompressed bytes 23844198
  testzip() -> None   (None == every CRC-32 matched)
  elapsed 0.02 s
    MOON_nomenclature_center_pts.shp   254536    CRC 0x18bd28fd
    MOON_nomenclature_center_pts.shx    72796    CRC 0xa07c6167
    MOON_nomenclature_center_pts.dbf 23481450    CRC 0xeff5fb13
    MOON_nomenclature_center_pts.cpg        5    CRC 0xe813c50
    MOON_nomenclature_center_pts.prj      157    CRC 0xd0f3cb61
    metadata_nomenclature_points_MOON.xml 35254  CRC 0xf9e2bffa
  ```

  Negative control, to show the two reads are not equivalent — one byte of the
  `.prj` member's stored data flipped in a throwaway copy:

  ```
  REAL FILE  testzip() -> None | namelist() -> 6 members | 0.02 s, 23.8 MB uncompressed
  CORRUPTED  namelist() -> 6 members (looks fine) | testzip() -> 'MOON_nomenclature_center_pts.prj'
  ```

  So the §1 claim stands as written (`testzip()` clean), and it is now
  `crcOk: true, badFile: null` in `capabilities.json` rather than prose.

## 2. Driver probe — expected vs actual

Task 1 recorded GDAL 3.12.2 with `GTiff`, `JP2OpenJPEG` and `BMP` registered
(`docs/superpowers/specs/driver-probe.txt`), so the JP2 path was *expected* to
work. The actual outcome on the real 2.5 GB file is recorded independently:
**it did** — `JP2OpenJPEG` opened it and decoded real pixels. No fallback was
needed.

`data/raw/capabilities.json`, verbatim:

```json
{
 "rasterio": "1.5.2",
 "drivers": {
  "detail": {
   "open": true,
   "shape": [54582, 109164],
   "count": 1,
   "dtypes": ["uint8"],
   "crs": "ESRI:104903",
   "transform": [0.00329779, 0.0, -180.0, 0.0, -0.00329779, 90.0, 0.0, 0.0, 1.0],
   "driver": "JP2OpenJPEG",
   "nodata": [null],
   "decode_min": 0,
   "decode_max": 77
  },
  "color": {
   "open": true,
   "shape": [13680, 27360],
   "count": 4,
   "dtypes": ["uint8", "uint8", "uint8", "uint8"],
   "crs": "None",
   "transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
   "driver": "GTiff",
   "nodata": [null, null, null, null],
   "decode_min": 169,
   "decode_max": 188
  },
  "labels": {
   "archive": true,
   "entries": 6,
   "members": ["MOON_nomenclature_center_pts.shp", "MOON_nomenclature_center_pts.shx",
    "MOON_nomenclature_center_pts.dbf", "MOON_nomenclature_center_pts.cpg",
    "MOON_nomenclature_center_pts.prj", "metadata_nomenclature_points_MOON.xml"],
   "crcOk": true,
   "badFile": null,
   "isRaster": false,
   "note": "shapefile bundle consumed by scripts/labels.py; not a raster, so no GDAL driver is involved. crcOk is ZipFile.testzip(): every member inflated and CRC-32 checked"
  }
 }
}
```

(Re-pasted after the fix round: the archive branch now reports `crcOk` /
`badFile` from `testzip()`, so §1's integrity claim is produced by the committed
probe rather than asserted in prose.)

Notes on the probe:
* `detail.decode_min/max` (0/77) come from a 64×64 window at the top-left, i.e.
  the north polar region of the 303 ppd grayscale mosaic — dark but non-zero and
  clearly decoding, which is what "the driver works" means here.
* `color.transform` is the identity matrix and `crs` is `None`: the file has no
  GeoTIFF keys at all, confirming its grid must be *assigned*. Reading it emits
  rasterio's `NotGeoreferencedWarning` on stderr; that warning is the honest
  evidence behind `gridReadFrom: 'assigned'`, not a defect.
* **Fixed while recording this:** the gazetteer is a shapefile zip, but the
  probe ran it through rasterio and stored
  `"labels": {"open": false, "error": "RasterioIOError: … not recognized as
  being in a supported file format"}`. That read like a driver failure for a
  file that was never a raster. `probe_capabilities` now branches on the spec's
  `kind: 'archive'` and verifies it as a zip, and it also records per-band
  `nodata` for rasters.
* The `.aux.xml` sidecar is fetched **beside** the JP2 because GDAL resolves a
  PAM sidecar by location. Its download is deliberately **non-fatal** —
  `fetch_sidecars()` catches `Exception` *and* `SystemExit` (a `SystemExit` is
  not an `Exception`, so the brief's bare `except` would still have aborted a
  finished 2.5 GB fetch) and prints a note. Here it succeeded (5,248 B) and it
  carries the GMLJP2 `RectifiedGrid` block quoted in §3.1. The deciding evidence
  for the georeference is Stage 0's `gridReadFrom`, not the sidecar's presence.
* `remote_size()` probes with HEAD and falls back to a 1-byte ranged GET if S3
  answers 405/416 or withholds Content-Length; `download()` treats a 416 on a
  non-empty `.part` as "already complete" rather than as a failed transfer.

## 3. Stage 0 grid contracts — verdicts

Step 7 command, re-run verbatim after the fix round (restored 1e-6 deg extent
gate, canonical `pxPerDeg`), against the files already on disk — nothing
downloaded:

```
$ .venv/Scripts/python.exe -c "…read_grid_contract + assert_contract for both roles…"
detail {'driver': 'JP2OpenJPEG', 'width': 109164, 'height': 54582, 'count': 1,
        'pxPerDeg': 303.23333333333335, 'gridReadFrom': 'raster', 'originConvention': 'corner'}
color  {'driver': 'GTiff', 'width': 27360, 'height': 13680, 'count': 4,
        'pxPerDeg': 76.0, 'gridReadFrom': 'assigned', 'originConvention': 'assigned'}
STAGE 0 OK
exit=0
```

| check | detail (JP2) | color (TIF) |
|---|---|---|
| `gridReadFrom` | **`raster`** — georeference read from the file | **`assigned`** — grid imposed from the global extent |
| `originConvention` | `corner` | `assigned` |
| width × height | 109164 × 54582 | 27360 × 13680 |
| count / dtype | 1 / uint8 | 4 / uint8 |
| `pxPerDeg` (canonical, `width/360`) | 303.23333333333335 (spec table 303.233, tol 2e-3 → off by 3.34e-4) | 76.0 exactly |
| `pxPerDegDeclared` (the file's own statement) | 303.23337750432864 (= 1/0.00329779) | `null` — no georeference, so it states nothing |
| west / north / east / south | −180 / +90 / **180.0** / **−90.0** (exact) | −180 / +90 / 180.0 / −90.0 (exact) |
| 2:1 aspect | 109164 = 2 × 54582 ✓ | 27360 = 2 × 13680 ✓ |

Both required verdicts are as the brief demands: **`detail.gridReadFrom ==
'raster'`** and **`color.gridReadFrom == 'assigned'`**. The JP2-vs-TIF choice is
in §5.

Geometry keys of the detail contract, verbatim (the rest — path, driver, width,
height, count, dtype, crs, nodata — are unchanged from the pre-fix pass and are
in the table above):

```json
{"pxPerDeg": 303.23333333333335, "pxPerDegDeclared": 303.23337750432864,
 "west": -180.0, "north": 90.0, "east": 180.0, "south": -90.0,
 "gridReadFrom": "raster", "originConvention": "corner"}
```

Colour contract, geometry keys verbatim:

```json
{"pxPerDeg": 76.0, "pxPerDegDeclared": null,
 "west": -180.0, "north": 90.0, "east": 180.0, "south": -90.0,
 "gridReadFrom": "assigned", "originConvention": "assigned"}
```

### 3.1 Origin convention: what the metadata says vs what GDAL reports

The file's own GML box (mirrored in the sidecar) is **pixel-centre** referenced:

```xml
<gml:origin><gml:pos>-179.998351105 89.998351105</gml:pos></gml:origin>
<gml:offsetVector>0.00329779 0</gml:offsetVector>
<gml:offsetVector>0 -0.00329779</gml:offsetVector>
<gml:low>0 0</gml:low> <gml:high>109163 54581</gml:high>
AREA_OR_POINT=Area, srsName=GCS_Moon_2000 (Moon_2000_IAU_IAG, r=1737400 m)
```

GDAL's JP2OpenJPEG driver resolves that to the **corner** transform
`(-180.0, +90.0)`, so the JP2 came through `_normalise_origin` on the `corner`
branch, not the `centre` one. The centre branch is still required and still
under test (`test_accepts_and_normalises_the_pixel_centre_origin`), because the
raw metadata is centre-referenced and any source that hands that value through
verbatim must normalise it — the behaviour is recorded, not assumed, in the
module docstring. The CRS GDAL resolves is `ESRI:104903`, the named equivalent
of the `GCS_Moon_2000` WKT in `contract.MOON_WKT`.

### 3.2 Real-data defect found — and the first fix, which was the wrong one

With the brief's `assert_contract` as written, the real JP2 **failed Stage 0**:

```
AssertionError: east: got 179.99994756 expected 180.0
```

Cause: the GML `offsetVector` is written as `0.00329779` deg/px, while a
109164-px globe needs `360/109164 = 0.0032977904803781466` deg/px. The
**4.8038e-10 deg/px** rounding shortfall accumulates across the width to
5.244e-5 deg in `east` and 2.622e-5 deg in `south` — **0.016 of one pixel**.
(An earlier revision of this log and of `test_contract.py` stated the shortfall
as 4.8e-9 deg/px; that was off by an order of magnitude and is corrected here,
measured against the two values above.)

The first fix (commit `1f31656`) treated the symptom: it widened the box gate to
`box_tol = max(expected.get('boxTol', 1e-6), 0.05 / pxPerDeg)` — 1.65e-4 deg at
303 ppd — because `east`/`south` were *derived from the file's rounded pixel
size*. That bought a real defect: `pxPerDeg` then meant "the file's stated pixel
size" on the `raster` branch and "width/360" on the `assigned` branch, and
nothing in the returned dict said which; and it loosened a gate the task did not
need loosened.

**Superseded by the correct fix (this round, see §7):** `read_grid_contract` now
uses `ds.width/360.0` as `pxPerDeg` in **both** branches, derives `east`/`south`
from it, and keeps the file's own value under a separate key,
`pxPerDegDeclared` (`null` for a file with no georeference — the colour TIFF
states nothing, so it declares nothing). The `0.05/pxPerDeg` widening and the
`boxTol` knob are **deleted**, and the extent box is back to the brief's plain
1e-6 deg, which the real JP2 now clears exactly (`east == 180.0`,
`south == -90.0`, see §3). `_normalise_origin` still interprets the half-pixel
offset with the *declared* size, which is the metadata being described.

The gate now fails on drift the loosened version would have waved through —
tested, not asserted:

| case | east / south | result |
|---|---|---|
| canonical box (what the contract returns) | 180.0 / −90.0 | passes at 1e-6 |
| 0.016 px, i.e. the old widened-pass value | 179.99994756 | **rejected** (`east`) |
| 0.5 px at 303 ppd (1.65e-3 deg) | 179.99833 | **rejected** (`east`) |
| 1.0 px | 179.99665 | **rejected** (`east`) |

## 4. The colour file's alpha band — resolved

The spec left band 4 open. Measured three ways, each more thorough than the
last. The brief's quick corner check:

```
alpha min 255 max 255 frac 255: 1.0
rgb mean per band: [170.31, 167.95, 161.38]
```

A 400×400 corner window cannot speak for a mosaic whose poles are the interesting
part, so a stratified survey walked **full-width** 64-row bands (one LZW strip
each, all 360° of longitude) down the entire globe at a 512-row stride, plus
named windows at both poles and three longitudes:

```
 top row     lat  a.min a.max  a.mean  frac255   n<255 RGB mean per band
       0    89.6    255   255  255.00   1.0000       0 [171.88, 169.55, 162.99]
    2048    62.6    255   255  255.00   1.0000       0 [167.78, 166.41, 160.15]
    6656     2.0    255   255  255.00   1.0000       0 [138.48, 137.4, 132.64]
    9216   -31.7    255   255  255.00   1.0000       0 [148.13, 146.29, 140.6]
   13312   -85.6    255   255  255.00   1.0000       0 [172.38, 169.95, 163.36]
SAMPLED: 1728 full-width rows (12.6% of the height, 47,278,080 pixels)
alpha overall: min=255 frac(255)=1.000000 frac(<255)=0.000000 frac(0)=0.000000
  north pole, lon -180   alpha min=255 max=255 frac255=1.0000
  north pole, lon 0      alpha min=255 max=255 frac255=1.0000
  north pole, lon +90    alpha min=255 max=255 frac255=1.0000
  equator, lon 0         alpha min=255 max=255 frac255=1.0000
  south pole, lon -180   alpha min=255 max=255 frac255=1.0000
  south pole, lon 0      alpha min=255 max=255 frac255=1.0000
```

Then every strip in the file was decoded — no sampling:

```
EXHAUSTIVE band 4: 374,284,800 px (13680x27360) min=255 max=255
                   frac(255)=1.000000 frac(<255)=0.000000 frac(0)=0.000000
```

**Decision: the alpha band carries no information** — all 374,284,800 pixels of
band 4 are exactly 255 (opacity), so `frac(255) = 1.0` and the brief's first
branch applies: **drop band 4**. `flatten_alpha()` was therefore **not** added to
`scripts/composite.py` (its documented full-width band precondition from Task 4
is untouched — `git diff` shows no change to that file). The bake must keep
reading bands 1–3 only; `count: 4` stays in `EXPECTED_COLOR` because the grid
contract describes the *file*, and reading 3 of 4 bands is a bake-side choice,
not a contract violation. Had any pixel been <255 the blend would have been
needed — the measurement is what settled it.

## 5. Which source is in use

* **detail: the 303 ppd JP2** `LRO_WAC_Mosaic_Global_303ppd_v3.jp2`
  (2,500,331,610 B, `JP2OpenJPEG`, 109164 × 54582, grid read from the raster).
* **The 100 m TIF fallback was NOT downloaded.** `npm run fetch` skipped it
  (`skip Lunar_LRO_LROC-WAC_Mosaic_global_100m_June2013.tif (only needed if the
  JP2 driver fails)`), saving a 5,959,263,751 B transfer, because the JP2 driver
  worked. Exit code 0, not 3. It remains available via
  `npm run fetch -- --only detail_fallback,color,labels` if a future GDAL build
  breaks the JP2 path.
* color: `lroc_color_poles.tif` (`GTiff`, 4 bands, grid assigned).
* labels: `MOON_nomenclature_center_pts.zip` — note `scripts/labels.py` still
  reads the Task 5 fixture at `tests/fixtures/moon_nomenclature_fixture.zip`
  (identical gazetteer, committed and small); the raw copy now also exists in
  `data/raw/` for provenance.

## 6. Interfaces handed to Tasks 7–9

* `scripts/fetch_data.py`: `SOURCE_SPECS` (carrying `kind`), `remote_size`,
  `sha256`, `download(url, dest, total=None, force=False)`, `fetch(spec,
  force=False, verify=False)`, `fetch_sidecars(spec, force=False)`,
  `probe_capabilities`, `main`, and the provenance helpers `utc_now`,
  `read_records`, `merge_records(prior, current, fetched_at=None)`,
  `write_records(path, current, fetched_at=None)`; internals `_part_path`,
  `_promote`, `_digest_for`, `_record`.
* `scripts/contract.py`: `MOON_WKT`, `EXPECTED_DETAIL`, `EXPECTED_COLOR`,
  `read_grid_contract`, `assert_contract`. **`pxPerDeg` is now canonical
  (`width/360`) on both branches**; `pxPerDegDeclared` is the file's own value
  (`None` when the file states none). Use `pxPerDeg` for tiling math; use
  `width`/`height` and the normalised origin for everything else.
* `data/raw/capabilities.json`, `data/raw/sha256.json` — one record per role,
  merged rather than rewritten, each stamped with `fetchedAt`, `sha256Source`,
  `sha256Verified`, `specMismatch` and `reused`.
* Re-run: `npm run fetch` (idempotent — verifies by size, refreshes both JSON
  files, re-fetches only the 5 KB sidecar). Add `--verify` to re-hash the
  sources, `--force` to re-download them.
* **Integrity caveat, stated plainly:** the default reuse path checks *name and
  size* and then copies the digest recorded by an earlier run, so an idempotent
  `npm run fetch` no longer proves the bytes are the bytes it downloaded — a
  file of the same name and size but different contents would pass. `--verify`
  re-hashes (measured: 2.1 s for the JP2, 0.4 s for the colour TIFF) and
  `--force` re-downloads. Records make this visible: `sha256Source: "recorded"`
  / `sha256Verified: false` versus `"computed"` / `true`.
* Stage 0: the loop in §3 must print `STAGE 0 OK` before any bake is trusted.
* Probe scripts left in `work/` (git-ignored): `work/alpha_probe.py`,
  `work/alpha_full.py`.

## 7. Fix round (review of Task 6) — what changed and what was measured

Findings I1–I6 plus Minor 9. No source bytes were re-downloaded: the three
files were already size-verified in §1, `--force` was never used, and the only
commands run against `data/raw` were the Stage 0 check in §3 and
`npm run fetch -- --only labels`, both of which take the reuse path and open no
socket on the main files.

* **I1 — `pxPerDeg` means one thing now.** Canonical `width/360` in both
  branches, `pxPerDegDeclared` for the file's own statement, `east`/`south`
  derived from the canonical value, `1e-6` deg box gate restored, and the
  `0.05/pxPerDeg` widening from `1f31656` deleted together with its `boxTol`
  knob. Measured: detail `pxPerDeg 303.23333333333335` /
  `pxPerDegDeclared 303.23337750432864`, colour `76.0` / `null`; both boxes now
  exactly `east 180.0`, `south -90.0`.
* **I2 — merge by role.** Evidence in §1: a labels-only run left all three roles
  in `sha256.json` (`grep -c '"role"'` → 3) and stamped only labels.
* **I3 — force and partials.** `<name>.force.part` for forced transfers,
  `SystemExit` when a partial exceeds the advertised size, and `_promote`
  checking the size on every rename — which is what gives the sidecars the
  second size check they lacked. 8 tests in `test_fetch.py` cover refusal,
  promotion, resume and the force path.
* **I4 — the 0.5 px case** (`east = 179.99833`, 0.507 px at 303 ppd) is now a
  test, alongside 0.016 px (the value the deleted widening used to accept) and
  1.0 px. All three are rejected by the restored gate; §3 shows the real JP2
  still passing it.
* **I5 — `testzip()` actually run** on the labels archive, plus a corrupted
  negative control (§1); the committed probe now reports `crcOk`/`badFile`, and
  the log's 4.8e-9 deg/px arithmetic is corrected to 4.8038e-10 (§3.2).
* **I6 — spec vs Content-Length.** Fail when the on-disk size matches neither;
  proceed on Content-Length and record `specMismatch: true` when the two
  disagree. All three roles are `specMismatch: false` — no disagreement exists
  for these URLs today (§1).
* **Minor 9 — digest cache**, with the cost it saves measured and the property
  it gives up stated in §6 rather than implied.

Tests: `scripts/tests/test_contract.py` 9 → 12 (canonicalisation, half-pixel and
superseded-widening gates) and the new `scripts/tests/test_fetch.py` 24, so
58 → **85 passed**, also under `-W error`. `npx vitest run`: **7 passed**.
