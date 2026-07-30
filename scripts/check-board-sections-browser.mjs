#!/usr/bin/env node
/**
 * Checks the board's section hotkeys in a real browser.
 *
 * `check-board-map.mjs` covers the resolver and the board file. Neither says the key
 * *works*, and that is the distinction this repository keeps paying for: a panel that
 * never opened, a race in tab startup, a click landing on the label instead of the box —
 * all three compiled, type-checked, and did nothing they claimed.
 *
 * So the questions here are the ones only a browser can answer. Does Alt and the key a
 * section declared bring that section into view from wherever the board happens to be
 * scrolled? Does the *other* section's key reach the other one, rather than both landing
 * on whichever mark the scene lists first? Does the key stand down while a shape's label
 * is being typed into — where `p` and `g` have to be characters rather than a jump — and,
 * since #177, does it still *reach* the board while the terminal has the keyboard, which is
 * the one focused `TEXTAREA` that is not a text field? Does a key a section is not allowed to have leave the
 * feature that owns it alone? And does a board that declares no sections bind nothing at
 * all, which is the case that keeps this right for every project that never draws one?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own
 * canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-sections-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

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

// ─── A project with two sections and one terminal ─────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-board-sections-'));
const projectDir = join(workDir, 'sections-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'sections-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Sections Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
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

const api = (path, options = {}) => fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
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

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** Alt and a letter, which is what a section's `hotkeyCode` means on the page. */
const altPress = async (code, key, virtualKey) => {
  await pressKey(code, key, 1, virtualKey);
  // scrollToContent animates; the assertion is about where it lands, not how it gets there.
  await sleep(1400);
};

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
}

async function doubleClick(x, y) {
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  }
  await sleep(400);
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
        window.__sectionCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__sectionCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { sections: {}, cards: {}, terminal: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    const box = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    if (custom.kind === 'board-section') out.sections[custom.title] = box;
    else if (custom.kind === 'terminal') out.terminal = box;
    else if (custom.docKey) out.cards[custom.docKey] = box;
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.editing = Boolean(state.editingTextElement);
  out.active = document.activeElement ? document.activeElement.tagName : null;
  out.focused = String((document.activeElement || {}).className || '');

  // The screen is the part of the overlay that takes a pointer; clicking it hands the
  // keyboard to the shell's own emulator. It was the strip along the bottom of the block
  // until #144 removed that strip.
  const screen = document.querySelector('.terminal-card__body');
  const box = screen ? screen.getBoundingClientRect() : null;
  out.screen = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** Is the middle of this box somewhere a reader can see? */
const onScreen = (scene, box) => {
  const point = toViewport(scene, box.x + box.w / 2, box.y + box.h / 2);
  return point.x > 0 && point.x < scene.view.width && point.y > 0 && point.y < scene.view.height;
};

const rect = (body) => api('/api/elements', { method: 'POST', body: JSON.stringify(body) });

/** Where the two sections sit: far enough apart that neither is ever accidentally in view. */
const STRUCTURE = { x: 0, y: 0, width: 900, height: 700 };
const DEVELOPMENT = { x: 0, y: 4000, width: 900, height: 700 };

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await rect({
    type: 'rectangle', ...STRUCTURE, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Project structure', hotkeyCode: 'KeyP' },
  });
  await rect({
    type: 'rectangle', ...DEVELOPMENT, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Development', hotkeyCode: 'KeyG' },
  });
  // A card inside each, so "the section is in view" is about content and not about an
  // empty box, and so there is a label to type into later.
  await rect({
    type: 'rectangle', x: 40, y: 40, width: 300, height: 160,
    backgroundColor: '#e7f5ff', text: 'architecture', customData: { docKey: 'architecture' },
  });
  await rect({
    type: 'rectangle', x: 40, y: 4040, width: 300, height: 160,
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
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.sections && probe.sections['Project structure'] && probe.sections.Development;
  }, 'both sections to reach the canvas');

  console.log('1. each key reaches its own section, from anywhere on the board');
  // Parked on empty canvas a long way from both, so "it is in view" is not just where the
  // board happened to open.
  const park = 'window.__sectionCheckApi.updateScene({ appState: { scrollX: -2600, scrollY: -2200, zoom: { value: 0.5 } } })';
  await evaluate(park);
  await sleep(400);
  let scene = await evaluate(PROBE);
  check('neither section starts in view',
        !onScreen(scene, scene.sections['Project structure']) && !onScreen(scene, scene.sections.Development),
        JSON.stringify(scene.view));

  await altPress('KeyP', 'p', 80);
  scene = await evaluate(PROBE);
  await shot('01-alt-p');
  check('Alt+P puts Project structure in the viewport',
        onScreen(scene, scene.sections['Project structure']), JSON.stringify(scene.view));
  check('and the card inside it came with it', onScreen(scene, scene.cards.architecture),
        JSON.stringify(scene.cards.architecture));
  check('at a zoom where it can be read', scene.view.zoom > 0.3, String(scene.view.zoom));
  check('Development is not also in view, so this was a jump and not a zoom out',
        !onScreen(scene, scene.sections.Development), JSON.stringify(scene.view));

  await altPress('KeyG', 'g', 71);
  scene = await evaluate(PROBE);
  await shot('02-alt-g');
  check('Alt+G puts Development in the viewport', onScreen(scene, scene.sections.Development),
        JSON.stringify(scene.view));
  check('and the log card with it', onScreen(scene, scene.cards['development-log']),
        JSON.stringify(scene.cards['development-log']));
  check('the other section is behind us again', !onScreen(scene, scene.sections['Project structure']),
        JSON.stringify(scene.view));

  console.log('\n2. the key stands down while a label is being typed into');
  await altPress('KeyP', 'p', 80);
  scene = await evaluate(PROBE);
  const card = toViewport(scene, scene.cards.architecture.x + scene.cards.architecture.w / 2,
                          scene.cards.architecture.y + scene.cards.architecture.h / 2);
  await doubleClick(card.x, card.y);
  scene = await evaluate(PROBE);
  check('double-clicking the card opens its label for editing', scene.editing || scene.active === 'TEXTAREA',
        `editing=${scene.editing} active=${scene.active}`);

  const before = { ...scene.view };
  await altPress('KeyG', 'g', 71);
  scene = await evaluate(PROBE);
  await shot('03-typing-a-label');
  check('Alt+G does not jump out from under the cursor',
        Math.abs(scene.view.scrollX - before.scrollX) < 1 && Math.abs(scene.view.scrollY - before.scrollY) < 1,
        `${JSON.stringify(before)} → ${JSON.stringify(scene.view)}`);
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(300);

  // The reverse of what this section asked for its first three revisions, and #177 is the
  // reversal. It used to require that Alt+G leave the board alone while the terminal had the
  // keyboard, on the reasoning that `g` there has to be a character. The reader's complaint
  // is that this made a focused block a hole in the board's own navigation, and the answer
  // is that the four board keys are the board's and the shell is not sent them either — the
  // second half is `check-terminal-hotkey-browser.mjs`, which reads the shell's own transcript.
  console.log('\n3. and it reaches the board even while the terminal has the keyboard');
  await waitFor(async () => (await evaluate(PROBE)).terminal, 'the terminal block');
  // Alt+T first: the block sits off to the right of the board, and a screen that is not on
  // screen is not a screen anyone can click.
  await altPress('KeyT', 't', 84);
  await waitFor(async () => (await evaluate(PROBE)).screen, 'the terminal overlay to render');
  scene = await evaluate(PROBE);
  await click(scene.screen.x, scene.screen.y);
  scene = await evaluate(PROBE);
  check('clicking the screen puts the keyboard in the terminal',
        /xterm/.test(scene.focused), scene.focused);

  await altPress('KeyG', 'g', 71);
  scene = await evaluate(PROBE);
  await shot('04-from-the-terminal');
  check('Alt+G puts Development in the viewport from inside a focused shell',
        onScreen(scene, scene.sections.Development), JSON.stringify(scene.view));
  await evaluate('document.activeElement && document.activeElement.blur()');
  await sleep(200);

  console.log('\n4. a section cannot take a key this canvas already owns');
  // Alt+T is the terminal's. A third section claiming it must be ignored rather than
  // honoured — a data file that could break the terminal would be a bad trade.
  await rect({
    type: 'rectangle', x: 0, y: 8000, width: 900, height: 700, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Greedy', hotkeyCode: 'KeyT' },
  });
  await waitFor(async () => (await evaluate(PROBE)).sections.Greedy, 'the greedy section');
  await evaluate(park);
  await sleep(400);
  await altPress('KeyT', 't', 84);
  scene = await evaluate(PROBE);
  await shot('04-alt-t-still-the-terminal');
  check('Alt+T still reaches the terminal', onScreen(scene, scene.terminal), JSON.stringify(scene.terminal));
  check('and not the section that tried to claim it', !onScreen(scene, scene.sections.Greedy),
        JSON.stringify(scene.sections.Greedy));

  console.log('\n5. a board with no marked sections binds nothing');
  await evaluate(`(() => {
    const api = window.__sectionCheckApi;
    const kept = api.getSceneElements().filter((element) => (element.customData || {}).kind !== 'board-section');
    api.updateScene({ elements: kept });
  })()`);
  await sleep(400);
  scene = await evaluate(PROBE);
  check('the marks are gone', Object.keys(scene.sections).length === 0, JSON.stringify(scene.sections));

  await evaluate(park);
  await sleep(400);
  const empty = (await evaluate(PROBE)).view;
  for (const [code, key, virtualKey] of [['KeyP', 'p', 80], ['KeyG', 'g', 71]]) {
    await altPress(code, key, virtualKey);
    scene = await evaluate(PROBE);
    check(`Alt+${key.toUpperCase()} moves nothing`,
          Math.abs(scene.view.scrollX - empty.scrollX) < 1 && Math.abs(scene.view.scrollY - empty.scrollY) < 1,
          `${JSON.stringify(empty)} → ${JSON.stringify(scene.view)}`);
  }
  await shot('05-nothing-bound');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
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
