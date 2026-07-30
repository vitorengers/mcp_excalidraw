#!/usr/bin/env node
/**
 * Checks that the rows the terminal block reports are rows the frame can actually draw.
 *
 * `check-terminal-font-browser.mjs` makes this assertion about **width** — a line exactly as
 * wide as the grid the header claims, whose last column has to land inside the block — and
 * says in a comment why it stops there: the cell *height* was wrong before the font buttons
 * existed, at the default size with no button pressed, and correcting it moves what every
 * shell on every board is told. This is the vertical half, and the reason it is a check of
 * its own is that it has to sweep the font range rather than ride along with a case about
 * something else.
 *
 * The defect it was written against: `TERMINAL_CELL` took a row to be `1.35 ×` the font,
 * which is the `lineHeight` xterm is *given*. xterm does not apply that to the font size —
 * it measures the font's own line box first, which for this monospace stack is a little over
 * `1em`, and multiplies that. So the block divided by a cell about 15% too short and handed
 * the shell two or three rows more than it had room for, and `TerminalPanel.css` clips what
 * the frame cannot hold rather than scrolling it. The bottom rows were unreachable.
 *
 * Everything here is measured off a real render, because the constant is exactly what an
 * arithmetic check cannot catch: a check that divides by the same wrong cell the code does
 * agrees with it. So the questions are asked of the DOM — is `.xterm-screen`, which xterm
 * sizes as `rows × cell`, inside `.terminal-card__body`, which is the frame — and of the
 * shell, whose `cols`×`rows` is what came back from the server rather than what the browser
 * hoped.
 *
 * At **zoom 1**, deliberately. The grid is derived from the block's *scene* size so that a
 * pinch is not a resize, so the cell has to be a scene-unit cell; zoom 1 is where scene units
 * and screen pixels are the same thing and the question is therefore well posed. The board's
 * zoom scales the frame and the text together, which is the design.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-rows-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-rows-'));
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
 * As many lines as the grid claims, the last of them marked.
 *
 * The vertical twin of the width check's ruler, and through Node for the same reason: the
 * case is about a row being drawn, and it should not also be about PowerShell and `sh`
 * spelling repetition differently.
 */
writeFileSync(join(projectDir, 'rows.js'), [
  'const rows = Number(process.argv[2]);',
  'const lines = [];',
  'for (let row = 1; row < rows; row++) lines.push(String(row));',
  "lines.push('#last');",
  "process.stdout.write(lines.join('\\n') + '\\n');",
  '',
].join('\n'), 'utf8');

const PORT = 35900 + (process.pid % 200);
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
 * What the block is, and what the emulator drew inside it.
 *
 * `.xterm-screen` is the measurement that matters: xterm sizes it as `rows × cell`, so its
 * height *is* the screen the shell was told it had, in the pixels it was actually drawn in.
 * `.terminal-card__body` is the frame around it — the block minus the header, the tab strip
 * and the padding. There was a prompt row below it too, until #144.
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
  out.card = {
    box: boxOf(card),
    fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    // The strip the scrollback bar is drawn in, which since #197 is part of the frame the
    // emulator does *not* have. Read off the card rather than assumed, because it scales with
    // the font and this file sweeps the font range.
    reserve: Number.parseFloat(getComputedStyle(card).getPropertyValue('--terminal-scrollbar')),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    readout: (card.querySelector('.terminal-card__font-size') || {}).textContent || '',
    minus: boxOf(steps[0]),
    plus: boxOf(steps[1]),
    body: boxOf(card.querySelector('.terminal-card__body')),
    screen: boxOf(card.querySelector('.xterm-screen')),
    drawnRows: card.querySelectorAll('.xterm-rows > div').length,
  };

  // Where the marked last line was painted, if it has been printed yet.
  out.lastRow = (() => {
    const rows = card.querySelectorAll('.xterm-rows > div');
    for (let index = rows.length - 1; index >= 0; index--) {
      if (/^#last/.test(rows[index].textContent || '')) return { ...boxOf(rows[index]), index };
    }
    return null;
  })();

  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

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
 * Four things have to catch up and they do it at their own pace: the overlay redraws at the
 * new font, the debounced report reaches the server, the server answers `GET /api/terminal`
 * with the new grid, and the emulator resizes to it. Reading any one of them early is how a
 * case measures the *previous* size and passes on a grid nobody is looking at, so this holds
 * out for all four agreeing and then staying that way for longer than the debounce.
 *
 * The font is the anchor the others are checked against: at zoom 1 the card is drawn at the
 * reader's size exactly, so a card still at 13 is a card that has not caught up yet.
 */
async function settled(size) {
  let last = '';
  let stable = 0;
  for (let attempt = 0; attempt < 200; attempt++) {
    let shell = null;
    let scene = null;
    try { shell = await session(); scene = await evaluate(PROBE); } catch { /* not yet */ }
    const agreed = shell && scene?.card?.screen
      && Math.abs(scene.card.fontSize - size) < 0.5
      && scene.card.drawnRows === shell.rows
      && scene.card.grid === `${shell.cols}×${shell.rows}`;
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
  throw new Error(`timed out waiting for the grid to settle at ${size}px\n${serverLog}`);
}

/**
 * The whole question, at one font size.
 *
 * Two ways of asking it, because they fail differently. The geometry is the direct one: the
 * screen xterm drew is `rows × cell`, and it has to be inside the frame. The arithmetic is
 * the one that says *by how much* — the real cell, read back from the render, against the
 * frame the block actually has.
 *
 * Asked of **both** axes since #115. It was rows only, because the width was linear at
 * 0.586px per font pixel against the 0.585 the cell was drawn with, and that agreement was a
 * fact about one typeface: the block now draws in Comic Shanns, whose glyphs are 0.55 wide,
 * and a column constant carried across a typeface change is the same defect as the row one
 * this file was written for, five per cent the other way. So the columns are measured off
 * the render here rather than trusted, at all three sizes, and the width has stopped being
 * an assumption named in a comment.
 */
async function assertFits(label, size) {
  const { shell, scene } = await settled(size);
  const { body, screen } = scene.card;
  const cell = { width: screen.width / shell.cols, height: screen.height / shell.rows };
  // The frame *the text* has, which since #197 is not the whole frame: the last
  // `--terminal-scrollbar` pixels across are the strip the scrollback bar is drawn in, and
  // `terminalGrid()` gives them up before it divides. Measured off the card rather than
  // assumed, so this stays the question it was — "are the columns the shell was told about
  // columns the frame can draw" — rather than becoming a question about the strip's width.
  const strip = Number.isFinite(scene.card.reserve) ? scene.card.reserve : 0;
  const holds = {
    cols: Math.floor((body.width - strip) / cell.width),
    rows: Math.floor(body.height / cell.height),
  };
  console.log(`     ${shell.cols}×${shell.rows} claimed, cell `
    + `${cell.width.toFixed(2)}×${cell.height.toFixed(2)}px, screen `
    + `${screen.width.toFixed(1)}×${screen.height.toFixed(1)}px in a `
    + `${body.width.toFixed(1)}×${body.height.toFixed(1)}px frame `
    + `less a ${strip.toFixed(1)}px scrollbar strip `
    + `(the frame holds ${holds.cols}×${holds.rows})`);

  check(`${label}: the screen the shell was told fits inside the frame`,
        screen.bottom <= body.bottom + 1,
        `screen ends at ${screen.bottom.toFixed(1)}, frame at ${body.bottom.toFixed(1)} `
        + `— ${(screen.bottom - body.bottom).toFixed(1)}px clipped`);
  check(`${label}: and the rows it claims are rows the frame can hold`,
        shell.rows <= holds.rows,
        `${shell.rows} claimed, ${holds.rows} can be drawn`);
  check(`${label}: without giving up so many that the block is wasted`,
        shell.rows >= holds.rows - 2 && shell.rows > 4,
        `${shell.rows} claimed of the ${holds.rows} that fit`);

  check(`${label}: the screen is inside the frame across, too`,
        screen.right <= body.right + 1,
        `screen ends at ${screen.right.toFixed(1)}, frame at ${body.right.toFixed(1)} `
        + `— ${(screen.right - body.right).toFixed(1)}px clipped`);
  check(`${label}: and the columns it claims are columns the frame can hold`,
        shell.cols <= holds.cols,
        `${shell.cols} claimed, ${holds.cols} can be drawn`);
  check(`${label}: without giving up so many that the block is wasted across`,
        shell.cols >= holds.cols - 2 && shell.cols > 20,
        `${shell.cols} claimed of the ${holds.cols} that fit`);
  return { shell, scene };
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
    '--window-size=1500,1320',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the terminal overlay to render');

  // Zoom 1, and the block put where the whole of it is on screen. Scene units and screen
  // pixels are then the same thing, which is the only zoom at which "the rows the block
  // reports" and "the rows the frame draws" are being measured in one currency.
  //
  // 180 down the page rather than 120, and that is what sections 3 and 4 below were quietly
  // failing on: the card is clipped into the canvas area by its wrapper, the canvas area
  // starts a little under 140px down, and a block whose top lands at 120 has its header strip
  // — the `−` and `+` this file steps the font with — hidden behind the app's own toolbar.
  // The clicks landed on the toolbar, the readout never moved, and the sweep timed out
  // waiting for a font it had never asked for. 180 puts the whole 720-tall block on a
  // 950-tall window with the header where it is drawn.
  let scene = await evaluate(PROBE);
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${60 - scene.block.x}, scrollY: ${180 - scene.view.offsetTop - scene.block.y}, zoom: { value: 1 } } })`);
  await sleep(600);
  scene = await evaluate(PROBE);
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  check('and the block is the size it is drawn at', scene.card.box.height > 400,
        `${scene.card.box.width.toFixed(0)}×${scene.card.box.height.toFixed(0)}`);

  console.log('\n1. at the default size, with no button pressed');
  check('the readout says the default', scene.card.readout === '18', scene.card.readout);
  const base = await assertFits('18px', 18);
  await shot('01-default');

  console.log('\n2. and the bottom row is a row the reader can see');
  // The geometry above says the screen fits. This says a line printed into its last row was
  // painted where a reader could read it — the vertical twin of the width check's ruler,
  // and the thing three UI defects in this repository got past by compiling.
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await sleep(600);
  await typeText(`node rows.js ${base.shell.rows}`);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  const lastRow = await waitFor(async () => (await evaluate(PROBE)).lastRow, 'the last line to be drawn');
  scene = await evaluate(PROBE);
  await shot('02-bottom-row');
  check('the marked last line is inside the block, not clipped off the bottom of it',
        lastRow.bottom <= scene.card.box.bottom + 1 && lastRow.top > scene.card.box.top,
        `it ends at ${lastRow.bottom.toFixed(1)}, the block at ${scene.card.box.bottom.toFixed(1)}`);
  check('and inside the frame the emulator was given',
        lastRow.bottom <= scene.card.body.bottom + 1,
        `it ends at ${lastRow.bottom.toFixed(1)}, the frame at ${scene.card.body.bottom.toFixed(1)}`);

  console.log('\n3. at the bottom of the font range, where the rows are most numerous');
  await stepTo(8);
  scene = await evaluate(PROBE);
  check('the readout says the smallest size', scene.card.readout === '8', scene.card.readout);
  await assertFits('8px', 8);
  await shot('03-smallest');

  console.log('\n4. and at the top of it, where the frame takes the most room');
  await stepTo(24);
  scene = await evaluate(PROBE);
  check('the readout says the largest size', scene.card.readout === '24', scene.card.readout);
  await assertFits('24px', 24);
  await shot('04-largest');
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
