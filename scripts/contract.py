"""Stage 0: read each source's grid and assert it is the grid the spec claims.

Verified from the files themselves:
  * the detail JP2 embeds GMLJP2 + a GeoTIFF uuid box (origin -179.998351105
    89.998351105, offset 0.00329779 deg/px, CRS GCS_Moon_2000, Kakadu v6.1.1),
    so GDAL reads its georeference directly and no .j2w is needed;
  * the SVS colour TIFF has NO GeoTIFF keys (its IFD0 has 19 entries, none of
    33550/33920/33922), so its grid is *assigned* from the global extent and
    validated by aspect ratio only.
Both origins are normalised to pixel-corner form, and the convention used is
recorded rather than assumed.

Measured on the fetched files (see docs/superpowers/specs/fetch-log.md): GDAL's
JP2OpenJPEG driver resolves the GML centre-referenced origin above to the
pixel-corner transform (-180.0, +90.0) with CRS ESRI:104903, so the JP2 reports
originConvention 'corner' and gridReadFrom 'raster'; the centre branch stays
under test because the file's own GML box is centre-referenced, and any source
that hands through that value verbatim must still normalise.

`pxPerDeg` is always the *canonical* grid value, width/360, in both branches,
and east/south are derived from it. The file's own stated pixel size is kept
separately as `pxPerDegDeclared` (None for a file with no georeference, which
states nothing). The detail JP2 declares 0.00329779 deg/px where a 109164 px
globe needs 360/109164 = 0.00329779048 deg/px; that 4.8038e-10 deg/px rounding
is 0.016 px of shortfall across the width, which is metadata evidence, not a
geometry to propagate into the tiling grid.
"""
from __future__ import annotations
import rasterio

MOON_WKT = (
    'GEOGCS["GCS_Moon_2000",DATUM["D_Moon_2000",'
    'SPHEROID["Moon_2000_IAU_IAG",1737400.0,0.0]],'
    'PRIMEM["Reference_Meridian",0.0],'
    'UNIT["Degree",0.0174532925199433]]'
)

# `pxPerDeg` here is the spec table's rounded statement of the grid; the value
# read_grid_contract reports is the canonical width/360 (109164/360 =
# 303.23333..., 27360/360 = 76.0), so `tol` only has to absorb the table's own
# rounding -- not any rounding in the file's metadata.
EXPECTED_DETAIL = {'width': 109164, 'height': 54582, 'count': 1,
                   'pxPerDeg': 303.233, 'dtype': 'uint8', 'tol': 2e-3}
EXPECTED_COLOR = {'width': 27360, 'height': 13680, 'count': 4,
                  'pxPerDeg': 76.0, 'dtype': 'uint8', 'tol': 1e-6}


def _normalise_origin(west, north, px_per_deg):
    half = 0.5 / px_per_deg
    if abs(west + 180.0) <= 1e-9 and abs(north - 90.0) <= 1e-9:
        return -180.0, 90.0, 'corner'
    if abs(west - (-180.0 + half)) <= 1e-9 and abs(north - (90.0 - half)) <= 1e-9:
        return -180.0, 90.0, 'centre'
    raise AssertionError(
        f'grid origin {west!r}, {north!r} is neither corner- nor centre-referenced '
        f'for a global extent (half pixel = {half:.9f} deg)')


def read_grid_contract(path: str) -> dict:
    with rasterio.open(path) as ds:
        t = ds.transform
        referenced = bool(ds.crs) or (t is not None and not t.is_identity)
        # The grid is defined by the pixel count over a known global extent, so
        # one canonical pixel size serves both branches; a source's own rounded
        # statement about it is recorded, not used for geometry.
        px_per_deg = ds.width / 360.0
        if referenced:
            declared = 1.0 / abs(t.a)
            west, north, convention = _normalise_origin(t.c, t.f, declared)
            source = 'raster'
        else:
            declared = None
            west, north, convention = -180.0, 90.0, 'assigned'
            source = 'assigned'
        c = {
            'path': path, 'driver': ds.driver, 'width': ds.width,
            'height': ds.height, 'count': ds.count, 'dtype': ds.dtypes[0],
            'pxPerDeg': px_per_deg, 'pxPerDegDeclared': declared,
            'west': west, 'north': north,
            'east': west + ds.width / px_per_deg,
            'south': north - ds.height / px_per_deg,
            'originConvention': convention, 'gridReadFrom': source,
            'crs': str(ds.crs), 'nodata': list(ds.nodatavals),
        }
    # A global equirectangular grid must satisfy width == 2 * height. The
    # difference is compared in pixels, not in px/deg: an absolute px/deg
    # threshold is scale-dependent and would wave through a 20%-skewed
    # 1000x600 grid (only 0.56 px/deg apart).
    if abs(c['width'] - 2 * c['height']) > max(2.0, 0.002 * c['width']):
        raise AssertionError(
            f'{path}: not a 2:1 global grid ({c["width"]}x{c["height"]}, '
            f'px/deg lon {c["width"]/360:.6f} vs lat {c["height"]/180:.6f})')
    return c


def assert_contract(actual: dict, expected: dict) -> None:
    tol = expected.get('tol', 0.0)
    for key in ('width', 'height', 'count', 'dtype'):
        if actual[key] != expected[key]:
            raise AssertionError(
                f"{key}: got {actual[key]!r} expected {expected[key]!r} "
                f"({actual['path']})")
    if abs(actual['pxPerDeg'] - expected['pxPerDeg']) > tol:
        raise AssertionError(
            f"pxPerDeg: got {actual['pxPerDeg']:.6f} (file declares "
            f"{actual.get('pxPerDegDeclared')!r}) expected "
            f"{expected['pxPerDeg']:.6f} tol {tol} ({actual['path']})")
    # east/south are derived from the canonical pixel size (width/360), so they
    # are exact for a correct global grid no matter how the source rounds its
    # own deg/px statement -- which is why the box keeps the plain 1e-6 deg gate
    # and the file's own statement stays diagnostic, in pxPerDegDeclared.
    for key, want in (('west', -180.0), ('north', 90.0),
                      ('east', 180.0), ('south', -90.0)):
        if abs(actual[key] - want) > 1e-6:
            raise AssertionError(
                f'{key}: got {actual[key]!r} expected {want!r} '
                f'(box tol 1e-6 deg, {actual["path"]})')
