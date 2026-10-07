# Verify 10 — layer switching, mode morph, camera preservation

**Task:** 10 of 18 (`task-10-brief.md`). Run 2026-10-06 in the Qoder in-app browser
(MCP `browser-use`) against `npm run dev -- -p 3110` → **http://localhost:3110/**.
Port 3100 was already occupied by a PID this task did not start (per dispatch rules it was
left alone); the dev server for this run is on 3110 and was stopped after verification.

Gate status: **mode toggle works; camera preservation passes numerically; the *visual*
check could NOT be completed** — see "What remains for the controller".

## What was verified numerically (in-page evidence)

The app exposes `globalThis.__moonViewer` and `globalThis.__moonHarness`
(`camera()`, `sceneMode()`, `setMode`, `setLayer`, `setCamera`, `imageryCount()`,
and — added by Task 11 — `labelCount()`, `shownEntities()`, `refreshLabels()`,
`picked()`) for the verification harness only. As of the Task 10 fix round these
two globals are gated to `process.env.NODE_ENV === 'development'` (they are `undefined`
in a production bundle), so the sweep MUST run `npm run dev` — not a built
`next start` — for the hooks to exist. All toggles below went through the real UI path
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
`scene.mode` reaches the target, with a wall-clock fallback (`scene.completeMorph()`).
In the original build that fallback deadline was `2 × duration + 3 s = 4 s`; the Task 10
fix round raised it to `MORPH_DEADLINE_MS = 15 s` so a normal ~1 s morph in a visible tab
can never be cut into a jump-cut by a stalled first frame (see the owed section below). In
this in-app browser the page is *hidden* (`visibilityState: hidden`), Chrome suspends its
rAF loop and throttles its timers, so every toggle here completed via the fallback
(elapsed 4.0–8.7 s per morph, measured before the deadline raise). The **final state is
what the table above proves**; the smooth animated transition can only be judged in a
visible tab — see "OWED to Task 18" below.

### How a morph that did not animate is now reported (fix round 2, replaces an overclaim)

Round 1's text here said "a morph that never lands rejects so the UI surfaces it and can
retry". **That was an overclaim and is corrected.** As round 1 shipped, the rejection was
dead code: `waitForSceneMode` resolved either on destroy, on `scene.mode === target`, or
on the deadline — and the deadline branch called `completeMorph()` *first*, which puts the
scene in the target mode, so `settleMode` always found the target and the promise resolved
as plain success. A stalled morph therefore jump-cut and the UI reported an animated
change. Round 2 fixes the reporting and the retry path:

- `waitForSceneMode` no longer decides success; it returns **how it stopped**
  (`{ landed, forced, tornDown }`).
- `settleMode` re-reads the live scene mode and returns a `ModeChange`:
  `{ mode, applied, animated, forced }`.
  - jump-cut at the deadline → `{ applied: true, animated: false, forced: true }`. The mode
    really changed, so this is **not** an error; `MoonMap` shows a `role="status"` line —
    "Paper view is showing; the transition could not animate (no render frames), so it was
    completed instantly." Plain "success" is no longer claimed for a forced jump-cut.
  - the scene is verifiably *not* in the target mode even after the deadline's
    `completeMorph()` → `MorphIncompleteError` and `applied` never advances. This is
    option (b) of the review's F2: the stall is reported as `forced` (a status, not
    success), and the throw is kept only for a scene that genuinely never arrived.
    Two unit tests drive the real deadline pump with fake timers
    (`src/test/morph.test.ts` → "the deadline path is reachable through setMode and
    reported honestly"),
    one for the forced-but-applied outcome and one for the reject; run against
    round 1's `morph.ts` they fail (4 of 18), so they pin behaviour and not a mock.
    **Exactly how much of this is proven, and how much is not:**
    - *Proven by unit test:* `setMode` no longer converts a non-arrival into
      success. When the wait ends with the scene still out of the target mode it
      rejects instead of resolving — which is what made round 1's throw
      unreachable: the old wait always handed `settleMode` a scene that had already
      been forced into place.
    - *Reasoned from Cesium 1.146's source, never observed in a browser:* for the
      scene to still be wrong after the deadline, `scene.completeMorph()` has to
      fail to land it. `Scene.prototype.completeMorph` delegates to
      `SceneTransitioner.prototype.completeMorph`, which calls `_completeMorph`
      **only if it is defined** (`Build/CesiumUnminified/Cesium.js:252858`, and
      `Scene4.prototype.completeMorph` at `:266825`), and `_completeMorph` is
      installed by `createMorphHandler` only when `scene.completeMorphOnUserInput`
      is true (`:253079-253089`, default `true` at `:263726`; this app never sets
      it). With the flag off, `completeMorph()` is a permanent no-op and
      `SceneTransitioner.prototype.morphTo2D` then takes its early-return branch
      whenever the mode is still `MORPHING` (`:252863-252872`), so a frame-starved
      tab can never leave `MORPHING` — that is the configuration in which the
      reject fires. With the default configuration the completion callback assigns
      `scene._mode` directly (`complete2DCallback` `:253676`, `complete3DCallback`
      `:253644`), so a starved morph lands and reads back `forced: true`.
    - *Therefore, for Task 18:* in the shipped configuration a **reject is a bug
      report, not expected hidden-tab behaviour** — a hidden tab should show the
      `forced` status line. Do not "confirm" the reject path by flipping
      `completeMorphOnUserInput` and calling it verified; that only proves the
      unit-tested branch, and the animation itself still needs the visible-tab run
      below.
- On rejection (and on a viewer destroyed mid-morph) the mode latch
  (`src/lib/cesium/modeLatch.ts`) **rolls `requested` back to `applied`**, and the
  toggle is driven by the mode the scene was confirmed in — not by the last click.
  Round 1 left `requested` stranded on the failed mode, which deduped every later
  request for it: after one rejection neither Paper nor Globe could change the scene
  again until reload, while the toggle still showed the unreachable mode. The
  orchestration itself is no longer inline in the component: the effect calls
  `attemptMode`, so `src/test/modeLatch.test.ts` (10 tests) drives the production
  claim-await-commit/roll-back path directly, including the finding's proof — after
  a rejection the **next identical click dispatches a second morph** (the test
  asserts the morph was actually called with `['paper','globe','globe']`), while a
  click on the mode the scene is confirmed in stays a genuine no-op.

**Timeout note for the Task 18 sweep:** a frame-starved (hidden) tab only settles a morph
when `MORPH_DEADLINE_MS` fires, so **a single toggle can take up to ~15 s** (the raised
deadline; round 1's was 4 s). Any automated sweep must use a per-step timeout strictly
greater than 15 000 ms — 20 s or more per toggle — or it will report a false failure on
morphs that are merely settling via the fallback. In a *visible* tab the morph lands on its
own in ~1 s and the deadline is never reached.

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

Task 10 fix round: the singleton was deliberately left untouched (this round only added the
`MIN_H`/`MAX_H` height limits to moon.ts, which is a separate concern from `CREDIT`), so the
decision and the "no 'already associated' warning" observation stand. Re-check at Task 13.

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

## OWED to Task 18 — the morph ANIMATION was never observed landing on its own

Reviewer finding, recorded verbatim:

> Every recorded toggle finished via the `completeMorph()` fallback (4.0-8.7 s),
> never via `scene.mode === target`. End state proven; the animation is not, and a
> 4 s deadline against ~1 s of morph turns any stalled first frame into a
> jump-cut. Needs one visible-tab run.

**Status: OWED, not closed.** This fix round could not run a visible tab — browser
verification belongs to the controller, the in-app harness tab has a 0×0 viewport, and the
external tab cannot be scripted. No observation of the real animation was possible here,
so the smooth Paper↔Globe transition is **unproven**; do not describe it as working until
the steps below have actually been run and passed.

What this round changed in response (these make a natural landing *possible* and make a
non-landing loud; none of them OBSERVE the animation):
- `MORPH_DEADLINE_MS` (src/lib/cesium/morph.ts) raised from `2 × duration + 3 s = 4 s` to
  `max(15 s, (2·0.5 + 12) s) = 15 s`, so a normal ~1 s morph with a stalled first frame is
  never jump-cut in a visible tab; the `completeMorph()` fallback now only fires when the
  render loop is genuinely starved (a hidden tab). Cost: a starved toggle can now take up
  to ~15 s to settle — see the timeout note above.
- `setMode` resolves a `ModeChange`, so a jump-cut is reported as `forced: true` (and shown
  as a status) instead of as plain success, and `settleMode` only throws when the scene is
  verifiably not in the requested mode even after the forced completion. The wait can no
  longer mint a success, so the throw is no longer dead code sitting behind a resolved
  promise — see the reachability breakdown above for what *is* unit-proven and what is only
  reasoned from Cesium's source.
- `MoonMap` routes every mode request through `attemptMode` (src/lib/cesium/modeLatch.ts),
  which rolls the latch back on rejection *and* on a mid-morph teardown, and the toggle
  renders the mode the scene was confirmed in — so a failed switch is honest *and*
  retryable (round 1's stranded `requested` ref blocked every later mode change until
  reload).

Exact steps for a human in a VISIBLE browser tab:
1. Start the dev server: `npm run dev -- -p 3110` and open http://localhost:3110/ in a
   normal FOREGROUND window (not hidden / not headless). The harness globals are gated to
   `process.env.NODE_ENV === 'development'`, so this must be `dev`, not a built `start`.
   Allow up to 20 s per toggle before calling it a failure (see the timeout note above).
2. Paste the console snippet below, then click Paper and Globe by hand and WATCH the
   transition — it should animate over roughly a second, not snap.
3. Proof requires `usedFallback=false`, `landedOnItsOwn=true` and `forced=false` on every
   toggle. If `forced` is ever `true` in a *visible* tab, the morph did not land on its own
   and the jump-cut fired — that is exactly the still-open finding, so report it, do not
   sign off. (`forced`/`animated` come from the resolved `ModeChange`; the
   `completeMorph` monkey-patch is kept as an independent cross-check of the same fact.)

Console snippet (devtools of the visible tab):

```js
const v = globalThis.__moonViewer, s = v.scene;
const NAMES = ['MORPHING', 'COLUMBUS_VIEW', 'SCENE2D', 'SCENE3D'];
const origComplete = s.completeMorph.bind(s);
let usedFallback = false;
s.completeMorph = function (...a) { usedFallback = true; return origComplete(...a); };
for (const m of ['paper', 'globe', 'paper', 'globe']) {
  usedFallback = false;
  const t0 = performance.now();
  // setMode resolves a ModeChange: { mode, applied, animated, forced }.
  const out = await __moonHarness.setMode(m);
  const ok = out.applied && s.mode === (m === 'paper' ? 2 : 3);
  console.log(`morph ${m}: end=${NAMES[s.mode]} ms=${Math.round(performance.now() - t0)} ` +
    `usedFallback=${usedFallback} landedOnItsOwn=${ok && !out.forced} forced=${out.forced} ` +
    `applied=${out.applied}`);
}
```
Expected in a visible tab: `end=SCENE2D`/`SCENE3D`, `usedFallback=false` throughout,
`forced=false`, `landedOnItsOwn=true`, `ms` a little above ~1000 ms (the 0.5 s morph is two
tweens plus frame scheduling), and a visibly smooth animation. In a *hidden* tab expect
`forced=true` with the status line in the UI — that is the honest reporting, not a pass.

## Steps for the controller (close the visual check)

1. Open http://localhost:3110/ (server: `npm run dev -- -p 3110`; stop the PID you started
   afterwards) in a **visible** window and click Paper: the morph should animate in ~0.5 s
   and the map should be axis-aligned (north up, no tilt). Click Globe: tilt returns.
   Allow **more than 15 s per toggle** before calling it a failure — a frame-starved tab
   only settles at `MORPH_DEADLINE_MS` (see the timeout note above).
2. At the L5 home view over Mare Tranquillitatis, screenshot both modes.
3. Click Albedo ↔ Colour relief: the imagery should swap between greyscale albedo and
   colour relief with no double-layer ghosting.
4. Drag the map between toggles once, to confirm preservation with real input.
5. Read the two outcomes apart — they mean different things and the retry rule differs:
   - `forced=true` (the `role="status"` line): the mode **did** change, only the animation
     was jump-cut. The toggle must show that mode, and clicking it again is a **no-op by
     design** (the scene is already there) — that is not the round-1 bug. Reaching the
     *other* mode must still work.
   - the `role="alert"` panel (a rejection): the scene never left its previous mode. The
     toggle must have fallen back to the mode the scene really holds, and clicking the
     **same** mode again must dispatch a fresh morph and reach it (round 1 could not — the
     latch was stranded on the failed mode, which deduped every later request until reload).
   Check both against the live scene:
   `document.querySelector('.ctl-mode .on')?.textContent` must be `'Paper'` exactly when
   `__moonHarness.sceneMode()` is `'SCENE2D'`, and `'Globe'` exactly when it is `'SCENE3D'`
   — the selected button reports the mode the scene is actually in, never the last click.
   (`sceneMode()` returns Cesium's mode name, so it is never literally equal to the button
   label; the pair above is the check.)
