import sys
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from blur import gauss1d, blur_separable


def test_kernel_is_normalised_and_symmetric():
    k = gauss1d(2.5, 8)
    assert k.shape == (17,)
    assert k.sum() == pytest.approx(1.0, abs=1e-6)
    assert np.allclose(k, k[::-1])


def test_constant_field_is_unchanged_exactly():
    a = np.full((32, 64), 7.0, np.float32)
    assert np.allclose(blur_separable(a, 2.5, 8), 7.0, atol=1e-5)


def test_seam_is_treated_as_adjacent_when_wrapping():
    # a column-constant impulse at x=0 must leak equally to x=-1 and x=+1
    a = np.zeros((9, 64), np.float32)
    a[:, 0] = 1.0
    out = blur_separable(a, 2.5, 3, wrap_x=True)
    assert out[4, -1] > 1e-3
    assert out[4, -1] == pytest.approx(out[4, 1], rel=1e-6)


def test_no_wrap_keeps_the_far_edge_at_zero():
    a = np.zeros((9, 64), np.float32)
    a[:, 0] = 1.0
    out = blur_separable(a, 2.5, 3, wrap_x=False)
    assert out[4, -1] == 0.0


def test_y_is_always_edge_clamped_not_wrapped():
    a = np.zeros((21, 21), np.float32)
    a[0, 10] = 1.0
    out = blur_separable(a, 2.0, 4, wrap_x=True)
    assert out[0, 10] > out[20, 10] == 0.0


def test_impulse_support_is_limited_to_the_radius_and_symmetric():
    a = np.zeros((33, 33), np.float32)
    a[16, 16] = 1.0
    r = 4
    out = blur_separable(a, 2.0, r)
    assert out[16, 16 + r + 1] == 0.0
    assert out[16 + r + 1, 16] == 0.0
    assert np.allclose(out[16, 16 - r : 16 + r + 1], out[16, 16 + r : 16 - r - 1 : -1])
    assert out.sum() == pytest.approx(1.0, abs=1e-5)
