import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as Cesium from 'cesium';
import { CREDIT, makeProvider } from '@/lib/cesium/moon';
import { attributionContent } from '@/lib/attribution';
import type { Manifest } from '@/types';

const manifest = JSON.parse(
  readFileSync('public/tiles/manifest.json', 'utf8'),
) as Manifest;

describe('the credit is one imported string, never a retyped copy', () => {
  it('is a Cesium Credit whose html reads back verbatim', () => {
    expect(CREDIT).toBeInstanceOf(Cesium.Credit);
    expect(typeof CREDIT.html).toBe('string');
    expect(CREDIT.html.length).toBeGreaterThan(40);
  });
  it('names the four provenance holders', () => {
    for (const part of [
      'NASA/GSFC/Arizona State University',
      'LROC WAC mosaic',
      'Scientific Visualization Studio',
      'CGI Moon Kit',
      'USGS Astrogeology Science Center',
      'IAU Gazetteer of Planetary Nomenclature',
    ]) {
      expect(CREDIT.html).toContain(part);
    }
  });
  it('keeps the deliberate U+2019 apostrophe and no ASCII impostor', () => {
    // The Global Constraints call out the typographic apostrophe specifically:
    // a hand-retyped "NASA's" would differ from the real string by one code
    // point, which is exactly the false-failure this task must not create.
    expect([...CREDIT.html].filter((c) => c === '’')).toHaveLength(1);
    expect(CREDIT.html).not.toContain("NASA's");
    expect(CREDIT.html.indexOf('’')).toBeGreaterThan(0);
  });
});

describe('the shared CREDIT singleton across provider rebuilds', () => {
  it('hands every provider the identical object, not a copy', () => {
    const a = makeProvider('photo', 6);
    const b = makeProvider('paper', 6);
    const c = makeProvider('photo', 6);
    expect(a.credit).toBe(CREDIT);
    expect(b.credit).toBe(CREDIT);
    expect(c.credit).toBe(a.credit);
    // Reading it through three providers must not have changed a character.
    expect(a.credit.html).toBe(CREDIT.html);
    expect(b.credit.html).toBe(CREDIT.html);
  });
  it('cannot be destroyed by an imagery-layer swap in Cesium 1.146', () => {
    // setLayer() removes every layer with destroyRemoved=true and then adds a
    // provider carrying this same object. Two facts make the credit survive
    // that, both checked here rather than asserted in prose:
    //  - a Credit exposes no destroy() in 1.146, and `ImageryLayer.destroy()`
    //    is `destroyObject(this)` — it poisons the *layer*, never the credit
    //    the layer merely referenced;
    //  - the credit lives on the *provider*, which is where Cesium's per-frame
    //    `updateCredits()` reads it back from (`layer.imageryProvider.credit`),
    //    so a rebuilt layer re-registers the identical singleton.
    const provider = makeProvider('photo', 6);
    expect(provider.credit).toBe(CREDIT);
    expect(typeof (CREDIT as unknown as { destroy?: unknown }).destroy).toBe('undefined');
    const layer = new Cesium.ImageryLayer(provider);
    // 1.146 has no public `layer.credit` accessor (verified: `undefined`), which
    // is exactly why the provider is the object that owns the credit.
    expect(
      (layer as unknown as { credit?: unknown }).credit,
    ).toBeUndefined();
    expect(layer.imageryProvider.credit).toBe(CREDIT);
    layer.destroy();
    expect(layer.isDestroyed()).toBe(true);
    // The singleton the attribution panel reads is untouched by that destroy.
    expect(CREDIT.html.length).toBeGreaterThan(40);
    expect([...CREDIT.html].filter((ch) => ch === '’')).toHaveLength(1);
    expect(makeProvider('paper', 6).credit).toBe(CREDIT);
  });
});

describe('attributionContent', () => {
  it('reuses the imported credit text', () => {
    expect(attributionContent(manifest).credit).toBe(CREDIT.html);
  });
  it('names the three products with their real resolutions', () => {
    const products = attributionContent(manifest).products;
    expect(products.map((p) => p.name)).toEqual([
      'LRO_WAC_Mosaic_Global_303ppd_v3.jp2',
      'lroc_color_poles.tif',
      'MOON_nomenclature_center_pts.zip',
    ]);
    expect(products.map((p) => p.detail)).toEqual([
      'detail mosaic, 100 m/px',
      'colour base, 76 px/deg',
      '9,087 gazetteer records',
    ]);
  });
  it('prints the bake date from the manifest, not from the clock', () => {
    expect(attributionContent(manifest).baked).toBe(manifest.generatedAt);
    expect(attributionContent(manifest).baked).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });
  it('degrades to a manifest-free credit when the bake has not run', () => {
    const empty = attributionContent(null);
    expect(empty.credit).toBe(CREDIT.html);
    expect(empty.products).toHaveLength(3);
    expect(empty.products.every((p) => p.name === 'not baked yet')).toBe(true);
    expect(empty.baked).toBe('not baked yet');
  });
});
