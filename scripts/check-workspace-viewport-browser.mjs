#!/usr/bin/env node
/**
 * Checks that each board keeps its own camera across a tab switch.
 *
 * The observation behind #156 reads as the tabs being wired together: pan one board and
 * the other pans with it. Nothing crosses. There is simply *one* viewport for the whole
 * page — the Excalidraw element carries no React key, so it is never remounted, the scene
 * is swapped in place on a switch, and `scrollX`, `scrollY` and `zoom` carry straight over
 * from the board you left. Nothing saved a scroll position per board, and nothing restored
 * one. Two boards whose content sits at different coordinates make it look worse still:
 * the second one opens on empty canvas, which reads as that project's drawing being gone.
 *
 * Only a browser can answer it. The viewport is `appState` on a mounted component; a
 * switch is a click on the strip followed by a reconnect and a scene replacement; and
 * "where the board was left" is a number that exists nowhere on the server. All three
 * type-check perfectly whether or not this works.
 *
 * The pan and the zoom are wheel gestures over the canvas, because that is what a reader
 * does, and because a viewport set through the API would prove only that the API can set
 * one. What is asserted afterwards is not an exact scroll — that would be asserting
 * Excalidraw's arithmetic — but the three things a reader would notice: the second board
 * did not open where the first one was parked, its own content is in view, and the first
 * board came back to where it was left.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server, both
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-workspace-viewport-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

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

// ─── Two projects, whose drawings are nowhere near each other ──
//
// Far apart on purpose: a board that inherits the other board's camera opens on empty
// canvas, which is both the reader's complaint and the sharpest thing to assert.

const workDir = mkdtempSync(join(tmpdir(), 'check-workspace-viewport-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const ALPHA = 'alpha-project';
const BETA = 'beta-project';
const alphaDir = join(workDir, ALPHA);
const betaDir = join(workDir, BETA);
for (const dir of [alphaDir, betaDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: ALPHA, path: alphaDir.replace(/\\/g, '/') },
    { id: BETA, path: betaDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so nothing else is drawing on
// these boards and nothing else is moving the camera.
writeFileSync(join(alphaDir, 'board.config.json'),
              JSON.stringify({ name: 'Alpha', repo: 'vitorengers/vibemaxxing' }), 'utf8');
writeFileSync(join(betaDir, 'board.config.json'),
              JSON.stringify({ name: 'Beta', repo: 'vitorengers/vibemaxxing' }), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
  },
}).child;
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

/** The reader's own pan: a wheel over the canvas. Ctrl held is the reader's own zoom. */
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
        window.__viewCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__viewCheckApi;
  if (!api) return { error: 'no api handle' };
  const boxes = {};
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.mark) boxes[custom.mark] = { x: element.x, y: element.y, w: element.width, h: element.height };
  }
  const state = api.getAppState();
  return {
    boxes,
    view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
            offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
            width: state.width, height: state.height },
    active: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
    connecting: /connecting/i.test(document.body.textContent || ''),
  };
})()`;

/** Click the tab with this name on it — the gesture the whole issue is about. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

/** Is the middle of this box somewhere a reader can see? */
const onScreen = (probe, box) => {
  if (!box) return false;
  const x = (box.x + box.w / 2 + probe.view.scrollX) * probe.view.zoom + probe.view.offsetLeft;
  const y = (box.y + box.h / 2 + probe.view.scrollY) * probe.view.zoom + probe.view.offsetTop;
  return x > 0 && x < probe.view.width && y > 0 && y < probe.view.height;
};

const sameView = (one, other, tolerance = 2) =>
  Math.abs(one.scrollX - other.scrollX) <= tolerance
  && Math.abs(one.scrollY - other.scrollY) <= tolerance
  && Math.abs(one.zoom - other.zoom) <= 0.01;

const show = (view) => `scrollX ${view.scrollX.toFixed(1)}, scrollY ${view.scrollY.toFixed(1)}, zoom ${view.zoom.toFixed(3)}`;

/** Wait for the board named by `mark` to be the one on the canvas. */
const boardShowing = (mark) => waitFor(async () => {
  const probe = await evaluate(PROBE);
  return probe.boxes && probe.boxes[mark] ? probe : null;
}, `the ${mark} board's own scene`);

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await seed(ALPHA, {
    type: 'rectangle', x: 0, y: 0, width: 320, height: 220,
    backgroundColor: '#e7f5ff', text: 'alpha', customData: { mark: 'alpha' },
  });
  await seed(BETA, {
    type: 'rectangle', x: 7000, y: 5200, width: 320, height: 220,
    backgroundColor: '#f3f0ff', text: 'beta', customData: { mark: 'beta' },
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  console.log('1. the board opens on Alpha, and a wheel over it moves Alpha');
  let probe = await boardShowing('alpha');
  check('Alpha is the board in front', /Alpha/.test(probe.active ?? ''), String(probe.active));
  const opened = probe.view;

  await wheel(600, 900);
  await wheel(0, 240, 2);   // Ctrl held: Excalidraw's own zoom gesture
  await sleep(400);
  probe = await evaluate(PROBE);
  const alphaParked = probe.view;
  await shot('01-alpha-parked');
  check('the wheel moved Alpha off where it opened', !sameView(alphaParked, opened),
        `${show(opened)} → ${show(alphaParked)}`);

  console.log('\n2. switching to Beta does not hand Beta the camera Alpha was parked at');
  check('Beta has a tab to click', await selectTab('Beta'));
  probe = await boardShowing('beta');
  await sleep(600);
  probe = await evaluate(PROBE);
  const betaOpened = probe.view;
  await shot('02-beta-first-visit');
  check('Beta is the board in front', /Beta/.test(probe.active ?? ''), String(probe.active));
  check('Beta did not inherit the camera Alpha was left at', !sameView(betaOpened, alphaParked),
        `both boards are looking at ${show(alphaParked)}`);
  check('and Beta\'s own drawing is on screen, not a blank stretch of canvas',
        onScreen(probe, probe.boxes.beta),
        `${show(betaOpened)} with beta at ${JSON.stringify(probe.boxes.beta)}`);

  console.log('\n3. moving Beta leaves Alpha where it was');
  await wheel(-900, -500);
  await wheel(0, -180, 2);
  await sleep(400);
  probe = await evaluate(PROBE);
  const betaParked = probe.view;
  check('the wheel moved Beta', !sameView(betaParked, betaOpened),
        `${show(betaOpened)} → ${show(betaParked)}`);

  check('Alpha has a tab to click', await selectTab('Alpha'));
  probe = await boardShowing('alpha');
  await sleep(600);
  probe = await evaluate(PROBE);
  await shot('03-alpha-returned');
  check('Alpha came back to where it was left', sameView(probe.view, alphaParked),
        `left at ${show(alphaParked)}, came back to ${show(probe.view)}`);
  // Deliberately not "and Alpha's drawing is on screen": the wheel in section 1 panned off
  // it, and putting a board back where it was left means putting it back there even when
  // the reader had left it looking at nothing. Fitting to content is the *first* visit only.
  check('so it was restored rather than re-fitted onto its content',
        !onScreen(probe, probe.boxes.alpha), JSON.stringify(probe.boxes.alpha));

  console.log('\n4. and a board visited twice is remembered, not re-fitted');
  check('Beta has a tab to click again', await selectTab('Beta'));
  probe = await boardShowing('beta');
  await sleep(600);
  probe = await evaluate(PROBE);
  await shot('04-beta-returned');
  check('Beta came back to where it was left', sameView(probe.view, betaParked),
        `left at ${show(betaParked)}, came back to ${show(probe.view)}`);
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
