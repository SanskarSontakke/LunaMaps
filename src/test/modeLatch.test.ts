import { describe, expect, it } from 'vitest';
import {
  attemptMode,
  commitMode,
  createModeLatch,
  requestMode,
  rollbackMode,
  type ModeAttempt,
} from '@/lib/cesium/modeLatch';
import type { ModeChange } from '@/lib/cesium/morph';
import type { Mode } from '@/types';

/**
 * The mode-request latch behind MoonMap's mode effect. It owns the two facts the
 * UI must never conflate: `applied` (the mode the scene has been *confirmed* in)
 * and `requested` (the mode currently being morphed to). The re-review found that
 * a rejected `setMode` left `requested` pointing at a mode the scene never
 * reached, so every later request for that mode was deduped forever — the map was
 * stuck until reload. These tests pin the rollback and, with it, retryability.
 */
describe('mode latch — a rejected morph stays retryable', () => {
  it('a failed request rolled back makes the NEXT IDENTICAL click a real request', () => {
    const latch = createModeLatch('globe');
    // Paper succeeds: the scene is really in paper.
    expect(requestMode(latch, 'paper')).toBe(true);
    commitMode(latch, 'paper');
    expect(latch).toEqual({ applied: 'paper', requested: 'paper' });

    // Globe rejects (the morph never landed).
    expect(requestMode(latch, 'globe')).toBe(true);
    expect(rollbackMode(latch)).toBe('paper');
    expect(latch).toEqual({ applied: 'paper', requested: 'paper' });

    // THE FINDING: re-clicking the same mode must not be deduped.
    expect(requestMode(latch, 'globe')).toBe(true);
    // And neither is the interleaved path the old guard blocked (paper then globe).
    rollbackMode(latch);
    expect(requestMode(latch, 'paper')).toBe(false); // already applied: a real no-op
    expect(requestMode(latch, 'globe')).toBe(true);
  });

  it('rollback reports the mode the scene actually reached, which is what the toggle shows', () => {
    const latch = createModeLatch('globe');
    commitMode(latch, 'paper');
    requestMode(latch, 'globe');
    // The scene never left paper, so the caller must render paper as selected.
    expect(rollbackMode(latch)).toBe('paper');
    expect(latch.requested).toBe(latch.applied);
  });

  it('a successful request advances both halves of the latch', () => {
    const latch = createModeLatch('globe');
    expect(requestMode(latch, 'paper')).toBe(true);
    commitMode(latch, 'paper');
    expect(latch).toEqual({ applied: 'paper', requested: 'paper' });
    // Re-stating the mode the scene is confirmed in is a no-op (no duplicate morph).
    expect(requestMode(latch, 'paper')).toBe(false);
  });

  it('an in-flight request is deduped, so a double click cannot start the same morph twice', () => {
    const latch = createModeLatch('globe');
    expect(requestMode(latch, 'paper')).toBe(true);
    // While the paper morph is still running the same mode is not re-enqueued.
    expect(requestMode(latch, 'paper')).toBe(false);
    expect(latch).toEqual({ applied: 'globe', requested: 'paper' });
  });

  it('committing a mode nobody asked for cannot strand the latch', () => {
    const latch = createModeLatch('globe');
    requestMode(latch, 'paper');
    commitMode(latch, 'paper');
    expect(rollbackMode(latch)).toBe('paper');
  });
});

/* ------------------------------------------------------------------ *
 * attemptMode: the ACTUAL orchestration MoonMap's mode effect runs.
 * It is extracted from the component (the suite is node-only, there is no DOM
 * here) so the retry contract the re-review asked for is proven against
 * production code rather than against a copy of it in the test.
 * ------------------------------------------------------------------ */

const landed = (mode: Mode): ModeChange => ({
  mode,
  applied: true,
  animated: true,
  forced: false,
});
const jumpCut = (mode: Mode): ModeChange => ({
  mode,
  applied: true,
  animated: false,
  forced: true,
});
/** `settleMode`'s teardown answer: the viewer died mid-morph. */
const tornDown = (mode: Mode): ModeChange => ({
  mode,
  applied: false,
  animated: false,
  forced: false,
});

/** Records every mode it is actually asked to morph to — that log IS the proof
 *  that a repeat click was dispatched instead of deduped away. */
function fakeMorph(answer: (mode: Mode) => ModeChange | Error) {
  const asked: Mode[] = [];
  const morph = (mode: Mode): Promise<ModeChange> => {
    asked.push(mode);
    const out = answer(mode);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  return { asked, morph };
}

describe('attemptMode — the mode effect the UI actually runs', () => {
  it('after a rejection, the NEXT IDENTICAL CLICK IS NOT A NO-OP (round 1 stranded the latch)', async () => {
    const latch = createModeLatch('globe');
    const failNext = { on: false };
    const { asked, morph } = fakeMorph((mode) =>
      failNext.on && mode === 'globe'
        ? new Error(`scene never reached ${mode} mode; try again`)
        : landed(mode),
    );

    expect(await attemptMode(latch, 'paper', morph)).toEqual<ModeAttempt>({
      status: 'committed',
      mode: 'paper',
      forced: false,
    });
    expect(asked).toEqual(['paper']);

    failNext.on = true;
    const failed = await attemptMode(latch, 'globe', morph);
    expect(failed.status).toBe('failed');
    // The scene never left paper: that is the mode the toggle must show.
    expect(failed).toEqual<ModeAttempt>({
      status: 'failed',
      reached: 'paper',
      message: 'scene never reached globe mode; try again',
    });
    // Round 1: `requested` stayed 'globe' here, so the two assertions below
    // were the bug — the retry deduped and the map could never reach globe.
    expect(latch).toEqual({ applied: 'paper', requested: 'paper' });

    failNext.on = false;
    expect(await attemptMode(latch, 'globe', morph)).toEqual<ModeAttempt>({
      status: 'committed',
      mode: 'globe',
      forced: false,
    });
    expect(asked).toEqual(['paper', 'globe', 'globe']);
  });

  it('a confirmed mode is a real no-op: no morph is enqueued for it', async () => {
    const latch = createModeLatch('globe');
    const { asked, morph } = fakeMorph(landed);
    await attemptMode(latch, 'paper', morph);
    expect(await attemptMode(latch, 'paper', morph)).toEqual<ModeAttempt>({
      status: 'noop',
    });
    expect(asked).toEqual(['paper']);
  });

  it('an in-flight request is deduped, so a double click cannot enqueue the same morph twice', async () => {
    const latch = createModeLatch('globe');
    let release!: (change: ModeChange) => void;
    const pending = new Promise<ModeChange>((resolve) => {
      release = resolve;
    });
    const asked: Mode[] = [];
    const morph = (mode: Mode) => {
      asked.push(mode);
      return pending;
    };
    const running = attemptMode(latch, 'paper', morph);
    // `attemptMode` runs its latch check synchronously, before its first await,
    // so the in-flight request is already claimed here.
    expect(await attemptMode(latch, 'paper', morph)).toEqual<ModeAttempt>({
      status: 'noop',
    });
    expect(asked).toEqual(['paper']);
    release(jumpCut('paper'));
    expect(await running).toEqual<ModeAttempt>({
      status: 'committed',
      mode: 'paper',
      forced: true,
    });
  });

  it('a jump-cut at the deadline is reported as forced, never as an animated morph', async () => {
    const latch = createModeLatch('globe');
    const { morph } = fakeMorph(jumpCut);
    expect(await attemptMode(latch, 'paper', morph)).toEqual<ModeAttempt>({
      status: 'committed',
      mode: 'paper',
      forced: true,
    });
  });

  it('a torn-down viewer reports the mode the scene was confirmed in and stays usable', async () => {
    const latch = createModeLatch('globe');
    await attemptMode(latch, 'paper', fakeMorph(landed).morph);
    const takedown = fakeMorph(tornDown);
    expect(await attemptMode(latch, 'globe', takedown.morph)).toEqual<ModeAttempt>({
      status: 'torn-down',
      reached: 'paper',
    });
    // Not stranded: the next viewer can still be asked for globe.
    const after = fakeMorph(landed);
    expect(await attemptMode(latch, 'globe', after.morph)).toEqual<ModeAttempt>({
      status: 'committed',
      mode: 'globe',
      forced: false,
    });
    expect(after.asked).toEqual(['globe']);
  });
});
