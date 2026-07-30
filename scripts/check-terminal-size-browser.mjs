#!/usr/bin/env node
/**
 * Checks the three levers #144 moves: how big a fresh terminal block is, how big the tab
 * strip is drawn, and that the status bar along the bottom is gone.
 *
 * Every case is asked of a **real render** rather than of the source, which is the whole
 * reason this is a browser check. #110 is the precedent: a scale written into a stylesheet
 * that never reaches the element leaves the file reading exactly right and the strip exactly
 * the size it was. So the size of a chip is `getBoundingClientRect()`, and the size of the
 * block is the scene element the browser placed, not the constant the module exports.
 *
 * **The strip is measured against itself at `--terminal-tab-scale: 1`**, which is what the
 * strip was before this change: every length inside the row is `em` off the row's own
 * font-size, and the scale is the one multiplier on it. Forcing the variable to 1 therefore
 * reproduces the old row in the same browser, at the same zoom and the same reader font size,
 * which is a fairer comparison than a number copied out of another run — and it is the same
 * question `scripts/check-workspace-tabs-scale.mjs` asks of the workspace strip, for the same
 * reason: one lever, or a stylesheet with the number written in six places and five of them
 * still on the old value.
 *
 * The bottom bar is asked about twice, live and after the shell has exited, because the
 * exited state is the one that had something to say — `press + for another, or Alt+T` — and
 * a bar removed without re-homing that would take the way back out with it.
 *
 * At **zoom 1**, deliberately, for the reason `check-terminal-rows-browser.mjs` gives: scene
 * units and screen pixels are the same thing there, so the block's width and the card's are
 * one currency.
 *
 * The size case has outlived the change it was written for. #144 moved a constant and this
 * asked whether the constant reached the scene; #199 replaced the constant with a grid, so it
 * now asks whether the *derived* rectangle reached the scene — the same question about a
 * number that is no longer written down anywhere.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-size-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

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

const modulePath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the terminal block module is built — dist/core/terminal-block.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { TERMINAL_GRID, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, terminalSizeFor } =
  await import(pathToFileURL(modulePath).href);

/**
 * What the block is drawn at when nobody has resized it.
 *
 * A pair of numbers until #199 — 1140 × 720 since #144 — and since then a *grid*, 125 × 30,
 * which is only a rectangle once a page has measured its font. So this file stopped naming the
 * rectangle and derives it from the cell the page really has, which is the same thing the page
 * does. `check-terminal-default-grid-browser.mjs` is what asks whether the grid itself is right,
 * and it asks the server rather than the arithmetic.
 */
const expectedSize = (cell) => terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_SIZE, cell.lineBox, cell.advance);
/** Half again as big, and the tolerance a border rounded to a device pixel needs. */
const SCALE = { min: 1.45, max: 1.55 };

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-size-'));
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

const PORT = 36700 + (process.pid % 200);
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

/** The board's sessions, as the *server* has them — not as the browser hoped. */
const sessions = async () => (await (await api('/api/terminal')).json())?.sessions ?? [];

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
  await sleep(140);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(35);
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

/**
 * The blocks on the board and what the overlay drew for each of them.
 *
 * Heights rather than centres for the strip, because the question here is how big a chip is
 * rather than where to click it — a chip is as wide as the session id inside it, and the id
 * is generated, so width says nothing. The height is the row.
 */
const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  const out = { blocks: [], cards: [] };
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.blocks.push({ id: element.id, x: element.x, y: element.y,
                          width: element.width, height: element.height });
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
    out.cards.push({
      box: boxOf(card),
      fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
      tabCount: card.querySelectorAll('.terminal-card__tab').length,
      tab: boxOf(card.querySelector('.terminal-card__tab')),
      add: boxOf(card.querySelector('.terminal-card__add')),
      detach: boxOf(card.querySelector('.terminal-card__detach')),
      merge: boxOf(card.querySelector('.terminal-card__merge')),
      strip: boxOf(card.querySelector('.terminal-card__tabs')),
      header: boxOf(card.querySelector('.terminal-card__header')),
      body: boxOf(card.querySelector('.terminal-card__body')),
      // The bar #144 removes. Anything but null here is the bar still being drawn.
      prompt: boxOf(card.querySelector('.terminal-card__prompt')),
      // Its one load-bearing sentence, at whatever its new home is.
      ended: (card.querySelector('.terminal-card__ended') || {}).textContent || '',
      screen: (card.querySelector('.xterm-rows') || {}).innerText || '',
    });
  }
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

/** Every card's tab strip forced back to the size it was before #144, or let go again. */
const setScale = (value) => evaluate(`(() => {
  for (const card of document.querySelectorAll('.terminal-card')) {
    ${value === null
      ? "card.style.removeProperty('--terminal-tab-scale');"
      : `card.style.setProperty('--terminal-tab-scale', '${value}');`}
  }
  return true;
})()`);

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
    '--window-size=1700,1320',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).cards.length > 0, 'the terminal overlay to render');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tab, 'the tab strip to render');

  console.log('\n1. a fresh block is the default grid, at this page\'s own cell');
  let scene = await evaluate(PROBE);
  const block = scene.blocks[0];
  // Measured at the size the *reader* is on rather than at the card's computed size: the
  // overlay is drawn at the board's zoom, and the grid is derived in scene units.
  const cell = await evaluate(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '${TERMINAL_FONT_SIZE}px ' + ${JSON.stringify(TERMINAL_FONT_FAMILY)};
    const metrics = ctx.measureText('W');
    return { advance: metrics.width,
             lineBox: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent };
  })()`);
  const expected = expectedSize(cell);
  check(`the block the board placed is ${expected.width} scene units wide — `
        + `${TERMINAL_GRID.cols} columns of this page's cell, plus the frame`,
        block.width === expected.width, String(block.width));
  check(`and ${expected.height} tall — ${TERMINAL_GRID.rows} rows of it`,
        block.height === expected.height, String(block.height));

  // Zoom 1 from here on: scene units and screen pixels are one currency, and the reader font
  // size is the default, so the two measurements of the strip differ only by the scale.
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${40 - block.x}, scrollY: ${140 - scene.view.offsetTop - block.y}, zoom: { value: 1 } } })`);
  await sleep(600);
  scene = await evaluate(PROBE);
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  check('and the overlay is drawn at the block\'s own size',
        Math.abs(scene.cards[0].box.width - block.width) < 2
        && Math.abs(scene.cards[0].box.height - block.height) < 2,
        `card ${scene.cards[0].box.width.toFixed(0)}×${scene.cards[0].box.height.toFixed(0)} `
        + `for block ${block.width}×${block.height}`);
  check('at the default reader font size',
        Math.abs(scene.cards[0].fontSize - TERMINAL_FONT_SIZE) < 0.5,
        String(scene.cards[0].fontSize));
  await shot('01-default-block');

  console.log('\n2. the bar along the bottom is gone, on a live block');
  check('no .terminal-card__prompt in the DOM', scene.cards[0].prompt === null,
        JSON.stringify(scene.cards[0].prompt));
  check('and the screen reaches the bottom of the card instead',
        scene.cards[0].body.bottom > scene.cards[0].box.bottom - 12,
        `frame ends at ${scene.cards[0].body.bottom.toFixed(1)}, `
        + `card at ${scene.cards[0].box.bottom.toFixed(1)}`);

  console.log('\n3. the reattach control needs a second block, so detach one first');
  // `+` then detach: `__merge` is only rendered when there is another block to merge into,
  // and it is one of the four controls #144 names.
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabCount === 2, 'a second chip');
  scene = await evaluate(PROBE);
  await click(scene.cards[0].detach.x, scene.cards[0].detach.y);
  await waitFor(async () => (await evaluate(PROBE)).cards.length === 2, 'a second block');
  await waitFor(async () => (await evaluate(PROBE)).cards.every((card) => card.merge),
                'the reattach control on both blocks');
  scene = await evaluate(PROBE);
  await shot('02-two-blocks');

  console.log('\n4. and the strip is drawn half again as big as it was');
  const scaled = (await evaluate(PROBE)).cards[0];
  await setScale(1);
  await sleep(200);
  const plain = (await evaluate(PROBE)).cards[0];
  await setScale(null);
  await sleep(200);
  await shot('03-strip');

  for (const part of ['tab', 'add', 'detach', 'merge']) {
    const grown = scaled[part];
    const before = plain[part];
    if (!grown || !before) {
      check(`.terminal-card__${part} is drawn at all`, false, 'it is not in the DOM');
      continue;
    }
    const ratio = grown.height / before.height;
    check(`.terminal-card__${part} is ${SCALE.min}–${SCALE.max}× the height it had`,
          ratio >= SCALE.min && ratio <= SCALE.max,
          `${before.height.toFixed(2)}px → ${grown.height.toFixed(2)}px, ${ratio.toFixed(3)}×`);
  }
  // One lever, not six: if any length in the row were still written as a bare `em`, forcing
  // the variable to 1 would leave the row taller than it used to be rather than back at it.
  const stripRatio = scaled.strip.height / plain.strip.height;
  check(`the whole row follows the same one variable, ${SCALE.min}–${SCALE.max}×`,
        stripRatio >= SCALE.min && stripRatio <= SCALE.max,
        `${plain.strip.height.toFixed(2)}px → ${scaled.strip.height.toFixed(2)}px, `
        + `${stripRatio.toFixed(3)}×`);
  // The header is the band the block is dragged by and is deliberately not scaled — a strip
  // that took the header's size with it would be #112's budget spent twice over.
  check('and the header it sits under is left alone',
        Math.abs(scaled.header.height - plain.header.height) < 0.6,
        `${plain.header.height.toFixed(2)}px → ${scaled.header.height.toFixed(2)}px`);

  console.log('\n5. a shell that has gone still says how to get another, on the block');
  scene = await evaluate(PROBE);
  await click(scene.cards[0].body.x, scene.cards[0].body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused),
                'the keyboard to reach the shell');
  await sleep(600);
  await typeText('exit');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  const gone = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    const card = probe.cards.find((entry) => /gone/i.test(entry.ended));
    return card ?? null;
  }, 'the block to say the shell has gone');
  await shot('04-exited');
  check('the block says the shell has gone', /gone/i.test(gone.ended), gone.ended);
  check('and names `+` as the way to another', /\+/.test(gone.ended), gone.ended);
  check('and names Alt+T as the other way', /alt\+t/i.test(gone.ended), gone.ended);
  check('the bar is still absent with the shell gone',
        (await evaluate(PROBE)).cards.every((card) => card.prompt === null),
        'a .terminal-card__prompt came back for the exited state');
  // The notice is drawn over the screen rather than in a row of its own, so what the shell
  // was told is the same before and after it appears. A frame that changed height when a
  // shell exited would re-grid every block on the board for a reason nobody asked for.
  const after = (await evaluate(PROBE)).cards.find((card) => /gone/i.test(card.ended));
  check('and the frame the emulator was given did not change height with it',
        Math.abs(after.body.height - gone.body.height) < 1,
        `${gone.body.height.toFixed(1)}px → ${after.body.height.toFixed(1)}px`);

  console.log('\n6. and the sessions the server has still match the blocks on screen');
  const live = await sessions();
  check('one shell left of the two that were opened', live.length === 1,
        JSON.stringify(live.map((entry) => entry.id)));
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
