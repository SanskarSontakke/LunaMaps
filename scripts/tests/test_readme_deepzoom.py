"""The README's deep-zoom table is a claim about artifacts, so an artifact checks it.

`## Deep zoom: what L8-L10 actually covers` publishes twelve boxes, twelve ground
sizes, twelve tile counts, per-level totals, a byte total and a m/px table. Every one
of those numbers is re-derived here from the tile tree and the grid contract, so a
doc edit that drifts from the delivery fails the suite instead of shipping a confident
wrong figure. Two of those numbers are already load-bearing in the prose: the column
sums to 7,132 while the store holds 7,106, and the difference is the declared overlap.

Nothing here writes to `public/tiles/**`, and nothing here reaches the network. The
tree is gitignored with only the manifest force-added, so the two tests that read it
skip on a fresh clone; the four that only need tracked files always run.
"""
from __future__ import annotations

import json
import math
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import grid    # noqa: E402
import regions  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
README = REPO / 'README.md'
SHIPPED_PLAN = REPO / 'public' / 'data' / 'regions.json'
ORTHO_TREE = REPO / 'public' / 'tiles' / 'ortho'
HEADING = '## Deep zoom: what L8-L10 actually covers'
ARC_M_PER_DEG = 30323.35
LEVELS = (8, 9, 10)


def num(text: str) -> float:
    """README figures use a real minus sign (U+2212) and thin thousands separators."""
    return float(text.replace('\u2212', '-').replace(',', ''))


def section_text() -> str:
    parts = README.read_text(encoding='utf-8').split(HEADING)
    assert len(parts) == 2, f'{HEADING!r} appears {len(parts) - 1} times in README.md'
    return parts[1].split('\n## ')[0]


def table_rows() -> list[dict]:
    """The twelve `| \\`id\\` | box | km | tiles |` rows, or a loud failure."""
    rows = []
    for line in section_text().splitlines():
        m = re.match(r'^\|\s*`([a-z0-9-]+)`\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*([\d,]+)\s*\|$', line)
        if not m:
            continue
        box = [num(v) for v in re.findall(r'−?\d+\.\d+', m.group(2))]
        km = [num(v) for v in re.findall(r'\d+(?:\.\d+)?(?=\s*(?:×|km))', m.group(3))]
        assert len(box) == 4 and len(km) == 2, f'{m.group(1)}: unreadable row {line!r}'
        rows.append({'id': m.group(1), 'box': box, 'km': km, 'tiles': int(num(m.group(4)))})
    assert len(rows) == 12, f'expected 12 deep-zoom rows, parsed {len(rows)}'
    return rows


def bold_totals() -> dict:
    m = re.search(
        r'\*\*(\d[\d,]*) tiles total — (\d[\d,]*) at L8, (\d[\d,]*) at L9, (\d[\d,]*) at L10 — (\d[\d,]*) B\.\*\*',
        section_text())
    assert m, 'the bold totals sentence is gone from the deep-zoom section'
    return {'total': int(num(m.group(1))), 'L8': int(num(m.group(2))),
            'L9': int(num(m.group(3))), 'L10': int(num(m.group(4))),
            'bytes': int(num(m.group(5)))}


def tiles_on_disk() -> list[tuple[int, int, int, int]]:
    """(level, x, y, bytes) for every delivered ortho JPEG, from the paths alone."""
    out = []
    for level in LEVELS:
        base = ORTHO_TREE / str(level)
        if not base.is_dir():
            continue
        for xdir in sorted(base.iterdir()):
            if not xdir.is_dir():
                raise AssertionError(f'layout is <level>/<x>/<y>.jpg, found {xdir}')
            for jpg in xdir.iterdir():
                if jpg.suffix == '.jpg':
                    out.append((level, int(xdir.name), int(jpg.stem), jpg.stat().st_size))
    return out


def overlapping(box, disk):
    """Tiles whose rectangle overlaps `box`, computed here rather than by the code
    that wrote the tree. A center-inside test would undercount: a 0.5 deg box sits
    entirely inside one L8 tile (0.703 deg wide) whose center is outside it."""
    west, south, east, north = box
    hits = set()
    for level, x, y, _ in disk:
        twest, tsouth, teast, tnorth = grid.tile_bounds(level, x, y)
        lat_hit = tnorth > south and tsouth < north
        if west <= east:
            lon_hit = teast > west and twest < east
        else:                       # the box crosses the antimeridian
            lon_hit = teast > west or twest < east
        if lat_hit and lon_hit:
            hits.add((level, x, y))
    return hits


def ground_km(box):
    west, south, east, north = box
    mid = math.radians((south + north) / 2.0)
    return [(east - west) * ARC_M_PER_DEG * abs(math.cos(mid)) / 1000.0,
            (north - south) * ARC_M_PER_DEG / 1000.0]


def compare(rows, disk, totals, plan):
    """Every published figure against the artifacts. Returns problem strings, empty
    when the README and the tree agree -- kept pure so the control below can mutate
    an input and prove the comparison is capable of reporting it."""
    problems = []
    by_id = {r['id']: r for r in plan['regions']}
    for row in rows:
        region = by_id.get(row['id'])
        if region is None:
            problems.append(f'{row["id"]}: in the README, not in regions.json')
            continue
        box = regions.box_of(region)
        if [round(v, 3) for v in box] != [round(v, 3) for v in row['box']]:
            problems.append(f'{row["id"]}: box {row["box"]} != published {box}')
        if disk and len(overlapping(box, disk)) != row['tiles']:
            problems.append(f'{row["id"]}: {row["tiles"]} tiles claimed, '
                            f'{len(overlapping(box, disk))} on disk')
        if plan['cost']['perRegion'].get(row['id']) != row['tiles']:
            problems.append(f'{row["id"]}: {row["tiles"]} != cost.perRegion '
                            f'{plan["cost"]["perRegion"].get(row["id"])}')
        got = ground_km(row['box'])
        if any(abs(g - w) > 0.6 for g, w in zip(got, row['km'])):
            problems.append(f'{row["id"]}: ground {got} != README {row["km"]}')
    if disk:
        for level in LEVELS:
            want = totals[f'L{level}']
            got = sum(1 for t in disk if t[0] == level)
            if got != want:
                problems.append(f'L{level}: {got} tiles on disk, README says {want}')
        if len(disk) != totals['total']:
            problems.append(f'total: {len(disk)} tiles on disk, README says {totals["total"]}')
        size = sum(t[3] for t in disk)
        if size != totals['bytes']:
            problems.append(f'bytes: {size} on disk, README says {totals["bytes"]}')
    return problems


@pytest.fixture(scope='module')
def plan():
    return json.loads(SHIPPED_PLAN.read_text(encoding='utf-8'))


# --- assertions that need no tiles ------------------------------------------

def test_the_table_names_every_shipped_bake_region(plan):
    """Two lists, one membership: the README cannot quietly drop a box or invent one."""
    ids = {r['id'] for r in table_rows()}
    assert ids == {r['id'] for r in plan['regions']}


def test_each_row_prints_the_box_the_app_publishes(plan):
    by_id = {r['id']: r for r in plan['regions']}
    for row in table_rows():
        assert [round(v, 3) for v in regions.box_of(by_id[row['id']])] == \
               [round(v, 3) for v in row['box']], row['id']


def test_ground_sizes_use_the_cosine_and_could_not_have_passed_without_it():
    """The control matters more than the pass: `Δlon * arc` without `cos(lat)` is the
    mistake this section documents, so at least one row must fail the naive formula
    by more than the tolerance the real comparison allows."""
    for row in table_rows():
        got = ground_km(row['box'])
        assert all(abs(g - w) <= 0.6 for g, w in zip(got, row['km'])), (row['id'], got, row['km'])
    naive = [(abs((r['box'][2] - r['box'][0]) * ARC_M_PER_DEG / 1000.0 - r['km'][0]) > 0.6)
             for r in table_rows()]
    assert sum(naive) >= 5, f'the cosine test is vacuous: only {sum(naive)} rows discriminate'


def test_the_m_per_px_the_prose_quotes_is_the_grid_contract_says():
    """`41.64 m/px at L8, 20.82 at L9, 10.41 at L10` -- the unit is written once and
    elided after it, so the level is the anchor and each number is re-derived."""
    quoted = dict((int(m.group(2)), float(m.group(1))) for m in
                  re.finditer(r'([\d.]+)(?:\s*m/px)?\s+at\s+L(\d+)\b', section_text()))
    assert set(quoted) == set(LEVELS), f'prose quotes m/px for {sorted(quoted)}'
    for level, value in quoted.items():
        assert round(grid.m_per_px(level), 2) == value, f'L{level}'


def test_the_column_sum_is_the_plan_and_the_union_is_the_difference(plan):
    """The table column is per region and therefore double-counts the box that sits
    inside another. The README says so; here that sentence is pinned to the numbers."""
    rows = table_rows()
    cost = plan['cost']
    assert sum(r['tiles'] for r in rows) == sum(cost['perRegion'].values())
    assert cost['tiles'] + cost['overlap'] == sum(cost['perRegion'].values())
    assert re.search(r'sums to 7,132', section_text()), 'the reconciliation is not in the prose'
    assert str(cost['overlap']) in section_text(), 'the overlap figure is not in the prose'


# --- assertions that read the delivered tree ---------------------------------

@pytest.mark.skipif(not ORTHO_TREE.exists(),
                    reason='the ortho tree is gitignored; run stream_bake.py to '
                           'produce it and this test re-derives every README figure from it')
def test_every_published_figure_matches_the_delivered_tree(plan):
    assert compare(table_rows(), tiles_on_disk(), bold_totals(), plan) == []


def _mutate_tiles(rows, **_):
    next(r for r in rows if r['id'] == 'tycho')['tiles'] += 1
    return 'tycho'


def _mutate_km(rows, **_):
    next(r for r in rows if r['id'] == 'copernicus')['km'][0] += 5.0
    return 'copernicus'


def _mutate_box(rows, **_):
    next(r for r in rows if r['id'] == 'tycho')['box'][1] -= 0.25
    return 'tycho'


def _mutate_bytes(rows, *, totals, **_):
    totals['bytes'] += 1
    return 'bytes'


def _mutate_level(rows, *, totals, **_):
    totals['L9'] += 3
    return 'L9'


@pytest.mark.skipif(not ORTHO_TREE.exists(),
                    reason='needs the delivered ortho tree to have anything to corrupt')
@pytest.mark.parametrize('mutate', [
    _mutate_tiles, _mutate_km, _mutate_box, _mutate_bytes, _mutate_level])
def test_the_comparison_can_fail(plan, mutate):
    """A guard that cannot fail guards nothing. Each mutation breaks one published
    figure; the comparison must report it and nothing else."""
    rows, totals = table_rows(), bold_totals()
    who = mutate(rows, totals=totals)
    problems = compare(rows, tiles_on_disk(), totals, plan)
    assert problems, f'{mutate.__name__} changed a README figure and the audit did not notice'
    assert all(who in p for p in problems), problems
