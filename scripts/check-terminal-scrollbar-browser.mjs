#!/usr/bin/env node
/**
 * Checks that the terminal block has a scrollback bar, and that the strip it is drawn in is
 * room the grid gave up rather than room it took from the last column.
 *
 * The defect it was written against is not a bug; it is a decision blocked on a number. The
 * block scrolled from the day it had an emulator — the wheel moves the scrollback — but there
 * was nothing to see: `TerminalPanel.css` said `overflow: hidden !important` on the viewport,
 * with a note explaining why a real bar could not be added yet. A bar is a strip of the block's
 * width, `terminalGrid()` knew of no such strip, and everything the frame cannot hold is
 * clipped rather than scrolled, so the bar would have been drawn over the last column the shell
 * was told about. Against that code every case in section 2 and 3 below is red: there is no
 * thumb to find, at any font size, however much has been printed.
 *
 * So the questions are asked in two currencies, because the two halves fail differently.
 *
 * - **Pixels**, for whether a thumb exists. A native scrollbar is drawn by the browser and no
 *   API in the page will describe it — `::-webkit-scrollbar-thumb` has no box to query — so the
 *   strip is screenshotted a column at a time and read back, the way
 *   `check-terminal-paper-browser.mjs` reads a rendered colour. A thumb is a run of pixels in
 *   that column that are not the paper behind them.
 * - **Geometry**, for whether the strip cost the shell anything it was told it had. The screen
 *   xterm drew is `cols × cell` wide, and it has to end at or before the strip begins; the
 *   painted last column of a ruler exactly `cols` wide has to as well, at 8, 18 and 24 — the
 *   three sizes `check-terminal-rows-browser.mjs` sweeps, and for its reason: a strip scaled by
 *   the font is a strip that can be right at one end of the range and wrong at the other.
 *
 * And the two things a scrollbar must not become. It is a **viewer**: dragging the thumb moves
 * the reader through the transcript the server already holds, and the server's own `scrollback`
 * is byte-identical across the drag. And it must not have taken the wheel away — the wheel
 * still scrolls the scrollback, and the sideways half of one still reaches the canvas, which is
 * #112 and #162 and the two things a block sitting on a board owes the board. Since #256 the
 * *vertical* half is the terminal's for as long as there is a scrollback to scroll, ends
 * included, and a block wearing a bar always has one — so what is asked at the bottom of it
 * here is that the board stayed still.
 *
 * **No `--hide-scrollbars`.** Every other browser check here passes that flag and none of them
 * care; this one is about a scrollbar, and under that flag Chrome draws none and the whole file
 * would pass by measuring nothing.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks do
 * it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it
 * loads the built frontend.
 *
 * Usage: node scripts/check-terminal-scrollbar-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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

// ─── Pixels, as the screen really has them ────────────────────

/**
 * Enough of a PNG decoder to read a clipped screenshot back.
 *
 * The same one `check-terminal-paper-browser.mjs` carries, and here for a cousin of its reason:
 * there the colour was the one the page could not answer for because a filter applies at paint,
 * here the *element* is one the page has no handle on at all. Eight-bit, colour type 2 or 6,
 * which is all Chrome emits; the five row filters are all handled because which one it picks
 * for a given strip is its business, not ours.
 */
function decodePng(buffer) {
  let at = 8;
  let header = null;
  const parts = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const lanes = header?.colour === 6 ? 4 : header?.colour === 2 ? 3 : 0;
  if (!lanes || header.depth !== 8) throw new Error(`unreadable screenshot: ${JSON.stringify(header)}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = header.width * lanes;
  const out = Buffer.alloc(stride * header.height);
  let source = 0;
  for (let row = 0; row < header.height; row++) {
    const filter = raw[source++];
    for (let index = 0; index < stride; index++) {
      const value = raw[source + index];
      const left = index >= lanes ? out[row * stride + index - lanes] : 0;
      const up = row > 0 ? out[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= lanes ? out[(row - 1) * stride + index - lanes] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else {
        const guess = left + up - upLeft;
        const toLeft = Math.abs(guess - left);
        const toUp = Math.abs(guess - up);
        const toCorner = Math.abs(guess - upLeft);
        restored = value + (toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : upLeft);
      }
      out[row * stride + index] = restored & 255;
    }
    source += stride;
  }
  return { header, at: (x, y) => { const base = y * stride + x * lanes; return [out[base], out[base + 1], out[base + 2]]; } };
}

/** The card's surface, so "not the paper" is a question with an answer. */
const PAPER = [0xfa, 0xf6, 0xee];
const far = (pixel, from) => Math.max(...pixel.map((value, index) => Math.abs(value - from[index])));

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-scrollbar-'));
const projectDir = join(workDir, 'scrollbar-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'scrollbar-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Scrollbar Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/** More lines than the block can show, so there is a scrollback for a thumb to stand for. */
writeFileSync(join(projectDir, 'lines.js'), [
  'const count = Number(process.argv[2]);',
  'const lines = [];',
  "for (let line = 1; line <= count; line++) lines.push('line ' + line);",
  "process.stdout.write(lines.join('\\n') + '\\n');",
  '',
].join('\n'), 'utf8');

/**
 * A line exactly as wide as the grid, ending in a character nothing else prints.
 *
 * The same ruler `check-terminal-font-browser.mjs` uses, and through Node for its reason: the
 * case is about a column being drawn, and it should not also be about PowerShell and `sh`
 * spelling repetition differently.
 */
writeFileSync(join(projectDir, 'ruler.js'), [
  'const width = Number(process.argv[2]);',
  "process.stdout.write('-'.repeat(Math.max(1, width - 1)) + '#' + '\\n');",
  '',
].join('\n'), 'utf8');

const PORT = 36300 + (process.pid % 200);
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

/** The board's one session, as the *server* has it — not as the browser hoped. */
const session = async () => ((await (await api('/api/terminal')).json())?.sessions ?? [])[0] ?? null;

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

/** One pixel column of the screen, top to bottom, as it was really painted. */
async function column(x, top, height) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(x), y: Math.round(top), width: 1, height: Math.max(1, Math.round(height)), scale: 1 },
  });
  const png = decodePng(Buffer.from(data, 'base64'));
  const pixels = [];
  for (let y = 0; y < png.header.height; y++) pixels.push(png.at(0, y));
  return pixels;
}

/**
 * The thumb, found by looking at the strip rather than by asking the page about it.
 *
 * The longest run of pixels down the middle of the strip that is not the paper behind it. A
 * run rather than a count, because "a thumb has non-zero height" is a claim about something
 * continuous — a scattering of dark pixels down a track would satisfy a count and would not be
 * a thumb.
 */
async function thumbIn(strip) {
  const pixels = await column(strip.x, strip.top, strip.height);
  let best = { length: 0, start: 0 };
  let run = 0;
  for (let index = 0; index < pixels.length; index++) {
    if (far(pixels[index], PAPER) > 24) {
      run++;
      if (run > best.length) best = { length: run, start: index - run + 1 };
    } else run = 0;
  }
  return {
    height: best.length,
    top: strip.top + best.start,
    bottom: strip.top + best.start + best.length,
    middle: strip.top + best.start + best.length / 2,
    sample: pixels[best.start + Math.floor(best.length / 2)] ?? null,
  };
}

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(140);
}

/** A press, a few moves and a release — a drag the browser's own scrollbar can follow. */
async function drag(fromX, fromY, toX, toY, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(80);
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: fromX + ((toX - fromX) * step) / steps,
      y: fromY + ((toY - fromY) * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
}

/** One notch of the wheel, where the pointer is. Negative `deltaY` is towards the top. */
async function wheel(x, y, deltaY, notches = 1, deltaX = 0) {
  for (let notch = 0; notch < notches; notch++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, button: 'none', buttons: 0 });
    await sleep(80);
  }
  await sleep(250);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(30);
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
 * What the block is, what the emulator drew inside it, and what the viewport says about itself.
 *
 * `.xterm-screen` is `cols × cell` — the screen the shell was told it had, in the pixels it was
 * drawn in. `.xterm-viewport` is the box the bar belongs to: it spans the whole frame, so the
 * strip is the last `--terminal-scrollbar` pixels of it and everything the shell was told about
 * has to end before that. `scrollHeight` against `clientHeight` is the browser's own answer to
 * whether there is anything to scroll, which is the condition a thumb exists under.
 */
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
                 offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  }

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height,
             left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };

  const card = document.querySelector('.terminal-card');
  if (!card) { out.card = null; return out; }

  const steps = card.querySelectorAll('.terminal-card__font-step');
  const viewport = card.querySelector('.xterm-viewport');
  out.card = {
    box: boxOf(card),
    fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    reserve: Number.parseFloat(getComputedStyle(card).getPropertyValue('--terminal-scrollbar')),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    readout: (card.querySelector('.terminal-card__font-size') || {}).textContent || '',
    minus: boxOf(steps[0]),
    plus: boxOf(steps[1]),
    body: boxOf(card.querySelector('.terminal-card__body')),
    screen: boxOf(card.querySelector('.xterm-screen')),
    viewport: viewport ? {
      ...boxOf(viewport),
      overflowY: getComputedStyle(viewport).overflowY,
      scrollTop: viewport.scrollTop,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      offsetWidth: viewport.offsetWidth,
      clientWidth: viewport.clientWidth,
    } : null,
    drawnRows: card.querySelectorAll('.xterm-rows > div').length,
    rows: (card.querySelector('.xterm-rows') || {}).textContent || '',
  };

  // Where the last cell of each ruler line was actually painted. A Range rather than the row's
  // own box: the question is whether that column landed clear of the strip, and the row is as
  // wide as the grid whether or not the frame could hold it.
  //
  // Every ruler on the screen, not the first one found, because this file prints one per font
  // size and the earlier ones are still in the buffer — reflowed into fragments by the resize,
  // some of which are dashes ending in a hash and match just as well. The caller picks the one
  // whose width is the grid it is asking about; a fragment never has that width.
  out.rulers = [...card.querySelectorAll('.xterm-rows > div')].map((row) => {
    const text = row.textContent || '';
    if (!/^-{4,}#/.test(text)) return null;
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
    return null;
  }).filter(Boolean);

  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

/**
 * How wide the strip the card names is, or `NaN` where it names none.
 *
 * `NaN` rather than a default, so every comparison against it is false: the code this check was
 * written against reserves nothing, and a missing width read as zero would let the geometry
 * cases pass by comparing the frame with itself.
 */
const reserveOf = (scene) => (Number.isFinite(scene.card.reserve) ? scene.card.reserve : Number.NaN);

/** Where the strip begins, in screen pixels. `NaN` where the card names no strip. */
const stripStart = (scene) => scene.card.viewport.right - reserveOf(scene);

/**
 * Where the strip is on screen: the last `reserve` pixels of the viewport, down its middle.
 *
 * The width falls back to 12 here and only here — a screenshot needs a rectangle, and without
 * one the pixel cases would die on a `NaN` clip and the run would report a single exception
 * instead of the red cases that say what is missing.
 */
const stripOf = (scene) => {
  const reserve = Number.isFinite(scene.card.reserve) ? scene.card.reserve : 12;
  return {
    x: scene.card.viewport.right - reserve / 2,
    left: scene.card.viewport.right - reserve,
    top: scene.card.viewport.top,
    height: scene.card.viewport.height,
  };
};

/**
 * Zoom 1, with the whole block on screen, however the last case left the canvas.
 *
 * **Below the app's own toolbar**, and that is not a taste. The card is clipped into the canvas
 * area by its wrapper, and the canvas area starts a little under 140px down the page — so a
 * block whose top lands at 120 has its header strip hidden, and the `−` and `+` on it are
 * coordinates a click passes straight through to the toolbar. The font sweep below then presses
 * nothing at all, for as many attempts as it is given. 180 puts the whole block on the window
 * with the header where it is drawn — and the window grew with the block when #199 made the
 * default 30 rows of 18px text, a thousand scene units tall rather than 720.
 */
const BLOCK_AT = { x: 60, y: 180 };

async function placeBoard() {
  const before = await evaluate(PROBE);
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${BLOCK_AT.x - before.block.x}, scrollY: ${BLOCK_AT.y - before.view.offsetTop - before.block.y}, zoom: { value: 1 } } })`);
  await sleep(600);
  return evaluate(PROBE);
}

/** One press of `+` or `-`, aimed at wherever the button is now. */
async function step(direction) {
  const scene = await evaluate(PROBE);
  const target = direction > 0 ? scene.card.plus : scene.card.minus;
  await click(target.x, target.y);
}

/** Press until the readout says this, or give up saying what it did say. */
async function stepTo(size) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const scene = await evaluate(PROBE);
    const at = Number(scene.card.readout);
    if (at === size) return at;
    await step(size > at ? 1 : -1);
  }
  return Number((await evaluate(PROBE)).card.readout);
}

/**
 * The state once everything has agreed about one font size.
 *
 * The rows check's helper, and here for its reason: the overlay redraws, the debounced report
 * reaches the server, the server answers with the new grid and the emulator resizes to it, each
 * at its own pace. Reading one of them early is how a case measures the previous size.
 */
async function settled(size) {
  let last = '';
  let stable = 0;
  let seen = 'nothing read';
  for (let attempt = 0; attempt < 250; attempt++) {
    let shell = null;
    let scene = null;
    try { shell = await session(); scene = await evaluate(PROBE); } catch { /* not yet */ }
    const agreed = shell && scene?.card?.screen
      && Math.abs(scene.card.fontSize - size) < 0.5
      && scene.card.drawnRows === shell.rows
      && scene.card.grid === `${shell.cols}×${shell.rows}`;
    seen = `card at ${scene?.card?.fontSize}px showing "${scene?.card?.grid}" over `
      + `${scene?.card?.drawnRows} drawn rows, shell at ${shell?.cols}×${shell?.rows}`;
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
  throw new Error(`timed out waiting for the grid to settle at ${size}px — ${seen}\n${serverLog}`);
}

/** A command into the focused shell. */
async function run(command) {
  await typeText(command);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
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
    // Deliberately no --hide-scrollbars: see the note at the top of this file.
    '--window-size=1500,1320',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the terminal overlay to render');

  // Zoom 1, where a scene unit and a screen pixel are the same thing — the only zoom at which
  // "the strip the grid reserved" and "the strip the bar is drawn in" are one currency.
  let scene = await placeBoard();
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  check('and the block is the size it is drawn at', scene.card.box.height > 400,
        `${scene.card.box.width.toFixed(0)}×${scene.card.box.height.toFixed(0)}`);

  console.log('\n1. the strip is a term of the grid, not room taken from the last column');
  let base = await settled(18);
  scene = base.scene;
  check('the card names a strip for the bar', reserveOf(scene) >= 8 && reserveOf(scene) <= 24,
        `--terminal-scrollbar is ${JSON.stringify(scene.card.reserve)}`);
  check('the viewport can scroll rather than clipping what it cannot hold',
        scene.card.viewport?.overflowY === 'auto' || scene.card.viewport?.overflowY === 'scroll',
        `overflow-y is ${scene.card.viewport?.overflowY}`);
  console.log(`     ${base.shell.cols}×${base.shell.rows} claimed, a ${scene.card.reserve}px strip in a `
    + `${scene.card.body.width.toFixed(1)}px frame, screen ${scene.card.screen.width.toFixed(1)}px`);
  check('the screen the shell was told about stops before the strip begins',
        scene.card.screen.right <= stripStart(scene) + 1,
        `screen ends at ${scene.card.screen.right.toFixed(1)}, the strip begins at `
        + `${stripStart(scene).toFixed(1)}`);
  // What a strip may cost, and no more. The columns the frame could otherwise hold, less the
  // columns the shell was told about: a strip is worth `ceil(strip / cell)` of them, plus one
  // for the floor in `terminalGrid()` and one for the frame's own deliberate over-reserve —
  // `TERMINAL_CHROME.width` is 20 against a padding that measures 13, and has been since #144.
  // A strip counted twice, or subtracted in the wrong units, spends more than that.
  {
    const cell = scene.card.screen.width / base.shell.cols;
    const held = Math.floor(scene.card.body.width / cell);
    const budget = Math.ceil(reserveOf(scene) / cell) + 2;
    check('and the strip is the only thing it costs',
          held - base.shell.cols <= budget,
          `${held - base.shell.cols} columns of the ${held} the frame holds, against a budget of `
          + `${budget} for a ${scene.card.reserve}px strip on a ${cell.toFixed(2)}px cell`);
  }

  console.log('\n2. a session that fits on one screen has no thumb');
  scene = await evaluate(PROBE);
  check('there is nothing to scroll yet',
        scene.card.viewport.scrollHeight <= scene.card.viewport.clientHeight + 1,
        `${scene.card.viewport.scrollHeight} of ${scene.card.viewport.clientHeight}`);
  const quiet = await thumbIn(stripOf(scene));
  await shot('01-no-scrollback');
  check('and nothing is painted in the strip', quiet.height <= 2,
        `${quiet.height}px of the strip is not paper (${JSON.stringify(quiet.sample)})`);

  // ─── The column the strip must not have taken ────────────────
  //
  // At the three sizes `check-terminal-rows-browser.mjs` sweeps, and for its reason: the strip
  // is scaled by the font, so a reservation that is right at 18 can be a column short at 8 and
  // a column wasted at 24. The ruler is the painted answer — the geometry above says the screen
  // *box* ends before the strip, this says the last character in it was drawn there.
  //
  // Before the transcript below, deliberately. A font step re-grids the block, and re-gridding
  // a block with four screenfuls behind it is xterm reflowing the whole buffer at a new width:
  // slower, and a thing this case is not about. The sweep ends back at 18, which is where the
  // scrollback cases want it.
  for (const [index, size] of [18, 8, 24].entries()) {
    console.log(`\n${3 + index}. the rightmost column the shell was told about, at ${size}px`);
    await placeBoard();
    await stepTo(size);
    const at = await settled(size);
    scene = await placeBoard();
    check(`${size}px: the readout says so`, scene.card.readout === String(size), scene.card.readout);
    check(`${size}px: the strip is the same strip, scaled with the text`,
          Math.abs(reserveOf(scene) - 12 * (size / 13)) < 0.6,
          `${scene.card.reserve} against the ${(12 * (size / 13)).toFixed(2)} the font asks for`);
    check(`${size}px: the screen stops before the strip`,
          scene.card.screen.right <= stripStart(scene) + 1,
          `screen ends at ${scene.card.screen.right.toFixed(1)}, the strip begins at `
          + `${stripStart(scene).toFixed(1)}`);

    await click(scene.card.body.x, scene.card.body.y);
    await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
    await sleep(400);
    await run(`node ruler.js ${at.shell.cols}`);
    // The ruler *this* grid drew, by its width — an earlier size's, reflowed into fragments by
    // the resize, is on the screen too. Waited for rather than asserted: that a line of `cols`
    // characters comes out `cols` wide is `check-terminal-font-browser.mjs`'s question, and
    // this one is about where its last column landed.
    const cell = await waitFor(async () => (await evaluate(PROBE)).rulers
      .filter((ruler) => ruler.width === at.shell.cols).pop(), `the ${at.shell.cols}-wide ruler to be drawn`);
    scene = await evaluate(PROBE);
    await shot(`0${2 + index}-ruler-${size}`);
    check(`${size}px: its last column is drawn in full, clear of the strip`,
          cell.right <= stripStart(scene) + 1 && cell.right > scene.card.viewport.left,
          `column ${cell.width} ends at ${cell.right.toFixed(1)}, the strip begins at `
          + `${stripStart(scene).toFixed(1)}`);
  }

  console.log('\n6. with more output than one screen there is a thumb, and it has a height');
  // Back to the default first: the sweep above left the block at 24, and the strip is what the
  // rest of this file is about rather than the font it was last set to.
  await placeBoard();
  await stepTo(18);
  base = await settled(18);
  scene = await placeBoard();
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await sleep(600);
  await run(`node lines.js ${base.shell.rows * 4}`);
  await waitFor(async () => (await evaluate(PROBE)).card.rows.includes(`line ${base.shell.rows * 4}`),
                'the shell to print four screenfuls', 100);
  await sleep(600);
  scene = await evaluate(PROBE);
  const strip = stripOf(scene);
  check('the viewport has more than it can show',
        scene.card.viewport.scrollHeight > scene.card.viewport.clientHeight + 1,
        `${scene.card.viewport.scrollHeight} of ${scene.card.viewport.clientHeight}`);
  const thumb = await thumbIn(strip);
  await shot('05-thumb');
  check('a thumb is painted in the strip, and it has a height', thumb.height > 8,
        `${thumb.height}px, sampled ${JSON.stringify(thumb.sample)}`);
  check('and it is shorter than the track, so it stands for a part of the transcript',
        thumb.height < scene.card.viewport.height * 0.9,
        `${thumb.height}px of a ${scene.card.viewport.height.toFixed(0)}px track`);

  console.log('\n7. dragging it moves the reader, and nothing else');
  {
    const before = await session();
    scene = await evaluate(PROBE);
    const scrollTop = scene.card.viewport.scrollTop;
    const shown = scene.card.rows;
    await drag(strip.x, thumb.middle, strip.x, Math.max(strip.top + 2, thumb.middle - thumb.height - 60));
    scene = await evaluate(PROBE);
    await shot('06-dragged');
    check('the drag moved the viewport', scene.card.viewport.scrollTop < scrollTop - 4,
          `scrollTop ${scrollTop} → ${scene.card.viewport.scrollTop}`);
    check('and the emulator drew a different part of the transcript', scene.card.rows !== shown,
          `${shown.slice(0, 50)} … / ${scene.card.rows.slice(0, 50)} …`);
    const after = await session();
    check('while the server\'s scrollback is byte-identical — a bar is a viewer, not an input',
          before?.scrollback === after?.scrollback,
          `${before?.scrollback?.length} bytes → ${after?.scrollback?.length} bytes`);
    check('and the shell was not told a new grid either',
          before?.cols === after?.cols && before?.rows === after?.rows,
          `${before?.cols}×${before?.rows} → ${after?.cols}×${after?.rows}`);
  }

  console.log('\n8. the wheel still does what it did — #112 and #162 are not regressed');
  {
    scene = await placeBoard();
    const before = { rows: scene.card.rows, view: scene.view };
    await wheel(scene.card.body.x, scene.card.body.y, -120, 3);
    scene = await evaluate(PROBE);
    check('a wheel the scrollback can use still scrolls it', scene.card.rows !== before.rows,
          `${before.rows.slice(0, 50)} … / ${scene.card.rows.slice(0, 50)} …`);
    check('without the board moving underneath it',
          Math.abs(scene.view.scrollY - before.view.scrollY) < 1
          && Math.abs(scene.view.zoom - before.view.zoom) < 0.001,
          `${JSON.stringify(before.view)} → ${JSON.stringify(scene.view)}`);
  }
  {
    // Down to the bottom of the scrollback first, which is where a reader who has caught up
    // with a run is sitting. Wheeled until the rows stop changing rather than a fixed count
    // of notches: how many it takes depends on how many rows the block holds and how far up
    // the thumb drag above left the reader, and #199 changed the first of those. Ten notches
    // was enough for a 28-row block and is not for a 30-row one.
    //
    // **This case used to assert the opposite, and #256 is why it does not.** The wheel that
    // reaches the canvas is the one over a block with *no* scrollback — which a block with a
    // bar on it is not, that bar being drawn precisely because there is one. Reaching the end
    // of what there is was read as the same thing, and the reader who had scrolled up to
    // read something watched the canvas pan away instead of stopping. `#112`'s promise is
    // unchanged and asserted where it applies:
    // `check-terminal-focus-browser.mjs` step 7 and `check-terminal-wheel-edge-browser.mjs`.
    scene = await evaluate(PROBE);
    let atBottom = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const now = (await evaluate(PROBE)).card.rows;
      if (now === atBottom) break;
      atBottom = now;
      await wheel(scene.card.body.x, scene.card.body.y, 120, 5);
    }
    scene = await placeBoard();
    const view = { scrollX: scene.view.scrollX, scrollY: scene.view.scrollY, zoom: scene.view.zoom };
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    const after = (await evaluate(PROBE)).view;
    await shot('07-wheel-at-the-bottom');
    check('and a wheel at the bottom of it stays with the terminal, board unmoved',
          Math.abs(after.scrollY - view.scrollY) < 1 && Math.abs(after.scrollX - view.scrollX) < 1
          && Math.abs(after.zoom - view.zoom) < 0.001,
          `${JSON.stringify(view)} → ${JSON.stringify(after)}`);
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
