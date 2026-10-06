import sys
from pathlib import Path
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from composite import chroma_detail


def rand_base(seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    # every pixel clearly non-black, so mean(B) >= 1 everywhere
    return rng.integers(40, 250, (33, 41, 3)).astype(np.uint8)


def test_k_zero_reproduces_the_base_bit_for_bit():
    B = rand_base(1)
    D = np.full(B.shape[:2], 128, np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.0), B)


def test_none_detail_returns_the_base():
    B = rand_base(2)
    D = np.zeros(B.shape[:2], np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=None), B)


def test_flat_detail_leaves_the_base_alone():
    """A constant detail field has no high-frequency band at all."""
    B = rand_base(3)
    D = np.full(B.shape[:2], 200, np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.4), B)


def test_chroma_is_held_and_dark_detail_darkens_the_pixel():
    B = np.zeros((17, 25, 3), np.uint8)
    B[..., 0], B[..., 1], B[..., 2] = 200, 100, 50
    D = np.full(B.shape[:2], 180, np.uint8)
    D[:, 12] = 20
    out = chroma_detail(B, D, k=0.8, sigma=1.0, radius=4)
    interior = (slice(2, 15), slice(2, 23))
    ro = out[interior][..., 0] / out[interior][..., 2]
    rb = B[interior][..., 0] / B[interior][..., 2]
    assert np.allclose(ro, rb, rtol=0.08)
    assert int(out[:, 12].astype(np.int32).sum()) < int(out[:, 2].astype(np.int32).sum())


def test_output_dtype_shape_clamp_and_finiteness():
    B = rand_base(4)
    D = np.random.default_rng(5).integers(0, 255, B.shape[:2]).astype(np.uint8)
    out = chroma_detail(B, D, k=1.5)
    assert out.dtype == np.uint8 and out.shape == B.shape
    assert np.isfinite(out).all()


def test_all_black_pixel_does_not_diverge():
    B = np.zeros((9, 9, 3), np.uint8)
    D = np.zeros((9, 9), np.uint8)
    assert np.array_equal(chroma_detail(B, D, k=0.4), B)
