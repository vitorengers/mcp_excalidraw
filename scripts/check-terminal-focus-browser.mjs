#!/usr/bin/env node
/**
 * Checks who owns the pointer over a terminal block, in a real browser.
 *
 * The block used to be transparent to the pointer everywhere except a strip along the
 * bottom that said `click here to type`. That was a deliberate trade — the pointer stayed
 * with the canvas so Excalidraw kept the shape's handles — and #112 is the observation that
 * it was priced too high: the handles live *outside* the block's bounds, so the overlay can
 * take the pointer and the shape keeps every one of them, as long as some band still selects
 * and drags it. The header is that band.
 *
 * So the questions here are the ones only a browser answers, and each of them is a half of
 * the trade being turned round:
 *
 * - **does a click in the middle of the body reach the shell?** Not the strip, the middle.
 *   And does a command typed straight after it run, without `p`, `w` and `d` being taken as
 *   Excalidraw's freedraw and diamond tools.
 * - **does the header still move the block, and does the body no longer?** Both, or the
 *   block is either unmovable or untypable.
 * - **is the shape still a shape?** A corner drag has to resize it after the terminal has
 *   had the pointer, and the new size has to reach the server as `cols` × `rows`.
 * - **and is the wheel used rather than swallowed?** The scrollback takes it while there is
 *   any scrollback at all — at the ends of it as much as in the middle, which is #256 — and
 *   the canvas takes it over a block that has none. And since #162 that is asked of each
 *   axis on its own: a touchpad pan carries both, and the emulator has no use for the
 *   horizontal one, so it goes to the board even while the vertical one does not.
 *   `check-terminal-wheel-edge-browser.mjs` is where the ends are asked of both of the
 *   block's views; what is here is the pair that frames them.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own
 * canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-focus-browser.mjs [--chrome <path>] [--shots <dir>]
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
const isWindows = process.platform === 'win32';

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

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-focus-'));
const projectDir = join(workDir, 'focus-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'focus-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Focus Project',
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

/**
 * One request, with two more goes at it.
 *
 * Not a retry of the *case* — a 4xx comes straight back. This is for the connection itself,
 * which on this machine occasionally refuses with `fetch failed` while several servers and a
 * headless Chrome are competing for sockets.
 */
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

/**
 * The clipboard permission, granted over the **browser** target rather than the page's.
 *
 * `Browser.grantPermissions` is refused on a page session, and without it Chrome answers
 * `navigator.clipboard.writeText` with `NotAllowedError` — which the copy case would then be
 * unable to tell apart from the block never asking.
 */
async function grantClipboard() {
  const endpoint = await waitFor(async () =>
    (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl,
  'the Chrome browser target');
  await new Promise((resolve, reject) => {
    const browserSocket = new WebSocket(endpoint);
    browserSocket.once('open', () => browserSocket.send(JSON.stringify({
      id: 1,
      method: 'Browser.grantPermissions',
      params: { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] },
    })));
    browserSocket.once('message', () => { browserSocket.close(); resolve(); });
    browserSocket.once('error', reject);
  });
}

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

/**
 * One notch of the wheel, where the pointer is. Negative `deltaY` is towards the top.
 *
 * `deltaX` is the axis a touchpad pan carries and a wheel usually does not, which is why it
 * is last and defaults to nothing: every case written before #162 turns a mouse wheel. A
 * pan carries both at once, so the two are separate arguments rather than a direction.
 */
async function wheel(x, y, deltaY, notches = 1, deltaX = 0) {
  for (let notch = 0; notch < notches; notch++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0,
    });
    await sleep(80);
  }
  await sleep(250);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(25);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** A line, ending in the carriage return a terminal actually sends for Enter. */
async function run(line) {
  await typeText(line);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
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
        window.__focusCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Where the block is, where the parts of the overlay are, and who takes the pointer.
 *
 * `selectionRects` is how a mouse selection is seen from outside the emulator: xterm draws
 * one `<div>` per selected run into `.xterm-selection`, so a count above zero is text the
 * reader has selected with a drag.
 */
const PROBE = `(() => {
  const api = window.__focusCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null };
  for (const element of api.getSceneElements()) {
    if ((element.customData || {}).kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.tool = state.activeTool ? state.activeTool.type : null;
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  const card = document.querySelector('.terminal-card');
  if (!card) return { ...out, card: null };
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const body = card.querySelector('.terminal-card__body');
  const header = card.querySelector('.terminal-card__header');
  out.card = {
    box: boxOf(card),
    body: boxOf(body),
    header: boxOf(header),
    // The strip along the bottom of the block, which #144 removed. Anything but null here
    // is that strip back, offering itself as the way in the screen already is.
    prompt: boxOf(card.querySelector('.terminal-card__prompt')),
    bodyPointerEvents: body ? getComputedStyle(body).pointerEvents : null,
    headerPointerEvents: header ? getComputedStyle(header).pointerEvents : null,
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    // What the emulator's own viewport has left to scroll, in pixels, which is what decides
    // who owns a vertical wheel since #256. Zero is a screen with nothing behind it.
    scrollback: (() => {
      const viewport = card.querySelector('.xterm-viewport');
      return viewport ? viewport.scrollHeight - viewport.clientHeight : 0;
    })(),
    selectionRects: card.querySelectorAll('.xterm-selection div').length,
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
    // xterm marks a live mouse protocol with a class on its own root rather than on the
    // event, and that class is the guard forwardWheelToCanvas reads. True here means a
    // program has asked for the pointer, so the wheel is being sent to it as an escape.
    mouseEvents: !!card.querySelector('.xterm.enable-mouse-events'),
  };
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const containsPath = (haystack, needle) =>
  String(haystack ?? '').replace(/\\/g, '/').toLowerCase()
    .includes(String(needle ?? '').replace(/\\/g, '/').toLowerCase());

/** Enough lines to fill the block several times over, so there is a scrollback to scroll. */
const MANY_LINES = isWindows
  ? '1..60 | ForEach-Object { "line $_" }'
  : 'i=1; while [ $i -le 60 ]; do echo "line $i"; i=$((i+1)); done';

/**
 * Enough scrollback for a whole pan to stay inside it.
 *
 * Sixty lines is three or four notches, and a gesture is longer than that: run out of
 * scrollback halfway and the rest of the pan is handed to the board *correctly*, by the
 * rule case 7 asserts, which would be read here as the swing this case is looking for.
 */
const DEEP_SCROLLBACK = isWindows
  ? '1..400 | ForEach-Object { "deep $_" }'
  : 'i=1; while [ $i -le 400 ]; do echo "deep $i"; i=$((i+1)); done';

/** Something to interrupt, and something to say the shell survived being interrupted. */
const LONG_WAIT = isWindows
  ? "Start-Sleep -Seconds 25; Write-Output ('SUR'+'VIVED')"
  : 'sleep 25; echo "SUR""VIVED"';
const MARKER = isWindows
  ? "Write-Output ('IN'+'TERRUPTED')"
  : 'echo "IN""TERRUPTED"';

/**
 * `DECSET 1006` and `1000` — how a program says it wants the pointer — into the parser.
 *
 * Both, and in that order, because the pair is what a program actually sends: `1000` alone
 * leaves xterm on its default encoding, and a report in that encoding leaves the emulator
 * through `onBinary` rather than `onData` — a door this frontend does not listen at, so the
 * report would be dropped before the network and the case would be measuring the wrong
 * thing. `1006` is SGR, which every mouse-reporting program of the last decade asks for.
 *
 * Into the *parser* rather than through the shell, and that is a Windows fact rather than a
 * preference: a `printf '\\033[?1000h'` from `bash` arrives at the pty intact, but the same
 * sequence written by anything running under PowerShell is swallowed by the pseudoconsole
 * and never reaches the browser. Measured both ways before this was written. The shell is
 * the machine's, so the check would be asking a different question on this machine than on
 * a Linux one, and the question it wants is about xterm: the moment its parser sees this it
 * puts `enable-mouse-events` on its own root and starts sending the wheel out as an escape,
 * which is exactly the state `claude` — what blocks here routinely run — leaves it in.
 *
 * The emulator is reached the way the Excalidraw handle above is, through the React fibre,
 * because it lives in a ref inside `TerminalScreen` and nothing exports it.
 */
const MOUSE_ON = `(() => {
  for (const screen of document.querySelectorAll('.terminal-card__screen')) {
    const key = Object.keys(screen).find((name) => name.startsWith('__reactFiber$'));
    if (!key) continue;
    let node = screen[key];
    for (let up = 0; up < 8 && node; up++) {
      let state = node.memoizedState;
      for (let along = 0; along < 40 && state; along++) {
        const held = state.memoizedState;
        const terminal = held && typeof held === 'object' ? held.current : null;
        if (terminal && typeof terminal.write === 'function' && terminal.options) {
          terminal.write('\\u001b[?1006h\\u001b[?1000h');
          return true;
        }
        state = state.next;
      }
      node = node.return;
    }
  }
  return false;
})()`;

/**
 * Every byte the block sent to the shell, so "the program was told" is an observation.
 *
 * The keyboard and the mouse leave by the same door — `POST /api/terminal/input` — so the
 * list is emptied before each gesture rather than read as a whole.
 */
const SPY_INPUT = `(() => {
  window.__terminalInput = [];
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (String(url).includes('/api/terminal/input') && init && typeof init.body === 'string') {
      try { window.__terminalInput.push(JSON.parse(init.body).data); } catch { /* not ours */ }
    }
    return real(input, init);
  };
  return true;
})()`;

/**
 * Where the board was after each wheel of a gesture, recorded in the page.
 *
 * A pan that swings can end where it started — the signs of a hand's tremor alternate — so
 * the reading that matters is taken during the gesture, not after it. Listening in the
 * capture phase at the window puts this ahead of everything the page does with the event,
 * and the frame after is where Excalidraw has finished doing it.
 *
 * Only the wheels the pointer made. The overlay answers a wheel by re-dispatching one at
 * the canvas, which arrives here too — counting those would be counting the same gesture
 * twice, and out of order at that.
 */
const SPY_SCROLL_X = `(() => {
  window.__wheelScrollX = [];
  window.__wheelForwarded = [];
  if (!window.__wheelScrollXBound) {
    window.__wheelScrollXBound = true;
    window.addEventListener('wheel', (event) => {
      if (!event.isTrusted) { window.__wheelForwarded.push(event.deltaX); return; }
      const seen = { deltaX: event.deltaX, deltaY: event.deltaY };
      requestAnimationFrame(() => {
        const state = window.__focusCheckApi.getAppState();
        seen.scrollX = state.scrollX;
        seen.scrollY = state.scrollY;
        window.__wheelScrollX.push(seen);
      });
    }, true);
  }
  return true;
})()`;

/**
 * The board where this check wants it: round numbers, so a corner converts back exactly.
 *
 * Well down the window on purpose. Excalidraw draws its hint — "Press Enter to add text" —
 * in a strip across the top of the canvas whenever something is selected, and that strip is
 * inside its container, so a press that lands on it never reaches the shape. A block put
 * near the top of the viewport has its header under that hint, and the header is what half
 * the cases here have to grab.
 */
async function placeBoard(zoom = 0.8) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__focusCheckApi.updateScene({ appState: { scrollX: ${320 / zoom - scene.block.x}, scrollY: ${(300 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so the block has content to be placed away from.
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

  await grantClipboard();
  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');
  let scene = await placeBoard();

  console.log('1. the body takes the pointer, the header leaves it to the canvas');
  check('the emulator\'s host takes the pointer', scene.card.bodyPointerEvents === 'auto',
        String(scene.card.bodyPointerEvents));
  check('and the header does not, so it is still the shape underneath',
        scene.card.headerPointerEvents === 'none', String(scene.card.headerPointerEvents));
  // It stopped *offering* itself in #112, when the screen took the pointer, and #144 took
  // the strip away rather than leaving a band that narrates where the pointer already is.
  check('and the strip that used to offer itself as the way in is gone',
        scene.card.prompt === null, JSON.stringify(scene.card.prompt));

  console.log('\n2. a click in the middle of the body puts the keyboard in the terminal');
  await click(scene.card.body.x, scene.card.body.y);
  scene = await evaluate(PROBE);
  await shot('01-focused');
  check('the emulator has the focus', /xterm/.test(scene.focused), scene.focused);
  check('and clicking it did not select the block instead',
        !scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

  // A shell on a terminal has a REPL to start, and keystrokes sent into one that is still
  // starting go nowhere. A reader waits for the prompt to be drawn; so does this.
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(500);
  await typeText('pwd');
  // `p` is Excalidraw's freedraw and `d` its diamond. A keystroke that reached the canvas
  // would have changed the tool, and the reader would be drawing instead of typing.
  check('and none of what was typed reached Excalidraw\'s tools',
        (await evaluate(PROBE)).tool === 'selection', (await evaluate(PROBE)).tool);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => containsPath((await evaluate(PROBE)).card?.screen, projectDir),
                'the shell to answer pwd');
  scene = await evaluate(PROBE);
  await shot('02-pwd');
  check('the command typed straight after the click ran',
        containsPath(scene.card.screen, projectDir), String(scene.card.screen).slice(-200));

  console.log('\n3. a drag on the header moves the block');
  {
    const before = { x: scene.block.x, y: scene.block.y };
    // Low in the header rather than in the middle of it: the middle is where the two font
    // buttons and the mode chip are, and those do take the pointer.
    const from = { x: scene.card.header.left + 6, y: scene.card.header.top + scene.card.header.height - 2 };
    await drag(from, { x: from.x + 140, y: from.y + 90 });
    scene = await evaluate(PROBE);
    await shot('03-dragged');
    check('the block moved with it',
          Math.abs(scene.block.x - before.x - 140 / scene.view.zoom) < 6
          && Math.abs(scene.block.y - before.y - 90 / scene.view.zoom) < 6,
          `${before.x},${before.y} → ${scene.block.x},${scene.block.y} at zoom ${scene.view.zoom}`);
  }

  console.log('\n4. a drag in the body selects text, and leaves the block where it is');
  {
    const before = { x: scene.block.x, y: scene.block.y };
    const from = { x: scene.card.body.left + 4, y: scene.card.body.top + 4 };
    await drag(from, { x: from.x + 160, y: from.y + 26 });
    scene = await evaluate(PROBE);
    await shot('04-selected');
    check('the block did not move',
          Math.abs(scene.block.x - before.x) < 0.5 && Math.abs(scene.block.y - before.y) < 0.5,
          `${before.x},${before.y} → ${scene.block.x},${scene.block.y}`);
    check('and the drag selected text in the terminal instead',
          scene.card.selectionRects > 0, String(scene.card.selectionRects));
  }

  console.log('\n5. Ctrl+C over that selection copies it, rather than interrupting');
  // The call is wrapped rather than the clipboard read back: `readText` in headless Chrome
  // waits on a prompt nobody is here to answer even with the permission granted. What the
  // wrapper records is both halves — the text the block asked to copy, and whether the
  // browser accepted the write, which is the part a swallowed rejection would have hidden.
  await evaluate(`(() => {
    window.__copied = null;
    const real = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (text) => {
      window.__copied = { text, state: 'pending' };
      return real(text).then(() => { window.__copied.state = 'ok'; },
                             (error) => { window.__copied.state = 'refused: ' + error.message; });
    };
  })()`);
  const screenBefore = scene.card.screen;
  await pressKey('KeyC', 'c', 2, 67);
  await sleep(600);
  {
    const copied = await evaluate('window.__copied');
    scene = await evaluate(PROBE);
    const text = typeof copied?.text === 'string' ? copied.text : '';
    check('the selected text was handed to the clipboard', text.trim().length > 0,
          JSON.stringify(copied));
    check('and the browser took it', copied?.state === 'ok', JSON.stringify(copied?.state));
    check('and it is text that was on the screen',
          text.trim().length > 0 && String(screenBefore).includes(text.trim().split('\n')[0].trim()),
          JSON.stringify(text.slice(0, 120)));
    check('the selection was let go, so the next Ctrl+C is an interrupt again',
          scene.card.selectionRects === 0, String(scene.card.selectionRects));
  }

  // And it still is one: with nothing selected, Ctrl+C has to reach the shell.
  await run(LONG_WAIT);
  await sleep(1500);
  await pressKey('KeyC', 'c', 2, 67);
  await sleep(800);
  await run(MARKER);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('INTERRUPTED'),
                'the shell to take a command again after the interrupt', 60);
  scene = await evaluate(PROBE);
  check('Ctrl+C with nothing selected still interrupts the shell',
        !String(scene.card.screen).includes('SURVIVED'), String(scene.card.screen).slice(-300));

  console.log('\n6. the block is still a block: the header selects it and a corner resizes it');
  // Further out than the rest of the file, and for a reason about the window rather than
  // about the code: a fresh block is the default grid in scene units — a thousand of them tall
  // since #199 made it 30 rows of 18px text — and at 0.8 its bottom-right corner plus the
  // 180 × 120 this case drags it by lands past the bottom of the window. A press dispatched
  // outside the viewport is not a press on the handle.
  scene = await placeBoard(0.4);
  {
    const header = { x: scene.card.header.left + 6, y: scene.card.header.top + scene.card.header.height - 2 };
    await click(header.x, header.y);
    scene = await evaluate(PROBE);
    check('clicking the header selects the shape',
          scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

    const [gridBefore] = (await (await api('/api/terminal')).json())?.sessions ?? [];
    const before = { w: scene.block.w, h: scene.block.h };
    const corner = toViewport(scene, scene.block.x + scene.block.w, scene.block.y + scene.block.h);
    // A few pixels *outside* the corner rather than exactly on it: the handle is a square
    // centred there, so both land on it, but the point exactly on the corner is also the card's own
    // last pixel, and which of the two takes the press is a rounding — one the block size decides,
    // and #199 changed the block size. See check-terminal-geometry-browser.
    await drag({ x: corner.x + 5, y: corner.y + 5 }, { x: corner.x + 185, y: corner.y + 125 });
    scene = await evaluate(PROBE);
    await shot('05-resized');
    check('dragging its corner still resizes it',
          scene.block.w > before.w + 50 && scene.block.h > before.h + 30,
          `${before.w}×${before.h} → ${scene.block.w}×${scene.block.h}`);

    const gridAfter = await waitFor(async () => {
      const [session] = (await (await api('/api/terminal')).json())?.sessions ?? [];
      return session && session.cols > (gridBefore?.cols ?? 0) ? session : null;
    }, 'the new grid to reach the server');
    check('and the session was told the new size',
          gridAfter.cols > gridBefore.cols && gridAfter.rows > gridBefore.rows,
          `${gridBefore.cols}×${gridBefore.rows} → ${gridAfter.cols}×${gridAfter.rows}`);
  }

  console.log('\n7. the wheel over the body is used, not swallowed');
  scene = await placeBoard();

  {
    // Before the sixty lines, and that ordering is #256. The block has printed a prompt and
    // a handful of answers into a screen far taller than either, so there is nothing behind
    // it for a wheel to bring back — and *that* is the case #112 answered when it gave the
    // board every wheel the terminal could not use. What #256 narrowed is the other
    // situation the same sentence used to cover: a scrollback the reader has reached the end
    // of, which is not the same as no scrollback and no longer answered the same way.
    check('the block has nothing behind its screen yet', scene.card.scrollback <= 2,
          `${scene.card.scrollback}px, grid ${scene.card.grid}`);
    const view = { scrollX: scene.view.scrollX, scrollY: scene.view.scrollY, zoom: scene.view.zoom };
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    const after = (await evaluate(PROBE)).view;
    check('so a wheel over it reaches the canvas',
          Math.abs(after.scrollY - view.scrollY) > 1 || Math.abs(after.scrollX - view.scrollX) > 1
          || Math.abs(after.zoom - view.zoom) > 0.001,
          `${JSON.stringify(view)} → ${JSON.stringify(after)}`);
  }

  scene = await placeBoard();
  await click(scene.card.body.x, scene.card.body.y);
  await run(MANY_LINES);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('line 60'),
                'the shell to print sixty lines', 80);
  await sleep(500);
  scene = await placeBoard();

  {
    // And with sixty lines behind it, the same wheel at the same place is the terminal's,
    // even parked at the bottom where the emulator has nothing to show for it. This case
    // used to assert the opposite; it is the one the reader in #256 met.
    // `check-terminal-wheel-edge-browser.mjs` asks both ends of both views.
    check('the sixty lines gave it a scrollback', scene.card.scrollback > 50,
          `${scene.card.scrollback}px`);
    const view = { scrollX: scene.view.scrollX, scrollY: scene.view.scrollY, zoom: scene.view.zoom };
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    const after = (await evaluate(PROBE)).view;
    check('a wheel at the bottom of a scrollback stays with the terminal',
          Math.abs(after.scrollY - view.scrollY) < 1 && Math.abs(after.scrollX - view.scrollX) < 1
          && Math.abs(after.zoom - view.zoom) < 0.001,
          `${JSON.stringify(view)} → ${JSON.stringify(after)}`);
  }

  scene = await placeBoard();
  {
    const before = { screen: scene.card.screen, view: scene.view };
    await wheel(scene.card.body.x, scene.card.body.y, -120, 3);
    scene = await evaluate(PROBE);
    await shot('06-scrolled');
    check('and a wheel it can use scrolls the scrollback',
          scene.card.screen !== before.screen,
          `${String(before.screen).slice(0, 60)} … / ${String(scene.card.screen).slice(0, 60)} …`);
    check('without the board moving underneath it',
          Math.abs(scene.view.scrollY - before.view.scrollY) < 1
          && Math.abs(scene.view.zoom - before.view.zoom) < 0.001,
          `${JSON.stringify(before.view)} → ${JSON.stringify(scene.view)}`);
  }

  console.log('\n8. the horizontal axis of a wheel is the board\'s, whoever wanted the vertical');
  // #162: a touchpad pan carries both axes at once, and the emulator has no use for one of
  // them — xterm has no horizontal scrolling and emits no escape sequence for one. So the
  // gesture is answered per axis rather than whole, or a pan over a block is a pan that
  // only goes up and down.
  {
    scene = await placeBoard();
    const before = { view: scene.view, screen: scene.card.screen };
    const expected = 120 / before.view.zoom;
    await wheel(scene.card.body.x, scene.card.body.y, 0, 1, -120);
    scene = await evaluate(PROBE);
    check('a wheel with only a horizontal axis pans the board',
          Math.abs(scene.view.scrollX - before.view.scrollX - expected) < expected * 0.35,
          `${before.view.scrollX} → ${scene.view.scrollX}, wanted +${expected} at zoom ${before.view.zoom}`);
    check('and does not move the board up or down',
          Math.abs(scene.view.scrollY - before.view.scrollY) < 1,
          `${before.view.scrollY} → ${scene.view.scrollY}`);
    check('and does not scroll the scrollback either',
          scene.card.screen === before.screen,
          `${String(before.screen).slice(0, 60)} … / ${String(scene.card.screen).slice(0, 60)} …`);
  }

  {
    // Back to the bottom of the scrollback first, so the wheel below is one the emulator
    // can genuinely use — that is the half of the gesture it is allowed to keep.
    await wheel(scene.card.body.x, scene.card.body.y, 120, 6);
    scene = await placeBoard();
    const before = { view: scene.view, screen: scene.card.screen };
    const expected = 120 / before.view.zoom;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 1, -120);
    scene = await evaluate(PROBE);
    await shot('07-panned-diagonally');
    check('a diagonal wheel scrolls the scrollback',
          scene.card.screen !== before.screen,
          `${String(before.screen).slice(0, 60)} … / ${String(scene.card.screen).slice(0, 60)} …`);
    check('and pans the board sideways at the same time',
          Math.abs(scene.view.scrollX - before.view.scrollX - expected) < expected * 0.35,
          `${before.view.scrollX} → ${scene.view.scrollX}, wanted +${expected} at zoom ${before.view.zoom}`);
    check('while leaving the board where it was up and down',
          Math.abs(scene.view.scrollY - before.view.scrollY) < 1,
          `${before.view.scrollY} → ${scene.view.scrollY}`);
  }

  {
    // #198: a finger moving up a trackpad is never exactly vertical. Every event of the pan
    // carries a few pixels of sideways drift whose sign follows the tremor of the hand, and
    // an axis split that asks only `deltaX !== 0` answers each of them as a pan — so the
    // board swings left, right, left for the length of the gesture. One such event is
    // invisible; the complaint is the stream, so this dispatches one.
    //
    // The net displacement is not the measurement: the signs alternate, so a board that
    // swung the whole way can still end within a pixel of where it started. What is asserted
    // is the worst position the board reached *during* the pan.
    //
    // Two of the events carry no vertical at all — the finger pausing on its way up while
    // still drifting sideways. Read on their own they are a sideways pan; read as part of
    // the gesture they are the same drift, which is what makes the lock gesture-scoped
    // rather than a ratio applied per event.
    scene = await placeBoard();
    await click(scene.card.body.x, scene.card.body.y);
    await run(DEEP_SCROLLBACK);
    await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('deep 400'),
                  'the shell to print four hundred lines', 120);
    await sleep(500);
    scene = await evaluate(PROBE);
    const before = { view: scene.view, screen: scene.card.screen };
    // Sampled from inside the page rather than over the protocol between events: a gesture
    // is defined by the gaps in it, so a round trip per event would be the check dictating
    // the timing it is measuring — and at 60-120 Hz a real pan leaves no room for one.
    await evaluate(SPY_SCROLL_X);
    const drift = [-3, 2, -4, 3, [-3, 0], 4, -2, 3, [-4, 0], 2, -3, 4];
    for (const step of drift) {
      const [deltaX, deltaY] = Array.isArray(step) ? step : [step, -120];
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: scene.card.body.x, y: scene.card.body.y,
        deltaX, deltaY, button: 'none', buttons: 0,
      });
      await sleep(40);
    }
    await sleep(250);
    const seen = await evaluate('window.__wheelScrollX');
    const swing = Math.max(0, ...seen.map((at) => Math.abs(at.scrollX - before.view.scrollX)));
    scene = await evaluate(PROBE);
    await shot('07b-drifted-up-the-trackpad');
    check('a vertical pan carrying sideways drift never swings the board',
          swing < 2,
          `worst ${swing.toFixed(2)}px from ${before.view.scrollX}, forwarded `
          + `[${(await evaluate('window.__wheelForwarded')).join(' ')}], saw `
          + seen.map((at) => `${at.deltaX}/${at.deltaY}→`
                             + `${(at.scrollX - before.view.scrollX).toFixed(2)}`).join(' '));
    check('and leaves it where it started when the pan ends',
          Math.abs(scene.view.scrollX - before.view.scrollX) < 2,
          `${before.view.scrollX} → ${scene.view.scrollX}`);
    check('while the vertical half still reached the emulator',
          scene.card.screen !== before.screen,
          `${String(before.screen).slice(0, 60)} … / ${String(scene.card.screen).slice(0, 60)} …`);
  }

  {
    // And the gesture ends when the finger comes off: a sideways pan started after the one
    // above pans at once, with no modifier and nothing to wait for.
    scene = await placeBoard();
    const before = { view: scene.view };
    const expected = 120 / before.view.zoom;
    await wheel(scene.card.body.x, scene.card.body.y, 0, 1, -120);
    scene = await evaluate(PROBE);
    check('a sideways pan right after a vertical one still pans the board',
          Math.abs(scene.view.scrollX - before.view.scrollX - expected) < expected * 0.35,
          `${before.view.scrollX} → ${scene.view.scrollX}, wanted +${expected} at zoom ${before.view.zoom}`);
  }

  await evaluate(SPY_INPUT);
  check('a program can ask for the pointer', await evaluate(MOUSE_ON) === true);
  await waitFor(async () => (await evaluate(PROBE)).card?.mouseEvents,
                'the emulator to hand the pointer over');
  {
    scene = await placeBoard();
    const before = { view: scene.view };
    const expected = 120 / before.view.zoom;
    await evaluate('window.__terminalInput.length = 0');
    await wheel(scene.card.body.x, scene.card.body.y, 0, 1, -120);
    scene = await evaluate(PROBE);
    const sent = await evaluate('window.__terminalInput');
    check('a horizontal wheel pans the board even while a program holds the pointer',
          Math.abs(scene.view.scrollX - before.view.scrollX - expected) < expected * 0.35,
          `${before.view.scrollX} → ${scene.view.scrollX}, wanted +${expected} at zoom ${before.view.zoom}`);
    // xterm takes the button from the sign of `deltaY`, so it has nothing to report for a
    // wheel that only went sideways — it cancels the event and sends nothing at all.
    check('and the program was sent nothing for it',
          Array.isArray(sent) && sent.length === 0, JSON.stringify(sent));
  }

  {
    const before = { view: scene.view };
    await evaluate('window.__terminalInput.length = 0');
    await wheel(scene.card.body.x, scene.card.body.y, -120, 1);
    scene = await evaluate(PROBE);
    const sent = await evaluate('window.__terminalInput');
    check('a vertical wheel still reaches that program',
          Array.isArray(sent) && sent.some((data) => /\[(M|<)/.test(String(data))),
          JSON.stringify(sent));
    check('and leaves the board exactly where it was',
          Math.abs(scene.view.scrollX - before.view.scrollX) < 1
          && Math.abs(scene.view.scrollY - before.view.scrollY) < 1,
          `${JSON.stringify(before.view)} → ${JSON.stringify(scene.view)}`);
  }

  console.log('\n9. the header is a target the reader can hit, at any zoom');
  await evaluate('window.__focusCheckApi.updateScene({ appState: { zoom: { value: 0.15 } } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  await shot('08-zoomed-out');
  check('the band that drags the block does not vanish with the zoom',
        scene.card.header.height >= 12, `${scene.card.header.height}px at zoom ${scene.view.zoom}`);

  console.log('\n10. and none of it was ever stored');
  await sleep(2400);
  const stored = await (await api('/api/elements')).json();
  check('the authored shape is in the store',
        stored.elements.some((element) => element.width === 200), String(stored.count));
  check('the terminal block is not',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  // The server's own output, because the most confusing way for this to fail is a `fetch
  // failed` from a canvas server that died, which says nothing about why.
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
