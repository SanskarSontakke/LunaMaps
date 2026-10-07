import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import {
  GLOBE_BASE_COLOR,
  PAPER_BASE_COLOR,
  baseColorFor,
} from '@/lib/cesium/moon';

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
  it('paper mode applies the warm, low-contrast filter to the canvas', () => {
    expect(rule(".map-host[data-mode='paper'] canvas")).toBe(
      'filter: sepia(0.22) saturate(0.55) contrast(0.94) brightness(1.08);',
    );
  });
  it('globe mode keeps a near-neutral filter, not the paper one', () => {
    expect(rule(".map-host[data-mode='globe'] canvas")).toBe(
      'filter: saturate(1.04) contrast(1.02);',
    );
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
