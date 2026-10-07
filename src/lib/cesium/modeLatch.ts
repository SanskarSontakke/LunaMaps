import type { ModeChange } from './morph';
import type { Mode } from '@/types';

/**
 * The mode-request latch: the small state machine behind MoonMap's mode effect.
 *
 * Two facts must never be conflated:
 *  - `applied` — the mode the live scene has been *confirmed* to be in (only a
 *    resolved `setMode` may advance it);
 *  - `requested` — the mode currently being morphed to.
 *
 * Round 1 of the Task 10 review set `requested` on dispatch and never rolled it
 * back, so after a rejection the latch was stranded at `{applied: 'paper',
 * requested: 'globe'}`: the mode effect's dedupe refused both 'paper' (== applied)
 * and 'globe' (== requested) forever, and the map could not change mode again
 * without a reload. `rollbackMode` is what keeps a failed switch retryable, and
 * its return value is the mode the UI must show as selected — the scene's real
 * mode, not the one the user asked for.
 */
export interface ModeLatch {
  applied: Mode;
  requested: Mode;
}

export const createModeLatch = (mode: Mode): ModeLatch => ({
  applied: mode,
  requested: mode,
});

/**
 * Claim a request. Returns true when the caller must actually morph to `mode`,
 * false when it is a no-op: either the scene is already confirmed in that mode,
 * or that exact morph is already in flight (a double click must not enqueue the
 * same transition twice).
 */
export function requestMode(latch: ModeLatch, mode: Mode): boolean {
  if (latch.applied === mode || latch.requested === mode) return false;
  latch.requested = mode;
  return true;
}

/** The scene is provably in `mode` now. */
export function commitMode(latch: ModeLatch, mode: Mode): void {
  latch.applied = mode;
  latch.requested = mode;
}

/**
 * The request failed. Forget the intent and go back to the mode the scene really
 * reached, so the *same* click re-dispatches instead of being deduped forever.
 * Returns that mode, which is what the toggle has to render as selected.
 */
export function rollbackMode(latch: ModeLatch): Mode {
  latch.requested = latch.applied;
  return latch.applied;
}

/**
 * The result of one mode attempt, in the form the UI renders. Every branch but
 * `noop` carries the mode the scene actually holds now, so the toggle can never
 * show a mode the map did not reach.
 */
export type ModeAttempt =
  | { status: 'noop' }
  | { status: 'committed'; mode: Mode; forced: boolean }
  | { status: 'torn-down'; reached: Mode }
  | { status: 'failed'; reached: Mode; message: string };

/**
 * One click → one honest outcome. This is the whole mode effect minus React: it
 * claims the latch, awaits the morph, and ALWAYS leaves `requested` equal to the
 * mode the scene is confirmed in — committing on success, rolling back on both
 * flavours of non-success (a rejection, and a viewer destroyed mid-morph).
 *
 * Round 1 set `requested` on dispatch and only ever cleared it on success, which
 * is how one failed morph made every later request for that mode a deduped
 * no-op until reload. `modeLatch.test.ts` pins the retry against this function,
 * and `MoonMap`'s effect is a thin render over its result.
 *
 * `morph` is `setMode(viewer, mode)` at the call site; injecting it keeps this
 * state machine testable with no DOM, no GPU and no Cesium import.
 */
export async function attemptMode(
  latch: ModeLatch,
  mode: Mode,
  morph: (mode: Mode) => Promise<ModeChange>,
): Promise<ModeAttempt> {
  if (!requestMode(latch, mode)) return { status: 'noop' };
  try {
    const change = await morph(mode);
    if (!change.applied) {
      // The viewer was destroyed mid-morph: nothing was applied and there is no
      // scene to retry onto. Roll the latch back anyway so no intent survives a
      // teardown, and let the caller stay silent.
      return { status: 'torn-down', reached: rollbackMode(latch) };
    }
    commitMode(latch, mode);
    // `forced` is deliberately passed through: a deadline jump-cut changed the
    // mode but never animated, and the UI must not label it a smooth morph.
    return { status: 'committed', mode, forced: change.forced };
  } catch (e: unknown) {
    return {
      status: 'failed',
      reached: rollbackMode(latch),
      message: e instanceof Error ? e.message : 'unknown error',
    };
  }
}
