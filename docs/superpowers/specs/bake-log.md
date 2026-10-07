# Bake log — Task 7 (synthetic pyramid) and Task 8 (Tier A real bake)

Run 2026-10-07 (IST) on Windows / Git Bash, branch `feat/lunar-map-explorer`.
Python `.venv` (rasterio 1.5.2 / GDAL 3.12.2, numpy 2.5.3, Pillow), Node 24 /
npm 11. Every number below is pasted from a command that was actually run in
this session; where a brief's expectation was wrong, the measured value replaces
it and the expectation is quoted next to it.

Free disk before the bake (`df -h .`):

```
Filesystem      Size  Used Avail Use% Mounted on
C:              466G  289G  178G  62% /c
```

`C:` is a Samsung SSD 980 PRO 500 GB (`Get-PhysicalDisk` → `MediaType SSD`), so
nothing below is explained by a slow disk. Total physical RAM 15.8 GiB, ~8.1 GB
free at the start of the Tier A run.

## 0. What had to land first (Task 6 follow-ups)

Both rulings are recorded with their measurements in
[`fetch-log.md`](fetch-log.md) §8. Summary: re-hashing the 3,042,272,356 B of
sources costs **2.48 s**, so it is the default again (`--verify` deleted,
`--skip-verify` added, a digest that moves now stops the run); and because
`pxPerDeg` is canonical, Stage 0 had stopped looking at the file's own declared
pixel size, so `assert_contract` now checks it within
`DECLARED_PX_PER_DEG_TOL_PX = 0.1` px. Stage 0 re-run against the real files:

```
detail  pxPerDeg 303.23333333333335  pxPerDegDeclared 303.23337750432864
        declared-vs-canonical drift: -0.015902 px   tol 0.1   -> passes
color   pxPerDeg 76.0  pxPerDegDeclared null (no GeoTIFF keys) -> not checked
STAGE 0 OK
```

## 1. Task 7 — the pyramid proved on synthetic data

`scripts/tests/test_bake_synthetic.py` was written first and run:

```
scripts\tests\test_bake_synthetic.py:13: in <module>
    import derive
E   ModuleNotFoundError: No module named 'derive'
```

(The brief predicted `No module named 'bake'`; the module-level `import derive`
on line 13 fails first. Same RED class: the pipeline does not exist yet.)

After `manifest.py`, `derive.py` and `bake.py` landed:

```
$ .venv/Scripts/python.exe -m pytest scripts/tests/test_bake_synthetic.py -q -W error
8 passed in 1.92s
$ npm run test        # vitest + whole pytest suite
Tests  7 passed (7)
106 passed in 2.87s
$ npx tsc --noEmit    # clean
```

The brief's Step 5 says "Expected: 8 passed" but its own code block contains
**seven** test functions. The eighth is `test_the_band_blur_is_periodic_across_a_step_at_the_seam`,
added because the brief's seam fixture cannot discriminate the thing the test
name claims. Measured (`work/wrap_probe.py`, L1 photo tiles, red channel):

| fixture | assertion | `wrap_x=True` | `wrap_x=False` |
|---|---|---|---|
| brief's 256 px dark band *around* ±180 | `left[:, -8:]` vs `right[:, :8]` | 170 vs 170 (Δ 0) | 170 vs 170 (Δ 0) |
| step exactly *at* ±180 (new test) | seam edge vs flat interior | **+46 / −67** | **0 / 0** |

A band of dark pixels that is wider than the 8 px kernel is equally dark whether
the blur wraps or not, so the brief's assertion scores identically under both
boundary conditions — it proves continuity, not periodicity. It is kept
unchanged; the new test is what pins the wrap, and it is the one referenced from
spec §3.1 Stage 2.

## 2. Task 8 Step 1 — dry run and the smoke pyramid

```
$ npm run bake -- --dry-run
top=L6 (166.6 m/px) layers=['paper', 'photo']
planned files=21,844 bytes~=0.68 GB disk free=190.4 GB
  LRO_WAC_Mosaic_Global_303ppd_v3.jp2: OK 109164x54582 303.2333 px/deg from raster
  lroc_color_poles.tif: OK 27360x13680 76.0000 px/deg from assigned
dry run: nothing written
```

Both grid contracts `OK`, nothing written, exit 0. `m_per_px(6)` is
**166.57113880453207** → 166.57 rounded, so the manifest's L6 row reads 166.57
and the plan's commit message "(166.5 m/px)" is a truncation of the same number.

```
$ time npm run bake -- --top 2 --layer both --band-rows 512 --force
top=L2 (2665.1 m/px) layers=['paper', 'photo']
planned files=84 bytes~=0.00 GB disk free=190.4 GB
paper: 32 tiles at level 2
paper: 10 parent tiles derived L1..L0
photo: 32 tiles at level 2
photo: 10 parent tiles derived L1..L0
baked 84 tiles in 2280.1s -> public\tiles

real	38m0.946s
```

Tile counts are exactly as expected: **42 per layer** (2 + 8 + 32), 84 total,
`find public/tiles/paper public/tiles/photo -name '*.jpg' | wc -l` → 84.

| layer | tiles | bytes on disk |
|---|---|---|
| paper | 42 | 3,336,520 |
| photo | 42 | 3,509,740 |

Per level, photo (measured before the Tier A `--force` deleted the tree):
L0 2 tiles / 150,942 B, L1 8 / 678,857 B, L2 32 / 2,679,941 B. Paper's per-level
split was **not captured** — the Tier A run removes `public/tiles/paper` before
it is enumerated; only the layer total above survives.

**The brief's "a couple of minutes" is wrong, and here is why.** 38 minutes for
84 tiles. `bake.read_world_rows` asks GDAL for a full-width window with an
`out_shape`, and the detail source's block geometry defeats it:

```
$ .venv/Scripts/python.exe -c "…ds.overviews(1), ds.block_shapes…"
overviews: [2]   block shapes: [(54582, 20000)]   tiled: True
```

GDAL's smallest addressable unit in `LRO_WAC_Mosaic_Global_303ppd_v3.jp2` is
**54,582 rows × 20,000 columns** — the full image height. Any band read, however
short, therefore decodes the whole 5.96 GPix codestream:

| measurement (single-threaded, SSD, no other load) | value |
|---|---|
| 1:1 full-width read of 1,706 source rows (178 MB out) | 85.0 s = **2.2 MPix/s** |
| same window resampled to one L6 band `(1024, 65536)` with `average` | 156–177 s |
| same window with `bilinear` instead of `average` | 155.9 s |
| same window with **integer** row offsets instead of fractional | 156.0 s |
| one L6 colour band `(1040, 65536, 3)` from the 518 MB TIFF | 0.9 s |
| `chroma_detail` on one L6 band (1040 × 65536 × 3) | 7.7 s |

So the cost is the JP2 decode, not the resampling and not the window alignment —
which is exactly what spec §3.1 Stage 1 (block-tiled GDAL working copies with
internal overviews) existed to prevent, and which amendment A removed. See §5
for what that means for Task 17.

## 3. Task 8 Step 2 — inspecting the smoke pyramid

**No browser screenshot was taken, and none was possible.** The in-app page is
not a visible surface: `take_screenshot` returned

```
NATIVE_BROWSER_VIEWPORT_UNAVAILABLE: In-app Browser did not provide a visible
surface with a positive viewport within 1000ms (operation=screenshot,
viewport=0x0, visible=true, attached=true, cdpAttached=true,
visibilityState=hidden).
```

after navigating `http://localhost:3100` with `MoonMap.tsx` temporarily pointed
at `{ layer: 'photo', top: 2, mode: 'globe' }` (and then `mode: 'paper'`). The
same limitation gate G1 documents in "What could not be done". `evaluate_script`
*does* run in this tab, so the live viewer was read numerically, and the visual
criteria were checked against the tiles themselves. That is a substitute, not
the check the brief asked for, and it is recorded as such.

**Live viewer, in-page (photo L2, globe mode):**

```
maxLevel=2 | tileWidth=512 | tilingScheme=GeographicTilingScheme
L2 grid = 8 x 4 | tileXYToRectangle(0,0,1).north = 90.000 deg
mode=3 (SCENE3D) | camera = lat 0.00, lon 0.00, h 3,297,199 m
paper mode re-check: mode=2 (SCENE2D) | enableTilt=false | maxLevel=2
console: 1 message, the React DevTools info banner — zero errors, zero warnings
```

`row0northDeg = 90.000` is the same y-origin G1 proved, now read through the
real provider. The canvas is 0×0 in a hidden tab and Cesium never composites a
frame, so `tilesLoaded` and pixel reads are meaningless here — after an explicit
`viewer.resize()` + `render()` the 900×700 canvas still sampled back **1 distinct
colour**, and the browser's request list for the page contains no tile requests
at all. Nothing about the imagery can be read off this tab.

**Substitute 1 — every URL the provider builds, over HTTP:**

```
$ for each of /tiles/{photo,paper}/{0,1,2}/{x}/{y}.jpg on localhost:3100
200 OK: 84   non-200: 0
photo L2 3/1 content-type=image/jpeg bytes=45173 status=200
```

**Substitute 2 — the tiles against the source, not against a render**
(`work/smoke_source_check.py`, L2, paper layer, which is the raw detail band with
no composite in it):

| check | tile | source box | verdict |
|---|---|---|---|
| row 0 is north | `paper/2/0/0` mean **63.44** | source rows 0–13,646 = lat +90…+45, mean **62.91** | Δ 0.52 |
| last row is south | `paper/2/0/3` mean **48.49** | source rows 40,936–54,582 = lat −45…−90, mean **47.99** | Δ 0.50 |

A vertically flipped bake would have scored these two the other way round. This
is a stronger orientation proof than a screenshot, because it compares against
the file the bake read rather than against someone's reading of a picture.

**Substitute 3 — the antimeridian, against the distribution of internal edges**
(paper mosaic, 32 px each side of every column boundary):

```
internal edge steps: [0.49, 0.34, 0.21, 1.52, 0.35, 7.04, 1.76]
median internal 0.49   max internal 7.04   antimeridian seam step 4.19
photo antimeridian seam step 0.23 (its internal reference edge: 1.10)
```

The seam step in the paper layer is smaller than the largest ordinary internal
edge step (7.04 at the lon +45 boundary), so it is terrain, not a wrap artefact;
and the photo layer — the one with the periodic blur — steps **0.23** across the
seam, less than an ordinary internal edge. No streak.

**Substitute 4 — poles and hemispheres** (mosaic means):

```
photo  latitude band means (90→45, 45→0, 0→−45, −45→−90): 164.3, 138.9, 144.1, 161.7
paper  same:                                              65.5,  64.5,  66.2,  63.1
photo  near side (lon 0) 151.6   far side (lon ±180) 160.2   whole 152.2
photo  darkest 128 px block centre: lon −50.6 lat  +5.6  mean  73.4
photo  brightest 128 px block centre: lon +95.6 lat +61.9 mean 196.3
paper  polar rows: north 17.5  south 25.4   (the source's own polar darkening:
       Task 6 measured the JP2's north-west 64×64 window as 0..77)
```

The northern near-side band is darker than the southern one (138.9 vs 144.1),
which is what the maria distribution actually looks like; a flipped bake inverts
it. The polar rows are dark in `paper` because the source is dark there — the
tile-vs-source match above is what shows the bake inherited that rather than
clamping it.

**Substitute 5 — the pictures.** `work/smoke_mosaic.py` stitched the L2 tiles
into equirectangular mosaics in the order Cesium addresses them (`work/smoke/`
mosaic-*.png at 4096×2048, view-*.png at 1365×682) and those were looked at
directly. What is visible in both layers: the Oceanus Procellarum / Imbrium /
Serenitatis complex as one dark mass spanning roughly lon −82…+20 centred
north of the equator; Mare Crisium as a detached round dark patch near lon +55;
Mare Orientale's multi-ring structure near lon −90, south of the equator; a
bright ray crater below the equator at about lon −11, lat −43 (**Tycho** — its
rays being in the *southern* hemisphere is the orientation check in plain
sight); crusty, mare-free farside highlands across the right third and the left
edge with no band or streak at the join; and polar terrain that thins out
normally at the top and bottom rather than notching to black. Colour is present
but subtle (the SVS base is a low-saturation product and the photo layer's
chroma comes from a 76 px/deg base), which is what spec §7 says to expect.

Verdict on the four criteria: **not upside down, no seam streak, no polar notch,
maria and highlands where they belong** — established as above, with the
browser-render caveat stated. `MoonMap.tsx` was reverted to the committed
`{ layer: 'probe', top: 1, mode: 'globe' }` afterwards.

## 4. Task 8 Step 3 — Tier A

Completed 2026-10-07 in a second session; §0–§3 above are the first session's
record and are unchanged. Free disk on arrival (`df -h .`, 08:52):

```
Filesystem      Size  Used Avail Use% Mounted on
C:              466G  297G  169G  64% /c
```

169 GB free, ~19× the 8 GB floor, so the bake was allowed to proceed.

### 4.0 The bake had not been interrupted, and the resume-vs-restart ruling

The handoff described an interrupted run holding 2,048 of 8,192 `paper` L6
tiles. Measured at 08:52: **2,304**, and rising. `Get-CimInstance Win32_Process`:

```
ProcessId 25840  .venv\Scripts\python.exe   scripts/bake.py --top 6 --layer both --band-rows 1024 --force   created 07-10-2026 08:27:25
ProcessId 23808  Python312\python.exe       scripts/bake.py --top 6 --layer both --band-rows 1024 --force   created 07-10-2026 08:27:25, RSS 1.9 GB -> 4.1 GB
```

The bake was **still running**: the newest tile was `paper/6/127/17.jpg` stamped
08:51:22, sixty seconds before I looked. So "resume the leftovers or wipe them"
never arose in the form the handoff assumed — the leftovers were the live run's
own output, mid-flight. The ruling, with the reasoning the brief asks for
anyway, since it is what a future interrupted bake will need:

1. **`--force` had already wiped that layer.** `run()` does
   `if force and (out / layer).exists(): shutil.rmtree(out / layer)`
   (`scripts/bake.py:117-119`) before baking each layer, so `public/tiles/paper`
   was deleted at 08:27:25. Every `paper` tile on disk was written by *this*
   process. There was no older-code tile in the tree to be incompatible with.
2. **Provenance pinned, not assumed.** `scripts/bake.py` has mtime 07:12:07,
   commit `62a9634` is dated 07:15:35, the process started 08:27:25, and
   `git status` shows `scripts/` clean — so the interpreter loaded exactly the
   committed code, with `--band-rows 1024` from the command line and every other
   parameter at the committed default (`--quality 85`, `--detail-gain 0.4`,
   `sigma=2.5`, `radius=8` are `main()`/`bake_top()` defaults, not flags the run
   passed).
3. **Structural check of the in-flight tiles.** 380 sampled across rows 0..19:
   all `(512, 512)`, all mode `L`, zero decode failures.
4. **The decisive question — can `derive_levels` build correct parents from a
   partly written top level?** It cannot build *any* parents: `derive.py:41`
   reads all four children unconditionally, so a missing child raises
   `FileNotFoundError` and the run dies loudly. A subtly mixed pyramid could
   therefore not have been hidden in soft parents. In this run `derive_levels`
   executed only after `bake_top` returned, i.e. with all 8,192 children present.
5. **Decision: let the in-flight `--force` run finish.** It is the strictly
   safer of the brief's two options — a full restart already under way, which
   guarantees one process, one code revision and one parameter set for all
   21,844 tiles. Starting anything else was actively harmful: a second bake
   would have raced it on the same tree, and the brief's Step 1/2 `--force`
   smoke command would have `rmtree`'d the ~2,300 tiles already decoded. The
   smoke set was therefore **copied aside** first
   (`work/smoke-l2-preserved/`, 42 tiles) precisely because `run()` was going to
   delete it when it reached `photo` — which it did, at ~09:56.

Polling timeline (tile counts, `find … | wc -l`), which is also the band-rate
evidence in §4.1:

| time | paper | photo | note |
|---|---|---|---|
| 08:52 | 2,304 | 42 | live run, paper rows 0..17 |
| 09:00 | 3,072 | 42 | 12/32 bands |
| 09:50 | 7,936 | 42 | 31/32 bands |
| 10:00 | **10,922** | 512 | paper done + derived; photo layer started |
| 10:30 | 10,922 | 3,328 | 13/32 bands |
| 11:00 | 10,922 | 5,888 | 23/32 bands |
| 11:25 | 10,922 | **10,922** | manifest rewritten |

**Monitoring caveat — a false `BAKE PROCESS GONE`.** The waiter that polled for
this run logged `BAKE PROCESS GONE at 08:59:24` (`work/bake-waiter.log`), but the
bake was alive throughout: the timeline above has `paper` at 2,304 and rising at
08:52, and the process table below lists both interpreters. The waiter's own
query failed first — `work/bake-waiter.log` opens with a PowerShell
`TerminatorExpectedAtEndOfString` parser error, after which its process lookup
returned nothing and the script read that empty result as "gone". The lesson for
a future interrupted bake: a waiter's "gone" verdict is only as trustworthy as
its last *successful* query, so never conclude the bake died from the waiter
alone — corroborate against tile-count growth between polls, which is exactly
what §4.0 did before deciding to let the run finish rather than restart it.

### 4.1 Wall clock

**Provenance of this transcript.** This block is the delivered bake's own stdout,
copied verbatim from `work/smoke/tierA.log`. This session did **not** execute the
`time npm run bake` command itself: the `--force` bake had been launched in the
earlier session and was still running on arrival (§4.0), and what this session
observed was that process completing and writing its log. The `$ time …` prompt
line and the `real` line are therefore reproduced from `work/smoke/tierA.log`,
not re-measured here; the bake cannot be re-run to regenerate them (the sources
would be re-decoded for three hours), so the block is marked as copied rather
than passed off as a fresh invocation. The duration reconciliation below is
anchored to `generatedAt`, which the *same* completed run wrote into
`manifest.json`.

```
$ time npm run bake -- --top 6 --layer both --band-rows 1024 --force
top=L6 (166.6 m/px) layers=['paper', 'photo']
planned files=21,844 bytes~=0.68 GB disk free=186.6 GB
paper: 8192 tiles at level 6
paper: 2730 parent tiles derived L5..L0
photo: 8192 tiles at level 6
photo: 2730 parent tiles derived L5..L0
baked 21844 tiles in 10680.5s -> public\tiles

real	178m3.232s
```

**2 h 58 m 03 s** headline, taken from `real 178m3.232s` = 2 h 58 m 03.2 s. Three
independent records of the same duration, agreeing to a few seconds: `real
178m3.232s` = 2 h 58 m 03.2 s (the `time` wrapper around npm + interpreter +
bake); `timings.bakeSeconds = 10680.5` s = 2 h 58 m 00.5 s (the process's own
wall clock, which excludes startup so it reads a hair under `real`); and the
process created 08:27:25 → the manifest stamped `generatedAt =
2026-10-07T05:55:25+00:00` = 11:25:25 IST, a span of 2 h 58 m 00 s. (An earlier
draft of this line read the stamp as `11:25:35` and the span as 2 h 58 m 10 s —
a ~10 s overstatement; the committed `generatedAt` is at `:25`, so the third
record is 2 h 58 m 00 s, and the ~3 s gap to `real` is startup, not run time.
The 2 h 58 m 03 s headline stands.)

Band arithmetic: L6 world height is 32,768 px, so `--band-rows 1024` is 32 bands
per layer, each 2 tile rows = 256 tiles. Observed rates: paper 150–195 s/band,
photo 150–200 s/band. That reproduces §2's diagnosis rather than contradicting
it. The L2 smoke bake cost 2,280 s for 8 bands (4 per layer, since L2's world
height is 2,048 px and it ran with `--band-rows 512`) = **285 s/band**, *more*
per band than Tier A: the same full-codestream JP2 decode is paid each time, and
the fixed setup is amortised over far fewer, shorter bands. The cost is the
decode per band, not the resample, which is why 84 tiles took 38 minutes.

### 4.2 Counts — exact

| L | expected | paper | photo |
|---|---|---|---|
| 0 | 2 | 2 | 2 |
| 1 | 8 | 8 | 8 |
| 2 | 32 | 32 | 32 |
| 3 | 128 | 128 | 128 |
| 4 | 512 | 512 | 512 |
| 5 | 2,048 | 2,048 | 2,048 |
| 6 | 8,192 | 8,192 | 8,192 |
| **total** | **10,922** | **10,922** | **10,922** |

`find public/tiles/paper public/tiles/photo -name '*.jpg' | wc -l` → **21,844**,
and the manifest records `layers.paper.tiles == 10922` and the same for `photo`.
No stray non-JPEG files in either tree.

**Deviation from the brief's literal command:** `find public/tiles -name '*.jpg'
| wc -l` prints **21,854**, not 21,844. The extra 10 are `public/tiles/probe/`,
the synthetic Gate G1 probe tiles from Task 2, which sit in the same parent
directory. They are git-ignored and are not part of the bake; the two baked
layers are exactly 2 × 10,922. The scoped command above is the one to use.

### 4.3 Measured bytes

| layer | tiles | bytes | bytes/tile | bits/px |
|---|---|---|---|---|
| paper | 10,922 | 472,094,745 | 43,224 | 1.3191 |
| photo | 10,922 | 455,311,811 | 41,688 | 1.2722 |
| **both** | **21,844** | **927,406,556** | 42,456 | 1.2957 |

`du -sb` agrees with the manifest byte sums to the byte (472,094,745 /
455,311,811); `du -sh` reports 474M / 458M because it counts NTFS allocation
units, not file lengths.

Per level, bytes/tile and bits/px:

| L | paper tiles | paper bytes | B/tile | bits/px | photo tiles | photo bytes | B/tile | bits/px |
|---|---|---|---|---|---|---|---|---|
| 0 | 2 | 164,203 | 82,102 | 2.506 | 2 | 96,309 | 48,154 | 1.470 |
| 1 | 8 | 662,536 | 82,817 | 2.527 | 8 | 374,036 | 46,754 | 1.427 |
| 2 | 32 | 2,516,933 | 78,654 | 2.400 | 32 | 1,459,101 | 45,597 | 1.392 |
| 3 | 128 | 9,064,997 | 70,820 | 2.161 | 128 | 5,994,331 | 46,831 | 1.429 |
| 4 | 512 | 31,103,905 | 60,750 | 1.854 | 512 | 25,654,549 | 50,107 | 1.529 |
| 5 | 2,048 | 102,435,356 | 50,017 | 1.526 | 2,048 | 97,605,343 | 47,659 | 1.454 |
| 6 | 8,192 | 326,146,815 | 39,813 | 1.215 | 8,192 | 324,128,142 | 39,566 | 1.207 |

`paper` is 3.7% larger than `photo` overall despite being single-channel: the raw
WAC detail band carries far more high-frequency energy per tile than the
low-saturation 76 px/deg colour base, and JPEG charges for that. Its cost is
front-loaded into the derived levels (2.5 bits/px at L0–L1 vs 1.215 at L6),
because a downsampled grayscale tile keeps its full tonal range while the colour
layer's chroma averages out.

### 4.4 How the measurement compares with the plan's estimate

All percentages below use **the measurement (927,406,556 B = 0.927 GB) as the
single denominator**, stated once as the rule and applied consistently; the two
earlier figures ("7% below the range", "36% low") were against *different* bases
and are reconciled explicitly here.

- Spec §3 / plan: "Tier A, two layers: ~21,844 files, **~1.0–1.8 GB**". The file
  count is **exact**. The bytes are **0.927 GB measured (0.864 GiB)**, so §3's
  estimate is replaced by that figure. Against the measurement, the quoted range
  sits **7.8% above at its low end and 94.1% above at its high end** (0.927 GB is
  7.3% below the 1.0 GB low end — the same gap seen against the range instead of
  the measurement, which is where the earlier "7%" came from).
- The estimator in `bake.py` itself, whose numbers the disk guard actually uses,
  predicted **0.68 GB**, i.e. **26.7% below the measurement** (equivalently the
  real bake came out 36.4% *above* the prediction — that alternative base is the
  "36%" the earlier draft quoted, and both describe the same 247,364,202 B gap).
  The placeholders were individually wrong in opposite directions: `paper` 0.55
  bits/px against 1.3191 measured (2.4× too low) and `photo` 1.35 against 1.2722
  (6% too high). The errors partly cancelled, which is exactly why a
  plausible-looking total hid a 2.4× error in one layer.

### 4.5 Step 4 — the estimator re-measured

`scripts/bake.py` now carries the measured values, with `bake-log.md` named as
the source:

```python
BITS_PER_PIXEL = {'paper': 1.3191, 'photo': 1.2722}
```

Verified by re-running the estimator and the dry run:

```
Tier A est bytes 927405788 =0.927 GB files 21844
measured         927406556 error -0.00%
Tier B est 3.71 GB  ratio B/A=4.00
guard needs 1.5x Tier A = 1.39 GB

$ npm run bake -- --dry-run        # after the update
top=L6 (166.6 m/px) layers=['paper', 'photo']
planned files=21,844 bytes~=0.93 GB disk free=184.9 GB
  LRO_WAC_Mosaic_Global_303ppd_v3.jp2: OK 109164x54582 303.2333 px/deg from raster
  lroc_color_poles.tif: OK 27360x13680 76.0000 px/deg from assigned
dry run: nothing written
```

(The pre-update dry run, for the record: `planned files=21,844 bytes~=0.68 GB
disk free=180.1 GB`, both contracts `OK`, nothing written, exit 0.)
The estimator is now accurate to 5 significant figures on Tier A by
construction. Both estimator tests assert *ratios*
(`b['bytes'] > a['bytes'] * 2` today, `> 2.5` in Task 17's planned test), so
they are invariant to this change: measured B/A = 4.00, still passing.

### 4.6 Step 2's smoke check, as re-run and extended on the delivered pyramid

**No browser screenshot was taken by this session either, and none was
possible.** `take_screenshot` on the in-app browser returned the same failure
§3 quotes: `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE … viewport=0x0,
visibilityState=hidden`. The blocker is the missing visible surface, not scope:
the brief's route to a screenshot — pointing `MoonMap.tsx` at `{layer, top}` —
is a `src/` edit that §3 records as having been *done and then reverted*, so
editing `src/` was available and was never the obstacle; it simply renders
nothing watchable while the in-app tab holds a 0×0 viewport and Cesium never
composites a frame. So **no Cesium-globe render was inspected**, and what
follows is the numeric substitute the fallback allows, defined here and re-run
for Task 17:
`work/tierA_check.py`, which stitches the real tiles into a mosaic and scores
them against `public/data/features.json` — the IAU gazetteer, an independent
dataset that says where each maria and crater is.

Method: luminance of the mosaic sampled in a disc of the feature's own
gazetteer diameter at its gazetteer coordinates, expressed as a percentile of
the whole mosaic; orientation scored over all 23 `Mare`/`Oceanus` and 334
`Crater` entries by comparing mean z at true latitudes against mirrored
latitudes (`lat → −lat`); the seam scored as a 32 px-wide mean either side of
every column boundary over |lat| ≤ 70, so polar map-scale collapse cannot
masquerade as a wrap artefact.

All seven named features and all four criteria, every layer and level checked —
six runs, **54/54 verdicts PASS** (`lum` = mean luminance, `pct` = percentile of
the mosaic). The full transcript of all six runs — including the 27 verdicts that
until now had no retained evidence — is committed at
[`tierA-check-transcript.txt`](tierA-check-transcript.txt) (`work/` itself is
git-ignored). It was re-run for Task 17 on HEAD `6c3d038` against the unmodified
`public/tiles` tree plus the copied-aside L2 smoke set: every luminance,
percentile, orientation contrast, seam step and correlation value below
reproduced, all 54 verdicts still PASS, and none failed to reproduce:

| check | photo L2 (smoke, direct) | photo L2 (delivered, derived) | photo L3 | photo L4 | paper L2 | paper L3 |
|---|---|---|---|---|---|---|
| Mare Tranquillitatis DARK | 66.00 / 0.5 | 65.86 / 0.4 | 67.86 / 0.6 | 67.86 / 0.6 | 26.00 / 11.8 | 27.00 / 13.5 |
| Mare Imbrium DARK | 85.42 / 4.9 | 85.85 / 4.7 | 86.13 / 5.0 | 84.13 / 4.4 | 34.00 / 17.8 | 34.50 / 20.1 |
| Mare Crisium DARK | 84.92 / 4.7 | 84.92 / 4.5 | 84.92 / 4.5 | 84.92 / 4.5 | 34.00 / 17.8 | 34.00 / 19.1 |
| Mare Serenitatis DARK | 82.63 / 4.0 | 83.63 / 4.1 | 84.13 / 4.4 | 82.63 / 3.9 | 34.00 / 17.8 | 34.00 / 19.1 |
| Oceanus Procellarum DARK | 71.92 / 1.2 | 71.92 / 1.1 | 69.92 / 0.9 | 68.92 / 0.7 | 28.00 / 12.8 | 26.00 / 13.1 |
| Tycho BRIGHT | 211.86 / 95.0 | 210.36 / 99.5 | 211.36 / 99.4 | 216.36 / 99.3 | 106.50 / 90.1 | 97.50 / 85.0 |
| Copernicus BRIGHT | 175.35 / 79.5 | 174.93 / 83.7 | 179.43 / 88.6 | 180.42 / 88.2 | 86.00 / 77.4 | 85.50 / 76.6 |
| orientation (true vs mirrored) | −1.673 vs −0.427 | −2.110 vs −0.490 | −2.153 vs −0.422 | −2.130 vs −0.393 | −0.866 vs −0.236 | −0.828 vs −0.266 |
| antimeridian seam vs internal median/max | 9.099 vs 9.908/10.766 | 8.742 vs 9.272/9.934 | 7.647 vs 7.848/9.168 | 7.146 vs 7.705/8.849 | 9.574 vs 10.024/10.910 | 12.382 vs 12.577/14.776 |

What this proves, feature by feature: the five maria land in the darkest
0.4–20.1% of the map *at their gazetteer coordinates* (0.4–5.0% in `photo`,
11.8–20.1% in `paper`), and Tycho — a ray crater at lon −11.2, lat −43.3 — lands
in the brightest 0.5–5.0% of `photo` and the brightest 9.9–15.0% of `paper`.
The orientation test is
the strong one, because it does not use a single assumption about the bake: at
true latitudes the gazetteer's own maria sit **1.67–2.15 σ** below its craters in
`photo` and **0.83–0.87 σ** below in `paper`, while the same features mirrored
across the equator score only **0.24–0.49 σ**. An upside-down bake would invert
that ordering. A further, independent confirmation of orientation compares the
delivered `photo` mosaic against the source file itself, at three levels:

```
corr(source, direct             ) = 0.9801   (L2)   0.9824 (L3)   0.9712 (L4)
corr(source, vertically flipped ) = 0.3047          0.2996        0.2916
```

The seam step is **below the median internal boundary step** in every case, so
there is no streak at lon ±180 — the join is smoother than an ordinary tile
boundary, which is what `blur.py`'s periodic wrap is for.

**Poles: dark in `paper`, and that is the source, not a clamp.** The brief's
criterion is "no dark notch at the poles". The `paper` polar rows *are* dark
(north row y=0 mean 16.5, south row y=63 mean 19.7, against 68.0 at the equator),
so this needed a direct test rather than a glance. A clamp produces a flat tile;
real polar terrain stays textured:

| paper L6 row | mean of 5 sampled tiles | mean within-tile std | min | max |
|---|---|---|---|---|
| y=0 (north) | 16.51 | 34.95 | 0 | 243 |
| y=1 | 25.47 | 33.23 | 0 | 245 |
| y=2 | 39.37 | 42.74 | 0 | 254 |
| y=61 (south) | 42.40 | 54.46 | 0 | 255 |
| y=62 | 27.25 | 45.95 | 0 | 255 |
| y=63 | 19.73 | 42.24 | 0 | 250 |
| y=32 (equator, reference) | 67.97 | 20.28 | — | — |

Within-tile std at the poles is 33–54, **higher** than the equator's 20.3, with
the full 0–255 range present: dark ground carrying bright crater rims under
extreme equirectangular compression. That is the WAC mosaic's own polar
darkening, which Task 6 measured directly (the JP2's north-west 64×64 window
decodes 0..77, recorded in `capabilities.drivers.detail.decode_min/max`). The
`photo` layer, whose source *does* include pole-filling imagery, shows bright
polar bands instead (min 39.5 at L2). No notch in either layer.

**Looked at directly, as pictures.** `work/tierA_check.py --mosaic-out` stitched
the L2 tiles into equirectangular mosaics (`work/tierA-smoke/`,
`work/tierA-final/`) and those PNG/JPEG files were opened and viewed. Both
layers show: the Procellarum/Imbrium/Serenitatis/Tranquillitatis complex as one
dark mass **north** of the equator on the near side; Mare Crisium as a detached
round dark patch near lon +55; Mare Orientale's ringed basin near lon −93 south
of the equator; Tycho's ray system fanning out **south** of the equator at
lon ≈ −11 (its rays being southern is orientation in plain sight); Copernicus
with its own rays north of the equator; crater-saturated, mare-free farside
highlands across the right third and the left edge with no band at the join;
polar terrain that thins normally instead of notching. `photo` is low-saturation
as spec §7 predicts. This is a genuine look at the baked pixels, but it is
**not** the Cesium globe render the brief's Step 2 asked for, and is recorded as
the substitute.

**One expected, documented consequence of derivation.** The delivered parents are
softer and cheaper than the smoke tiles baked *directly* at the same levels. Same
`photo` layer, bytes/tile: L0 48,154 vs 75,471 smoke, L1 46,754 vs 84,857, L2
45,597 vs 83,748 — the derived pyramid's parents are 54–64% of the size, and the
L2 mosaic's contrast drops with them (sd 29.16 delivered vs 36.01 smoke, at
almost the same mean: 150.79 vs 150.46). That is `derive.py`'s stated trade —
parents come from decoded JPEG, so they are marginally softer than a fresh source
read, in exchange for geometric identity between parent and child, which is what
stops cross-level flicker. Not a defect, and the reason the checks above pass at
L2, L3 *and* L4.

### 4.7 Deviations from the brief, and what was not done

1. Step 1's `--top 2 --force` smoke bake was **not re-run** in this session: the
   Tier A `--force` run was live and would have had its `paper` tree deleted. The
   smoke evidence is §2/§3 (first session) plus §4.6 re-run on the delivered
   pyramid and on the copied-aside L2 `photo` set.
2. Step 2's browser screenshots were not possible: the in-app tab is a 0×0
   viewport with no visible surface, so no Cesium frame is composited to capture.
   (Pointing `MoonMap.tsx` at a layer is a `src/` edit that §3 shows was made and
   reverted — it was not withheld, it simply would not have rendered anything
   watchable.) Numeric substitute + direct image viewing in §4.6.
3. Step 3's literal `find public/tiles` command over-counts by the 10 probe
   tiles; see §4.2.
4. `--band-rows 1024` was used as the brief specifies. The L6 world height is
   32,768 px, so 1024 gives 32 bands per layer; the brief's Step 1 `--band-rows
   512` for the L2 smoke run is unchanged from §2.
5. No pipeline defect surfaced, but one warning the delivered run printed is now
   recorded here rather than omitted: a `rasterio NotGeoreferencedWarning` for
   `lroc_color_poles.tif`, at `work/smoke/tierA.log` line 5. It is expected and
   benign, not a defect — the SVS colour mosaic genuinely carries no GeoTIFF
   geotransform, GCPs or RPCs, so rasterio hands back the identity matrix, which
   is precisely the condition `contract.py` handles by *assigning* the grid
   instead of reading it. That is why §0 and §2's dry run report the colour layer
   as `76.0 px/deg from assigned`, and why `capabilities.drivers.color` records
   `crs: None` over an identity `transform`. The detail JP2, which *is*
   georeferenced, emitted no such warning. With that cause on the record:
   `bake.py` was modified only in `BITS_PER_PIXEL` (Step 4); `grid.py`,
   `composite.py`, `blur.py`, `labels.py`, `contract.py` and `src/` were not
   touched, no tolerance was widened, and no assertion was weakened.
6. Tests after the bake and the estimator update:
   `.venv/Scripts/python.exe -m pytest scripts/tests -q` → **106 passed**, no
   warnings; `npx vitest run` → **7 passed (7)**. vitest also prints a
   **pre-existing** Vite notice unrelated to this task — "ESM syntax in a file
   loaded as CommonJS (vitest.config.ts:1:1) … unsupported by
   `configLoader: 'native'`". It reproduces on the untouched config, and fixing
   it means renaming `vitest.config.ts` or setting `"type": "module"` in
   `package.json`, which would change how Next loads its own config. Left for
   its own task; recorded rather than silenced.

## 5. What this means for Task 17 (the forward reference from §2)

- **Disk is not the constraint.** Tier A measured 0.927 GB against a guard that
  now asks for 1.39 GB free. With 169 GB free the guard is nowhere near binding,
  and its numbers are no longer fiction: `estimate()` reproduces the measured
  total to 5 significant figures.
- **Time is the constraint.** At the observed 150–200 s per band, Tier B is not
  4× Tier A, it is worse: L7 needs 64 bands per layer instead of 32, and
  `read_world_rows` still decodes the whole 5.96 GPix codestream for each one,
  because the JP2's block geometry is `(54582, 20000)` — full image height.
  Extrapolating the measured rate, Tier B both layers is on the order of
  **6–12 hours**, and the bytes the estimator predicts for it are 3.71 GB
  (ratio B/A = 4.00). Task 17's opt-in prompt should quote the hours, not just
  the GB.
- **The fix that would change this is spec §3.1 Stage 1** (block-tiled GDAL
  working copies with internal overviews), which plan amendment A removed. It is
  the only known way to stop paying a full JP2 decode per band; the measurement
  behind that claim is §2's table and §4.1's band rates.
- **A future interrupted bake should be diagnosed before it is resumed.** §4.0
  is the procedure: check whether the process is still alive, read the `--force`
  semantics in `run()`, pin the code provenance against `git`, and remember that
  `derive_levels` fails loudly rather than silently on a partial top level.

### 5.1 Status — landed in Task 17

Every forward item above is now implemented in `scripts/bake.py` and pinned by
`scripts/tests/test_disk_guard.py` (full suite: 168 passed):

- **Stage 0 gates a real bake, not only `--dry-run`.** `main()` runs
  `contract.assert_contract` over both sources before `--out` is created or,
  under `--force`, deleted; a missing or wrong-grid source is a hard `exit 2`
  refusal, not a printed "absent" followed by a green `continue`. No multi-hour
  bake can start on an unverified grid.
- **The disk guard measures the volume `--out` resolves to** (`free_bytes_at`
  walks to the nearest existing ancestor and never creates the path), not the
  shell's `cwd`.
- **`baked` and `derived` are counted, printed and manifested separately**, so a
  resume that re-encodes every parent but bakes nothing no longer reports writes
  it did not make.
- **`estimate()` renamed the pyramid-wide count** off the misleading
  `tilesPerLayer` key (`tilesThroughTopPerLayer`, with `tilesAtTop` for the
  single level), and `--band-rows 0` (or any non-positive, or non-multiple of
  512) is a named argument error raised before `range()` is entered.

**Tier B is opt-in and was NOT run.** `project_seconds(7, both, 1024)` puts it at
**6.7–8.4 h** from the measured 150–200 s/band (the §5 "on the order of 6–12 h"
band), on 128 bands (64/layer, double Tier A's 64) and 87,380 files, and the
estimator puts its bytes at **3.71 GB — 4.00× the measured Tier A total** — for
which the guard asks **5.56 GB free**. The controller's ruling keeps it unrun
because it extrapolates to 6–12 hours for resolution the delivered L6
(166.5 m/px, Gate G2-verified) does not need; `disk_refusal`/`main` quote the
hours, the Tier A comparison, a cheaper single-layer subset command and an
explicit "declining Tier B is a valid answer", so the cost is honest whether the
answer is yes or no. The delivered `public/tiles/manifest.json` was corrected to
list only the baked levels L0–L6 (finding 10) and ends with a trailing newline
(finding 13), and its 54 §4.6 smoke verdicts are now backed by the committed
[`tierA-check-transcript.txt`](tierA-check-transcript.txt) (finding 6).

