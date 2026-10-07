# Verify 14 — shareable URL state

**Task:** 14 of 18 (plan §Task 14). Format: `#lon/lat/height/mode/layer[/feature]`.

Status: **implemented and unit-verified, including the anti-loop proof. No browser
surface was driven by this run** — the in-app tab reports a 0×0 viewport and no
visible tab is scriptable — so **no interactive result is claimed here.** Every
check that needs a real tab is under *Owed to the Task 18 sweep* with steps and
console snippets.

## Commands and real output

| command | result |
|---|---|
| `npx vitest run` | **166 passed / 13 files** (was 139/12; +27 in `urlState.test.ts`) |
| `npx tsc --noEmit` | **exit 0, no diagnostics** |
| `npm run build` | **`✓ Compiled successfully in 4.8s`**, lint/type validity passed, 5 static pages, `/` = 1.28 kB + 104 kB First Load JS |

Pre-existing, unrelated to this task: the build prints Next.js's "additional
lockfiles detected / `outputFileTracingRoot`" notice (a workspace-root artifact of
this checkout). No new warning was introduced.

TDD order followed: `src/test/urlState.test.ts` was written first and run alone —
it failed with `Cannot find package '@/lib/urlState'` (module did not exist). The
implementation then produced **one genuine assertion failure, not a loosened one**:
`serialize(parse(serialize(v)))` at `height: 1234.56` returned `1500`, not `1235` —
because `serializeHash` does not clamp while `parseHash` does, and 1235 m is below
`MIN_H`. The precision test was moved to an in-range height and the out-of-range
behaviour is now pinned as its own case (`a height outside the controller limits
converges in one step`). Nothing was made fuzzy.

## What the tests prove (`src/test/urlState.test.ts`, 27 tests)

**Round trip / clamping / malformed input** — the five plan-verbatim cases pass as
written, plus:

| input | result | why it matters |
|---|---|---|
| `serializeHash` → `parseHash` of `{23.47312, 0.67461, 180000, globe, photo}` | exact `toEqual` | 5 dp lon/lat, whole metres |
| `#Mare Tranquillitatis` in the feature slot | name restored | percent-encoding, one segment |
| `''`, `'#'`, `'#x'`, `'#garbage/here'`, `'#NaN/0/0/globe/photo'` | `DEFAULT_VIEW` lon **and** height | total function, no throw |
| `#999/-999/1e30/globe/photo` | `lon 180`, `lat -89.9999`, `height 3.5e7` | clamps, never throws |
| `#0/0/1/globe/photo` | `height 1500` (`MIN_H`) | the clamp is the camera controller's own pair |
| `#0/0/globe/photo` (no height slot) | `height 2.2e7` | absent ≠ 0 m — 0 would put the camera on the surface |
| `#0/0/100000/mars/satellite`, `…/globe/satellite` | `globe`, `photo` | unknown mode/layer rejected; `probe` is not shareable |
| `#10/20/300000/globe/photo/%E0%A4%A` | `lon 10`, **no** feature, no throw | a lone truncated `%` escape cannot crash a reload |
| `Sinus Iridium/Rupes #7 50%` | 6 segments total, name intact | a `/` in a name must not shift the camera fields |
| `parseHash('')` identity | a **copy**, not `DEFAULT_VIEW` | mutating the result cannot poison the fallback |

**The anti-loop invariant** (`the anti-loop invariant` block):
`serializeHash(parseHash(s)) === s` for a full view including a feature, verified
twice in a row. This is the property the sync rests on: the value written reads
back as the value that was written, so the differ guard is silent on the next pass.
An out-of-range typed height costs **one** correction (`1235` → `1500`) and is then
a fixed point — convergence, not oscillation. `viewFromCamera` clamps before
writing, so the app itself never produces the un-clamped string.

**`createUrlSync`** (9 tests, against a fake document where a write is visible to
the next read — that visibility is what makes a loop possible):

- first tick writes; a second tick of the same view writes nothing (`writes === 0`
  when the document already holds the identical string);
- **4 Hz throttle** (`HASH_SYNC_MS === 250`): 20 ticks at ~120 Hz of a *moving*
  camera produce **1** write; the next write needs ≥ 250 ms;
- **hostile re-entrancy**: a `hashchange` handler wired directly into `write` that
  parses the new hash, applies it and flushes back — terminates at exactly
  **1 write**, hash equal to `serializeHash(view)`, with a depth-25 trap that would
  throw `feedback loop` if it recursed;
- `flush` bypasses the throttle (so a selection is shareable mid-fly-to) but keeps
  the guard — re-flushing the same view is a no-op;
- dropping the selection removes the feature segment entirely;
- `lastWritten()` distinguishes our own value from an external one (back/forward);
- after `stop()` no further writes (teardown can't write into a dead document).

**Also unit-proven, unchanged:** the morph-latch tests (10) and morph tests (18),
including `settleMode`'s rollback/reject contracts, and Task 11's label/declutter
tests (9 + 7). No existing assertion was weakened or deleted; the full suite went
139 → 166 passed.

## What the wiring does (read from the code, not run)

`src/components/MoonMap.tsx`:

- **Inbound, on mount** (no viewer yet — the manifest fetch is async):
  `wasEmptyHash(location.hash)` gates everything. Empty or malformed → HOME and the
  default mode/layer are kept. Otherwise the parsed view is stored in
  `pendingCameraRef`, `mode`/`layer` state is set (so the viewer is **built** in the
  shared mode rather than morphing into it a commit later), and a named feature goes
  to `pendingFeatureRef`. The viewer-creation effect applies the camera through
  `applyViewCamera` (nadir, north-up — a link carries no heading/pitch) and re-seeds
  the Task 13 readout, which otherwise starts at HOME.
- **Outbound:** one `postRender` listener → `sync.tick(currentUrlView())`.
  `currentUrlView()` = `getCameraState(viewer)` + `modeRef`/`layerRef` +
  `selectedRef.current?.properties.name`. `modeRef` mirrors **`sceneMode`** (the mode
  the scene is *confirmed* to be in), not `mode` (the last one clicked) — the same
  honesty rule Task 10 round 2 put on the toggle, so a shared link can never promise
  a mode the morph never reached.
- **Inbound again on `hashchange`:** ignored when the hash equals `lastWritten()`
  (our own value arriving via a traversal) or is empty/malformed; otherwise applied —
  camera, mode/layer state, and the feature card.
- **One source of truth for the selection**, as required: Task 12's search result and
  Task 11's click-to-pick both already funnel into `selectFeature`, so the feature
  segment is *projected from* that state (`selectedRef`) — the URL is never a second
  copy. `selectFeature` additionally `flush`es, so the hash names the feature before
  the 1.4 s `flyToFeature` finishes. An unknown name opens no card and is not an error.
- **Dev-only harness additions** (`NODE_ENV === 'development'`, same guard as the
  existing globals): `hash()` and `flushHash()`. `flushHash` exists because the
  outbound path is frame-driven and a frame-starved tab (this environment's 0×0
  viewport) never fires `postRender`; without it the sweep could not observe the
  camera → hash direction at all.

## Deviations from the plan (deliberate, documented)

1. **An empty hash publishes the live camera, not `serializeHash(DEFAULT_VIEW)`.**
   Step 3 literally says to write `DEFAULT_VIEW` when the hash yields nothing. Writing
   it while the screen shows HOME would put a string in the address bar that describes
   a view nobody is looking at, and the next throttled tick would contradict it. So:
   HOME stays the first-paint framing, and the sync's attach path writes what is
   actually on screen. `DEFAULT_VIEW` remains the *malformed/absent parse* fallback and
   the whole-disc link target (`#0/0/22000000/globe/photo` is tested exactly).
2. **`wasEmptyHash` decides "apply or not", not "is it the default view".** Comparing
   against `DEFAULT_VIEW` would make a hand-written `#0/0/22000000/globe/photo` look
   empty (it is serialised with 5 dp, and it is a valid request). The test used is
   "did a lon/lat parse", which is exactly "did this hash carry state of its own".
3. **Files beyond the plan's list:** `src/test/urlState.test.ts` is plan-listed; the
   extra surface (`createUrlSync`, `viewFromCamera`, `wasEmptyHash`, `HASH_SYNC_MS`)
   lives in `src/lib/urlState.ts` rather than inside `MoonMap` because **vitest runs in
   a `node` environment with no DOM and no new dependencies** — so the throttle, the
   differ guard and the loop proof are only testable as pure, dependency-injected units.
   The React file keeps the wiring, not the logic.
4. **`history.replaceState(null, '', hash)`** (no title, same-document) — never
   `pushState`: dragging the camera must not fill the back stack with thousands of
   entries. Traversal back to an earlier *document* state still reaches `hashchange`.
5. **Restoring from a URL does not `flyToFeature`.** The hash already carries the
   camera the link-maker was looking at; flying to the feature afterwards would
   overwrite it and re-write the hash. Only the card is opened.

## Not verified (honest list)

- That a copied URL **actually** reopens the same place, mode, layer and card in a
  second tab. The serialise/parse halves are unit-proven; `camera.setView`,
  `setModeState`/`setLayerState` and the effect ordering were never executed.
- That `postRender` fires often enough for the throttle to be felt, or that the
  address bar visibly updates while dragging.
- That `hashchange` → apply works in a browser (no `window` in the test environment;
  `createUrlSync` was driven against a fake document).
- That a percent-encoded name appears in the bar exactly as
  `...%2FMare%20Tranquillitatis` and reloads with the card open.
- That `replaceState` at 4 Hz does not thrash the browser's history/URL UI.
- SSR safety is reasoned, not observed: every `window`/`history` read is inside an
  effect or a dev-only harness closure, and `npm run build` prerenders `/`
  successfully (5/5 static pages) — which proves the server render does not throw,
  not that the client hydration is event-correct.
- **Interactions with other frame-driven work:** the URL sync adds a second
  `postRender` listener next to Task 11's label refresh and Task 13's readout
  (each with its own throttle). Both existing listeners and their 125 ms throttle
  are untouched, but no test covers "three postRender subscribers on a
  requestRenderMode viewer".

## Owed to the Task 18 sweep

Precondition: `npm run dev`, a **visible** tab with a real viewport (record `w × h`).
The dev globals (`__moonViewer`, `__moonHarness`, incl. the new `hash()`/`flushHash()`)
exist only in development.

1. **Round trip, the acceptance case in Step 4.** Fly somewhere, then:
   ```js
   __moonHarness.flushHash();               // force the write (no waiting for frames)
   const url = location.href;               // .../#-23.47312/-5.67461/129829/globe/photo
   ```
   Open `url` in a **new** tab. Expect: same centre (±1 m and ±1e-5°), same mode, same
   layer. Then compare against the camera:
   ```js
   ({ hash: __moonHarness.hash(), cam: __moonHarness.camera() });
   ```
   `cam.lonDeg.toFixed(5)` / `cam.latDeg.toFixed(5)` / `Math.round(cam.height)` must be
   the hash's first three fields.
2. **The canonical default URL.** Visit `/#0/0/22000000/globe/photo` directly:
   expect a whole-disc framing, no error overlay, `__moonHarness.camera().height ===
   22000000`.
3. **Malformed input renders the default view with no error.** Visit `/#nonsense`,
   `/#NaN/0/0/globe/photo`, `/#/`, `/#0/0/1e30/mars/satellite`, and
   `/#0/0/300000/globe/photo/%E0%A4%A`. Expect: the HOME framing (23.4731 / 0.6746 at
   ~259 659 m) for the first four, and for the last one the camera restored with **no
   card**; no React error overlay in any case; and afterwards
   `__moonHarness.flushHash()` must print a *valid* hash (the bad one is replaced, not
   propagated).
4. **Two-way, live.** Drag the globe and watch the address bar update at ≤ 4 Hz (not
   per frame — count the changes over a 2 s drag; expect ≲ 8):
   ```js
   let n = 0; const obs = new MutationObserver(() => n++);
   addEventListener('hashchange', () => n++);
   setTimeout(() => ({ writes: n }), 2000);
   ```
   Then prove **no loop** for real: hold the tab still and sample
   ```js
   const a = location.hash; await new Promise(r => setTimeout(r, 3000));
   ({ stable: a === location.hash });
   ```
   Expect `stable: true` (an oscillating sync would show a changing hash and a
   burning CPU).
5. **Mode and layer reach the URL.** `__moonHarness.setMode('paper')`, wait for
   `sceneMode` to confirm (poll `__moonHarness.sceneMode()` for `SCENE2D` — allow
   > 15 s in a starved tab, per `MORPH_DEADLINE_MS`), then `flushHash()` and check the
   4th/5th fields read `paper`. Repeat for `setLayer('paper')`. Confirm the hash does
   **not** claim `paper` mode while the latch is still reporting a failed morph: force
   that by clicking the toggle in a hidden tab and reading `__moonHarness.hash()`.
6. **Selection → hash → reload with the card open (the Step 4 case).** Search
   `Mare Tranquillitatis`, choose it, then:
   ```js
   __moonHarness.flushHash();    // mid-fly-to, deliberately
   location.hash;                // .../globe/photo/Mare%20Tranquillitatis
   __moonHarness.selected()?.properties.name;
   ```
   Reload that URL: expect the card open on `Mare Tranquillitatis` and the camera at
   the linked height (the link's camera wins over `flyToFeature` — deviation 5 above).
   Then click bare regolith next to a label: the card closes **and the feature segment
   disappears** from the hash.
7. **Back/forward.** Make 3 selections, press browser Back: expect `hashchange` to
   apply the older camera/mode/layer/card, and expect no immediate re-write that
   cancels the navigation (`__moonHarness.hash()` should stay on the older value).
8. **Keyboard + URL.** With `→` held down, the hash must track the camera; typing
   `apollo 11` in search must **not** move the camera (Task 13's assertion) and must
   not write a feature segment until a result is chosen.
9. **Screenshot** the address bar + map for: default link, paper-mode link, feature
   link, and a malformed URL that fell back. Four images belong in this file once a
   tab exists.
