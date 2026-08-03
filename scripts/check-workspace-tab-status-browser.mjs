#!/usr/bin/env node
/**
 * Checks that a tab says what is wrong with its project to a reader who cannot see it, and that
 * there is room on it for two independent states at once.
 *
 * #515. Two things, and the second is why the first is worth landing on its own.
 *
 * **The defect.** A project whose config failed to resolve is marked with a bare `!` glyph
 * carrying `aria-hidden="true"`, underlined dotted, and the meaning lives only in the tab's
 * three-line `title`. A tooltip is a hover, so a keyboard user never reaches it, and a screen
 * reader is told outright to skip the only mark on the screen that says this project is broken.
 * The accessible name of that marker is the empty string.
 *
 * **The slot.** The agreed liveness indicator has to sit on the same row, and it cannot be
 * folded into `Workspace.error`: `error` is a config-resolution failure that gates real
 * behaviour — an implement run refuses outright on it — so a laptop that happens to be asleep
 * written into that field would make projects that have nothing to do with it start refusing
 * runs. Two independent states, rendered independently, and this check is what holds them apart.
 *
 * ## What is asserted
 *
 * - **What each marker is worth to a reader who cannot see it**, computed by Chrome itself over
 *   `Accessibility.getPartialAXTree` rather than guessed from the DOM. Two readings, because
 *   a mark on a tab is not a named thing in its own right: a plain `<span>` is a generic
 *   container that Chrome ignores as `uninteresting`, and its text is folded into the name of
 *   the `role="tab"` button it sits inside. So the assertions are that no mark is taken out of
 *   the tree — `ariaHiddenElement` is the reason Chrome gives, and the reason the old code
 *   fails — and that the sentence each mark stands for is *in the name the tab is read by*.
 *   Before the fix that name is the project's name and nothing else.
 * - **A workspace carrying no status renders what it renders today** — no status element at
 *   all, the row still badge-then-name-then-marker, named child by child.
 * - **Each of the four states carries a readable text label**, not a colour and not an
 *   `aria-label` on a glyph, and the label is not `aria-hidden`.
 * - **Both at once**: a tab whose project is both broken *and* unreachable shows both marks,
 *   in boxes that do not overlap, with two different accessible names.
 * - **Rendered pixels, in both themes.** Every colour on this strip resolves through
 *   Excalidraw's own theme tokens and is only settled at paint; a `getComputedStyle`
 *   comparison would agree with itself in one theme and say nothing about the other. The read
 *   is clamped to the badge's **own** box rather than the row's, because an inline box carries
 *   the font's full ascent and descent and reaches into whatever is drawn under it.
 *
 * ## How the status gets there
 *
 * This issue supplies no data — nothing on the server sets the field yet. So the check wraps
 * `window.fetch` and rewrites the one `/api/workspaces` answer on its way past, which is the
 * shape the real supplier will have. It is installed with
 * `Page.addScriptToEvaluateOnNewDocument` **before** `Page.navigate`: the strip is drawn from
 * that one response, and a wrapper installed after the load would arrive to find it already on
 * screen. The table is re-registered between rounds and the page navigated again, so four
 * states are driven through two projects.
 *
 * Self-contained: two throwaway projects — one healthy, one whose `board.config.json` is not
 * JSON — its own canvas server on a free port, Chrome over the DevTools protocol through `ws`,
 * all killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-workspace-tab-status-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

// ─── Colour, as it came out of the compositor ─────────────────

/** `rgb(217, 119, 87)` or `#d97757` → `[217, 119, 87]`, and anything else to null. */
function channels(value) {
  const text = String(value ?? '').trim();
  const hex = text.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((at) => parseInt(hex[1].slice(at, at + 2), 16));
  const parts = text.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return parts.slice(0, 3).map((part) => Math.round(Number(part)));
}

const distance = (a, b) => {
  if (!a || !b) return null;
  return Math.sqrt(a.reduce((sum, value, at) => sum + (value - b[at]) ** 2, 0));
};

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

/** What a small bold label has to clear against the pill it is printed on. */
const LEGIBLE = 3;

/** How far apart two fills have to be before "these are different colours" is a measurement. */
const APART = 24;

/**
 * Enough of a PNG decoder to read a screenshot back. The same one
 * `scripts/check-agent-transcript-ink-browser.mjs` and `check-terminal-paper-browser.mjs` use,
 * and for the same reason: what the DOM was told a colour is and what was painted are two
 * claims, and only one of them is what a reader sees. Eight-bit, colour type 2 or 6, which is
 * all Chrome emits.
 */
function decodePng(buffer) {
  let at = 8;
  let header = null;
  const parts = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    }
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

/**
 * A marker's own rectangle, cut down so nothing outside the mark is sampled.
 *
 * An inline box is taller than the line box it sits in — the font's full ascent and descent —
 * so a span sampled exactly as `getBoundingClientRect` hands it over reaches past its own
 * background and into whatever is painted behind the row. A badge is a painted pill and the
 * pixels that matter are the ones inside it, so the read is the intersection of the two, inset
 * by a pixel on every side to keep the antialiased rim out of it.
 */
function inside(box, bounds, inset = 1) {
  const left = Math.max(box.left, bounds.left) + inset;
  const top = Math.max(box.top, bounds.top) + inset;
  const right = Math.min(box.left + box.width, bounds.left + bounds.width) - inset;
  const bottom = Math.min(box.top + box.height, bounds.top + bounds.height) - inset;
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Every pixel of a rectangle, in device coordinates, clipped to the picture. */
function* pixels(picture, box, scale) {
  const left = Math.max(0, Math.floor(box.left * scale));
  const top = Math.max(0, Math.floor(box.top * scale));
  const right = Math.min(picture.width, Math.ceil((box.left + box.width) * scale));
  const bottom = Math.min(picture.height, Math.ceil((box.top + box.height) * scale));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) yield picture.at(x, y);
  }
}

/** The pixel furthest from `surface` — for a row of text, the middle of a stroke. */
function inkIn(picture, box, surface, scale = 1) {
  let best = null;
  let furthest = -1;
  for (const pixel of pixels(picture, box, scale)) {
    const away = distance(pixel, surface);
    if (away > furthest) { furthest = away; best = pixel; }
  }
  return best;
}

/**
 * The commonest pixel of a rectangle, which for a painted pill is its fill.
 *
 * The mode rather than a named corner: the padding round a label is a few pixels either side
 * and a corner sample is one rounded-off pixel away from being the page behind the badge.
 */
function fillIn(picture, box, scale = 1) {
  const seen = new Map();
  for (const pixel of pixels(picture, box, scale)) {
    const key = pixel.join(',');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let best = null;
  let most = -1;
  for (const [key, count] of seen) {
    if (count > most) { most = count; best = key.split(',').map(Number); }
  }
  return best;
}

// ─── Two projects, one of them with a config nobody can read ──

const workDir = mkdtempSync(join(tmpdir(), 'check-tab-status-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const slash = (value) => value.replace(/\\/g, '/');

/**
 * Short ids and short names, and that is a measurement rather than a taste.
 *
 * The strip runs at `--workspace-tab-scale: 2.5`, so a tab is about two and a half times the
 * size it reads as in the stylesheet, and it scrolls sideways rather than wrapping. Two long
 * names with a `Unreachable` pill on each would put the second tab off the right-hand edge —
 * where every box this check measures is still a perfectly good rectangle, describing a
 * region of the screen the tab is not on.
 */
const HEALTHY = 'alpha';
const BROKEN = 'beta';
/** A project whose config cannot be parsed keeps its id as its name, which is the fallback. */
const LABEL = { [HEALTHY]: 'Alpha', [BROKEN]: BROKEN };

for (const id of [HEALTHY, BROKEN]) mkdirSync(join(workDir, id), { recursive: true });
writeFileSync(join(workDir, HEALTHY, 'board.config.json'), JSON.stringify({
  name: LABEL[HEALTHY],
}, null, 1), 'utf8');
// Not JSON at all, which is what puts a reason into `Workspace.error` without inventing one:
// the loader reports `Invalid board.config.json: …` and the project is still listed.
writeFileSync(join(workDir, BROKEN, 'board.config.json'), '{ this is not JSON', 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: HEALTHY, path: slash(join(workDir, HEALTHY)) },
    { id: BROKEN, path: slash(join(workDir, BROKEN)) },
  ],
}, null, 1), 'utf8');

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
  const buffer = Buffer.from(data, 'base64');
  writeFileSync(join(shotDir, `${name}.png`), buffer);
  return decodePng(buffer);
}

/**
 * What the accessibility tree says about one element, asked of the browser rather than guessed.
 *
 * Two answers, and they are answers to two different questions.
 *
 * `name` is the accessible name Chrome computed, with all dozen-odd steps of the algorithm run.
 * It is only interesting on an element that has one: a plain `<span>` is a *generic container*
 * and Chrome ignores it as `uninteresting` whatever text it holds — which is not a defect, it
 * is how the text inside it comes to belong to the control the span is part of. So the name
 * that matters for a mark on a tab is the **tab's**, and that is what `announcedFor` reads.
 *
 * `reasons` is where the defect is visible. `aria-hidden="true"` does not merely suppress a
 * name — it takes the element and everything under it out of the tree, and Chrome says so by
 * name: `ariaHiddenElement`. That is the difference between a span nobody needed to hear about
 * and a sentence deliberately kept from a reader.
 */
async function axOf(selector) {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) return null;
  const { node } = await send('DOM.describeNode', { nodeId });
  const { nodes } = await send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
  const found = nodes.find((entry) => entry.backendDOMNodeId === node.backendNodeId) ?? nodes[0];
  if (!found) return null;
  return {
    name: found.name?.value ?? '',
    ignored: Boolean(found.ignored),
    reasons: (found.ignoredReasons ?? []).map((reason) => reason.name),
  };
}

/** True when this element, or the subtree it is in, was hidden from an assistive technology. */
const hiddenFromReaders = (ax) => !ax
  || ax.reasons.includes('ariaHiddenElement')
  || ax.reasons.includes('ariaHiddenSubtree');

/**
 * The one answer the whole strip is drawn from, rewritten on its way past.
 *
 * `/api/workspaces` is read once, at mount, and its result is what `WorkspaceTabs` renders. So
 * the status field is attached here rather than by a route that does not exist yet: the page
 * receives exactly the payload a later position will send it, and nothing in the component
 * knows it was not the server that said so.
 *
 * The match is anchored so that `/api/workspaces/order` — a write, sent by a drag — is not
 * caught by it and handed back a JSON body it never had.
 */
const instrumentFor = (table) => `(() => {
  const status = ${JSON.stringify(table)};
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const answer = realFetch.apply(this, arguments);
    if (!/\\/api\\/workspaces(\\?|$)/.test(url)) return answer;
    return answer.then((response) => response.clone().json().then((body) => {
      if (body && Array.isArray(body.workspaces)) {
        body.workspaces = body.workspaces.map((workspace) => (status[workspace.id]
          ? Object.assign({}, workspace, { status: status[workspace.id] })
          : workspace));
      }
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      });
    }).catch(() => response));
  };
  return true;
})()`;

/** The imperative Excalidraw API, through the container's React fibre. */
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
        window.__tabStatusApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** Put the whole board in one theme — the strip follows the canvas through `.app[data-theme]`. */
const setTheme = (theme) => evaluate(`(() => {
  window.__tabStatusApi.updateScene({ appState: { theme: ${JSON.stringify(theme)} } });
  return true;
})()`);

const themeNow = () => evaluate(`((document.querySelector('.app') || {}).dataset || {}).theme || null`);

/**
 * Every box this check measures, in one round trip and in CSS pixels.
 *
 * The row is carried alongside each marker because a marker is clamped to it before any pixel
 * is read, and the viewport is carried because a screenshot is in device pixels while a
 * `getBoundingClientRect` is not.
 */
const MEASURE = `(() => {
  const box = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  };
  const tabs = [...document.querySelectorAll('.workspace-tab')].map((tab) => {
    const select = tab.querySelector('.workspace-tab__select');
    const statusMark = tab.querySelector('.workspace-tab__status');
    const warn = tab.querySelector('.workspace-tab__warn');
    return {
      name: ((tab.querySelector('.workspace-tab__name') || {}).textContent || '').trim(),
      broken: tab.classList.contains('workspace-tab--broken'),
      title: tab.getAttribute('title'),
      rowBox: box(select),
      status: statusMark ? {
        text: statusMark.textContent,
        className: statusMark.className,
        hidden: statusMark.getAttribute('aria-hidden'),
        box: box(statusMark),
      } : null,
      warn: warn ? {
        text: warn.textContent,
        hidden: warn.getAttribute('aria-hidden'),
        box: box(warn),
      } : null,
      // What the row is made of, in order, so "renders what it renders today" is a shape and
      // not an impression: today it is an optional WSL badge, the name, and an optional marker.
      parts: [...select.children].map((child) => child.className),
    };
  });
  return {
    tabs,
    viewport: { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio },
  };
})()`;

/** The tab whose project this is, by the name its config gives it. */
const tabOf = (scene, id) => scene.tabs.find((tab) => tab.name === LABEL[id]);

/**
 * The sentence a screen reader reads out when it reaches this project's tab.
 *
 * The `role="tab"` button is the named thing on the row — a mark inside it is a generic span,
 * and its text becomes part of *this* name rather than a name of its own. So this is the one
 * string that answers "what is a reader who cannot see the strip actually told", and against
 * the code before the fix it is the project's name and nothing else.
 */
const announcedFor = (scene, id) => {
  const at = scene.tabs.findIndex((tab) => tab.name === LABEL[id]);
  if (at < 0) return Promise.resolve(null);
  return axOf(`.workspace-tabs > div:nth-of-type(${at + 1}) .workspace-tab__select`);
};

/** Is this rectangle somewhere a reader could actually be looking? */
const onScreen = (box, viewport) => Boolean(box)
  && box.width > 4 && box.height > 4
  && box.left >= 0 && box.top >= 0
  && box.left + box.width <= viewport.width
  && box.top + box.height <= viewport.height;

/**
 * One mark, as pixels: the fill it is painted on, the ink printed on that fill, and how far it
 * stands out from the tab behind it.
 *
 * `standout` is measured against the row rather than against the mark's own fill, because that
 * is the comparison "the two are visually distinct" is actually about — a red glyph on the tab
 * and a coloured pill on the same tab, told apart by a reader looking at the row.
 */
function paintOf(picture, viewport, rowBox, mark) {
  const scale = picture.width / (viewport.width || picture.width);
  const box = inside(mark.box, rowBox);
  const fill = fillIn(picture, box, scale);
  const row = fillIn(picture, inside(rowBox, rowBox, 0), scale);
  return { fill, ink: inkIn(picture, box, fill, scale), standout: inkIn(picture, box, row, scale) };
}

const STATES = ['checking', 'online', 'unreachable', 'refused'];

/**
 * The rounds. Two projects, four states, so the page is navigated again with a new table
 * rather than four projects being invented to hold them all at once.
 *
 * The middle round is the one the design turns on: the broken project carries a status *and*
 * an error, which is the case a single field could not have represented.
 */
const ROUNDS = [
  {
    name: 'checking',
    table: { [HEALTHY]: { state: 'checking', reason: 'Asking the peer' } },
  },
  {
    name: 'online-and-unreachable',
    table: {
      [HEALTHY]: { state: 'online', reason: 'Answered in 41ms' },
      [BROKEN]: { state: 'unreachable', reason: 'No answer in 250ms' },
    },
  },
  {
    name: 'refused',
    table: { [HEALTHY]: { state: 'refused', reason: 'The board refused this device' } },
  },
];

/** Everything measured about a state, gathered across the rounds and asserted at the end. */
const painted = { light: {}, dark: {} };

let scriptId = null;

/** Re-arm the wrapper with a new table and load the board again from scratch. */
async function round(table) {
  if (scriptId) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId });
  ({ identifier: scriptId } = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: instrumentFor(table),
  }));
  // The bare address rather than a reload: `rememberWorkspace` writes `?workspace=` with
  // `replaceState`, and carrying that query forward would decide which board opens.
  await send('Page.navigate', { url: `${BASE}/` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API');
  await waitFor(async () => (await evaluate(MEASURE)).tabs.length === 2, 'both projects on the strip');
  // Said rather than assumed: the theme persists across a load, so a round that followed a dark
  // one would otherwise start wherever the last one left off and file its pixels under `light`.
  await setTheme('light');
  await waitFor(async () => (await themeNow()) === 'light', 'the board to be in light');
}

// ─── The run ──────────────────────────────────────────────────

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  const listed = await waitFor(async () => {
    const body = await (await fetch(`${BASE}/api/workspaces`)).json();
    return body?.workspaces?.length === 2 ? body.workspaces : null;
  }, 'both projects in the registry');

  const brokenRecord = listed.find((workspace) => workspace.id === BROKEN);
  const REASON = brokenRecord?.error ?? '';
  check('the fixture really is a project whose config cannot be resolved',
    Boolean(REASON), JSON.stringify(brokenRecord));
  check('and the healthy one carries no error',
    listed.find((workspace) => workspace.id === HEALTHY)?.error === null);

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1900,1000',
    'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Accessibility.enable');

  // ─── 0 ──────────────────────────────────────────────────────

  console.log('\n0. the four states are four states, in both places that name them');

  /**
   * The union is written twice, and neither copy can import the other.
   *
   * `src/core/peer-liveness.ts` is what decides these states, and it opens sockets — it imports
   * `net`. The frontend's `tsconfig` compiles everything it can reach, so a component that
   * imported that module for its type alone would drag a Node built-in into the browser build.
   * Two copies of four words is two chances for one of them to learn a fifth, and nothing about
   * a fifth word would fail to compile on either side.
   */
  const unionIn = (path, name) => {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    // One line, deliberately: a union that has grown past a line has grown past four words,
    // and reading on would quietly collect whatever the next declaration in the file says.
    const declared = new RegExp(`type ${name}\\s*=([^\\n;]*)`).exec(source);
    return declared
      ? [...declared[1].matchAll(/'([a-z]+)'/g)].map((found) => found[1]).sort()
      : null;
  };
  const onScreenSide = unionIn('frontend/src/components/WorkspaceTabs.tsx', 'WorkspaceStatusState');
  const serverSide = unionIn('src/core/peer-liveness.ts', 'PeerLivenessState');
  check('the strip declares the four states', JSON.stringify(onScreenSide) === JSON.stringify(STATES.slice().sort()),
    JSON.stringify(onScreenSide));
  check('and the module that decides them declares the same four',
    serverSide !== null && JSON.stringify(serverSide) === JSON.stringify(onScreenSide),
    `${JSON.stringify(serverSide)} vs ${JSON.stringify(onScreenSide)}`);

  // ─── 1 ──────────────────────────────────────────────────────

  console.log('\n1. the broken project says why, to a reader who cannot see it');

  await round(ROUNDS[0].table);
  let scene = await evaluate(MEASURE);
  const brokenTab = tabOf(scene, BROKEN);
  check('the broken project has a tab of its own', Boolean(brokenTab),
    JSON.stringify(scene.tabs.map((tab) => tab.name)));
  check('and it is marked broken', brokenTab?.broken === true);
  check('and it carries a marker', Boolean(brokenTab?.warn));

  const warnAx = await axOf('.workspace-tab--broken .workspace-tab__warn');
  check('the marker is no longer taken out of the accessibility tree',
    !hiddenFromReaders(warnAx), JSON.stringify(warnAx));
  const brokenName = await announcedFor(scene, BROKEN);
  check('and the reason the config could not be resolved is in the name the tab is read by',
    Boolean(brokenName?.name) && brokenName.name.includes(REASON),
    `name=${JSON.stringify(brokenName?.name)} reason=${JSON.stringify(REASON)}`);
  check('the reason is still in the tooltip as well, for a reader who hovers',
    (brokenTab?.title ?? '').includes(REASON), JSON.stringify(brokenTab?.title));

  // ─── 2 ──────────────────────────────────────────────────────

  console.log('\n2. a project carrying no status renders what it renders today');

  check('the broken project was given no status in this round', brokenTab?.status === null,
    JSON.stringify(brokenTab?.status));
  check('so its row is the name-then-marker it has always been',
    JSON.stringify(brokenTab?.parts) === JSON.stringify(['workspace-tab__name', 'workspace-tab__warn']),
    JSON.stringify(brokenTab?.parts));

  // ─── 3 ──────────────────────────────────────────────────────

  console.log('\n3. each of the four states is a readable label, not a colour');

  for (const [index, plan] of ROUNDS.entries()) {
    if (index > 0) await round(plan.table);
    scene = await evaluate(MEASURE);
    for (const [id, wanted] of Object.entries(plan.table)) {
      const tab = tabOf(scene, id);
      const mark = tab?.status;
      check(`${wanted.state}: the tab carries a status marker`, Boolean(mark),
        JSON.stringify(tab?.parts));
      check(`${wanted.state}: it names the state in its class`,
        (mark?.className ?? '').includes(`workspace-tab__status--${wanted.state}`),
        JSON.stringify(mark?.className));
      check(`${wanted.state}: it prints a readable word, not only a colour`,
        /[A-Za-z]{4,}/.test((mark?.text ?? '').trim()), JSON.stringify(mark?.text));
      check(`${wanted.state}: the label is not hidden from an assistive technology`,
        mark?.hidden !== 'true', JSON.stringify(mark?.hidden));
      check(`${wanted.state}: the reason reaches the tooltip verbatim`,
        (tab?.title ?? '').includes(wanted.reason), JSON.stringify(tab?.title));
      check(`${wanted.state}: the marker is somewhere on the screen`,
        onScreen(mark?.box, scene.viewport), JSON.stringify(mark?.box));

      const announced = await announcedFor(scene, id);
      check(`${wanted.state}: the state is in the name the tab is read by`,
        (announced?.name ?? '').toLowerCase().includes(wanted.state),
        JSON.stringify(announced?.name));
      check(`${wanted.state}: and the reason with it, word for word`,
        (announced?.name ?? '').includes(wanted.reason), JSON.stringify(announced?.name));
    }

    const statusAx = await axOf('.workspace-tab__status');
    check(`${Object.values(plan.table)[0].state}: the marker is not hidden from the tree`,
      !hiddenFromReaders(statusAx), JSON.stringify(statusAx));

    // ─── pixels, both themes, in the round that painted them ──
    for (const theme of ['light', 'dark']) {
      await setTheme(theme);
      await waitFor(async () => (await themeNow()) === theme, `the board to be in ${theme}`);
      await sleep(300);
      const picture = await shot(`${plan.name}-${theme}`);
      const measured = await evaluate(MEASURE);
      for (const [id, wanted] of Object.entries(plan.table)) {
        const tab = tabOf(measured, id);
        if (!tab?.status || !tab.rowBox) continue;
        painted[theme][wanted.state] = paintOf(picture, measured.viewport, tab.rowBox, tab.status);
      }
      // The round that has both marks is the one the two-states claim is made on.
      if (plan.name === 'online-and-unreachable') {
        const together = tabOf(measured, BROKEN);
        painted[theme].bothStatus = together?.status && together.rowBox
          ? paintOf(picture, measured.viewport, together.rowBox, together.status) : null;
        painted[theme].bothWarn = together?.warn && together.rowBox
          ? paintOf(picture, measured.viewport, together.rowBox, together.warn) : null;
        painted[theme].bothBoxes = {
          status: together?.status?.box ?? null,
          warn: together?.warn?.box ?? null,
        };
      }
    }
  }

  // ─── 4 ──────────────────────────────────────────────────────

  console.log('\n4. a status and an error on one tab, neither displacing the other');

  await round(ROUNDS[1].table);
  scene = await evaluate(MEASURE);
  const together = tabOf(scene, BROKEN);
  check('the broken project shows its status', Boolean(together?.status),
    JSON.stringify(together?.parts));
  check('and still shows its config error', Boolean(together?.warn), JSON.stringify(together?.parts));
  const boxes = {
    status: together?.status?.box ?? null,
    warn: together?.warn?.box ?? null,
  };
  const overlap = boxes.status && boxes.warn
    && boxes.status.left < boxes.warn.left + boxes.warn.width
    && boxes.warn.left < boxes.status.left + boxes.status.width;
  check('the two marks do not sit on top of one another',
    Boolean(boxes.status && boxes.warn) && !overlap, JSON.stringify(boxes));
  check('and both are on the screen',
    onScreen(boxes.status, scene.viewport) && onScreen(boxes.warn, scene.viewport),
    JSON.stringify(boxes));
  check('the tooltip carries both the error and the liveness reason',
    (together?.title ?? '').includes(REASON) && (together?.title ?? '').includes('No answer in 250ms'),
    JSON.stringify(together?.title));

  const announced = await announcedFor(scene, BROKEN);
  check('and an assistive technology is told both, as two separate things',
    (announced?.name ?? '').includes(REASON)
    && (announced?.name ?? '').includes('No answer in 250ms')
    && (announced?.name ?? '').toLowerCase().includes('unreachable'),
    JSON.stringify(announced?.name));
  check('neither of the two marks is hidden from the tree',
    !hiddenFromReaders(await axOf('.workspace-tab--broken .workspace-tab__warn'))
    && !hiddenFromReaders(await axOf('.workspace-tab--broken .workspace-tab__status')));

  // ─── 5 ──────────────────────────────────────────────────────

  console.log('\n5. rendered pixels, in both themes');

  for (const theme of ['light', 'dark']) {
    for (const state of STATES) {
      const paint = painted[theme][state];
      check(`${theme}: ${state} was painted at all`, Boolean(paint?.fill && paint?.ink),
        JSON.stringify(paint));
      if (!paint?.fill || !paint?.ink) continue;
      const ratio = contrast(paint.ink, paint.fill);
      check(`${theme}: ${state}'s label clears ${LEGIBLE}:1 against its own fill`,
        ratio !== null && ratio >= LEGIBLE,
        `ink=${paint.ink} fill=${paint.fill} ratio=${ratio === null ? '?' : ratio.toFixed(2)}`);
    }

    // Colour is not the message, but it must not be a lie either: four states that all paint
    // the same would leave the label doing the whole job with a decoration beside it saying
    // nothing at all.
    for (let a = 0; a < STATES.length; a++) {
      for (let b = a + 1; b < STATES.length; b++) {
        const one = painted[theme][STATES[a]]?.fill;
        const other = painted[theme][STATES[b]]?.fill;
        check(`${theme}: ${STATES[a]} and ${STATES[b]} are not painted alike`,
          Boolean(one && other) && distance(one, other) > APART, `${one} vs ${other}`);
      }
    }
  }

  for (const state of STATES) {
    const light = painted.light[state]?.fill;
    const dark = painted.dark[state]?.fill;
    check(`${state} is painted differently in dark than in light`,
      Boolean(light && dark) && distance(light, dark) > APART, `${light} vs ${dark}`);
  }

  for (const theme of ['light', 'dark']) {
    const statusPaint = painted[theme].bothStatus;
    const warnPaint = painted[theme].bothWarn;
    check(`${theme}: the status pill and the config-error mark do not paint the same`,
      Boolean(statusPaint?.standout && warnPaint?.standout)
      && distance(statusPaint.standout, warnPaint.standout) > APART,
      `${statusPaint?.standout} vs ${warnPaint?.standout}`);
  }
} catch (error) {
  failures++;
  console.error(`  FAIL  the run completed — ${error.message}`);
} finally {
  if (socket) { try { socket.close(); } catch { /* going anyway */ } }
  for (const child of children) { try { child.kill(); } catch { /* going anyway */ } }
  await sleep(500);
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* Windows holds the profile */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
