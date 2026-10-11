# Deploying this app

Written 2026-10-09, when the project's **local-first** rule ("no tile server, no object
storage, no public deploy") was lifted for hosting. That rule still holds by default: an
unset `NEXT_PUBLIC_TILE_BASE_URL` means the app reads `/tiles` from its own origin, which
is what every checkout of this repository does, and nothing here changes that path.

What follows separates three things deliberately: what is **verified in this repo**, what
is **a command you run**, and what **cannot be verified without your credentials**.

## 1. What is in the repository, measured

| | files | bytes |
|---|---|---|
| tracked today (`git ls-files`) | 129 | 26,291,646 |
| — of which `tests/fixtures/moon_nomenclature_fixture.zip` | 1 | 23,845,070 |
| — the same, without that fixture | 128 | 2,446,576 |
| `.git` (object database) | — | 3,078,729 |
| `public/cesium` (gitignored, created by `npm install`) | — | 7,044,626 |
| `public/data` (tracked: features, regions) | 2 | 738,584 |
| `public/tiles` — base pyramid L0-L7, both layers | 87,380 | 2,819,245,403 |
| `public/tiles` — `ortho` L8-L10, 12 regions | 7,106 | 187,755,158 |

Re-measured 2026-10-09. The pyramids are gitignored by design (`.gitignore:50-51` keeps
only `public/tiles/manifest.json`). That is the whole deployment problem in one line:
**the repository without its one fixture is 2.4 MB and the imagery is 3.0 GB**, so the
imagery has to arrive some other way.

Per-file ceilings are not the issue, and the honest reason is the fixture: the largest
committed file is `tests/fixtures/moon_nomenclature_fixture.zip` at 23,845,070 B, which
clears Vercel's and GitHub's 100 MB per-file hard limit and GitHub's 50 MB advisory with
room to spare. It is committed on purpose — it is the input `scripts/labels.py` reads to
produce `public/data/features.json`, and keeping it means the label set is reproducible
with no network. In git it costs 1,133,823 B packed, not 23.8 MB: the gazetteer's DBF
payload is text and zlib takes it down ~21×, so `git clone` transfers ~3 MB, not 27.

The issue is history, not limits: a re-bake replaces 95,000 files, and git keeps every
one of them forever.

## 2. Two deployments that work today

**A. UI only, no imagery.** Deploy with `NEXT_PUBLIC_TILE_BASE_URL` unset. The app boots,
`probeAssets` gets 404s, and the existing "Imagery has not been baked yet" panel appears
naming the commands — the honest state, not a broken map. Deep zoom reports
"not on this machine" through the same mechanism. Good for reviewing chrome, labels,
search and the sidebar without shipping a single JPEG.

**B. Imagery from a store.** Set `NEXT_PUBLIC_TILE_BASE_URL` to an `https://` prefix that
serves the same layout the bake writes:

```
<base>/manifest.json
<base>/<layer>/<level>/<x>/<y>.jpg          # layer is paper | photo | ortho
```

Then sync the tree. These are the commands; **they are not run or verified here**, because
there are no credentials in this session — treat them as the shape of the step, not as a
tested recipe:

```bash
# S3-compatible (AWS S3, Cloudflare R2, Backblaze, MinIO…)
aws s3 sync public/tiles s3://<bucket>/tiles --exclude "*" --include "*.jpg" \
    --cache-control "public, max-age=31536000, immutable" --no-progress
aws s3 cp public/tiles/manifest.json s3://<bucket>/tiles/manifest.json \
    --cache-control "public, max-age=60"

# Vercel Blob (store `url` is the base you put in the env var)
npx @vercel/blob deploy public/tiles --access public
```

Then set, in the Vercel project (or `.env.local` for a local build):

```
NEXT_PUBLIC_TILE_BASE_URL=https://<your-store-prefix>/tiles
```

`vercel.json` is committed with the Next.js preset, the install/build commands, one region,
and immutable cache headers on `/tiles/*` for the case where tiles *are* served by the app
itself (deployment A plus a small committed subset).

## 3. Four things that will actually go wrong

1. **No `Access-Control-Allow-Origin` on the store.** Cesium loads imagery as images into
   WebGL textures. `Resource` marks a cross-origin tile request `crossOrigin` itself
   (`@cesium/engine/Source/Core/Resource.js:1017-1027`), which means without a CORS header
   the browser refuses the image — and the failure is **an empty globe, not an error
   panel**: `probeAssets` fetches the same URL, also fails, and the panel blames the bake.
   Verify with `curl -I` for an `Access-Control-Allow-Origin` line before blaming the app.
2. **The manifest needs the same header, and its absence looks different.**
   `manifestUrl()` is `${TILES_BASE}/manifest.json` (`src/lib/tileSource.ts:69`), so when
   the base points at a store the manifest comes from the store too — it is a plain
   `fetch` from a different origin, and a store that sends CORS on the JPEGs but not on
   the JSON fails before any imagery is asked for. The two failures are distinguishable,
   which is why both are listed: **no manifest → the "Imagery has not been baked yet"
   panel; manifest present, tiles refused → an empty globe.** The `aws` commands above
   `cp` the manifest separately precisely because it must be there, and the pyramid
   subset in §5 is useless without it.
3. **A `manifest.json` that describes tiles the store never got.** The app now samples two
   deep-zoom tiles per served level before it will attach the overlay (`orthoProbePaths` in
   `src/lib/cesium/ortho.ts`), and a miss turns the control off with "not on this
   machine". That is deliberate: it is the failure mode of a
   tracked manifest next to gitignored imagery, which is the state a fresh clone is in.
   It is a *presence* check, not an index: a half-synced store can still pass it, so sync
   the whole prefix or none of it.
4. **`http://` in the base.** Rejected at load, falls back to `/tiles`, and says so on the
   console. A store that only answers plain HTTP will look like the app ignored the
   setting. It did not; mixed content did.

## 4. Build-side notes, verified here

- `npm install` runs `scripts/postinstall_cesium.mjs`, which copies
  `node_modules/cesium/Build/Cesium/{Workers,Widgets,Assets,ThirdParty}` into
  `public/cesium`. It uses `node:path` and `cpSync` with no Windows-specific separators, so
  it runs on Vercel's Linux image. `MoonMap` sets `globalThis.CESIUM_BASE_URL = '/cesium'`
  at runtime, so the self-hosted assets stay same-origin and no Cesium ion request is made.
- Nothing in the build needs Python. `fetch`, `bake`, `bake:deep`, `bake:publish`, `labels`
  and `proof` are operator commands against the local venv; `npm run build` does not call
  any of them.
- `src/` contains no `http(s)://` string except an IAU link in a test, and three `fetch(`
  calls, all of which resolve through `src/lib/tileSource.ts`. So the one build-time
  network egress in the project is `next/font/google` in `src/app/layout.tsx`.
- **The production build is verified, and it needed fixing to get there.** `npm run build`
  compiled, linted and prerendered five static pages while the resulting app rendered a
  permanently empty page: one emitted chunk threw `SyntaxError: Octal escape sequences are
  not allowed in template strings` at parse time, so its dependents never loaded and React
  never hydrated. The cause is `@spz-loader/core`, a Cesium dependency that carries its WASM
  point-cloud decoder as a template literal of raw control bytes; re-emitting it during the
  client build turns a NUL into a `\0` escape followed by a digit. `next.config.mjs` aliases
  that module to `false` for the client build, which is safe here because no `.spz` point
  cloud is ever loaded — and it is the reason a Vercel deploy of any commit before
  `057884d` would have shown a blank page. `work/verify_production.mjs` is the check: it
  drives `next start` with no dev harness available, and asserts hydration, the gazetteer
  count, the area picker and 2,620 painted outline pixels.
- **`next dev` does not exercise any of this.** 498 unit tests and every browser probe passed
  against the dev server while the shipped bundle was dead, so a green `npm run test` is not
  evidence that a deployment works. Run `npm run build` and load the result before publishing.
- Verified in this repository as of writing: `npx tsc --noEmit` clean, `npx vitest run`
  (498 passed / 25 files), `npm run test` (vitest then the 358-test pytest suite), and
  `npm run build` + `next start` + the production probe above. `npm run build` has to be run
  with the dev server **stopped**: `next dev` and `next build` share `.next`, and building over
  a live dev server corrupts both (it produced `Cannot find module './897.js'` 500s and
  destroyed every CDP execution context for an hour of this session). That is a workflow
  trap, not a config problem, and `vercel.json` sets `buildCommand` explicitly so a
  Vercel build — which has no dev server — is unaffected.

## 5. If you would rather not run a store at all

Commit a subset instead of the whole pyramid. The levels are independent, so a small demo
pyramid is a file-selection job, not a re-bake:

| subset | files | bytes | what it buys |
|---|---|---|---|
| L0-L4, both layers | 1,364 | 71.2 MB | 666 m/px: recognisable maria, craters, all 1,585 names tiering normally |
| L0-L5, both layers | 5,460 | 252.6 MB | 333 m/px, and a repo most hosts will complain about |
| L0-L6, both layers | 21,844 | 865.8 MB | not advisable in git |

Deep zoom stays unavailable either way — 7,106 tiles and 188 MB is a lot of immutable
history for a feature that only appears inside twelve boxes. `bake:deep` regenerates it in
about nine minutes from the public COG whenever you want it locally.

## 6. Two decisions taken on 2026-10-09, recorded where they can be found

- **The deployment is public and indexable**, not access-restricted. That is a rights
  question as much as a configuration one: the pyramid is derived imagery from LROC/ASU,
  NASA SVS and JAXA/SELENE sources, and **nobody has verified that those bodies permit
  redistributing derived rasters.** `NOTICE.md` states what each upstream actually says
  (only the IAU gazetteer carries a written constraint: `Public domain.`) and what remains
  unchecked. The attribution the app renders — `CREDIT` for the two baked layers,
  `ORTHO_CREDIT` for the deep one — is the minimum that must survive any change here; it is
  asserted in code, imported rather than retyped, precisely so a deployment cannot lose it
  by editing a string in two places.
- **The code is MIT; the data is not licensed by it.** `LICENSE` says so at the bottom and
  `NOTICE.md` explains why: this repository cannot grant rights it does not hold.
