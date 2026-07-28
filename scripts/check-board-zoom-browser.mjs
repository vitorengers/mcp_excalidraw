#!/usr/bin/env node
/**
 * Checks that the board is never drawn smaller than it was written, and that a zoom sticks.
 *
 * #185 is a reader on a 2560x1440 display saying the writing in the blocks is blurry. It is
 * not a resolution defect — Excalidraw rasterises at `devicePixelRatio x zoom` — it is the
 * board's own zoom. This board is a tall, narrow column, and every way onto it fitted *both*
 * axes, so the height bound the fit: a 1130x2732 column against a ~2560x1300 canvas opened at
 * `min(2.27, 0.48) = 0.48`, and the 13px card body was drawn at 6px. The wider the display,
 * the more of it the fit threw away.
 *
 * So the fit has a floor now: `min(1, viewportWidth / contentWidth)`. Height never shrinks the
 * board below the size it was authored at — a board taller than the viewport is scrolled, not
 * squeezed — while a board *wider* than the viewport is still fitted to the width, because
 * panning sideways to read a line of text would be a worse answer than a smaller one.
 *
 * The second half is that no zoom survived a reload: `boardViewportsRef` was a React ref, so a
 * reader who corrected the zoom by hand lost the correction on every refresh, which is what
 * turned a one-time nuisance into "if I dont zoom in". It is in `localStorage` now, per board,
 * beside the theme, the menu setting and the terminal's geometry.
 *
 * Only a browser can answer either. `zoom.value` lives on `appState` of a mounted component;
 * the fit is Excalidraw's own arithmetic over the real canvas size; and "survives a reload" is
 * a claim about a page that has been thrown away and built again. All of it type-checks
 * perfectly whether or not it works.
 *
 * Every case in sections 2-7 was red before the fix. Sections 2-4 are the floor: 0.10, 0.30
 * and 0.30 against floors of 0.49, 1 and 1 — Excalidraw rounds a fit *down* to a tenth, which
 * is why the numbers are blunter than the arithmetic. Section 5 is the guard on the other
 * side, that the floor never pushes content off the sides; it was red for the same rounding,
 * at 0.40 where the width fit is 0.49, and it is the case that would go red again if the floor
 * were ever written as a fixed number instead of the width fit. Sections 6-7 are the
 * persistence, which came back to the origin at 100% because nothing was saving anything.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server, both
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-zoom-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIPPED — no Chrome or Edge found, so the browser half was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  process.exit(0);
}

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Two projects: a small one, and a tall narrow column like this repository's board ──

const workDir = mkdtempSync(join(tmpdir(), 'check-board-zoom-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const ALPHA = 'alpha-project';
const COLUMN = 'column-project';
const alphaDir = join(workDir, ALPHA);
const columnDir = join(workDir, COLUMN);
for (const dir of [alphaDir, columnDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: ALPHA, path: alphaDir.replace(/\\/g, '/') },
    { id: COLUMN, path: columnDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so nothing else is drawing on these
// boards and nothing else is moving the camera.
writeFileSync(join(alphaDir, 'board.config.json'),
              JSON.stringify({ name: 'Alpha', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
writeFileSync(join(columnDir, 'board.config.json'),
              JSON.stringify({ name: 'Column', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const WINDOW = { width: 1400, height: 900 };

/**
 * The Column board, in the shape of the one this repository ships.
 *
 * Narrow and very tall, so the height is what binds a fit-both-axes; and one deliberately
 * *wide* section, because the floor must not be allowed to push content off the sides.
 */
const STRUCTURE = { x: 0, y: 0, width: 900, height: 2200 };
const DEVELOPMENT = { x: 0, y: 2260, width: 900, height: 1800 };
const WIDE = { x: 0, y: 4120, width: 2800, height: 400 };

const PORT = 37500 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

// The terminal block is deleted out of the child's environment on purpose: this machine's
// shell exports EXCALIDRAW_TERMINAL=1, and a terminal block would put a DOM overlay over the
// mirror and an extra shape into the scene bounds every fit here is measured against.
const serverEnv = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LOG_LEVEL: 'error',
                    EXCALIDRAW_WORKSPACES: registryPath };
delete serverEnv.EXCALIDRAW_TERMINAL;

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

const seed = (workspace, body) => fetch(`${BASE}/api/elements?workspace=${workspace}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function attach() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
}

async function pressKey(code, key, modifiers, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
}

/** Alt and a letter, which is what a section's `hotkeyCode` means on the page. */
const altPress = async (code, key, virtualKey) => {
  await pressKey(code, key, 1, virtualKey);
  // scrollToContent animates; the assertion is about where it lands, not how it gets there.
  await sleep(1600);
};

/** The reader's own pan, and with Ctrl held, the reader's own zoom. */
async function wheel(deltaX, deltaY, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 700, y: 500, deltaX, deltaY, modifiers, button: 'none', buttons: 0,
  });
  await sleep(250);
}

/** The imperative API, through the container's React fibre. See check-board-sections-browser. */
const GRAB_API = `(() => {
  const host = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
  if (!host) return false;
  const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
  if (!key) return false;
  let node = host[key];
  for (let up = 0; up < 60 && node; up++) {
    let state = node.memoizedState;
    for (let along = 0; along < 40 && state; along++) {
      const value = state.memoizedState;
      if (value && typeof value === 'object'
          && typeof value.getSceneElements === 'function' && typeof value.updateScene === 'function') {
        window.__zoomCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__zoomCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { sections: {}, marks: {}, boxes: [] };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    const custom = element.customData || {};
    const box = { x: element.x, y: element.y, w: element.width, h: element.height };
    out.boxes.push(box);
    if (custom.kind === 'board-section') out.sections[custom.title] = box;
    if (custom.mark) out.marks[custom.mark] = box;
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.active = (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null;
  return out;
})()`;

/** Click the tab with this name on it. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

/**
 * The floor the fit is not allowed to go below, for content this wide.
 *
 * The rule the frontend applies, restated here rather than imported: a check that asks the
 * code under test what the answer should be cannot be red.
 */
const floorFor = (view, contentWidth) => Math.min(1, view.width / contentWidth);

const boundsOf = (boxes) => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

/** Is the middle of this box somewhere a reader can see? */
const onScreen = (probe, box) => {
  const x = (box.x + box.w / 2 + probe.view.scrollX) * probe.view.zoom + probe.view.offsetLeft;
  const y = (box.y + box.h / 2 + probe.view.scrollY) * probe.view.zoom + probe.view.offsetTop;
  return x > 0 && x < probe.view.width && y > 0 && y < probe.view.height;
};

const sameView = (one, other, tolerance = 2) =>
  Math.abs(one.scrollX - other.scrollX) <= tolerance
  && Math.abs(one.scrollY - other.scrollY) <= tolerance
  && Math.abs(one.zoom - other.zoom) <= 0.01;

const show = (view) =>
  `scrollX ${view.scrollX.toFixed(1)}, scrollY ${view.scrollY.toFixed(1)}, zoom ${view.zoom.toFixed(3)}`;

/** Wait for the board carrying this mark to be the one on the canvas. */
const boardShowing = (mark) => waitFor(async () => {
  const probe = await evaluate(PROBE);
  return probe.marks && probe.marks[mark] ? probe : null;
}, `the ${mark} board's own scene`);

/** Everything the page needs after it has been built again from nothing. */
async function openPage() {
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await seed(ALPHA, {
    type: 'rectangle', x: 0, y: 0, width: 320, height: 220,
    backgroundColor: '#e7f5ff', text: 'alpha', customData: { mark: 'alpha' },
  });

  await seed(COLUMN, {
    type: 'rectangle', ...STRUCTURE, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Project structure', hotkeyCode: 'KeyP', mark: 'column' },
  });
  await seed(COLUMN, {
    type: 'rectangle', ...DEVELOPMENT, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Development', hotkeyCode: 'KeyG' },
  });
  await seed(COLUMN, {
    type: 'rectangle', ...WIDE, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Wide', hotkeyCode: 'KeyJ' },
  });
  // A card near the top of each tall section, so "the section is in view" is about content
  // and not about an empty box.
  await seed(COLUMN, {
    type: 'rectangle', x: 40, y: 40, width: 300, height: 160,
    backgroundColor: '#e7f5ff', text: 'architecture', customData: { docKey: 'architecture' },
  });
  await seed(COLUMN, {
    type: 'rectangle', x: 40, y: 2300, width: 300, height: 160,
    backgroundColor: '#f3f0ff', text: 'the log', customData: { docKey: 'development-log' },
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await openPage();

  console.log('1. the board opens on Alpha, and the reader parks it somewhere of their own');
  let probe = await boardShowing('alpha');
  check('Alpha is the board in front', /Alpha/.test(probe.active ?? ''), String(probe.active));

  await wheel(400, 600);
  await wheel(0, 240, 2);   // Ctrl held: Excalidraw's own zoom gesture
  await sleep(400);
  probe = await evaluate(PROBE);
  const alphaParked = probe.view;
  check('the wheel moved Alpha', Math.abs(alphaParked.zoom - 1) > 0.01 || alphaParked.scrollX !== 0,
        show(alphaParked));

  console.log('\n2. a first visit to a tall board is not shrunk to fit its height');
  check('Column has a tab to click', await selectTab('Column'));
  probe = await boardShowing('column');
  await sleep(900);
  probe = await evaluate(PROBE);
  await shot('02-column-first-visit');
  const whole = boundsOf(probe.boxes);
  const wholeFloor = floorFor(probe.view, whole.w);
  check('the whole board is taller than the canvas, so the old fit was height-bound',
        probe.view.height / whole.h < wholeFloor,
        `height fit ${(probe.view.height / whole.h).toFixed(3)} against a floor of ${wholeFloor.toFixed(3)}`);
  check('the first visit opens at or above the floor',
        probe.view.zoom >= wholeFloor - 0.001,
        `opened at ${probe.view.zoom.toFixed(3)}, floor ${wholeFloor.toFixed(3)}`);

  console.log('\n3. Alt+P reaches Project structure without shrinking it to fit');
  await altPress('KeyP', 'p', 80);
  probe = await evaluate(PROBE);
  await shot('03-alt-p');
  const structure = probe.sections['Project structure'];
  const structureFloor = floorFor(probe.view, structure.w);
  check('Project structure is on screen', onScreen(probe, structure), JSON.stringify(probe.view));
  check('and it is drawn at or above the floor',
        probe.view.zoom >= structureFloor - 0.001,
        `landed at ${probe.view.zoom.toFixed(3)}, floor ${structureFloor.toFixed(3)}`);

  console.log('\n4. and Alt+G reaches Development the same way');
  await altPress('KeyG', 'g', 71);
  probe = await evaluate(PROBE);
  await shot('04-alt-g');
  const development = probe.sections.Development;
  const developmentFloor = floorFor(probe.view, development.w);
  check('Development is on screen', onScreen(probe, development), JSON.stringify(probe.view));
  check('and it is drawn at or above the floor',
        probe.view.zoom >= developmentFloor - 0.001,
        `landed at ${probe.view.zoom.toFixed(3)}, floor ${developmentFloor.toFixed(3)}`);

  console.log('\n5. but a section wider than the canvas is still fitted to the width');
  await altPress('KeyJ', 'j', 74);
  probe = await evaluate(PROBE);
  await shot('05-alt-j');
  const wide = probe.sections.Wide;
  const wideFloor = floorFor(probe.view, wide.w);
  check('the wide section is wider than the canvas, so the width is what binds',
        wideFloor < 1, `floor ${wideFloor.toFixed(3)}`);
  check('it is fitted to the width rather than pushed off the sides',
        Math.abs(probe.view.zoom - wideFloor) <= 0.02,
        `landed at ${probe.view.zoom.toFixed(3)}, width fit ${wideFloor.toFixed(3)}`);
  const leftEdge = (wide.x + probe.view.scrollX) * probe.view.zoom + probe.view.offsetLeft;
  const rightEdge = (wide.x + wide.w + probe.view.scrollX) * probe.view.zoom + probe.view.offsetLeft;
  check('so both of its sides are on screen',
        leftEdge >= -1 && rightEdge <= probe.view.width + 1,
        `left ${leftEdge.toFixed(1)}, right ${rightEdge.toFixed(1)}, canvas ${probe.view.width}`);

  console.log('\n6. a zoom the reader chose survives a reload');
  await wheel(0, -300, 2);   // in, past whatever the fit chose
  await wheel(-200, 300);
  await sleep(400);
  probe = await evaluate(PROBE);
  const columnParked = probe.view;
  check('the wheel moved Column off where the fit put it',
        !sameView(columnParked, { scrollX: 0, scrollY: 0, zoom: wideFloor }), show(columnParked));

  await sleep(1200);   // past the debounce the page writes on
  await send('Page.reload', { ignoreCache: false });
  await sleep(1500);
  await openPage();
  probe = await boardShowing('column');
  await sleep(1200);
  probe = await evaluate(PROBE);
  await shot('06-column-reloaded');
  check('the reload came back to Column', /Column/.test(probe.active ?? ''), String(probe.active));
  check('and to the view it was left at', sameView(probe.view, columnParked),
        `left at ${show(columnParked)}, came back to ${show(probe.view)}`);

  console.log('\n7. and it is remembered per board, not for the page');
  check('Alpha has a tab to click', await selectTab('Alpha'));
  probe = await boardShowing('alpha');
  await sleep(900);
  probe = await evaluate(PROBE);
  await shot('07-alpha-after-reload');
  check('Alpha came back to its own view, the one from before the reload',
        sameView(probe.view, alphaParked),
        `left at ${show(alphaParked)}, came back to ${show(probe.view)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
