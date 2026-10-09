import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DENSITY_DEFAULT,
  DENSITY_MAX,
  DENSITY_MIN,
  TIER_FROM_LEVEL,
  clampDensity,
  createLabelGate,
  densityHeightScale,
  tierPriority,
  tierVisibleMaxHeight,
  visibleTiers,
} from '@/lib/labels/tiers';
import { cameraHeightForLevel } from '@/lib/grid';
import type { Tier } from '@/types';

const TIERS: Tier[] = [0, 1, 2, 3];
/** Every viewport this project has actually measured a frame at, plus the 900 px
 *  the model used to assume. */
const VIEWPORTS = [900, 805, 786, 564, 420];
/** Heights from 1 km to the whole-disc framing, spanning both tier gates. */
const HEIGHTS = [
  1e3, 5e3, 2e4, 1e5, 5e5, 1.0e6, 1.2e6, 2e6, 3.5e6, 6e6, 1e7, 2.6e7,
];

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
  it('answers at the viewport it is given, not the one it assumes', () => {
    // The 116-vs-93 label gap in verify-11.md was this: the same height on a
    // 786 px canvas has a lower tier-2 gate than on the assumed 900 px one, so
    // the shorter view drops a whole tier. Neither number was wrong; the
    // assumption was.
    expect(visibleTiers(1.0e6, 900, 60)).toEqual([0, 1, 2, 3]);
    expect(visibleTiers(1.0e6, 786, 60)).toEqual([0, 1, 3]);
  });
  it('is called with the live canvas, not the default', () => {
    // Static assertion, because `attachLabels` needs a WebGL scene to run. The
    // defect this guards against is invisible from the module under test: the
    // parameters exist and are correct, and the caller left them out.
    //
    // The density control moved this call site from `visibleTiers` to
    // `createLabelGate` (which wraps the same gates), so the rule is pinned on
    // the new name — and pinned the same way: the live canvas height with the
    // documented `|| 900` fall-back, never a bare default.
    const src = readFileSync('src/lib/labels/entities.ts', 'utf8');
    expect(src).toMatch(
      /createLabelGate\(\s*hgt \|\| 900,\s*fovDeg,\s*filter\?\.density \?\? DENSITY_DEFAULT,?\s*\)/,
    );
    expect(src).not.toMatch(/createLabelGate\(\s*900\s*,/);
    expect(src).not.toMatch(/createLabelGate\(\s*hgt\s*\)/);
    // The zero-canvas guard survived the refactor: a 0 px canvas must not drive
    // every threshold to 0 and silently drop tiers 1 and 2.
    expect(src).toMatch(/hgt \|\| 900/);
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

// ---------------------------------------------------------------- D9 density --

describe('densityHeightScale: the default is the identity, and only the default', () => {
  it('returns exactly 1 at DENSITY_DEFAULT for every rank', () => {
    // This one line is the kernel of the equivalence proof: if the scale is 1,
    // multiplying a gate altitude by it changes nothing, so the shipped default
    // cannot differ from the behaviour before the control existed. `===` rather
    // than `toBeCloseTo` on purpose — a near-1 would move a boundary somewhere.
    for (const rank of [0, 0.25, 0.5, 0.75, 1, 0.999999]) {
      expect(densityHeightScale(DENSITY_DEFAULT, rank)).toBe(1);
    }
  });
  it('is 1 at rank 0 for EVERY density: the head of a tier never goes early', () => {
    // A density control that hid `Oceanus Procellarum` (tier 0) while showing a
    // 20 km crater would be broken by construction, so this is checked across the
    // whole range, not just the ends.
    for (const d of [DENSITY_MIN, 0.5, 0.9, 1, 1.5, 2, DENSITY_MAX, 999]) {
      expect(densityHeightScale(d, 0)).toBe(1);
    }
  });
  it('reaches the density itself at the tail of a tier, both directions', () => {
    expect(densityHeightScale(0.4, 1)).toBeCloseTo(0.4, 12);
    expect(densityHeightScale(2, 1)).toBeCloseTo(2, 12);
  });
  it('is monotone in rank and never zero, so Infinity gates stay Infinity', () => {
    const ranks = [0, 0.2, 0.4, 0.6, 0.8, 1];
    // Below the default the scale falls as the rank rises (the tail closes
    // first); above it, the scale rises (the tail opens first). Either way it is
    // monotone, never zero, and pinned at 1 at rank 0.
    for (const d of [DENSITY_MIN, 0.3, 0.5, 0.75, 1, 1.5, 2, DENSITY_MAX]) {
      const scales = ranks.map((r) => densityHeightScale(d, r));
      const nonDecreasing = scales.every((s, i) => i === 0 || s >= scales[i - 1] - 1e-12);
      const nonIncreasing = scales.every((s, i) => i === 0 || s <= scales[i - 1] + 1e-12);
      expect(nonDecreasing || nonIncreasing, `d=${d}`).toBe(true);
      expect(scales[0]).toBe(1);
      for (const s of scales) expect(s).toBeGreaterThanOrEqual(DENSITY_MIN);
    }
    // Tiers 0 and 3 have no gate altitude; `Infinity × anything positive` is still
    // Infinity, which is why no density can hide a mare or a landing site.
    for (const tier of [0, 3] as Tier[]) {
      for (const d of [DENSITY_MIN, 0.5, 1, 2, DENSITY_MAX]) {
        for (const rank of [0, 0.5, 1]) {
          expect(tierVisibleMaxHeight(tier, 900, 60) * densityHeightScale(d, rank)).toBe(
            Infinity,
          );
        }
      }
    }
  });
  it('refuses to be driven out of range by garbage', () => {
    expect(clampDensity(Number.NaN)).toBe(DENSITY_DEFAULT);
    expect(clampDensity(-5)).toBe(DENSITY_MIN);
    expect(clampDensity(1e9)).toBe(DENSITY_MAX);
    expect(clampDensity(0)).toBe(DENSITY_MIN);
    // …and a rank outside `[0, 1]` is clamped, not trusted.
    expect(densityHeightScale(0.5, -3)).toBe(1);
    expect(densityHeightScale(0.5, 40)).toBeCloseTo(0.5, 12);
  });
});

describe('createLabelGate: the default density IS the old tier model', () => {
  it('answers tiersAt exactly as visibleTiers does, at every height and viewport', () => {
    // The equivalence proof, structural: the same function, not a numerical
    // coincidence. `entities.ts` calls `tiersAt` when the density is the default,
    // so if this holds for a sweep it holds for the shipped app.
    for (const viewport of VIEWPORTS) {
      for (const height of HEIGHTS) {
        expect(createLabelGate(viewport, 60).tiersAt(height)).toEqual(
          visibleTiers(height, viewport, 60),
        );
      }
    }
  });

  it('admits exactly the names the old tier test admitted, at every rank', () => {
    for (const viewport of VIEWPORTS) {
      for (const height of HEIGHTS) {
        const open = new Set(visibleTiers(height, viewport, 60));
        const gate = createLabelGate(viewport, 60, DENSITY_DEFAULT);
        for (const tier of TIERS) {
          for (const rank of [0, 0.3, 0.6, 1]) {
            expect(gate.admits(tier, rank, height)).toBe(open.has(tier));
          }
        }
      }
    }
  });

  it('reports the density it was built at, clamped', () => {
    expect(createLabelGate(900, 60).density).toBe(DENSITY_DEFAULT);
    expect(createLabelGate(900, 60, 0.01).density).toBe(DENSITY_MIN);
    expect(createLabelGate(900, 60, Number.NaN).density).toBe(DENSITY_DEFAULT);
  });
});

describe('createLabelGate: away from the default it moves the tail, not the head', () => {
  // A tier-2 name, at a height tier 2's own gate does not reach on a 900 px view.
  const gateAltitude = tierVisibleMaxHeight(2, 900, 60);
  const aboveGate = gateAltitude * 2;

  it('raises the tail above the gate when density is above 1', () => {
    const gate = createLabelGate(900, 60, 2);
    expect(gate.admits(2, 1, aboveGate)).toBe(true);
    expect(gate.admits(2, 1, gateAltitude * 2.5)).toBe(false);
    // The head is where it always was: a denser setting cannot promote the
    // biggest names past their own tier gate, because they are already drawn.
    expect(gate.admits(2, 0, aboveGate)).toBe(false);
    expect(gate.admits(2, 0, gateAltitude)).toBe(true);
  });

  it('closes the tail first when density is below 1', () => {
    const gate = createLabelGate(900, 60, 0.5);
    const mid = gateAltitude * 0.75;
    expect(gate.admits(2, 0, mid)).toBe(true);
    expect(gate.admits(2, 1, mid)).toBe(false);
    expect(gate.admits(2, 1, gateAltitude * 0.4)).toBe(true);
  });

  it('is monotone in rank, so the slider never re-orders a tier', () => {
    // Walking from a tier's head to its tail, visibility must move in ONE
    // direction — and which direction depends on which side of the default the
    // density is on. Below it the head is the last to go (head scale 1 ≥ tail
    // scale d), so "tail visible ⇒ head visible". Above it the tail is the first
    // to arrive (tail scale ≥ 1 = head scale), so "head visible ⇒ tail visible".
    // Asserting one direction for both settings would have failed the other half
    // of the slider's range.
    const ranks = [0, 0.2, 0.4, 0.6, 0.8, 1];
    for (const density of [0.3, 0.7, 1, 1.8, 3]) {
      const gate = createLabelGate(900, 60, density);
      for (const tier of [1, 2] as Tier[]) {
        for (let i = 1; i < ranks.length; i += 1) {
          for (const height of HEIGHTS) {
            const head = gate.admits(tier, ranks[i - 1], height);
            const tail = gate.admits(tier, ranks[i], height);
            // `head || !tail` is "tail ⇒ head"; `tail || !head` is "head ⇒ tail".
            // Writing either one the wrong way round is the easiest mistake in
            // this file, so the implication is spelled out next to the test.
            if (density >= 1) {
              expect(tail || !head, `d=${density} r=${ranks[i]}`).toBe(true);
            } else {
              expect(head || !tail, `d=${density} r=${ranks[i]}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('draws strictly more of a tier at a fixed height as density rises', () => {
    const fractionAdmitted = (density: number, height: number, viewport: number) => {
      const gate = createLabelGate(viewport, 60, density);
      let n = 0;
      for (let r = 0; r <= 1.0001; r += 0.05) if (gate.admits(2, r, height)) n += 1;
      return n;
    };
    for (const viewport of VIEWPORTS) {
      for (const height of [1.4e6, 2.2e6, 3.4e6]) {
        const sparse = fractionAdmitted(0.3, height, viewport);
        const standard = fractionAdmitted(DENSITY_DEFAULT, height, viewport);
        const dense = fractionAdmitted(DENSITY_MAX, height, viewport);
        expect(sparse).toBeLessThanOrEqual(standard);
        expect(dense).toBeGreaterThanOrEqual(standard);
      }
    }
    // And the ordering is strict somewhere, or the slider is decoration: at a
    // height just past tier 2's gate the sparse setting admits nothing while the
    // dense setting admits the whole tier.
    const gateAltitude = tierVisibleMaxHeight(2, 900, 60);
    expect(fractionAdmitted(0.3, gateAltitude * 1.5, 900)).toBe(0);
    expect(fractionAdmitted(DENSITY_MAX, gateAltitude * 1.5, 900)).toBeGreaterThan(0);
  });
});
