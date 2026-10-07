'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { createMoonViewer, MOON_ELLIPSOID } from '@/lib/cesium/moon';
import {
  flyToFeature,
  getCameraState,
  setLayer,
  setMode,
  type CameraState,
} from '@/lib/cesium/morph';
import { attachPicking } from '@/lib/cesium/picking';
import { attachLabels, type LabelSet } from '@/lib/labels/entities';
import { layerTop, useManifest } from '@/lib/assets';
import { fuzzySearch } from '@/lib/search';
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
import SearchBox from './SearchBox';
import FeatureCard from './FeatureCard';

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
  /** Dev-sweep helpers for Task 12: search without a DOM, and card state. */
  search(query: string): string[];
  selectByName(name: string): boolean;
  selected(): Feature | null;
}

// Cesium.SceneMode enum values as names (MORPHING=0 … SCENE3D=3), for readable
// harness output.
const MODE_NAMES = ['MORPHING', 'COLUMBUS_VIEW', 'SCENE2D', 'SCENE3D'];

// Home view: Mare Tranquillitatis at L5 ground resolution (the Task 10
// screenshot target). Height derived from the grid, never hard-coded.
const HOME = { lonDeg: 23.4731, latDeg: 0.6746 };
const homeHeight = () => cameraHeightForLevel(5, 900, 60);

// Paper and photo levels come strictly from the validated manifest — there is
// no default or hardcoded fallback, so Cesium's maximumLevel always matches what
// was actually baked. `probe` is not a product layer: it is the single-level
// Task 2 gate fixture, pinned to top 1 here and nowhere else.
const topOf = (manifest: Manifest, layer: LayerName) =>
  layer === 'probe' ? 1 : layerTop(manifest, layer);

export default function MoonMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const labelsRef = useRef<LabelSet | null>(null);
  const pickedRef = useRef<Feature | null>(null);
  const { manifest, error } = useManifest();
  const [features, setFeatures] = useState<FeatureCollection | null>(null);
  // A ref mirror of the two pieces of late-arriving state the dev harness needs
  // (it is built once, when the viewer is created, long before `features`
  // exists and independently of every re-render).
  const featuresRef = useRef<FeatureCollection | null>(null);
  const selectedRef = useRef<Feature | null>(null);
  const [selected, setSelectedFeature] = useState<Feature | null>(null);
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  const [layer, setLayerState] = useState<LayerName>(DEFAULT_LAYER);
  // What the live viewer was built with and has since been *confirmed* at: the
  // layer effect dedupes on `applied.layer` (setLayer is synchronous), and the
  // mode effect advances `applied.mode` only after a morph resolves, so a failed
  // switch never leaves `applied` claiming a mode the scene is not showing. A
  // `didMount`-style flag is eaten by the renders that happen *before* the
  // manifest (and viewer) exist, which swallows the user's first toggle.
  const applied = useRef({ mode: DEFAULT_MODE, layer: DEFAULT_LAYER });
  // The last mode we *asked* the live viewer to morph to. The morph is async
  // and the queue serialises requests, so a fast Paper/Globe double-click must
  // enqueue both (the second one wins). Dedupe on this intent ref, not on
  // `applied` (which now advances only on success) — that would drop the second
  // click while the first is still morphing.
  const requested = useRef<Mode>(DEFAULT_MODE);
  const [modeError, setModeError] = useState<string | null>(null);

  // Card state for both entry points (search result and map click). Kept
  // separate from `pickedRef`, which stays strictly "what the last left-click
  // picked" so Task 11's harness metric does not drift.
  const selectFeature = useCallback((f: Feature | null) => {
    selectedRef.current = f;
    setSelectedFeature(f);
  }, []);
  // Search / pick → card + camera. `flyToFeature` needs a live viewer; with no
  // viewer yet (features can load before the manifest does) the card still
  // opens — the design §6 degraded path, not a silent no-op.
  const goToFeature = useCallback(
    (f: Feature) => {
      const viewer = viewerRef.current;
      if (viewer && !viewer.isDestroyed()) {
        flyToFeature(viewer, {
          coordinates: f.geometry.coordinates,
          diameterKm: f.properties.diameterKm,
        });
      }
      selectFeature(f);
    },
    [selectFeature],
  );

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
    requested.current = mode;
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        HOME.lonDeg,
        HOME.latDeg,
        homeHeight(),
        MOON_ELLIPSOID,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    // requestRenderMode viewer: the home setView changes nothing on screen
    // until a frame is asked for (the same pump setLayer/setMode do).
    viewer.scene.requestRender();
    viewerRef.current = viewer;
    // Verification hooks exist only in dev. Task 18's sweep runs `npm run dev`
    // (NODE_ENV=development) and drives these; exposing setMode/setLayer/
    // setCamera on globalThis in a production bundle would hand the live scene
    // graph to anything running in the page. The globals are typed `| undefined`
    // and the cleanup below resets them, so a prod build simply leaves them
    // undefined — no behaviour change to the map itself.
    if (process.env.NODE_ENV === 'development') {
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
        // Task 18 sweep helpers: drive search and the card without a DOM.
        search: (q: string) =>
          featuresRef.current
            ? fuzzySearch(q, featuresRef.current).map((f) => f.properties.name)
            : [],
        selectByName: (name: string) => {
          const hit = (featuresRef.current?.features ?? []).find(
            (f) => f.properties.name === name,
          );
          if (!hit) return false;
          goToFeature(hit);
          return true;
        },
        selected: () => selectedRef.current,
      };
    }
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
  // effect matches `applied`/`requested` and is a no-op, so the viewer is never
  // morphed while it is being built. A failed morph no longer silently advances
  // `applied` (the old bug): it stays at the last mode the scene actually
  // reached, so toggling back is a real retry, and the rejection is surfaced.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (applied.current.mode === mode || requested.current === mode) return;
    requested.current = mode;
    setMode(viewer, mode)
      .then(() => {
        applied.current.mode = mode;
        setModeError(null);
      })
      .catch((e: unknown) => {
        // The morph never landed (stalled frames) — do NOT advance `applied`.
        // Surfacing beats the old `void setMode(...)` swallow + console log.
        setModeError(
          e instanceof Error ? `View mode change failed: ${e.message}` : 'View mode change failed',
        );
      });
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
        if (!alive) return;
        featuresRef.current = fc;
        setFeatures(fc);
      })
      .catch(() => {
        if (alive) {
          featuresRef.current = null;
          setFeatures(null);
        }
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
      // A pick opens the card (Task 12 is picking's first consumer). Picking
      // the canvas beside a label yields null, which closes it.
      selectFeature(f);
    });
    return () => {
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        labels.destroy();
      }
      detachPick();
      labelsRef.current = null;
    };
    // selectFeature is a stable useCallback, so this never re-runs the attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, manifest, selectFeature]);

  return (
    <>
      <div ref={hostRef} id="cesiumContainer" className="map-host" />
      {manifest && !error && (
        <div className="ui">
          <ModeToggle mode={mode} onChange={setModeState} />
          <LayerChips layer={layer} onChange={setLayerState} />
          <SearchBox features={features} onChoose={goToFeature} />
          {!features && (
            <div className="ctl ctl-note" role="status">
              Place names unavailable — search and labels are off; the map still
              works.
            </div>
          )}
          {modeError && (
            <div className="ctl ctl-error" role="alert" aria-live="assertive">
              {modeError}
            </div>
          )}
          <FeatureCard feature={selected} onClose={() => selectFeature(null)} />
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
