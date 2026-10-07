import { describe, expect, it } from 'vitest';
import { TIER_FROM_LEVEL, tierPriority, visibleTiers } from '@/lib/labels/tiers';
import { cameraHeightForLevel } from '@/lib/grid';

describe('visibleTiers', () => {
  it('shows only tier 0 and landing sites from deep space', () => {
    expect(visibleTiers(2e7, 900, 60)).toEqual([0, 3]);
  });
  it('adds tier 1 once a hemisphere fills the screen', () => {
    expect(visibleTiers(3.5e6, 900, 60)).toContain(1);
    expect(visibleTiers(3.5e6, 900, 60)).not.toContain(2);
  });
  it('adds tier 2 at regional scale', () => {
    // The grid-derived threshold for level 3 at a 900 px / 60° view is
    // cameraHeightForLevel(3, 900, 60) ≈ 1.0386e6 m; the brief's 1.2e6 sits
    // *above* it, so the principled tier-2 test height is 1.0e6. The exact
    // boundary is asserted below so this stays honest.
    expect(cameraHeightForLevel(3, 900, 60)).toBeGreaterThan(1.0e6);
    expect(cameraHeightForLevel(3, 900, 60)).toBeLessThan(1.2e6);
    expect(visibleTiers(1.0e6, 900, 60)).toEqual([0, 1, 2, 3]);
    expect(visibleTiers(1.2e6, 900, 60)).toEqual([0, 1, 3]);
  });
  it('never loses a tier at the closest zoom', () => {
    expect(visibleTiers(2_000, 900, 60)).toEqual([0, 1, 2, 3]);
  });
  it('keeps the documented level mapping', () => {
    expect(TIER_FROM_LEVEL).toEqual({ 0: null, 1: 1, 2: 3, 3: null });
  });
});

describe('tierPriority', () => {
  it('ranks lower tiers above higher ones', () => {
    expect(tierPriority(0, 1000)).toBeGreaterThan(tierPriority(1, 9000));
  });
  it('breaks ties inside a tier by size', () => {
    expect(tierPriority(2, 300)).toBeLessThan(tierPriority(2, 900));
  });
});
