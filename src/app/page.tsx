'use client';
import dynamic from 'next/dynamic';

const MoonMap = dynamic(() => import('@/components/MoonMap'), { ssr: false });

export default function Home() {
  return <MoonMap />;
}
