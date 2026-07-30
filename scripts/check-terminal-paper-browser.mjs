#!/usr/bin/env node
/**
 * Checks that the terminal is drawn in the board's design, in **both** of the board's themes.
 *
 * Every other region of this board is a pale block with a hand-drawn label. The terminal was
 * the one thing in another design language — a Catppuccin Mocha surface on a `#1e1e2e` shape,
 * in whatever monospace stack the machine happened to resolve. That was a deliberate decision
 * once (`TerminalPanel.css` said so: a terminal that follows the canvas into light mode stops
 * looking like one), and #115 reversed it, so this is the case that pins the design down.
 *
 * #147 is the half of that #115 got wrong, and it is why every case below runs twice. Dark
 * mode on this board is not a stylesheet, it is a **filter on the canvas** —
 * `.theme--dark canvas { filter: invert(93%) hue-rotate(180deg) }`, which Excalidraw ships.
 * The block is on that canvas, so its paper fill is painted near-black for free; the overlay
 * is a `div` and a *sibling* of Excalidraw, so nothing filters it and it painted a literal
 * `#faf6ee` on a dark board. Two things the source asserts are one colour, drawn as two.
 *
 * That is why the first case of each theme is a **rendered pixel** rather than a string.
 * `getComputedStyle` and `element.backgroundColor` both answer about what was *declared*, and
 * the filter applies at paint — so the old version of this case compared `#faf6ee` with
 * `#faf6ee` and passed while the screen showed a bright card in a dark ring. The comparison
 * here is a screenshot of the canvas where the block is against a screenshot of the card, and
 * it can only be answered by looking.
 *
 * The questions, and every one of them is a question only a browser answers:
 *
 * - **is the block and its overlay one surface, as painted?** The overlay paints the surface
 *   and the shape underneath is filled to match, so the two have to come out the same colour
 *   *after* the canvas filter has had its way with one of them and not the other.
 * - **is the face the one the blocks use?** Excalifont is proportional and cannot drive an
 *   emulator, so the board's code face is the monospaced sibling Excalidraw ships beside it,
 *   Comic Shanns. A web font that never loaded is invisible in the source: the stack still
 *   names it, `document.fonts.check()` still says yes — it answers about the *list*, and a
 *   list whose first entry matches nothing is a list that resolved to its fallback. So the
 *   question is asked of the glyphs, whose advance width is 0.55 per font pixel in Comic
 *   Shanns against 0.586 in the stack behind it.
 * - **is the colour legible on it?** A theme sets five entries and the other sixteen fall
 *   through to xterm's dark-tuned defaults. So all sixteen are printed by a real shell and
 *   read back from the render, and each one has to clear 3:1 against **its own theme's**
 *   surface — the light palette's sixteen would be near-invisible on the dark one and the
 *   other way about.
 * - **does it still say terminal when the text has gone?** The dark fill used to be the thing
 *   that said so at a zoom too far out for the overlay to be legible. Whatever replaces it has
 *   to be an *area* rather than a glyph, and it has to be one in both themes: a dark band on a
 *   dark card is not a band.
 * - **does toggling the theme cost the session?** The emulator is re-themed in place. Rebuilt
 *   instead, it would take the screen with it — a program on the alternate screen replayed
 *   into a fresh parser is that program's scrollback, not that program. So the toggle happens
 *   with `vim`'s trick on screen and the emulator's own DOM node marked, and both survive.
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
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two surfaces, spelled out rather than imported. See the note on the file.
 *
 * The dark one is **what the light one renders as**. The shape is an ordinary block fill and
 * behaves like every other block fill on this board: it is a literal pastel that Excalidraw's
 * dark filter darkens, and it is scene data, so it cannot depend on which theme the reader
 * happens to have on without every toggle becoming a board change. So the fill stays put in
 * both themes and the dark palette's surface is defined as the colour it comes out — measured
 * off a real render, `invert(93%) hue-rotate(180deg)` of `#faf6ee`.
 */
const SURFACE = { light: '#faf6ee', dark: '#1d1912' };
const FACE = 'Comic Shanns';
/** Comic Shanns' advance width per font pixel, measured off a real render of the face. */
const ADVANCE = 0.55;
/** The stack behind it resolves to about this, which is how a fallback gives itself away. */
const FALLBACK_ADVANCE = 0.586;
/** What a colour has to clear against its own surface to count as ink rather than a watermark. */
const LEGIBLE = 3;
/**
 * How far two renderings of one surface may be apart and still be one surface.
 *
 * Not zero: the filter is arithmetic on eight-bit channels and rounds, and a screenshot of a
 * rounded corner is antialiased. Small enough that the defect this case exists for — a card
 * eight stops brighter than the block under it — cannot hide inside it.
 */
const SAME_SURFACE = 6;

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
  if (Array.isArray(value)) return value.slice(0, 3);
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

/** The same question of two *renderings*, where the filter's rounding is allowed for. */
const nearly = (a, b, tolerance = SAME_SURFACE) => {
  const left = channels(a);
  const right = channels(b);
  return Boolean(left && right && left.every((value, at) => Math.abs(value - right[at]) <= tolerance));
};

const hex = (value) => {
  const parts = channels(value);
  return parts ? `#${parts.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}` : String(value);
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

// ─── Pixels, as the screen really has them ────────────────────

/**
 * Enough of a PNG decoder to read a clipped screenshot back.
 *
 * Chrome hands `Page.captureScreenshot` back as a PNG and the whole point of these cases is
 * that no API in the page can answer them — a CSS filter is applied when the canvas is
 * composited, so every colour the DOM will tell you about is the colour before it. Eight-bit,
 * colour type 2 or 6, which is all Chrome emits; the five row filters are all handled because
 * which one it picks for a given strip is its business, not ours.
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
  return (x, y) => {
    const base = y * stride + x * lanes;
    return [out[base], out[base + 1], out[base + 2]];
  };
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

/** `vim`'s trick, and nothing else: switch to the alternate screen and leave a word on it. */
const ALT_MARK = 'ALTSCREENMARK';
writeFileSync(join(projectDir, 'alt.js'), [
  'const esc = String.fromCharCode(27);',
  `process.stdout.write(esc + '[?1049h' + esc + '[H' + ${JSON.stringify(ALT_MARK)} + '\\r\\n');`,
  '',
].join('\n'), 'utf8');

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

/** What one point of the screen really is, filter and all. */
async function pixelAt(x, y) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1, scale: 1 },
  });
  return decodePng(Buffer.from(data, 'base64'))(0, 0);
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

  // Which theme the board is in, from the two places that have to agree about it: the shell
  // around the canvas and Excalidraw's own container, whose class is what carries the filter.
  const shell = document.querySelector('.app');
  out.theme = shell ? shell.getAttribute('data-theme') : null;
  out.filtered = /theme--dark/.test((document.querySelector('.excalidraw') || {}).className || '');

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
  const emulator = card.querySelector('.xterm');

  out.card = {
    box: boxOf(card),
    background: getComputedStyle(card).backgroundColor,
    fontSize: Number.parseFloat(getComputedStyle(card).fontSize),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    rowsFontFamily: rows ? getComputedStyle(rows).fontFamily : null,
    rowsFontSize: rows ? Number.parseFloat(getComputedStyle(rows).fontSize) : null,
    rowsColour: rows ? getComputedStyle(rows).color : null,
    rowsText: rows ? (rows.textContent || '') : '',
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
    // Put here by this check before the theme is toggled. An emulator that was disposed and
    // rebuilt is a new node, and a new node has no mark.
    emulatorMark: emulator ? (emulator.dataset.paperCheck || null) : null,
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

/**
 * The board's theme, set the way a reader sets it: through Excalidraw's own appState, which
 * is where its menu puts it and which the app mirrors onto `.app[data-theme]`.
 */
async function useTheme(theme) {
  await evaluate(`window.__paperCheckApi.updateScene({ appState: { theme: ${JSON.stringify(theme)} } })`);
  await waitFor(async () => (await evaluate(PROBE)).theme === theme, `the board to go ${theme}`, 40);
  await sleep(900);
}

/**
 * Two points of the card's own surface, chosen so that nothing is drawn on them.
 *
 * The card is `padding: 0.35em 0.5em 0.4em` and the emulator's host has no horizontal margin
 * of its own, so a half-em strip down each side of the card is the card's background and
 * nothing else — no glyph, no band, no chip. Three pixels in is inside that strip at any font
 * size the block is legible at, and it is inside the block's fill too, which is what makes
 * the same coordinate answerable twice.
 */
const surfacePoints = (card) => [
  { x: card.left + 3, y: card.top + card.height * 0.6 },
  { x: card.right - 3, y: card.top + card.height * 0.6 },
];

/**
 * What the canvas has painted where the block is.
 *
 * The overlay covers the block's bounds exactly — measured, not assumed: the card's box and
 * the shape's viewport bounds are the same rectangle, and the only canvas pixel outside the
 * card's edge is the shape's own two-pixel stroke. So the way to see the fill is to take the
 * overlay away for one frame, which is not a contrivance: `suppressed` does exactly this,
 * with `visibility`, every time the block is dragged or resized — and a block whose fill only
 * matches the card while the card is over it is a block that changes colour as it is dragged.
 */
async function shapeUnder(card) {
  await evaluate(`document.querySelector('.terminal-card').style.visibility = 'hidden'`);
  await sleep(400);
  const middle = await pixelAt(card.left + card.width / 2, card.top + card.height * 0.6);
  const edges = [];
  for (const point of surfacePoints(card)) edges.push(await pixelAt(point.x, point.y));
  await evaluate(`document.querySelector('.terminal-card').style.visibility = ''`);
  await sleep(400);
  return { middle, edges };
}

// ─── The cases, once per theme ────────────────────────────────

/** The block and the overlay are one surface — as painted, not as declared. */
async function surfaceCase(theme, scene) {
  const surface = SURFACE[theme];
  console.log(`\n${theme} 1. the block and the overlay are one surface`);
  check("the shape's fill is the board's own paper, the same literal in both themes",
        same(scene.block.backgroundColor, SURFACE.light),
        `the rectangle is ${scene.block.backgroundColor}, not ${SURFACE.light}`);
  check(`the overlay paints ${surface}`, same(scene.card.background, surface),
        `the card is ${scene.card.background}, not ${surface}`);
  check("and the emulator's own backdrop is that surface too, not the theme it shipped with",
        scene.card.viewport === null || same(scene.card.viewport, surface),
        `the xterm viewport is ${scene.card.viewport}`);

  // The case the old string comparison could not fail. In dark mode the canvas is under
  // `filter: invert(93%) hue-rotate(180deg)` and the overlay is not, so a card and a block
  // that declare the same hex are painted eight stops apart. Same two coordinates, asked
  // twice: once with the overlay over them and once with it out of the way.
  const painted = await shapeUnder(scene.card.box);
  const card = [];
  for (const point of surfacePoints(scene.card.box)) card.push(await pixelAt(point.x, point.y));
  console.log(`     block renders ${hex(painted.middle)}, `
    + `edges ${painted.edges.map(hex).join(' ')} under card ${card.map(hex).join(' ')}, `
    + `declared fill ${scene.block.backgroundColor}`);
  check(`the shape renders as ${surface} once the canvas has been drawn`,
        nearly(painted.middle, surface),
        `the block is painted ${hex(painted.middle)}, not ${surface}`);
  const apart = card.map((pixel, at) => ({ pixel, under: painted.edges[at] }))
    .filter((pair) => !nearly(pair.pixel, pair.under));
  check('so the card and the block under it are one surface on the screen', apart.length === 0,
        apart.map((pair) => `card ${hex(pair.pixel)} over block ${hex(pair.under)}`).join(', '));
}

/** All sixteen, read off the render, against this theme's own surface. */
async function inkCase(theme, scene) {
  const surface = SURFACE[theme];
  console.log(`\n${theme} 3. all sixteen ANSI colours are ink a reader can read`);
  const inks = scene.inks ?? [];
  const worst = [];
  for (let index = 0; index < 16; index++) {
    const ink = inks.find((span) => span.text === `C${index}X`);
    const ratio = ink ? contrast(ink.colour, surface) : null;
    worst.push({ index, colour: ink?.colour ?? null, ratio });
  }
  console.log('     ' + worst.map((ink) => `${ink.index}:${ink.ratio ? ink.ratio.toFixed(1) : '?'}`).join(' '));
  const faint = worst.filter((ink) => !(ink.ratio >= LEGIBLE));
  check(`every one of the sixteen clears ${LEGIBLE}:1 against ${surface}`, faint.length === 0,
        faint.map((ink) => `${ink.index} ${ink.colour} at ${ink.ratio ? ink.ratio.toFixed(2) : 'unreadable'}`).join(', '));
  check('and the default foreground is darker still, since most of the text is that one',
        contrast(scene.card.rowsColour, surface) >= 4.5,
        `${scene.card.rowsColour} at ${(contrast(scene.card.rowsColour, surface) ?? 0).toFixed(2)}`);
}

/** And it still says terminal at a zoom where nothing on it can be read. */
async function bandCase(theme) {
  const surface = SURFACE[theme];
  console.log(`\n${theme} 4. and it still says terminal at a zoom where nothing can be read`);
  const scene = await viewAt(0.15);
  await shot(`${theme}-03-zoomed-out`);
  // 7px rather than the 5 it was, and the number is not a taste: the card's text is the
  // reader's size times `Math.max(0.35, zoom)`, so below zoom 0.35 it stops shrinking and sits
  // at a third of the size they read at. #199 made that size 18, so the floor is 6.3px where it
  // used to be 4.55 — the same illegible strip of grey, a point and a half taller.
  check('the text is past legibility', scene.card.fontSize <= 7, `${scene.card.fontSize}px`);
  check('the block is still on screen to be read', scene.card.box.width > 60,
        `${scene.card.box.width.toFixed(0)}×${scene.card.box.height.toFixed(0)}`);

  // The dark fill used to do this. Whatever took it over has to be an area with a colour of
  // its own — a glyph at four pixels is a smudge, and a rule one pixel high is nothing. And
  // it has to be one in *this* theme: a dark band on a dark card is not a band.
  // It was two bands, top and bottom, until #144 took the bottom one away; the question was
  // always whether *a* band survives being shrunk, and the header is the one that also has a
  // second job — it is what selects and drags the block.
  const bands = [scene.card.header].filter(Boolean).map((band) => ({
    ...band,
    ratio: contrast(band.background, surface),
  }));
  console.log('     ' + bands.map((band) => `${band.background} ${band.width.toFixed(0)}×${band.height.toFixed(1)} at ${band.ratio ? band.ratio.toFixed(1) : '?'}:1`).join('  '));
  const marks = bands.filter((band) => band.ratio >= LEGIBLE
    && band.height >= 2 && band.width >= scene.card.box.width * 0.7);
  check(`a band of its own colour still crosses the block, against ${surface}`, marks.length > 0,
        bands.map((band) => `${band.background} ${band.width.toFixed(0)}×${band.height.toFixed(1)}`).join(', ')
        || 'nothing on the card carries a background');
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

  // Pinned, not inherited. Without this the theme falls through to `prefers-color-scheme`,
  // and a check whose answer depends on the machine's own setting is a check that passes
  // somewhere and fails somewhere else for a reason nobody can see.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('excalidraw-canvas-theme', 'light') } catch (error) { /* no storage */ }`,
  });
  await send('Page.reload', { ignoreCache: false });
  await sleep(500);

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card?.screen, 'the terminal overlay to render');

  // Zoom 1, where a scene unit is a pixel and the advance width can be compared with the
  // number the face is specified in.
  let scene = await viewAt(1);
  check('the board is at zoom 1, where a scene unit is a pixel', scene.view.zoom === 1,
        String(scene.view.zoom));
  check('and it is pinned light rather than left to the machine', scene.theme === 'light',
        `the board is ${scene.theme}`);
  await shot('light-01-paper');

  await surfaceCase('light', scene);

  console.log('\nlight 2. the rows are drawn in the face the blocks use');
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

  // The sixteen are printed once and read twice: the transcript stays on the screen across a
  // theme toggle, and what changes is the colour xterm draws it in.
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await sleep(700);
  await typeText('node colours.js');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => ((await evaluate(PROBE)).inks ?? []).length >= 16, 'the sixteen colours to be drawn');
  scene = await evaluate(PROBE);
  await shot('light-02-ansi');
  await inkCase('light', scene);

  await bandCase('light');

  console.log('\n5. the theme is a repaint, not a rebuild');
  scene = await viewAt(1);
  await evaluate(`document.querySelector('.terminal-card .xterm').dataset.paperCheck = 'one'`);
  const beforeToggle = await evaluate(PROBE);
  await useTheme('dark');
  scene = await evaluate(PROBE);
  check('the canvas is under the dark filter', scene.filtered === true, String(scene.filtered));
  check('the emulator is the same node it was — not disposed and rebuilt',
        scene.card.emulatorMark === 'one', String(scene.card.emulatorMark));
  check('and it repainted: the surface it was opened with is not the one it has now',
        !same(scene.card.viewport, beforeToggle.card.viewport),
        `still ${scene.card.viewport}`);

  await shot('dark-01-paper');
  await surfaceCase('dark', scene);
  await inkCase('dark', scene);
  await bandCase('dark');

  // The one a rebuild really costs, and the reason the theme is pushed into the live
  // emulator rather than the emulator being made again: a program on the alternate screen
  // replayed into a fresh parser comes back as its own scrollback.
  console.log('\n6. a program on the alternate screen survives the toggle');
  scene = await viewAt(1);
  await click(scene.card.body.x, scene.card.body.y);
  await waitFor(async () => /xterm/.test((await evaluate(PROBE)).focused), 'the keyboard to reach the shell');
  await typeText('node alt.js');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => (await evaluate(PROBE)).card.rowsText.includes(ALT_MARK),
                'the alternate screen to be drawn');
  await evaluate(`document.querySelector('.terminal-card .xterm').dataset.paperCheck = 'two'`);
  await useTheme('light');
  scene = await evaluate(PROBE);
  await shot('06-alt-screen');
  check('the emulator survived the toggle', scene.card.emulatorMark === 'two',
        String(scene.card.emulatorMark));
  check('and the program is still on the alternate screen', scene.card.rowsText.includes(ALT_MARK),
        JSON.stringify(scene.card.rowsText.slice(0, 120)));
  check('and the board is light again, with the light surface on the card',
        scene.theme === 'light' && same(scene.card.background, SURFACE.light),
        `${scene.theme} / ${scene.card.background}`);
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
