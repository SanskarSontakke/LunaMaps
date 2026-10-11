import type { ViewBox, ViewRegion } from '@/lib/viewRegions';
import { viewRegionBounds } from '@/lib/viewRegions';

/**
 * What to draw for one browsable area, decided as plain numbers before any Cesium
 * object exists — `src/test/areaOutline.test.ts` runs this in node.
 *
 * The reason it is not just "draw the rectangle" is that a `views` box is a
 * *set of coordinates*, and two of the shapes in that file are not boxes in the
 * sense a reader means:
 *
 * - `south-polar-cap` is `[-180, -90, 180, -60]`. Outlined as a rectangle that is
 *   four edges, two of which are the same meridian at the seam (one visible line
 *   down the map, at a longitude with no meaning there) and one of which is the
 *   parallel at -90°, a single point. The boundary a user means is the circle at
 *   60° S and nothing else.
 * - `near-side` is `[-90, -90, 90, 90]`. Its meridians at ±90° really are
 *   boundaries and really do meet at the poles, so they are drawn; its two
 *   latitude edges are the poles themselves, so they are not.
 *
 * So the rule keys on the one property that distinguishes them: a box spanning
 * the whole longitude range has no meridian edges.
 */
export interface OutlineEdge {
  /** A constant latitude running `from`..`to` in longitude, or a constant
   *  longitude running `from`..`to` in latitude. */
  kind: 'parallel' | 'meridian';
  at: number;
  from: number;
  to: number;
}

export interface OutlinePlan {
  /** Boxes to tint. Every box in the view, always, including a band's. */
  fill: ViewBox[];
  /**
   * Every line to stroke. One representation because one mechanism draws them:
   * `RectangleGraphics.outline` measured zero painted pixels in both modes — it
   * sits at altitude 0 on the same surface as the imagery, so there is nothing to
   * see it against — while a ground-clamped polyline of the same colour measured
   * ~2,600. A band's parallel is the same record with `from: -180, to: 180`.
   */
  edges: OutlineEdge[];
}

/** The longitude range is the whole globe, so the west/east edges are one meridian at the seam. */
export const spansAllLongitudes = (box: ViewBox): boolean =>
  box[0] === -180 && box[2] === 180;

/** The edge is a pole: a point, not a line. */
const isPole = (lat: number): boolean => lat === 90 || lat === -90;

export function outlinePlanFor(view: ViewRegion): OutlinePlan {
  const fill: ViewBox[] = [];
  const edges: OutlineEdge[] = [];
  for (const box of view.boxes) {
    fill.push(box);
    const [west, south, east, north] = box;
    if (spansAllLongitudes(box)) {
      if (!isPole(south)) edges.push({ kind: 'parallel', at: south, from: -180, to: 180 });
      if (!isPole(north)) edges.push({ kind: 'parallel', at: north, from: -180, to: 180 });
      continue;
    }
    edges.push({ kind: 'meridian', at: west, from: south, to: north });
    edges.push({ kind: 'meridian', at: east, from: south, to: north });
    if (!isPole(south)) edges.push({ kind: 'parallel', at: south, from: west, to: east });
    if (!isPole(north)) edges.push({ kind: 'parallel', at: north, from: west, to: east });
  }
  return { fill, edges };
}

/**
 * The rectangle to frame a view with, in the `[west, south, east, north]` degree
 * form `Cesium.Rectangle.fromDegrees` takes directly.
 *
 * `viewRegionBounds` is the whole story here, and the reason to call it rather
 * than min/max the boxes is its `west > east` result: the far side's two boxes
 * bound a covering rectangle of `{west: 90, east: -90}`, which is the Cesium
 * convention for a rectangle crossing the antimeridian and the only single
 * rectangle that IS the far side. Taking `min(west)..max(east)` instead gives
 * -180..180, which frames the whole Moon and is not what was selected.
 */
export function areaRectangle(view: ViewRegion): [number, number, number, number] | null {
  const bounds = viewRegionBounds(view.boxes);
  return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north] : null;
}
