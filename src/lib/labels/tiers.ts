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
