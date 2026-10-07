import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds

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


SMALL_EXPECTED = {'width': W, 'height': H, 'count': 1,
                  'pxPerDeg': PX_PER_DEG, 'dtype': 'uint8', 'tol': 1e-6}


def test_accepts_the_corner_origin_convention(tmp_path):
    c = contract.read_grid_contract(make_grid(tmp_path, 'corner.tif', -180.0, 90.0))
    assert c['originConvention'] == 'corner'
    assert c['gridReadFrom'] == 'raster'
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
    assert c['pxPerDeg'] == pytest.approx(PX_PER_DEG)
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
    assert c['pxPerDeg'] == pytest.approx(PX_PER_DEG)
    assert c['west'] == pytest.approx(-180.0)


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


# Measured from data/raw/LRO_WAC_Mosaic_Global_303ppd_v3.jp2 itself. The JP2's
# GML offsetVector is written as 0.00329779 deg/px, while a 109164 px globe
# needs 360/109164 = 0.0032977904...; the 4.8e-9 deg/px rounding shortfall
# accumulates to 5.24e-5 deg over the width, i.e. 0.016 of one pixel.
DETAIL_BOX = {'path': 'detail-jp2-rounding', 'width': 109164, 'height': 54582,
              'count': 1, 'dtype': 'uint8', 'pxPerDeg': 303.23337750432864,
              'west': -180.0, 'north': 90.0,
              'east': 179.99994756, 'south': -89.99997378}


def test_the_extent_box_absorbs_the_sources_rounded_pixel_size():
    """0.016 px of decimal rounding must not be read as a broken georeference."""
    contract.assert_contract(DETAIL_BOX, contract.EXPECTED_DETAIL)


def test_the_extent_box_still_rejects_a_whole_pixel_of_drift():
    """One pixel at 303 ppd is 0.0033 deg -- ~20x the rounding budget."""
    with pytest.raises(AssertionError, match='east'):
        contract.assert_contract(dict(DETAIL_BOX, east=179.99665),
                                 contract.EXPECTED_DETAIL)
    with pytest.raises(AssertionError, match='south'):
        contract.assert_contract(dict(DETAIL_BOX, south=-89.99665),
                                 contract.EXPECTED_DETAIL)
