/**
 * The two canvas filters, as numbers.
 *
 * `src/app/globals.css` holds the same values as literals (CSS cannot import
 * TypeScript without a build step this project does not have), and
 * `src/test/paperTint.test.ts` fails if the two drift — the same pairing used
 * for `PAPER_BASE_COLOR`. What the test can additionally assert is the *intent*
 * below, which a text diff cannot: that the globe stretch is large enough to
 * move the measured tile saturation past what the eye reads as colour.
 *
 * Both are chroma operations about each pixel's own grey, so the grayscale
 * albedo layer and the near-white label text pass through them unchanged.
 */

/** Measured in `data/raw/lroc_color_poles.tif` and reproduced by the baked
 *  `photo` tiles to within ~1 count of R-B: median saturation 0.04-0.08. */
export const MEASURED_TILE_SATURATION = 0.05;

/** Chroma multiplier on the photographic globe. `MEASURED_TILE_SATURATION *
 *  GLOBE_SATURATE` is the on-screen saturation this produces; gate G3's neutral
 *  grey globe came from the 1.04 that was here before. */
export const GLOBE_SATURATE = 2.6;

/** Albedo's mean is 64/255 (`albedoHistogram` in public/tiles/manifest.json).
 *  `contrast(<1)` compresses toward mid grey and `brightness(>1)` shifts up; CSS
 *  filters are affine, so together they are the floor-plus-scale that turns a
 *  dark albedo map into a light sheet. No gamma is available here, and none is
 *  claimed. */
export const PAPER_CONTRAST = 0.72;
export const PAPER_BRIGHTNESS = 1.55;
export const PAPER_SEPIA = 0.42;
/** Above 1 because the previous look put 0.55 here and cancelled its own tint. */
export const PAPER_SATURATE = 1.25;

export const PAPER_FILTER = `contrast(${PAPER_CONTRAST}) brightness(${PAPER_BRIGHTNESS}) sepia(${PAPER_SEPIA}) saturate(${PAPER_SATURATE})`;
export const GLOBE_FILTER = `saturate(${GLOBE_SATURATE}) contrast(1.02)`;
