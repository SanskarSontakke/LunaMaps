/**
 * Spec §4.5's performance budget, as arithmetic.
 *
 * The clause that is easy to misread is "no more than 16 simultaneous tile
 * requests". It is not about how many requests a view *issues* — a busy zoom can
 * issue hundreds — it is about how many are in flight at the same instant. That
 * quantity has one honest observable in a browser: the `[startTime, responseEnd]`
 * window every `PerformanceResourceTiming` entry carries. The peak is the maximum
 * number of those windows that overlap, which is what `peakConcurrency` computes.
 *
 * What the measurement is NOT: the entries are the page's view of the network, so
 * the peak is derived from `PerformanceEntry` overlap, not read out of Cesium's
 * scheduler internals (`RequestScheduler.statistics`). The two can disagree, and
 * the disagreement is worth knowing about — see the note in
 * `docs/superpowers/specs/gate-G3-live.md` (the 2026-10-09 §4.5 section): a
 * request Cesium has issued but the browser is holding behind a socket limit still
 * has no resource-timing entry until it is actually sent, so this measure reports
 * what reached the wire, which is the number the clause cares about.
 *
 * Pure: no DOM, no `performance`, no Cesium. Takes an array shaped like
 * `PerformanceEntry[]` so the same function that summarises a live probe run is
 * the one `src/test/perfBudget.test.ts` drives with hand-built intervals.
 */

/** The subset of `PerformanceResourceTiming` these calculations read. Real
 *  entries carry much more; anything extra is ignored. */
export interface TilePerfEntry {
  readonly name: string;
  /** When the browser began fetching, relative to timeOrigin (ms). */
  readonly startTime: number;
  /** When the first byte of the response arrived. Absent for a cached or
   *  same-process response, which is why the latency figure is opt-in. */
  readonly responseStart?: number;
  /** When the last byte arrived (ms). */
  readonly responseEnd: number;
}

/** One budget clause, answered. `medianMs`/`p95Ms` are NaN when there were no
 *  matching entries — "nothing to average" is not the same fact as "0 ms", and
 *  collapsing them would let a view that requested nothing look compliant. */
export interface LoadSummary {
  /** Maximum number of in-flight tile requests at any instant. */
  peak: number;
  /** Median of the durations, in ms. */
  medianMs: number;
  /** 95th percentile of the durations, in ms. */
  p95Ms: number;
  /** Entries the numbers are computed over. */
  count: number;
}

/** The four numbers §4.5 asks for, transcribed from
 * `docs/superpowers/specs/2026-10-06-lunar-map-explorer-design.md` §4.5. They are
 * the spec's, not a measurement; everything measured in this repo lives in the
 * gate record next to the choice it justified. */
export const SPEC_BUDGET = {
  maxSimultaneousTileRequests: 16,
  medianTileResponseMs: 150,
  l0PaintedMs: 3000,
  tabMemoryGb: 1.2,
} as const;

/** Every baked layer is served from `/tiles/<layer>/<level>/<x>/<y>.jpg`; that
 *  path is what makes a resource entry a tile request. */
export const TILE_PATH = /\/tiles\/[^/]+\/\d+\//;

export const isTileEntry = (entry: TilePerfEntry): boolean =>
  TILE_PATH.test(entry.name);

/**
 * The in-flight window of one entry. `startTime → responseEnd` is the interval
 * the page should count, because it spans the whole time a tile was being
 * fetched; `responseStart → responseEnd` would ignore the bytes of the response
 * that are still arriving and understate overlap.
 */
export const inFlightMs = (entry: TilePerfEntry): number =>
  Math.max(0, entry.responseEnd - entry.startTime);

/** Nearest-rank percentile of an already-sorted ascending array: the value at
 *  index `ceil(q * n) - 1`. No interpolation, so the result is always a duration
 *  that was actually observed. Empty input returns NaN rather than 0. */
export function percentileSorted(sorted: readonly number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const rank = Math.max(1, Math.ceil(q * n));
  return sorted[rank - 1];
}

/**
 * Maximum overlap of the entries' in-flight windows.
 *
 * Sweep line: +1 at each `startTime`, -1 at each `responseEnd`, walked in time
 * order. Two conventions matter and both are pinned by tests:
 *
 *  1. At an exact tie the end is processed before the start, so a request that
 *     finishes at t and one that starts at t are NOT counted together — the
 *     window is half-open, `[startTime, responseEnd)`.
 *  2. An entry whose window is empty (`responseEnd <= startTime`, which is what a
 *     memory-cache hit reports) cannot overlap anything measurable and is skipped
 *     for the peak. It still counts in `count`, because it was a request.
 */
export function peakConcurrency(entries: readonly TilePerfEntry[]): number {
  type Event = { t: number; delta: 1 | -1 };
  const events: Event[] = [];
  for (const entry of entries) {
    const start = entry.startTime;
    const end = entry.responseEnd;
    if (!(end > start)) continue;
    events.push({ t: start, delta: 1 });
    events.push({ t: end, delta: -1 });
  }
  events.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t - b.t));
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.delta;
    if (active > peak) peak = active;
  }
  return peak;
}

/** Duration used for the latency clause. `in-flight` (the default) is the whole
 *  fetch; `response` is `responseEnd - responseStart`, the shorter number a
 *  server-side log would report. Entries with no `responseStart` are skipped for
 *  `response`, since inventing a start time would invent a latency. */
export type LatencyBasis = 'in-flight' | 'response';

function durationOf(entry: TilePerfEntry, basis: LatencyBasis): number | null {
  if (basis === 'in-flight') return inFlightMs(entry);
  if (typeof entry.responseStart !== 'number' || !Number.isFinite(entry.responseStart)) {
    return null;
  }
  return Math.max(0, entry.responseEnd - entry.responseStart);
}

/**
 * Summarise a set of resource entries against §4.5.
 *
 * `entries` may be raw `PerformanceEntry[]` objects — the fields read here are a
 * subset. Filtering to tile requests happens inside, so passing every resource on
 * the page is safe; pass `match: () => true` to summarise an already-filtered
 * list (e.g. one layer's requests).
 */
export function summarizeTileLoad(
  entries: readonly TilePerfEntry[],
  options: { match?: (entry: TilePerfEntry) => boolean; basis?: LatencyBasis } = {},
): LoadSummary {
  const match = options.match ?? isTileEntry;
  const basis: LatencyBasis = options.basis ?? 'in-flight';
  const tiles = entries.filter(match);
  const durations: number[] = [];
  for (const entry of tiles) {
    const d = durationOf(entry, basis);
    if (d !== null) durations.push(d);
  }
  durations.sort((a, b) => a - b);
  return {
    peak: peakConcurrency(tiles),
    medianMs: round2(percentileSorted(durations, 0.5)),
    p95Ms: round2(percentileSorted(durations, 0.95)),
    count: tiles.length,
  };
}

const round2 = (value: number) =>
  Number.isFinite(value) ? Number(value.toFixed(2)) : value;

/** The two clauses a `LoadSummary` can answer, as pass/fail. `null` means the
 *  measurement had no data for that clause, which is reported rather than called
 *  a pass. */
export function budgetVerdict(summary: LoadSummary): {
  concurrencyMet: boolean;
  latencyMet: boolean | null;
} {
  return {
    concurrencyMet: summary.peak <= SPEC_BUDGET.maxSimultaneousTileRequests,
    latencyMet: Number.isFinite(summary.medianMs)
      ? summary.medianMs <= SPEC_BUDGET.medianTileResponseMs
      : null,
  };
}
