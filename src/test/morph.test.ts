import { describe, expect, it } from 'vitest';
import { MIN_H, MAX_H, clampHeight, preserveState } from '@/lib/cesium/morph';

describe('clampHeight', () => {
  it('bounds the camera inside the controller limits', () => {
    expect(MIN_H).toBe(1_500);
    expect(MAX_H).toBe(3.5e7);
    expect(clampHeight(10)).toBe(MIN_H);
    expect(clampHeight(9e7)).toBe(MAX_H);
    expect(clampHeight(5e5)).toBe(5e5);
  });
});

describe('preserveState', () => {
  const s = { lonDeg: 23.4731, latDeg: 0.6746, height: 2e5, heading: 0.4, pitch: -1.2 };
  it('keeps the centre across a mode change', () => {
    const out = preserveState(s, 'paper');
    expect(out.lonDeg).toBeCloseTo(23.4731);
    expect(out.latDeg).toBeCloseTo(0.6746);
  });
  it('forces straight-down, no heading in paper mode', () => {
    const out = preserveState(s, 'paper');
    expect(out.pitch).toBeCloseTo(-Math.PI / 2);
    expect(out.heading).toBe(0);
  });
  it('keeps tilt freedom in globe mode', () => {
    const out = preserveState(s, 'globe');
    expect(out.pitch).toBe(-1.2);
    expect(out.heading).toBe(0.4);
  });
  it('keeps the pole visible instead of clipping it', () => {
    expect(preserveState({ ...s, latDeg: 89.9999 }, 'globe').latDeg).toBeLessThan(90);
  });
});
