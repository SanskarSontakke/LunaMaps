# Amendment 2 — resolution, colour, regions, filters, label visibility

Date: 2026-10-08. Supersedes parts of spec §2.1, §3, §6, §7 and the plan's Tier B
framing. Decisions D6–D12 below are approved by the owner; §0 corrects two claims I had
previously stated as fact.

## 0. Two corrections

**"~100 m/px is the finest global public product" was wrong.** USGS Astrogeology's mosaic
bucket also carries `Lunar_LO_UVVISv2_Hybrid_Mosaic_Global_59m.tif` (**16.99 GB, 59 m/px,
global, colour** — Lunar Orbiter MR photogrammetric control merged with Clementine UVVIS)
and `Lunar_LO_MR_Mosaic_Global_59m.tif` (same size, monochrome). At 59 m/px the native grid
is 514 px/deg, which sits between L7 (364) and L8 (728) — so **L8 stops being interpolation
and becomes real data**, and L9 (1,456 px/deg = 21 m/px) is where interpolation begins.
Caveats to verify before trusting it: it is a 1960s-frame + 1994-sensor composite, so
radiometry is not illumination-normalized the way WAC is, and registration against the WAC
grid must be measured, not assumed.

**"Sub-metre detail exists for exactly one site, Apollo 17" was also wrong.** The same
bucket has `LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif` (**77.17 GB, 1 m/px,
controlled, COG**), `NAC_SPOLE_mosaic_1m_cog.tif` (42.60 GB) and
`ShadowCam_SPOLE-90_Mosaic_1m_cog.tif` (19.89 GB, permanently-shaded-region imagery). All
three are cloud-optimised GeoTIFFs, which means **tiles can be streamed by HTTP range
request without downloading the file** — no 77 GB, no tile server.

**Cost correction in the other direction:** my "caps + site list ≈ 30,000 tiles, ~3 GB,
~6 h" figure was wrong. At L8 the grid is 512 × 256 tiles; a |lat| > 80° cap is 15 rows ×
512 = 7,680 tiles, so **both caps ≈ 15,360 tiles ≈ 0.6 GB, and ten 6° site boxes ≈ 720
tiles**. Call it under an hour, not six.

## 0b. §0 corrected itself — measured 2026-10-08, before any of it was spent

Both §0 "corrections" were read off a filename rather than a header, and streaming the
headers disproves them. Every row below is a live probe of the remote file, not a catalog
page.

| claim | measured |
|---|---|
| `Lunar_LO_UVVISv2_Hybrid_Mosaic_Global_59m.tif` is global **colour** | **one band**, `ColorInterp.gray`, uint8, 184320 x 92160 = exactly the file's 16,988,406,549 bytes, so it is **uncompressed**, strip-organised (`tiled=False`, block 184320 x 1) with **no overviews** |
| `Lunar_LO_MR_Mosaic_Global_59m.tif` is the monochrome sibling, same size | true, and that is *why* the two sizes matched: identical geometry, both single-band |
| 514 px/deg | **512 px/deg** exactly (59.225 m/px), CRS `SimpleCylindrical Moon` on R = 1,737,400 — properly georeferenced, unlike the colour file we hold |
| the three 1 m/px polar COGs are in "the same bucket" | **all three 404** on `asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/`, which is a file proxy that cannot be listed. The names came from elsewhere and were never probed |

Consequences, in order of how much they cost:

1. **A 59 m/px global *colour* source does not exist here.** The claim that "L8 stops being
   interpolation and becomes real data" was about colour, and it is false: our only global
   colour is still 76 px/deg (400 m/px). Above L6 the `photo` layer's *relief* is real
   (WAC, 100 m/px) and its *hue* is interpolated. That is a limitation to state in the app,
   not a bake to run.
2. **The 17 GB LO download is off the critical path.** It buys 512 px/deg of monochrome
   1966 film. Its illumination is not normalized, and §2 item 4 bans mixing two shaded
   sources, so it cannot feed `paper` without breaking Gate G2's albedo proof, and it
   cannot feed `photo` chroma because it has none.
3. **L8 and the COG prototype both wait on §0b item A** — a real, reachable 1 m/px polar
   source. Until one answers a HEAD request, region-limited L8 would be baking
   interpolation into 15,360 tiles and calling it detail.

What is *not* affected: L7 (83.3 m/px) is within reach of the WAC mosaic we already hold
and verified, so `npm run bake -- --top 7` was started on 2026-10-08 from held sources.

## 1. Approved decisions

| # | Decision |
|---|---|
| D6 | Bake **L7 globally and L8 only for regions**: both polar caps (|lat| > 80°) plus ~10 named site boxes. Region-limited pyramids, not a global L8. |
| D7 | Colour: keep the natural-colour pipeline as the default `photo` layer and **fix its chroma** (it currently renders near-grey). Add GLD100 ClrShade (11.19 GB, 118 m/px, ±79°) as a **third selectable layer, explicitly labelled false colour** — it is TiO/FeO abundance colourisation, so mare read blue-violet. It is not "better colour", it is a different product, and the UI must say so. |
| D8 | Regions are **derived + curated** from data we already hold: latitudinal caps, near/far hemispheres, gazetteer bboxes for the major maria, and named site boxes. Every region records its geometry source in the manifest. |
| D9 | Label set grows from 600 to **~1,800** (all craters ≥ 30 km plus every named mare, lacus, sinus, montes, vallis, rima, catena, dorsum, rupes, planitia, promontorium and all 81 astronaut-named features), with a **density slider** controlling how many are drawn at a given zoom. Default density stays as today. |
| D10 | Filters drive a **collapsible sidebar list** as well as map visibility: type, size range, mission, region, density; the list is sorted and clicking a row flies there and opens its card. |
| D11 | **Region highlighting**: selecting a region (e.g. South Pole) draws its outline, tints its interior, and frames the camera on it. Reuses the sidebar; no new engine. |
| D12 | **Label and UI visibility** is a first-class fix, not polish: brighter fill, stronger halo, optional opaque backing plate, larger minimum font, and landing-site markers that stop out-shining the names. |

## 2. Consequences for the pipeline

1. **Availability, not 404s.** A region-limited L8 means most L8 tiles do not exist. The
   imagery provider must be given a `TileAvailability` built from the baked region inventory
   so Cesium shows the L7 parent instead of requesting a missing tile. `manifest.json`
   records the region tile list; the app derives availability from it, and a test asserts the
   two agree exactly. Without this the console fills with 404s and the map shows holes.
2. **The band precondition does not hold for site boxes.** `blur_separable`'s periodic-x is
   correct for full-width bands; a box window must pass `wrap_x=False` and instead read real
   neighbour data in its margin (≥ 3σ, modulo-wrapped at the source level). Task 4's
   precondition is "the array has real data around the kept pixels", not "the array is the
   whole world" — the code and docstring must say it that way.
3. **A registration gate before any new source is used.** For LO/UVVIS 59 m and GLD100:
   cross-correlate against the existing WAC albedo at L6 over a global sample and require
   peak alignment within 1 px and correlation above a stated floor; report the numbers in the
   manifest. A source that fails the gate does not enter the bake, and the reason is printed.
   This is the direct guard for the "don't mess up the geometry" requirement.
4. **Illumination mixing stays banned.** GLD100 and SVS are both shaded-relief products with
   different sun models, so they may not both contribute relief at once. The ±79° boundary is
   crossed by blending **colour only** over a 5° band, and a new check measures the
   luminance step across that band at several longitudes and fails above a threshold.
5. **COG streaming for the 1 m polar mosaics** is a prototype-gated option: a browser-side
   range-reader (`geotiff`) over `UrlTemplateImageryProvider`'s custom-provider seam, no
   download, no server. If the prototype cannot decode the internal compression, the fallback
   is a small server-side tile endpoint or a partial download — and that is reported, not
   silently substituted.
6. **Polar albedo hole.** 6.60% of the L5 paper grid reads DN 0 above |lat| 73° (upstream WAC
   gap). The LO/UVVIS 59 m source covers the poles, so the same fetch that gives L8 real
   detail can fill the hole; the fill must be recorded per-tile in the manifest so the map
   never presents filled pixels as measured ones.

## 3. Consequences for the app

- Sidebar (filters + live list + region chips), density slider, region highlight overlay.
- Layer set becomes three: `paper` (albedo), `photo` (natural colour relief),
  `gld100` (false-colour abundance relief, labelled as such).
- Label styling and the landing-site marker treatment revised per D12.
- Default camera framing replaced: the current 22,000 km home view shows a ~110 px disc in a
  564 × 786 canvas, which is a framing bug, not a taste question.
- ~~Compass rose is clipped under the top control bar in flat mode.~~ There is no compass
  rose: that badge is the Next.js dev-mode indicator (`NEXTJS-PORTAL`), which does not
  exist in a production build. `devIndicators: false` removes it from dev captures.
- Spec §4.5's performance budget: the measurement half landed on 2026-10-09 and is in
  `gate-G3-live.md` §9 (median tile response 0.5–3.3 ms, wire peak concurrency 1–8 against
  the ≤16 clause, JS heap 113 MB after 60 deep tiles, globe 69–95 ms p50 / paper 110–137 ms
  p50 under SwiftShader). What is still true of the original complaint is the normative
  half: there is no `maximumScreenSpaceError` and no request-concurrency config anywhere in
  `src/`, so the clause holds by Cesium's default rather than by a decision — and a
  deployment that serves tiles from a distant CDN rather than localhost inherits an
  unmeasured latency there.

## 4. Cost picture, to be re-measured not re-asserted

| Item | Download | Bake |
|---|---|---|
| L7 global, both layers | 0 (sources held) | +3.71 GB, ~7–8 h (measured per-band rate) |
| L8 caps + site boxes | 0 | ~0.7 GB, under 1 h (corrected from my earlier 6 h) |
| LO/UVVIS 59 m hybrid | 16.99 GB | enables real L8 and the polar fill |
| GLD100 ClrShade | 11.19 GB | false-colour layer, mid-latitudes |
| NAC/ShadowCam 1 m poles | 0 if streaming works | deep zoom on the south polar region |

Total disk to hold everything currently planned: ~35 GB of sources plus ~6 GB of tiles.
Free space must be checked before any of this starts; the bake guard already refuses to run
without 1.5× its estimate.

## 5. Standing defects carried into this amendment

Fixed 2026-10-08, with the before/after numbers in `gate-G3-live.md` §8:

1. ~~The `photo` layer shows no visible colour — chroma injection is doing detail, not
   hue.~~ **The diagnosis was wrong.** The bake reproduces the source's chroma to within
   ~1 count of R−B at every level; the LROC colour mosaic simply measures a median
   saturation near 0.05. It is a display stretch now (`GLOBE_SATURATE`), stated as one.
2. ~~The paper tint is imperceptible.~~ Fixed by lifting the floor as well as warming it.
3. ~~Landing-site markers out-shine the names.~~ Fixed: half the area, a fifth of the alpha.
4. ~~Labels over bright highland terrain lose contrast.~~ Fixed, and the distance fade was
   moved because its far stop sat below the whole-globe home height.
5. **Still open.** `verify-11.md` reports 116 labels at 3.5 × 10⁶ m where the live pass
   measured 93; the declutter cell size assumes a 900 px viewport that is never read from
   the canvas. The new default framing puts every tier on screen at once, so this one is
   now more exposed, not less.

## 6. Source inventory, every row probed on 2026-10-08

A bucket listing I dismissed as impossible is possible: `asc-pds-services` answers
`?list-type=2` when the prefix is given **from the bucket root**
(`prefix=mosaic/Lunar_safed/...`). My earlier `prefix=Lunar_LO` on the `/mosaic/` key path
returned `NoSuchKey` and I concluded the host could not be listed. That conclusion was
wrong, and it is what made the polar files look like a fabrication: they were one directory
deeper. `§0b`'s "a file proxy that cannot be listed" is hereby corrected.

| source | bytes | bands | COG | px/deg | m/px | what it is good for |
|---|---|---|---|---|---|---|
| `wms_basemaps3/Moon/Kaguya_TCortho_Mosaic_Global_4096ppd_cog.tif` | 78,252,302,973 | 1 uint8 | **yes**: tiled 512, jpeg, 9 ovr | 4096.09 | **7.4** | global, equirectangular on `GCS_Moon` R=1,737,400 with bounds exactly (-180,-90,180,90) — **our grid contract, no reprojection**. Shaded orthophoto, so it may not mix with WAC albedo |
| `mosaic/Lunar_safed/LMAP/SouthPolar/LRO_LROC_NAC_SPOLE-90_Mosaic_1m_controlled_cog.tif` | 77,174,580,438 | 1 uint8 | yes: tiled 512, **deflate**, 10 ovr | 1011.7 (1.0 m/px) | 1.0 | PolarStereographic -90, extent 182,107 m, lat >= -84.0. Needs reprojection into the equirect grid |
| `.../SouthPolar/NAC_SPOLE_mosaic_1m_cog.tif` | 42,596,230,725 | 1 uint8 | yes, deflate, 10 ovr | 1.0 m/px | 1.0 | *Orthographic* -90, lat >= -85.5 |
| `.../SouthPolar/ShadowCam_SPOLE-90_Mosaic_1m_cog.tif` | 19,887,940,203 | 1 uint8 | yes, deflate, 10 ovr | 1.0 m/px | 1.0 | Polar Stereographic IAU 30135; permanently-shaded-region imagery (a 256 window read back mean 3.7 DN) |
| `.../SouthPolar/ldem_87s_5mpp_cog.tif` (+ `_hillshade_`) | 4,200,862,545 | 1 float32 | yes, 8 ovr | 5.0 m/px | 5.0 | stereo DEM south of -87, plus its hillshade |
| `wms_basemaps3/Moon/LRO_WAC_Mosaic_Global_303ppd_v3_cog.tif` | 859,483,513 | 1 | yes, jpeg | 303.23 | 100 | the albedo source we already hold as a 2.5 GB JP2, in 859 MB of COG |
| `wms_basemaps3/Moon/LRO_LOLA_ClrShade_Global_256ppd_v06_cog.tif` | 847,198,547 | **3 RGB** | yes | 256 | 118.4 | colourised shaded relief. D7's "labelled false-colour third layer", at a tenth of GLD100's size and streamable |
| `mosaic/Lunar_LROC_WAC_GLD100_ClrShade_79s79n_118m_v1_1.tif` | 11,185,005,343 | 3 RGB | **no**, striped, 0 ovr | 256 | 118.4 | the D7 pick; unusable by streaming, and LOLA ClrShade is the same job smaller |
| `mosaic/LRO_LrocKaguya_Shade_60N60S_512ppd_cog.tif` | 2,574,022,967 | 1 | yes | 512 | 59.2 | shaded, so same mixing ban |
| `mosaic/Lunar_LO_UVVISv2_Hybrid_Mosaic_Global_59m.tif` | 16,988,406,549 | 1 | no | 512 | 59.2 | §0b: **monochrome**, not the colour source §0 claimed |

**D6 is superseded by the first row.** The plan was "L7 global, L8 for caps and ~10 site
boxes" because I believed 59 m/px was the floor. Kaguya TC is 7.4 m/px global on our own
grid, so L8 (41.6), L9 (20.8) and L10 (10.4 m/px) are all real data — L11 (5.2) is where
interpolation starts. Global L10 is out for a local-first app (L0..L10 is 2,796,202 tiles),
so the shape stays regional, but the *depth* goes from L8 to L10, and it is streamed:
reading only the windows a site box needs costs a few hundred MB, not 78 GB.

Two consequences to respect, both measured:

1. Kaguya TC is a **shaded** orthophoto. It cannot feed `paper` (WAC albedo) or blend into
   it at a level boundary; §2 item 4's illumination ban applies to it exactly as it applied
   to GLD100. It earns its own labelled layer, or it does not ship.
2. The polar COGs are internally **deflate**-compressed, not JPEG, so a browser-side
   geotiff.js prototype needs an inflate path, and all three are in polar projections, so
   feeding the equirectangular bake means resampling them, not just windowing.

## 7. The south polar cap was measured, and dropped — 2026-10-09

§6 left one region unbaked: `south-polar-cap`, box -180/180 × -90/-84, planned at L8-L9
(23,040 of the plan's 30,172 tiles). It was not baked because `check_plan` refuses the
`nac-spole` source by projection. The question this section answers is whether it *should*
be baked, and the answer is no, on three measurements.

**7.1 The obvious source has no data there.** Kaguya TC is equirectangular, already
registered, already streaming, and its header declares latitude bounds of exactly +-90.
Probing it through `/vsicurl` on 2026-10-09 says otherwise: `nodata` is 0, and a 16-point
longitude sweep of 64 px boxes reports the fraction of longitudes that actually have data —

| latitude | longitudes with data (of 16) |
|---|---|
| -82 | 15 |
| -85 | 12 |
| -87 | 10 |
| -89 | 6 |

and 512 px samples centred at -84, -88 and -89.6 read back 99.8-100 % below 3 DN (mean
0.01, max 12). Baking the cap from Kaguya would put black rectangles into the pyramid and
advertise them as terrain. That is the same failure the plan refuses in a COG *window*
(`stream_bake.py`: rasterio's cropped-window lie), only with the holes baked in.

**7.2 The grid cannot express what the other source has — and this paragraph was wrong
the first time.** `nac-spole` genuinely covers the cap: 364,214 px square at 1 m, polar
stereographic on latitude of origin -90, radius 182,107 m, which is exactly to -84.0. A
geographic tiling scheme samples *latitude* on a fixed grid, so one tile row is
`m_per_px(L)` in latitude and `m_per_px(L) × cos(lat)` in longitude at that latitude:

| level | latitude | longitude at -84 | at -88 | at -89.6 | honest (≤ 1 m/px) only where |
|---|---|---|---|---|---|
| L8 | 41.64 m/px | 4.35 | 1.45 | 0.29 | `\|lat\| ≤ 88.6°` |
| L9 | 20.82 m/px | 2.18 | 0.73 | 0.145 | `\|lat\| ≤ 87.3°` |
| L10 | 10.41 m/px | 1.09 | 0.36 | 0.073 | `\|lat\| ≤ 84.5°` — which is outside the box |

(arc metres per degree = `1,737,400·π/180` = 30,323.35; a tile spans `180/2^L` degrees of
latitude and `360/2^(L+1)` of longitude over 512 px.) So a 1 m/px source arrives **downsampled
40:1 in latitude** — the grid simply cannot carry that much detail northward — while the
poleward rows ask for finer-than-1 m longitude sampling and would be **interpolated**. The
first version of this table quoted 0.0073 m/px for L8 at -89.6 where the arithmetic gives
0.29, a 40× error, and said "unreachable at any level" when the honest reading is level- and
latitude-specific: L8 is real data from -84 to about -88.6 and interpolated inside that.
**Conclusion unchanged, reasoning corrected.**

**The asymmetry is the whole point, and it cuts the other way for the layer that shipped.**
For an **equirectangular** source the `cos(lat)` factor appears on *both* sides — the source's
own pixels converge with the meridian grid exactly as the tile's do — so the ratio is
latitude-invariant and there is no polar problem to find: Kaguya TC at 4,096.09 px/deg against
this grid is a **5.63:1 downsample at L8, 2.81:1 at L9 and 1.41:1 at L10, at every latitude
including -89.6**. That is why `check_plan`'s equatorial comparison (`grid.px_per_deg(L)`
against the source's px/deg) is *correct* for `kaguya-tc` and *meaningless* for `nac-spole`,
and why the projection refusal has to come first — see §7.5. A claim made earlier in this
session, that 23 of the 7,106 delivered tiles were upsampled by 0.4% because a poleward tile
row needs `px_per_deg(L)/cos(lat)`, was exactly this error in the opposite direction: it
applied the convergence to the demand and not to the supply. No delivered tile is upsampled.

**The 1 m/px south pole §6 hoped for is not deliverable in this pyramid.** Not because the
source is missing — it is there and measured — but because a fixed-degree grid throws away
most of it in latitude and then asks for more than it has in longitude, at the same time.
Reaching 1 m/px at the pole needs a polar-stereographic *view*: its own projection, its own
tiling, and its own rendering path. That is an architecture question, and §7.5 closes the
bake-side question instead.

**7.3 The cost is not the 9 minutes the site boxes took.** Measured on the delivered run:
7,106 tiles, 187,755,158 bytes, 9 minutes, i.e. ~13 tiles/s and ~26.4 KB per tile. The cap
needs a *different* read pattern, because a polar-stereographic source and an
equirectangular grid are rotated relative to one another: an L9 tile at -89° is a radial
spoke 10,659 m long and ~19 m wide, and the axis-aligned window that contains it is about
10.7 km square — roughly 180× the spoke's own area, averaged over the 1,024 longitudes. One
pass over the cap at 1 m/px is 1.04e11 px (~104 GB); per-tile windows multiply that by the
spoke-to-bbox ratio, which is why the naive version is not an afternoon. Doing it properly
means reading annulus strips once and scattering into tiles — a new code path, not a flag.

**7.4 And it would break the mixing ban.** `nac-spole` is a second shaded mosaic with its
own illumination, its own season and its own scale. Inside `ortho` it draws a seam at -84°
and makes the control's "Kaguya TC" label false; §2 item 4 applies exactly as it did to
GLD100. Honest versions are a separate layer with its own toggle, or no cap.

**Decision (the user's, 2026-10-09): drop it from the plan.** `south-polar-cap` is gone
from `regions.py` and `public/data/regions.json`; the plan is now the 12 Kaguya regions and
7,132 tiles (7,106 distinct — apollo-15's site box lies inside rima-hadley's and shares 26
tiles with it). What that buys is checkable rather than aspirational: `test_disk_guard.py`
now asserts plan == delivery (`planned == set(ortho['regions'])`) and that every shipped
region cites `kaguya-tc`, so a region that is planned-but-never-baked fails the suite
instead of quietly shrinking the record.

A real deep south pole is a **polar-stereographic view** — its own projection, its own
tiling, or a locally-cut image — which is an architecture question and not a bake. It stays
out of scope for this amendment. `nac-spole` remains in `regions.SOURCES` as the measured
row it is, because the projection refusal needs a real polar projection to refuse.

**7.5 Two rulings the whole-branch review extracted, and what happened to them.**

- *The projection refusal must be the last word on a projected source.* `check_plan` used
  to append a resolution verdict after refusing by projection — "L9 needs 1456.36 px/deg
  but source 'nac-spole' is 1011.71 px/deg" — which compares degrees-per-pixel of a
  stereographic pixel against this grid and means nothing (§7.2). The row was left in
  `SOURCES` anyway, so the message was reachable on shipped data, and the test that should
  have caught it used `pxPerDeg: 30_000`, the one value that makes the second message
  unable to fire. `1e7c1a5` stops at the projection and re-points the fixture at the
  measured 1011.71, so the single-refusal assertion now discriminates.
- *The mixing ban, in the compositor rather than the bake.* The review's sharpest point:
  the default base layer is `photo`, itself a shaded relief product, so one click stacks
  Kaguya's shaded orthophoto over a second shaded illumination and the ban in §2 item 4 is
  reachable in the shipped default state — not through the bake, which stays clean. The
  ruling (the user's, 2026-10-09): **accept it, and let D11's region outlines be the
  mitigation.** The reasoning, stated so a later reader knows what was traded: inside a box
  the overlay is opaque, so no *pixel* is a blend of two sources; what the ban permits to
  survive is a visible step at the twelve box edges and a paper-mode CSS lift calibrated to
  WAC albedo DN running over Kaguya pixels. Outlines and framing make the seam attributable
  instead of mysterious; muting it by blending would be the thing actually forbidden.
  Two consequences follow and are owed work, not debate: D11 is now load-bearing rather than
  cosmetic, and the paper-mode filter needs its own measured answer for overlay pixels
  (`§8` of `gate-G3-live.md` covers the base layers only).
