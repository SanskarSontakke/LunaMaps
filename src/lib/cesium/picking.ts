import * as Cesium from 'cesium';
import type { Feature } from '@/types';

/**
 * Left-click pick of a label/dot entity → its Feature (Task 12's feature card
 * consumes this). Returns the detach function.
 */
export function attachPicking(
  viewer: Cesium.Viewer,
  onPick: (feature: Feature | null) => void,
): () => void {
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  const read = (picked: unknown) => {
    const entity = picked as Cesium.Entity | undefined;
    const raw = entity?.properties?.feature?.getValue(viewer.clock.currentTime);
    onPick((raw as Feature) ?? null);
  };
  handler.setInputAction(
    (mov: { position: Cesium.Cartesian2 }) => read(viewer.scene.pick(mov.position)),
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
  );
  return () => handler.destroy();
}
