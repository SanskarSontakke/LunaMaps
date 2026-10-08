import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// A function expression inside a useEffect dependency array makes the array's
// LENGTH differ between module versions, and React's dev invariant on that is a
// throw that replaces the whole page with "Application error" — no viewer, no
// labels, no harness. The mode effect hit exactly this. These assertions pin the
// shape of the file so it cannot come back.

const SRC = readFileSync(
  resolve(__dirname, '../components/MoonMap.tsx'),
  'utf8',
);

const DEPS = /}\s*,\s*\[([^\]]*)\]\s*\)/g;

function depsArrays(src: string): string[][] {
  const out: string[][] = [];
  for (const match of src.matchAll(DEPS)) {
    const inner = match[1].trim();
    out.push(inner.length === 0 ? [] : inner.split(/\s*,\s*/));
  }
  return out;
}

describe('MoonMap effect dependency arrays', () => {
  const arrays = depsArrays(SRC);

  it('finds the dependency arrays at all, so this suite cannot pass vacuously', () => {
    expect(arrays.length).toBeGreaterThanOrEqual(5);
  });

  it('never holds a function expression', () => {
    const offenders = arrays.filter((deps) =>
      deps.some((d) => /=>|function\b/.test(d)),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the mode effect on the fixed two-value latch', () => {
    expect(arrays).toContainEqual(['mode', 'modeNonce']);
    expect(
      arrays.filter((d) => d.some((x) => x.startsWith('applyModeAttempt'))),
    ).toEqual([]);
  });

  it('reaches the outcome handler through a ref, not a dependency', () => {
    expect(SRC).toMatch(/const applyModeAttemptRef = useRef\(applyModeAttempt\)/);
    expect(SRC).toMatch(/applyModeAttemptRef\.current = applyModeAttempt/);
    expect(SRC).toMatch(/applyModeAttemptRef\.current\(out\)/);
  });
});
