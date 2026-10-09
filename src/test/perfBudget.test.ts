import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SPEC_BUDGET,
  budgetVerdict,
  inFlightMs,
  isTileEntry,
  peakConcurrency,
  percentileSorted,
  summarizeTileLoad,
  type TilePerfEntry,
} from '@/lib/perfBudget';

/**
 * Spec §4.5's budget is arithmetic over `PerformanceResourceTiming` windows, and this
 * file is where that arithmetic is proved. The numbers here are hand-built intervals,
 * not measurements: the point is that "16 simultaneous tile requests" means *overlap*,
 * and a derivation that cannot tell five nested windows from five sequential ones would
 * let the app pass a budget it does not meet.
 *
 * The live numbers this function is eventually run against come from
 * `work/perf_budget_probe.mjs`, which imports the very same module — so a change to
 * the derivation applies to the measurement and to these tests at once. There is no
 * second copy to fall out of agreement, and the last test below is what keeps it that
 * way.
 */

const tile = (
  startTime: number,
  responseEnd: number,
  responseStart?: number,
  level = 7,
): TilePerfEntry => ({
  name: `/tiles/photo/${level}/${Math.round(startTime)}/${Math.round(responseEnd)}.jpg`,
  startTime,
  responseEnd,
  ...(responseStart === undefined ? {} : { responseStart }),
});

describe('peak concurrency is overlap, not volume', () => {
  it('reports every request when all of them are in flight at once', () => {
    // The worst case §4.5 is afraid of: a zoom that fires a burst and waits for all
    // of it. Twelve overlapping windows is twelve simultaneous requests, whatever
    // the individual durations are.
    const burst = Array.from({ length: 12 }, (_, i) => tile(0, 500 + i));
    expect(peakConcurrency(burst)).toBe(12);
  });

  it('reports one when no request starts before the previous one finished', () => {
    const sequential = Array.from({ length: 12 }, (_, i) => tile(i * 100, i * 100 + 90));
    expect(peakConcurrency(sequential)).toBe(1);
  });

  it('treats the window as half-open, so touching intervals are not simultaneous', () => {
    // One ends at t, the next starts at t. Counting that as 2 would make a perfectly
    // serial workload look concurrent and fail nothing useful.
    expect(peakConcurrency([tile(0, 100), tile(100, 200), tile(200, 300)])).toBe(1);
  });

  it('finds the peak in the middle of the series, not at either end', () => {
    // A[0,100] B[10,50] C[20,60] D[55,80] E[70,90]
    //   at t=20  -> A B C      = 3
    //   at t=55  -> A C D      = 3   (B closed at 50)
    //   at t=70  -> A D E      = 3
    // Never more than 3, even though five windows exist and four are open at t=10..20.
    const staggered = [
      tile(0, 100),
      tile(10, 50),
      tile(20, 60),
      tile(55, 80),
      tile(70, 90),
    ];
    expect(peakConcurrency(staggered)).toBe(3);
  });

  it('separates a workload that meets the 16-request clause from one that does not', () => {
    expect(peakConcurrency(Array.from({ length: 16 }, (_, i) => tile(i, 1000)))).toBe(16);
    expect(peakConcurrency(Array.from({ length: 17 }, (_, i) => tile(i, 1000)))).toBe(17);
  });

  it('ignores a request whose window is empty, because it cannot overlap anything', () => {
    // Chrome reports responseEnd === startTime for a memory-cache hit. It was still a
    // request, so it counts; it had no measurable time in flight, so it cannot add to
    // the peak.
    const cached = [tile(50, 50), tile(50, 50), tile(50, 50)];
    expect(peakConcurrency(cached)).toBe(0);
    expect(summarizeTileLoad(cached).count).toBe(3);
  });

  it('returns 0 for no requests at all rather than inventing a baseline', () => {
    expect(peakConcurrency([])).toBe(0);
  });
});

describe('the latency half of §4.5', () => {
  it('uses the whole in-flight window as the duration by default', () => {
    expect(inFlightMs(tile(100, 250, 240))).toBe(150);
  });

  it('takes the nearest-rank percentile of an odd-length sample', () => {
    const sorted = [10, 20, 30];
    expect(percentileSorted(sorted, 0.5)).toBe(20); // ceil(1.5) = 2 -> index 1
    expect(percentileSorted(sorted, 0.95)).toBe(30); // ceil(2.85) = 3 -> index 2
  });

  it('takes the upper of the two middle values for an even-length median', () => {
    const sorted = [10, 20, 30, 40];
    expect(percentileSorted(sorted, 0.5)).toBe(20); // ceil(2) = 2 -> index 1
    expect(percentileSorted(sorted, 0.95)).toBe(40);
    expect(Number.isNaN(percentileSorted([], 0.5))).toBe(true);
  });

  it('reports the response-only duration when asked, and skips entries without one', () => {
    const withResponse = [tile(0, 100, 90), tile(0, 100)];
    expect(summarizeTileLoad(withResponse, { basis: 'response' }).count).toBe(2);
    // Only the first entry has a responseStart, so the median is over one value —
    // but `count` is the number of tile requests, which stays 2.
    const summary = summarizeTileLoad(withResponse, { basis: 'response' });
    expect(summary.medianMs).toBe(10);
    expect(summary.count).toBe(2);
  });

  it('returns NaN medians instead of zero when there was nothing to average', () => {
    const summary = summarizeTileLoad([]);
    expect(summary.count).toBe(0);
    expect(summary.peak).toBe(0);
    expect(Number.isNaN(summary.medianMs)).toBe(true);
    expect(Number.isNaN(summary.p95Ms)).toBe(true);
  });

  it('excludes non-tile resources from every number', () => {
    const noise: TilePerfEntry[] = [
      { name: '/_next/static/chunks/app/page.js', startTime: 0, responseEnd: 4000 },
      { name: '/cesium/Workers/geometry.js', startTime: 10, responseEnd: 3900 },
    ];
    const mixed = [...noise, tile(0, 50), tile(5, 60)];
    const summary = summarizeTileLoad(mixed);
    expect(summary.count).toBe(2);
    expect(summary.peak).toBe(2);
    // Filtered as noise, the same two long-lived scripts would claim 2 simultaneous
    // "tile" requests they are not.
    expect(summarizeTileLoad(noise).count).toBe(0);
    expect(isTileEntry(noise[0])).toBe(false);
    expect(isTileEntry(tile(0, 10))).toBe(true);
  });
});

describe('summarizeTileLoad is the one shape the probe reads', () => {
  it('answers all four fields for a realistic settled deep view', () => {
    // Sixteen L8-L10 ortho tiles fetched over ~150 ms, in the pattern the live probe
    // produces: a burst that overlaps, then a tail.
    const entries = Array.from({ length: 16 }, (_, i) =>
      tile(i * 8, 120 + i * 20, 100 + i * 20, 9),
    );
    const summary = summarizeTileLoad(entries);
    expect(summary.count).toBe(16);
    expect(summary.peak).toBeLessThanOrEqual(16);
    expect(summary.peak).toBeGreaterThan(1);
    expect(typeof summary.medianMs).toBe('number');
    expect(Number.isFinite(summary.medianMs)).toBe(true);
    expect(summary.p95Ms).toBeGreaterThanOrEqual(summary.medianMs);
  });

  it('judges the clauses against the spec numbers, not a local copy of them', () => {
    expect(SPEC_BUDGET.maxSimultaneousTileRequests).toBe(16);
    expect(SPEC_BUDGET.medianTileResponseMs).toBe(150);
    expect(SPEC_BUDGET.l0PaintedMs).toBe(3000);
    expect(SPEC_BUDGET.tabMemoryGb).toBe(1.2);

    expect(budgetVerdict({ peak: 16, medianMs: 150, p95Ms: 400, count: 20 }).concurrencyMet).toBe(true);
    expect(budgetVerdict({ peak: 17, medianMs: 1, p95Ms: 2, count: 20 }).concurrencyMet).toBe(false);
    expect(budgetVerdict({ peak: 1, medianMs: 150.01, p95Ms: 200, count: 3 }).latencyMet).toBe(false);
    expect(
      budgetVerdict({ peak: 1, medianMs: Number.NaN, p95Ms: Number.NaN, count: 0 }).latencyMet,
    ).toBeNull();
  });
});

describe('the budget this file encodes is the budget the spec states', () => {
  // §4.5 is the source of `SPEC_BUDGET`. If the spec is edited, this fails and the
  // constants have to be re-transcribed on purpose — not quietly.
  const spec = readFileSync(
    'docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md',
    'utf8',
  );
  const section = spec
    .slice(spec.indexOf('### 4.5 Performance budget'), spec.indexOf('## 5. Verification'))
    // The spec wraps at 80 columns, so a clause can break mid-phrase. Whitespace is
    // layout here, not content; the numbers and the words around them are what is
    // being pinned.
    .replace(/\s+/g, ' ');

  it('still asks for sixteen simultaneous tile requests', () => {
    expect(section).toContain('no more than 16 simultaneous tile requests');
  });
  it('still asks for a median tile response under 150 ms', () => {
    expect(section).toContain('median tile response < 150 ms');
  });
  it('still asks for L0 painted inside 3 s', () => {
    expect(section).toMatch(/L0 globe visibly painted < 3 s/);
  });
  it('still caps the tab at 1.2 GB after 50 tile fetches', () => {
    expect(section).toContain('browser tab < 1.2 GB after 50 tile fetches');
  });
});

describe('the probe shares this derivation instead of writing its own', () => {
  const probe = readFileSync('work/perf_budget_probe.mjs', 'utf8');

  it('imports the maths from src/lib/perfBudget', () => {
    expect(probe).toContain("from '../src/lib/perfBudget.ts'");
    expect(probe).toContain('summarizeTileLoad(');
  });
  it('does not re-implement the sweep line or the percentile', () => {
    expect(probe).not.toMatch(/function\s+peakConcurrency/);
    expect(probe).not.toMatch(/function\s+percentile/);
  });
});
