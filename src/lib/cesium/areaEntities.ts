import * as Cesium from 'cesium';
import type { ViewRegion } from '@/lib/viewRegions';
import { outlinePlanFor } from '@/lib/cesium/areaOutline';
import type { OutlineEdge } from '@/lib/cesium/areaOutline';

/**
 * D11: the selected area, drawn.
 *
 * Everything that decides *what shape* lives in `areaOutline.ts` and is tested in
 * node; this file only turns that plan into entities. The split is the point: the
 * seam and the pole are geometry questions with numeric answers, and a Cesium
 * object would have made them untestable without a WebGL scene.
 *
 * A dedicated `CustomDataSource`, not the label one: the labels are refreshed at
 * up to 8 Hz by the declutter and `removeAll()` there would take the map's names
 * with the area's outline. Clearing is therefore `entities.remove` on this source
 * alone, and the source is created once and destroyed with the viewer.
 *
 * The colour is deliberately not the amber of `#ffd45e`: that is the focus ring,
 * and landing sites are already amber discs (`labels/entities.ts`), so a third
 * amber thing on the map would be a highlight that competes with the two things
 * it is meant to be drawn around.
 */
export const AREA_LINE_COLOR = 'rgba(64, 156, 255, 0.92)';
export const AREA_FILL_COLOR = 'rgba(64, 156, 255, 0.16)';
/** Degrees between samples of a latitude circle. 180 points, at any zoom. */
const PARALLEL_STEP_DEG = 2;

export function createAreaSource(viewer: Cesium.Viewer): Cesium.CustomDataSource {
  const ds = new Cesium.CustomDataSource('areas');
  viewer.dataSources.add(ds);
  return ds;
}

/** One stroked edge, sampled every `PARALLEL_STEP_DEG` along its running axis. */
function addEdge(ds: Cesium.CustomDataSource, edge: OutlineEdge): void {
  const coords: number[] = [];
  const steps = Math.max(
    1,
    Math.ceil(Math.abs(edge.to - edge.from) / PARALLEL_STEP_DEG),
  );
  for (let i = 0; i <= steps; i += 1) {
    const along = edge.from + ((edge.to - edge.from) * i) / steps;
    // A parallel holds its latitude and runs in longitude; a meridian the reverse.
    coords.push(...(edge.kind === 'parallel' ? [along, edge.at] : [edge.at, along]));
  }
  ds.entities.add(
    new Cesium.Entity({
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray(coords),
        width: 2,
        material: Cesium.Color.fromCssColorString(AREA_LINE_COLOR),
        // Clamped to the ground: the boundary of an area on the surface, not a
        // chord through the sphere. Measured to paint in both SCENE2D and SCENE3D.
        clampToGround: true,
      },
    }),
  );
}

/** Draw `view` into `ds`, replacing whatever was there. Returns the entity count. */
export function drawArea(ds: Cesium.CustomDataSource, view: ViewRegion | null): number {
  ds.entities.removeAll();
  if (!view) return 0;
  const plan = outlinePlanFor(view);
  for (const box of plan.fill) {
    ds.entities.add(
      new Cesium.Entity({
        rectangle: {
          // `coordinates`, not `rectangle`: this is the field's name in the pinned
          // 1.146 typings, and the older spelling most examples use does not
          // typecheck here.
          coordinates: Cesium.Rectangle.fromDegrees(...box),
          material: Cesium.Color.fromCssColorString(AREA_FILL_COLOR),
          // 1 km up. At altitude 0 the plane is coplanar with the imagery it is
          // meant to tint, and measured exactly as the outline did: zero painted
          // pixels. One kilometre is nothing against a 1,737 km radius and enough
          // to be in front of the surface.
          height: 1000,
          // Fill only. The boundary is `plan.edges`, drawn as clamped polylines —
          // see `OutlinePlan.edges` for why the rectangle's own outline is not it.
        },
      }),
    );
  }
  for (const edge of plan.edges) addEdge(ds, edge);
  return ds.entities.values.length;
}

export function flyToArea(
  viewer: Cesium.Viewer,
  rectangle: [number, number, number, number],
): void {
  const [west, south, east, north] = rectangle;
  viewer.camera.flyTo({
    // A Rectangle destination lets Cesium choose the height, which is the whole
    // reason to hand it the rectangle: `west > east` is Cesium's own form for a
    // rectangle crossing the antimeridian, so the far side frames as one honest
    // 180°-wide area instead of the entire globe.
    destination: Cesium.Rectangle.fromDegrees(west, south, east, north),
    duration: 1.4,
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });
}
