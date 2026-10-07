import * as Cesium from 'cesium';
import { MOON_ELLIPSOID } from './moon';
import { alongParallelMeters, mPerPxFromPixels } from '@/lib/scale';

/**
 * Longitude step of the probe pair, in degrees. 0.01 deg is ~303 m of ground on
 * the moon: small enough that chord-vs-arc and the second-order perspective
 * error stay far below the readout's rounding to whole m/px, large enough that
 * the measured pixel delta is well above projection noise at the coarsest view.
 */
export const PROBE_D_LON_DEG = 0.01;

export type ScreenPoint = { x: number; y: number } | null | undefined;
export type Project = (
  scene: Cesium.Scene,
  world: Cesium.Cartesian3,
) => ScreenPoint;

/** The public Cesium 1.146 entry point; `undefined` when the point is off-screen. */
const projectThroughCamera: Project = (_scene, world) => {
  const p = Cesium.SceneTransforms.worldToWindowCoordinates(_scene, world);
  return p ? { x: p.x, y: p.y } : undefined;
};

/**
 * Metres per screen pixel, *measured* through the live camera: project the
 * surface point under the camera and a point a hair east of it, take the pixel
 * distance, and divide the along-parallel ground distance by it.
 *
 * This is the only way to be right in both modes without analytic guesswork.
 * In `SCENE3D` (globe) the cos(latitude) factor cancels between ground and
 * image, and the answer tracks camera height; in `SCENE2D` (paper) the pixel
 * grid is equirectangular — pixels per degree of longitude do *not* shrink with
 * latitude — so the cos factor survives into the reading, which is the honest
 * value at that latitude. Both fall out of the projection; neither is assumed.
 *
 * Returns null when either point does not project (off-screen, or behind the
 * view plane on an oblique globe) or when both land on the same pixel. The
 * readout then prints `UNAVAILABLE` from `src/lib/scale.ts` instead of a number.
 *
 * `project` is injectable so the null paths and the equirectangular case can be
 * asserted without a WebGL scene; production callers never pass it.
 */
export function measureMPerPx(
  viewer: Cesium.Viewer,
  project: Project = projectThroughCamera,
): number | null {
  const c = viewer.camera.positionCartographic;
  const toDeg = 180 / Math.PI;
  const lat = c.latitude * toDeg;
  const lon = c.longitude * toDeg;
  const scene = viewer.scene;
  const a = project(
    scene,
    Cesium.Cartesian3.fromDegrees(lon, lat, 0, MOON_ELLIPSOID),
  );
  const b = project(
    scene,
    Cesium.Cartesian3.fromDegrees(lon + PROBE_D_LON_DEG, lat, 0, MOON_ELLIPSOID),
  );
  if (!a || !b) return null;
  return mPerPxFromPixels(
    alongParallelMeters(lat, PROBE_D_LON_DEG),
    Math.hypot(b.x - a.x, b.y - a.y),
  );
}
