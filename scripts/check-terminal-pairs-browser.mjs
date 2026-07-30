#!/usr/bin/env node
/**
 * Checks that a pair drawn from within the sixteen ANSI slots is legible — the slot as a
 * **page**, not only as ink — in **both** of the board's themes.
 *
 * `check-terminal-paper-browser.mjs` asks each of the sixteen to clear 3:1 against the
 * *surface*. Every one of them does, and it is the wrong half of the question: no slot was ever
 * checked as a **background**, and no pair from within the sixteen against another. The one
 * program this surface was built for draws one. Claude Code's hint chip is ANSI `black` on ANSI
 * `brightCyan`, which was **1.11:1** on paper and 2.15:1 on night — the illegible steel-blue
 * strip in #147's screenshot, and worse in light mode than in dark. That is #159.
 *
 * ## The contract this asserts
 *
 * A pair from within the sixteen clears the same **3:1** the ink floor asks for. Which pairs are
 * in reach is not a matter of taste — it falls out of the ink floor, and in opposite directions
 * in the two themes:
 *
 * - **`black` is the ink.** It is the one slot a program reaches for when it draws on a colour,
 *   and it is the end of the ramp: on paper the *darkest* of the sixteen, on night the one
 *   *closest to the surface* that still clears the ink floor. Both are asserted here, because a
 *   `black` that drifts back into the middle of the ramp is exactly how this defect happened.
 * - **On paper that is nearly free.** `black` can go all the way to the far end, so fourteen of
 *   the other fifteen are pages under it. Only `brightWhite` is not: on paper it is the
 *   strongest grey ink, and `black` on it is ink on ink.
 * - **On night `black` cannot leave the ink floor**, because a slot that fails as ink fails the
 *   other check. It sits just above it, which means a page has to be about **ten times** the
 *   surface to clear 3:1 over it — and that is the light half of Mocha. `red`, `blue`, `white`,
 *   `brightRed`, `brightBlue` and `brightBlack` are **out of reach**, and the reason is the
 *   hue rather than the taste: a red or a blue lifted to a 10:1 ink is a pink or a powder blue,
 *   which is no longer that colour, and `brightBlack` is the comment grey, which is near `black`
 *   by definition.
 * - **`brightWhite` is the other ink, and only on night**, where it clears `black` and
 *   `brightBlack`. On paper there is no light ink at all, and there cannot be: every one of the
 *   sixteen is 3:1 ink on a light page, so every one of them is dark. A program that draws
 *   light-on-colour cannot be served by any palette that keeps the ink floor. That is a cost of
 *   the floor, and it is written down rather than hidden.
 *
 * The named sets are asserted **exactly** — a slot outside them that turns out to clear 3:1
 * fails this check too. The lists are in `docs/terminal.md` as well, and a list that quietly
 * became wrong in one of the two places is the failure this project keeps paying for.
 *
 * ## Why a browser, and why a real shell
 *
 * A background is not a value the source can be asked for. xterm draws the sixteen from the
 * theme it was handed, through rules of its own in a stylesheet it injects, so what a slot is
 * *painted* as is a fact about the render. The pairs are therefore printed by a real shell as
 * real SGR escapes and read back off the spans as `color` and `background-color` — the pair a
 * reader is actually looking at, not the pair `terminal-palette.ts` says they are.
 *
 * The overlay is a DOM sibling of Excalidraw and nothing filters it, in either theme, so a
 * computed colour is the painted colour here — unlike the *shape* underneath, which is on the
 * filtered canvas and needs a screenshot. `check-terminal-paper-browser.mjs` is where that
 * distinction is paid for; this check never asks the canvas anything.
 *
 * The colours are literals here on purpose. `src/core/terminal-palette.ts` is where they are
 * decided, and a check that imported it would agree with whatever that file happened to say.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-pairs-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The two surfaces. The dark one is what the light one renders as — see the paper check. */
const SURFACE = { light: '#faf6ee', dark: '#1d1912' };

/** What a pair has to clear, which is the floor the ink already clears. */
const LEGIBLE = 3;

/** The sixteen, in the order a program numbers them. */
const SLOTS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta',
  'brightCyan', 'brightWhite',
];

/**
 * Which slots have to be a page under `black`, per theme, and exactly which.
 *
 * Light: everything but `brightWhite`. Night: the four light hues in both their members, plus
 * `brightWhite`. See the note on the file for why the two lists are not the same list.
 */
const PAGES = {
  light: SLOTS.filter((slot) => slot !== 'black' && slot !== 'brightWhite'),
  dark: ['yellow', 'green', 'cyan', 'magenta',
         'brightYellow', 'brightGreen', 'brightCyan', 'brightMagenta', 'brightWhite'],
};

/**
 * The light ink, and the pages it has to clear. Null where there is none to have.
 *
 * On paper every one of the sixteen is ink on a light page, so none of them is light: there is
 * no pair with a light foreground to check, and no palette that keeps the ink floor can offer
 * one.
 */
const LIGHT_INK = {
  light: null,
  dark: { ink: 'brightWhite', pages: ['black', 'brightBlack'] },
};

/**
 * The chip this issue is about, named rather than left to fall out of the list above.
 *
 * Claude Code draws `Review HANDOFF.md file` as ANSI `black` on ANSI `brightCyan`. It is the
 * program the terminal block exists to run, so the pair it happens to pick is a case in its own
 * right — if the palette ever moves in a way that keeps every list above true and still loses
 * this one, the failure should name the program.
 */
const CHIP = { ink: 'black', page: 'brightCyan', words: 'Review HANDOFF.md file' };

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
  // A transparent background is not a page: the question here is what was *painted*.
  if (parts.length > 3 && parts[3] < 0.99) return null;
  return parts.slice(0, 3);
}

const same = (a, b) => {
  const left = channels(a);
  const right = channels(b);
  return Boolean(left && right && left.every((value, at) => value === right[at]));
};

const hex = (value) => {
  const parts = channels(value);
  return parts ? `#${parts.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}` : String(value);
};

/** WCAG relative luminance, so "legible" is a number rather than an opinion. */
function luminance(colour) {
  const parts = channels(colour);
  if (parts === null) return null;
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

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-pairs-'));
const projectDir = join(workDir, 'pairs-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'pairs-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Pairs Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/**
 * Every pair the contract names, printed by a real shell as real escapes.
 *
 * Through Node rather than the shell's own spelling, for the reason the other terminal checks
 * give: the case is about what the pairs look like, and it should not also be about PowerShell
 * and `sh` disagreeing about how an escape is written. Markers are `P<n>X` and `W<n>X` so a
 * partial match — the `1` in `P13X` — cannot be mistaken for another one's.
 *
 * The chip is printed in the words Claude Code prints, so the screenshot shows the thing the
 * issue is about rather than a marker standing in for it.
 */
writeFileSync(join(projectDir, 'pairs.js'), [
  'const esc = String.fromCharCode(27);',
  'const fg = (index) => esc + "[" + (index < 8 ? 30 + index : 82 + index) + "m";',
  'const bg = (index) => esc + "[" + (index < 8 ? 40 + index : 92 + index) + "m";',
  'const off = esc + "[0m";',
  '',
  '// Each of the sixteen as a page, inked with ANSI black — what a chip is.',
  'const pages = [];',
  'for (let index = 0; index < 16; index++) {',
  '  pages.push(fg(0) + bg(index) + "P" + index + "X" + off);',
  '}',
  'process.stdout.write(pages.join(" ") + "\\r\\n");',
  '',
  '// The light ink, on the two slots dim enough to be a page for one.',
  'const inked = [];',
  'for (const index of [0, 8]) {',
  '  inked.push(fg(15) + bg(index) + "W" + index + "X" + off);',
  '}',
  'process.stdout.write(inked.join(" ") + "\\r\\n");',
  '',
  '// The chip this is all about, in its own words.',
  `process.stdout.write(fg(0) + bg(14) + " ${CHIP.words} " + off + "\\r\\n");`,
  '',
].join('\n'), 'utf8');

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
        window.__pairsCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Every drawn run on the screen, with the two colours it was drawn with.
 *
 * `background-color` is the half nothing has ever asked for. xterm paints a slot used as a page
 * through a rule in a stylesheet of its own, so a span that carries none reports the
 * transparent `rgba(0, 0, 0, 0)` — which `channels()` reads as "no colour was painted", and a
 * pair with no page is a failed case rather than a passing one.
 */
const PROBE = `(() => {
  const api = window.__pairsCheckApi;
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

  const shell = document.querySelector('.app');
  out.theme = shell ? shell.getAttribute('data-theme') : null;

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height,
             left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };

  const card = document.querySelector('.terminal-card');
  if (!card) { out.card = null; return out; }

  out.card = {
    box: boxOf(card),
    background: getComputedStyle(card).backgroundColor,
    body: boxOf(card.querySelector('.terminal-card__body')),
    screen: boxOf(card.querySelector('.xterm-screen')),
  };

  out.runs = Array.from(card.querySelectorAll('.xterm-rows span')).map((span) => {
    const style = getComputedStyle(span);
    return { text: (span.textContent || '').trim(), colour: style.color, background: style.backgroundColor };
  }).filter((run) => run.text.length > 0);

  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

/** Put the block on screen at a zoom of this case's choosing. */
async function viewAt(zoom, left = 60, top = 120) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__pairsCheckApi.updateScene({ appState: { scrollX: ${left / zoom} - ${scene.block.x}, scrollY: (${top} - ${scene.view.offsetTop}) / ${zoom} - ${scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(700);
  return evaluate(PROBE);
}

/** The board's theme, set the way a reader sets it — through Excalidraw's own appState. */
async function useTheme(theme) {
  await evaluate(`window.__pairsCheckApi.updateScene({ appState: { theme: ${JSON.stringify(theme)} } })`);
  await waitFor(async () => (await evaluate(PROBE)).theme === theme, `the board to go ${theme}`, 40);
  await sleep(900);
}

/** The run carrying one marker, or null if the shell never drew it. */
const runOf = (scene, text) => (scene.runs ?? []).find((run) => run.text === text) ?? null;

// ─── The cases, once per theme ────────────────────────────────

/**
 * Every one of the sixteen as a page, and `black` on it.
 *
 * The whole set is measured and printed before anything is asserted, because the interesting
 * output of this check is the table: which slots are pages in this theme is a fact about the
 * palette that the contract then has to keep up with.
 */
function pairCase(theme, scene) {
  const surface = SURFACE[theme];
  console.log(`\n${theme} 1. each of the sixteen as a page, inked with ANSI black`);

  const measured = SLOTS.map((slot, index) => {
    const run = runOf(scene, `P${index}X`);
    return {
      slot, index, run,
      ink: run?.colour ?? null,
      page: run?.background ?? null,
      ratio: run ? contrast(run.colour, run.background) : null,
      onSurface: run ? contrast(run.background, surface) : null,
    };
  });

  console.log('     ' + measured
    .map((pair) => `${pair.index}:${pair.ratio ? pair.ratio.toFixed(2) : '?'}`).join(' '));
  for (const pair of measured) {
    console.log(`     ${String(pair.index).padStart(2)} ${pair.slot.padEnd(14)} `
      + `page ${hex(pair.page)} ink ${hex(pair.ink)} `
      + `pair ${pair.ratio ? pair.ratio.toFixed(2) : 'unreadable'}:1  `
      + `page as ink ${pair.onSurface ? pair.onSurface.toFixed(2) : '?'}:1`);
  }

  // Every one of them has to have been *painted*: a slot xterm left at its own default reports
  // a transparent background, which is the shape a theme that sets five entries has.
  const unpainted = measured.filter((pair) => channels(pair.page) === null);
  check('every one of the sixteen was drawn as a real page by a real shell', unpainted.length === 0,
        unpainted.map((pair) => `${pair.slot} ${pair.run ? pair.run.background : 'never drawn'}`).join(', '));

  // The ink is one colour, the palette's `black`, in all sixteen — otherwise the numbers above
  // are about sixteen different questions.
  const inks = new Set(measured.map((pair) => hex(pair.ink)));
  check('and all sixteen were inked with the one colour, ANSI black', inks.size === 1,
        [...inks].join(', '));

  const wanted = new Set(PAGES[theme]);
  const shortfall = measured.filter((pair) => wanted.has(pair.slot) && !(pair.ratio >= LEGIBLE));
  check(`the ${wanted.size} slots the contract calls pages all clear ${LEGIBLE}:1 under black`,
        shortfall.length === 0,
        shortfall.map((pair) => `${pair.slot} at ${pair.ratio ? pair.ratio.toFixed(2) : 'unreadable'}`).join(', '));

  // Asserted exactly, in both directions. A slot that quietly came into reach is a `docs`
  // entry that quietly became wrong, and this project has paid for a list that was true once.
  const surprises = measured
    .filter((pair) => pair.slot !== 'black' && !wanted.has(pair.slot) && pair.ratio >= LEGIBLE);
  check('and the ones it calls out of reach really are out of reach', surprises.length === 0,
        surprises.map((pair) => `${pair.slot} now clears at ${pair.ratio.toFixed(2)} — the contract says it cannot`).join(', '));
}

/** `black` is the end of the ramp, which is the whole reason the list above is as long as it is. */
function inkEndCase(theme, scene) {
  const surface = SURFACE[theme];
  console.log(`\n${theme} 2. black is the end of the ramp, not a grey in the middle of it`);
  const inks = SLOTS.map((slot, index) => {
    const run = runOf(scene, `P${index}X`);
    return { slot, onSurface: run ? contrast(run.background, surface) : null };
  }).filter((entry) => entry.onSurface !== null);
  const black = inks.find((entry) => entry.slot === 'black');
  const others = inks.filter((entry) => entry.slot !== 'black');
  const ranked = [...inks].sort((a, b) => a.onSurface - b.onSurface)
    .map((entry) => `${entry.slot} ${entry.onSurface.toFixed(2)}`);
  console.log(`     against ${surface}, weakest first: ${ranked.join(', ')}`);

  if (theme === 'light') {
    // On paper black can go all the way to the far end, and has to: the further it is from the
    // page, the more of the other fifteen are a page for it.
    const stronger = others.filter((entry) => entry.onSurface >= black.onSurface);
    check('on paper black is the strongest ink of the sixteen', stronger.length === 0,
          stronger.map((entry) => `${entry.slot} is stronger at ${entry.onSurface.toFixed(2)}`).join(', '));
  } else {
    // On night it cannot: a slot that fails as ink fails the other check, so the best black
    // available is the one *nearest* the floor — and that is what decides which slots are pages.
    const dimmer = others.filter((entry) => entry.onSurface <= black.onSurface);
    check('on night black is the slot closest to the surface that is still ink',
          dimmer.length === 0 && black.onSurface >= LEGIBLE,
          dimmer.map((entry) => `${entry.slot} is closer at ${entry.onSurface.toFixed(2)}`).join(', ')
          || `black is at ${black.onSurface.toFixed(2)} against the surface`);
  }
}

/** The other ink, where the theme has one. */
function lightInkCase(theme, scene) {
  const rule = LIGHT_INK[theme];
  console.log(`\n${theme} 3. the light ink, on the slots dim enough to be a page for it`);
  if (!rule) {
    console.log('     none — on paper every one of the sixteen is ink on a light page, so none of');
    console.log('     them is light, and a program that draws light-on-colour cannot be served.');
    const drawn = [0, 8].map((index) => runOf(scene, `W${index}X`)).filter(Boolean);
    console.log('     ' + drawn.map((run) => `${hex(run.colour)} on ${hex(run.background)} `
      + `at ${(contrast(run.colour, run.background) ?? 0).toFixed(2)}:1`).join(', '));
    check('and the palette does not pretend otherwise: brightWhite on a grey stays under the floor',
          drawn.length === 2 && drawn.every((run) => contrast(run.colour, run.background) < LEGIBLE),
          drawn.map((run) => (contrast(run.colour, run.background) ?? 0).toFixed(2)).join(', '));
    return;
  }
  const measured = rule.pages.map((slot) => {
    const run = runOf(scene, `W${SLOTS.indexOf(slot)}X`);
    return { slot, run, ratio: run ? contrast(run.colour, run.background) : null };
  });
  console.log('     ' + measured.map((pair) => `${rule.ink} on ${pair.slot}: `
    + `${hex(pair.run?.colour)} on ${hex(pair.run?.background)} `
    + `at ${pair.ratio ? pair.ratio.toFixed(2) : '?'}:1`).join(', '));
  const faint = measured.filter((pair) => !(pair.ratio >= LEGIBLE));
  check(`${rule.ink} clears ${LEGIBLE}:1 on ${rule.pages.join(' and ')}`, faint.length === 0,
        faint.map((pair) => `${pair.slot} at ${pair.ratio ? pair.ratio.toFixed(2) : 'unreadable'}`).join(', '));
}

/** And the chip the whole issue is about, by name. */
function chipCase(theme, scene) {
  console.log(`\n${theme} 4. the Claude Code chip, which is the program this surface exists for`);
  const run = (scene.runs ?? []).find((entry) => entry.text.includes('HANDOFF'));
  const ratio = run ? contrast(run.colour, run.background) : null;
  console.log(`     "${run ? run.text : '(never drawn)'}" — ${CHIP.ink} ${hex(run?.colour)} `
    + `on ${CHIP.page} ${hex(run?.background)} at ${ratio ? ratio.toFixed(2) : '?'}:1`);
  check(`\`${CHIP.words}\` clears ${LEGIBLE}:1 as ${CHIP.ink} on ${CHIP.page}`, ratio >= LEGIBLE,
        ratio ? `${ratio.toFixed(2)}:1` : 'the chip was never drawn');
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

  // Pinned, not inherited. Without this the theme falls through to `prefers-color-scheme`, and
  // a check whose answer depends on the machine's own setting passes somewhere and fails
  // somewhere else for a reason nobody can see.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('excalidraw-canvas-theme', 'light') } catch (error) { /* no storage */ }`,
  });
  await send('Page.reload', { ignoreCache: false });
  await sleep(500);

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card?.screen, 'the terminal overlay to render');

  let scene = await viewAt(1);
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  check('and it is pinned light rather than left to the machine', scene.theme === 'light',
        `the board is ${scene.theme}`);
  check('the card is on paper', same(scene.card.background, SURFACE.light),
        `the card is ${scene.card.background}`);

  // The pairs are printed once and read twice: the transcript stays on the screen across a
  // theme toggle, and what changes is the colours xterm draws it in.
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await sleep(700);
  await typeText('node pairs.js');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => {
    const drawn = await evaluate(PROBE);
    return (drawn.runs ?? []).filter((run) => /^P\d{1,2}X$/.test(run.text)).length >= 16
      && (drawn.runs ?? []).some((run) => run.text.includes('HANDOFF'));
  }, 'the pairs to be drawn');
  scene = await evaluate(PROBE);
  await shot('light-01-pairs');

  pairCase('light', scene);
  inkEndCase('light', scene);
  lightInkCase('light', scene);
  chipCase('light', scene);

  console.log('\n5. the same transcript, after dark');
  await useTheme('dark');
  scene = await evaluate(PROBE);
  await shot('dark-01-pairs');
  check('the card is on its night side', same(scene.card.background, SURFACE.dark),
        `the card is ${scene.card.background}`);

  pairCase('dark', scene);
  inkEndCase('dark', scene);
  lightInkCase('dark', scene);
  chipCase('dark', scene);
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
