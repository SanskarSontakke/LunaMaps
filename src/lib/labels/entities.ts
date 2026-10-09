import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, MOON_RADIUS_M } from '@/lib/cesium/moon';
import { declutterWithMarkers, type Box, type LabelBox } from './declutter';
import { tierPriority, createLabelGate, DENSITY_DEFAULT } from './tiers';
import { densityRanks, rankFor } from '@/lib/filters';
import type { Feature, FeatureCollection } from '@/types';

/**
 * The filter state `refresh` takes, in the shape the label layer can use without
 * knowing anything about controls. `MoonMap` builds it from
 * `src/lib/filters.ts`'s `applyFilters`, so the sidebar list and the map are
 * always two views of ONE predicate — which is the whole point of D10 ("filters
 * drive a collapsible sidebar list as well as map visibility") and the reason
 * this is a parameter of the refresh path rather than a `show` writer somewhere
 * else.
 */
export interface LabelFilter {
  /** The names the filters kept. `null`/absent means "every name". */
  names?: ReadonlySet<string> | null;
  /** The D9 density multiplier; omitted means `DENSITY_DEFAULT`, today exactly. */
  density?: number;
}

export interface LabelSet {
  refresh(heightM: number, filter?: LabelFilter): void;
  destroy(): void;
  readonly count: number;
  readonly shown: number;
}

/**
 * The per-character advance of `600 13px system-ui, sans-serif`, MEASURED rather
 * than guessed. `work/measure-labels.mjs` ran all 1,585 shipped names through
 * `CanvasRenderingContext2D.measureText` in the live page (headless Chrome, the
 * same font string Cesium rasterises with) and reported the width/length ratio:
 *
 * | ratio over the gazetteer | value | name |
 * |--------------------------|-------|------|
 * | p50 | 6.58 | — |
 * | p90 | 7.40 | — |
 * | p99 | 8.20 | — |
 * | max | 9.64 | `Ohm` (three wide capitals in 3 chars) |
 *
 * The constant this file used before was **6.6 — the median**, i.e. a box
 * narrower than the glyphs for roughly half the names and measurably narrower
 * for **57 of them** (`len × 6.6 + 8 < measured width`). A box that under-reports
 * is how two names touch on screen while the declutter believes it won, so the
 * constant is now **7.5: the smallest value at which zero of the 1,585 names are
 * under-reported**. It is a floor, not an average, and that is the whole
 * difference: an average culls too little, a floor culls a little too much.
 *
 * `LABEL_H` follows the same rule: measured ink is at most 13 px tall
 * (ascent 10 + descent 3, worst `Oppolzer`), plus the 2 px outline on each side,
 * so 16 under-reported vertically and 19 does not.
 *
 * The width cap is above every modelled name in this gazetteer (the longest is 30
 * characters → 233 px), so it never engages and cannot reintroduce an
 * under-report; it exists only for a name the bake has not written yet.
 *
 * None of this can be exact without asking the canvas on every frame, which is
 * the residual limitation `src/test/declutter.test.ts` pins by name.
 */
const CHAR_PX = 7.5;
const LABEL_H = 19;
const MAX_LABEL_W = 260;
/** The traverse dot's own footprint: `pixelSize: 4` plus a 1.5 px outline. */
const MARKER_HALF = 3.5;
/** How far a tier-3 name clears its own marker. The marker's own half-height is
 *  3.5 px, so 8 leaves a 4.5 px gap between the dot and the text's descenders —
 *  enough to read as two things, not enough to detach the name from its site. */
const LABEL_TEXT_GAP = 8;

function setLabelShow(entity: Cesium.Entity, show: boolean): void {
  if (!entity.label) return;
  const p = entity.label.show;
  if (p instanceof Cesium.ConstantProperty) p.setValue(show);
  else entity.label.show = new Cesium.ConstantProperty(show);
}

/** Does any part of `b` fall inside the `w × h` canvas? Hoisted so a refresh of
 *  1,585 entries allocates no closures. */
function boxOnScreen(b: Box, w: number, h: number): boolean {
  return b.x + b.w >= 0 && b.x <= w && b.y + b.h >= 0 && b.y <= h;
}

/**
 * Add every place name as a label entity (tier 3 also gets a traverse dot)
 * and expose a refresh that shows only what the camera height allows, what the
 * active filters keep, and what screen-space declutter leaves standing. All style
 * values here are product constants — low-contrast fill, dark outline, distance
 * fade.
 */
export function attachLabels(
  viewer: Cesium.Viewer,
  fc: FeatureCollection,
): LabelSet {
  // Where each name sits inside its own tier, so the density multiplier has
  // somewhere to bite. Built once: it depends only on the gazetteer, which is
  // fixed for the life of this LabelSet.
  const ranks = densityRanks(fc.features);
  const entries = fc.features.map((f: Feature) => {
    const [lon, lat] = f.geometry.coordinates;
    const isTraverse = f.properties.tier === 3;
    const entity = viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, 0, MOON_ELLIPSOID),
      properties: { feature: f },
      // Hidden until the first refresh; entity.show gates label and point.
      show: false,
      label: {
        text: f.properties.name,
        font: '600 13px system-ui, sans-serif',
        // 0.62 alpha over a highland that bakes at 200/255 is not a name, it is a
        // smudge — gate G3 defect 5. Near-opaque fill with a heavier dark outline
        // is what survives both mare and highland; `saturate()` on the canvas only
        // touches chroma, so this grey text is not tinted by it.
        fillColor: Cesium.Color.fromCssColorString('rgba(246,246,246,0.94)'),
        outlineColor: Cesium.Color.fromCssColorString('rgba(0,0,0,0.86)'),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        // A traverse name sits ABOVE its dot. With both origins at CENTER the dot
        // is painted through the middle of its own glyphs — `aristarchus-base.png`
        // has the amber marker of `West` on top of the `e`, and `Double`'s and
        // `Little West`'s markers inside the word `Double`. Centring a name on its
        // own marker is the one collision no declutter pass can see, because the
        // two boxes belong to the same entity and only one of them is in the
        // contest. Clearing the dot by `LABEL_TEXT_GAP` px makes a name's own
        // marker structurally un-overlappable, and the modelled box below moves
        // with it.
        verticalOrigin: isTraverse ? Cesium.VerticalOrigin.BOTTOM : Cesium.VerticalOrigin.CENTER,
        pixelOffset: isTraverse ? new Cesium.Cartesian2(0, -LABEL_TEXT_GAP) : undefined,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // The old pair faded to 0.25 by 2.2 Mm — which is *below* the whole-globe
        // home framing (2.64 Mm on a portrait canvas), so the default view showed
        // every name at its dimmest. The far stop now sits past the height that
        // frames the disc, and the floor is where a name is still a name.
        translucencyByDistance: new Cesium.NearFarScalar(2e4, 1.0, 6e6, 0.8),
        scaleByDistance: new Cesium.NearFarScalar(2e4, 1.0, 6e6, 0.85),
      },
    });
    if (isTraverse) {
      // A saturated amber disc with a black ring out-shouts every name on the
      // map, which is gate G3 defect 4. Two things bring it back: half the area
      // and a low alpha. Low alpha matters more than it looks, because the
      // canvas-wide `saturate()` in globe mode amplifies whatever chroma is
      // already in the pixel — a 0.85-alpha amber composites to a chroma the
      // filter then pushes to clipped orange.
      entity.point = new Cesium.PointGraphics({
        pixelSize: 4,
        color: Cesium.Color.fromCssColorString('rgba(255,214,102,0.3)'),
        outlineColor: Cesium.Color.fromCssColorString('rgba(0,0,0,0.8)'),
        outlineWidth: 1.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
    }
    return { entity, feature: f, rank: rankFor(ranks, f.properties.name) };
  });

  let shownCount = 0;
  // Scratch objects reused across refreshes (1,585 entities × 8 Hz).
  const nHat = new Cesium.Cartesian3();
  const toCam = new Cesium.Cartesian3();

  return {
    refresh(heightM: number, filter?: LabelFilter) {
      const scene = viewer.scene;
      const w = scene.canvas.clientWidth;
      const hgt = scene.canvas.clientHeight;
      // The tier gates are heights at which a tile level's ground resolution
      // matches the *screen*, so they have to be evaluated against the canvas
      // that is actually on screen. Called bare they assumed 900 px, which is
      // what `verify-11.md` measured 116 labels against while a live 786 px tab
      // showed 93. A zero-height canvas (detached, or a hidden tab mid-boot)
      // would drive every threshold to 0 and silently drop tiers 1 and 2, so the
      // fall-back keeps the documented assumption rather than inventing a worse
      // answer.
      const frustum = scene.camera.frustum;
      const fovDeg =
        frustum instanceof Cesium.PerspectiveFrustum
          ? Cesium.Math.toDegrees(frustum.fov ?? Math.PI / 3)
          : 60;
      // The density multiplier composes with the tier gates here and nowhere
      // else (D9): `createLabelGate` is `visibleTiers` at the default value, so a
      // refresh with no filter draws exactly what it drew before this existed.
      const gate = createLabelGate(
        hgt || 900,
        fovDeg,
        filter?.density ?? DENSITY_DEFAULT,
      );
      const openTiers = new Set(gate.tiersAt(heightM));
      const allowed = filter?.names ?? null;
      const now = viewer.clock.currentTime;
      const camPos = scene.camera.positionWC;
      // In 3D, the far side of the moon must not label through it
      // (disableDepthTestDistance is infinity, so nothing else stops it).
      const horizonTest = scene.mode === Cesium.SceneMode.SCENE3D;
      const candidates: { entity: Cesium.Entity; index: number }[] = [];
      const boxes: LabelBox[] = [];
      const markers: LabelBox[] = [];
      entries.forEach(({ entity, feature, rank }, i) => {
        entity.show = false;
        // A filtered-out name stops being drawn, here and only here: this is the
        // same predicate the sidebar lists, handed in as `filter.names`.
        if (allowed && !allowed.has(feature.properties.name)) return;
        const tier = feature.properties.tier;
        if (!openTiers.has(tier)) return;
        if (!gate.admits(tier, rank, heightM)) return;
        const pos = entity.position?.getValue(now) as Cesium.Cartesian3 | undefined;
        if (!pos) return;
        if (horizonTest) {
          // Surface point P is over the horizon iff the angle between the
          // outward normal and the camera direction at P is not acute.
          const n = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.multiplyByScalar(pos, 1 / MOON_RADIUS_M, nHat),
            nHat,
          );
          const v = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.subtract(camPos, pos, toCam),
            toCam,
          );
          if (Cesium.Cartesian3.dot(n, v) <= 0) return;
        }
        const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, pos);
        if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return;
        const bw = Math.min(feature.properties.name.length * CHAR_PX + 8, 220);
        // The text box follows the origin the entity was built with: a traverse
        // name's box sits `LABEL_TEXT_GAP + LABEL_H` above its anchor, every other
        // name's box is centred on it. A model that disagreed with the renderer
        // would declutter the wrong rectangles.
        const by =
          tier === 3 ? screen.y - LABEL_TEXT_GAP - LABEL_H : screen.y - LABEL_H / 2;
        const box = { x: screen.x - bw / 2, y: by, w: bw, h: LABEL_H };
        const markerBox = {
          x: screen.x - MARKER_HALF,
          y: screen.y - MARKER_HALF,
          w: MARKER_HALF * 2,
          h: MARKER_HALF * 2,
        };
        // Off-screen names would pollute the declutter contest; skip them. A
        // traverse site is kept while EITHER half is on screen: its name can sit
        // just outside the frame while its 7 px marker is not, and dropping the
        // marker with the name would make landing sites blink out at the edges.
        const textVisible = boxOnScreen(box, w, hgt);
        const markerVisible = tier === 3 && boxOnScreen(markerBox, w, hgt);
        if (!textVisible && !markerVisible) return;
        candidates.push({ entity, index: i });
        if (textVisible) {
          boxes.push({
            id: String(i),
            priority: tierPriority(tier, feature.properties.diameterKm),
            box,
          });
        }
        if (markerVisible) {
          markers.push({
            id: String(i),
            priority: tierPriority(tier, feature.properties.diameterKm),
            box: markerBox,
          });
        }
      });
      const { kept, keptMarkers } = declutterWithMarkers(boxes, markers);
      // The declutter ids are the `candidates` indices as strings; `Number` is
      // lossless here because they came from `String(i)` above.
      const keep = new Set(kept.map(Number));
      const keepMarker = new Set(keptMarkers.map(Number));
      shownCount = 0;
      for (const { entity, index } of candidates) {
        const on = keep.has(index);
        if (entries[index].feature.properties.tier === 3) {
          // The dot is the site; the name is its label. A name that loses the
          // declutter contest still leaves its marker standing — but only if the
          // marker itself did not land on a name that WON, which is the case
          // `aristarchus-base.png` shows and the reason `keptMarkers` exists.
          const dot = keepMarker.has(index);
          entity.show = on || dot;
          setLabelShow(entity, on);
        } else {
          entity.show = on;
        }
        if (on) shownCount++;
      }
      scene.requestRender();
    },
    get count() {
      return entries.length;
    },
    get shown() {
      return shownCount;
    },
    destroy() {
      for (const { entity } of entries) viewer.entities.remove(entity);
      entries.length = 0;
      shownCount = 0;
    },
  };
}
