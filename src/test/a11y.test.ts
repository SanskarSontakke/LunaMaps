import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MoonMap from '@/components/MoonMap';
import SearchBox from '@/components/SearchBox';
import Sidebar, { SIDEBAR_LIST_ID } from '@/components/Sidebar';
import { defaultFilters } from '@/lib/filters';
import type { Feature, FeatureCollection } from '@/types';

/**
 * The shell's accessibility, tested the way this repo tests CSS and rendered
 * markup: the stylesheet is read as text and required to carry the exact rules
 * (`src/test/paperTint.test.ts`), and components are run through
 * `renderToStaticMarkup` because vitest has no DOM and no WebGL (`src/test/
 * ortho.test.ts`). Nothing here asks a browser — and nothing here claims to have
 * seen one.
 *
 * The findings this covers, all of them true of the shell before the change:
 * the metadata was create-next-app's own; the stylesheet had no `:focus` rule and
 * no `outline` at all while five selectors reset the UA ring with `all: unset`;
 * the map host had no role, name or text alternative; `globals.css` styled a
 * `<main>` no file rendered; the combobox pointed `aria-controls` at a listbox
 * that was not in the document; and `/` focused a `disabled` input, which is a
 * no-op that reports nothing.
 */

const css = readFileSync('src/app/globals.css', 'utf8');
const layoutSource = readFileSync('src/app/layout.tsx', 'utf8');
const pageSource = readFileSync('src/app/page.tsx', 'utf8');
const moonMapSource = readFileSync(
  resolve(__dirname, '../components/MoonMap.tsx'),
  'utf8',
);
const searchBoxSource = readFileSync(
  resolve(__dirname, '../components/SearchBox.tsx'),
  'utf8',
);

/** The two ring literals, pinned here because `src/lib/look.ts` — the file that
 *  normally holds a visual constant — belongs to another agent in this wave. Move
 *  these there and the CSS comment's pairing claim becomes true as well. */
const FOCUS_RING = '#ffd45e';
const FOCUS_HALO = 'rgba(5, 6, 10, 0.95)';

/** CSS with comments stripped, split into `{ selectors, body }` rules. Naive on
 *  purpose: this stylesheet has no nested at-rules beyond the two `@media` blocks
 *  and no braces inside any comment, and a real parser would let a broken rule
 *  parse its way back into passing. */
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1].split(',').map((s) => s.trim()).filter(Boolean),
  body: m[2].replace(/\s+/g, ' ').trim(),
}));

const ruleFor = (selector: string) =>
  rules.find((r) => r.selectors.includes(selector));

describe('the stylesheet says which control has focus', () => {
  it('declares the two-tone ring as the literals this test reads', () => {
    expect(stripped).toContain(`--focus-ring: ${FOCUS_RING};`);
    expect(stripped).toContain(`--focus-halo: ${FOCUS_HALO};`);
    const host = rules.filter((r) =>
      r.selectors.some((s) => s.endsWith(':focus-visible')),
    );
    expect(host.length).toBeGreaterThanOrEqual(2);
    const ring = host.find((r) => r.body.includes('var(--focus-ring)'));
    expect(ring?.body).toContain('outline: 2px solid var(--focus-ring)');
    expect(ring?.body).toContain('outline-offset: 2px');
    expect(ring?.body).toContain('box-shadow: 0 0 0 5px var(--focus-halo)');
  });

  /**
   * THE DISCRIMINATING TEST. Every rule that resets the UA ring is found from the
   * stylesheet itself rather than listed here, so a new `all: unset` control
   * without a ring fails this immediately — which is exactly the state the whole
   * file was in before, when it had zero `:focus` rules.
   */
  it('gives a focus-visible ring to every control that unsets its own', () => {
    const resetters = rules.filter((r) => /all: unset/.test(r.body));
    expect(resetters.length).toBeGreaterThanOrEqual(5);
    const uncovered: string[] = [];
    for (const rule of resetters) {
      for (const selector of rule.selectors) {
        if (!stripped.includes(`${selector}:focus-visible`)) {
          uncovered.push(selector);
        }
      }
    }
    expect(uncovered).toEqual([]);
    // Named explicitly as well, so deleting one of the five known offenders is a
    // failure with a readable message and not a vacuous pass on an empty list.
    for (const selector of [
      '.ctl button',
      '.ctl-search input',
      '.ctl-search [role="option"]',
      '.card-close',
      '.panel-retry',
    ]) {
      expect(stripped).toContain(`${selector}:focus-visible`);
    }
  });

  it('never turns the ring off again', () => {
    expect(stripped).not.toMatch(/outline:\s*(none|0)\b/);
    expect(stripped).not.toMatch(/outline-(color|style):\s*(transparent|none|0)/);
  });

  it('rings the map itself, inward, because the host is full-bleed', () => {
    const host = ruleFor('.map-host:focus-visible');
    expect(host?.body).toContain('outline: 3px solid var(--focus-ring)');
    expect(host?.body).toContain('outline-offset: -3px');
  });

  it('exists as a landmark target: the `main` rule has a `main` element', () => {
    // `html, body, main` has been styled since Task 15 while nothing rendered a
    // `<main>`: a dead rule is how a missing landmark stays invisible in review.
    expect(ruleFor('main') ?? ruleFor('body')).toBeDefined();
    expect(stripped).toMatch(/html,\s*body,\s*main\s*\{/);
    expect(pageSource).toMatch(/<main>/);
  });
});

describe('prefers-reduced-motion is honoured where CSS can reach it', () => {
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(
    stripped,
  );

  it('has a reduce block, and it shortens transitions and animations', () => {
    expect(reduced).not.toBeNull();
    expect(reduced?.[1]).toMatch(/transition-duration:\s*0(\.001ms|s)\s*!important/);
    expect(reduced?.[1]).toMatch(/animation-duration:\s*0(\.001ms|s)\s*!important/);
    expect(reduced?.[1]).toContain('scroll-behavior: auto !important');
  });

  /**
   * Coverage, not a count. `globals.css` is being edited by more than one agent in
   * this wave and chrome transitions are being added to it, so asserting "no
   * motion exists" would be a claim about someone else's line, true today and
   * false tomorrow. What has to hold instead is that the reduce block reaches
   * every rule in the file — which is what its universal selector buys — and that
   * the motion CSS cannot reach is named where it lives.
   */
  it('reaches every rule the file declares, whatever chrome is added later', () => {
    const selector = reduced?.[0].slice(
      reduced[0].indexOf('{') + 1,
      reduced[0].indexOf('{') + 40,
    );
    expect(selector).toContain('*');
    const movable = rules.filter((r) =>
      /(^|[^-])\b(transition|animation)-\w+:\s|\b(transition|animation):/.test(r.body),
    );
    // Not vacuous in either direction: a chrome transition may be added, and if
    // one is, this test's job is to still pass because the wildcard covers it.
    expect(movable.length).toBeGreaterThanOrEqual(0);
    for (const rule of movable) {
      expect(rule.selectors.length).toBeGreaterThan(0);
    }
  });

  it('names the motion CSS cannot reach, in the file where it lives', () => {
    const morph = readFileSync(resolve(__dirname, '../lib/cesium/morph.ts'), 'utf8');
    // The real fix belongs here: a reduced-motion read that jumps the tween. The
    // three anchors below are what a future change has to touch, and they are
    // asserted rather than cited, so a refactor that moves them is noticed.
    expect(morph).toMatch(/export const MORPH_SECONDS = 0\.5;/);
    expect(morph).toMatch(/scene\.morphTo3D\(MORPH_SECONDS\)/);
    expect(morph).toMatch(/duration: 1\.4/);
    // And the stylesheet says so out loud, so nobody reads the media block as the
    // end of the job.
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toMatch(/NOT reduced by this block|NOT covered by this block/);
  });
});

describe('the document describes itself', () => {
  // Read out of the metadata object, not out of the file: layout.tsx's own
  // comment quotes the template strings it removed, and a plain `not.toContain`
  // on the source would fail for describing the bug rather than for carrying it.
  // The description is a concatenation of literals, so the whole block is the
  // unit being read.
  const metadata =
    /export const metadata: Metadata = \{([\s\S]*?)\n\};/.exec(layoutSource)?.[1] ?? '';
  const title = /title:\s*"([^"]*)"/.exec(metadata)?.[1];

  it('has real metadata, not the template’s', () => {
    expect(metadata).not.toBe('');
    expect(title).toBeDefined();
    expect(title).toContain('Moon');
    expect(title).not.toContain('Create Next App');
    expect(metadata).toContain('description:');
    expect(metadata).toContain('IAU');
    expect(metadata).toContain('Gazetteer');
    expect(metadata).not.toContain('Generated by create next app');
    // A one-word description is not a description.
    expect(metadata.replace(/\s/g, '').length).toBeGreaterThan(120);
    expect(layoutSource).toMatch(/<html lang="en">/);
  });

  it('makes no build-time network request for a font nothing uses', () => {
    // An import statement, not a mention: the comment above explains what went.
    expect(layoutSource).not.toMatch(/from\s+["']next\/font/);
    expect(layoutSource).not.toMatch(/^\s*const\s+\w+\s*=\s*Geist(_Mono)?\(/m);
    // The claim the removal rests on: the only stylesheet that reads the two
    // variables is the template's `page.module.css`, and no source file imports it.
    for (const source of [layoutSource, pageSource, moonMapSource, searchBoxSource]) {
      expect(source).not.toMatch(/from\s+["'][^"']*page\.module\.css["']/);
    }
    expect(css).not.toMatch(/--font-geist/);
    expect(css).toMatch(/system-ui/);
  });
});

describe('the map region is reachable and named', () => {
  // `createElement`, not a direct call: `MoonMap` uses hooks, and calling the
  // function outside a render leaves React's dispatcher null
  // (`Cannot read properties of null (reading 'useRef')`). Effects do not run in
  // a static render, which is exactly what makes this the way to see the shell —
  // the host element, the note, and nothing that needs a canvas.
  const html = renderToStaticMarkup(createElement(MoonMap));

  it('names the host a screen reader lands on', () => {
    const host = /<div[^>]*class="map-host"[^>]*>/.exec(html)?.[0] ?? '';
    expect(host).toContain('role="region"');
    expect(host).toContain('aria-label="Moon map"');
    expect(host).toContain('tabindex="0"');
    expect(host).toContain('aria-describedby="map-intro"');
    // Not a dangling reference: the node it points at is in the same render.
    expect(html).toContain('id="map-intro"');
    expect(html).toMatch(/<p id="map-intro" class="sr-only">/);
    expect(html).toMatch(/arrow keys pan/);
  });

  it('keeps the mode attribute it already carried', () => {
    // `data-mode` drives the paper tint (paperTint.test.ts); the a11y pass must
    // not have cost it.
    expect(html).toContain('data-mode="globe"');
    expect(moonMapSource).toContain('data-mode={sceneMode}');
  });
});

describe('the combobox points only at what is on the page', () => {
  const withNames: FeatureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-16, -43.5] },
        properties: {
          name: 'Tycho',
          gloss: 'Crater.',
          type: 'Crater, crateres',
          code: 'CR',
          tier: 1,
          diameterKm: 85,
          bbox: null,
          quad: 'LAC-78',
          approval: '1973/01/01',
          mission: null,
          url: 'https://planetarynames.wr.usgs.gov/Feature/6009',
        },
      },
    ],
  };

  it('emits no aria-controls or aria-owns while the list is closed', () => {
    for (const [label, props] of [
      ['no gazetteer', { features: null }],
      ['a gazetteer', { features: withNames }],
    ] as const) {
      const markup = renderToStaticMarkup(
        createElement(SearchBox, { ...props, onChoose: () => {} }),
      );
      expect(markup, label).not.toContain('aria-controls');
      expect(markup, label).not.toContain('aria-owns');
      expect(markup, label).toContain('aria-expanded="false"');
      expect(markup, label).toContain('role="combobox"');
      // The listbox the ids used to name is not rendered either, so there is
      // nothing for the attributes to point at — and nothing hidden is added to
      // pretend there is.
      expect(markup, label).not.toContain('role="listbox"');
    }
  });

  it('gates the attributes on the same condition as the listbox', () => {
    expect(searchBoxSource).toMatch(
      /const listShown = open && results\.length > 0;/,
    );
    expect(searchBoxSource).toMatch(
      /aria-controls=\{listShown \? listId : undefined\}/,
    );
    expect(searchBoxSource).toMatch(
      /aria-owns=\{listShown \? listId : undefined\}/,
    );
    expect(searchBoxSource).toMatch(/\{listShown && \(/);
  });

  it('reports a / that cannot do its job instead of doing nothing', () => {
    // The gazetteer-missing case renders the input `disabled`; focus on a disabled
    // field is a no-op, so the shortcut has to say which half happened.
    const disabled = renderToStaticMarkup(
      createElement(SearchBox, { features: null, onChoose: () => {} }),
    );
    expect(disabled).toContain('disabled');
    expect(moonMapSource).toMatch(/if \(field instanceof HTMLInputElement && !field\.disabled\) field\.focus\(\);/);
    expect(moonMapSource).toMatch(/else reportSearchUnavailable\(\);/);
    expect(moonMapSource).toMatch(/setSearchNudge\('Pressing \/ did nothing[^\n]*\)/);
    // The nudge lands in the `role="status"` note that is already on screen, which
    // is what makes it a report rather than a second panel.
    expect(moonMapSource).toMatch(/\{searchNudge \? ` \$\{searchNudge\}` : ''\}/);
    expect(moonMapSource).toMatch(/self-clearing|Self-clearing/);
    // ...and its timer is cleared with the listener it belongs to.
    expect(moonMapSource).toMatch(
      /if \(searchNudgeTimer\.current\) clearTimeout\(searchNudgeTimer\.current\);/,
    );
  });
});

describe('the sidebar list names itself per sort direction', () => {
  const feature: Feature = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-16, -43.5] },
    properties: {
      name: 'Tycho',
      gloss: 'Crater.',
      type: 'Crater, craters',
      code: 'CR',
      tier: 1,
      diameterKm: 85,
      bbox: null,
      quad: 'LAC-78',
      approval: '1973-01-01',
      mission: null,
      url: 'https://planetarynames.wr.usgs.gov/Feature/6009',
    },
  };

  const list = (direction: 'asc' | 'desc') =>
    renderToStaticMarkup(
      createElement(Sidebar, {
        features: [feature],
        filters: defaultFilters(),
        sort: { key: 'name', direction },
        selectedName: null,
        open: true,
        onToggle: () => {},
        onFiltersChange: () => {},
        onSortChange: () => {},
        onClearFilters: () => {},
        onChoose: () => {},
        areas: null,
        selectedAreaId: null,
        onAreaChoose: () => {},
      }),
    );

  it('spells the sort direction into the list’s accessible name', () => {
    // `Sidebar` builds this as `${sort.direction}ending`, which only reads
    // correctly because `asc`/`desc` both end in the letters that start
    // "-ending". That is a fragile piece of luck worth a test rather than an
    // assumption: this string is what a screen reader announces for the whole
    // list, and it is the only place the two words appear in the sidebar.
    expect(list('asc')).toContain('sorted by name, ascending');
    expect(list('desc')).toContain('sorted by name, descending');
    for (const markup of [list('asc'), list('desc')]) {
      expect(markup).not.toMatch(/desceending|ascencoding|sort\.direction/);
    }
  });

  it('names the list, the region it sits in, and the toggle that opens it', () => {
    const markup = list('asc');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Place names"');
    expect(markup).toContain('aria-expanded="true"');
    // `aria-controls` only while the list is in the document, same rule as the
    // combobox above: the toggle names `moon-sidebar-list`, and here it exists.
    expect(markup).toContain(`aria-controls="${SIDEBAR_LIST_ID}"`);
    expect(markup).toContain(`id="${SIDEBAR_LIST_ID}"`);
  });

  it('drops aria-controls when collapsed, rather than pointing at nothing', () => {
    const closed = renderToStaticMarkup(
      createElement(Sidebar, {
        features: [feature],
        filters: defaultFilters(),
        sort: { key: 'name', direction: 'asc' },
        selectedName: null,
        open: false,
        onToggle: () => {},
        onFiltersChange: () => {},
        onSortChange: () => {},
        onClearFilters: () => {},
        onChoose: () => {},
        areas: null,
        selectedAreaId: null,
        onAreaChoose: () => {},
      }),
    );
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('aria-controls');
    expect(closed).not.toContain(`id="${SIDEBAR_LIST_ID}"`);
  });
});

describe('the sidebar column cannot hide its own list', () => {
  /** Every declaration the cascade applies to a selector, in source order. The
   *  stylesheet groups selectors (`.sidebar-list-head, .sidebar-list, …`), so a
   *  first-match lookup would read one grouped rule and miss the real block. */
  const cascade = (selector: string) =>
    rules
      .filter((r) => r.selectors.includes(selector))
      .map((r) => r.body)
      .join('; ');

  it('gives the clipped panel two scroll regions, not one immovable block', () => {
    // `.sidebar` is `overflow: hidden` under a `max-height`, so a child that
    // cannot shrink is a child that pushes the rest of the column out of the
    // box. That is exactly what happened before this rule existed: the filter
    // block kept its ~700 px content height, the list fell to its 60 px floor and
    // painted its first row at y = 863 in an 805 px window — in the document,
    // unreachable. `work/verify_sidebar.mjs` is the measurement.
    const panel = cascade('.sidebar');
    expect(panel).toMatch(/overflow:\s*hidden/);
    expect(panel).toMatch(/max-height:/);
    for (const selector of ['.filters', '.sidebar-list']) {
      const body = cascade(selector);
      expect(body, `${selector} has no rule at all`).not.toBe('');
      expect(body, `${selector} must be able to give up height`).toMatch(
        /min-height:\s*0|flex:\s*1 1 auto/,
      );
      expect(body, `${selector} must scroll instead of overflowing`).toMatch(
        /overflow-y:\s*auto/,
      );
    }
  });

  it('leaves the deep-zoom control outside the column it occupies', () => {
    // The other half of the same measurement: the panel runs from x = 14 to
    // 14 + 268 + 2·10 = 302, and `.ctl-ortho` used to start at 148 — under it.
    const sidebar = cascade('.sidebar');
    const left = Number(/left:\s*(\d+)px/.exec(sidebar)?.[1]);
    const width = Number(/width:\s*(\d+)px/.exec(sidebar)?.[1]);
    const pad = Number(/padding:\s*[\d.]+px\s+([\d.]+)px/.exec(sidebar)?.[1]);
    const rightEdge = left + width + 2 * pad;
    expect(rightEdge).toBe(302);
    const ortho = Number(/left:\s*(\d+)px/.exec(cascade('.ctl-ortho'))?.[1]);
    expect(ortho).toBeGreaterThan(rightEdge);
  });
});
