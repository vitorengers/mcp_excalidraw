#!/usr/bin/env node
/**
 * Checks that the `✻ thinking…` row is really drawn in the agent's orange, in **both** themes,
 * and that the agent's prose really has a blank line either side of it — on a real Chrome,
 * against real pixels.
 *
 * #258 asked for two things a compiler cannot answer. A colour written into a transcript is a
 * *name* until something resolves it: the seventeenth ink has no SGR number, it rides the fold
 * view's private OSC, and the frontend is what turns the name into a hex out of the palette for
 * the theme the reader is in. Every step of that chain compiles whether or not one pixel comes
 * out orange. And a blank line is a `<div>` that either exists or does not.
 *
 * ## What is asserted
 *
 * - **The computed colour of the marker is that theme's hex**, read out of `terminal-palette.ts`
 *   rather than retyped, and it is a *different* hex in the two themes — the case a literal
 *   would fail and nothing else here would.
 * - **The rendered pixels**, which is the case `CLAUDE.md` names: the row is screenshotted and
 *   the most-inked pixel in it is compared against all seventeen inks of that theme plus the
 *   surface. The nearest has to be the agent's ink. `getComputedStyle` answers what the DOM was
 *   told; this answers what was drawn.
 * - **It is no longer the ink of a file path.** The defect was `brightBlack`, which is also the
 *   argument inside the parens on the row above — so the marker's colour is asserted to differ
 *   from that row's argument, which is the comparison the screenshot on the issue is about.
 * - **3:1 against the card it is on**, in both themes, which is the floor every other ink on this
 *   surface was moved to clear.
 * - **A blank line above the prose and one below it**, counted as drawn rows, and never two.
 *
 * The overlay is a DOM sibling of Excalidraw and nothing filters it — the *shape* underneath is
 * on the filtered canvas and that is `check-terminal-paper-browser.mjs`'s problem, not this
 * one — so the computed style and the pixels agree here by construction. They are both read
 * anyway, because "the pixels agree by construction" is exactly the kind of claim that stops
 * being true without anybody noticing.
 *
 * Self-contained: a throwaway workspace, its own canvas server on a free port, Chrome over the
 * DevTools protocol through `ws`, all killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-agent-transcript-ink-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a run of text has to clear against the card it is drawn on. */
const LEGIBLE = 3;

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const paletteModule = join(repoRoot, 'dist', 'core', 'terminal-palette.js');
if (!existsSync(paletteModule)) {
  console.error('  FAIL  the built server exists — dist/core/terminal-palette.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const palette = await import(pathToFileURL(paletteModule).href);

/**
 * The ink this check is about, or a hole where it should be.
 *
 * A hole rather than an exit: the spacing half of #258 does not depend on the palette at all,
 * and a check that dies on its first import shows one line about its own harness instead of
 * everything it could have measured.
 */
const AGENT_INK = palette.DOCUMENT_INKS?.agent ?? { light: null, dark: null };
const inkTable = (theme) =>
  (typeof palette.terminalDocumentInk === 'function' ? palette.terminalDocumentInk(theme) : {});

// ─── Colour, as the browser hands it back ─────────────────────

/** `rgb(217, 119, 87)` or `#d97757` → `[217, 119, 87]`, and anything else to null. */
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
  if (parts.length > 3 && parts[3] < 0.99) return null;
  return parts.slice(0, 3);
}

const hex = (value) => {
  const parts = Array.isArray(value) ? value : channels(value);
  return parts ? `#${parts.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}` : String(value);
};

const same = (a, b) => {
  const left = channels(a);
  const right = channels(b);
  return Boolean(left && right && left.every((value, at) => value === right[at]));
};

/** How far apart two colours are, as a straight line through the cube. */
function distance(a, b) {
  const left = Array.isArray(a) ? a : channels(a);
  const right = Array.isArray(b) ? b : channels(b);
  if (!left || !right) return Infinity;
  return Math.hypot(...left.map((value, at) => value - right[at]));
}

/** WCAG relative luminance, so "legible" is a number rather than an opinion. */
function luminance(colour) {
  const parts = Array.isArray(colour) ? colour : channels(colour);
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

/**
 * Enough of a PNG decoder to read a clipped screenshot back.
 *
 * The same one `check-terminal-paper-browser.mjs` uses, and for a related reason: what the DOM
 * says a colour is and what came out of the compositor are two claims, and only one of them is
 * what a reader sees. Eight-bit, colour type 2 or 6, which is all Chrome emits.
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
  return {
    width: header.width,
    height: header.height,
    at(x, y) {
      const base = y * stride + x * lanes;
      return [out[base], out[base + 1], out[base + 2]];
    },
  };
}

// ─── What a run streams ───────────────────────────────────────
//
// A tool call so that the dim ink of an argument is on the screen to compare the marker with,
// prose between two tool calls so the blank lines have something to be between, and the thinking
// block itself. The shapes are the ones the other checks in this family took off a real capture.

const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Read'] },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'ARGUMENTINK' } }] },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'the file' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'PROSE-WITH-ROUND-IT' }] } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'npm test' } }] },
  },
  { type: 'result', is_error: false, num_turns: 3 },
];

const STREAM = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`;

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-transcript-ink-'));
const projectDir = join(workDir, 'ink-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'ink-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Ink Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

// The stub prints the **raw** stream and the server renders it, because the command carries
// `--output-format stream-json` — the real path rather than an imitation of it. It stays alive
// afterwards: a shell that exits is dropped from the session map and the block would have
// nothing left to draw.
const stubPath = join(workDir, 'stub-agent.mjs');
writeFileSync(stubPath, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(STREAM)});
setInterval(() => {}, 60000);
`, 'utf8');

const SESSION_COMMAND = `node "${stubPath.replace(/\\/g, '/')}" --output-format stream-json`;

const PORT = 37600 + (process.pid % 180);
const CDP_PORT = PORT + 200;
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
    // Pipes, so the stub's output is the transcript and nothing echoes a prompt into it.
    EXCALIDRAW_TERMINAL_PTY: '0',
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
  throw new Error(`timed out waiting for ${what}\n${serverLog.slice(-1200)}`);
}

async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}) =>
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
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

/**
 * A run's own rectangle, cut down to the line it is on.
 *
 * An inline box is taller than the line box it sits in — the font's own ascent and descent,
 * which here is 31 pixels of span inside 18 pixels of row — so a span sampled as it comes off
 * so a span sampled as `getBoundingClientRect` hands it over reaches into the row below and picks
 * up that row's colour. That is how this check first read the `Bash` line's green while the
 * marker beside it was already orange, which is a false failure and would as easily have been a
 * false pass.
 */
function clamped(box, bounds) {
  const top = Math.max(box.top, bounds.top);
  const bottom = Math.min(box.top + box.height, bounds.top + bounds.height);
  return { left: box.left, top, width: box.width, height: Math.max(1, bottom - top) };
}

/**
 * The whole screen as pixels, once.
 *
 * The whole screen rather than a clipped rectangle per row, and that is not an optimisation: a
 * `clip` makes Chrome capture beyond the viewport, which relays the page out — and this page
 * positions the overlay from the canvas' own scroll state, so the block moves while the picture
 * is being taken and a row's box no longer names that row. Read at the first attempt as the
 * *next* row's colour, which is a false pass away from being a false failure.
 */
async function frame() {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  return decodePng(Buffer.from(data, 'base64'));
}

/**
 * The most-inked pixel of a rectangle, which for a row of text is the middle of a glyph.
 *
 * A glyph is antialiased, so the box is mostly surface and the edges of every stroke are blends
 * of the two. The pixel furthest from the surface is the one the stroke really is, and it is the
 * only pixel in the box worth asking about.
 */
function inkIn(picture, box, surface, scale = 1) {
  const left = Math.max(0, Math.floor(box.left * scale));
  const top = Math.max(0, Math.floor(box.top * scale));
  const right = Math.min(picture.width, Math.ceil((box.left + box.width) * scale));
  const bottom = Math.min(picture.height, Math.ceil((box.top + box.height) * scale));
  let best = null;
  let furthest = -1;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const pixel = picture.at(x, y);
      const away = distance(pixel, surface);
      if (away > furthest) { furthest = away; best = pixel; }
    }
  }
  return best;
}

/** The imperative Excalidraw API, through the container's React fibre. See check-terminal-browser. */
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
        window.__inkCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The document the block is drawing, row by row, with a box for anything worth photographing.
 *
 * Rows rather than runs: this view is `<div>` per line and `<span>` per colour, so the blank
 * lines #258 asked for are rows with nothing in them and can be counted, which is what a claim
 * about spacing has to be asked of once it has left the transcript.
 */
const PROBE = `(() => {
  const out = {};
  const shell = document.querySelector('.app');
  out.viewport = { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio };
  out.theme = shell ? shell.getAttribute('data-theme') : null;

  const card = document.querySelector('.terminal-card');
  if (!card) { out.card = null; return out; }
  out.card = { background: getComputedStyle(card).backgroundColor };

  const transcript = card.querySelector('.terminal-transcript:not([style*="hidden"])');
  out.hasEmulator = Boolean(card.querySelector('.xterm-rows'));
  if (!transcript) { out.rows = null; return out; }

  const boxOf = (node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  };
  out.rows = [...transcript.children].map((row) => {
    const spans = [...row.querySelectorAll('span')];
    const head = row.querySelector('.terminal-transcript__head');
    const text = (row.textContent || '').replace(/\\u00a0/g, ' ');
    return {
      kind: row.classList.contains('terminal-transcript__fold') ? 'fold' : 'line',
      text,
      blank: text.trim() === '',
      box: boxOf(row),
      runs: (head ? [...head.querySelectorAll('span')] : spans).map((span) => ({
        text: (span.textContent || '').replace(/\\u00a0/g, ' '),
        colour: getComputedStyle(span).color,
        box: boxOf(span),
      })),
    };
  });
  return out;
})()`;

/** The board's theme, set the way a reader sets it — through Excalidraw's own appState. */
async function useTheme(theme) {
  await evaluate(`window.__inkCheckApi.updateScene({ appState: { theme: ${JSON.stringify(theme)} } })`);
  await waitFor(async () => (await evaluate(PROBE)).theme === theme, `the board to go ${theme}`, 40);
  await sleep(700);
}

async function openSession() {
  const response = await api('/api/terminal', {
    method: 'POST',
    body: JSON.stringify({ command: SESSION_COMMAND }),
  });
  if (response.status !== 202) {
    throw new Error(`POST /api/terminal answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).session;
}

/** The one run carrying a marker, wherever in the document it is. */
const runWith = (scene, marker) => (scene.rows ?? [])
  .flatMap((row) => row.runs.map((run) => ({ ...run, row })))
  .find((run) => run.text.includes(marker)) ?? null;

const THINKING = '✻ thinking';

async function themeCases(theme, scene, picture) {
  const surface = scene.card.background;
  const inks = inkTable(theme);
  console.log(`\n${theme} — the card is ${hex(surface)}, and the agent's ink is ${AGENT_INK[theme]}`);

  const marker = runWith(scene, THINKING);
  const argument = runWith(scene, 'ARGUMENTINK');
  check(`${theme} 1. the thinking marker is on the screen`, Boolean(marker),
    JSON.stringify((scene.rows ?? []).map((row) => row.text)));
  check(`${theme} 1b. and so is a tool call, whose argument is the ink the marker used to share`,
    Boolean(argument), 'nothing carrying the argument was drawn');
  if (!marker || !argument) return null;

  console.log(`     computed ${hex(marker.colour)}, against the argument's ${hex(argument.colour)}`);
  check(`${theme} 2. it is painted this theme's agent ink, resolved out of the palette`,
    same(marker.colour, AGENT_INK[theme]),
    `${hex(marker.colour)} — expected ${AGENT_INK[theme]}`);
  check(`${theme} 3. rather than the dim ink of a file path, which is what it was`,
    !same(marker.colour, argument.colour) && !same(marker.colour, inks.brightBlack),
    `${hex(marker.colour)} is the argument's own ink`);

  const ratio = contrast(marker.colour, surface) ?? 0;
  console.log(`     ${ratio.toFixed(2)}:1 against the card`);
  check(`${theme} 4. and it clears ${LEGIBLE}:1 against the card it is drawn on`, ratio >= LEGIBLE,
    `${ratio.toFixed(2)}:1`);

  // The pixels. Everything above is what the DOM was told; this is what came out of it.
  // The screenshot is in device pixels and a box is in CSS pixels, and on a machine whose
  // display is scaled those are not the same number. Read off the picture rather than
  // assumed: a factor of 1.25 puts every sample one row down, which reads as the *next*
  // line's colour and is how this check first failed against a correct render.
  const scale = picture.width / (scene.viewport?.width || picture.width);
  const drawn = inkIn(picture, clamped(marker.box, marker.row.box), channels(surface), scale);
  console.log(`     the picture is ${picture.width}px wide for a ${scene.viewport?.width}px viewport, so ${scale}x`);
  const candidates = Object.entries({ ...inks, surface }).map(([name, value]) => ({
    name, away: distance(drawn, value),
  })).sort((a, b) => a.away - b.away);
  console.log(`     the most-inked pixel of the row is ${hex(drawn)}, nearest `
    + candidates.slice(0, 3).map((one) => `${one.name} (${one.away.toFixed(0)})`).join(', '));
  check(`${theme} 5. the pixels of the row are that orange and not something the DOM only claims`,
    candidates[0]?.name === 'agent',
    `nearest ink to ${hex(drawn)} is ${candidates[0]?.name} at ${candidates[0]?.away.toFixed(0)}`);

  return { colour: marker.colour, drawn };
}

/** The blank lines, counted as rows of the drawn document rather than as bytes. */
function spacingCases(scene) {
  const rows = scene.rows ?? [];
  const at = rows.findIndex((row) => row.text.includes('PROSE-WITH-ROUND-IT'));
  const shape = rows.map((row) => (row.blank ? '(blank)' : row.text.trim().slice(0, 28)));
  console.log(`     the document is ${JSON.stringify(shape)}`);

  check('the prose is a row of its own', at >= 0, JSON.stringify(shape));
  if (at < 0) return;
  check('with a drawn blank line above it', at > 0 && rows[at - 1].blank, JSON.stringify(shape));
  check('and a drawn blank line below it', Boolean(rows[at + 1]?.blank), JSON.stringify(shape));
  check('and never two of either, which is what a gap that grows looks like',
    !(rows[at - 2]?.blank) && !(rows[at + 2]?.blank), JSON.stringify(shape));
  check('the tool calls are still rows that fold',
    rows.filter((row) => row.kind === 'fold').length === 2,
    `${rows.filter((row) => row.kind === 'fold').length} folds`);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  const session = await openSession();

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

  // Pinned, not inherited: a check whose answer depends on the machine's own colour scheme
  // passes somewhere and fails somewhere else for a reason nobody can see.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('excalidraw-canvas-theme', 'light') } catch (error) { /* no storage */ }`,
  });
  await send('Page.reload', { ignoreCache: false });
  await sleep(500);

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const light = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return (probed.rows ?? []).some((row) => row.text.includes('the run finished')) ? probed : null;
  }, 'the block to draw the whole transcript as a document');

  console.log(`the session is on ${session.mode}, and the tab is a document rather than a screen`);
  check('0. the board is pinned light rather than left to the machine',
    light.theme === 'light', `the board is ${light.theme}`);
  check('0b. and the transcript is the fold view, which is the only one with this ink',
    Boolean(light.rows) && !light.hasEmulator,
    'the tab is still an emulator, so nothing here is being asked of the right view');
  check('0c. and the palette declares the ink all of this is about',
    Boolean(AGENT_INK.light && AGENT_INK.dark),
    'terminal-palette.ts exports no DOCUMENT_INKS.agent, so there is no hex to hold a render to');

  await shot('01-light');

  console.log('\nthe room the prose was asked for, counted as drawn rows');
  spacingCases(light);

  const lightInk = await themeCases('light', light, await frame());

  await useTheme('dark');
  const dark = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return (probed.rows ?? []).some((row) => row.text.includes('the run finished')) ? probed : null;
  }, 'the block to redraw after dark');
  await shot('02-dark');
  const darkInk = await themeCases('dark', dark, await frame());

  // The case a literal would fail and nothing else here would.
  console.log('\nthe same marker, read twice');
  if (lightInk && darkInk) {
    check('the marker is a different colour in the two themes, so a name was resolved twice',
      !same(lightInk.colour, darkInk.colour),
      `${hex(lightInk.colour)} in both — a hex was printed into the transcript rather than a name`);
    check('and the pixels moved with it',
      distance(lightInk.drawn, darkInk.drawn) > 8,
      `${hex(lightInk.drawn)} and ${hex(darkInk.drawn)}`);
    check('and the card itself moved too, so this is a real toggle',
      !same(light.card.background, dark.card.background),
      `${hex(light.card.background)} in both`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  the check ran to the end — ${error.message}`);
  if (serverLog.trim()) console.error(serverLog.trim().split('\n').slice(-12).join('\n'));
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds handles */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

console.log(failures === 0 ? '\nall cases passed' : `\n${failures} case(s) failed`);
if (failures > 0 && !argOf('--shots')) {
  console.log('Pass --shots <dir> to keep the screenshots of what was actually drawn.');
}
process.exit(failures === 0 ? 0 : 1);
