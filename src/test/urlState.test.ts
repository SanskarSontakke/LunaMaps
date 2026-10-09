import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_HOME_HEIGHT,
  HOME_MARGIN,
  MOON_RADIUS_M,
  globeFitHeightMeters,
} from '@/lib/cesium/moon';
import {
  DEFAULT_HEIGHT,
  DEFAULT_VIEW,
  HASH_SYNC_MS,
  createUrlSync,
  parseHash,
  serializeHash,
  viewFromCamera,
  wasEmptyHash,
  type ViewState,
} from '@/lib/urlState';

const FOV60 = Math.PI / 3;
/** The string the default view writes, and therefore the number a hand-typed
 *  whole-disc link has to carry. Derived here rather than typed, so this file
 *  cannot be the place a stale literal comes back to life. */
const DEFAULT_HASH = serializeHash(DEFAULT_VIEW);
const DEFAULT_HEIGHT_STRING = String(DEFAULT_HEIGHT);

// The five cases the plan pins verbatim, then the anti-loop machinery that only
// looks safe until a hashchange listener is wired to it.

describe('url state round trip', () => {
  it('round-trips a view', () => {
    const v = {
      lon: 23.47312, lat: 0.67461, height: 180_000,
      mode: 'globe' as const, layer: 'photo' as const,
    };
    expect(parseHash(serializeHash(v))).toEqual(v);
  });
  it('carries a selected feature name with spaces', () => {
    const s = serializeHash({ ...DEFAULT_VIEW, feature: 'Mare Tranquillitatis' });
    expect(parseHash(s).feature).toBe('Mare Tranquillitatis');
  });
  it('falls back to defaults on malformed input', () => {
    for (const bad of ['', '#', '#x', '#garbage/here', '#NaN/0/0/globe/photo']) {
      expect(parseHash(bad).lon).toBe(DEFAULT_VIEW.lon);
      expect(parseHash(bad).height).toBe(DEFAULT_VIEW.height);
    }
  });
  it('clamps out-of-range numbers instead of throwing', () => {
    const p = parseHash('#999/-999/1e30/globe/photo');
    expect(p.lon).toBeLessThanOrEqual(180);
    expect(p.lat).toBeGreaterThanOrEqual(-90);
    expect(p.height).toBeLessThanOrEqual(3.5e7);
  });
  it('rejects unknown mode and layer names', () => {
    expect(parseHash('#0/0/100000/mars/satellite').mode).toBe(DEFAULT_VIEW.mode);
    expect(parseHash('#0/0/100000/globe/satellite').layer).toBe(DEFAULT_VIEW.layer);
  });
});

describe('parseHash details', () => {
  it('clamps to the real controller limits, not just under them', () => {
    expect(parseHash('#999/0/1e30/globe/photo')).toEqual({
      lon: 180, lat: 0, height: 3.5e7, mode: 'globe', layer: 'photo',
      feature: undefined,
    });
    expect(parseHash('#0/0/1/globe/photo').height).toBe(1_500);
    expect(parseHash('#0/95/100000/globe/photo').lat).toBe(89.9999);
  });
  it('accepts a hand-typed default-framing URL as its own fixed point', () => {
    // Amendment 2 retired `#0/0/22000000/globe/photo` as the canonical whole-disc
    // link: the canonical default is now whatever `DEFAULT_VIEW` derives, and a
    // URL that spells that framing out must read back as exactly the view it came
    // from — including through the integer-metre write of `serializeHash`.
    expect(parseHash(DEFAULT_HASH)).toEqual({ ...DEFAULT_VIEW, feature: undefined });
    expect(serializeHash(parseHash(DEFAULT_HASH))).toBe(DEFAULT_HASH);
    expect(parseHash(`#0/0/${DEFAULT_HEIGHT_STRING}/globe/photo`).height).toBe(
      DEFAULT_HEIGHT,
    );
  });
  it('restores a paper-mode, paper-layer view', () => {
    const p = parseHash('#-12.5/45.25/500000/paper/paper');
    expect(p).toMatchObject({ mode: 'paper', layer: 'paper', lon: -12.5, lat: 45.25 });
  });
  it('never throws on an undecodable percent escape', () => {
    // decodeURIComponent('%E0%A4%A') throws URIError; a shareable URL typed by a
    // human must not be able to crash the map with one.
    const p = parseHash('#10/20/300000/globe/photo/%E0%A4%A');
    expect(p.lon).toBe(10);
    expect(p.feature).toBeUndefined();
  });
  it('round-trips a feature name containing / and # through one segment', () => {
    const name = 'Sinus Iridium/Rupes #7 50%';
    const s = serializeHash({ ...DEFAULT_VIEW, feature: name });
    // One path segment only: the camera fields must stay where parseHash looks.
    expect(s.split('/')).toHaveLength(6);
    expect(s).toContain('%2F');
    expect(parseHash(s).feature).toBe(name);
  });
  it('treats an absent height as the default, not as 0', () => {
    expect(parseHash('#0/0/globe/photo').height).toBe(DEFAULT_VIEW.height);
    expect(parseHash('#10/10/globe/photo').height).toBe(DEFAULT_VIEW.height);
    // A two-segment link has no height slot at all: `globe` is not a number.
    expect(parseHash('#0/0').height).toBe(DEFAULT_VIEW.height);
  });
  it('does not hand out the DEFAULT_VIEW object itself', () => {
    const p = parseHash('');
    expect(p).not.toBe(DEFAULT_VIEW);
    const before = DEFAULT_VIEW.height;
    p.height = 1;
    expect(DEFAULT_VIEW.height).toBe(before);
  });
  it('reports whether a hash carried any state of its own', () => {
    expect(wasEmptyHash('')).toBe(true);
    expect(wasEmptyHash('#')).toBe(true);
    expect(wasEmptyHash(DEFAULT_HASH)).toBe(false);
    // Malformed input is empty input: the default view renders, no fly-to.
    expect(wasEmptyHash('#garbage/here')).toBe(true);
  });
});

/**
 * The default framing amendment 2 recorded as a bug, and the oracle that could
 * not catch it.
 *
 * `src/test/urlState.test.ts` used to assert `parseHash(...).height ===
 * DEFAULT_VIEW.height` for the fallback, which is true for every value of that
 * constant including 0 and 1e30, and it used to pin the literal `2.2e7` — the
 * deep-space framing that put a ~110 px disc on screen. So the pair could only
 * ever agree with itself. What is asserted instead is the DERIVATION: the
 * default is the height `globeFitHeightMeters` — the function `MoonMap` uses for
 * the real HOME view — gives for the case `moon.ts` exports a fallback for, and
 * it puts the disc's limb where the home margin says it belongs.
 */
describe('the default framing is derived, not typed', () => {
  it('is the same function MoonMap uses for HOME, on the un-measurable canvas', () => {
    // A URL carries no viewport, so the square canvas is the shape whose answer
    // `moon.ts` documents as the fallback. Any square size gives it: the function
    // depends on the aspect ratio, not on the pixel count.
    expect(DEFAULT_HEIGHT).toBe(Math.round(globeFitHeightMeters(1, 1, FOV60)));
    expect(globeFitHeightMeters(900, 900, FOV60)).toBe(
      globeFitHeightMeters(1, 1, FOV60),
    );
    expect(DEFAULT_VIEW.height).toBe(DEFAULT_HEIGHT);
  });
  it('equals the exported fallback height, to the metre it writes', () => {
    expect(DEFAULT_HEIGHT).toBe(Math.round(FALLBACK_HOME_HEIGHT));
    expect(Math.abs(DEFAULT_HEIGHT - FALLBACK_HOME_HEIGHT)).toBeLessThan(1);
  });
  it('frames the whole disc: the limb sits at the home margin of the half-field', () => {
    // The semantic the number exists for. `2.2e7` fails this by a factor of ~8 in
    // angular radius, which is what made a hand-typed short link show a postage
    // stamp — so the derivation is pinned by what it must LOOK like, not by a
    // literal that can be retyped.
    const limbRadians = (h: number) =>
      Math.asin(MOON_RADIUS_M / (MOON_RADIUS_M + h));
    expect(limbRadians(DEFAULT_VIEW.height)).toBeCloseTo(
      HOME_MARGIN * (FOV60 / 2),
      3,
    );
    expect(limbRadians(2.2e7)).toBeLessThan(HOME_MARGIN * (FOV60 / 2) / 2);
  });
  it('is a whole-disc height, not a deep-space one', () => {
    expect(DEFAULT_VIEW.height).toBeLessThan(3e6);
    expect(DEFAULT_VIEW.height).toBeGreaterThan(1.5e6);
    // The bug this replaces, stated so it cannot be mistaken for a rounding.
    expect(DEFAULT_VIEW.height).not.toBe(2.2e7);
  });
  it('a short hand-typed link lands on the derived framing', () => {
    // Compared against the FUNCTION, not against `DEFAULT_HEIGHT`, or this would
    // be the same self-agreeing oracle the old test was.
    const derived = Math.round(globeFitHeightMeters(1, 1, FOV60));
    for (const hash of ['#0/0', '#0/0/globe/photo', '#', '', '#nonsense']) {
      expect(parseHash(hash).height).toBe(derived);
    }
  });
});

describe('the anti-loop invariant', () => {
  it('serialisation is a fixed point of the parse/serialize pair', () => {
    // The whole two-way sync rests on this: write -> read -> apply -> write must
    // produce the identical string, or the two directions feed each other.
    const v = {
      lon: -104.77012, lat: -26.13004, height: 129_829,
      mode: 'paper' as const, layer: 'paper' as const,
      feature: 'Mare Tranquillitatis',
    };
    const once = serializeHash(v);
    expect(serializeHash(parseHash(once))).toBe(once);
    expect(serializeHash(parseHash(once))).toBe(once);
    expect(parseHash(once).feature).toBe('Mare Tranquillitatis');
  });
  it('rounds to the precision it claims: 5 dp of lon/lat, whole metres', () => {
    const s = serializeHash({ ...DEFAULT_VIEW, lon: 1 / 3, lat: 2 / 3, height: 123_456.78 });
    expect(s).toBe('#0.33333/0.66667/123457/globe/photo');
    // ...and re-serialising the parsed form is stable at that precision.
    expect(serializeHash(parseHash(s))).toBe(s);
  });
  it('a height outside the controller limits converges in one step', () => {
    // serializeHash clamps nothing, so a hand-written 1235 m (below MIN_H) reads
    // back as the clamp floor. That is a ONE-time correction: the second read is
    // identical, so the differ guard sees no change and the sync stops instead
    // of oscillating. `viewFromCamera` clamps before writing, so the app itself
    // never produces this string — only a typed URL can.
    const once = serializeHash({ ...DEFAULT_VIEW, height: 1234.56 });
    expect(once).toBe('#0.00000/0.00000/1235/globe/photo');
    const twice = serializeHash(parseHash(once));
    expect(twice).toBe('#0.00000/0.00000/1500/globe/photo');
    expect(serializeHash(parseHash(twice))).toBe(twice);
  });
});

describe('viewFromCamera', () => {
  it('maps the camera fields and carries mode, layer and selection', () => {
    expect(
      viewFromCamera(
        { lonDeg: 23.47312, latDeg: 0.67461, height: 180_000 },
        'paper',
        'paper',
        'Apollo 11 landing site',
      ),
    ).toEqual({
      lon: 23.47312, lat: 0.67461, height: 180_000,
      mode: 'paper', layer: 'paper', feature: 'Apollo 11 landing site',
    });
  });
  it('clamps the height so a mid-morph camera cannot serialise outside range', () => {
    const v = viewFromCamera({ lonDeg: 0, latDeg: 0, height: 9e20 }, 'globe', 'photo');
    expect(v.height).toBe(3.5e7);
    expect(v.feature).toBeUndefined();
  });
});

/**
 * A stand-in for `window.location.hash` + `history.replaceState`: writing is
 * visible to the next read, which is what makes a feedback loop possible and so
 * what the guard has to survive.
 */
function fakeDocument(initial = '') {
  const state = { hash: initial, writes: 0 };
  return {
    state,
    readHash: () => state.hash,
    write: (hash: string) => {
      state.hash = hash;
      state.writes += 1;
    },
  };
}

describe('createUrlSync', () => {
  const v = (over: Partial<ViewState> = {}) => ({
    ...DEFAULT_VIEW,
    ...over,
  });

  it('writes the current view on the first tick', () => {
    const doc = fakeDocument();
    const sync = createUrlSync({ ...doc, now: () => 0 });
    expect(sync.tick(v({ lon: 12 }))).toBe(true);
    expect(doc.state.hash).toBe(`#12.00000/0.00000/${DEFAULT_HEIGHT_STRING}/globe/photo`);
  });
  it('never writes when the serialised string already matches', () => {
    const doc = fakeDocument(serializeHash(v({ lon: 12 })));
    const sync = createUrlSync({ ...doc, now: () => 0 });
    expect(sync.tick(v({ lon: 12 }))).toBe(false);
    expect(doc.state.writes).toBe(0);
  });
  it('throttles to 4 Hz: one write per interval no matter how often it is ticked', () => {
    expect(HASH_SYNC_MS).toBe(250);
    let now = 0;
    const doc = fakeDocument();
    const sync = createUrlSync({ ...doc, now: () => now });
    // 20 ticks (5 s of frames) of a moving camera at ~120 Hz.
    let written = 0;
    for (let i = 0; i < 20; i += 1) {
      now += 8;
      if (sync.tick(v({ lon: i }))) written += 1;
    }
    // first tick passes (the clock starts at 0), then one per 250 ms window.
    expect(written).toBe(1);
    now = 300;
    expect(sync.tick(v({ lon: 99 }))).toBe(true);
    expect(doc.state.writes).toBe(2);
  });
  it('cannot loop: a hashchange listener that re-ticks on every write settles', () => {
    const doc = fakeDocument();
    let now = 0;
    const sync = createUrlSync({ ...doc, now: () => now });
    const view = v({ lon: 44 });
    // Hostile wiring: every write fires a hashchange, whose handler applies the
    // URL and syncs back. With the differ guard this terminates after one write;
    // without it the recursion is unbounded and this test blows the stack.
    const onHashChange = () => {
      const applied = parseHash(doc.state.hash);
      sync.flush(viewFromCamera(
        { lonDeg: applied.lon, latDeg: applied.lat, height: applied.height },
        applied.mode,
        applied.layer,
        applied.feature,
      ));
    };
    let depth = 0;
    const guarded = (write: () => void) => {
      if (depth > 25) throw new Error('feedback loop');
      depth += 1;
      try {
        write();
      } finally {
        depth -= 1;
      }
    };
    const reentrant = createUrlSync({
      readHash: doc.readHash,
      now: () => now,
      write: (h) => guarded(() => {
        doc.write(h);
        onHashChange();
      }),
    });
    expect(() => reentrant.tick(view)).not.toThrow();
    expect(doc.state.writes).toBe(1);
    expect(doc.state.hash).toBe(serializeHash(view));
  });
  it('flush bypasses the throttle for a selection change but keeps the guard', () => {
    const doc = fakeDocument();
    const sync = createUrlSync({ ...doc, now: () => 0 });
    expect(sync.tick(v({ lon: 7 }))).toBe(true);
    expect(sync.flush(v({ lon: 7, feature: 'Tycho' }))).toBe(true);
    expect(doc.state.hash).toBe(
      `#7.00000/0.00000/${DEFAULT_HEIGHT_STRING}/globe/photo/Tycho`,
    );
    // Re-flushing the same view (a double click on the same result) is a no-op.
    expect(sync.flush(v({ lon: 7, feature: 'Tycho' }))).toBe(false);
    expect(doc.state.writes).toBe(2);
  });
  it('dropping the selection removes the feature segment', () => {
    const doc = fakeDocument(serializeHash({ ...DEFAULT_VIEW, feature: 'Tycho' }));
    const sync = createUrlSync({ ...doc, now: () => 0 });
    expect(sync.flush(DEFAULT_VIEW)).toBe(true);
    expect(doc.state.hash).toBe(DEFAULT_HASH);
    expect(parseHash(doc.state.hash).feature).toBeUndefined();
  });
  it('lastWritten reports what this instance put there, for its own hashchange guard', () => {
    const doc = fakeDocument();
    const sync = createUrlSync({ ...doc, now: () => 0 });
    expect(sync.lastWritten()).toBeNull();
    sync.flush(v({ lon: 3 }));
    expect(sync.lastWritten()).toBe(doc.state.hash);
    // Something else changed the URL: this sync did not write it, so the app
    // must treat it as an inbound navigation rather than an echo of its own.
    doc.state.hash = '#99/99/99/globe/photo';
    expect(sync.lastWritten()).not.toBe(doc.state.hash);
  });
  it('a hand-typed out-of-range height converges to silence', () => {
    let now = 0;
    const doc = fakeDocument('#0/0/1235/globe/photo');
    const sync = createUrlSync({ ...doc, now: () => now });
    // The app applies that hash, clamps it, and reports the clamped camera back.
    const applied = parseHash(doc.state.hash);
    const view = viewFromCamera(
      { lonDeg: applied.lon, latDeg: applied.lat, height: applied.height },
      applied.mode,
      applied.layer,
    );
    expect(sync.tick(view)).toBe(true);
    expect(sync.tick(view)).toBe(false); // same frame window: throttled
    now = 10_000;
    // Past the throttle the corrected string is already what the document holds,
    // so the differ guard keeps quiet — one write, then silence.
    expect(sync.tick(view)).toBe(false);
    expect(doc.state.writes).toBe(1);
  });
  it('stops writing once the document no longer exists (teardown)', () => {
    const readHash = vi.fn(() => '#0/0/100000/globe/photo');
    const write = vi.fn();
    const sync = createUrlSync({ readHash, write, now: () => 0 });
    sync.flush(v({ lon: 5 }));
    expect(write).toHaveBeenCalledTimes(1);
    sync.stop();
    expect(sync.flush(v({ lon: 6 }))).toBe(false);
    expect(sync.tick(v({ lon: 7 }))).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
