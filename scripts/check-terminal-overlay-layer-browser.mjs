#!/usr/bin/env node
/**
 * Checks that a terminal block stops at the edge of the canvas, in a real browser.
 *
 * The overlay is drawn at the block's bounds in viewport coordinates, with no clamp: pan the
 * block above the top of the canvas area and `top` goes negative, and nothing used to stop it
 * there. The canvas wrapper declared no `overflow`, so the card was not clipped; the project
 * tabs and the header row are static and unpositioned, so a `z-index: 5` card painted over
 * them. That is #153: the tab strip and the buttons drawn across, the connection pill and
 * `Clear Canvas` hidden underneath, and — because the card's body takes the pointer —
 * unclickable as well as invisible.
 *
 * Since #261 the two are one bar — `.workspace-tabs` is the left-hand group of `.header` —
 * so the parts hit-tested below are parts of a single row. Both selectors are still asked
 * about separately, because the ladder that #153 settled is declared on both.
 *
 * Why a browser, and why `elementFromPoint`. A bounding rect ignores clipping entirely: a
 * clipped card still reports the same box it always did, so a check that measured rects would
 * be green before and after the fix. `document.elementFromPoint` asks the question the reader
 * asks — *what does a click here hit* — and it answers with the clip and the stacking order
 * both applied. So the geometry is asserted first (the card really is spread over the chrome,
 * or the rest of the file proves nothing), and every layering question after it goes through
 * a hit test.
 *
 * The last section is #112 turned round the other way: the card must still take the pointer
 * where it always did. A fix that stopped the overlay covering the chrome by making it
 * transparent, or by moving it, would pass every case above and undo the block.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-overlay-layer-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-layer-'));
const projectDir = join(workDir, 'layer-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'layer-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Layer Project',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

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
    EXCALIDRAW_TERMINAL: '1',
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

/** One request, with two more goes at the connection. See check-terminal-focus-browser. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}) => request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
  headers: { 'Content-Type': 'application/json' },
  ...options,
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(250);
}

/** A drag, in steps: both Excalidraw and xterm act on pointer moves, not on where it lands. */
async function drag(from, to, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
}

/** The imperative API, through the container's React fibre. See check-terminal-browser. */
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
        window.__layerCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The board, the card, the chrome the card can land on, and who a click there would hit.
 *
 * `hits` is the whole point of the file. For each named part of the page chrome it reports the
 * box, the element `document.elementFromPoint` finds at the middle of that box, and — the
 * question being asked — whether that element is the terminal overlay or something inside it.
 * A hit test applies the clip and the stacking order; a bounding rect applies neither.
 */
const PROBE = `(() => {
  const api = window.__layerCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null, authored: 0 };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    if ((element.customData || {}).kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    } else {
      out.authored++;
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.window = { width: window.innerWidth, height: window.innerHeight };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
             width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const nameOf = (node) => {
    if (!node) return 'nothing';
    const tag = node.tagName ? node.tagName.toLowerCase() : '?';
    const cls = typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    return tag + cls;
  };

  const card = document.querySelector('.terminal-card');
  const clear = Array.from(document.querySelectorAll('.header button'))
    .find((node) => (node.textContent || '').trim() === 'Clear Canvas') || null;
  const parts = {
    // Was the Excalidraw Canvas title, which #261 removed when the two strips became one
    // row. The restart button took its place here: it is the newest thing on the bar, and it
    // is the one whose press cannot be taken back.
    restart: document.querySelector('.header .restart-server__button'),
    status: document.querySelector('.header .status'),
    clear,
    tab: document.querySelector('.workspace-tabs .workspace-tab__select'),
    add: document.querySelector('.workspace-tabs__add'),
  };
  out.hits = {};
  for (const [name, node] of Object.entries(parts)) {
    const box = boxOf(node);
    if (!box) { out.hits[name] = null; continue; }
    const found = document.elementFromPoint(box.x, box.y);
    out.hits[name] = {
      box,
      found: nameOf(found),
      // The two answers this file is made of: did the click reach the part of the chrome it
      // was aimed at, and did the overlay take it instead.
      onChrome: Boolean(found && node.contains(found)),
      onOverlay: Boolean(card && found && (card === found || card.contains(found))),
    };
  }

  out.chrome = { tabs: boxOf(document.querySelector('.workspace-tabs')), header: boxOf(document.querySelector('.header')) };
  out.layers = {
    // Belt and braces, and the reason it is here: clipping alone is one declaration away from
    // being lost, and the chrome should outrank the overlays whether or not it is clipped.
    tabs: document.querySelector('.workspace-tabs') ? getComputedStyle(document.querySelector('.workspace-tabs')).zIndex : null,
    header: document.querySelector('.header') ? getComputedStyle(document.querySelector('.header')).zIndex : null,
    card: card ? getComputedStyle(card).zIndex : null,
    docs: null,
  };

  if (!card) return { ...out, card: null };
  out.card = {
    box: boxOf(card),
    body: boxOf(card.querySelector('.terminal-card__body')),
    header: boxOf(card.querySelector('.terminal-card__header')),
  };
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

const setView = async (scrollX, scrollY, zoom) => {
  await evaluate(`window.__layerCheckApi.updateScene({ appState: { scrollX: ${scrollX}, scrollY: ${scrollY}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
};

/**
 * The reproduction: the block panned up and left until its **body** covers the whole of the
 * page chrome.
 *
 * The body rather than the card, because the body is the part that takes the pointer — the
 * title band and the tab strip above it are transparent to it by design, so a hit test through
 * them would find the chrome even with the overlay uncliped and prove nothing.
 *
 * Two steps, and the second is what makes it exact. The card's chrome is sized in `em` off a
 * font-size that follows the zoom, so where the body starts is not known until it is measured;
 * the card moves linearly with the scroll, so one measured correction lands it.
 */
async function panOverChrome(zoom = 1.5) {
  const start = await evaluate(PROBE);
  let scene = await setView(-start.block.x, -start.block.y, zoom);
  const dx = (-30 - scene.card.body.left) / zoom;
  const dy = (-30 - scene.card.body.top) / zoom;
  return setView(scene.view.scrollX + dx, scene.view.scrollY + dy, zoom);
}

/**
 * The board where the last section wants it: well down the window, clear of the chrome and of
 * Excalidraw's own hint strip across the top of the canvas. Same arithmetic and same reason as
 * `check-terminal-focus-browser`.
 */
async function placeBoard(zoom = 0.8) {
  const scene = await evaluate(PROBE);
  return setView(320 / zoom - scene.block.x, (300 - scene.view.offsetTop) / zoom - scene.block.y, zoom);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so `Clear Canvas` has something to clear and the click can be shown
  // to have run rather than merely to have landed.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 200, height: 140,
                           backgroundColor: '#a5d8ff', text: 'the board' }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');

  console.log('1. the block is panned until its body is spread over the whole of the chrome');
  let scene = await panOverChrome();
  await shot('01-panned-over-chrome');
  {
    const body = scene.card.body;
    const header = scene.chrome.header;
    // Without this, every hit test below could be green because the card is somewhere else.
    check('the overlay body reaches above the top of the window',
          body.top < 0, `body.top ${body.top}`);
    check('and spans it left to right',
          body.left <= 0 && body.right >= scene.window.width,
          `${body.left}…${body.right} across ${scene.window.width}`);
    check('and reaches below the bottom of the header row',
          body.bottom > header.bottom, `body.bottom ${body.bottom} vs header.bottom ${header.bottom}`);
  }

  console.log('\n2. a click on the chrome hits the chrome, not the card over it');
  for (const [name, what] of [
    ['the project tab', 'tab'],
    ['the `+` on the tab strip', 'add'],
    ['the `Restart Server` button', 'restart'],
    ['the connection pill', 'status'],
    ['the `Clear Canvas` button', 'clear'],
  ]) {
    const hit = scene.hits[what];
    check(`${name} is what a click there finds`, hit && hit.onChrome && !hit.onOverlay,
          hit ? `found ${hit.found} at ${Math.round(hit.box.x)},${Math.round(hit.box.y)}` : 'not on the page');
  }

  console.log('\n3. and the chrome sits on a layer above the overlays either way');
  {
    const numeric = (value) => (value === 'auto' || value == null ? null : Number(value));
    const card = numeric(scene.layers.card);
    check('the card declares one', card !== null && Number.isFinite(card), String(scene.layers.card));
    for (const part of ['tabs', 'header']) {
      const value = numeric(scene.layers[part]);
      check(`the ${part} outrank it`, value !== null && card !== null && value > card,
            `${part} ${scene.layers[part]} vs card ${scene.layers.card}`);
    }
  }

  console.log('\n4. and the click on `Clear Canvas` runs, with the card still over it');
  {
    const before = await evaluate(PROBE);
    check('there is something on the board to clear', before.authored > 0, String(before.authored));
    await evaluate(`(() => { window.__hit = null;
      document.addEventListener('click', (event) => {
        const node = event.target;
        window.__hit = (node.tagName || '?').toLowerCase() + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : '');
      }, true);
    })()`);
    await click(before.hits.clear.box.x, before.hits.clear.box.y);
    const landed = await evaluate('window.__hit');
    await shot('02-clear-clicked');
    check('the click was taken by the button', /button/.test(String(landed)), String(landed));
    const emptied = await waitFor(async () => {
      const stored = await (await api('/api/elements')).json();
      return stored.count === 0 ? stored : null;
    }, 'the board to be cleared', 40).catch(() => null);
    check('and the board was cleared by it', emptied !== null,
          JSON.stringify((await (await api('/api/elements')).json()).count));
  }

  console.log('\n5. and none of #112 is undone: the body still types, the header still drags');
  // The block comes back on its own after the board is emptied — erasing one does not get rid
  // of it — so this waits for the overlay again rather than making a second block.
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to come back');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to come back');
  scene = await placeBoard();
  {
    await click(scene.card.body.x, scene.card.body.y);
    scene = await evaluate(PROBE);
    await shot('03-body-focused');
    check('a click in the body puts the keyboard in the emulator',
          /xterm/.test(scene.focused), scene.focused);
    check('and did not select the block instead',
          !scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

    const before = { x: scene.block.x, y: scene.block.y };
    // Low in the header rather than in the middle: the middle is the font buttons and the
    // mode chip, and those do take the pointer.
    const from = { x: scene.card.header.left + 6, y: scene.card.header.top + scene.card.header.height - 2 };
    await drag(from, { x: from.x + 140, y: from.y + 90 });
    scene = await evaluate(PROBE);
    await shot('04-dragged');
    check('and a drag on the header still moves the block',
          Math.abs(scene.block.x - before.x - 140 / scene.view.zoom) < 6
          && Math.abs(scene.block.y - before.y - 90 / scene.view.zoom) < 6,
          `${before.x},${before.y} → ${scene.block.x},${scene.block.y} at zoom ${scene.view.zoom}`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  if (server.exitCode !== null) console.error(`the canvas server exited (${server.exitCode}):\n${serverLog}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
