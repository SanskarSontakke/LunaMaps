'use client';
import { useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { createMoonViewer, MOON_ELLIPSOID } from '@/lib/cesium/moon';
import { getCameraState, setLayer, setMode, type CameraState } from '@/lib/cesium/morph';
import { attachPicking } from '@/lib/cesium/picking';
import { attachLabels, type LabelSet } from '@/lib/labels/entities';
import { layerTop, useManifest } from '@/lib/assets';
import { cameraHeightForLevel } from '@/lib/grid';
import {
  DEFAULT_LAYER,
  DEFAULT_MODE,
  type Feature,
  type FeatureCollection,
  type LayerName,
  type Manifest,
  type Mode,
} from '@/types';
import ModeToggle from './ModeToggle';
import LayerChips from './LayerChips';

declare global {
  // Exposed for the browser verification harness only.
  var __moonViewer: Cesium.Viewer | undefined;
  var __moonHarness: MoonHarness | undefined;
  var CESIUM_BASE_URL: string | undefined;
}

export interface MoonHarness {
  camera(): CameraState | null;
  sceneMode(): string;
  setMode(mode: Mode): Promise<void>;
  setLayer(layer: LayerName): void;
  setCamera(
    lonDeg: number,
    latDeg: number,
    heightM: number,
    pitchRad?: number,
    headingRad?: number,
  ): void;
  imageryCount(): number;
  labelCount(): number;
  shownEntities(): number;
  refreshLabels(heightM?: number): void;
  picked(): Feature | null;
}

// Cesium.SceneMode enum values as names (MORPHING=0 … SCENE3D=3), for readable
// harness output.
const MODE_NAMES = ['MORPHING', 'COLUMBUS_VIEW', 'SCENE2D', 'SCENE3D'];

// Home view: Mare Tranquillitatis at L5 ground resolution (the Task 10
// screenshot target). Height derived from the grid, never hard-coded.
const HOME = { lonDeg: 23.4731, latDeg: 0.6746 };
const homeHeight = () => cameraHeightForLevel(5, 900, 60);

// The UI only ever selects paper/photo; probe is the Task 2 gate fixture.
const topOf = (manifest: Manifest, layer: LayerName) =>
  layer === 'probe' ? 1 : layerTop(manifest, layer);

export default function MoonMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const labelsRef = useRef<LabelSet | null>(null);
  const pickedRef = useRef<Feature | null>(null);
  const { manifest, error } = useManifest();
  const [features, setFeatures] = useState<FeatureCollection | null>(null);
  const [, setSelectedFeature] = useState<Feature | null>(null);
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  const [layer, setLayerState] = useState<LayerName>(DEFAULT_LAYER);
  // What the live viewer was built with and has since been driven to. The
  // mode/layer effects compare against this instead of a first-render ref:
  // a `didMount`-style flag is eaten by the renders that happen *before* the
  // manifest (and viewer) exist, which swallows the user's first toggle.
  const applied = useRef({ mode: DEFAULT_MODE, layer: DEFAULT_LAYER });

  // The viewer is created only after the manifest has loaded and validated,
  // so `top` is real and a broken build fails in the panel below, not in a
  // half-rendered Cesium scene.
  useEffect(() => {
    globalThis.CESIUM_BASE_URL = '/cesium';
    const host = hostRef.current;
    if (!host || !manifest || viewerRef.current) return;
    const viewer = createMoonViewer(host, {
      layer,
      top: topOf(manifest, layer),
      mode,
    });
    applied.current = { mode, layer };
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        HOME.lonDeg,
        HOME.latDeg,
        homeHeight(),
        MOON_ELLIPSOID,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewerRef.current = viewer;
    globalThis.__moonViewer = viewer;
    globalThis.__moonHarness = {
      camera: () => (viewer.isDestroyed() ? null : getCameraState(viewer)),
      sceneMode: () => MODE_NAMES[viewer.scene.mode] ?? String(viewer.scene.mode),
      setMode: (m: Mode) => setMode(viewer, m),
      setLayer: (l: LayerName) => setLayer(viewer, l, topOf(manifest, l)),
      setCamera: (
        lonDeg: number,
        latDeg: number,
        heightM: number,
        pitchRad?: number,
        headingRad?: number,
      ) => {
        viewer.camera.setView({
          destination: Cesium.Cartesian3.fromDegrees(
            lonDeg,
            latDeg,
            heightM,
            MOON_ELLIPSOID,
          ),
          orientation: {
            heading: headingRad ?? 0,
            pitch: pitchRad ?? -Math.PI / 2,
            roll: 0,
          },
        });
        viewer.scene.requestRender();
      },
      imageryCount: () => viewer.imageryLayers.length,
      labelCount: () => labelsRef.current?.count ?? 0,
      shownEntities: () =>
        viewer.isDestroyed()
          ? -1
          : viewer.entities.values.filter((e) => e.show).length,
      refreshLabels: (heightM?: number) =>
        labelsRef.current?.refresh(heightM ?? getCameraState(viewer).height),
      picked: () => pickedRef.current,
    };
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      globalThis.__moonViewer = undefined;
      globalThis.__moonHarness = undefined;
    };
    // mode/layer are read from the render in which the manifest first arrives;
    // after that the two effects below own them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest]);

  // Apply user changes after the viewer exists; the first render of each
  // effect matches `applied` and is a no-op, so the viewer is never morphed
  // while it is being built.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (applied.current.mode === mode) return;
    applied.current.mode = mode;
    void setMode(viewer, mode);
  }, [mode]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !manifest) return;
    if (applied.current.layer === layer) return;
    applied.current.layer = layer;
    setLayer(viewer, layer, topOf(manifest, layer));
  }, [layer, manifest]);

  // Labels ride in their own file; the map works without them (design §6
  // failure modes): search and labels disable, the map stays usable.
  useEffect(() => {
    let alive = true;
    fetch('/data/features.json')
      .then((r) => {
        if (!r.ok) throw new Error(`features.json HTTP ${r.status}`);
        return r.json();
      })
      .then((fc: FeatureCollection) => {
        if (alive) setFeatures(fc);
      })
      .catch(() => {
        if (alive) setFeatures(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Attach place names once the viewer and features coexist; drive the
  // tier/declutter refresh from the camera at 8 Hz and pick on click.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !features || labelsRef.current) return;
    const labels = attachLabels(viewer, features);
    labelsRef.current = labels;
    labels.refresh(getCameraState(viewer).height);
    let last = 0;
    const onPostRender = () => {
      const t = Date.now();
      if (t - last < 125) return; // throttle to 8 Hz
      last = t;
      if (!viewer.isDestroyed()) labels.refresh(getCameraState(viewer).height);
    };
    viewer.scene.postRender.addEventListener(onPostRender);
    const detachPick = attachPicking(viewer, (f) => {
      pickedRef.current = f;
      setSelectedFeature(f);
    });
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        labels.destroy();
      }
      detachPick();
      labelsRef.current = null;
    };
  }, [features, manifest]);

  return (
    <>
      <div ref={hostRef} id="cesiumContainer" className="map-host" />
      {manifest && !error && (
        <div className="ui">
          <ModeToggle mode={mode} onChange={setModeState} />
          <LayerChips layer={layer} onChange={setLayerState} />
        </div>
      )}
      {error && (
        // Task 15 replaces this with the full NoAssets failure panel.
        <div className="ui">
          <div className="ctl ctl-error" role="alert">
            Map assets are unavailable: {error}
          </div>
        </div>
      )}
    </>
  );
}
