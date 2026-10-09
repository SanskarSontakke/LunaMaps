"""Derive each level from the level below by 2x2 box averages of four tiles.

Every parent has exactly four children at every level (a level has twice the
columns and rows of the one below, and level 0 is the base case), so there is no
partial-child special case to get wrong. Parents come from decoded JPEG, so they
are marginally softer than a fresh source read would give; in exchange parent
and child are geometrically identical, which is what stops cross-level flicker.
"""
from __future__ import annotations
from pathlib import Path
import numpy as np
from PIL import Image
import grid


def parent_from_children(kids) -> np.ndarray:
    nw, ne, sw, se = kids
    top = np.concatenate([nw, ne], axis=1)
    bot = np.concatenate([sw, se], axis=1)
    big = np.concatenate([top, bot], axis=0).astype(np.float32)
    h, w = big.shape[0], big.shape[1]
    if big.ndim == 2:
        p = big.reshape(h // 2, 2, w // 2, 2).mean(axis=(1, 3))
    else:
        p = big.reshape(h // 2, 2, w // 2, 2, big.shape[2]).mean(axis=(1, 3))
    return np.clip(np.rint(p), 0.0, 255.0).astype(np.uint8)


def read_tile(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path))


def derive_levels(out_dir, layer: str, top: int, quality: int,
                  save_tile) -> int:
    """Re-encode every parent from the children currently on disk.

    `save_tile` is called with force=True on purpose: a parent is not source
    data, it is a function of its children, so whenever the children exist the
    parent has to match them rather than whatever it was last written as.

    The consequence, which the 2026-10-09 review measured: on a resume this
    re-encodes ALL parents while `save_tile`'s existence test keeps every
    top-level child, so the two halves of the tree are encoded by different
    runs. That is only safe while the two encoders agree, and the only thing in
    this pipeline that makes them agree is `bake.check_encoder_params`, which
    refuses a resume whose `quality`/`detailGain` differ from the delivered
    record. Do not weaken that guard from here.
    """
    out = Path(out_dir) / layer
    written = 0
    for L in range(top, 0, -1):
        cols, rows = grid.level_cols(L - 1), grid.level_rows(L - 1)
        for py in range(rows):
            for px in range(cols):
                kids = [read_tile(out / str(L) / str(px * 2 + dx) / f'{py * 2 + dy}.jpg')
                        for dy in (0, 1) for dx in (0, 1)]
                arr = parent_from_children(kids)
                if save_tile(out_dir, layer, L - 1, px, py, arr, quality, True):
                    written += 1
    return written
