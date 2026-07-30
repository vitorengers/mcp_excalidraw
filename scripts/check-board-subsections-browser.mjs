#!/usr/bin/env node
/**
 * Checks `Alt+Left` and `Alt+Right` in a real browser.
 *
 * `check-board-subsections.mjs` covers the resolver: which part one step lands on, given
 * where the viewport is. It says nothing about whether pressing the key moves anything, and
 * that is the distinction this repository keeps paying for — a panel that never opened, a
 * race in tab startup, a click landing on the label instead of the box, all three compiled.
 *
 * So the questions here are the ones only a browser can answer. Does `Alt+Right` walk the
 * viewport down the parts of the section it is on, and `Alt+Left` back up them? Does it
 * refuse to leave that section — the *whole* contract of a key that means "the next part of
 * what I am reading" rather than "the next thing on the board"? Does it stand down while a
 * label is being typed into, where `ArrowLeft` has to be a caret move? Does it still reach
 * the board from inside a focused terminal, which is #177's answer and applies unchanged?
 * And does a board that draws no parts bind nothing at all, which is what keeps `Alt+Left`
 * the browser's own Back for every project that never draws one?
 *
 * **What it cannot answer is whether the browser took the chord first.** A CDP-injected key
 * event is delivered straight to the renderer, so the accelerator table never sees it and
 * this file would pass whether or not a real `Alt+Left` had gone Back. That question is
 * `scripts/check-alt-arrow-accelerator.mjs`, which sends the chord through Windows itself,
 * and its answer is in `docs/board-sections.md`.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas server and kills
 * both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads
 * the built frontend.
 *
 * Usage: node scripts/check-board-subsections-browser.mjs [--chrome <path>] [--shots <dir>]
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

function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => path && existsSync(path)) ?? null;
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

// ─── A project with two sections, each cut into parts ──────────

const workDir = mkdtempSync(join(tmpdir(), 'check-board-subsections-'));
const projectDir = join(workDir, 'parts-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'parts-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Parts Project',
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

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** Alt and one arrow — one step along the section the viewport is on. */
const step = async (direction) => {
  const [code, virtualKey] = direction > 0 ? ['ArrowRight', 39] : ['ArrowLeft', 37];
  await pressKey(code, code, 1, virtualKey);
  // scrollToContent animates; the assertion is about where it lands, not how it gets there.
  await sleep(1400);
};

const altPress = async (code, key, virtualKey) => {
  await pressKey(code, key, 1, virtualKey);
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
        window.__partsCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__partsCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { sections: {}, parts: {}, cards: {}, terminal: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    const box = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    if (custom.kind === 'board-section') out.sections[custom.title] = box;
    else if (custom.kind === 'board-subsection') out.parts[custom.title] = box;
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
  const screen = document.querySelector('.terminal-card__body');
  const box = screen ? screen.getBoundingClientRect() : null;
  out.screen = box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/**
 * Has a key landed on this box — is the reader looking at the start of it?
 *
 * Across the middle and at the **top**, and the top is #232. Asking about the middle on both
 * axes was the right question only while a target taller than the canvas was *centred* in its
 * own overflow: the middle was on screen and the title above it was not, which is the defect
 * #232 reports. Such a target is top-aligned now, so the middle of a section several canvases
 * tall sits well below the fold and the old probe would call a correct landing a miss.
 */
const onScreen = (scene, box) => {
  const point = toViewport(scene, box.x + box.w / 2, box.y);
  return point.x > 0 && point.x < scene.view.width
    && point.y >= scene.view.offsetTop && point.y < scene.view.offsetTop + scene.view.height;
};

/**
 * Put the viewport centre on one scene point.
 *
 * `Alt+P` is not a starting position: since #232 it lands on the *top* of the section, which
 * on a section cut into three parts is already somewhere inside the first one, so a walk
 * started from it begins one step in — the same objection as when it centred the section and
 * started on the second part. Every case below that cares where it starts says so here.
 */
const park = async (sceneX, sceneY, zoom = 0.3) => {
  await evaluate(`(() => {
    const api = window.__partsCheckApi;
    const state = api.getAppState();
    api.updateScene({ appState: { zoom: { value: ${zoom} },
      scrollX: state.width / 2 / ${zoom} - ${sceneX},
      scrollY: state.height / 2 / ${zoom} - ${sceneY} } });
  })()`);
  await sleep(400);
};

/** Which part the viewport is centred on, by name, or null between them. */
const centredOn = (scene) => {
  const x = scene.view.width / 2 / scene.view.zoom - scene.view.scrollX;
  const y = scene.view.height / 2 / scene.view.zoom - scene.view.scrollY;
  const hit = Object.entries(scene.parts).find(([, box]) =>
    x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
  return hit ? hit[0] : null;
};

const rect = (body) => api('/api/elements', { method: 'POST', body: JSON.stringify(body) });

/** Two sections, three parts each, far enough apart that nothing is accidentally in view. */
const STRUCTURE = { x: 0, y: 0, width: 1200, height: 3000 };
const DEVELOPMENT = { x: 0, y: 6000, width: 1200, height: 3000 };
const STRUCTURE_PARTS = ['Architecture', 'The blocks', 'How to try it'];
const DEVELOPMENT_PARTS = ['The log', 'Traps', 'What is next'];

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
  for (const [at, title] of STRUCTURE_PARTS.entries()) {
    await rect({
      type: 'rectangle', x: 60, y: 100 + at * 900, width: 900, height: 500,
      backgroundColor: 'transparent', text: title,
      customData: { kind: 'board-subsection', title, order: at + 1 },
    });
  }
  for (const [at, title] of DEVELOPMENT_PARTS.entries()) {
    await rect({
      type: 'rectangle', x: 60, y: 6100 + at * 900, width: 900, height: 500,
      backgroundColor: 'transparent', text: title,
      customData: { kind: 'board-subsection', title, order: at + 1 },
    });
  }

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
    return probe.parts && Object.keys(probe.parts).length === 6;
  }, 'both sections and all six parts to reach the canvas');

  console.log('1. Alt+Right walks down the section the reader is on');
  await altPress('KeyP', 'p', 80);
  let scene = await evaluate(PROBE);
  check('Alt+P puts the reader in Project structure',
        onScreen(scene, scene.sections['Project structure']), JSON.stringify(scene.view));

  // At the top of the section, above every part: the first press has to put the reader on
  // the walk rather than one step along it.
  await park(600, 30);
  check('and the top of it is on no part at all', centredOn(await evaluate(PROBE)) === null);

  await step(1);
  scene = await evaluate(PROBE);
  await shot('01-first-step');
  check('the first Alt+Right lands on the first part',
        centredOn(scene) === 'Architecture', String(centredOn(scene)));
  check('and it is on screen', onScreen(scene, scene.parts.Architecture), JSON.stringify(scene.view));

  await step(1);
  scene = await evaluate(PROBE);
  check('the second lands on the second part', centredOn(scene) === 'The blocks', String(centredOn(scene)));
  await step(1);
  scene = await evaluate(PROBE);
  await shot('02-third-part');
  check('the third lands on the third', centredOn(scene) === 'How to try it', String(centredOn(scene)));

  console.log('\n2. and Alt+Left walks back up it');
  await step(-1);
  scene = await evaluate(PROBE);
  check('back one lands on the second part', centredOn(scene) === 'The blocks', String(centredOn(scene)));
  await step(-1);
  scene = await evaluate(PROBE);
  check('and back again on the first', centredOn(scene) === 'Architecture', String(centredOn(scene)));

  console.log('\n3. a step stops at the end of a section rather than leaving it');
  // The contract of the key: the parts *inside* the section being read. Wandering into the
  // next section is what Alt+P and Alt+G are for, and they say which one they land on.
  await step(-1);
  scene = await evaluate(PROBE);
  check('Alt+Left on the first part stays on it', centredOn(scene) === 'Architecture',
        String(centredOn(scene)));
  check('and does not cross into the other section',
        !onScreen(scene, scene.sections.Development), JSON.stringify(scene.view));

  for (let along = 0; along < 4; along++) await step(1);
  scene = await evaluate(PROBE);
  await shot('03-end-of-the-section');
  check('and pressing Alt+Right past the last part stays on the last',
        centredOn(scene) === 'How to try it', String(centredOn(scene)));
  check('rather than walking into Development',
        !onScreen(scene, scene.sections.Development), JSON.stringify(scene.view));

  console.log('\n4. the other section has its own walk');
  await altPress('KeyG', 'g', 71);
  scene = await evaluate(PROBE);
  check('Alt+G puts the reader in Development', onScreen(scene, scene.sections.Development),
        JSON.stringify(scene.view));
  await park(600, 6030);
  await step(1);
  scene = await evaluate(PROBE);
  await shot('04-the-other-section');
  check('a step from the top of Development lands on its first part',
        centredOn(scene) === 'The log', String(centredOn(scene)));
  await step(1);
  scene = await evaluate(PROBE);
  check('and the walk continues inside it', centredOn(scene) === 'Traps', String(centredOn(scene)));

  console.log('\n5. it stands down while a label is being typed into');
  const box = scene.parts.Traps;
  const centre = toViewport(scene, box.x + box.w / 2, box.y + box.h / 2);
  await doubleClick(centre.x, centre.y);
  scene = await evaluate(PROBE);
  check('double-clicking a part opens its label for editing',
        scene.editing || scene.active === 'TEXTAREA', `editing=${scene.editing} active=${scene.active}`);

  const before = { ...scene.view };
  await step(1);
  scene = await evaluate(PROBE);
  await shot('05-typing-a-label');
  check('Alt+Right does not jump out from under the cursor',
        Math.abs(scene.view.scrollX - before.scrollX) < 1 && Math.abs(scene.view.scrollY - before.scrollY) < 1,
        `${JSON.stringify(before)} → ${JSON.stringify(scene.view)}`);
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(300);

  console.log('\n6. and it reaches the board from inside a focused terminal');
  // #177, unchanged: a focused xterm is a focused TEXTAREA, and the board's keys are the
  // board's. `board-hotkeys.ts` holds the one rule all of them read.
  await waitFor(async () => (await evaluate(PROBE)).terminal, 'the terminal block');
  await altPress('KeyT', 't', 84);
  await waitFor(async () => (await evaluate(PROBE)).screen, 'the terminal overlay to render');
  scene = await evaluate(PROBE);
  await click(scene.screen.x, scene.screen.y);
  scene = await evaluate(PROBE);
  check('clicking the screen puts the keyboard in the terminal', /xterm/.test(scene.focused), scene.focused);

  await park(600, 6030);
  await step(1);
  scene = await evaluate(PROBE);
  await shot('06-from-the-terminal');
  check('Alt+Right walks the board from inside a focused shell',
        centredOn(scene) === 'The log', String(centredOn(scene)));
  await evaluate('document.activeElement && document.activeElement.blur()');
  await sleep(200);

  console.log('\n7. a board that draws no parts binds nothing');
  // Which is every board that never draws one, and is what leaves Alt+Left and Alt+Right as
  // the browser's own Back and Forward there.
  await evaluate(`(() => {
    const api = window.__partsCheckApi;
    const kept = api.getSceneElements().filter((element) => (element.customData || {}).kind !== 'board-subsection');
    api.updateScene({ elements: kept });
  })()`);
  await sleep(400);
  scene = await evaluate(PROBE);
  check('the parts are gone', Object.keys(scene.parts).length === 0, JSON.stringify(scene.parts));

  const parked = 'window.__partsCheckApi.updateScene({ appState: { scrollX: -400, scrollY: -800, zoom: { value: 0.7 } } })';
  await evaluate(parked);
  await sleep(400);
  const still = (await evaluate(PROBE)).view;
  for (const direction of [1, -1]) {
    await step(direction);
    scene = await evaluate(PROBE);
    check(`Alt+${direction > 0 ? 'Right' : 'Left'} moves nothing`,
          Math.abs(scene.view.scrollX - still.scrollX) < 1 && Math.abs(scene.view.scrollY - still.scrollY) < 1,
          `${JSON.stringify(still)} → ${JSON.stringify(scene.view)}`);
  }
  await shot('07-nothing-bound');
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
