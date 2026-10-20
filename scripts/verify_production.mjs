// Does the PRODUCTION bundle actually render?
//
// Every browser check in this repo's history ran against `next dev`, and every one of them
// leaned on `globalThis.__moonViewer` / `__moonHarness` — which `MoonMap` only installs when
// `process.env.NODE_ENV === 'development'`. So none of them proves the shipped build hydrates,
// loads `features.json` and `regions.json` through their validators, or wires the area picker.
// This drives `next start` with no harness at all and asserts on DOM that can only exist if
// all of that happened.
//
// It is the check that would have caught the blank page: `npm run build` at `057884d` compiled,
// linted and prerendered five static pages while the emitted client chunk died at parse time on
// an octal escape in `@spz-loader/core`'s inlined WASM, so React never hydrated. `npx next dev`
// never showed it, because dev does not use the emitted bundle.
//
//   npm run build && PORT=3100 npx next start          # in another shell
//   PROD_PORT=3100 node scripts/verify_production.mjs  # exits nonzero on any failed assertion
//
// Set CHROME_PATH if Chrome lives somewhere else. Screenshots land in `work/prod-shots/`
// (untracked scratch, like every other capture); the painted-pixel counts measured from them are
// recorded in `docs/deploy.md` §4, not re-asserted here.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9347;                       // CDP port, distinct from the app port below
const BASE = `http://localhost:${process.env.PROD_PORT ?? 3100}/`;
const OUT = 'work/prod-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms, label) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) throw new Error('timeout: ' + label);
      await nap(200);
    }
  };
  const rows = () => [...document.querySelectorAll('.sidebar-row')];
  const out = {};
  // React hydration + features.json through its validator: the rows cannot exist
  // unless both happened. Also proves the wide-viewport effect opened the panel.
  await until(() => rows().length > 0, 40000, 'hydrated sidebar rows');
  out.rows = rows().length;
  out.head = document.querySelector('[data-testid="sidebar-head"]')?.textContent ?? null;
  out.harnessAbsent = typeof globalThis.__moonViewer === 'undefined';
  out.nextDevIndicator = !!document.querySelector('nextjs-portal');
  out.searchPlaceholder = document.querySelector('.ctl-search input')?.placeholder ?? null;
  const sel = document.getElementById('moon-area-select');
  out.areaOptions = sel ? sel.querySelectorAll('option').length : null;
  out.areaOptgroups = sel ? [...sel.querySelectorAll('optgroup')].map((g) => g.label) : null;
  if (!sel) return out;
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(sel, 'south-polar-cap');
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await nap(5000);
  out.copyAfterSelect = document.querySelector('[data-area-copy]')?.textContent ?? null;
  out.readout = document.querySelector('.scale-meta')?.textContent ?? null;
  return out;
};

const run = async () => {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(`${tmpdir()}/lunar-prod-`);
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
     '--use-angle=swiftshader', `--remote-debugging-port=${PORT}`,
     `--user-data-dir=${profile}`, '--window-size=1440,900', '--hide-scrollbars',
     '--no-first-run', '--force-device-scale-factor=1', BASE],
    { stdio: 'ignore' },
  );
  const report = { consoleErrors: [], results: null };
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i += 1) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = l.find((t) => t.type === 'page');
      } catch { /* not up */ }
      if (!page) await sleep(250);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const waiting = new Map();
    let next = 1;
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const s = waiting.get(m.id);
      if (s) { waiting.delete(m.id); if (m.error) s.reject(new Error(JSON.stringify(m.error))); else s.resolve(m.result); return; }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        report.consoleErrors.push(`${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 180));
      }
      if (m.method === 'Runtime.exceptionThrown') {
        report.consoleErrors.push('EXCEPTION ' + JSON.stringify({
          text: m.params.exceptionDetails.text,
          url: m.params.exceptionDetails.url,
          line: m.params.exceptionDetails.lineNumber,
          col: m.params.exceptionDetails.columnNumber,
          desc: (m.params.exceptionDetails.exception?.description || '').slice(0, 900),
        }));
      }
    });
    await new Promise((res) => ws.addEventListener('open', res));
    const send = (method, params = {}) => new Promise((res, rej) => {
      const id = next++;
      waiting.set(id, { resolve: res, reject: rej });
      ws.send(JSON.stringify({ id, method, params }));
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(8000);
    const r = await send('Runtime.evaluate', {
      expression: `(${PROBE.toString()})()`, awaitPromise: true,
      returnByValue: true, timeout: 120000,
    });
    if (r.exceptionDetails) report.results = { error: r.exceptionDetails.exception?.description };
    else report.results = r.result.value;
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/south-polar-cap-production.png`, Buffer.from(shot.data, 'base64'));
    ws.close();
  } finally {
    chrome.kill();
  }
  console.log(JSON.stringify(report, null, 1));
  return report;
};

// The verdict, not just the transcript. Each term names a state the shipped bundle can
// reach without working: no rows means React never hydrated; a present harness would mean
// the dev-only globals leaked into production; `nextjs-portal` means the dev badge is up,
// i.e. something started `next dev` on this port instead of `next start`.
const verdict = (report) => {
  const r = report.results ?? {};
  const bad = [];
  if (r.error) bad.push(`probe threw: ${String(r.error).slice(0, 200)}`);
  if (!(r.rows > 0)) bad.push('no hydrated sidebar rows');
  if (r.harnessAbsent === false) bad.push('__moonViewer exists in the production build');
  if (r.nextDevIndicator) bad.push('the Next.js dev indicator is present');
  if (!(r.areaOptions > 0)) bad.push('the area picker has no options (regions.json did not load)');
  if (!r.copyAfterSelect) bad.push('selecting an area produced no copy');
  if (report.consoleErrors.length) bad.push(`${report.consoleErrors.length} console errors/exceptions`);
  return bad;
};

run()
  .then((report) => {
    const bad = verdict(report);
    if (bad.length) {
      console.error('PRODUCTION RENDER FAIL\n  ' + bad.join('\n  '));
      process.exit(1);
    }
    console.log('PRODUCTION RENDER PASS');
  })
  .catch((e) => { console.error('FAILED', e); process.exit(1); });
