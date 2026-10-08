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
- Spec §4.5's performance budget is still unimplemented: no `maximumScreenSpaceError`, no
  tile-request concurrency cap, no latency or memory measurement.

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
