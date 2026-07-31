#!/usr/bin/env node
/**
 * Checks that the agent transcript's colours are *painted*, and painted legibly, in **both** of
 * the board's themes.
 *
 * `check-agent-stream-render-colour.mjs` asserts the escapes the renderer writes. That is half
 * the question and it is the half compiling can answer. The other half is what a reader sees,
 * and this project has paid for the difference three times: a slot number is not a colour until
 * xterm has resolved it against the theme it was handed, and the whole design of #242 rests on
 * that resolution happening twice — once per palette — from one map. A renderer that wrote
 * `38;2;14;124;134` would pass the source-level check's cousin and print the *light* palette's
 * cyan into a dark card. So the colours are read back off the spans xterm drew, with the board
 * put into each theme in turn, and the two readings are compared against each other.
 *
 * ## What is asserted
 *
 * - **Every authored run is painted**, and painted in something other than the default ink. The
 *   defect was a transcript that was entirely one grey.
 * - **A category is one colour and the categories are different colours** — on the screen, not
 *   in the source. Two tools of a kind read alike, five kinds read apart, and any two of them
 *   are separated by more than a rounding error.
 * - **A failed tool result is red and a finished run is green**, by the dominant channel rather
 *   than by a hex: a reader who could not name the slot still has to see failure as red.
 * - **Every colour clears 3:1 against the card it is on**, which is the floor
 *   `terminal-palette.ts` moved all sixteen to clear and the reason only the sixteen are used.
 * - **The same run is a different colour in the two themes.** This is the case that would have
 *   caught a literal: a hard-coded hex is identical in both, and every other assertion here
 *   would still pass.
 *
 * ## Why the computed style is enough here
 *
 * The terminal overlay is a DOM sibling of Excalidraw and nothing filters it, in either theme —
 * unlike the *shape* underneath, which is on the filtered canvas and needs a screenshot. That
 * distinction is paid for in `check-terminal-paper-browser.mjs`; this check never asks the
 * canvas anything, exactly as `check-terminal-pairs-browser.mjs` does not.
 *
 * The renderer's own bytes, not an imitation of them: the session's command is a stub that
 * imports `dist/core/agent-stream-render.js`, feeds it a real `stream-json` capture and prints
 * what comes back — the same arrangement `check-agent-stream-render-browser.mjs` uses, and for
 * the same reason. In a hosted run that rendering happens inside `TerminalSession.emit`; either
 * way the bytes reaching the emulator are the renderer's.
 *
 * Chrome is driven over the DevTools protocol through `ws`. Self-contained otherwise: it builds
 * a throwaway workspace, starts its own canvas server and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend, so a fix that is only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-agent-stream-render-colour-browser.mjs [--chrome <path>] [--shots <dir>]
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

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What a run of text has to clear against the card it is drawn on. */
const LEGIBLE = 3;
/** How far apart two categories have to be before a reader can be said to tell them apart. */
const SEPARATION = 24;

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

const rendererModule = join(repoRoot, 'dist', 'core', 'agent-stream-render.js');
if (!existsSync(rendererModule)) {
  console.error('  FAIL  the built server exists — dist/core/agent-stream-render.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
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
  if (parts.length > 3 && parts[3] < 0.99) return null;
  return parts.slice(0, 3);
}

const hex = (value) => {
  const parts = channels(value);
  return parts ? `#${parts.map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}` : String(value);
};

const same = (a, b) => {
  const left = channels(a);
  const right = channels(b);
  return Boolean(left && right && left.every((value, at) => value === right[at]));
};

/** The largest single-channel gap between two colours — "can a reader tell these apart". */
function apart(a, b) {
  const left = channels(a);
  const right = channels(b);
  if (!left || !right) return null;
  return Math.max(...left.map((value, at) => Math.abs(value - right[at])));
}

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

/** Which channel a colour is mostly made of — "is this red", asked of a render. */
function dominant(colour) {
  const parts = channels(colour);
  if (!parts) return null;
  const [r, g, b] = parts;
  if (r > g && r > b) return 'red';
  if (g > r && g > b) return 'green';
  if (b > r && b > g) return 'blue';
  return 'grey';
}

// ─── What a real run streams ──────────────────────────────────
//
// One of each category, plus the two shapes that had no colour to differ in at all: a tool
// result carrying `is_error`, and the closing line. Both closing lines are emitted so the two
// can be read off one screen — the renderer treats every `result` event on its own, so a
// transcript with two of them is not a case this is inventing behaviour for.

const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Read'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'PROSE — plain ink' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'INSPECTION' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'GOODRESULT' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep', input: { pattern: 'INSPECTION2' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'MUTATION' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'BADRESULT', is_error: true }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'EXECUTION' } }] } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'NETWORK' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { prompt: 'DELEGATION' } }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode', input: { plan: 'UNCATEGORISED' } }] } },
  { type: 'result', is_error: true, num_turns: 2 },
  { type: 'result', is_error: false, num_turns: 4 },
];

const STREAM = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`;

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-stream-colour-'));
const projectDir = join(workDir, 'colour-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'colour-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Colour Project',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

// The stub the session runs. It stays alive afterwards: a shell that exits is dropped from the
// session map on the spot, and the block would have nothing left to draw.
//
// **The fold marks come off, and that is what keeps this an emulator's question.** Since #246 a
// transcript still carrying them is one the *board* composed, and the block draws such a tab as
// a document of collapsible rows rather than as a screen — there are no `.xterm-rows` in an
// agent tab any more, and a folded row hides the result gutters half of this check is about.
// What is asserted here is the renderer's colour vocabulary as an emulator resolves it, which is
// every other pipe-mode session and the bytes themselves; that the *document* resolves the same
// slots out of the same palette is `scripts/check-agent-transcript-fold.mjs`'s case.
const stubPath = join(workDir, 'stub-agent.mjs');
writeFileSync(stubPath, `#!/usr/bin/env node
import { AgentStreamRenderer, stripFoldMarks } from ${JSON.stringify(pathToFileURL(rendererModule).href)};
process.stdout.write(stripFoldMarks(new AgentStreamRenderer().feed(${JSON.stringify(STREAM)})));
setInterval(() => {}, 60000);
`, 'utf8');

const SESSION_COMMAND = `node "${stubPath.replace(/\\/g, '/')}"`;

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

/** One request, with two more goes at the connection itself. */
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
        window.__colourCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Every drawn run on the screen, with the colour it was drawn in.
 *
 * xterm's DOM renderer emits one span per run of identical attributes, so a line the renderer
 * wrote as two coloured runs arrives as two spans — which is exactly the granularity the map is
 * decided at. A run xterm left on the theme's foreground inherits it, so `getComputedStyle`
 * still answers with a colour rather than with nothing, and "painted" has to be asked as "is it
 * a different colour from the prose", not as "is there a colour at all".
 */
const PROBE = `(() => {
  const out = {};
  const shell = document.querySelector('.app');
  out.theme = shell ? shell.getAttribute('data-theme') : null;

  const api = window.__colourCheckApi;
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.block = { id: element.id, x: element.x, y: element.y };
      }
    }
    const state = api.getAppState();
    out.view = { zoom: state.zoom.value, offsetTop: state.offsetTop };
  }

  const card = document.querySelector('.terminal-card');
  if (!card) { out.card = null; return out; }
  const body = card.querySelector('.terminal-card__body');
  const box = body ? body.getBoundingClientRect() : null;
  out.card = {
    background: getComputedStyle(card).backgroundColor,
    screen: getComputedStyle(card.querySelector('.xterm-screen') || card).backgroundColor,
    body: box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null,
  };
  out.runs = Array.from(card.querySelectorAll('.xterm-rows span')).map((span) => ({
    text: (span.textContent || '').replace(/\\u00a0/g, ' ').trim(),
    colour: getComputedStyle(span).color,
  })).filter((run) => run.text.length > 0);
  return out;
})()`;

/** Put the block on screen at a zoom of this case's choosing. See check-terminal-pairs-browser. */
async function viewAt(zoom, left = 60, top = 120) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__colourCheckApi.updateScene({ appState: { scrollX: ${left / zoom} - ${scene.block.x}, scrollY: (${top} - ${scene.view.offsetTop}) / ${zoom} - ${scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(900);
  return evaluate(PROBE);
}

/** The board's theme, set the way a reader sets it — through Excalidraw's own appState. */
async function useTheme(theme) {
  await evaluate(`window.__colourCheckApi.updateScene({ appState: { theme: ${JSON.stringify(theme)} } })`);
  await waitFor(async () => (await evaluate(PROBE)).theme === theme, `the board to go ${theme}`, 40);
  await sleep(900);
}

/** The colour of the one drawn run carrying a marker, or null if it was never drawn. */
const colourOf = (scene, marker) =>
  (scene.runs ?? []).find((run) => run.text.includes(marker))?.colour ?? null;

/**
 * Open a session running the stub. The command is named in the body rather than typed into a
 * shell, so nothing here is asserting the shell's own echo.
 */
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

// ─── The cases, once per theme ────────────────────────────────

/**
 * The runs this check has an opinion about, found by the words that are in them.
 *
 * A tool call is drawn as **two** runs — the name in its category's colour, the argument in the
 * dim ink — so the name is looked up by the tool's own name and the argument by the word the
 * stub put inside the parens. Looking a category up by its argument is the mistake that would
 * make every one of these read the same, and pass.
 *
 * `⎿` finds the *successful* gutter because it is the first one drawn; the failed result is
 * found by its text, which on a failure is painted with the gutter and therefore arrives as one
 * span.
 */
const MARKERS = {
  prose: 'PROSE',
  inspection: 'Read',
  inspection2: 'Grep',
  mutation: 'Write',
  execution: 'Bash',
  network: 'WebFetch',
  delegation: 'Agent',
  uncategorised: 'ExitPlanMode',
  argument: 'INSPECTION',
  goodGutter: '⎿',
  badResult: 'BADRESULT',
  thinking: 'thinking',
  finished: 'the run finished',
  errored: 'the run reported an error',
};

/** The five hues, which have to be five. */
const CATEGORIES = ['inspection', 'mutation', 'execution', 'network', 'delegation'];

function themeCases(theme, scene) {
  const surface = scene.card.background;
  console.log(`\n${theme} — the card is ${hex(surface)}`);

  const read = Object.fromEntries(Object.entries(MARKERS)
    .map(([name, marker]) => [name, colourOf(scene, marker)]));

  for (const [name, colour] of Object.entries(read)) {
    console.log(`     ${name.padEnd(14)} ${colour ? hex(colour) : '(never drawn)'}`
      + `${colour ? `  ${(contrast(colour, surface) ?? 0).toFixed(2)}:1` : ''}`);
  }

  const missing = Object.entries(read).filter(([, colour]) => !colour).map(([name]) => name);
  check(`${theme} 1. every line the renderer authored was drawn`, missing.length === 0,
        missing.join(', '));
  if (missing.length) return read;

  // The defect itself: before #242 every one of these was the prose colour, because none of
  // them was painted at all.
  const unpainted = CATEGORIES.concat(['badResult', 'finished', 'errored'])
    .filter((name) => same(read[name], read.prose));
  check(`${theme} 2. no authored line is left on the prose ink`, unpainted.length === 0,
        `${unpainted.join(', ')} are all ${hex(read.prose)}`);

  // A category is one colour: two inspection tools, drawn twice, read the same.
  check(`${theme} 3. two tools of one kind are drawn in one colour`,
        same(read.inspection, read.inspection2),
        `Read is ${hex(read.inspection)}, Grep is ${hex(read.inspection2)}`);

  // And the kinds are apart, by more than a rounding error.
  const tooClose = [];
  for (let left = 0; left < CATEGORIES.length; left++) {
    for (let right = left + 1; right < CATEGORIES.length; right++) {
      const gap = apart(read[CATEGORIES[left]], read[CATEGORIES[right]]);
      if (!(gap >= SEPARATION)) tooClose.push(`${CATEGORIES[left]}/${CATEGORIES[right]} ${gap}`);
    }
  }
  check(`${theme} 4. the five kinds are told apart on the screen, by at least ${SEPARATION} in a channel`,
        tooClose.length === 0, tooClose.join(', '));

  // Uncategorised is the ink, deliberately: colour is added information and there is none here.
  check(`${theme} 5. a tool in no category is drawn in the prose ink rather than a sixth hue`,
        same(read.uncategorised, read.prose),
        `${hex(read.uncategorised)} against prose ${hex(read.prose)}`);

  // The argument steps back, so a column of tool calls reads as a column of verbs.
  check(`${theme} 5b. the argument inside the parens is dimmer than the name it follows`,
        !same(read.argument, read.inspection)
        && (contrast(read.argument, surface) ?? 0) < (contrast(read.prose, surface) ?? 0),
        `argument ${hex(read.argument)} at ${(contrast(read.argument, surface) ?? 0).toFixed(2)}:1, `
        + `name ${hex(read.inspection)}, prose ${hex(read.prose)}`);

  // `is_error`, which was dropped on the way through.
  check(`${theme} 6. a failed tool result does not look like one that worked`,
        !same(read.badResult, read.goodGutter),
        `both are ${hex(read.goodGutter)}`);
  check(`${theme} 7. and it is red to a reader who cannot name the slot`,
        dominant(read.badResult) === 'red', `${hex(read.badResult)} is mostly ${dominant(read.badResult)}`);

  // The closing line, which differed only in its wording.
  check(`${theme} 8. the closing line is green when the run finished`,
        dominant(read.finished) === 'green', `${hex(read.finished)} is mostly ${dominant(read.finished)}`);
  check(`${theme} 9. and red when it did not`,
        dominant(read.errored) === 'red', `${hex(read.errored)} is mostly ${dominant(read.errored)}`);

  // The payoff of using only the sixteen: every one of them was moved until it cleared this.
  const faint = Object.entries(read)
    .map(([name, colour]) => [name, contrast(colour, surface)])
    .filter(([, ratio]) => !(ratio >= LEGIBLE));
  check(`${theme} 10. every colour on the card clears ${LEGIBLE}:1 against it`, faint.length === 0,
        faint.map(([name, ratio]) => `${name} at ${(ratio ?? 0).toFixed(2)}`).join(', '));

  return read;
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
  await waitFor(async () => (await evaluate(PROBE)).card, 'the terminal overlay to render');
  const drawnEverything = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return (probed.runs ?? []).some((run) => run.text.includes('the run finished')) ? probed : null;
  }, 'the block to draw the whole transcript');

  console.log(`the session is on ${session.mode}, which is the mode an agent tab runs in`);
  check('0. the board is pinned light rather than left to the machine',
        drawnEverything.theme === 'light', `the board is ${drawnEverything.theme}`);

  await shot('01-light');
  const light = themeCases('light', drawnEverything);

  await useTheme('dark');
  const darkScene = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return (probed.runs ?? []).some((run) => run.text.includes('the run finished')) ? probed : null;
  }, 'the block to redraw after dark');
  await shot('02-dark');
  const dark = themeCases('dark', darkScene);

  // The case a literal would fail and nothing else here would. A slot is resolved by the
  // palette the reader is in; a `38;2;r;g;b` is the same three numbers in both cards.
  console.log('\nthe same transcript, read twice');
  const unchanged = Object.keys(MARKERS)
    .filter((name) => light[name] && dark[name] && same(light[name], dark[name]));
  console.log('     ' + Object.keys(MARKERS)
    .map((name) => `${name} ${hex(light[name])}→${hex(dark[name])}`).join('\n     '));
  check('every run changed colour with the theme, so the slot was resolved and not printed',
        unchanged.length === 0,
        `${unchanged.join(', ')} came out the same hex in both themes`);
  check('and the card itself moved with it',
        !same(drawnEverything.card.background, darkScene.card.background),
        `${hex(drawnEverything.card.background)} in both`);

  // And the same transcript at a zoom somebody reads a whole board at. The overlay is scaled by
  // a transform rather than re-drawn, so this cannot come out differently — which is the point:
  // `CLAUDE.md` asks for the zoomed-out look, and a claim nobody measured is a claim.
  console.log('\nzoomed out');
  const zoomed = await viewAt(0.4);
  await shot('03-dark-zoomed');
  const drifted = Object.entries(MARKERS)
    .filter(([name, marker]) => dark[name] && !same(colourOf(zoomed, marker), dark[name]));
  check('every colour is the one it was at zoom 1', drifted.length === 0,
        drifted.map(([name, marker]) => `${name} is ${hex(colourOf(zoomed, marker))}`).join(', '));
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
