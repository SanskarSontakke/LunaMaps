# Fetch log — Task 6: sources, driver probe, Stage 0 grid contracts

Date: 2026-10-07 (IST). Environment: Windows / Git Bash, Python `.venv` with
rasterio 1.5.2 (bundled GDAL 3.12.2), numpy 2.5.3, pyshp.
Free disk at start: 183 GB on `C:` (guard is 15 GB — not close to the limit).

Everything below is pasted from the actual commands run, not from the spec.

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
  for all three. Sizes were verified against Content-Length *and* re-checked
  after the transfer closed (`dest.stat().st_size != total` guard).
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
  members (`testzip()` clean), consistent with the Task 5 fixture.

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
   "isRaster": false,
   "note": "shapefile bundle consumed by scripts/labels.py; not a raster, so no GDAL driver is involved"
  }
 }
}
```

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
  carries the GMLJP2 `RectifiedGrid` block quoted in §4. The deciding evidence
  for the georeference is Stage 0's `gridReadFrom`, not the sidecar's presence.
* `remote_size()` probes with HEAD and falls back to a 1-byte ranged GET if S3
  answers 405/416 or withholds Content-Length; `download()` treats a 416 on a
  non-empty `.part` as "already complete" rather than as a failed transfer.

## 3. Stage 0 grid contracts — verdicts

```
$ .venv/Scripts/python.exe -c "…read_grid_contract + assert_contract for both roles…"
detail {'driver': 'JP2OpenJPEG', 'width': 109164, 'height': 54582, 'count': 1,
        'pxPerDeg': 303.23337750432864, 'gridReadFrom': 'raster', 'originConvention': 'corner'}
color  {'driver': 'GTiff', 'width': 27360, 'height': 13680, 'count': 4,
        'pxPerDeg': 76.0, 'gridReadFrom': 'assigned', 'originConvention': 'assigned'}
STAGE 0 OK
```

| check | detail (JP2) | color (TIF) |
|---|---|---|
| `gridReadFrom` | **`raster`** — georeference read from the file | **`assigned`** — grid imposed from the global extent |
| `originConvention` | `corner` | `assigned` |
| width × height | 109164 × 54582 | 27360 × 13680 |
| count / dtype | 1 / uint8 | 4 / uint8 |
| pxPerDeg | 303.23337750432864 (spec 303.233, tol 2e-3 → off by 3.78e-4) | 76.0 exactly |
| west / north / east / south | −180 / +90 / 179.99994756 / −89.99997378 | −180 / +90 / 180 / −90 |
| 2:1 aspect | 109164 = 2 × 54582 ✓ | 27360 = 2 × 13680 ✓ |

Both required verdicts are as the brief demands: **`detail.gridReadFrom ==
'raster'`** and **`color.gridReadFrom == 'assigned'`**. The JP2-vs-TIF choice is
in §5.

Full detail contract, verbatim:

```json
{
 "path": "data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2",
 "driver": "JP2OpenJPEG",
 "width": 109164, "height": 54582, "count": 1, "dtype": "uint8",
 "pxPerDeg": 303.23337750432864,
 "west": -180.0, "north": 90.0, "east": 179.99994756, "south": -89.99997378,
 "originConvention": "corner", "gridReadFrom": "raster",
 "crs": "ESRI:104903", "nodata": [null]
}
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

### 3.2 Real-data defect found and fixed: the extent box was unreachable

With the brief's `assert_contract` as written, the real JP2 **failed Stage 0**:

```
AssertionError: east: got 179.99994756 expected 180.0
```

Cause: the GML `offsetVector` is written as `0.00329779` deg/px, while a
109164-px globe needs `360/109164 = 0.0032977904…`. The 4.8e-9 deg/px rounding
shortfall accumulates across the width to 5.24e-5 deg in `east` and 2.62e-5 deg
in `south` — **0.016 of one pixel**. The brief's hard-coded `1e-6` deg box
tolerance cannot be met by *any* file with a decimal-rounded pixel size, and
`EXPECTED_DETAIL` already concedes this by carrying `tol: 2e-3` (three orders
looser than color's `1e-6`) for `pxPerDeg`; the box check contradicted that
concession. Rejecting the file here would have thrown away a 2.5 GB download
over a metadata rounding artefact.

Fix (TDD, `test_contract.py`): because `east`/`south` are *derived*
(`west + width/pxPerDeg`), the box tolerance is bounded by the pixel size —
`box_tol = max(expected.get('boxTol', 1e-6), 0.05 / pxPerDeg)`, i.e. 1.65e-4 deg
at 303 ppd. Two tests added, confirmed RED first:

```
FAILED scripts/tests/test_contract.py::test_the_extent_box_absorbs_the_sources_rounded_pixel_size
FAILED scripts/tests/test_contract.py::test_the_extent_box_still_rejects_a_whole_pixel_of_drift
2 failed, 7 deselected in 0.25s
```

then GREEN (9 passed). The gate is not weakened into a no-op: one pixel of drift
(0.0033 deg at 303 ppd) still fails by ~20×, and `west`/`north` are still
policed to 1e-9 by `_normalise_origin`, with width/height/count/dtype exact.

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

* `scripts/fetch_data.py`: `SOURCE_SPECS` (now carrying `kind`),
  `remote_size`, `sha256`, `download`, `fetch`, `fetch_sidecars`,
  `probe_capabilities`, `main`.
* `scripts/contract.py`: `MOON_WKT`, `EXPECTED_DETAIL`, `EXPECTED_COLOR`,
  `read_grid_contract`, `assert_contract`.
* `data/raw/capabilities.json`, `data/raw/sha256.json`.
* Re-run: `npm run fetch` (idempotent — re-verifies by size, re-hashes, refreshes
  both JSON files without re-downloading).
* Stage 0: the loop in §3 must print `STAGE 0 OK` before any bake is trusted.
* Probe scripts left in `work/` (git-ignored): `work/alpha_probe.py`,
  `work/alpha_full.py`.
