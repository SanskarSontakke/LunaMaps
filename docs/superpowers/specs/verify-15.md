# Task 15 verification — failure modes and the unbaked path

Date: 2026-10-07. Branch `feat/lunar-map-explorer`, commit "feat: honest failure
states for unbaked assets and boot errors".

## 1. What is proven here, and how

No browser tab is scriptable from this session: the in-app browser reports a
**0x0 viewport**, and an external tab cannot be driven. So the three real failure
paths are **not** claimed as observed in a browser — see §3, which is owed to the
Task 18 sweep.

What *is* proven is the boot order and the panels, with **injected failures**, in
`src/test/diagnostics.test.ts` (32 tests, node environment):

| Thing proven | How |
|---|---|
| `hasWebGL2()` is false with no `document` | direct assertion (node env has no DOM) |
| `classifyBootError` → `webgl` / `assets` / `cesiumBase` / `unknown`, including thrown non-`Error` values, and that it never invents a category | direct assertions on the exact strings `loadManifest` (src/lib/assets.ts) and Cesium 1.146 produce |
| `assetCommands` → full pipeline when the manifest is missing, `npm run bake -- --top 6 --layer both` when only tiles are missing | direct assertions; the flags were checked against `scripts/bake.py` `--top` / `--layer` (never executed) |
| `bootHint` per kind, including the `npm run postinstall` / `public/cesium/Workers/` fix | direct assertions |
| **Boot order routing**: WebGL absent → `ErrorPanel(webgl)` *without* fetching; `manifest.json HTTP 404` → `NoAssets(['tiles/manifest.json'])`; an *incompatible* manifest → `ErrorPanel(assets)` (not a bake instruction); probe failures → `NoAssets(those paths)`; a probe that returns junk → `ErrorPanel(probe)`; all ok → `ready` with the same manifest | `runBoot({ hasWebGL2, loadManifest, probeAssets })` with every dependency faked (src/lib/diagnostics.ts exports the order as a pure function for exactly this reason) |
| **The panels' actual text** | rendered with `react-dom/server` from the states `runBoot`/`bootFailure` returned: the missing paths, the command in a `<code>` block, the git-ignore sentence, `bootHint`, the raw message in a `<pre>` for `unknown`, and a "Try again" button on every one of them |
| **Per-tile failure capture is real** | `createTileErrorTally` counts exactly the events handed to it: 0 with none, 3 after three, newest-first, capped, `reset()` zeroing it. Nothing in the module can produce a count that did not come from `observe` |

`runBoot` resolves a state for *every* outcome, so a failed boot can never become
an unhandled rejection — asserted by the fact that each test above awaits it.

One config change was needed for the panel assertions: `vitest.config.ts` now sets
`oxc: { jsx: { runtime: 'automatic' } }`. `tsconfig.json` keeps `jsx: "preserve"`
(Next's own compiler is the production transformer and never reads vitest's
config); without the override, importing a `.tsx` component under vitest failed
import-analysis. No dependencies were added.

## 2. Boot order as wired in `src/components/MoonMap.tsx`

`hasWebGL2()` → `loadManifest()` → `probeAssets()` → `createMoonViewer()` →
`attachLabels()` → `attachPicking()`.

- Steps 1–3 run in `runBoot`; step 4 is the viewer effect (try/catch →
  `bootFailure('viewer', e)`); steps 5–6 are the attach effect.
- Every step renders something. `booting` shows "Loading baked lunar imagery…",
  `assets` shows `NoAssets`, `error` shows `ErrorPanel`, and steps 5–6 show a
  retryable banner **over a map that is already drawing** (hiding a working map
  behind a full-screen panel would be its own failure).
- `Attribution` stays outside the panels, so provenance survives every failure.
- SSR/first paint: the WebGL answer is unknown (`webgl === null`) so the server
  and client both render the loading note — no hydration mismatch, and no panel
  is claimed for a browser we have not looked at.

### Retryability (the Task 10 latch rule)

Nothing latches:

- `bootNonce` is a dependency of the boot effect; `Try again` bumps it, and the
  effect **clears the failure state first** (`setBoot({ phase: 'booting' })`)
  before re-running the probe. A repeat click is never swallowed as a no-op.
- A failed `createMoonViewer` leaves `viewerRef.current === null`, so the next
  attempt can build; the effect's deps include `bootNonce` for the case where the
  retry yields an identical manifest.
- The tile tally is `reset()` at the start of each attempt, so a new boot inherits
  no old count.
- Labels/picking publish `labelsRef.current` **only after `attachLabels` and the
  first `refresh` both succeed**; on failure the partial attach is destroyed and
  the ref stays null, so `attachNonce` can re-enter. (The order this replaces —
  publishing before `refresh` — is precisely how Task 10 round 1 made a failed
  morph unretryable until reload.)
- `modeLatch`/`attemptMode` and the declutter tests were not touched: `modeLatch`
  (10 tests) and `declutter` (9 tests) still pass unchanged.

## 3. OWED to the Task 18 browser sweep — the three real paths

Not executed in this task, deliberately: Tier A is 21,844 git-ignored baked tiles
(~3 hours of baking). **Nothing below was run here.** The controller must run it.
Record the actual console/network output; where the expected panel text does not
appear, say so rather than marking it passing.

### 3.1 Tiles absent → `NoAssets`

```bash
find public/tiles -type f | wc -l        # record BEFORE (expect 21,845 incl. manifest.json)
mv public/tiles ../tiles-backup-15
npm run dev                              # http://localhost:3000
# ... read the panel, screenshot it, then ALWAYS restore:
mv ../tiles-backup-15 public/tiles
find public/tiles -type f | wc -l        # MUST equal the BEFORE number
```

Expected panel: title "Imagery has not been baked yet"; the missing list containing
`public/tiles/manifest.json`; the command block `npm run fetch && npm run bake &&
npm run labels`; the sentence that `public/tiles/` is git-ignored so a fresh clone
must bake; a "Try again" button. No uncaught console error — the `manifest.json`
404 appears in the network log, which is the point, not a failure. After the
restore, clicking "Try again" (no reload) must bring up the map: that is the live
proof of retryability.

### 3.2 `public/cesium` missing → `ErrorPanel` (`cesiumBase`)

```bash
mv public/cesium ../cesium-backup-15
npm run dev
mv ../cesium-backup-15 public/cesium     # or just re-run: npm run postinstall
```

Expected: title "The map failed to start (creating the Cesium viewer)", hint "The
Cesium static assets were not copied. Run npm run postinstall and confirm
public/cesium/Workers/ exists.", the raw error in a collapsible `<details>`, and
"Try again". Note the manifest and the tile probe do **not** depend on
`public/cesium`, so this path reaches step 4 — that is why the step is `viewer`.
**Uncertainty to resolve in the sweep, not here:** if Cesium surfaces the missing
`Workers/`/`Assets/` fetch *asynchronously* instead of throwing from the `Viewer`
constructor, the panel will not appear and the console will hold the 404s. Record
which happens; the classification itself (`Workers/…`, `Assets/…`,
`approximateTerrainHeights` → `cesiumBase`) is unit-proven, the surfacing point is
not.

### 3.3 WebGL unavailable → `ErrorPanel` (`webgl`)

```bash
# baseline, in the page console: hasWebGL2() is exposed via the boot only; check as
# document.createElement('canvas').getContext('webgl2') !== null   -> expect true
# then block 3D APIs (chrome://flags/#disable-3d-apis, or):
"C:\Program Files\Google\Chrome\Application\chrome.exe" --disable-3d-apis http://localhost:3000
```

Expected: title "This browser cannot run the map", hint "This app needs WebGL2.
Your browser or GPU did not provide it.", message "WebGL2 context is not available
in this browser.", no canvas, no blank screen — and nothing fetched (step 1 gates
the rest). If `--disable-3d-apis` is unavailable in the installed Chrome, say that
WebGL was **not** forced off rather than claiming it was tested (the plan allows no
other outcome than an honest note).

### 3.4 Tile-failure counter, dev only

`__moonHarness.tileErrors()` must report `0` after a healthy Tier A browse
(globe → paper → zoom to L6 → back). Any number above 0 must be cross-checked
against the network log, since every increment corresponds to one real
`ImageryLayer.errorEvent`. Inducing non-zero counts **is not** part of this sweep:
the only way to make a Tier A tile 404 is to move or delete a baked file, which
this task forbids. The counter's arithmetic is unit-proven instead; the browser
half that is owed here is only "it reads 0 when nothing failed".

## 4. Suites

vitest 15 files / 209 tests passed (was 177 + 32 new diagnostics tests, 0 removed,
0 weakened); pytest 168 passed; `npx tsc --noEmit` clean; `npm run build` compiled
statically. Pre-existing build warning, untouched and out of Task 15's scope: Next
reports an inferred monorepo-style tracing root plus an "additional lockfile"
(`package-lock.json`), silenced only by setting `outputFileTracingRoot` in
`next.config.mjs`.
