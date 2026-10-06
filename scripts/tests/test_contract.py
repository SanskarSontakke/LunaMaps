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


def test_unreferenced_raster_gets_an_assigned_grid_and_says_so(tmp_path):
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
