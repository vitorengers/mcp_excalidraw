#!/usr/bin/env node
/**
 * Checks that a fresh terminal block opens at the grid the project claims — 125 columns by 30
 * rows — and that it is a *grid* it opens at rather than a rectangle that happens to divide
 * into one on the machine the number was picked on (#199).
 *
 * The defect this was written against: the default was `TERMINAL_SIZE`, a pair of scene units,
 * and the grid fell out of it afterwards in `terminalGrid()`. Half of a cell is a **browser
 * measurement** — the advance width of whichever member of `TERMINAL_FONT_FAMILY` the page
 * resolved, and since #115 that is a web font — so one rectangle is two grids: 1140 × 720 read
 * as 147 columns against the fallback stack and 156 against Comic Shanns, while the comment
 * beside it claimed "around 150 × 33" and the rows were five out. Nothing could notice,
 * because an arithmetic check that divides by the same assumed cell the code does agrees with
 * it. So every case here is asked of a **real render and of the server**: the block off the
 * scene, the grid off `GET /api/terminal`, which is what the shell was actually told.
 *
 * Three questions, and the third is the one a re-picked constant cannot pass:
 *
 *   1. a board that never had a block gets 125 × 30, and the rect it got there by is the one
 *      `terminalSizeFor` derives from the cell **this page measured**;
 *   2. `+` and `-` leave a coherent grid — never at `terminalGrid()`'s 20/4 floors, falling as
 *      the text grows — and never resize or move the block, because the reader did not;
 *   3. with the reader's text at 24, the *next* board's fresh block is 125 × 30 again, at a
 *      rectangle a third bigger. Same screen, two rectangles: that is the whole claim, and a
 *      constant answers it with one rectangle and two screens.
 *
 * A second board rather than a reload for case 3 because the font is one preference for the
 * page: it survives the switch, and the switch is the cheapest door to a board that has never
 * placed a block.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-default-grid-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

const modulePath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the terminal block module is built — dist/core/terminal-block.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

// Read rather than retyped. The grid, the gap and the font family are what the page places a
// block from, and a copy of them here would be a second definition to drift from the one under
// test. `terminalSizeFor` is read for the same reason and used only where the question is "did
// the page derive this rect", never where the question is "is the grid right" — that one is
// asked of the server, which cannot be agreeing with the arithmetic by construction.
const terminal = await import(pathToFileURL(modulePath).href);
const { TERMINAL_GAP, TERMINAL_FONT_FAMILY } = terminal;

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * The contract, written here rather than read off the module.
 *
 * Everything else this file imports is read so it cannot drift — but these two *are* the
 * observation, and a check that took them from the module under test would agree with whatever
 * that module happened to say. They are also what makes this file red against the old code
 * rather than absent: there was no grid to read there, and the default size was 13.
 */
const GRID = { cols: 125, rows: 30 };
const DEFAULT_FONT = 18;

console.log('\n0. the module says what a fresh block is, in cells');
check(`the default grid is ${GRID.cols}×${GRID.rows}`,
      terminal.TERMINAL_GRID?.cols === GRID.cols && terminal.TERMINAL_GRID?.rows === GRID.rows,
      JSON.stringify(terminal.TERMINAL_GRID ?? null));
check(`the default font size is ${DEFAULT_FONT}`,
      terminal.TERMINAL_FONT_SIZE === DEFAULT_FONT, String(terminal.TERMINAL_FONT_SIZE));
check('and a grid can be turned back into a size', typeof terminal.terminalSizeFor === 'function',
      `terminalSizeFor is ${typeof terminal.terminalSizeFor}`);

/**
 * What rectangle this grid comes to at a size, for a page whose cell has been measured.
 *
 * Through the module, because the question the cases below ask of it is "did the page derive
 * this rect from what it measured" — not "is the grid right", which is asked of the server and
 * so cannot be agreeing with the arithmetic by construction. `null` when the module has no such
 * function at all, which is the old code, and the cases say so rather than throwing.
 */
const derive = (fontSize, cell) => (typeof terminal.terminalSizeFor === 'function'
  ? terminal.terminalSizeFor(GRID, fontSize, cell.lineBox, cell.advance)
  : null);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A scene unit: the block is placed in whole ones, so nothing here needs a wider tolerance. */
const CLOSE = 1;

// ─── Two projects, one entered after the reader has moved the text ────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-default-grid-'));
const firstDir = join(workDir, 'first-project');
const secondDir = join(workDir, 'second-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [firstDir, secondDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const FIRST = 'first-project';
const SECOND = 'second-project';
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: FIRST, path: firstDir.replace(/\\/g, '/') },
    { id: SECOND, path: secondDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so the anchored origin is measured
// against the board's own content and nothing else is drawing on these boards.
writeFileSync(join(firstDir, 'board.config.json'), JSON.stringify({
  name: 'First Project', repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');
writeFileSync(join(secondDir, 'board.config.json'), JSON.stringify({
  name: 'Second Project', repo: 'vitorengers/mcp_excalidraw',
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

/** One request, with two more goes at it — the connection, not the case. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (workspace, path, options = {}) =>
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

/** The board's sessions, as the *server* has them — not as the browser hoped. */
const sessionsOf = async (workspace) =>
  (await (await api(workspace, '/api/terminal')).json())?.sessions ?? [];

const showGrid = (grid) => (grid ? `${grid.cols}×${grid.rows}` : 'none');

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

/** The blocks on the board, the card over the first of them, and this board's own shapes. */
const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  const out = { blocks: [], cards: [], shapes: [] };
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.blocks.push({ id: element.id, x: element.x, y: element.y,
                          width: element.width, height: element.height,
                          sessions: (element.customData || {}).sessions || [] });
      // What the board itself authored, which is how this check tells one board's scene from
      // another's: nothing else on screen carries the project it came from.
      } else if (!(element.customData || {}).kind && !element.containerId) {
        out.shapes.push({ x: element.x, y: element.y });
      }
    }
    const state = api.getAppState();
    out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                 offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  }

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height,
             left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };

  for (const card of document.querySelectorAll('.terminal-card')) {
    const steps = card.querySelectorAll('.terminal-card__font-step');
    out.cards.push({
      box: boxOf(card),
      readout: (card.querySelector('.terminal-card__font-size') || {}).textContent || '',
      grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
      header: boxOf(card.querySelector('.terminal-card__header')),
      minus: boxOf(steps[0]),
      plus: boxOf(steps[1]),
    });
  }
  out.workspace = new URLSearchParams(window.location.search).get('workspace');
  return out;
})()`;

/**
 * The cell this page really has, measured the way `terminal-metrics.ts` measures it.
 *
 * Not to check the arithmetic with — the grid is asked of the server — but to say what
 * rectangle 125 × 30 *is* on this machine. Two font stacks give two answers and both are
 * correct, which is the reason the default stopped being a rectangle.
 *
 * At the size the *reader* is on, never at the card's computed size: the overlay is drawn at
 * the board's zoom, so a card at zoom 0.5 computes to half the type it stands for, while the
 * grid is derived in scene units. Measuring the drawn size would be a cell for a font nobody
 * chose.
 */
const measureCell = (fontSize) => evaluate(`(() => {
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '${fontSize}px ' + ${JSON.stringify(TERMINAL_FONT_FAMILY)};
  const metrics = ctx.measureText('W');
  return {
    advance: metrics.width,
    lineBox: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent,
  };
})()`);

/**
 * Switch board by pressing the tab's own button. Through the DOM rather than with a pointer:
 * a terminal card is an overlay that can be over the strip, so a coordinate would be a case
 * failing on where a block happens to sit.
 */
const switchTo = (name) => evaluate(`(() => {
  for (const tab of document.querySelectorAll('.workspace-tab')) {
    const label = (tab.querySelector('.workspace-tab__name') || {}).textContent || '';
    if (label.trim() === ${JSON.stringify(name)}) {
      tab.querySelector('.workspace-tab__select').click();
      return true;
    }
  }
  return false;
})()`);

/**
 * Put the block where its header is on screen, so `+` and `-` are buttons and not pixels.
 *
 * Zoomed out, and that is about the window rather than about the code: a block sized for 30
 * rows of 18px text is a thousand scene units tall and one sized for 24px text is nearer
 * fourteen hundred, so at zoom 1 the header of the second is the only part of it on a 1100-tall
 * window. 260 down the page clears the app's own toolbar, which is what the header would
 * otherwise be behind — a click that lands on the toolbar moves no font and times the sweep out.
 */
async function place(block, zoom = 0.6) {
  const { view } = await evaluate(PROBE);
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${(140 - view.offsetLeft) / zoom - block.x}, scrollY: ${(260 - view.offsetTop) / zoom - block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(500);
  return evaluate(PROBE);
}

/**
 * The state once the page, the server and the emulator have all agreed about one font size.
 *
 * The same hold-out `check-terminal-rows-browser.mjs` makes, and for its reason: the overlay
 * redraws, the debounced report reaches the server, and the shell resizes, each at its own
 * pace, so reading any one of them early measures the *previous* size.
 */
async function settled(size = null) {
  let last = '';
  let stable = 0;
  for (let attempt = 0; attempt < 160; attempt++) {
    let shell = null;
    let scene = null;
    try { [shell] = await sessionsOf(FIRST); scene = await evaluate(PROBE); } catch { /* not yet */ }
    const card = scene?.cards?.[0];
    const agreed = shell && card
      && (size === null || card.readout === String(size))
      && card.grid === `${shell.cols}×${shell.rows}`;
    const signature = agreed ? `${shell.cols}x${shell.rows}` : '';
    if (agreed && signature === last) {
      // Longer than TERMINAL_RESIZE_DEBOUNCE_MS, so a report still in flight has landed.
      if (++stable >= 4) return { shell, scene };
    } else {
      stable = 0;
      last = signature;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for the grid to settle`
    + `${size === null ? '' : ` at ${size}px`}\n${serverLog}`);
}

/** One press of `+` or `-`, aimed at wherever the button is now. */
async function step(direction) {
  const scene = await evaluate(PROBE);
  const target = direction > 0 ? scene.cards[0].plus : scene.cards[0].minus;
  if (!target) throw new Error('the font buttons are not drawn on the card');
  await click(target.x, target.y);
}

/** Press until the readout says this, or give up saying what it did say. */
async function stepTo(size) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const scene = await evaluate(PROBE);
    const at = Number(scene.cards[0].readout);
    if (at === size) return at;
    await step(size > at ? 1 : -1);
  }
  return Number((await evaluate(PROBE)).cards[0].readout);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Content on each board, at a different `x`, so the two anchored origins are different
  // numbers and one board's block cannot be mistaken for the other's.
  await api(FIRST, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 200, height: 140,
                           backgroundColor: '#a5d8ff', text: 'the first board' }),
  });
  await api(SECOND, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 600, y: 0, width: 200, height: 140,
                           backgroundColor: '#b2f2bb', text: 'the second board' }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1700,1100',
    `${BASE}/?workspace=${FIRST}`,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const fresh = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.blocks.length > 0 && probe.cards.length > 0 ? probe.blocks[0] : null;
  }, 'the first board to place a terminal block');
  await place(fresh);
  await shot('01-fresh');

  console.log('\n1. a board that never had a block opens one at the grid, not at a rectangle');
  const first = await settled();
  console.log(`     the shell was told ${showGrid(first.shell)}, `
    + `in a block ${fresh.width}×${fresh.height} scene units`);
  check(`the reader's text starts at ${DEFAULT_FONT}px`,
        first.scene.cards[0].readout === String(DEFAULT_FONT), first.scene.cards[0].readout);
  check(`the shell is told ${GRID.cols} columns`,
        first.shell.cols === GRID.cols, String(first.shell.cols));
  check(`and ${GRID.rows} rows`,
        first.shell.rows === GRID.rows, String(first.shell.rows));

  // And the rect it got there by is the derived one rather than a constant that happens to
  // divide: measured off this page's own font, which is the input a constant cannot have.
  const cell = await measureCell(DEFAULT_FONT);
  const derived = derive(DEFAULT_FONT, cell);
  console.log(`     this page's cell at ${DEFAULT_FONT}px is `
    + `${cell.advance.toFixed(3)} × ${cell.lineBox.toFixed(3)}px, so ${GRID.cols}×${GRID.rows} is `
    + `${derived ? `${derived.width}×${derived.height}` : 'nothing this module can say'}`);
  check('the block is the rect that grid comes to on this page',
        Boolean(derived)
        && Math.abs(fresh.width - derived.width) <= CLOSE
        && Math.abs(fresh.height - derived.height) <= CLOSE,
        `${fresh.width}×${fresh.height}, derived `
        + `${derived ? `${derived.width}×${derived.height}` : 'not derivable'}`);
  check('and it is anchored one gap left of the board\'s content, from its own right edge',
        Math.abs(fresh.x - (0 - TERMINAL_GAP - fresh.width)) < CLOSE && Math.abs(fresh.y) < CLOSE,
        `${fresh.x},${fresh.y} for a ${fresh.width}-wide block`);

  console.log('\n2. `+` and `-` move the text and leave a grid the block can hold');
  const swept = [];
  for (const size of [24, 8, DEFAULT_FONT]) {
    check(`the readout reaches ${size}`, (await stepTo(size)) === size,
          (await evaluate(PROBE)).cards[0].readout);
    const at = await settled(size);
    swept.push({ size, grid: { cols: at.shell.cols, rows: at.shell.rows }, block: at.scene.blocks[0] });
    console.log(`     ${size}px: ${showGrid(at.shell)}`);
    // The floors in `terminalGrid()` are the tell for a block too small for the text in it:
    // a grid that has hit one is a number the reader did not ask for and the frame cannot draw.
    check(`at ${size}px the columns are not at the floor`, at.shell.cols > 20, String(at.shell.cols));
    check(`and the rows are not at the floor`, at.shell.rows > 4, String(at.shell.rows));
    // The reader moved the text, not the shape. A `+` that resized the block would be undoing
    // a drag every time somebody changed their mind about the type size.
    check(`and the block itself did not move or resize at ${size}px`,
          Math.abs(at.scene.blocks[0].width - fresh.width) <= CLOSE
          && Math.abs(at.scene.blocks[0].height - fresh.height) <= CLOSE
          && Math.abs(at.scene.blocks[0].x - fresh.x) <= CLOSE,
          `${at.scene.blocks[0].width}×${at.scene.blocks[0].height} at ${at.scene.blocks[0].x}`);
  }
  await shot('02-swept');
  const [big, small, back] = swept;
  check('bigger text is fewer columns and fewer rows in the same block',
        big.grid.cols < small.grid.cols && big.grid.rows < small.grid.rows,
        `24px ${showGrid(big.grid)} vs 8px ${showGrid(small.grid)}`);
  check(`and coming back to ${DEFAULT_FONT}px is the grid it started at`,
        back.grid.cols === GRID.cols && back.grid.rows === GRID.rows,
        showGrid(back.grid));

  console.log('\n3. the reader\'s own size, and the next board still opens at 125 × 30');
  check('the readout reaches 24 again', (await stepTo(24)) === 24,
        (await evaluate(PROBE)).cards[0].readout);
  await settled(24);
  check('there is a tab for the second board', await switchTo('Second Project'),
        'no such workspace tab');
  await waitFor(async () => (await evaluate(PROBE)).workspace === SECOND,
                'the second board to open');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle on the second board');
  // Waited for by *this board's own shapes*, not by "a block is on the board": a switch leaves
  // the board you left up until the new one lands, so for a second or so the block on screen is
  // the first board's, at the first board's rect.
  const other = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    const landed = probe.shapes.some((shape) => Math.abs(shape.x - 600) < CLOSE);
    if (!landed || probe.cards.length === 0 || probe.blocks.length === 0) return null;
    return probe.blocks[0];
  }, 'the second board to land with a terminal block of its own');
  await place(other, 0.4);
  await shot('03-second-board');

  const otherShell = await waitFor(async () => {
    const [session] = await sessionsOf(SECOND);
    return session && session.cols && session.rows ? session : null;
  }, 'the second board\'s shell to be told a grid');
  const bigCell = await measureCell(24);
  const bigDerived = derive(24, bigCell);
  console.log(`     at 24px the same grid is `
    + `${bigDerived ? `${bigDerived.width}×${bigDerived.height}` : 'nothing this module can say'}, `
    + `and the block is ${other.width}×${other.height}`);
  check(`the second board's shell is told ${GRID.cols} columns too`,
        otherShell.cols === GRID.cols, String(otherShell.cols));
  check(`and ${GRID.rows} rows too`,
        otherShell.rows === GRID.rows, String(otherShell.rows));
  check('at a rectangle of its own, derived from the size the reader is reading at',
        Boolean(bigDerived)
        && Math.abs(other.width - bigDerived.width) <= CLOSE
        && Math.abs(other.height - bigDerived.height) <= CLOSE,
        `${other.width}×${other.height}, derived `
        + `${bigDerived ? `${bigDerived.width}×${bigDerived.height}` : 'not derivable'}`);
  check('which is a bigger block than the first board got, for the same screen',
        other.width > fresh.width + 100 && other.height > fresh.height + 100,
        `${fresh.width}×${fresh.height} → ${other.width}×${other.height}`);
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
