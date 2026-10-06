"""Task 2 Gate G1 probe-tile fixture.

Every tile keeps the original asymmetric half-split (northern half BLACK, southern
half WHITE, red stripe on the tile's own equator), so a correctly ordered globe must
read black-above-white.

On top of that, tile CONTENT IS A FUNCTION OF ITS (L, x, y) IDENTITY, which the first
revision of this fixture was not (it wrote the same in-tile split for every x/y, so all
10 JPEGs were byte-identical and the rendered picture could not discriminate a row or
column index error at all):

  * the white southern half carries `y + 1` horizontal light-grey bands, so
    row 0 -> 1 band, row 1 -> 2 bands: swapping which row index is north changes
    the rendered picture;
  * the black northern half carries `x` vertical dark bars, so
    column 0 -> none, column 3 -> three: swapping the column index changes it too;
  * the band/bar tone and thickness carry `L`, so no two (L, x, y) triples collide.

Run:  .venv/Scripts/python.exe scripts/gen_probe_tiles.py
"""

import sys
from pathlib import Path
from PIL import Image, ImageDraw

TILE = 512
OUT = Path('public/tiles/probe')

# Grey used for the row-count bands in the WHITE half (light, but clearly not white).
BAND_GREY = 175
# Grey used for the column-count bars in the BLACK half (dark, but clearly not black).
BAR_GREY = 68


def probe_tile(L, x, y):
    """One 512x512 tile whose picture encodes its own (L, x, y)."""
    im = Image.new('RGB', (TILE, TILE))
    px = im.load()
    mid = TILE // 2
    for yy in range(TILE):
        if mid - 3 <= yy <= mid:
            colour = (220, 30, 30)
        elif yy < mid:
            colour = (0, 0, 0)
        else:
            colour = (255, 255, 255)
        for xx in range(TILE):
            px[xx, yy] = colour

    draw = ImageDraw.Draw(im)

    # Level-dependent styling: keeps every (L, x, y) triple byte-distinct while staying
    # inside the "light-grey band" / "dark bar" description.
    band_h = 14 + 6 * L
    bar_w = 26 + 6 * L
    tone_shift = 18 * L
    band_tone = BAND_GREY + tone_shift
    bar_tone = BAR_GREY + tone_shift

    # x vertical dark bars across the northern (black) half. x == 0 -> none.
    top, bottom = 0, mid - 4
    for i in range(x):
        centre = int((i + 0.5) * TILE / max(x, 1))
        draw.rectangle(
            [centre - bar_w // 2, top, centre + bar_w // 2, bottom],
            fill=(bar_tone, bar_tone, bar_tone),
        )

    # y + 1 horizontal light-grey bands in the southern (white) half. They are packed
    # into the half's UPPER part (the side facing the tile's own equator) on purpose:
    # in a whole-globe view the pole-facing part of a tile is crushed to a few pixels
    # by the projection, so bands spread over the whole half are unresolvable for the
    # southernmost row. Packed near the equator side, every band is legible.
    n = y + 1
    band_top, band_bottom = mid + 6, mid + 1 + int(0.45 * (TILE - mid))
    span = band_bottom - band_top
    for i in range(n):
        centre = int(band_top + (i + 0.5) * span / n)
        draw.rectangle(
            [0, centre - band_h // 2, TILE, centre + band_h // 2],
            fill=(band_tone, band_tone, band_tone),
        )

    # No border or edge decoration: grey exists only as southern-half row bands and
    # dark grey only as northern-half column bars, so a band count is never ambiguous.
    return im


def main():
    written = 0
    for L in (0, 1):
        for x in range(2 ** (L + 1)):
            for y in range(2 ** L):
                d = OUT / str(L) / str(x)
                d.mkdir(parents=True, exist_ok=True)
                probe_tile(L, x, y).save(d / f'{y}.jpg', quality=95, optimize=True)
                written += 1
    print(f'wrote {written} probe tiles to {OUT}')
    return 0 if written == 10 else 1


if __name__ == '__main__':
    sys.exit(main())
