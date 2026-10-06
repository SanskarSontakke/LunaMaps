import sys
from pathlib import Path
from PIL import Image

TILE = 512
OUT = Path('public/tiles/probe')


def half_split_tile():
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
    return im


def main():
    written = 0
    for L in (0, 1):
        for x in range(2 ** (L + 1)):
            for y in range(2 ** L):
                d = OUT / str(L) / str(x)
                d.mkdir(parents=True, exist_ok=True)
                half_split_tile().save(d / f'{y}.jpg', quality=95, optimize=True)
                written += 1
    print(f'wrote {written} probe tiles to {OUT}')
    return 0 if written == 10 else 1


if __name__ == '__main__':
    sys.exit(main())
