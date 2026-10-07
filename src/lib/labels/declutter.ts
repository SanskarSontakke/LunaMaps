export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelBox {
  id: string;
  priority: number;
  box: Box;
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Greedy screen-space label culling. Cesium has no built-in collision
 * avoidance, and this pass is what makes the names read as subtle instead of
 * messy. Pure, so it is testable without a GPU.
 *
 * Highest priority wins; ties break on id, so the result is independent of
 * input order. Occupied cells are looked up through a cell grid (cellPx) so
 * the clash test stays near-linear for hundreds of labels.
 */
export function declutter(items: LabelBox[], cellPx = 96): string[] {
  const order = [...items].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const cells = new Map<string, Box[]>();
  const span = (b: Box): string[] => {
    const out: string[] = [];
    for (let cx = Math.floor(b.x / cellPx); cx <= Math.floor((b.x + b.w) / cellPx); cx++) {
      for (let cy = Math.floor(b.y / cellPx); cy <= Math.floor((b.y + b.h) / cellPx); cy++) {
        out.push(`${cx},${cy}`);
      }
    }
    return out;
  };
  const kept: string[] = [];
  for (const item of order) {
    const clash = span(item.box).some((k) =>
      (cells.get(k) ?? []).some((b) => overlaps(b, item.box)),
    );
    if (clash) continue;
    kept.push(item.id);
    for (const k of span(item.box)) {
      const list = cells.get(k);
      if (list) list.push(item.box);
      else cells.set(k, [item.box]);
    }
  }
  return kept;
}
