# Verify 10 — layer switching, mode morph, camera preservation

**Task:** 10 of 18 (`task-10-brief.md`). Run 2026-10-06 in the Qoder in-app browser
(MCP `browser-use`) against `npm run dev -- -p 3110` → **http://localhost:3110/**.
Port 3100 was already occupied by a PID this task did not start (per dispatch rules it was
left alone); the dev server for this run is on 3110 and was stopped after verification.

Gate status: **mode toggle works; camera preservation passes numerically; the *visual*
check could NOT be completed** — see "What remains for the controller".

## What was verified numerically (in-page evidence)

The app exposes `globalThis.__moonViewer` and `globalThis.__moonHarness`
(`camera()`, `sceneMode()`, `setMode`, `setLayer`, `setCamera`, `imageryCount()`) for the
verification harness only. All toggles below went through the real UI path
(`button.click()` on `.ctl-mode`/`.ctl-layer` → React state → effect → `morph.ts setMode/
setLayer`), except where a `__moonHarness.setMode` call is named explicitly (same function).

### Camera preservation across Paper↔Globe toggles

Home camera (set at viewer creation) = Mare Tranquillitatis at L5:
`lonDeg 23.4731, latDeg 0.6746, height 259658.7 m` ( = `cameraHeightForLevel(5, 900, 60)`).

| Pair | camera before toggle | after Paper | after Globe | Δ(lon/lat) | Δ(height) | Paper pitch / heading |
|---|---|---|---|---|---|---|
| 1 (dur 1.0 s) | 23.4731, 0.6746, 259 658.7 | SCENE2D ✓ | SCENE3D ✓ | −3.6e−15°, 0 | −2.2e−14 % | −π/2 exactly (−1.5707963267948966), heading ≡ 0 (mod 2π, ≤ 9e−10 rad) |
| 2 (dur 1.0 s) | −52.4, 18.9, 180 000, tilt −1.0 rad, heading 0.55 | SCENE2D ✓ | SCENE3D ✓ | −7.1e−15°, 0 | 0 % | −π/2, heading 6.2831853 − 2π ≈ −8e−10 |
| 3 (dur 1.0 s) | 134.2, −7.3, 2.1e6 | SCENE2D ✓ | SCENE3D ✓ | 0, 0 | 0 % | −π/2 |
| 4 (dur 0.5 s) | −12.3, 45.6, 500 000, tilt −0.9, heading 1.3 | SCENE2D ✓ | SCENE3D ✓ | 0, 0 | 0 % (500 000.00000000035 both sides) | −π/2 |
| 5 (dur 0.5 s) | 179.4, −89.99, 1 600 m (near MIN_H, near pole/antimeridian) | SCENE2D ✓ | SCENE3D ✓ | ≤ 7e−15°, 1.9e−11° | ≤ 1e−10 % | −π/2, heading 2.7e−8 ≡ 0 |

Extra stress toggle: (178.9, 84.2, 3.4e7 ≈ near-MAX_H) → SCENE2D with height 34 000 000
unchanged, pitch −π/2.

All deltas are orders of magnitude inside the brief's tolerance (≤ 0.01° centre, ≤ 5 %
height). Paper mode is always axis-aligned: pitch exactly −90°, heading 0 mod 2π.
`screenSpaceCameraController.enableTilt` was observed `false` in Paper and `true` in Globe.
One behaviour worth recording: a paper→globe toggle restores the orientation *snapshot*,
and because Paper forces nadir, a user's tilt is not resurrected after a round-trip
(pitch returns as −π/2). This is inherent to the brief's `preserveState` design.

### The first-click bug this task caught and fixed

Before the fix, the `didMount`-style ref that skips the first effect render was consumed by
the renders that happen *before* the manifest (and viewer) exist — so the user's **first**
mode toggle silently did nothing (aria-pressed changed, scene stayed SCENE3D). Fixed by
replacing the flag with an `applied` ref that records what the live viewer was actually
built/driven to. Verified: first click after load now morphs (SCENE3D→SCENE2D, pitch −π/2).

### Morph completion in this hidden harness

Cesium 1.146's morph is two sequential tweens driven by scene render frames; the brief's
`camera.morphTo2D(1.0, cb)` API **does not exist** (the morph methods are on `Scene` and
take only a duration). `setMode` therefore starts `scene.morphToX(0.5)` and pumps until
`scene.mode` reaches the target, with a wall-clock fallback (`scene.completeMorph()`) at
2×duration+3 s. In this in-app browser the page is *hidden* (`visibilityState: hidden`),
Chrome suspends its rAF loop and throttles its timers, so every toggle here completed via
the fallback (elapsed 4.0–8.7 s per morph). The **final state is what the table above
proves**; the smooth animated transition can only be judged in a visible tab (open the URL
below and click Paper — controller action).

### Layer switching

- 6 programmatic swaps (paper→photo ×3 alternating) + 2 real chip clicks (Albedo, Colour
  relief): after **every** swap `viewer.imageryLayers.length === 1` (no stacked layers),
  and the live provider template matched the selection:
  `/tiles/paper/{z}/{x}/{y}.jpg` or `/tiles/photo/{z}/{x}/{y}.jpg`, `maximumLevel: 6`.
- Tile fetches observed in the page resource timeline:
  `/tiles/photo/0/0/0.jpg`, `/tiles/photo/0/1/0.jpg` and `/tiles/manifest.json` (×2 —
  React StrictMode dev double-effect; `useManifest` guards setState after unmount, and the
  fetch is `cache: 'no-store'`). Paper tiles did not re-fetch at L0 because the L0 photo
  tiles were already decoded and the hidden tab suspends rendering; tile *selection* is
  proven by the provider template and by G1/G2 (same template) — a visible-tab check of
  the albedo/colour picture swap is left to the controller.

### CREDIT singleton across swaps

`CREDIT` is one module-level `Cesium.Credit` reused by every provider (Cesium 1.146's
Credit is id-keyed by html string and creates its DOM element lazily, the same pattern as
Cesium's own OpenStreetMapImageryProvider). After all 5+ mode pairs and 8 layer swaps:
the attribution is still in the DOM (`creditText` starts "NASA/GSFC/Arizona State
University (LROC WAC mosaic) …", 2 credit containers present), and the browser console
contains **zero** Cesium warnings or errors — no "already associated with a DOM element"
message of any kind. **Decision: CREDIT stays a singleton; no factory needed.**

Console inventory for the whole session: one info line ("Download the React DevTools…")
and nothing else.

## What could NOT be verified, and why

- **Screenshots: not possible.** `take_screenshot` returns
  `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE … visible=false` (the same 0×viewport wall as
  Gate G1's harness notes). "Screenshot both modes at L5 over Mare Tranquillitatis" was
  therefore **not done** and no visual pass is claimed: not the paper map's axis
  alignment, not the globe shading, not the albedo-vs-colour look.
- **User-drag between toggles: substituted.** Synthetic `PointerEvent`s on the canvas do
  not pan Cesium in this harness (the camera did not move, and dispatching them froze the
  evaluate round-trip). Between pairs the camera was moved with the same end-state a drag
  produces (`__moonHarness.setCamera` → `camera.setView`, including tilt and heading);
  the preservation invariant under test is identical. Real mouse-drag behaviour still
  needs one look in a visible tab.

## Steps for the controller (close the visual check)

1. Open http://localhost:3110/ (server: `npm run dev -- -p 3110`; stop the PID you started
   afterwards) in a **visible** window and click Paper: the morph should animate in ~0.5 s
   and the map should be axis-aligned (north up, no tilt). Click Globe: tilt returns.
2. At the L5 home view over Mare Tranquillitatis, screenshot both modes.
3. Click Albedo ↔ Colour relief: the imagery should swap between greyscale albedo and
   colour relief with no double-layer ghosting.
4. Drag the map between toggles once, to confirm preservation with real input.
