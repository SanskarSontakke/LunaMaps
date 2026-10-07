import re
import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import Affine, from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract

W, H = 1212, 606           # 2:1 global grid at 3.36667 px/deg
PX_PER_DEG = W / 360.0


def make_grid(tmp_path, name, west, north, count=1, georef=True):
    path = tmp_path / name
    t = from_bounds(west, north - 180.0, west + 360.0, north, W, H)
    kw = dict(driver='GTiff', width=W, height=H, count=count, dtype='uint8')
    if georef:
        kw.update(crs=CRS.from_wkt(contract.MOON_WKT), transform=t)
    with rasterio.open(path, 'w', **kw) as ds:
        for b in range(1, count + 1):
            ds.write(np.full((H, W), 90 + b, np.uint8), b)
    return str(path)


def make_rounded_grid(tmp_path, name, deg_per_px):
    """A grid whose own pixel size is a rounded decimal, like the JP2's.

    The origin is exactly corner-referenced (-180, +90) but the pixel size is
    360/W rounded to 5 decimals, so width * deg_per_px overshoots 360 deg: the
    contract must report the canonical 360-derived pixel size and keep the
    file's rounded one as evidence only.
    """
    path = tmp_path / name
    with rasterio.open(
            path, 'w', driver='GTiff', width=W, height=H, count=1, dtype='uint8',
            crs=CRS.from_wkt(contract.MOON_WKT),
            transform=Affine(deg_per_px, 0.0, -180.0, 0.0, -deg_per_px, 90.0)) as ds:
        ds.write(np.zeros((H, W), np.uint8), 1)
    return str(path)


# 360/1212 = 0.297029702970... rounded the way the JP2 rounds 360/109164 to
# 0.00329779 -- 0.00036 deg of overshoot across the width.
ROUNDED_DEG_PER_PX = round(360.0 / W, 5)


SMALL_EXPECTED = {'width': W, 'height': H, 'count': 1,
                  'pxPerDeg': PX_PER_DEG, 'dtype': 'uint8', 'tol': 1e-6}


def test_accepts_the_corner_origin_convention(tmp_path):
    c = contract.read_grid_contract(make_grid(tmp_path, 'corner.tif', -180.0, 90.0))
    assert c['originConvention'] == 'corner'
    assert c['gridReadFrom'] == 'raster'
    assert c['pxPerDeg'] == PX_PER_DEG            # canonical, not the file's
    assert c['pxPerDegDeclared'] == pytest.approx(PX_PER_DEG)
    assert (c['west'], c['north'], c['east'], c['south']) == pytest.approx(
        (-180.0, 90.0, 180.0, -90.0))
    contract.assert_contract(c, SMALL_EXPECTED)


def test_accepts_and_normalises_the_pixel_centre_origin(tmp_path):
    # This is exactly what GDAL reports for the Kakadu/GMLJP2 mosaic:
    # origin -179.998351105 89.998351105 at 0.00329779 deg/px.
    half = 0.5 / PX_PER_DEG
    c = contract.read_grid_contract(
        make_grid(tmp_path, 'centre.tif', -180.0 + half, 90.0 - half))
    assert c['originConvention'] == 'centre'
    assert c['west'] == pytest.approx(-180.0)
    assert c['north'] == pytest.approx(90.0)
    assert c['pxPerDeg'] == PX_PER_DEG
    assert c['pxPerDegDeclared'] == pytest.approx(PX_PER_DEG)
    contract.assert_contract(c, SMALL_EXPECTED)


def test_pxPerDeg_is_canonical_even_when_the_file_rounds_its_pixel_size(tmp_path):
    """width/360 is the grid; the file's rounded value is evidence, not truth.

    The detail JP2 declares 0.00329779 deg/px where a 109164 px globe needs
    360/109164 = 0.00329779048 deg/px -- a 4.8e-10 deg/px shortfall. Deriving
    east/south from that rounded value leaves them 0.016 px short of +/-180 and
    +/-90, so the same key would mean two different things depending on the
    branch. The canonical value makes the extent exact and the declared value
    stays visible under its own key.
    """
    c = contract.read_grid_contract(
        make_rounded_grid(tmp_path, 'rounded.tif', ROUNDED_DEG_PER_PX))
    assert c['pxPerDeg'] == PX_PER_DEG
    assert c['pxPerDegDeclared'] == pytest.approx(1.0 / ROUNDED_DEG_PER_PX)
    assert c['pxPerDegDeclared'] != c['pxPerDeg']
    assert c['east'] == 180.0
    assert c['south'] == -90.0
    assert c['originConvention'] == 'corner'
    contract.assert_contract(c, SMALL_EXPECTED)


def test_rejects_a_mispositioned_origin(tmp_path):
    p = make_grid(tmp_path, 'off.tif', -179.0, 90.0)
    with pytest.raises(AssertionError, match='origin'):
        contract.read_grid_contract(p)


def test_rejects_a_grid_that_is_not_two_to_one(tmp_path):
    path = tmp_path / 'bad.tif'
    with rasterio.open(path, 'w', driver='GTiff', width=1000, height=600,
                       count=1, dtype='uint8',
                       transform=from_bounds(-180, -90, 180, 90, 1000, 600),
                       crs=CRS.from_wkt(contract.MOON_WKT)) as ds:
        ds.write(np.zeros((600, 1000), np.uint8), 1)
    with pytest.raises(AssertionError, match='2:1'):
        contract.read_grid_contract(str(path))


@pytest.mark.filterwarnings('ignore::rasterio.errors.NotGeoreferencedWarning')
def test_unreferenced_raster_gets_an_assigned_grid_and_says_so(tmp_path):
    # The missing geotransform is the point of this test, so rasterio's
    # NotGeoreferencedWarning is expected: silence it here (and only here) so
    # the suite stays warning-free.
    p = make_grid(tmp_path, 'plain.tif', 0.0, 0.0, count=4, georef=False)
    c = contract.read_grid_contract(p)
    assert c['gridReadFrom'] == 'assigned'
    assert c['count'] == 4
    assert c['pxPerDeg'] == PX_PER_DEG
    # An unreferenced file states no pixel size at all, so there is nothing to
    # declare: `assigned` must not pretend the value came from the file.
    assert c['pxPerDegDeclared'] is None
    assert c['west'] == pytest.approx(-180.0)
    assert c['east'] == 180.0
    assert c['south'] == -90.0


def test_assert_contract_names_the_offending_key(tmp_path):
    c = contract.read_grid_contract(make_grid(tmp_path, 'corner.tif', -180.0, 90.0))
    c['count'] = 3
    with pytest.raises(AssertionError, match='count'):
        contract.assert_contract(c, SMALL_EXPECTED)


def test_real_expected_numbers_match_the_spec_table():
    assert contract.EXPECTED_DETAIL['width'] == 109164
    assert contract.EXPECTED_DETAIL['height'] == 54582
    assert contract.EXPECTED_DETAIL['count'] == 1
    assert contract.EXPECTED_DETAIL['pxPerDeg'] == pytest.approx(303.233, abs=1e-3)
    assert contract.EXPECTED_COLOR['width'] == 27360
    assert contract.EXPECTED_COLOR['height'] == 13680
    assert contract.EXPECTED_COLOR['count'] == 4
    assert contract.EXPECTED_COLOR['pxPerDeg'] == pytest.approx(76.0)
    # The spec table rounds; the canonical measurement it must still cover is
    # width/360, which is what read_grid_contract now returns.
    assert abs(DETAIL_PX_PER_DEG - contract.EXPECTED_DETAIL['pxPerDeg']) \
        <= contract.EXPECTED_DETAIL['tol']
    assert abs(27360 / 360.0 - contract.EXPECTED_COLOR['pxPerDeg']) \
        <= contract.EXPECTED_COLOR['tol']


# Measured from data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2 itself. The JP2's
# GML offsetVector is written as 0.00329779 deg/px, while a 109164 px globe
# needs 360/109164 = 0.0032977904803781466 deg/px; the 4.8038e-10 deg/px
# rounding shortfall is 0.016 of one pixel once it accumulates across the
# width. read_grid_contract therefore reports the canonical 109164/360 px/deg,
# which makes east/south exact, and keeps the file's own value as
# pxPerDegDeclared.
DETAIL_PX_PER_DEG = 109164 / 360.0
DETAIL_BOX = {'path': 'detail-jp2', 'width': 109164, 'height': 54582,
              'count': 1, 'dtype': 'uint8',
              'pxPerDeg': DETAIL_PX_PER_DEG,
              'pxPerDegDeclared': 1.0 / 0.00329779,
              'west': -180.0, 'north': 90.0, 'east': 180.0, 'south': -90.0}


def test_the_canonical_detail_box_passes_the_1e6_degree_gate():
    """The exact grid needs no loosening: 1e-6 deg is reachable after all."""
    contract.assert_contract(DETAIL_BOX, contract.EXPECTED_DETAIL)


def test_a_box_derived_from_the_files_rounded_pixel_size_is_rejected():
    """The 0.05-px widening added in `1f31656` is gone, so 0.016 px fails."""
    with pytest.raises(AssertionError, match='east'):
        contract.assert_contract(dict(DETAIL_BOX, east=179.99994756),
                                 contract.EXPECTED_DETAIL)
    with pytest.raises(AssertionError, match='south'):
        contract.assert_contract(dict(DETAIL_BOX, south=-89.99997378),
                                 contract.EXPECTED_DETAIL)


def test_the_extent_box_rejects_half_a_pixel_of_drift():
    """0.5 px at 303 ppd is 1.65e-3 deg -- 1600x the 1e-6 gate, and the drift
    size the gate exists for: half a pixel off the globe is a broken grid."""
    with pytest.raises(AssertionError, match='east'):
        contract.assert_contract(dict(DETAIL_BOX, east=179.99833),
                                 contract.EXPECTED_DETAIL)
    with pytest.raises(AssertionError, match='south'):
        contract.assert_contract(dict(DETAIL_BOX, south=-89.99833),
                                 contract.EXPECTED_DETAIL)


def test_the_extent_box_still_rejects_a_whole_pixel_of_drift():
    """One pixel at 303 ppd is 0.0033 deg."""
    with pytest.raises(AssertionError, match='east'):
        contract.assert_contract(dict(DETAIL_BOX, east=179.99665),
                                 contract.EXPECTED_DETAIL)
    with pytest.raises(AssertionError, match='south'):
        contract.assert_contract(dict(DETAIL_BOX, south=-89.99665),
                                 contract.EXPECTED_DETAIL)


# The canonical box's own drift, measured from the two values the real file
# produces: 109164 * (303.23333333333335 / 303.23337750432864 - 1).
DETAIL_DECLARED_DRIFT_PX = 109164 * (DETAIL_PX_PER_DEG / (1.0 / 0.00329779) - 1.0)


def declared_at_drift_px(drift_px: float, width: int = 109164,
                         canonical: float | None = None) -> float:
    """The px/deg a file would have to state to land `drift_px` off canonical.

    east_declared - east_canonical, measured in canonical pixels, is
    `width * pxPerDeg / declared - width`; invert it for the declared value.
    """
    if canonical is None:
        canonical = DETAIL_PX_PER_DEG
    return width * canonical / (width + drift_px)


def test_the_files_own_pixel_size_is_verified_not_just_diagnostic():
    """Canonicalising pxPerDeg made east/south exact by construction, so the
    box gate stopped looking at the file's own claim. Stage 0 must still
    compare that claim against the grid it implies, or a source on a different
    pixel size passes Stage 0 while baking to the wrong geometry."""
    assert abs(DETAIL_DECLARED_DRIFT_PX) < 0.02, DETAIL_DECLARED_DRIFT_PX
    contract.assert_contract(DETAIL_BOX, contract.EXPECTED_DETAIL)


@pytest.mark.parametrize('drift_px', (0.5, -0.5, 1.0, 250.0))
def test_the_declared_pixel_size_gate_fails_at_half_a_pixel(drift_px):
    """The gate is pinned below the half-pixel that is a real grid defect."""
    declared = declared_at_drift_px(drift_px)
    with pytest.raises(AssertionError, match='pxPerDegDeclared'):
        contract.assert_contract(dict(DETAIL_BOX, pxPerDegDeclared=declared),
                                 contract.EXPECTED_DETAIL)


def test_the_declared_pixel_size_gate_clears_8_decimal_metadata():
    """8-decimal-place metadata (0.00329779) drifts 0.016 px; the gate must not
    fail on it, or Stage 0 rejects the only detail source we have."""
    half_tol = contract.DECLARED_PX_PER_DEG_TOL_PX * 0.5
    over_tol = contract.DECLARED_PX_PER_DEG_TOL_PX * 2.0
    contract.assert_contract(
        dict(DETAIL_BOX, pxPerDegDeclared=declared_at_drift_px(half_tol)),
        contract.EXPECTED_DETAIL)
    with pytest.raises(AssertionError, match='pxPerDegDeclared'):
        contract.assert_contract(
            dict(DETAIL_BOX, pxPerDegDeclared=declared_at_drift_px(over_tol)),
            contract.EXPECTED_DETAIL)


def test_a_declared_pixel_size_off_by_one_is_the_wrong_grid_not_rounding():
    """A 2x pixel size is a different globe: 109164 px of drift, and the box
    still says +/-180 and +/-90 because the extent is canonicalised."""
    with pytest.raises(AssertionError, match='pxPerDegDeclared'):
        contract.assert_contract(dict(DETAIL_BOX,
                                      pxPerDegDeclared=DETAIL_PX_PER_DEG / 2.0),
                                 contract.EXPECTED_DETAIL)


def test_a_file_that_states_no_pixel_size_is_not_checked_for_one():
    """The colour TIFF has no GeoTIFF keys: pxPerDegDeclared is None, so there
    is no claim to compare and the gate must stay silent (not fail on None)."""
    color_box = {'path': 'color-tif', 'width': 27360, 'height': 13680,
                 'count': 4, 'dtype': 'uint8', 'pxPerDeg': 27360 / 360.0,
                 'pxPerDegDeclared': None, 'west': -180.0, 'north': 90.0,
                 'east': 180.0, 'south': -90.0}
    contract.assert_contract(color_box, contract.EXPECTED_COLOR)


def test_the_gate_reports_the_drift_it_rejected(tmp_path):
    c = contract.read_grid_contract(make_rounded_grid(
        tmp_path, 'rounded.tif',
        1.0 / declared_at_drift_px(3.0, W, PX_PER_DEG)))
    with pytest.raises(AssertionError) as excinfo:
        contract.assert_contract(c, SMALL_EXPECTED)
    message = str(excinfo.value)
    assert 'pxPerDegDeclared' in message
    assert re.search(r'\b3(\.\d+)? px\b', message), message
