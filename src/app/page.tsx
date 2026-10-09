'use client';
import dynamic from 'next/dynamic';

const MoonMap = dynamic(() => import('@/components/MoonMap'), { ssr: false });

/**
 * The landmark `src/app/globals.css` has styled since Task 15
 * (`html, body, main { height: 100% … }`) while nothing rendered it: the map was a
 * bare child of `<body>`, so the rule was dead and a screen reader navigating by
 * landmarks found no main region at all. The labelled, described map region is
 * `MoonMap`'s own host element; this is the page structure it belongs in.
 *
 * `MoonMap` stays `ssr: false` — Cesium needs a canvas, and the server render had
 * nothing to show — so the landmark is what the shell actually contains.
 */
export default function Home() {
  return (
    <main>
      <MoonMap />
    </main>
  );
}
