#!/usr/bin/env node
/**
 * Checks the terminal's font size buttons in a real browser.
 *
 * `check-terminal-font.mjs` covers the arithmetic: one font size feeds the cell, the frame
 * and the grid, so a larger font in the same block is fewer columns. None of that says the
 * buttons exist, that a pointer can reach them through an overlay that is deliberately
 * transparent, or that the emulator really draws the grid the header claims — and this
 * repository has paid three times for the difference between compiling and working.
 *
 * So the questions here are the ones only a browser can answer. Are the two buttons on the
 * header, and did they take the pointer back without taking the block's own handles with
 * them? Does clicking `+` change what the *shell* was told, and not just what is drawn?
 * At the largest size, is the rightmost column the header claims actually inside the
 * block — the failure the whole design is arranged around, since anything past the frame
 * is clipped rather than scrolled. Is the block still selectable and still resizable by its
 * corner afterwards. And does the size survive a reload, which is a decision this change
 * made rather than a finding the issue settled.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way
 * `check-terminal-browser.mjs` does it. Self-contained otherwise: it builds a throwaway
 * workspace, starts its own canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-font-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-font-'));
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

/**
 * A line exactly as wide as the grid, ending in a character nothing else prints.
 *
 * Run through Node rather than written in the shell's own language: the case is about a
 * column being drawn, and it should not also be about PowerShell and `sh` spelling
 * repetition differently.
 */
writeFileSync(join(projectDir, 'ruler.js'), [
  'const width = Number(process.argv[2]);',
  "process.stdout.write('-'.repeat(Math.max(1, width - 1)) + '#' + '\\n');",
  '',
].join('\n'), 'utf8');

const PORT = 35700 + (process.pid % 200);
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

/** One request, with two more goes at it — the connection, not the case. */
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

const session = async () => (await (await api('/api/terminal')).json())?.session ?? null;

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
  await sleep(160);
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
    await sleep(40);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
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
  const out = { block: null };
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
      }
    }
    const state = api.getAppState();
    out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                 offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
                 width: state.width, height: state.height };
    out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  }

  const centreOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height, right: box.right, bottom: box.bottom,
             left: box.left, top: box.top };
  };

  const card = document.querySelector('.terminal-card');
  if (!card) { out.card = null; return out; }

  const steps = card.querySelectorAll('.terminal-card__font-step');
  const readout = card.querySelector('.terminal-card__font-size');
  const header = card.querySelector('.terminal-card__header');
  const body = card.querySelector('.terminal-card__body');
  const screen = card.querySelector('.xterm-screen');

  out.card = {
    box: centreOf(card),
    fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    steps: steps.length,
    minus: centreOf(steps[0]),
    plus: centreOf(steps[1]),
    readout: readout ? readout.textContent : null,
    // The bargain: the buttons take the pointer and nothing else on the header does.
    pointer: {
      card: getComputedStyle(card).pointerEvents,
      header: header ? getComputedStyle(header).pointerEvents : null,
      readout: readout ? getComputedStyle(readout).pointerEvents : null,
      step: steps[0] ? getComputedStyle(steps[0]).pointerEvents : null,
    },
    body: centreOf(body),
    screen: centreOf(screen),
    prompt: centreOf(card.querySelector('.terminal-card__prompt')),
    rows: (card.querySelector('.xterm-rows') || {}).textContent || '',
  };

  // Where the last cell of the ruler line was actually painted. A Range rather than the
  // row's own box: the question is whether that column landed inside the block, and the
  // row is as wide as the grid whether or not the frame could hold it.
  out.lastCell = (() => {
    for (const row of card.querySelectorAll('.xterm-rows > div')) {
      const text = row.textContent || '';
      if (!/^-{4,}#/.test(text)) continue;
      const at = text.indexOf('#');
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let offset = 0;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent.length;
        if (offset + length > at) {
          const range = document.createRange();
          range.setStart(node, at - offset);
          range.setEnd(node, at - offset + 1);
          const box = range.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: at + 1 };
        }
        offset += length;
        node = walker.nextNode();
      }
    }
    return null;
  })();

  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** One press of `+` or `-`, aimed at wherever the button is now. */
async function step(direction) {
  const scene = await evaluate(PROBE);
  const target = direction > 0 ? scene.card.plus : scene.card.minus;
  await click(target.x, target.y);
  return scene;
}

/** Press until the readout says this, or give up saying what it did say. */
async function stepTo(size) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const scene = await evaluate(PROBE);
    const at = Number(scene.card.readout);
    if (at === size) return at;
    await step(size > at ? 1 : -1);
  }
  return Number((await evaluate(PROBE)).card.readout);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

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
  await waitFor(async () => (await evaluate(PROBE)).card, 'the terminal overlay to render');
  // Alt+T, so the block is at a zoom where 13px text is 13px and the buttons are targets.
  await pressKey('KeyT', 't', 1, 84);
  await sleep(1400);

  console.log('1. the header carries the two buttons, and only they take the pointer');
  let scene = await evaluate(PROBE);
  await shot('01-default');
  check('there are two of them', scene.card.steps === 2, String(scene.card.steps));
  check('with the current size between them', scene.card.readout === '13', String(scene.card.readout));
  check('the overlay is still transparent to the pointer', scene.card.pointer.card === 'none',
        scene.card.pointer.card);
  check('and so is the header around them', scene.card.pointer.header === 'none',
        String(scene.card.pointer.header));
  check('the readout takes no clicks either — it is a readout',
        scene.card.pointer.readout === 'none', String(scene.card.pointer.readout));
  check('the buttons are the exception', scene.card.pointer.step === 'auto',
        String(scene.card.pointer.step));
  check('they are small enough to leave the block draggable',
        scene.card.plus.width + scene.card.minus.width < scene.card.box.width / 6,
        `${(scene.card.plus.width + scene.card.minus.width).toFixed(1)}px of ${scene.card.box.width.toFixed(1)}`);

  const base = await waitFor(session, 'the session to report a grid');
  check('and the shell was told a grid to start from', base.cols > 20 && base.rows > 4,
        `${base.cols}×${base.rows}`);

  console.log('\n2. a click on + is bigger text and fewer columns, all the way to the shell');
  const before = { fontSize: scene.card.fontSize, cols: base.cols, rows: base.rows };
  for (let press = 0; press < 4; press++) await step(1);
  scene = await evaluate(PROBE);
  check('the readout moved with the clicks', scene.card.readout === '17', String(scene.card.readout));
  check('and the text really is bigger', scene.card.fontSize > before.fontSize + 2,
        `${before.fontSize} → ${scene.card.fontSize}`);

  const bigger = await waitFor(async () => {
    const now = await session();
    return now && now.cols < before.cols ? now : null;
  }, 'the smaller grid to reach the shell');
  check('the shell was told fewer columns', bigger.cols < before.cols,
        `${before.cols} → ${bigger.cols}`);
  check('and fewer rows', bigger.rows < before.rows, `${before.rows} → ${bigger.rows}`);
  await waitFor(async () => (await evaluate(PROBE)).card.grid.includes(String(bigger.cols)),
                'the header to show the new grid');
  scene = await evaluate(PROBE);
  await shot('02-bigger');
  check('and the header says so', scene.card.grid.includes(`${bigger.cols}×${bigger.rows}`),
        scene.card.grid);

  console.log('\n3. and a click on - is the other way');
  for (let press = 0; press < 8; press++) await step(-1);
  scene = await evaluate(PROBE);
  check('the readout came back down', scene.card.readout === '9', String(scene.card.readout));
  const smaller = await waitFor(async () => {
    const now = await session();
    return now && now.cols > before.cols ? now : null;
  }, 'the larger grid to reach the shell');
  check('smaller text is more columns than the default was',
        smaller.cols > before.cols && smaller.rows > before.rows,
        `${before.cols}×${before.rows} → ${smaller.cols}×${smaller.rows}`);
  await shot('03-smaller');

  console.log('\n4. at the largest size, the rightmost column the header claims is drawn');
  const top = await stepTo(24);
  check('the + stops at the top of the range', top === 24, String(top));
  // Two more presses that must do nothing: an unbounded step would keep going, and the
  // grid would eventually be whatever the floors say rather than what the block holds.
  await step(1);
  await step(1);
  scene = await evaluate(PROBE);
  check('and further presses are a no-op rather than a bigger number',
        scene.card.readout === '24', String(scene.card.readout));

  const largest = await waitFor(async () => {
    const now = await session();
    return now && now.cols < bigger.cols ? now : null;
  }, 'the largest font to reach the shell');
  await waitFor(async () => (await evaluate(PROBE)).card.grid.includes(String(largest.cols)),
                'the header to catch up with it');

  // The emulator's own screen, against the frame that holds it. Anything past the frame is
  // clipped rather than scrolled, so a screen wider than the body is columns nobody can see.
  //
  // Width only, deliberately. Measured across the whole range, xterm's cell width is dead
  // linear in the font — 0.586px per font pixel from 8 to 24, against the 0.585 the block
  // is drawn with — so the columns fit at every step with a pixel or two to spare. Its cell
  // *height* is not the font times the line height: xterm measures the font's own line box
  // first, which is a little over 1em, so a row is nearer 1.55 × the font than the 1.35
  // `TERMINAL_CELL` assumes. That gap is there at 13 with no buttons pressed — it is what
  // this change found rather than what it caused, and it belongs to its own issue.
  scene = await evaluate(PROBE);
  check('the emulator is drawing inside the frame, not past the right of it',
        scene.card.screen.right <= scene.card.body.right + 1,
        `screen ends at ${scene.card.screen.right.toFixed(1)}, frame at ${scene.card.body.right.toFixed(1)}`);

  // And now the column itself, painted: a line exactly as wide as the grid the header
  // claims, whose last character has to land inside the block.
  await click(scene.card.prompt.x, scene.card.prompt.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await waitFor(async () => String((await evaluate(PROBE)).card.rows).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(500);
  await typeText(`node ruler.js ${largest.cols}`);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  const cell = await waitFor(async () => (await evaluate(PROBE)).lastCell, 'the ruler line to be drawn');
  scene = await evaluate(PROBE);
  await shot('04-largest');
  check('the ruler is as wide as the grid the header claims', cell.width === largest.cols,
        `${cell.width} drawn of ${largest.cols} claimed`);
  check('and its last column is inside the block, not clipped off the right of it',
        cell.right <= scene.card.box.right + 1 && cell.right > scene.card.box.left,
        `column ${cell.width} ends at ${cell.right.toFixed(1)}, block ends at ${scene.card.box.right.toFixed(1)}`);
  check('drawn at the size the reader asked for, not the default',
        cell.bottom - cell.top > 20, `${(cell.bottom - cell.top).toFixed(1)}px line box`);

  console.log('\n5. the block is still a block: selectable, and resizable by its corner');
  const held = { w: scene.block.w, h: scene.block.h, cols: largest.cols };
  const centre = toViewport(scene, scene.block.x + scene.block.w / 2, scene.block.y + scene.block.h / 2);
  await click(centre.x, centre.y);
  scene = await evaluate(PROBE);
  check('clicking it through the overlay still selects it',
        scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

  const corner = toViewport(scene, scene.block.x + scene.block.w, scene.block.y + scene.block.h);
  await drag(corner, { x: corner.x + 200, y: corner.y + 140 });
  scene = await evaluate(PROBE);
  await shot('05-resized');
  check('and its corner still resizes it', scene.block.w > held.w + 50 && scene.block.h > held.h + 30,
        `${held.w}×${held.h} → ${scene.block.w}×${scene.block.h}`);
  const grown = await waitFor(async () => {
    const now = await session();
    return now && now.cols > held.cols ? now : null;
  }, 'the dragged size to reach the shell');
  check('a bigger block at the same font is more columns again',
        grown.cols > held.cols, `${held.cols} → ${grown.cols}`);

  console.log('\n6. and the size is the reader\'s, so it survives a reload');
  await send('Page.reload');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the reload');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay after the reload');
  await sleep(800);
  scene = await evaluate(PROBE);
  await shot('06-reloaded');
  check('the reader\'s size came back', scene.card.readout === '24', String(scene.card.readout));
  check('and the block is drawing at it', scene.card.fontSize > 20, String(scene.card.fontSize));

  // A viewing preference, not a fact about the project: the block is stripped at both
  // doors, so a size that had reached `customData` would be dropped on the way to the store.
  const stored = await (await api('/api/elements')).json();
  check('nothing about it reached the store',
        stored.elements.every((element) => !(element.customData || {}).fontSize
          && !(element.customData || {}).terminalFont),
        JSON.stringify(stored.elements.map((element) => element.customData)));
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
