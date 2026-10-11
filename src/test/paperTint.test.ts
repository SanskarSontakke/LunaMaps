import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import {
  GLOBE_BASE_COLOR,
  PAPER_BASE_COLOR,
  baseColorFor,
} from '@/lib/cesium/moon';
import {
  GLOBE_FILTER,
  GLOBE_SATURATE,
  MEASURED_TILE_SATURATION,
  PAPER_BRIGHTNESS,
  PAPER_CONTRAST,
  PAPER_FILTER,
  PAPER_SEPIA,
  PAPER_SATURATE,
} from '@/lib/look';

/**
 * Task 16's proof surface. There is no DOM in this environment (vitest runs
 * `node`, and no visible tab can be driven), so the paper treatment is verified
 * the only two ways that are not a screenshot: the stylesheet is read as text and
 * required to carry the exact rules, and the colour the renderer paints is required
 * to be the same hex the stylesheet uses.
 *
 * The point of pinning them together is that they are the SAME visual fact seen
 * twice — the tone behind the canvas (CSS) and the tone of the globe itself
 * (`scene.globe.baseColor`, which shows through wherever no tile is loaded, i.e.
 * the margins around the rectangular world in paper mode). Two literals that drift
 * produce a sheet with a differently-coloured hole in it.
 */
const css = readFileSync('src/app/globals.css', 'utf8');
const mapHostSource = readFileSync('src/components/MoonMap.tsx', 'utf8');

const rule = (selector: string) => {
  const start = css.indexOf(selector);
  if (start < 0) return null;
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close).replace(/\s+/g, ' ').trim();
};

describe('the paper tint lives in the renderer, not the bake', () => {
  it('paper mode paints the host with the paper tone', () => {
    expect(rule(".map-host[data-mode='paper']")).toBe(`background: ${PAPER_BASE_COLOR};`);
  });
  it('paper mode applies the warm, lifted filter to the canvas', () => {
    expect(rule(".map-host[data-mode='paper'] canvas")).toBe(`filter: ${PAPER_FILTER};`);
  });
  it('globe mode stretches chroma instead of leaving it measured-neutral', () => {
    expect(rule(".map-host[data-mode='globe'] canvas")).toBe(`filter: ${GLOBE_FILTER};`);
  });
  it('the globe stretch clears what the eye reads as colour', () => {
    // The bake is not at fault: the tiles measure a median saturation of ~0.05,
    // and 0.12 on screen is where a grey map starts to read as a tan one.
    expect(MEASURED_TILE_SATURATION * GLOBE_SATURATE).toBeGreaterThanOrEqual(0.12);
  });
  it('the paper lift brightens without flattening the relief', () => {
    // Albedo percentiles straight out of public/tiles/manifest.json. The affine
    // map is (x/255 - 0.5) * contrast + 0.5, then * brightness; both sides are
    // in the same 0-1 units, so this is the on-screen value divided by 255.
    const shown = (v: number) =>
      ((v / 255 - 0.5) * PAPER_CONTRAST + 0.5) * PAPER_BRIGHTNESS;
    expect(shown(33.5)).toBeGreaterThan(0.3); // mare leaves the near-black
    expect(shown(80.5)).toBeLessThan(0.75); // highlands do not blow out
    // Relief survives — with a ceiling that is arithmetic, not taste. Writing the
    // chain as `out = b·(c·x + 127.5·(1−c))`, three things cannot all hold:
    //
    //   1. nothing clips        ->  b <= 2/(1+c)
    //   2. it is still paper    ->  out(64.33) >= 115
    //   3. relief >= 0.15       ->  b·c·(80.5-33.5)/255 >= 0.15  ->  b·c >= 0.812
    //
    // The largest slope compatible with (1) is 2c/(1+c), which reaches 0.812 only
    // at c = 0.681, b = 1.190 — and that pair puts the mean at 100.6, failing (2).
    // Sweeping the bound, the best relief available while staying at or above
    // mean 115 is ~0.13. So the old 0.15 was not a standard the filter met; it was
    // a standard met *by* clipping everything above DN 178.91 to pure white, which
    // is the defect `src/test/paperClip.test.ts` now forbids. The bar is 0.12
    // because that is what the constraint actually allows, and `paperClip`'s
    // gradient assertions are what stop it being bought back with a white wall.
    expect(shown(80.5) - shown(33.5)).toBeGreaterThan(0.12); // relief survives
    expect(PAPER_SEPIA).toBeGreaterThan(0);
    expect(PAPER_SATURATE).toBeGreaterThanOrEqual(1); // the tint is not undone
  });
  it('the map host carries the mode the scene is confirmed in', () => {
    // Static-source assertion, deliberately: `sceneMode` is the latch-confirmed
    // mode (Task 10 round 2), while `mode` is the last one clicked. Binding the
    // attribute to the wrong one would paint a paper sheet under a scene that
    // never morphed, so the pairing is pinned here rather than left to review.
    expect(mapHostSource).toContain('data-mode={sceneMode}');
    expect(mapHostSource).not.toMatch(/data-mode=\{mode\}/);
  });
});

describe('the globe base colour follows the mode', () => {
  it('two named tones, no fourth hex in the pair', () => {
    expect(PAPER_BASE_COLOR).toBe('#efe9dc');
    expect(GLOBE_BASE_COLOR).toBe('#0b0d12');
    expect(baseColorFor('paper')).toEqual(
      Cesium.Color.fromCssColorString('#efe9dc'),
    );
    expect(baseColorFor('globe')).toEqual(
      Cesium.Color.fromCssColorString('#0b0d12'),
    );
    expect(baseColorFor('paper')).not.toEqual(baseColorFor('globe'));
  });
  it('the CSS tone and the renderer tone are one value', () => {
    const sheet = rule(".map-host[data-mode='paper']") ?? '';
    expect(sheet).toContain(PAPER_BASE_COLOR);
    // The void tone is also what the page background and Cesium's own
    // scene.backgroundColor use, so the globe never sits on a lighter rect.
    expect(sheet).not.toContain(GLOBE_BASE_COLOR);
  });
});
