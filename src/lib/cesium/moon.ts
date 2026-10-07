import * as Cesium from 'cesium';
import type { LayerName, Mode } from '@/types';

export type { LayerName, Mode };

export const MOON_RADIUS_M = 1_737_400;
export const TILE_SIZE = 512;

// Camera height limits in metres. These live here because this is the file that
// actually configures the screen-space controller; morph.ts imports (and
// re-exports) them so the height clamp and the controller can never disagree.
export const MIN_H = 1_500;
export const MAX_H = 3.5e7;

export const MOON_ELLIPSOID = new Cesium.Ellipsoid(
  MOON_RADIUS_M,
  MOON_RADIUS_M,
  MOON_RADIUS_M,
);

export const CREDIT = new Cesium.Credit(
  'NASA/GSFC/Arizona State University (LROC WAC mosaic) · NASA’s Scientific ' +
    'Visualization Studio (CGI Moon Kit) · USGS Astrogeology Science Center · ' +
    'IAU Gazetteer of Planetary Nomenclature',
);

export function makeProvider(layer: LayerName, top: number) {
  return new Cesium.UrlTemplateImageryProvider({
    url: `/tiles/${layer}/{z}/{x}/{y}.jpg`,
    tilingScheme: new Cesium.GeographicTilingScheme({ ellipsoid: MOON_ELLIPSOID }),
    tileWidth: TILE_SIZE,
    tileHeight: TILE_SIZE,
    minimumLevel: 0,
    maximumLevel: top,
    rectangle: Cesium.Rectangle.MAX_VALUE,
    credit: CREDIT,
  });
}

export interface MoonViewerOptions {
  layer: LayerName;
  top: number;
  // Mode lives in types.ts so the viewer options and the UI controls cannot
  // drift apart (deferred finding from the Task 2 review).
  mode: Mode;
}

export function createMoonViewer(container: HTMLElement, opts: MoonViewerOptions) {
  const viewer = new Cesium.Viewer(container, {
    sceneMode:
      opts.mode === 'globe' ? Cesium.SceneMode.SCENE3D : Cesium.SceneMode.SCENE2D,
    ellipsoid: MOON_ELLIPSOID,
    // baseLayer must be passed explicitly: if it is omitted Cesium resolves a
    // default imagery provider through Cesium ion, which this app never uses.
    baseLayer: new Cesium.ImageryLayer(makeProvider(opts.layer, opts.top)),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
  });

  const scene = viewer.scene;
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0d12');
  scene.globe.enableLighting = false;
  // Cesium 1.146 only creates skyAtmosphere / sun / moon for the default (WGS84)
  // ellipsoid. With MOON_ELLIPSOID they are undefined, i.e. already off, so these
  // guards are required: unguarded `scene.skyAtmosphere.show` throws a TypeError.
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  scene.fog.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.backgroundColor = Cesium.Color.fromCssColorString('#05060a');

  const ctl = scene.screenSpaceCameraController;
  ctl.minimumZoomDistance = MIN_H;
  ctl.maximumZoomDistance = MAX_H;
  ctl.enableTilt = opts.mode === 'globe';

  return viewer;
}
