'use client';
import { useEffect, useRef } from 'react';
import type * as Cesium from 'cesium';
import { createMoonViewer } from '@/lib/cesium/moon';

declare global {
  // Exposed for the browser verification harness only.
  var __moonViewer: Cesium.Viewer | undefined;
  var CESIUM_BASE_URL: string | undefined;
}

export default function MoonMap() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);

  useEffect(() => {
    globalThis.CESIUM_BASE_URL = '/cesium';
    const host = hostRef.current;
    if (!host || viewerRef.current) return;
    const viewer = createMoonViewer(host, { layer: 'probe', top: 1, mode: 'globe' });
    viewerRef.current = viewer;
    globalThis.__moonViewer = viewer;
    return () => {
      viewer.destroy();
      viewerRef.current = null;
      globalThis.__moonViewer = undefined;
    };
  }, []);

  return <div ref={hostRef} id="cesiumContainer" className="map-host" />;
}
