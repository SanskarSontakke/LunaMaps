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
