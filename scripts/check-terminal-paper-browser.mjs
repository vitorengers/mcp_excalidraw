#!/usr/bin/env node
/**
 * Checks that the terminal is drawn in the board's design: paper, and the hand-drawn code face.
 *
 * Every other region of this board is a pale block with a hand-drawn label. The terminal was
 * the one thing in another design language — a Catppuccin Mocha surface on a `#1e1e2e` shape,
 * in whatever monospace stack the machine happened to resolve. That was a deliberate decision
 * once (`TerminalPanel.css` said so: a terminal that follows the canvas into light mode stops
 * looking like one), and #115 reverses it, so this is the case that pins the new one down.
 *
 * Four questions, and every one of them is a question only a browser answers:
 *
 * - **is it paper?** The overlay paints the surface and the shape underneath is filled to
 *   match, so the two have to be the *same* colour as well as the right one — a card that
 *   drifted from its own block would be a rectangle with a border of the old fill around it.
 * - **is the face the one the blocks use?** Excalifont is proportional and cannot drive an
 *   emulator, so the board's code face is the monospaced sibling Excalidraw ships beside it,
 *   Comic Shanns. A web font that never loaded is invisible in the source: the stack still
 *   names it, `document.fonts.check()` still says yes — it answers about the *list*, and a
 *   list whose first entry matches nothing is a list that resolved to its fallback. So the
 *   question is asked of the glyphs, whose advance width is 0.55 per font pixel in Comic
 *   Shanns against 0.586 in the stack behind it.
 * - **is the colour legible on it?** A theme sets five entries and the other sixteen fall
 *   through to xterm's dark-tuned defaults, where the yellow, the bright white and the bright
 *   cyan are near invisible on a light background. So all sixteen are printed by a real shell
 *   and read back from the render, and each one has to clear 3:1 against the paper it is
 *   drawn on.
 * - **does it still say terminal when the text has gone?** The dark fill used to be the thing
 *   that said so at a zoom too far out for the overlay to be legible, and paper cannot do
 *   that job. Whatever replaces it has to be an *area* rather than a glyph, so this asks at a
 *   zoom where the text is under five pixels and nothing can be read.
 *
 * The colours are literals here on purpose. `src/core/terminal-palette.ts` is where they are
 * decided, and a check that imported it would agree with whatever that file happened to say.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-paper-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The contract, spelled out rather than imported. See the note on the file. */
const PAPER = '#faf6ee';
const FACE = 'Comic Shanns';
/** Comic Shanns' advance width per font pixel, measured off a real render of the face. */
const ADVANCE = 0.55;
/** The stack behind it resolves to about this, which is how a fallback gives itself away. */
const FALLBACK_ADVANCE = 0.586;
/** What a colour has to clear against the paper to count as ink rather than a watermark. */
const LEGIBLE = 3;

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

// ─── Colour, as the browser hands it back ─────────────────────

/** `rgb(250, 246, 238)` or `#faf6ee` → `[250, 246, 238]`, and anything else to null. */
function channels(value) {
  const text = String(value ?? '').trim();
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = text.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return null;
  const parts = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
  // A transparent surface is not a colour: the question here is what was *painted*.
  if (parts.length > 3 && parts[3] < 0.99) return null;
  return parts.slice(0, 3);
}

const same = (a, b) => {
  const left = channels(a);
  const right = channels(b);
  return Boolean(left && right && left.every((value, at) => value === right[at]));
};

/** WCAG relative luminance, so "legible" is a number rather than an opinion. */
function luminance(colour) {
  const parts = channels(colour);
  if (!parts) return null;
  const [r, g, b] = parts.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  if (first === null || second === null) return null;
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-paper-'));
const projectDir = join(workDir, 'paper-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'paper-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Paper Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/**
 * All sixteen ANSI colours, each around a marker the render can be searched for.
 *
 * Through Node rather than the shell's own spelling, for the reason the rows check gives:
 * the case is about what the colours look like, and it should not also be about PowerShell
 * and `sh` disagreeing about how an escape is written. The marker is `C<n>X` so a partial
 * match — the `13` in `C13X` — cannot be mistaken for another one's.
 */
writeFileSync(join(projectDir, 'colours.js'), [
  'const esc = String.fromCharCode(27);',
  'const words = [];',
  'for (let index = 0; index < 16; index++) {',
  '  const code = index < 8 ? 30 + index : 82 + index;',
  "  words.push(esc + '[' + code + 'm' + 'C' + index + 'X' + esc + '[39m');",
  '}',
  "process.stdout.write(words.join(' ') + '\\n');",
  '',
].join('\n'), 'utf8');

const PORT = 36100 + (process.pid % 200);
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
        window.__paperCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The surface, the face and the ink, as the browser resolved all three.
 *
 * `screen.width / cols` is the advance width xterm actually drew with: it sizes its screen as
 * `cols × cell`, so dividing back out gives the cell rather than an estimate of it. That is
 * the one measurement a font that failed to load cannot fake.
 */
const PROBE = `(() => {
  const api = window.__paperCheckApi;
  const out = { block: null };
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                      backgroundColor: element.backgroundColor, strokeColor: element.strokeColor };
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

  const rows = card.querySelector('.xterm-rows');
  const screen = card.querySelector('.xterm-screen');
  const header = card.querySelector('.terminal-card__header');

  out.card = {
    box: boxOf(card),
    background: getComputedStyle(card).backgroundColor,
    fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    rowsFontFamily: rows ? getComputedStyle(rows).fontFamily : null,
    rowsFontSize: rows ? Number.parseFloat(getComputedStyle(rows).fontSize) : null,
    rowsColour: rows ? getComputedStyle(rows).color : null,
    screen: boxOf(screen),
    body: boxOf(card.querySelector('.terminal-card__body')),
    header: header ? { ...boxOf(header), background: getComputedStyle(header).backgroundColor } : null,
    // The emulator's own backdrop, which xterm paints from the theme it was given rather
    // than from the stylesheet. A card that is paper over a viewport that is not is still a
    // dark terminal with a light frame around it.
    viewport: (() => {
      const node = card.querySelector('.xterm-viewport');
      return node ? getComputedStyle(node).backgroundColor : null;
    })(),
  };

  // Whether the face is really in the document, rather than named in a list. fonts.check()
  // answers about the list and says yes when nothing in it matched, so this asks the set.
  out.face = (() => {
    const wanted = ${JSON.stringify(FACE)};
    const found = [];
    try {
      document.fonts.forEach((face) => {
        const family = String(face.family || '').replace(/^["']|["']$/g, '');
        if (family === wanted) found.push(face.status);
      });
    } catch (error) { return { error: String(error) } }
    return { registered: found.length, loaded: found.filter((status) => status === 'loaded').length };
  })();

  // Every marker the colour script printed, with the colour it was drawn in.
  out.inks = Array.from(card.querySelectorAll('.xterm-rows span'))
    .map((span) => ({ text: (span.textContent || '').trim(), colour: getComputedStyle(span).color }))
    .filter((span) => /^C\\d{1,2}X$/.test(span.text));

  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

/** Put the block on screen at a zoom of this case's choosing. */
async function viewAt(zoom, left = 60, top = 120) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__paperCheckApi.updateScene({ appState: { scrollX: ${left / zoom} - ${scene.block.x}, scrollY: (${top} - ${scene.view.offsetTop}) / ${zoom} - ${scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(700);
  return evaluate(PROBE);
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
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card?.screen, 'the terminal overlay to render');

  // Zoom 1, where a scene unit is a pixel and the advance width can be compared with the
  // number the face is specified in.
  let scene = await viewAt(1);
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  await shot('01-paper');

  console.log('\n1. the block and the overlay are one paper surface');
  check('the shape underneath is filled with paper', same(scene.block.backgroundColor, PAPER),
        `the rectangle is ${scene.block.backgroundColor}, not ${PAPER}`);
  check('the overlay paints the same paper', same(scene.card.background, PAPER),
        `the card is ${scene.card.background}, not ${PAPER}`);
  check('so the two are the same colour, not two colours that both look light',
        same(scene.card.background, scene.block.backgroundColor),
        `card ${scene.card.background} over block ${scene.block.backgroundColor}`);
  check("and the emulator's own backdrop is paper too, not the theme it shipped with",
        scene.card.viewport === null || same(scene.card.viewport, PAPER),
        `the xterm viewport is ${scene.card.viewport}`);

  console.log('\n2. the rows are drawn in the face the blocks use');
  check(`the face is registered on the document and loaded`,
        scene.face?.registered > 0 && scene.face?.loaded > 0,
        JSON.stringify(scene.face));
  check(`the rows ask for ${FACE} before anything else`,
        /^["']?Comic Shanns["']?/.test(String(scene.card.rowsFontFamily).trim()),
        String(scene.card.rowsFontFamily));

  // The question the source cannot answer. A stack that names a face which never arrived
  // renders in the next one along, and the only place that shows is the glyph width.
  {
    const shell = await waitFor(async () => {
      const [first] = (await (await api('/api/terminal')).json())?.sessions ?? [];
      return first && first.cols > 20 ? first : null;
    }, 'the session to report a grid');
    const advance = scene.card.screen.width / shell.cols;
    const perPixel = advance / scene.card.rowsFontSize;
    console.log(`     ${shell.cols} columns across ${scene.card.screen.width.toFixed(1)}px `
      + `at ${scene.card.rowsFontSize}px: ${advance.toFixed(3)}px a glyph, `
      + `${perPixel.toFixed(4)} per font pixel`);
    check(`and the glyphs really are ${FACE}'s, ${ADVANCE} wide per font pixel`,
          Math.abs(perPixel - ADVANCE) < 0.01,
          `${perPixel.toFixed(4)} per font pixel — `
          + `${Math.abs(perPixel - FALLBACK_ADVANCE) < 0.01 ? 'that is the fallback stack' : 'neither face'}`);
  }

  console.log('\n3. all sixteen ANSI colours are ink a reader can read');
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await sleep(700);
  await typeText('node colours.js');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  const inks = await waitFor(async () => {
    const found = (await evaluate(PROBE)).inks ?? [];
    return found.length >= 16 ? found : null;
  }, 'the sixteen colours to be drawn');
  scene = await evaluate(PROBE);
  await shot('02-ansi');

  const worst = [];
  for (let index = 0; index < 16; index++) {
    const ink = inks.find((span) => span.text === `C${index}X`);
    const ratio = ink ? contrast(ink.colour, PAPER) : null;
    worst.push({ index, colour: ink?.colour ?? null, ratio });
  }
  console.log('     ' + worst.map((ink) => `${ink.index}:${ink.ratio ? ink.ratio.toFixed(1) : '?'}`).join(' '));
  const faint = worst.filter((ink) => !(ink.ratio >= LEGIBLE));
  check(`every one of the sixteen clears ${LEGIBLE}:1 against the paper`, faint.length === 0,
        faint.map((ink) => `${ink.index} ${ink.colour} at ${ink.ratio ? ink.ratio.toFixed(2) : 'unreadable'}`).join(', '));
  check('and the default foreground is darker still, since most of the text is that one',
        contrast(scene.card.rowsColour, PAPER) >= 4.5,
        `${scene.card.rowsColour} at ${(contrast(scene.card.rowsColour, PAPER) ?? 0).toFixed(2)}`);

  console.log('\n4. and it still says terminal at a zoom where nothing can be read');
  scene = await viewAt(0.15);
  await shot('03-zoomed-out');
  check('the text is past legibility', scene.card.fontSize <= 5, `${scene.card.fontSize}px`);
  check('the block is still on screen to be read', scene.card.box.width > 60,
        `${scene.card.box.width.toFixed(0)}×${scene.card.box.height.toFixed(0)}`);

  // The dark fill used to do this. Whatever took it over has to be an area with a colour of
  // its own — a glyph at four pixels is a smudge, and a rule one pixel high is nothing.
  // It was two bands, top and bottom, until #144 took the bottom one away; the question was
  // always whether *a* band survives being shrunk, and the header is the one that also has a
  // second job — it is what selects and drags the block.
  const bands = [scene.card.header].filter(Boolean).map((band) => ({
    ...band,
    ratio: contrast(band.background, PAPER),
  }));
  console.log('     ' + bands.map((band) => `${band.background} ${band.width.toFixed(0)}×${band.height.toFixed(1)} at ${band.ratio ? band.ratio.toFixed(1) : '?'}:1`).join('  '));
  const marks = bands.filter((band) => band.ratio >= LEGIBLE
    && band.height >= 2 && band.width >= scene.card.box.width * 0.7);
  check('a band of its own colour still crosses the block', marks.length > 0,
        bands.map((band) => `${band.background} ${band.width.toFixed(0)}×${band.height.toFixed(1)}`).join(', ')
        || 'nothing on the card carries a background');
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
