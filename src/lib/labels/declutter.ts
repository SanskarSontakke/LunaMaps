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
 * The occupied space, as a cell grid, so the clash test stays near-linear for
 * hundreds of labels.
 *
 * One instance is the whole point: `declutterWithMarkers` places the names first
 * and then asks the markers to fit into what is LEFT, which is the only way a
 * 4 px dot can be made to lose a fight with a name without the name having to
 * know the dot exists.
 */
export interface Occupancy {
  /** Claim `box`, or refuse it and claim nothing. True means it was placed. */
  place(box: Box): boolean;
  /** Is `box` clear of everything claimed so far? */
  clashes(box: Box): boolean;
}

export function createOccupancy(cellPx = 96): Occupancy {
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
  const clashes = (b: Box): boolean =>
    span(b).some((k) => (cells.get(k) ?? []).some((other) => overlaps(other, b)));
  return {
    clashes,
    place(b: Box): boolean {
      if (clashes(b)) return false;
      for (const k of span(b)) {
        const list = cells.get(k);
        if (list) list.push(b);
        else cells.set(k, [b]);
      }
      return true;
    },
  };
}

/** Highest priority first; ties break on id, so the order never depends on input. */
const byPriority = (a: LabelBox, b: LabelBox): number =>
  b.priority - a.priority || a.id.localeCompare(b.id);

/**
 * Greedy screen-space label culling. Cesium has no built-in collision
 * avoidance, and this pass is what makes the names read as subtle instead of
 * messy. Pure, so it is testable without a GPU.
 *
 * Highest priority wins; ties break on id, so the result is independent of
 * input order. Occupied cells are looked up through a cell grid (`cellPx`) so
 * the clash test stays near-linear for hundreds of labels.
 */
export function declutter(items: LabelBox[], cellPx = 96): string[] {
  const occupancy = createOccupancy(cellPx);
  const kept: string[] = [];
  for (const item of [...items].sort(byPriority)) {
    if (occupancy.place(item.box)) kept.push(item.id);
  }
  return kept;
}

export interface Decluttered {
  /** The ids of the names that won their space. */
  kept: string[];
  /**
   * The ids of the markers that still fit — a SUBSET of the input, because a
   * marker that would land on a kept name is dropped rather than moving the
   * name. See `declutterWithMarkers`.
   */
  keptMarkers: string[];
}

/**
 * The two-population pass the globe actually needs: names first, then the
 * traverse markers into whatever the names left.
 *
 * WHY IT EXISTS. `work/ortho-shots/aristarchus-base.png` (8 km over
 * 0.674°N 23.483°E) shows the Apollo 11 name `Double` with another site's marker
 * painted through its glyphs. The gazetteer puts `Double`, `Little West` and
 * `West` within 320 m of each other, so at ~10 m/px all three names collide and
 * the old single-population pass correctly kept two and dropped `Little West` —
 * and then `entities.ts` showed that dropped name's *marker* anyway, because
 * markers were never in the contest. The declutter could not fix it: a box that
 * is not an input cannot lose.
 *
 * The order is the whole decision. Names beat markers unconditionally, because a
 * name carries information a dot does not, and the dot's own feature is already
 * named by a dot-sized mark on a map of 1,585 names. Markers then declutter
 * against each other on their own priority, so a pile of traverse sites thins to
 * the biggest rather than smearing.
 */
export function declutterWithMarkers(
  labels: LabelBox[],
  markers: LabelBox[],
  cellPx = 96,
): Decluttered {
  const occupancy = createOccupancy(cellPx);
  const kept: string[] = [];
  for (const item of [...labels].sort(byPriority)) {
    if (occupancy.place(item.box)) kept.push(item.id);
  }
  const keptMarkers: string[] = [];
  for (const item of [...markers].sort(byPriority)) {
    if (occupancy.place(item.box)) keptMarkers.push(item.id);
  }
  return { kept, keptMarkers };
}
