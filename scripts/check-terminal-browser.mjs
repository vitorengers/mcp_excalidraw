#!/usr/bin/env node
/**
 * Checks the terminal block in a real browser.
 *
 * `check-terminal.mjs` covers the shell, the guards and the transport. None of that says
 * the block works, and this repository has paid for that distinction three times: a panel
 * that never opened, a race in tab initialisation, a click landing on the label instead of
 * the box. All three compiled and type-checked.
 *
 * So the questions here are the ones only a browser can answer. Is the block on the right
 * of the board? Does Alt+T bring it into view? Does a click reach the *shape* through the
 * overlay, which is what leaves Excalidraw's own resize handles usable — and does dragging
 * one really tell the server a new size? Does a command typed into the block run, without
 * `p`, `w` and `d` being taken as Excalidraw's freedraw, then its diamond tool? And is the
 * block still absent from the store after all of that, which is the half of "derived" that
 * a check on the export cannot see?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own
 * canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-browser.mjs [--chrome <path>] [--shots <dir>]
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
const isWindows = process.platform === 'win32';

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-browser-'));
const projectDir = join(workDir, 'terminal-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'terminal-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Terminal Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = 35100 + (process.pid % 300);
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
 * headless Chrome are competing for sockets. Reported as a case failure that says nothing,
 * it reads as the feature being broken.
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
  await sleep(200);
}

/** A drag, in steps: Excalidraw resizes on pointer moves, not on where the pointer lands. */
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

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(50);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** The imperative API, through the container's React fibre. See check-board-drafts-browser. */
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
        window.__terminalCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null, authored: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    } else if (!custom.kind) {
      out.authored.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.tool = state.activeTool ? state.activeTool.type : null;
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  const card = document.querySelector('.terminal-card');
  if (card) {
    const box = card.getBoundingClientRect();
    const body = card.querySelector('.terminal-card__body');
    const prompt = card.querySelector('.terminal-card__prompt');
    const promptBox = prompt ? prompt.getBoundingClientRect() : null;
    out.card = {
      left: box.left, top: box.top, width: box.width, height: box.height,
      fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
      pointerEvents: getComputedStyle(body).pointerEvents,
      where: (card.querySelector('.terminal-card__where') || {}).textContent || '',
      grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
      mode: (card.querySelector('.terminal-card__mode') || {}).textContent || '',
      prompt: promptBox
        ? { x: promptBox.left + promptBox.width / 2, y: promptBox.top + promptBox.height / 2 }
        : null,
      text: body ? body.textContent : '',
      // The rendered screen alone. The body also holds the stylesheet the emulator injects
      // for its palette, which is text as far as textContent is concerned.
      screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
    };
  } else {
    out.card = null;
  }
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

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so "the right side" has a right side to be on.
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
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  console.log('1. the block lands on the right of the board, with the session drawn in it');
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');
  let scene = await evaluate(PROBE);
  await shot('01-placed');

  const authored = scene.authored.find((element) => element.w === 200);
  check('the authored shape is there to measure against', Boolean(authored), JSON.stringify(scene.authored));
  check('the block is one gap right of it',
        Boolean(authored) && Math.abs(scene.block.x - (authored.x + authored.w + 120)) < 1,
        `block at ${scene.block?.x}, content ends at ${authored && authored.x + authored.w}`);
  check('and level with its top', Boolean(authored) && Math.abs(scene.block.y - authored.y) < 1,
        `${scene.block?.y} vs ${authored?.y}`);
  check('the overlay is drawn over the block, not somewhere else',
        Math.abs(scene.card.left - toViewport(scene, scene.block.x, scene.block.y).x) < 2
        && Math.abs(scene.card.top - toViewport(scene, scene.block.x, scene.block.y).y) < 2,
        `card at ${scene.card.left},${scene.card.top}; block at ${JSON.stringify(toViewport(scene, scene.block.x, scene.block.y))}`);
  check('and at the block\'s size',
        Math.abs(scene.card.width - scene.block.w * scene.view.zoom) < 2
        && Math.abs(scene.card.height - scene.block.h * scene.view.zoom) < 2,
        `card ${scene.card.width}×${scene.card.height}, block ${scene.block.w}×${scene.block.h} at zoom ${scene.view.zoom}`);
  check('it names the directory the shell is in',
        containsPath(scene.card.where, projectDir), scene.card.where);
  check('and the grid the block stands for', /\d+×\d+/.test(scene.card.grid), scene.card.grid);
  check('the transcript is transparent to the pointer, so the shape underneath is still the shape',
        scene.card.pointerEvents === 'none', scene.card.pointerEvents);

  console.log('\n2. Alt+T brings it into view');
  // Scrolled well away first, so "it is in view" is not just where the board happened to be.
  await evaluate('window.__terminalCheckApi.updateScene({ appState: { scrollX: 2600, scrollY: 1800, zoom: { value: 0.4 } } })');
  await sleep(500);
  scene = await evaluate(PROBE);
  const offScreen = toViewport(scene, scene.block.x, scene.block.y);
  check('the block starts off screen',
        offScreen.x > scene.view.width || offScreen.x < 0 || offScreen.y > scene.view.height || offScreen.y < 0,
        JSON.stringify(offScreen));

  await pressKey('KeyT', 't', 1, 84);
  await sleep(1400);
  scene = await evaluate(PROBE);
  await shot('02-alt-t');
  const onScreen = toViewport(scene, scene.block.x + scene.block.w / 2, scene.block.y + scene.block.h / 2);
  check('and Alt+T puts it in the viewport',
        onScreen.x > 0 && onScreen.x < scene.view.width && onScreen.y > 0 && onScreen.y < scene.view.height,
        JSON.stringify(onScreen));
  check('at a zoom where it can be read', scene.view.zoom > 0.5, String(scene.view.zoom));
  check('the overlay came with it', Boolean(scene.card)
        && Math.abs(scene.card.left - toViewport(scene, scene.block.x, scene.block.y).x) < 2,
        JSON.stringify(scene.card));
  check('and its font scaled with the board',
        Math.abs(scene.card.fontSize - 13 * scene.view.zoom) < 1.5,
        `${scene.card.fontSize}px at zoom ${scene.view.zoom}`);

  console.log('\n3. a command typed into the block runs, and its output comes back');
  check('the block says which mode the session got', /^(pty|pipe)$/.test(scene.card.mode.trim()),
        scene.card.mode);
  // The strip at the bottom is the only part of the overlay that takes the pointer, and
  // clicking it is the whole of "giving the terminal the keyboard".
  await click(scene.card.prompt.x, scene.card.prompt.y);
  check('clicking the prompt strip puts the keyboard in the terminal',
        /xterm/.test((await evaluate(PROBE)).focused), (await evaluate(PROBE)).focused);

  // A shell on a terminal has a REPL to start, and keystrokes sent into one that is still
  // starting go nowhere. A reader waits for the prompt to be drawn; so does this.
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(500);
  await typeText('pwd');
  // `p` is Excalidraw's freedraw and `d` its diamond. A keystroke that reached the canvas
  // would have changed the tool, and the reader would be drawing instead of typing.
  check('and none of it reached Excalidraw\'s tools',
        (await evaluate(PROBE)).tool === 'selection', (await evaluate(PROBE)).tool);
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).includes('pwd'),
                'what was typed to appear on the screen');
  check('what was typed is drawn in the block', String((await evaluate(PROBE)).card.screen).includes('pwd'),
        String((await evaluate(PROBE)).card.screen).slice(-200));

  // A carriage return, which is what a terminal sends for Enter — and what the emulator
  // will put on the wire, since nothing appends a newline for it any more.
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => containsPath((await evaluate(PROBE)).card?.screen, projectDir),
                'the shell to answer pwd');
  scene = await evaluate(PROBE);
  await shot('03-pwd');
  check('the shell answered, in the block', containsPath(scene.card.screen, projectDir),
        String(scene.card.screen).slice(-200));

  console.log('\n4. the block resizes on the board, and the session is told');
  const [gridBefore] = (await (await api('/api/terminal')).json())?.sessions ?? [];
  const before = { w: scene.block.w, h: scene.block.h };

  // A click at the block's centre has to select the *shape*: the overlay is on top of it,
  // and if it took the click there would be no selection and no resize handles at all.
  const centre = toViewport(scene, scene.block.x + scene.block.w / 2, scene.block.y + scene.block.h / 2);
  await click(centre.x, centre.y);
  scene = await evaluate(PROBE);
  check('clicking the block selects it through the overlay',
        scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

  const corner = toViewport(scene, scene.block.x + scene.block.w, scene.block.y + scene.block.h);
  await drag(corner, { x: corner.x + 180, y: corner.y + 120 });
  scene = await evaluate(PROBE);
  await shot('04-resized');
  check('dragging its corner resizes it', scene.block.w > before.w + 50 && scene.block.h > before.h + 30,
        `${before.w}×${before.h} → ${scene.block.w}×${scene.block.h}`);
  check('the overlay grew with it',
        Math.abs(scene.card.width - scene.block.w * scene.view.zoom) < 2
        && Math.abs(scene.card.height - scene.block.h * scene.view.zoom) < 2,
        `card ${scene.card.width}×${scene.card.height} for block ${scene.block.w}×${scene.block.h}`);

  const gridAfter = await waitFor(async () => {
    const [session] = (await (await api('/api/terminal')).json())?.sessions ?? [];
    return session && session.cols > (gridBefore?.cols ?? 0) ? session : null;
  }, 'the new grid to reach the server');
  check('and the session was told the new size',
        gridAfter.cols > gridBefore.cols && gridAfter.rows > gridBefore.rows,
        `${gridBefore.cols}×${gridBefore.rows} → ${gridAfter.cols}×${gridAfter.rows}`);
  check('which the block shows', (await evaluate(PROBE)).card.grid.includes(String(gridAfter.cols)),
        (await evaluate(PROBE)).card.grid);

  console.log('\n5. and none of it was ever stored');
  // Excalidraw offers to bind text to whatever is selected — the hint on screen says so —
  // and a label bound to the block carries no `kind` of its own, so on its own terms it
  // looks like something this board authored. The block is still selected from the resize.
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await typeText('note');
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(500);
  const labelled = await evaluate(`(() => {
    const api = window.__terminalCheckApi;
    return api.getSceneElements()
      .filter((element) => element.type === 'text' && element.containerId)
      .map((element) => ({ text: element.text, containerId: element.containerId }));
  })()`);
  scene = await evaluate(PROBE);
  check('a label really did bind to the block, so this case is about something',
        labelled.some((label) => label.containerId === scene.block.id),
        JSON.stringify(labelled));

  // The resize and the label were real edits by a real pointer and keyboard, so the
  // autosync has run by now.
  await sleep(2400);
  const stored = await (await api('/api/elements')).json();
  check('the authored shape is in the store',
        stored.elements.some((element) => element.width === 200), String(stored.count));
  check('the terminal block is not',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
  check('and neither is the label that was bound to it',
        !stored.elements.some((element) => String(element.text ?? '').includes('note')),
        JSON.stringify(stored.elements.map((element) => element.text ?? element.type)));
  check('so nothing in the store points at a shape the store has never heard of',
        stored.elements.every((element) => !element.containerId
          || stored.elements.some((other) => other.id === element.containerId)),
        JSON.stringify(stored.elements.map((element) => `${element.id}→${element.containerId ?? ''}`)));
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
