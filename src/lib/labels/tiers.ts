import { cameraHeightForLevel } from '@/lib/grid';
import type { Tier } from '@/types';

/** Tier N becomes visible once the camera is close enough that the view's
 *  ground resolution matches tile level TIER_FROM_LEVEL[N]. Deriving the
 *  thresholds from the grid keeps them principled and viewport-aware instead
 *  of a set of magic numbers. Tiers 0 and 3 have no level gate: they always
 *  show. */
export const TIER_FROM_LEVEL: Record<Tier, number | null> = {
  0: null,
  1: 1,
  2: 3,
  3: null,
};

export function tierVisibleMaxHeight(
  tier: Tier,
  viewportPx: number,
  fovDeg: number,
): number {
  const level = TIER_FROM_LEVEL[tier];
  return level === null ? Infinity : cameraHeightForLevel(level, viewportPx, fovDeg);
}

export function visibleTiers(heightM: number, viewportPx = 900, fovDeg = 60): Tier[] {
  return ([0, 1, 2, 3] as Tier[]).filter(
    (t) => heightM <= tierVisibleMaxHeight(t, viewportPx, fovDeg),
  );
}

/**
 * Declutter ranking. Lower tiers always outrank higher ones; inside a tier,
 * bigger features win. Tier 3 gets a mid-tier boost so an astronaut-named
 * traverse label beats a random tier-2 crater but never a tier-0 mare.
 */
export function tierPriority(tier: Tier, diameterKm: number | null): number {
  const base = (3 - tier) * 1e6;
  const size = Math.min(diameterKm ?? 0, 9_999) * 10;
  return base + size + (tier === 3 ? 5e5 : 0);
}

// ------------------------------------------------------------------- density --

/**
 * Amendment 2's D9 density control: **a multiplier on the tier gates above**, not
 * a second visibility system. `1` is the shipped default and is the identity —
 * `densityHeightScale(1, rank) === 1` for every rank, so at the default every
 * gate is exactly the altitude `tierVisibleMaxHeight` gives and
 * `createLabelGate(...).admits(...)` reduces to `visibleTiers(...).includes(...)`.
 * `src/test/tiers.test.ts` pins that reduction over a sweep of heights and
 * viewports, which is the equivalence proof for "default density is today's
 * behaviour".
 */
export const DENSITY_DEFAULT = 1;

/** Sparsest (only the biggest names of a tier, and only up close) … */
export const DENSITY_MIN = 0.2;
/** … densest (a tier's tail is admitted from `3×` its gate altitude). */
export const DENSITY_MAX = 3;

export const clampDensity = (density: number): number =>
  Number.isFinite(density)
    ? Math.min(Math.max(density, DENSITY_MIN), DENSITY_MAX)
    : DENSITY_DEFAULT;

/** A rank is a position in `[0, 1]`; anything outside is clamped, not trusted. */
const clampRank = (rank: number): number =>
  Number.isFinite(rank) ? Math.min(Math.max(rank, 0), 1) : 0;

/**
 * How far a name's gate altitude moves for a density setting.
 *
 * `rank` is the name's position inside its OWN tier — `0` for the largest name in
 * it, `1` for the tail (see `filters.ts`'s `densityRanks`, which builds it from
 * `tierPriority`). The scale is linear in `rank` between the two ends:
 *
 * | density | rank 0 (the tier's biggest names) | rank 1 (its tail) |
 * |---------|-----------------------------------|-------------------|
 * | `0.2`   | `1.0` — unchanged                   | `0.2` — 5× closer |
 * | `1`     | `1.0`                               | `1.0`             |
 * | `3`     | `1.0` — unchanged                   | `3.0` — 3× higher |
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * - **The head of a tier never disappears before the tier itself does.** Rank 0
 *   is pinned at scale 1, so lowering density removes names *within* a tier and
 *   cannot empty one that the camera height still admits. A control that hid
 *   `Oceanus Procellarum` while showing a 20 km crater would be a broken control.
 * - **The scale is always positive** (`>= DENSITY_MIN`), so multiplying an
 *   ungated tier's `Infinity` by it cannot produce `NaN` — tiers 0 and 3 stay
 *   visible at any density, exactly as they are today.
 */
export function densityHeightScale(density: number, rank = 0): number {
  const d = clampDensity(density);
  const u = clampRank(rank);
  // The interpolation is written once because it is the same line in both
  // directions; the outer clamp is not decoration. `1 - (1 - 0.2) * 1` is
  // `0.19999999999999996` in IEEE-754, i.e. a hair below `DENSITY_MIN`, and an
  // invariant the tests read as exact needs to be exact at the endpoints rather
  // than approximately so.
  const scale = 1 + (d - 1) * u;
  return Math.min(Math.max(scale, DENSITY_MIN), DENSITY_MAX);
}

export interface LabelGate {
  /** The tiers with at least one drawable name at this height, this density. */
  tiersAt(heightM: number): Tier[];
  /** May THIS name — `rank` inside its tier — be drawn at this height? */
  admits(tier: Tier, rank: number, heightM: number): boolean;
  /** The density the gate was built at, clamped. */
  readonly density: number;
}

/**
 * The per-refresh gate `labels/entities.ts` builds from the live canvas.
 *
 * `viewportPx` and `fovDeg` are the same two facts `visibleTiers` needs, and for
 * the same reason: the tier gates are heights at which a tile level's ground
 * resolution matches *this screen*, so they have to be evaluated against the
 * canvas actually on it (amendment 2 §5.5 — assuming 900 px is what made
 * `verify-11.md`'s 116 labels disagree with a live tab's 93).
 *
 * At `DENSITY_DEFAULT` `tiersAt` IS `visibleTiers`, called through one branch on
 * purpose: the shipped behaviour then has the old function's identity rather than
 * merely its numbers.
 */
export function createLabelGate(
  viewportPx: number,
  fovDeg: number,
  density: number = DENSITY_DEFAULT,
): LabelGate {
  const d = clampDensity(density);
  const neutral = d === DENSITY_DEFAULT;
  // The most permissive scale this density can reach, used for the coarse
  // "could any name of this tier be here?" answer. Above the default the tail is
  // pushed outward, so the coarse set is WIDER than `visibleTiers`; below it the
  // head is unmoved, so the coarse set is exactly `visibleTiers`.
  const maxScale = Math.max(1, d);
  const gate = (tier: Tier): number =>
    tierVisibleMaxHeight(tier, viewportPx, fovDeg);
  return {
    density: d,
    tiersAt(heightM: number): Tier[] {
      if (neutral) return visibleTiers(heightM, viewportPx, fovDeg);
      return ([0, 1, 2, 3] as Tier[]).filter(
        (t) => heightM <= gate(t) * maxScale,
      );
    },
    admits(tier: Tier, rank: number, heightM: number): boolean {
      // No branch on `neutral` here: `densityHeightScale(1, u)` is exactly `1`,
      // and `x * 1 === x` for every finite `x` and for `Infinity`, so the default
      // density reaches the same comparison `visibleTiers` makes. The equivalence
      // test measures it rather than trusting that sentence.
      return heightM <= gate(tier) * densityHeightScale(d, rank);
    },
  };
}

