import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAPER_BRIGHTNESS, PAPER_CONTRAST } from '@/lib/look';

/**
 * The paper filter must not turn the brightest terrain into a white wall.
 *
 * CSS filters are affine, so `contrast(c) brightness(b)` is one line in DN units:
 *
 *     out(x) = b · (c·x + 127.5·(1 − c))
 *
 * which makes the saturation point computable — and computable means testable
 * against the shipped histogram instead of eyeballed against a screenshot. The
 * distribution this runs on is `albedoHistogram` in `public/tiles/manifest.json`:
 * every pixel of the 2,048-tile L5 `paper` layer (536,870,912 samples), measured by
 * `scripts/proof.py`.
 *
 * The assertion is deliberately a *bound*, not a measured fraction: the manifest
 * stores percentiles, not the 256 bins, and `clipDn > p9999` already proves that
 * no more than 0.01% of the layer can saturate. Storing the histogram to answer a
 * question the percentiles already answer would be a bigger artifact for no extra
 * guarantee.
 */
const clipDn = (c: number, b: number) => (255 - 127.5 * b * (1 - c)) / (b * c);
const out = (x: number, c: number, b: number) => b * (c * x + 127.5 * (1 - c));

const histogram = JSON.parse(
  readFileSync('public/tiles/manifest.json', 'utf8'),
).albedoHistogram as {
  mean: number;
  p99: number;
  p999: number;
  p9999: number;
  maxDn: number;
};

describe('the paper lift does not clip the bright end of the albedo range', () => {
  it('saturates above every value the delivered layer actually contains', () => {
    const clip = clipDn(PAPER_CONTRAST, PAPER_BRIGHTNESS);
    expect(clip).toBeGreaterThan(histogram.maxDn);
    // Bounded by the stored percentiles: at most 0.01% of the layer can saturate.
    expect(clip).toBeGreaterThan(histogram.p9999);
    expect(out(histogram.maxDn, PAPER_CONTRAST, PAPER_BRIGHTNESS)).toBeLessThanOrEqual(255);
  });

  it('keeps the top of the distribution as a gradient, not a wall', () => {
    // The defect being fixed: the old pair put the clip at DN 178.91 while p99 is
    // 197, so the brightest 1% of the Moon -- highlands, ray systems, Aristarchus
    // -- had zero tonal separation. Requiring a real spread across each band is
    // what stops a future "just brighten it a bit" change from silently eating it.
    const top = out(histogram.maxDn, PAPER_CONTRAST, PAPER_BRIGHTNESS);
    expect(top - out(histogram.p99, PAPER_CONTRAST, PAPER_BRIGHTNESS)).toBeGreaterThan(30);
    expect(top - out(histogram.p999, PAPER_CONTRAST, PAPER_BRIGHTNESS)).toBeGreaterThan(8);
  });

  it('still reads as light paper, not warm grey', () => {
    // Gate G3 defect 2 was that the map looked grey. The lift is what fixed it, so
    // the no-clip pair has to keep the mean in the same place the clipped one was.
    const mean = out(histogram.mean, PAPER_CONTRAST, PAPER_BRIGHTNESS);
    expect(mean).toBeGreaterThanOrEqual(115);
    expect(mean).toBeLessThanOrEqual(135);
  });

  it('proves the guard is falsifiable on the pair it replaced', () => {
    // A test that cannot fail is not a guard. 0.72/1.55 shipped for weeks and every
    // other paper test passed against it, so the negative control lives here.
    expect(clipDn(0.72, 1.55)).toBeLessThan(histogram.p99);
    expect(out(200, 0.72, 1.55)).toBeGreaterThan(255);
    expect(out(histogram.maxDn, 0.72, 1.55)).toBeGreaterThan(255);
  });

  it('keeps the no-clip bound as the arithmetic the comment claims', () => {
    // `b <= 2/(1+c)` is the derived ceiling. Asserting it directly means a future
    // edit that nudges brightness up fails with a message that says why.
    expect(PAPER_BRIGHTNESS).toBeLessThanOrEqual(2 / (1 + PAPER_CONTRAST));
  });
});
