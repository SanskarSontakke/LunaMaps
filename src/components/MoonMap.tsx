'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Cesium from 'cesium';
import { createMoonViewer, globeFitHeightMeters, MOON_ELLIPSOID } from '@/lib/cesium/moon';
import {
  flyToFeature,
  getCameraState,
  setLayer,
  setMode,
  type CameraState,
  type ModeChange,
} from '@/lib/cesium/morph';
import { attemptMode, createModeLatch, type ModeAttempt } from '@/lib/cesium/modeLatch';
import { attachPicking } from '@/lib/cesium/picking';
import { measureMPerPx } from '@/lib/cesium/scaleProbe';
import { attachLabels, type LabelSet } from '@/lib/labels/entities';
import { layerTop, loadManifest, probeAssets } from '@/lib/assets';
import {
  bootFailure,
  bootHint,
  createTileErrorTally,
  hasWebGL2,
  runBoot,
  type BootErrorState,
  type BootState,
} from '@/lib/diagnostics';
import NoAssets from './NoAssets';
import ErrorPanel from './ErrorPanel';
import { fuzzySearch } from '@/lib/search';
import { attachKeyboard } from '@/lib/keyboard';
import {
  createUrlSync,
  parseHash,
  viewFromCamera,
  wasEmptyHash,
  type UrlSync,
  type ViewState,
} from '@/lib/urlState';
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
import SearchBox, { SEARCH_INPUT_ID } from './SearchBox';
import FeatureCard from './FeatureCard';
import ScaleReadout, { type ReadoutState } from './ScaleReadout';
import Attribution from './Attribution';

declare global {
  // Exposed for the browser verification harness only.
  var __moonViewer: Cesium.Viewer | undefined;
  var __moonHarness: MoonHarness | undefined;
  var CESIUM_BASE_URL: string | undefined;
}

export interface MoonHarness {
  camera(): CameraState | null;
  sceneMode(): string;
  /**
   * The RAW morph: `setMode` on the live viewer, nothing else. It deliberately
   * bypasses the mode latch, so it does not claim an intent, does not roll back
   * on failure and does not move `sceneMode` — which is why `data-mode` on the
   * canvas does NOT follow it. A live probe that watched `data-mode` after this
   * call could (correctly) report `globe` while a morph to paper was running;
   * that is a harness artifact, not an app bug. Task 18 sweeps should call
   * `requestMode` instead, and keep this only for the case where the morph
   * primitive itself is the thing under test.
   */
  setMode(mode: Mode): Promise<ModeChange>;
  /**
   * The REAL mode-change path: the same state machine a toggle click runs
   * (`attemptMode` on the component's own latch → morph → commit or roll back),
   * so the latch, the `data-mode` tint, the toggle's selected state and the
   * `role="alert"` panel all move exactly as they do for a human click, and the
   * returned attempt says how it actually ended.
   */
  requestMode(mode: Mode): Promise<ModeAttempt>;
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
  /** The live projected scale, straight from `measureMPerPx` (Task 13 sweep). */
  scale(): { mPerPx: number | null; canvas: [number, number] };
  /**
   * Task 14 sweep: what the address bar holds, and a forced write of the live
   * view into it. The forced path exists because the camera → hash direction is
   * driven by `postRender`, and a frame-starved (hidden / 0×0) tab never fires
   * it — without `flushHash()` the URL state could only be observed by waiting
   * for real frames.
   */
  hash(): string;
  flushHash(): string;
  /**
   * Task 15: how many REAL tile-load errors the live viewer has reported through
   * `ImageryLayer.errorEvent`. The Task 18 sweep reads this instead of eyeballing
   * the network log; it is always 0 on a healthy Tier A pyramid, and it is never a
   * number this app made up.
   */
  tileErrors(): number;
}

// Cesium.SceneMode enum values as names (MORPHING=0 … SCENE3D=3), for readable
// harness output.
const MODE_NAMES = ['MORPHING', 'COLUMBUS_VIEW', 'SCENE2D', 'SCENE3D'];

// Home view: centred on Mare Tranquillitatis, at whatever height frames the
// whole globe in THIS viewport (gate G3 defect 3 — the previous height came from
// `cameraHeightForLevel(5, 900, 60)` = 260 km, which is a close-up of one
// quadrangle, and the 22,000 km the G3 hash asked for leaves a 110 px disc).
const HOME = { lonDeg: 23.4731, latDeg: 0.6746 };

/** Cesium's default 60° fov is vertical; an orthographic or 2D frustum has none,
 *  and `globeFitHeightMeters` takes the fallback in that case. */
const homeHeight = (viewer: Cesium.Viewer) => {
  const frustum = viewer.camera.frustum;
  const fov =
    frustum instanceof Cesium.PerspectiveFrustum
      ? (frustum.fov ?? Math.PI / 3)
      : Math.PI / 3;
  return globeFitHeightMeters(
    viewer.canvas.clientWidth,
    viewer.canvas.clientHeight,
    fov,
  );
};

// Paper and photo levels come strictly from the validated manifest — there is
// no default or hardcoded fallback, so Cesium's maximumLevel always matches what
// was actually baked. `probe` is not a product layer: it is the single-level
// Task 2 gate fixture, pinned to top 1 here and nowhere else.
const topOf = (manifest: Manifest, layer: LayerName) =>
  layer === 'probe' ? 1 : layerTop(manifest, layer);

/**
 * Shown when the morph had to be jump-cut at the deadline. The mode DID change,
 * so this is a status and not an error — but the animation the user asked for
 * never ran (a frame-starved tab), and reporting plain success would claim an
 * animation that did not happen.
 */
const forcedNotice = (mode: Mode) =>
  `${mode === 'paper' ? 'Paper' : 'Globe'} view is showing; the transition could ` +
  'not animate (no render frames), so it was completed instantly.';

export default function MoonMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const labelsRef = useRef<LabelSet | null>(null);
  const pickedRef = useRef<Feature | null>(null);
  // The keyboard detach function, so a StrictMode double-mount attaches once.
  const keyboardRef = useRef<(() => void) | null>(null);
  // ---- Task 15: the boot state machine ------------------------------------
  // `webgl` starts as null because `hasWebGL2()` needs a document: on the server
  // (and on the client's first render, which must match it) the answer is simply
  // not known yet. The boot effect waits for it instead of guessing.
  const [webgl, setWebgl] = useState<boolean | null>(null);
  // Every step that can fail, and what it renders instead of a blank canvas:
  //   webgl / manifest / probe / viewer  -> a full-screen panel
  //   labels / picking                   -> a retryable banner over a working map
  // `booting` is the only pre-panel phase, so there is never an empty screen.
  const [boot, setBoot] = useState<BootState>({ phase: 'booting' });
  // A failed step must be RETRYABLE. Nothing latches: `bootNonce` is bumped by
  // the panels' Try-again button, the boot effect re-runs on it, and it clears
  // its own failure state at the top of each attempt. This is the rule Task 10
  // round 1 broke (a stranded `requested` deduped every later attempt until
  // reload) and round 2 fixed with `rollbackMode`; the same discipline applies
  // here, so no failed step can leave a request that swallows the next click.
  const [bootNonce, setBootNonce] = useState(0);
  // Labels and picking attach *after* the map is already drawing, so a failure
  // there is a banner on a live map, not a screen-replacing panel — and the same
  // nonce-based retry, because `labelsRef`/`pickedRef` are only published once
  // the attach actually succeeded.
  const [attachError, setAttachError] = useState<
    BootErrorState | null
  >(null);
  const [attachNonce, setAttachNonce] = useState(0);
  // Real per-tile failure capture (design §4.4 "counted and logged"): every
  // increment comes from a Cesium `ImageryLayer.errorEvent`, never from an
  // estimate. See src/lib/diagnostics.ts.
  const tileTally = useRef(createTileErrorTally());
  const [tileErrors, setTileErrors] = useState(0);
  // The manifest the *ready* boot produced, or null while booting/failed. Named
  // `manifest` so every downstream consumer (viewer, layer effect, scale readout,
  // attribution) reads the same value it always did — only its source is now the
  // boot machine rather than an unretryable one-shot fetch.
  const manifest = boot.phase === 'ready' ? boot.manifest : null;
  const [features, setFeatures] = useState<FeatureCollection | null>(null);
  // A ref mirror of the two pieces of late-arriving state the dev harness needs
  // (it is built once, when the viewer is created, long before `features`
  // exists and independently of every re-render).
  const featuresRef = useRef<FeatureCollection | null>(null);
  const selectedRef = useRef<Feature | null>(null);
  const [selected, setSelectedFeature] = useState<Feature | null>(null);
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  const [layer, setLayerState] = useState<LayerName>(DEFAULT_LAYER);
  // What the live viewer was built with and has since been *confirmed* at for
  // the layer (`setLayer` is synchronous, so the layer effect dedupes on it
  // directly). The mode half of that idea now lives in `modeLatch`.
  const appliedLayer = useRef<LayerName>(DEFAULT_LAYER);
  // The mode the scene has been CONFIRMED to be in, mirrored into state so the
  // toggle can render the truth. `mode` is what the user asked for; this is what
  // the map actually shows. Round 1 rendered `mode`, so a rejected morph left the
  // toggle claiming a mode the scene never reached.
  const [sceneMode, setSceneMode] = useState<Mode>(DEFAULT_MODE);
  // The mode-request state machine: `applied` (confirmed) + `requested` (the
  // morph currently in flight). THE RULE, pinned by `src/test/modeLatch.test.ts`:
  // a request is dropped when `mode` equals EITHER half of the latch, so during a
  // Paper↔Globe double-click the FIRST click wins — the second click's mode is
  // the one already held (`applied`, the scene has not left it yet) and is
  // therefore a real no-op. The scene lands in the FIRST mode, not the second.
  // (`setMode`'s own queue serialises whatever the latch lets through; the latch,
  // not the queue, is what decides.) This is deliberate: re-firing the mode the
  // live scene is still standing in would enqueue a morph the toggle is not
  // showing, and the previous round's bug was a `requested` that survived a
  // failure and deduped every later click — hence the rollback below, not a
  // second-wins queue.
  const modeLatch = useRef(createModeLatch(DEFAULT_MODE));
  // Bumped by every mode request so the effect re-runs even when `mode` did not
  // change — i.e. the retry click after a failure, which React would otherwise
  // swallow as a no-op state write. The latch is what still dedupes real no-ops.
  const [modeNonce, setModeNonce] = useState(0);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modeNotice, setModeNotice] = useState<string | null>(null);
  const [readout, setReadout] = useState<ReadoutState>({
    mPerPx: null,
    latDeg: HOME.latDeg,
    lonDeg: HOME.lonDeg,
  });

  // ---- Task 14: shareable URL state ---------------------------------------
  // Mirrors of the two fields the frame-driven sync reads. `sceneMode` (the mode
  // the scene is CONFIRMED to be in) rather than `mode` (the last one clicked),
  // so a shared link can never promise a mode the morph did not reach — the same
  // honesty rule Task 10 round 2 put on the toggle. `layer` is applied
  // synchronously by its effect, so intent and scene cannot disagree.
  const modeRef = useRef<Mode>(DEFAULT_MODE);
  const layerRef = useRef<LayerName>(DEFAULT_LAYER);
  const urlSyncRef = useRef<UrlSync | null>(null);
  // The camera the hash asked for. Read on mount (no viewer exists yet — the
  // manifest fetch is async) and applied when the viewer is created.
  const pendingCameraRef = useRef<ViewState | null>(null);
  // The feature the hash asked for, resolved once features.json exists.
  const pendingFeatureRef = useRef<string | null>(null);

  // What the address bar should hold right now: the live camera, the confirmed
  // mode/layer and the existing selection. Every field is read from state that
  // already has an owner, so the URL is a *projection* — never a second source of
  // truth for the card, the mode or the layer.
  const currentUrlView = useCallback((): ViewState | null => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed()) return null;
    return viewFromCamera(
      getCameraState(viewer),
      modeRef.current,
      layerRef.current,
      selectedRef.current?.properties.name,
    );
  }, []);

  // Move the camera to a view parsed out of a hash. Nadir, north-up: a shared
  // link carries no heading/pitch, so the restore must not inherit whatever
  // tilt the previous session happened to leave on the camera.
  const applyViewCamera = useCallback((viewer: Cesium.Viewer, v: ViewState) => {
    viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        v.lon,
        v.lat,
        v.height,
        MOON_ELLIPSOID,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  }, []);

  // Card state for both entry points (search result and map click). Kept
  // separate from `pickedRef`, which stays strictly "what the last left-click
  // picked" so Task 11's harness metric does not drift.
  const selectFeature = useCallback((f: Feature | null) => {
    selectedRef.current = f;
    setSelectedFeature(f);
    // The open card and the address bar are the same fact, so write it now
    // instead of waiting for a frame: a link copied mid-fly-to still names the
    // feature. `flush` keeps the differ guard, so this cannot feed a loop, and
    // before the viewer exists `currentUrlView()` is null — nothing is written.
    const view = currentUrlView();
    if (view) urlSyncRef.current?.flush(view);
  }, [currentUrlView]);
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

  // One owner for every mode request: the toggle click, the 1/2 keys, and any
  // future URL restore. It sets the intent AND bumps the nonce, so a click on the
  // mode the scene is already holding (a retry after a failed morph) still reaches
  // the effect instead of being a no-op state write.
  const requestModeChange = useCallback((next: Mode) => {
    setModeState(next);
    setModeNonce((n) => n + 1);
  }, []);

  // Render the outcome of ONE mode attempt. Extracted from the mode effect
  // because the dev harness drives the same state machine through the same latch
  // (see `requestMode` below) and must report it identically — otherwise a sweep
  // that morphs through the harness would leave the toggle, the tint and the
  // error panel describing a mode the scene never reached.
  //
  // Every branch leaves the latch holding the mode the scene is confirmed in, so
  // the state written here is `reached`/`mode` from the attempt, never `mode`
  // from the intent.
  const applyModeAttempt = useCallback((out: ModeAttempt) => {
    switch (out.status) {
      case 'noop':
        return;
      case 'torn-down':
        // Teardown (unmount): no scene to report on, and the next viewer build
        // re-creates the latch. Neither an error nor a false success.
        return;
      case 'committed':
        setSceneMode(out.mode);
        setModeError(null);
        // A jump-cut at the deadline is NOT an animated morph: say so, while
        // still confirming the mode did change.
        setModeNotice(out.forced ? forcedNotice(out.mode) : null);
        return;
      case 'failed':
        // The morph never landed. `attemptMode` already rolled the latch back to
        // the mode the scene really holds — otherwise `requested` stays on the
        // failed mode and every later request for it is deduped until reload —
        // and `reached` is what the toggle now shows, so it never claims a mode
        // the scene did not reach.
        setSceneMode(out.reached);
        setModeNotice(null);
        setModeError(`View mode change failed: ${out.message}`);
        return;
    }
  }, []);

  // The handler above, reached through a ref that every render refreshes.
  //
  // WHY IT IS A REF AND NOT A DEPENDENCY: `applyModeAttempt` is a function, and a
  // function inside `useEffect`'s second argument makes the dependency array's
  // LENGTH the thing that varies between module versions (2 before the harness
  // shared it, 3 after) — and React's dev invariant on exactly that ("The final
  // argument passed to useEffect changed size between renders. Previous: [globe,
  // 0]  Incoming: [globe, 0, (out)=>…]") is a THROW, not a warning. The error
  // boundary then replaces the whole page with "Application error" and no viewer
  // is ever built, so the map, the labels, the search and `__moonHarness` all
  // vanish together. Reading the latest handler off a ref keeps the array the
  // fixed two-value literal `[mode, modeNonce]`, which is what `src/test/
  // effectDeps.test.ts` now pins statically: no dependency array in this file may
  // hold a function expression, and every one has a fixed literal length.
  const applyModeAttemptRef = useRef(applyModeAttempt);
  applyModeAttemptRef.current = applyModeAttempt;

  // Scale, measured through the live camera (see src/lib/cesium/scaleProbe.ts).
  // Only re-render when a *displayed* digit changed: this runs from the
  // postRender hook, and an unconditional setState at 8 Hz would rebuild the
  // React tree on every frame of a fly-to.
  const updateReadout = useCallback((viewer: Cesium.Viewer) => {
    if (viewer.isDestroyed()) return;
    const state = getCameraState(viewer);
    const next: ReadoutState = {
      mPerPx: measureMPerPx(viewer),
      latDeg: state.latDeg,
      lonDeg: state.lonDeg,
    };
    setReadout((prev) => {
      const sameScale =
        (prev.mPerPx === null) === (next.mPerPx === null) &&
        (prev.mPerPx === null ||
          next.mPerPx === null ||
          Math.round(prev.mPerPx) === Math.round(next.mPerPx));
      if (
        sameScale &&
        prev.latDeg.toFixed(4) === next.latDeg.toFixed(4) &&
        prev.lonDeg.toFixed(4) === next.lonDeg.toFixed(4)
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  // Read the shared hash once, on mount, while there is still no viewer. The
  // camera it names is applied when the viewer is created; mode and layer go
  // through the same state setters the controls use, so the viewer is *built* in
  // the shared mode instead of morphing into it a commit later (and the mode
  // latch is never claimed by anybody other than its own effect).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const hash = window.location.hash;
    // Empty or malformed (`#nonsense`, `#NaN/0/0/globe/photo`): keep HOME and
    // the default mode/layer. `parseHash` has already fallen back to
    // DEFAULT_VIEW, so nothing throws and no error overlay appears — and the
    // first sync tick below publishes the framing actually on screen.
    if (wasEmptyHash(hash)) return;
    const v = parseHash(hash);
    pendingCameraRef.current = v;
    if (v.feature) pendingFeatureRef.current = v.feature;
    setModeState(v.mode);
    setLayerState(v.layer);
  }, []);

  // Step 1 of the boot order: can this browser give us a WebGL2 context at all?
  // Deferred to an effect so the server render and the first client render agree
  // (`webgl === null` means "not probed yet", not "no WebGL").
  useEffect(() => {
    setWebgl(hasWebGL2());
  }, []);

  // Steps 1–3 run inside `runBoot` (src/lib/diagnostics.ts), with the WebGL probe
  // and the two asset calls injected, so the order and its routing are unit-tested
  // without a browser. Only after it returns `ready` does the viewer effect below
  // get a manifest to build with, so Cesium is never constructed over a pyramid
  // that was not verified by the probe.
  //
  // Retryable: `bootNonce` is in the deps and the first thing every attempt does
  // is clear the previous failure. Clicking Try again after a failed bake-less
  // boot re-fetches; a success then falls through to `ready` and the map builds.
  useEffect(() => {
    if (webgl === null) return; // not probed yet (SSR / first paint)
    let alive = true;
    setBoot({ phase: 'booting' });
    tileTally.current.reset();
    setTileErrors(0);
    void runBoot({
      hasWebGL2: () => webgl === true,
      loadManifest,
      probeAssets,
    }).then((state) => {
      if (alive) setBoot(state);
    });
    return () => {
      alive = false;
    };
  }, [webgl, bootNonce]);

  const retryBoot = useCallback(() => setBootNonce((n) => n + 1), []);
  const retryAttach = useCallback(() => setAttachNonce((n) => n + 1), []);

  // The viewer is created only after the manifest has loaded and validated,
  // so `top` is real and a broken build fails in the panel below, not in a
  // half-rendered Cesium scene.
  useEffect(() => {
    globalThis.CESIUM_BASE_URL = '/cesium';
    const host = hostRef.current;
    if (!host || !manifest || viewerRef.current) return;
    // Step 4 — the viewer itself. This is where a missing `public/cesium` shows
    // up (Cesium's WorkerFactory / Resource loads throw), and where a GPU that
    // vanished between the WebGL2 probe and context creation throws. The kind is
    // classified from the real message, and `viewerRef` stays null so the retry
    // can build again — a failed construction must not latch.
    let viewer: Cesium.Viewer;
    try {
      viewer = createMoonViewer(host, {
        layer,
        top: topOf(manifest, layer),
        mode,
      });
    } catch (e: unknown) {
      setBoot(bootFailure('viewer', e));
      return;
    }
    appliedLayer.current = layer;
    modeLatch.current = createModeLatch(mode);
    setSceneMode(mode);
    modeRef.current = mode;
    layerRef.current = layer;
    // The shared view wins over HOME when the hash carried one; the hash effect
    // below has already had its turn (it is declared first), so `pendingCameraRef`
    // is populated before this runs.
    const restored = pendingCameraRef.current;
    if (restored) {
      applyViewCamera(viewer, restored);
      // The readout starts at HOME, so a restored view must re-seed it here
      // rather than printing the old centre until the first rendered frame.
      updateReadout(viewer);
    } else {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          HOME.lonDeg,
          HOME.latDeg,
          homeHeight(viewer),
          MOON_ELLIPSOID,
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }
    // requestRenderMode viewer: the home setView changes nothing on screen
    // until a frame is asked for (the same pump setLayer/setMode do).
    viewer.scene.requestRender();
    viewerRef.current = viewer;
    // Design §4.4's "individual tile 404 at runtime" line, as REAL capture:
    // Cesium 1.146 raises `ImageryLayer.errorEvent` with a TileProviderError
    // carrying level/x/y, and every increment of the tally comes from one of
    // those events (src/lib/diagnostics.ts). `setLayer` removes and re-adds
    // imagery layers, so the subscription follows the collection through its
    // `layerAdded` / `layerRemoved` events instead of watching only index 0. The
    // count is always kept; the console log and the dev overlay only exist in
    // development, and the log stops after five lines so a broken pyramid cannot
    // flood the console.
    const tally = tileTally.current;
    const onTileError = (err: unknown) => {
      tally.observe(err);
      if (process.env.NODE_ENV === 'development') {
        const [latest] = tally.recent(1);
        if (tally.total() <= 5) {
          console.warn(
            `[tiles] tile failure #${tally.total()}: ${latest?.tile ?? 'provider-level'} — ${
              latest?.message ?? 'no message'
            }`,
          );
        }
        setTileErrors(tally.total());
      }
    };
    const layers = viewer.imageryLayers;
    const subscribe = (l: Cesium.ImageryLayer) => l.errorEvent.addEventListener(onTileError);
    const unsubscribe = (l: Cesium.ImageryLayer) => l.errorEvent.removeEventListener(onTileError);
    const onLayerAdded = (l: Cesium.ImageryLayer) => subscribe(l);
    const onLayerRemoved = (l: Cesium.ImageryLayer) => unsubscribe(l);
    for (let i = 0; i < layers.length; i += 1) subscribe(layers.get(i));
    layers.layerAdded.addEventListener(onLayerAdded);
    layers.layerRemoved.addEventListener(onLayerRemoved);
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
        // The raw morph primitive: bypasses the latch, so `data-mode` does not
        // follow it. Kept for testing `setMode` itself — see the interface docs.
        setMode: (m: Mode) => setMode(viewer, m),
        // The real path, for sweeps that have to observe what a click does. The
        // latch is claimed here exactly as the mode effect claims it, and the
        // outcome is rendered through the same `applyModeAttemptRef` the mode
        // effect uses, so the toggle, the tint and the `role="alert"` panel move
        // as they do for a human.
        // Setting `mode` afterwards is what the effect would have done anyway,
        // and it cannot double-morph: the latch now confirms the scene is already
        // in that mode, so the effect's `attemptMode` returns `noop`.
        requestMode: async (m: Mode): Promise<ModeAttempt> => {
          if (viewer.isDestroyed()) {
            return { status: 'torn-down', reached: modeLatch.current.applied };
          }
          const out = await attemptMode(modeLatch.current, m, (mm) =>
            setMode(viewer, mm),
          );
          applyModeAttemptRef.current(out);
          if (out.status !== 'noop') {
            setModeState(out.status === 'committed' ? out.mode : out.reached);
          }
          return out;
        },
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
        scale: () => ({
          mPerPx: viewer.isDestroyed() ? null : measureMPerPx(viewer),
          canvas: [viewer.canvas.clientWidth, viewer.canvas.clientHeight],
        }),
        hash: () => window.location.hash,
        tileErrors: () => tileTally.current.total(),
        flushHash: () => {
          const view = currentUrlView();
          if (view) urlSyncRef.current?.flush(view);
          return window.location.hash;
        },
      };
    }
    return () => {
      // Detach the tile-error wiring before destroying the viewer: a listener on
      // a destroyed collection is the kind of leak that only shows up as a stale
      // count in the next boot attempt.
      layers.layerAdded.removeEventListener(onLayerAdded);
      layers.layerRemoved.removeEventListener(onLayerRemoved);
      for (let i = 0; i < layers.length; i += 1) unsubscribe(layers.get(i));
      viewer.destroy();
      viewerRef.current = null;
      globalThis.__moonViewer = undefined;
      globalThis.__moonHarness = undefined;
    };
    // mode/layer are read from the render in which the manifest first arrives;
    // after that the two effects below own them. `bootNonce` is here so a retry
    // after a failed viewer build re-runs this effect even in the (unlikely) case
    // where the new boot hands back an identical manifest object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, bootNonce]);

  // Apply user changes after the viewer exists. The first run of this effect
  // matches the latch and is a no-op, so the viewer is never morphed while it is
  // being built. `modeNonce` is in the deps so a *repeat* click — the retry after
  // a rejection, where `mode` is already the clicked value — re-runs the attempt;
  // the latch inside `attemptMode` is what still refuses to enqueue a duplicate
  // morph. All the decision-making (claim → await → commit or roll back) lives in
  // `attemptMode`, which `src/test/modeLatch.test.ts` drives directly; this effect
  // only renders its result.
  //
  // DEPS: a fixed two-value literal, never the handler (see `applyModeAttemptRef`)
  // and never a computed/conditional array — a dependency array whose length can
  // differ between renders takes the whole page down.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    void attemptMode(modeLatch.current, mode, (m) => setMode(viewer, m)).then(
      (out) => applyModeAttemptRef.current(out),
    );
  }, [mode, modeNonce]);
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !manifest) return;
    if (appliedLayer.current === layer) return;
    appliedLayer.current = layer;
    setLayer(viewer, layer, topOf(manifest, layer));
  }, [layer, manifest]);

  // Keep the sync's mirrors in step with the truth the effects just confirmed.
  useEffect(() => {
    modeRef.current = sceneMode;
  }, [sceneMode]);
  useEffect(() => {
    layerRef.current = layer;
  }, [layer]);

  // Two-way URL sync, attached once there is a live camera to read.
  //
  //   camera -> hash : on `postRender`, throttled to 4 Hz, and only when the
  //                    serialised string differs from what the document holds.
  //   hash -> camera : on `hashchange` (back/forward traversal, or a link pasted
  //                    into the address bar).
  //
  // Why it cannot loop: `history.replaceState` does not fire `hashchange`; the
  // inbound path writes exactly the fields the outbound path reads; and
  // `serialize(parse(serialize(v))) === serialize(v)` makes every written value
  // its own fixed point, so the guard sees no difference on the next pass. The
  // hostile-listener case (a `hashchange` that re-syncs on every write) is pinned
  // in `src/test/urlState.test.ts`, and `lastWritten()` covers the one event that
  // can carry our own value back — a traversal to a hash we minted.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !manifest || typeof window === 'undefined') return;
    const sync = createUrlSync({
      readHash: () => window.location.hash,
      write: (hash) => window.history.replaceState(null, '', hash),
    });
    urlSyncRef.current = sync;
    const onPostRender = () => {
      if (viewer.isDestroyed()) return;
      const view = currentUrlView();
      if (view) sync.tick(view);
    };
    const onHashChange = () => {
      const hash = window.location.hash;
      if (hash === sync.lastWritten()) return;
      if (wasEmptyHash(hash)) return; // cleared by hand: leave the live view alone
      const v = parseHash(hash);
      setModeState(v.mode);
      setLayerState(v.layer);
      applyViewCamera(viewer, v);
      if (v.feature) {
        const hit = (featuresRef.current?.features ?? []).find(
          (f) => f.properties.name === v.feature,
        );
        // An unknown name opens no card; the camera still moves where the link
        // said, which is the degraded path the design asks for rather than an
        // error. If the gazetteer has not arrived yet, hand the name to the
        // hydration effect below (read from the ref, not from a stale closure).
        selectFeature(hit ?? null);
        if (!hit && !featuresRef.current) pendingFeatureRef.current = v.feature;
      } else {
        selectFeature(null);
      }
      // Re-read rather than trust the tween: `setView` is immediate, so this is
      // the camera the scene actually holds, and the guard makes it a no-op when
      // it already matches the address bar.
      const applied = currentUrlView();
      if (applied) sync.flush(applied);
    };
    viewer.scene.postRender.addEventListener(onPostRender);
    window.addEventListener('hashchange', onHashChange);
    // Publish the framing that is on screen right now (HOME, or the restored
    // view) instead of leaving the bar blank until the first throttled frame.
    onPostRender();
    return () => {
      sync.stop();
      urlSyncRef.current = null;
      window.removeEventListener('hashchange', onHashChange);
      if (!viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
      }
    };
  }, [manifest, applyViewCamera, currentUrlView, selectFeature]);

  // A shared link that names a feature re-opens the card once the gazetteer has
  // loaded — through `selectFeature`, the same owner the search result and the
  // map click use. The URL is never consulted again after this: it is an input to
  // that state, not a second copy of it.
  useEffect(() => {
    const name = pendingFeatureRef.current;
    if (!name || !features) return;
    pendingFeatureRef.current = null;
    const hit = features.features.find((f) => f.properties.name === name);
    if (hit) selectFeature(hit);
  }, [features, selectFeature]);

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

  // Steps 5 and 6 of the boot order: place names, then picking. They attach to a
  // viewer that is ALREADY drawing, so a throw here must not hide a working map
  // behind a full-screen panel — it becomes a retryable banner (below the render),
  // and the map keeps running.
  //
  // Retryability again decides the shape of the code: `labelsRef` is published
  // only after `attachLabels` AND the first refresh have both succeeded, and the
  // partial attach is destroyed on failure. The old order (`labelsRef.current =
  // labels` before `refresh`) meant a throw from `refresh` left the ref set, so
  // this effect's own `labelsRef.current` guard refused every later attempt — the
  // Task 10 latch bug in a different file. `attachNonce` gives the banner's
  // Try-again button a way back in.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !features || labelsRef.current) return;
    let labels: LabelSet | null = null;
    let detachPick: (() => void) | null = null;
    let onPostRender: (() => void) | null = null;
    let failure: BootErrorState | null = null;
    try {
      labels = attachLabels(viewer, features);
      labels.refresh(getCameraState(viewer).height);
      let last = 0;
      onPostRender = () => {
        const t = Date.now();
        if (t - last < 125) return; // throttle to 8 Hz
        last = t;
        if (!viewer.isDestroyed()) {
          labels?.refresh(getCameraState(viewer).height);
          updateReadout(viewer);
        }
      };
      viewer.scene.postRender.addEventListener(onPostRender);
      labelsRef.current = labels;
    } catch (e: unknown) {
      failure = bootFailure('labels', e);
      if (onPostRender && !viewer.isDestroyed()) {
        viewer.scene.postRender.removeEventListener(onPostRender);
        onPostRender = null;
      }
      labels?.destroy();
      labels = null;
      labelsRef.current = null;
    }
    if (!failure) {
      try {
        detachPick = attachPicking(viewer, (f) => {
          pickedRef.current = f;
          // A pick opens the card (Task 12 is picking's first consumer). Picking
          // the canvas beside a label yields null, which closes it.
          selectFeature(f);
        });
      } catch (e: unknown) {
        failure = bootFailure('picking', e);
      }
    }
    // `null` on a clean attach: React bails out when the value is unchanged, so
    // this does not re-render the tree on every successful run.
    setAttachError(failure);
    return () => {
      if (!viewer.isDestroyed()) {
        if (onPostRender) viewer.scene.postRender.removeEventListener(onPostRender);
        labels?.destroy();
      }
      detachPick?.();
      labelsRef.current = null;
    };
    // selectFeature is a stable useCallback, so this never re-runs the attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, manifest, selectFeature, attachNonce]);

  // Keyboard navigation, attached to the window (the canvas never holds focus,
  // and a document-level listener would fight Cesium's own handlers). Keys are
  // inert while a text field has focus, so typing in the search box moves the
  // caret, not the camera; `1`/`2` route through the same request handler the
  // mode toggle uses, so a morph is never started twice by two owners.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || keyboardRef.current) return;
    keyboardRef.current = attachKeyboard(window, viewer, {
      afterMove: () => {
        if (viewer.isDestroyed()) return;
        labelsRef.current?.refresh(getCameraState(viewer).height);
        // Immediate, so a single keypress is visible even when it lands inside
        // the 125 ms postRender throttle window of a one-shot move.
        updateReadout(viewer);
      },
      setMode: (m) => requestModeChange(m),
      focusSearch: () => document.getElementById(SEARCH_INPUT_ID)?.focus(),
      close: () => selectFeature(null),
    });
    return () => {
      keyboardRef.current?.();
      keyboardRef.current = null;
    };
  }, [manifest, requestModeChange, selectFeature, updateReadout]);

  return (
    <>
      {/* `sceneMode`, not `mode`: the tint has to match what the scene actually
          reached. Task 10 round 2 established that `mode` is the last one clicked
          and `sceneMode` is the confirmed one — binding the paper sheet to the
          intent would paint a warm map under a scene whose morph failed. */}
      <div
        ref={hostRef}
        id="cesiumContainer"
        className="map-host"
        data-mode={sceneMode}
      />
      {manifest && (
        <div className="ui">
          {/* The toggle reports the mode the SCENE is in, not the one last
              clicked: a morph that fails must not leave 'Globe' looking selected
              while the map is still on paper. */}
          <ModeToggle mode={sceneMode} onChange={requestModeChange} />
          <LayerChips layer={layer} onChange={setLayerState} />
          <SearchBox features={features} onChoose={goToFeature} />
          <ScaleReadout readout={readout} top={topOf(manifest, layer)} />
          {!features && (
            <div className="ctl ctl-note" role="status">
              Place names unavailable — search and labels are off; the map still
              works.
            </div>
          )}
          {modeNotice && (
            // Not an alert: the mode DID change. This says the transition was
            // jump-cut rather than animated, so the panel never reports a smooth
            // morph that the page could not render.
            <div className="ctl ctl-note" role="status" aria-live="polite">
              {modeNotice}
            </div>
          )}
          {modeError && (
            <div className="ctl ctl-error" role="alert" aria-live="assertive">
              {modeError}
            </div>
          )}
          {/* Steps 5 and 6 failed on a map that IS drawing: a banner with its own
              retry, not a screen-replacing panel. */}
          {attachError && (
            <div className="ctl ctl-error ctl-attach" role="alert" aria-live="assertive">
              <span>
                {attachError.step === 'labels'
                  ? 'Place names failed to attach'
                  : 'Map picking failed to attach'}
                {' — '}
                {bootHint(attachError.kind)} <code>{attachError.message}</code>
              </span>
              <button type="button" className="panel-retry" onClick={retryAttach}>
                Try again
              </button>
            </div>
          )}
          {/* Dev-only tile-failure counter, straight from Cesium's own error events
              (design §4.4). Zero means zero real `ImageryLayer.errorEvent`
              firings — never an estimate. */}
          {process.env.NODE_ENV === 'development' && tileErrors > 0 && (
            <div className="ctl ctl-tile-errors" role="status">
              tile load errors: {tileErrors}
            </div>
          )}
          <FeatureCard feature={selected} onClose={() => selectFeature(null)} />
        </div>
      )}
      {boot.phase === 'booting' && webgl !== false && (
        <div className="ui">
          <div className="ctl ctl-note" role="status">
            Loading baked lunar imagery…
          </div>
        </div>
      )}
      {boot.phase === 'assets' && (
        <NoAssets missing={boot.missing} onRetry={retryBoot} />
      )}
      {boot.phase === 'error' && (
        <ErrorPanel
          kind={boot.kind}
          step={boot.step}
          message={boot.message}
          onRetry={retryBoot}
        />
      )}
      {/* Outside `.ui` on purpose: provenance stays on screen even when the
          manifest or features.json is missing. */}
      <Attribution manifest={manifest} />
    </>
  );
}
