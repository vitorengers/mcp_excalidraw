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
 *   scrollback to show; the canvas takes it once there is not.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own
 * canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-focus-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

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
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = 35900 + (process.pid % 250);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: '1',
  },
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

/** One notch of the wheel, where the pointer is. Negative `deltaY` is towards the top. */
async function wheel(x, y, deltaY, notches = 1) {
  for (let notch = 0; notch < notches; notch++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none', buttons: 0,
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
  const prompt = card.querySelector('.terminal-card__prompt');
  out.card = {
    box: boxOf(card),
    body: boxOf(body),
    header: boxOf(header),
    prompt: boxOf(prompt),
    bodyPointerEvents: body ? getComputedStyle(body).pointerEvents : null,
    headerPointerEvents: header ? getComputedStyle(header).pointerEvents : null,
    hint: (card.querySelector('.terminal-card__hint') || {}).textContent || '',
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    selectionRects: card.querySelectorAll('.xterm-selection div').length,
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
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

/** Something to interrupt, and something to say the shell survived being interrupted. */
const LONG_WAIT = isWindows
  ? "Start-Sleep -Seconds 25; Write-Output ('SUR'+'VIVED')"
  : 'sleep 25; echo "SUR""VIVED"';
const MARKER = isWindows
  ? "Write-Output ('IN'+'TERRUPTED')"
  : 'echo "IN""TERRUPTED"';

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
  check('the strip no longer offers itself as the way in',
        !/click here to type/i.test(scene.card.hint), scene.card.hint);

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
  scene = await placeBoard();
  {
    const header = { x: scene.card.header.left + 6, y: scene.card.header.top + scene.card.header.height - 2 };
    await click(header.x, header.y);
    scene = await evaluate(PROBE);
    check('clicking the header selects the shape',
          scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

    const [gridBefore] = (await (await api('/api/terminal')).json())?.sessions ?? [];
    const before = { w: scene.block.w, h: scene.block.h };
    const corner = toViewport(scene, scene.block.x + scene.block.w, scene.block.y + scene.block.h);
    await drag(corner, { x: corner.x + 180, y: corner.y + 120 });
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
  await click(scene.card.body.x, scene.card.body.y);
  await run(MANY_LINES);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('line 60'),
                'the shell to print sixty lines', 80);
  await sleep(500);
  scene = await evaluate(PROBE);

  {
    // Down first, with the screen already at the bottom of its scrollback: there is nothing
    // there for the emulator to show, so the board is what should answer.
    const view = { scrollX: scene.view.scrollX, scrollY: scene.view.scrollY, zoom: scene.view.zoom };
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    const after = (await evaluate(PROBE)).view;
    check('a wheel the scrollback has no use for reaches the canvas',
          Math.abs(after.scrollY - view.scrollY) > 1 || Math.abs(after.scrollX - view.scrollX) > 1
          || Math.abs(after.zoom - view.zoom) > 0.001,
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

  console.log('\n8. the header is a target the reader can hit, at any zoom');
  await evaluate('window.__focusCheckApi.updateScene({ appState: { zoom: { value: 0.15 } } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  await shot('07-zoomed-out');
  check('the band that drags the block does not vanish with the zoom',
        scene.card.header.height >= 12, `${scene.card.header.height}px at zoom ${scene.view.zoom}`);

  console.log('\n9. and none of it was ever stored');
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
