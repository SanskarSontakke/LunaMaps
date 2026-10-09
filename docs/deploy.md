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
| tracked today (`git ls-files`) | 119 | largest is `tests/fixtures/moon_nomenclature_fixture.zip` at 23,845,070 B |
| `.git` | — | 3.4 MB |
| `public/cesium` (gitignored, created by `npm install`) | — | 7.6 MB |
| `public/data` (tracked: features, regions) | 2 | 716 KB |
| `public/tiles` — base pyramid L0-L7, both layers | 87,380 | 2,819,245,403 |
| `public/tiles` — `ortho` L8-L10, 12 regions | 7,106 | 187,755,158 |

The pyramids are gitignored by design (`.gitignore:44-47` keeps only
`public/tiles/manifest.json`). That is the whole deployment problem in one line: **the app
is 8 MB and the imagery is 3.0 GB**, so the imagery has to arrive some other way.

Vercel's own ceilings are not the issue — the largest single file in the tree is about
100 KB against a 100 MB per-file limit. The issue is repository and history size: a
re-bake replaces 95,000 files, and git keeps every one of them forever.

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

## 3. Three things that will actually go wrong

1. **No `Access-Control-Allow-Origin` on the store.** Cesium loads imagery as images into
   WebGL textures. `Resource` marks a cross-origin tile request `crossOrigin` itself
   (`@cesium/engine/Source/Core/Resource.js:1017-1027`), which means without a CORS header
   the browser refuses the image — and the failure is **an empty globe, not an error
   panel**: `probeAssets` fetches the same URL, also fails, and the panel blames the bake.
   Verify with `curl -I` for an `Access-Control-Allow-Origin` line before blaming the app.
2. **A `manifest.json` that describes tiles the store never got.** The app now samples two
   deep-zoom tiles per served level before it will attach the overlay (`orthoProbePaths` in
   `src/lib/cesium/ortho.ts`), and a miss turns the control off with "not on this
   machine". That is deliberate: it is the failure mode of a
   tracked manifest next to gitignored imagery, which is the state a fresh clone is in.
   It is a *presence* check, not an index: a half-synced store can still pass it, so sync
   the whole prefix or none of it.
3. **`http://` in the base.** Rejected at load, falls back to `/tiles`, and says so on the
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
- Verified in this repository as of writing: `npx tsc --noEmit` clean, `npx vitest run`,
  and `npm run test` (vitest then the pytest suite). `npm run build` has to be run with
  the dev server **stopped**: `next dev` and `next build` share `.next`, and building over
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
