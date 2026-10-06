"""Chroma transfer with high-frequency detail injection (spec §2.2).

Both inputs are single global mosaics on registered grids, so this is a
per-pixel raster composite: no field-of-view or illumination mixing is
possible, which is the property the brief asked us to protect.

At k = 0 the algebra collapses to mean(B) * (B / mean(B)) == B, and the float32
rounding error is far below 0.5, so rint recovers the original bytes exactly.
That identity is asserted, not assumed.
"""
from __future__ import annotations
import numpy as np
from blur import blur_separable

EPS = 1e-3


def chroma_detail(base: np.ndarray, detail: np.ndarray, k: float | None = 0.4,
                  sigma: float = 2.5, radius: int = 8) -> np.ndarray:
    if base.ndim != 3 or base.shape[2] != 3:
        raise ValueError(f'base must be (H,W,3), got {base.shape}')
    if detail.shape != base.shape[:2]:
        raise ValueError(f'detail {detail.shape} does not match base {base.shape[:2]}')
    if k is None or k == 0.0:
        return base.copy()

    B = base.astype(np.float32)
    D = detail.astype(np.float32)
    meanB = B.mean(axis=2)
    chi = B / np.maximum(meanB[..., None], EPS)
    lpD = blur_separable(D, sigma, radius, wrap_x=True)
    hpD = D - lpD
    muD = max(float(D.mean()), EPS)
    gain = 1.0 + k * hpD / muD
    out = np.clip(np.rint(meanB[..., None] * gain[..., None] * chi), 0.0, 255.0)
    return out.astype(np.uint8)
