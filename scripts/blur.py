"""Separable Gaussian without scipy.

The x axis is periodic by default because callers pass full-width longitude
bands: column 0 and column W-1 are physical neighbours on the globe. The y axis
is always edge-clamped because the poles are real boundaries.
"""
from __future__ import annotations
import numpy as np


def gauss1d(sigma: float, radius: int) -> np.ndarray:
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    k /= k.sum()
    return k.astype(np.float32)


def blur_separable(a: np.ndarray, sigma: float = 2.5, radius: int = 8,
                   wrap_x: bool = True) -> np.ndarray:
    """Separable Gaussian blur of a 2-D array, returning float32 of the same shape.

    PRECONDITION: with the default `wrap_x=True`, this is correct only when `a`
    spans the full 360 degrees of longitude, i.e. when its width equals
    `grid.world_px_width(L)` for the level being baked. Only then are column 0
    and column W-1 physical neighbours on the globe and the periodic pad the
    right boundary condition.

    Any narrower band -- a crop, a region, a single 512 px tile -- MUST pass
    `wrap_x=False`. With the default it silently blends the opposite edge of
    the same array into each seam column (at sigma=2.5, radius=8 an impulse on
    column 0 puts 14.7% of its energy on column W-1) and nothing raises. The y
    axis is edge-clamped either way: the poles are real boundaries.
    """
    if a.ndim != 2:
        raise ValueError(f'blur_separable needs a 2-D array, got shape {a.shape}')
    k = gauss1d(sigma, radius)
    h, w = a.shape

    ax = np.pad(a, ((0, 0), (radius, radius)),
               mode='wrap' if wrap_x else 'edge').astype(np.float32)
    tmp = np.zeros((h, w), np.float32)
    for i, weight in enumerate(k):
        tmp += weight * ax[:, i : i + w]

    ay = np.pad(tmp, ((radius, radius), (0, 0)), mode='edge')
    out = np.zeros((h, w), np.float32)
    for i, weight in enumerate(k):
        out += weight * ay[i : i + h, :]
    return out
