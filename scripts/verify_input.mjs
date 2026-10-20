// Real input events against the PRODUCTION bundle: wheel, drag, keyboard.
//
// `src/lib/keyboard.ts` has 40-odd unit tests, all of them calling the listener through a
// fake `window` that records one callback. That proves the switch table. It cannot prove
// that a physical `keydown` reaches it (focus, `preventDefault`, the `inField` guard), nor
// that Cesium's own screen-space controller still does what it should under a real wheel
// and a real drag. Gate G3's own record said drag, wheel and keyboard "have never been
// driven as real input events" -- so drive them, through CDP `Input.dispatch*`, in the
// shipped bundle where no `__moonViewer` handle exists.
//
// The camera is read from `location.hash` (`#lon/lat/height/mode/layer`), which
// `MoonMap` rewrites on a throttle from the camera -- so the assertion does not depend on
// any dev-only global.
//
//   npm run build && npx next start -p 3000   # in another shell
//   PROD_PORT=3000 npm run verify:input
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CDP = 9361;
const BASE = `http://localhost:${process.env.PROD_PORT ?? 3000}/#0/0/3000000/globe/photo`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READ = () => {
  const p = window.location.hash.replace(/^#/, '').split('/');
  const meta = document.querySelector('.scale-meta')?.textContent ?? null;
  return { lon: Number(p[0]), lat: Number(p[1]), height: Number(p[2]), meta };
};

const run = async () => {
  const chrome = spawn(
    CHROME,
    ['--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader',
     '--use-angle=swiftshader', `--remote-debugging-port=${CDP}`,
     `--user-data-dir=${mkdtempSync(`${tmpdir()}/lunar-input-`)}`,
     '--window-size=1440,900', '--hide-scrollbars', '--no-first-run',
     '--force-device-scale-factor=1', BASE],
    { stdio: 'ignore' },
  );
  let id = 1;
  const waiting = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const n = id++;
    waiting.set(n, { res, rej });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  let ws;
  try {
    let page = null;
    for (let i = 0; i < 120 && !page; i += 1) {
      try {
        const l = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json();
        page = l.find((t) => t.type === 'page');
      } catch { /* not up yet */ }
      if (!page) await sleep(250);
    }
    ws = new WebSocket(page.webSocketDebuggerUrl);
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (m.error) w.rej(new Error(JSON.stringify(m.error))); else w.res(m.result);
    });
    await new Promise((res) => ws.addEventListener('open', res));
    await send('Runtime.enable');
    await send('Page.enable');
    await sleep(12000);   // boot, hydrate, load the base pyramid, settle the camera

    const read = async () => {
      const r = await send('Runtime.evaluate', {
        expression: `(${READ.toString()})()`, returnByValue: true,
      });
      return r.result.value;
    };
    const wheel = (dy) => send('Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 820, y: 460, deltaX: 0, deltaY: dy, deltaMode: 0 });
    // `keyAction` switches on `event.key`, so the probe must send the character the
    // handler reads, not the US-layout code: passing `code` as `key` makes the app see
    // "Equal"/"KeyE" where it expects "+"/"e". Arrows look right either way because
    // their `key` and `code` are the same string -- which is how the mistake hides.
    const key = async (keyName, code, vk, { text = '', modifiers = 0 } = {}) => {
      for (const type of ['keyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', {
          type, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
          modifiers, text: type === 'keyDown' ? text : '',
        });
      }
    };

    const steps = [];
    const record = async (label, act, expect) => {
      const before = await read();
      await act();
      await sleep(2600);            // camera throttle + hash write
      const after = await read();
      const d = {
        label,
        lon: +(after.lon - before.lon).toFixed(3),
        lat: +(after.lat - before.lat).toFixed(3),
        height: Math.round(after.height - before.height),
        moved: Math.abs(after.lon - before.lon) > 1e-4
          || Math.abs(after.lat - before.lat) > 1e-4
          || Math.abs(after.height - before.height) > 1,
      };
      d.verdict = expect ? expect(d) : (d.moved ? 'ok' : 'NO RESPONSE');
      steps.push(d);
    };

    await record('wheel out', () => wheel(600),
      (x) => (x.moved && x.height > 0 ? 'ok (height up)' : x.moved ? 'moved but not up' : 'NO RESPONSE'));
    await record('wheel in', () => wheel(-900),
      (x) => (x.moved && x.height < 0 ? 'ok (height down)' : x.moved ? 'moved but not down' : 'NO RESPONSE'));
    await record('drag left-to-right', async () => {
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 460, button: 'left', clickCount: 1 });
      for (let x = 600; x <= 1060; x += 40) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: 460, button: 'left' });
        await sleep(60);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1060, y: 460, button: 'left', clickCount: 1 });
    });
    const arrowUp = () => key('ArrowUp', 'ArrowUp', 38);
    await record('ArrowUp (pan north)', arrowUp,
      (x) => (x.moved && x.lat > 0 ? 'ok (lat up)' : x.moved ? 'moved but not north' : 'NO RESPONSE'));
    await record('ArrowDown (pan south)', () => key('ArrowDown', 'ArrowDown', 40),
      (x) => (x.moved && x.lat < 0 ? 'ok (lat down)' : x.moved ? 'moved but not south' : 'NO RESPONSE'));
    await record('ArrowRight (pan east)', () => key('ArrowRight', 'ArrowRight', 39),
      (x) => (x.moved && x.lon > 0 ? 'ok (lon up)' : x.moved ? 'moved but not east' : 'NO RESPONSE'));
    await record('ArrowLeft (pan west)', () => key('ArrowLeft', 'ArrowLeft', 37),
      (x) => (x.moved && x.lon < 0 ? 'ok (lon down)' : x.moved ? 'moved but not west' : 'NO RESPONSE'));
    await record('+ (zoom in)', () => key('+', 'Equal', 187, { text: '+' }),
      (x) => (x.moved && x.height < 0 ? 'ok (height down)' : x.moved ? 'moved but not in' : 'NO RESPONSE'));
    await record('- (zoom out)', () => key('-', 'Minus', 189, { text: '-' }),
      (x) => (x.moved && x.height > 0 ? 'ok (height up)' : x.moved ? 'moved but not out' : 'NO RESPONSE'));
    await record('e (rotate right)', () => key('e', 'KeyE', 69, { text: 'e' }));
    await record('q (rotate left)', () => key('q', 'KeyQ', 81, { text: 'q' }));
    // modifiers 8 = Shift on the CDP wire. A separate rawKeyDown for ShiftLeft does NOT
    // set event.shiftKey, which is why the fast-pan step first measured the same as slow.
    await record('Shift+ArrowUp (fast pan)', () => key('ArrowUp', 'ArrowUp', 38, { modifiers: 8 }),
      (x) => (!x.moved ? 'NO RESPONSE' : x.lat > 0 ? 'ok (lat up)' : 'moved but not north'));

    const final = await read();
    const slow = steps.find((s) => s.label === 'ArrowUp (pan north)');
    const fast = steps.find((s) => s.label === 'Shift+ArrowUp (fast pan)');
    const ratio = fast && slow ? Math.abs(fast.lat) / Math.abs(slow.lat) : null;
    console.log(JSON.stringify({ steps, final, shiftPanRatio: ratio, expectsAbout3: 3 }, null, 1));
    const dead = steps.filter((s) => s.verdict.startsWith('NO RESPONSE'));
    const wrong = steps.filter((s) => s.verdict.startsWith('moved but not'));
    if (dead.length || wrong.length) {
      console.error(`INPUT FAIL: no response: ${dead.map((d) => d.label).join(', ') || 'none'}; `
        + `wrong direction: ${wrong.map((d) => `${d.label} -> ${d.verdict}`).join(', ') || 'none'}`);
      process.exitCode = 1;
    } else {
      console.log('INPUT PASS: every driven event moved the camera in the direction promised; '
        + `shift pan is ${ratio === null ? '?' : ratio.toFixed(2)}x the plain step (FAST = 3)`);
    }
  } finally {
    chrome.kill();
    ws?.close();
  }
};
run().catch((e) => { console.error('FAILED', e); process.exit(1); });
