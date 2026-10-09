import { describe, expect, it } from 'vitest';
import {
  createOccupancy,
  declutter,
  declutterWithMarkers,
  overlaps,
  type Box,
  type LabelBox,
} from '@/lib/labels/declutter';

const box = (x: number, y: number, w = 60, h = 16): Box => ({ x, y, w, h });
const item = (id: string, priority: number, x: number, y = 100): LabelBox => ({
  id,
  priority,
  box: box(x, y),
});

describe('overlaps', () => {
  it('detects an intersection', () => {
    expect(overlaps(box(0, 0, 10, 10), box(5, 5, 10, 10))).toBe(true);
  });
  it('treats touching edges as non-overlapping', () => {
    expect(overlaps(box(0, 0, 10, 10), box(10, 0, 10, 10))).toBe(false);
  });
  it('detects containment', () => {
    expect(overlaps(box(0, 0, 100, 100), box(40, 40, 10, 10))).toBe(true);
  });
});

describe('declutter', () => {
  it('keeps the higher priority of two colliding labels', () => {
    expect(declutter([item('a', 5, 100), item('b', 9, 104)])).toEqual(['b']);
  });
  it('keeps everything when nothing collides', () => {
    const kept = declutter([item('a', 5, 0), item('b', 5, 400), item('c', 5, 800)]);
    expect(kept.sort()).toEqual(['a', 'b', 'c']);
  });
  it('is independent of input order', () => {
    const items = [item('a', 5, 100), item('b', 9, 104), item('c', 1, 108)];
    expect(declutter(items)).toEqual(declutter([...items].reverse()));
    expect(declutter(items)).toEqual(['b']);
  });
  it('resolves a chain so only the top-ranked survivor remains', () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(`l${n}`, n, n * 6));
    expect(declutter(items)).toEqual(['l5']);
  });
  it('handles empty input', () => {
    expect(declutter([])).toEqual([]);
  });
  it('spans many cells for a wide label', () => {
    const wide = [{ id: 'w', priority: 1, box: box(0, 0, 400, 16) }];
    expect(declutter(wide, 96)).toEqual(['w']);
  });
  it('does not mutate the input', () => {
    const items = [item('a', 5, 100), item('b', 9, 104)];
    const before = items.map((i) => i.id);
    declutter(items);
    expect(items.map((i) => i.id)).toEqual(before);
  });
});

describe('the occupancy grid', () => {
  it('refuses a clashing box and claims nothing when it does', () => {
    const occ = createOccupancy(96);
    expect(occ.place(box(0, 0, 10, 10))).toBe(true);
    expect(occ.clashes(box(5, 5, 10, 10))).toBe(true);
    expect(occ.place(box(5, 5, 10, 10))).toBe(false);
    // The refused box is not in the map: a later box clear of the FIRST but not
    // the second would otherwise be turned away by a box that lost.
    expect(occ.place(box(20, 20, 10, 10))).toBe(true);
  });
  it('sees a clash across a cell boundary', () => {
    const occ = createOccupancy(96);
    occ.place(box(90, 0, 20, 10));
    expect(occ.place(box(105, 0, 20, 10))).toBe(false);
  });
});

describe('declutterWithMarkers: names win, dots fit what is left', () => {
  const name = (id: string, priority: number, b: Box): LabelBox => ({ id, priority, box: b });

  it('keeps every name when there are no markers at all', () => {
    const labels = [name('a', 3e6, box(0, 0, 40, 16)), name('b', 2e6, box(200, 0, 40, 16))];
    expect(declutterWithMarkers(labels, [])).toEqual({ kept: ['a', 'b'], keptMarkers: [] });
  });

  it('drops a marker that would land on a kept name', () => {
    const labels = [name('Double', 5e5, box(387, 379, 48, 19))];
    const markers = [name('dot', 5e5, box(416, 384, 7, 7))];
    const out = declutterWithMarkers(labels, markers);
    expect(out.kept).toEqual(['Double']);
    expect(out.keptMarkers).toEqual([]);
  });

  it('never lets a marker move a name', () => {
    // The order is the whole decision: a name carries information a 4 px dot does
    // not, so a dot that arrives first must not be able to evict one.
    const labels = [name('West', 500001, box(449, 393, 38, 19))];
    const markers = [name('Little West', 500000, box(450, 400, 7, 7))];
    const out = declutterWithMarkers(labels, markers);
    expect(out.kept).toEqual(['West']);
    expect(out.keptMarkers).toEqual([]);
  });

  it('thins a pile of markers against each other on their own priority', () => {
    const markers = [
      name('m1', 500002, box(100, 100, 7, 7)),
      name('m2', 500001, box(102, 101, 7, 7)),
    ];
    expect(declutterWithMarkers([], markers).keptMarkers).toEqual(['m1']);
  });

  it('is independent of input order, like the name pass', () => {
    const labels = [name('a', 5, box(100, 0, 40, 16)), name('b', 9, box(104, 0, 40, 16))];
    const markers = [name('ma', 5, box(120, 40, 7, 7)), name('mb', 9, box(120, 60, 7, 7))];
    expect(declutterWithMarkers(labels, markers)).toEqual(
      declutterWithMarkers([...labels].reverse(), [...markers].reverse()),
    );
  });
});

/**
 * THE ARISTARCHUS DEFECT — `work/ortho-shots/aristarchus-base.png`.
 *
 * A composited frame, 8 km over 0.674°N 23.483°E, ~10 m/px, in which the Apollo 11
 * name `Double` carries another site's marker through its own glyphs. The three
 * names in that frame are 224 m and 236 m apart, so at this scale they are 22 px
 * and 24 px apart on screen — and every one of them is tier 3, so every one of
 * them has a dot.
 *
 * The pixel evidence, read out of the shipped PNG (`work/` is gitignored, so the
 * numbers are recorded here rather than committed): the amber marker clusters sit
 * at (412.2, 402.2) = `Double`, (419.7, 401.9) = `Little West`, (464.3, 412.3) =
 * `West`; the bright glyph runs are `Double` over x 392–431 and `West` over x
 * 450–477. `Little West`'s marker is inside `Double`'s text. Its own text was
 * correctly decluttered away — the bug is that the dot was never in the contest.
 *
 * `measured` widths are from `work/measure-labels.mjs`, which ran the shipped
 * names through `measureText` in the live page at `600 13px system-ui`.
 */
const ARISTARCHUS = {
  canvas: { w: 884, h: 805 },
  mPerPx: 10,
  centre: { lon: 23.483, lat: 0.674 },
  arcPerDeg: 1_737_400 * (Math.PI / 180),
};

const project = (lon: number, lat: number) => ({
  x:
    ARISTARCHUS.canvas.w / 2 +
    ((lon - ARISTARCHUS.centre.lon) *
      ARISTARCHUS.arcPerDeg *
      Math.cos((ARISTARCHUS.centre.lat * Math.PI) / 180)) /
      ARISTARCHUS.mPerPx,
  y:
    ARISTARCHUS.canvas.h / 2 -
    ((lat - ARISTARCHUS.centre.lat) * ARISTARCHUS.arcPerDeg) / ARISTARCHUS.mPerPx,
});

const SITES = {
  Double: { name: 'Double', lon: 23.4727, lat: 0.6738, priority: 500_000.15, measured: 42.81 },
  'Little West': { name: 'Little West', lon: 23.4756, lat: 0.6743, priority: 500_000.4, measured: 62.45 },
  West: { name: 'West', lon: 23.4908, lat: 0.6705, priority: 500_001.88, measured: 29.43 },
} as const;

const LABEL_H = 19;
const OLD_LABEL_H = 16;
const GAP = 8;
const MARKER_HALF = 3.5;
const PAD = 8;

/** The width model `entities.ts` uses, at a given per-character advance. */
const modelledWidth = (name: keyof typeof SITES, charPx: number) =>
  Math.min(SITES[name].name.length * charPx + PAD, 260);

interface Frame {
  texts: LabelBox[];
  markers: LabelBox[];
}

/**
 * The geometry `entities.ts` builds: a text box centred on the anchor (or, for a
 * traverse name, cleared above it by `GAP`), and a marker box centred on the
 * anchor. Widths are the MODELLED ones, because that is what the declutter
 * actually sorts — the measured widths are the subject of the last describe.
 */
function frameFor(charPx: number, labelH: number, offset: boolean): Frame {
  const texts: LabelBox[] = [];
  const markers: LabelBox[] = [];
  for (const key of Object.keys(SITES) as (keyof typeof SITES)[]) {
    const site = SITES[key];
    const p = project(site.lon, site.lat);
    const w = modelledWidth(key, charPx);
    texts.push({
      id: key,
      priority: site.priority,
      box: {
        x: p.x - w / 2,
        y: offset ? p.y - GAP - labelH : p.y - labelH / 2,
        w,
        h: labelH,
      },
    });
    markers.push({
      id: key,
      priority: site.priority,
      box: {
        x: p.x - MARKER_HALF,
        y: p.y - MARKER_HALF,
        w: MARKER_HALF * 2,
        h: MARKER_HALF * 2,
      },
    });
  }
  return { texts, markers };
}

const OLD = () => frameFor(6.6, OLD_LABEL_H, false);
const NEW = () => frameFor(7.5, LABEL_H, true);

describe('the Aristarchus frame, reproduced from the shipped screenshot', () => {
  it('projects the three sites where the PNG shows them, to within two pixels', () => {
    // If this is wrong, every assertion below is testing the wrong geometry. The
    // projection is the linear near-nadir map (`m/px` at the frame centre), which
    // is what a perspective camera over an 8 km frame actually is to within a
    // couple of pixels — the amber marker clusters read out of the shipped PNG are
    // the control.
    const within = (predicted: number, observed: number, label: string) =>
      expect(Math.abs(predicted - observed), `${label} (${predicted} vs ${observed})`).toBeLessThan(2);
    within(project(SITES.Double.lon, SITES.Double.lat).x, 412.2, 'Double');
    within(project(SITES['Little West'].lon, SITES['Little West'].lat).x, 419.7, 'Little West');
    within(project(SITES.West.lon, SITES.West.lat).x, 464.3, 'West');
    // The separations, which are projection-model-independent to first order.
    const d = project(SITES.Double.lon, SITES.Double.lat);
    const lw = project(SITES['Little West'].lon, SITES['Little West'].lat);
    const w = project(SITES.West.lon, SITES.West.lat);
    expect(lw.x - d.x).toBeLessThan(20); // 7.5 px apart in the frame
    expect(w.x - lw.x).toBeGreaterThan(30);
    expect(w.x - lw.x).toBeLessThan(60);
  });

  it('reproduces the frame’s names: West and Double live, Little West dies', () => {
    expect(declutter(OLD().texts).sort()).toEqual(['Double', 'West']);
  });

  it('reproduces the defect: the dropped name’s marker sits inside a kept name', () => {
    const { texts, markers } = OLD();
    const kept = new Set(declutter(texts));
    const keptTexts = texts.filter((t) => kept.has(t.id)).map((t) => t.box);
    const droppedMarkers = markers.filter((m) => !kept.has(m.id));
    const offending = droppedMarkers.filter((m) =>
      keptTexts.some((b) => overlaps(m.box, b)),
    );
    // `Little West`'s dot, inside `Double`'s glyphs — exactly what the frame shows.
    expect(offending.map((m) => m.id)).toEqual(['Little West']);
    // The old pass cannot express this: its input is ONE population of boxes, and
    // the dot was never in it. `declutterWithMarkers` exists because the contest
    // needs two populations with a fixed order between them.
    expect(texts).toHaveLength(3);
    expect(markers).toHaveLength(3);
  });

  it('clears every collision once the marker is a second population', () => {
    const { texts, markers } = NEW();
    const out = declutterWithMarkers(texts, markers);
    const keptTexts = texts.filter((t) => out.kept.includes(t.id));
    const keptMarkers = markers.filter((m) => out.keptMarkers.includes(m.id));
    // The invariant the frame violated, stated once for everything it draws:
    // no two of the rectangles actually painted overlap.
    const drawn = [
      ...keptTexts.map((t) => ({ id: t.id, box: t.box })),
      ...keptMarkers.map((m) => ({ id: m.id, box: m.box })),
    ];
    for (let i = 0; i < drawn.length; i += 1) {
      for (let j = i + 1; j < drawn.length; j += 1) {
        expect(
          overlaps(drawn[i].box, drawn[j].box),
          `${drawn[i].id} × ${drawn[j].id}`,
        ).toBe(false);
      }
    }
    // The pass alone is not enough, and this is why the renderer moved the text
    // too: in the OLD geometry every marker sits inside its OWN name's box, so a
    // second population that loses to names would drop all three dots and take
    // the landing sites off the map with them.
    const old = OLD();
    const oldOut = declutterWithMarkers(old.texts, old.markers);
    expect(oldOut.keptMarkers).toEqual([]);
    expect(oldOut.kept.length).toBeGreaterThan(0);
    // In the new geometry the dots survive, because they no longer sit under the
    // text that shares their anchor.
    expect(out.keptMarkers.length).toBeGreaterThan(0);
  });

  it('clears a traverse name’s OWN marker structurally, by offsetting the text', () => {
    // With both origins at CENTER the dot is painted through the middle of its own
    // glyphs — the frame has `West`'s marker on the `e`. No declutter pass can fix
    // that: the two boxes belong to one entity and only one of them competes, and
    // hiding the dot would hide the site the name exists to label. So the renderer
    // moves the text, and the model moves with it.
    for (const b of OLD().texts) {
      const own = OLD().markers.find((m) => m.id === b.id);
      if (!own) continue;
      expect(overlaps(b.box, own.box), b.id).toBe(true);
    }
    for (const b of NEW().texts) {
      const own = NEW().markers.find((m) => m.id === b.id);
      if (!own) continue;
      expect(overlaps(b.box, own.box), b.id).toBe(false);
    }
  });
});

/**
 * WHAT THE CELL MODEL STILL CANNOT DO, stated as a test rather than a comment.
 *
 * The rectangles declutter sorts are a MODEL of a glyph run: `name.length ×
 * CHAR_PX + pad`. It can be made conservative — `work/measure-labels.mjs` measured
 * all 1,585 shipped names and `entities.ts` now uses the smallest per-character
 * advance at which none of them is under-reported — but it cannot be made EXACT
 * without asking the canvas, per frame, what the browser actually laid out:
 *
 *   - `measureText` is the only authority, and it needs a 2D context. Vitest runs
 *     in `node`, with no DOM and no canvas, which is why every visual claim in
 *     this repo is either a stylesheet read as text or a screenshot.
 *   - The rendered advance also depends on the label's own `scaleByDistance`
 *     (1.0 → 0.85 over the app's height range), on the device pixel ratio, and on
 *     which font `system-ui` resolved to on the machine — none of which a pure
 *     function can see.
 *   - The cell grid is therefore only as good as the boxes handed to it, and it
 *     has no opinion about their width. That is the honest residual, and it is
 *     why `CHAR_PX` is a measured floor rather than a rounded guess.
 */
describe('the box model is a model, and this is the gap', () => {
  it('lets two names touch when the box under-reports the glyphs', () => {
    // Same anchor, 40 px apart. The 30 px model says they clear each other; the
    // 44 px truth says they overlap. Nothing inside `declutter` can see this.
    const modelled = [
      { id: 'a', priority: 2, box: box(0, 0, 30, 16) },
      { id: 'b', priority: 1, box: box(40, 0, 30, 16) },
    ];
    expect(declutter(modelled)).toEqual(['a', 'b']);
    const truth = modelled.map((m) => ({ ...m, box: { ...m.box, w: 44 } }));
    expect(declutter(truth)).toEqual(['a']);
  });

  it('is conservative at the measured floor: no shipped name is under-boxed', () => {
    // The numbers `work/measure-labels.mjs` printed for the 1,585 shipped names,
    // `600 13px system-ui, sans-serif`, in the live page.
    const charPx = 7.5;
    const pad = 8;
    const measured: Array<[string, number, number]> = [
      // [name, length, measured width]
      ['Ohm', 3, 28.91], // the worst ratio in the gazetteer: 9.64 px/char
      ['Double', 6, 42.81],
      ['West', 4, 29.43],
      ['Little West', 11, 62.45],
    ];
    for (const [name, length, width] of measured) {
      expect(length * charPx + pad, name).toBeGreaterThanOrEqual(width);
    }
    // The constant this replaced was the MEDIAN (6.6), which under-boxed 57 of
    // the 1,585 names — including `Ohm`, whose 3 characters need 28.91 px against
    // a modelled 27.8.
    expect(3 * 6.6 + 8).toBeLessThan(28.91);
  });
});
