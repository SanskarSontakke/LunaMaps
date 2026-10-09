# Notices, provenance and what is *not* licensed

`LICENSE` (MIT) applies to this repository's code, tests and documentation. It applies
to **no imagery, no elevation data and no derived raster**, because this project does not
hold rights it could pass on. This file records what each artifact is, where it came from,
and what someone redistributing it has to check.

## Products this build serves

| Product | Upstream | Stated terms | What this repo ships |
|---|---|---|---|
| `paper` layer — flat relief | LRO WAC morphology mosaic, 100 m/px (303.233 px/deg), single band | none found in the file; metadata credits `LROC Team, ASU` | nothing — tiles are gitignored build output, baked locally by `npm run bake` |
| `photo` layer — colour relief | NASA SVS CGI Moon Kit `lroc_color_poles.tif`, 76 px/deg | none found; `TIFFTAG_DOCUMENTNAME` = `/svs/data/lunar/lroc/albedo/hapke/lroc_color_poles.tif` | nothing (same) |
| `ortho` layer — deep zoom | Kaguya TC orthomosaic, 4096 px/deg (7.4 m/px), SELENE/Kaguya Terrain Camera, JAXA; range-read from USGS Astrogeology's `asc-pds-services` mirror | none found in the COG header | nothing (streamed, never downloaded) |
| Place names | IAU Gazetteer of Planetary Nomenclature (USGS Astrogeology), 9,087 records | **`Public domain.`** (`useconst` in `metadata_nomenclature_points_MOON.xml`) | `public/data/features.json` — 1,585 curated features, derived from the tracked gazetteer zip |
| Geometry contract | CesiumJS `GeographicTilingScheme`; Moon radius 1,737,400 m, flattening 0 | Cesium is Apache-2.0 | `scripts/grid.py` and `src/lib/grid.ts`, mirrored and pinned by `test-vectors/grid.json` |

The only artifact in this repository with an explicit written use constraint is the
gazetteer, and it is public domain. `public/data/features.json` and
`public/data/regions.json` are derived from it, so they carry no upstream restriction
this file is aware of.

## The thing that has not been checked

**Nobody has verified the redistribution terms of the imagery products.** The README has
carried that as an open item since the first bake, and it is still open. A deployed
instance of this project that serves baked tiles is redistributing derived imagery from
LROC/ASU, NASA SVS and JAXA/SELENE sources under whatever terms those bodies attach, and
this repository asserts nothing about those terms either way.

Concretely, before publishing a deployment that serves tiles:

1. Check the use/redistribution conditions for the LRO WAC mosaic and the LROC
   Terrain Camera products with LPI/ASU, for the CGI Moon Kit with NASA's Scientific
   Visualization Studio, and for the Kaguya TC mosaic with JAXA/SELENE plus the USGS
   mirror that serves it.
2. Keep the attribution that the app already renders — `src/lib/cesium/moon.ts`'s `CREDIT`
   for the two baked layers and `src/lib/cesium/ortho.ts`'s `ORTHO_CREDIT` for the deep
   layer, which names Kaguya TC explicitly because those pixels are not LROC's.
3. Assume nothing from "the file was fetchable". Public availability and permission to
   redistribute are different questions.

The **UI-only deployment** described in `docs/deploy.md` (§2, option A) ships no imagery at
all and is therefore outside this question: the site serves code and public-domain place
names, and anyone who wants imagery bakes it locally from the upstream sources under their
own terms.

## Third-party code and assets

- `cesium` (Apache-2.0) — the renderer. Its static assets are copied into `public/cesium/`
  at install time by `scripts/postinstall_cesium.mjs` and are gitignored; they remain
  Apache-2.0 and are not covered by this repository's MIT grant.
- `next`, `react`, `react-dom` — MIT.
- Python: `rasterio` (BSD-3), `GDAL` (MIT-like), `numpy` (BSD-3), `Pillow` (HPND/MIT-style
  licence). No code from them is vendored into this repository.
- `tests/fixtures/moon_nomenclature_fixture.zip` — the gazetteer distribution, public
  domain, tracked in git because the geometry tests are pinned against its exact record
  count (9,087).

## No warranty

The gate verdicts in `public/tiles/manifest.json` (`geometryProof`, `albedoHistogram`) are
this project's own measurements of its own bake. They are not a certification of the
upstream data, and a map of the Moon at these resolutions is not a navigational,
scientific or survey product.
