import { describe, expect, it } from 'vitest';
import { declutter, overlaps, type Box, type LabelBox } from '@/lib/labels/declutter';

const box = (x: number, y: number, w = 60, h = 16): Box => ({ x, y, w, h });
const item = (id: string, priority: number, x: number, y = 100): LabelBox => ({
  id,
  priority,
  box: box(x, y),
});

describe('overlaps', () => {
  it('detects an intersection', () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(true);
  });
  it('treats touching edges as non-overlapping', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false);
  });
  it('detects containment', () => {
    expect(overlaps(box(0, 0, 100, 100), box(40, 40, 10, 10))).toBe(true);
  });
});

describe('declutter', () => {
  it('keeps the higher priority of two colliding labels', () => {
    expect(declutter([item('a', 5, 100), item('b', 9, 104)])).toEqual(['b']);
  });
  it('keeps everything when nothing collides', () => {
    const kept = declutter([item('a', 5, 0), item('b', 5, 400), item('c', 5, 800)]);
    expect(kept.sort()).toEqual(['a', 'b', 'c']);
  });
  it('is independent of input order', () => {
    const items = [item('a', 5, 100), item('b', 9, 104), item('c', 1, 108)];
    expect(declutter(items)).toEqual(declutter([...items].reverse()));
    expect(declutter(items)).toEqual(['b']);
  });
  it('resolves a chain so only the top-ranked survivor remains', () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`l${n}`, n, n * 6));
    expect(declutter(items)).toEqual(['l5']);
  });
  it('handles empty input', () => {
    expect(declutter([])).toEqual([]);
  });
  it('spans many cells for a wide label', () => {
    const wide = [{ id: 'w', priority: 1, box: box(0, 0, 400, 16) }];
    expect(declutter(wide, 96)).toEqual(['w']);
  });
});
