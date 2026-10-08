import * as Cesium from 'cesium';
import { MOON_ELLIPSOID, MOON_RADIUS_M } from '@/lib/cesium/moon';
import { declutter, type LabelBox } from './declutter';
import { tierPriority, visibleTiers } from './tiers';
import type { Feature, FeatureCollection } from '@/types';

export interface LabelSet {
  refresh(heightM: number): void;
  destroy(): void;
  readonly count: number;
  readonly shown: number;
}

const CHAR_PX = 6.6;
const LABEL_H = 16;

function setLabelShow(entity: Cesium.Entity, show: boolean): void {
  if (!entity.label) return;
  const p = entity.label.show;
  if (p instanceof Cesium.ConstantProperty) p.setValue(show);
  else entity.label.show = new Cesium.ConstantProperty(show);
}

/**
 * Add every place name as a label entity (tier 3 also gets a traverse dot)
 * and expose a refresh that shows only what the camera height allows and what
 * screen-space declutter leaves standing. All style values here are product
 * constants — low-contrast fill, dark outline, distance fade.
 */
export function attachLabels(viewer: Cesium.Viewer, fc: FeatureCollection): LabelSet {
  const entries = fc.features.map((f: Feature) => {
    const [lon, lat] = f.geometry.coordinates;
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
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // The old pair faded to 0.25 by 2.2 Mm — which is *below* the whole-globe
        // home framing (2.64 Mm on a portrait canvas), so the default view showed
        // every name at its dimmest. The far stop now sits past the height that
        // frames the disc, and the floor is where a name is still a name.
        translucencyByDistance: new Cesium.NearFarScalar(2e4, 1.0, 6e6, 0.8),
        scaleByDistance: new Cesium.NearFarScalar(2e4, 1.0, 6e6, 0.85),
      },
    });
    if (f.properties.tier === 3) {
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
    return { entity, feature: f };
  });

  let shownCount = 0;
  // Scratch objects reused across refreshes (600 entities × 8 Hz).
  const nHat = new Cesium.Cartesian3();
  const toCam = new Cesium.Cartesian3();

  return {
    refresh(heightM: number) {
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
      const tiers = new Set(visibleTiers(heightM, hgt || 900, fovDeg));
      const now = viewer.clock.currentTime;
      const camPos = scene.camera.positionWC;
      // In 3D, the far side of the moon must not label through it
      // (disableDepthTestDistance is infinity, so nothing else stops it).
      const horizonTest = scene.mode === Cesium.SceneMode.SCENE3D;
      const candidates: { entity: Cesium.Entity; index: number }[] = [];
      const boxes: LabelBox[] = [];
      entries.forEach(({ entity, feature }, i) => {
        entity.show = false;
        if (!tiers.has(feature.properties.tier)) return;
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
        const box = { x: screen.x - bw / 2, y: screen.y - LABEL_H / 2, w: bw, h: LABEL_H };
        // Off-screen names would pollute the declutter contest; skip them.
        if (box.x + box.w < 0 || box.x > w || box.y + box.h < 0 || box.y > hgt) return;
        candidates.push({ entity, index: i });
        boxes.push({
          id: String(i),
          priority: tierPriority(feature.properties.tier, feature.properties.diameterKm),
          box,
        });
      });
      const keep = new Set(declutter(boxes).map(Number));
      shownCount = 0;
      for (const { entity, index } of candidates) {
        const on = keep.has(index);
        if (entries[index].feature.properties.tier === 3) {
          // Traverse dots survive declutter; only their text competes.
          entity.show = true;
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
