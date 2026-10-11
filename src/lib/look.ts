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

/** Albedo's mean is 64.33/255 (`albedoHistogram` in public/tiles/manifest.json).
 *  `contrast(<1)` compresses toward mid grey and `brightness(>1)` shifts up; CSS
 *  filters are affine, so together they are the floor-plus-scale that turns a
 *  dark albedo map into a light sheet. No gamma is available here, and none is
 *  claimed.
 *
 *  The pair is chosen against the TOP of that distribution, not just its mean.
 *  In DN units the chain is `out = b·(c·x + 127.5·(1−c))`, so the input that
 *  saturates is `(255 − 127.5·b·(1−c)) / (b·c)`. The previous pair (0.72, 1.55)
 *  put that at **DN 178.91** while the shipped histogram has p99 = 197 — every
 *  pixel above 179 rendered pure white, measured 1.781% of all 536,870,912
 *  pixels of the L5 layer, and the brightest anorthositic highlands, ray systems
 *  and craters like Aristarchus live in exactly that band. `src/test/paperClip.test.ts`
 *  pins it.
 *
 *  `b ≤ 2/(1+c)` is the condition for input DN 255 to still land at or below 255,
 *  i.e. for the filter to clip nothing in the uint8 domain at all. At 0.53 that
 *  bound is 1.30719; 1.307 sits just inside it, and the pair was then chosen so
 *  the output mean stays where the old one was (123.0 against 127.1 measured),
 *  because the sheet is meant to read as light paper. The cost is honest and
 *  worth stating: the slope drops from 1.116 to 0.693, so mare-to-highland
 *  separation is gentler than it was. Trading a flat white wall for a softer
 *  gradient is the right way round — the wall destroys detail, the gradient only
 *  reduces its punch. */
export const PAPER_CONTRAST = 0.53;
export const PAPER_BRIGHTNESS = 1.307;
export const PAPER_SEPIA = 0.42;
/** Above 1 because the previous look put 0.55 here and cancelled its own tint. */
export const PAPER_SATURATE = 1.25;

export const PAPER_FILTER = `contrast(${PAPER_CONTRAST}) brightness(${PAPER_BRIGHTNESS}) sepia(${PAPER_SEPIA}) saturate(${PAPER_SATURATE})`;
export const GLOBE_FILTER = `saturate(${GLOBE_SATURATE}) contrast(1.02)`;
