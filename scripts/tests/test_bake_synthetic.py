import json
import sys
from pathlib import Path
import numpy as np
import pytest
import rasterio
from PIL import Image
from rasterio.crs import CRS
from rasterio.transform import from_bounds

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import contract
import derive
import grid

SRC_W, SRC_H = 1024, 512
WKT = contract.MOON_WKT


def write_raster(path, array, west=-180.0, north=90.0):
    count = array.shape[2] if array.ndim == 3 else 1
    t = from_bounds(west, north - 180.0, west + 360.0, north,
                    array.shape[1], array.shape[0])
    with rasterio.open(path, 'w', driver='GTiff', width=array.shape[1],
                       height=array.shape[0], count=count, dtype='uint8',
                       crs=CRS.from_wkt(WKT), transform=t) as ds:
        for b in range(count):
            ds.write(array[..., b] if count > 1 else array, b + 1)
    return str(path)


@pytest.fixture
def sources(tmp_path):
    """Detail: dark band straddling lon=+-180, bright elsewhere (a seam test).
    Colour: a warm flat tone with an alpha of 255."""
    yy, xx = np.mgrid[0:SRC_H, 0:SRC_W]
    seam = (xx < SRC_W // 8) | (xx >= 7 * SRC_W // 8)
    detail = np.where(seam, 30, 200).astype(np.uint8)
    colour = np.dstack([
        np.full((SRC_H, SRC_W), 190, np.uint8),
        np.full((SRC_H, SRC_W), 170, np.uint8),
        np.full((SRC_H, SRC_W), 150, np.uint8),
        np.full((SRC_H, SRC_W), 255, np.uint8),
    ])
    d = write_raster(tmp_path / 'detail.tif', detail)
    c = write_raster(tmp_path / 'colour.tif', colour)
    return d, c


def bake_kwargs(sources, out, **over):
    d, c = sources
    kw = dict(detail=d, color=c, layers=('paper', 'photo'), top=1, quality=95,
              band_rows=512, k=0.4, out_dir=str(out), force=True)
    kw.update(over)
    return kw


def test_tile_counts_are_exact(sources, tmp_path):
    import bake
    out = tmp_path / 'tiles'
    bake.run(**bake_kwargs(sources, out))
    for layer in ('paper', 'photo'):
        assert len(list((out / layer / '0').rglob('*.jpg'))) == 2
        assert len(list((out / layer / '1').rglob('*.jpg'))) == 8


def test_band_rows_must_align_to_tiles(sources, tmp_path):
    import bake
    with pytest.raises(ValueError, match='multiple'):
        bake.run(**bake_kwargs(sources, tmp_path / 'x', band_rows=300))


def test_parent_equals_box_average_of_children(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('photo',), quality=100, k=0.0))
    kids = [np.array(Image.open(out / 'photo' / '1' / str(x) / f'{y}.jpg'))
            for (x, y) in [(0, 0), (1, 0), (0, 1), (1, 1)]]
    parent = derive.parent_from_children(kids)
    on_disk = np.array(Image.open(out / 'photo' / '0' / '0' / '0.jpg'))
    assert int(np.abs(parent.astype(np.int32) - on_disk.astype(np.int32)).max()) <= 2


def test_seam_is_continuous_across_the_antimeridian(sources, tmp_path):
    """The dark band straddles lon=+-180, so both tiles touching the seam must
    read the same mean at their facing edges. A non-periodic blur would differ."""
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('photo',), k=1.0, sigma=2.5))
    cols = grid.level_cols(1)
    left = np.array(Image.open(out / 'photo' / '1' / '0' / '0.jpg'))
    right = np.array(Image.open(out / 'photo' / '1' / str(cols - 1) / '0.jpg'))
    assert abs(int(left[:, -8:].mean()) - int(right[:, :8].mean())) <= 2


def test_the_band_blur_is_periodic_across_a_step_at_the_seam(tmp_path):
    """Continuity is not periodicity, so this is the test that proves the wrap.

    The fixture above puts a 256 px-wide (at L1) dark band *around* lon=+-180,
    which means both the periodic and the edge-clamped blur see nothing but
    dark pixels at columns 0 and W-1 -- they agree there, and the assertion
    cannot tell the two boundary conditions apart. A step exactly at the
    antimeridian is the layout where they differ: with `wrap_x=True` the kernel
    at column 0 reads the far side's dark pixels and overshoots bright, and the
    kernel at column W-1 reads the bright side and undershoots dark. With
    `wrap_x=False` both edges stay flat at the base colour and the antimeridian
    shows the classic 1-tile-wide streak.

    Measured (work/wrap_probe.py, red channel, L1 tile edges vs a flat reference
    64 px inside the same tile): periodic 237 (+46) and 124 (-67); edge-clamped
    191 (+0) and 191 (+0). The thresholds below are that gap, not a guess.
    """
    yy, xx = np.mgrid[0:SRC_H, 0:SRC_W]
    detail = np.where(xx < SRC_W // 2, 200, 30).astype(np.uint8)
    colour = np.dstack([
        np.full((SRC_H, SRC_W), 190, np.uint8),
        np.full((SRC_H, SRC_W), 170, np.uint8),
        np.full((SRC_H, SRC_W), 150, np.uint8),
        np.full((SRC_H, SRC_W), 255, np.uint8),
    ])
    d = write_raster(tmp_path / 'step.tif', detail)
    c = write_raster(tmp_path / 'colour.tif', colour)
    out = tmp_path / 'tiles'
    import bake
    bake.run(detail=d, color=c, layers=('photo',), top=1, quality=95,
             band_rows=512, k=1.0, out_dir=str(out), force=True)
    cols = grid.level_cols(1)
    left = np.array(Image.open(out / 'photo' / '1' / '0' / '0.jpg'))[..., 0]
    right = np.array(Image.open(out / 'photo' / '1' / str(cols - 1) / '0.jpg'))[..., 0]
    # 96 px inside the tile: outside the 8 px kernel's reach, so the composite
    # of a flat detail region is exactly the base colour (red channel 190).
    flat = int(left[:, 96:160].mean())
    assert abs(flat - 190) <= 2, flat
    assert int(left[:, :4].mean()) - flat > 30
    assert flat - int(right[:, -4:].mean()) > 30


def test_rerun_writes_nothing(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    before = len(list(out.rglob('*.jpg')))
    again = bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0, force=False))
    assert again == 0
    assert len(list(out.rglob('*.jpg'))) == before


def test_manifest_records_measured_numbers(sources, tmp_path):
    out = tmp_path / 'tiles'
    import bake
    bake.run(**bake_kwargs(sources, out, layers=('paper',), top=0))
    m = json.loads((out / 'manifest.json').read_text())
    assert m['schema'] == 1
    assert m['grid']['tileSize'] == grid.TILE
    assert m['grid']['radiusMeters'] == 1737400.0
    assert m['grid']['yOrigin'] == 'north'
    assert m['layers']['paper']['top'] == 0
    assert m['layers']['paper']['tiles'] == 2
    assert m['layers']['paper']['bytes'] > 0
    assert m['levels'][6]['mPerPx'] == pytest.approx(166.6, abs=0.6)


def test_estimate_grows_superlinearly():
    import bake
    a = bake.estimate(6, ('paper', 'photo'))
    b = bake.estimate(7, ('paper', 'photo'))
    assert b['files'] == a['files'] + 2 * grid.level_cols(7) * grid.level_rows(7)
    assert b['bytes'] > a['bytes'] * 2
