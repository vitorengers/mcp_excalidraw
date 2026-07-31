#!/usr/bin/env node
/**
 * Measures the one bar of chrome above the canvas, in a real browser.
 *
 * The board had two full-width strips: the project tabs, and under them a header carrying the
 * connection pill, Sync to Backend, Hide Menus, Clear Canvas and the usage HUD. Neither was
 * broken — which is the whole difficulty. A merge that "looks right" in the stylesheet is
 * exactly the class of change this repository has been burned by three times: it compiles, it
 * builds, and the row is still two rows, or the controls scrolled away with the tabs, or a
 * press lands on the label instead of the box.
 *
 * So every number here comes out of the browser's own box model, and the colours come out of
 * the screen rather than out of `getComputedStyle` — dark mode on this board is a canvas
 * filter, and a check that reads declarations agrees with itself while the screen shows
 * something else.
 *
 * Six questions:
 *
 *   1. is there one strip? `.workspace-tabs` has to be *inside* `.header`, not a sibling above
 *      it, and nothing else may sit between the top of the window and the canvas;
 *   2. do the tabs and the controls share a row — overlapping vertically, tabs to the left of
 *      the controls — and is the bar shorter than the two strips it replaced were together?
 *      That last one is the merge, measured: two boxes that stack add up, two that share a row
 *      do not;
 *   3. did the canvas get the reclaimed height, and does Excalidraw know about it? The
 *      anchored overlays are drawn through `appState.offsetTop`, so a canvas that grew without
 *      a re-measure puts the terminal and the documentation card off by the strip's height;
 *   4. does the tab area scroll on its own, without taking the controls with it? The strip is
 *      `overflow-x: auto` and the controls must never leave the window;
 *   5. is each control hit-testable at its own centre — Sync to Backend, the menus toggle,
 *      Clear Canvas and Restart Server — which is the label-versus-box trap already paid for
 *      here;
 *   6. and does the merged bar follow the board into dark mode? The tabs were painted from the
 *      themed tokens and the header from a hard-coded `#fff`; one row cannot be both.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server on a port
 * of its own, both killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-merged-bar-browser.mjs [--chrome <path>] [--shots <dir>]
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

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome({ what: 'nothing was measured.' });

if (!existsSync(join(repoRoot, 'dist', 'frontend', 'index.html'))) {
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

// ─── Contrast, the way WCAG defines it ────────────────────────

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * Enough of a PNG decoder to read a clipped screenshot back. Eight-bit, colour type 2 or 6,
 * which is all Chrome emits; all five row filters. Lifted from `check-claude-status-browser`.
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
  return { header, lanes, stride, out };
}

// ─── Three projects, so the strip has something to be wide with ──

const workDir = mkdtempSync(join(tmpdir(), 'check-merged-bar-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const PROJECTS = [
  { id: 'canvas-tool', name: 'VibeMaxxing' },
  { id: 'field-notes', name: 'Field Notes' },
  { id: 'harvest-planner', name: 'Harvest Planner' },
];

const registry = { workspaces: [] };
for (const project of PROJECTS) {
  const dir = join(workDir, 'projects', project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: project.name }), 'utf8');
  registry.workspaces.push({ id: project.id, path: dir.replace(/\\/g, '/') });
}
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE_URL = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    // The board's own shell exports this, and a terminal block is a DOM overlay that
    // swallows the presses this check aims at the bar. Nothing here needs a terminal.
    EXCALIDRAW_TERMINAL: '',
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
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
}

/** What one box of the screen really is: its commonest colour, and the pixel furthest from it. */
async function readBox(rect) {
  const clip = {
    x: Math.round(rect.left), y: Math.round(rect.top),
    width: Math.max(2, Math.round(rect.width)), height: Math.max(2, Math.round(rect.height)),
    scale: 1,
  };
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
  const { header, lanes, stride, out } = decodePng(Buffer.from(data, 'base64'));
  const tally = new Map();
  const pixels = [];
  for (let y = 0; y < header.height; y++) {
    for (let x = 0; x < header.width; x++) {
      const base = y * stride + x * lanes;
      const pixel = [out[base], out[base + 1], out[base + 2]];
      pixels.push(pixel);
      const key = pixel.join(',');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  let background = null;
  let most = -1;
  for (const [key, count] of tally) {
    if (count > most) { most = count; background = key.split(',').map(Number); }
  }
  let text = background;
  let best = 1;
  for (const pixel of pixels) {
    const ratio = contrast(pixel, background);
    if (ratio > best) { best = ratio; text = pixel; }
  }
  return { background, text, ratio: best };
}

/** The imperative API, through the container's React fibre. See check-workspace-tabs-scale. */
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
        window.__barApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The whole bar as the browser has it: where each part is, what a click at its centre finds,
 * and how the chrome stacks against the canvas.
 */
const PROBE = `(() => {
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
             width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const nameOf = (node) => {
    if (!node) return 'nothing';
    const tag = node.tagName ? node.tagName.toLowerCase() : '?';
    const cls = typeof node.className === 'string' && node.className
      ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    return tag + cls;
  };
  const header = document.querySelector('.header');
  const tabs = document.querySelector('.workspace-tabs');
  const controls = document.querySelector('.controls');
  const byText = (pattern) => Array.from(document.querySelectorAll('.header button'))
    .find((node) => pattern.test((node.textContent || '').trim())) || null;

  const parts = {
    sync: byText(/^Sync to Backend$|^Syncing/),
    menus: byText(/Menus$/),
    clear: byText(/^Clear Canvas$/),
    restart: document.querySelector('.header .restart-server__button'),
    tab: document.querySelector('.workspace-tabs .workspace-tab__select'),
    add: document.querySelector('.workspace-tabs__add'),
  };
  const hits = {};
  for (const [name, node] of Object.entries(parts)) {
    const box = boxOf(node);
    if (!box) { hits[name] = null; continue; }
    const found = document.elementFromPoint(box.x, box.y);
    hits[name] = {
      box, found: nameOf(found),
      label: (node.textContent || '').trim(),
      onControl: Boolean(found && (node === found || node.contains(found))),
    };
  }

  return {
    header: boxOf(header),
    tabs: boxOf(tabs),
    controls: boxOf(controls),
    canvas: boxOf(document.querySelector('.excalidraw')),
    // The two questions section 1 is made of: is the strip inside the bar, and is there any
    // other full-width strip of chrome between the top of the page and the canvas.
    tabsInsideHeader: Boolean(header && tabs && header.contains(tabs)),
    stripsAboveCanvas: Array.from(document.querySelectorAll('.app > *'))
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return box.height > 0 && box.width > window.innerWidth * 0.5
          && !node.classList.contains('canvas-container');
      })
      .map(nameOf),
    titles: document.querySelectorAll('.header h1').length,
    strip: tabs ? {
      scrollWidth: tabs.scrollWidth, clientWidth: tabs.clientWidth,
      scrollLeft: tabs.scrollLeft,
      overflowX: getComputedStyle(tabs).overflowX,
    } : null,
    controlsWrap: controls ? getComputedStyle(controls).flexWrap : null,
    headerWrap: header ? getComputedStyle(header).flexWrap : null,
    tabRows: Array.from(document.querySelectorAll('.workspace-tab'))
      .map((tab) => Math.round(tab.getBoundingClientRect().top)),
    hits,
    offsetTop: window.__barApi ? window.__barApi.getAppState().offsetTop : null,
    theme: (document.querySelector('.app') || { dataset: {} }).dataset.theme || null,
    window: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;

const near = (a, b, slack = 1) => a !== null && b !== null && Math.abs(a - b) <= slack;

/**
 * The server the restart leaves behind.
 *
 * It is a grandchild this process never spawned — that is the whole point of the feature —
 * so nothing in `children` would ever kill it, and a check that walked away from it would
 * leave a canvas holding a port.
 */
let restarted = null;

try {
  await waitFor(async () => (await fetch(`${BASE_URL}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,900',
    BASE_URL,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.tabs && seen.controls && seen.tabRows.length === PROJECTS.length ? seen : null;
  }, 'the bar with every project on it');
  await sleep(400);

  let seen = await evaluate(PROBE);
  await shot('01-merged-bar');

  console.log('1. one strip of chrome, not two');
  check('the tab strip is inside the header rather than a strip above it', seen.tabsInsideHeader,
        JSON.stringify(seen.stripsAboveCanvas));
  check('exactly one full-width band sits above the canvas',
        seen.stripsAboveCanvas.length === 1, JSON.stringify(seen.stripsAboveCanvas));
  check('and it is the header', /header/.test(seen.stripsAboveCanvas[0] ?? ''),
        JSON.stringify(seen.stripsAboveCanvas));
  check('the constant page title is gone — the tabs name the board now',
        seen.titles === 0, `${seen.titles} h1 still in the header`);

  console.log('\n2. the tabs and the controls share that row');
  console.log(`      (bar ${Math.round(seen.header.width)}×${Math.round(seen.header.height)}px: `
    + `tabs ${Math.round(seen.tabs.width)}px, controls ${Math.round(seen.controls.width)}px)`);
  check('the tabs are on the left of the controls', seen.tabs.right <= seen.controls.left + 1,
        `tabs end at ${Math.round(seen.tabs.right)}, controls start at ${Math.round(seen.controls.left)}`);
  check('the controls are at the right-hand end of the bar',
        seen.controls.right <= seen.header.right + 1 && seen.controls.right > seen.header.width * 0.6,
        `controls ${Math.round(seen.controls.left)}…${Math.round(seen.controls.right)} of ${Math.round(seen.header.width)}`);
  check('they overlap vertically, which is what sharing a row means',
        seen.tabs.top < seen.controls.bottom && seen.controls.top < seen.tabs.bottom,
        `tabs ${Math.round(seen.tabs.top)}…${Math.round(seen.tabs.bottom)}, `
        + `controls ${Math.round(seen.controls.top)}…${Math.round(seen.controls.bottom)}`);
  check('so the bar is shorter than the two strips it replaced were together',
        seen.header.height < seen.tabs.height + seen.controls.height - 1,
        `bar ${Math.round(seen.header.height)}px, tabs ${Math.round(seen.tabs.height)}px `
        + `+ controls ${Math.round(seen.controls.height)}px`);
  check('and the bar is one row: nothing wrapped under it',
        seen.headerWrap === 'nowrap', seen.headerWrap);

  console.log('\n3. the canvas got the height back, and Excalidraw knows');
  check('the canvas starts where the bar ends', near(seen.canvas.top, seen.header.bottom, 1),
        `bar ends at ${Math.round(seen.header.bottom)}, canvas starts at ${Math.round(seen.canvas.top)}`);
  check('nothing above the canvas but the one bar',
        near(seen.canvas.top, seen.header.height, 1),
        `canvas.top ${Math.round(seen.canvas.top)} vs bar height ${Math.round(seen.header.height)}`);
  check('the offset the anchored overlays are drawn through is the canvas\'s real top edge',
        near(seen.offsetTop, seen.canvas.top, 1),
        `appState.offsetTop is ${seen.offsetTop}, the canvas starts at ${seen.canvas.top}`);

  console.log('\n4. the tab area scrolls without taking the controls with it');
  await send('Emulation.setDeviceMetricsOverride',
             { width: 900, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await evaluate(PROBE);
  await shot('02-narrow');
  check('the strip has more tabs than it has room for',
        narrow.strip.scrollWidth > narrow.strip.clientWidth,
        `${narrow.strip.scrollWidth}px of content in ${narrow.strip.clientWidth}px`);
  check('and reaches them by scrolling', narrow.strip.overflowX === 'auto', narrow.strip.overflowX);
  check('nothing wrapped onto a second row of tabs',
        new Set(narrow.tabRows).size === 1, JSON.stringify(narrow.tabRows));
  check('the controls are still whole inside the window',
        narrow.controls.right <= narrow.window.width + 1 && narrow.controls.left >= 0,
        `controls ${Math.round(narrow.controls.left)}…${Math.round(narrow.controls.right)} `
        + `of ${narrow.window.width}`);

  await evaluate(`document.querySelector('.workspace-tabs').scrollLeft = 9999`);
  await sleep(250);
  const scrolled = await evaluate(PROBE);
  await shot('03-strip-scrolled');
  check('scrolling the strip really moved it', scrolled.strip.scrollLeft > 0,
        `scrollLeft ${scrolled.strip.scrollLeft}`);
  check('and it did not move the controls',
        near(scrolled.controls.left, narrow.controls.left, 1),
        `${Math.round(narrow.controls.left)} → ${Math.round(scrolled.controls.left)}`);
  check('Clear Canvas is still hit-testable after the strip has scrolled',
        scrolled.hits.clear?.onControl === true, JSON.stringify(scrolled.hits.clear));

  // Put the strip back where it was found, or the first tab is off the left-hand end of it
  // for the hit tests below — the check's own leftover, not the board's.
  await evaluate(`document.querySelector('.workspace-tabs').scrollLeft = 0`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);

  console.log('\n5. every control answers a press at its own centre');
  seen = await evaluate(PROBE);
  for (const [name, what] of [
    ['Sync to Backend', 'sync'],
    ['the menus toggle', 'menus'],
    ['Clear Canvas', 'clear'],
    ['Restart Server', 'restart'],
    ['the project tab in front', 'tab'],
  ]) {
    const hit = seen.hits[what];
    check(`${name} is what a click at its centre finds`, hit !== null && hit.onControl,
          hit ? `found ${hit.found} at ${Math.round(hit.box.x)},${Math.round(hit.box.y)}`
              : 'not on the page');
  }

  // The `+` is the last thing on the strip, so on a board with more projects than the strip
  // has room for it is reached by scrolling — which it always was. What must not happen is
  // that scrolling to it still leaves it *under* the controls: that is what the strip's own
  // clipping would do if the controls were painted over its scroll area rather than beside it.
  await evaluate(`(() => { const bar = document.querySelector('.workspace-tabs');
    bar.scrollLeft = bar.scrollWidth; })()`);
  await sleep(250);
  const atEnd = await evaluate(PROBE);
  await shot('06-strip-at-its-end');
  check('the + that adds a project answers a press at the end of the strip\'s own scroll',
        atEnd.hits.add?.onControl === true,
        `found ${atEnd.hits.add?.found} at ${Math.round(atEnd.hits.add?.box?.x ?? -1)},`
        + `${Math.round(atEnd.hits.add?.box?.y ?? -1)}`);
  await evaluate(`document.querySelector('.workspace-tabs').scrollLeft = 0`);
  await sleep(200);

  console.log('\n6. the merged bar follows the board into dark mode, on the screen');
  const light = await readBox(seen.header);
  await shot('04-light');
  check(`the bar is light in the light theme (${hex(light.background)})`,
        luminance(light.background) > 0.5, hex(light.background));
  check(`and its text is legible on it (${light.ratio.toFixed(1)}:1)`, light.ratio >= 4.5,
        `${hex(light.text)} on ${hex(light.background)}`);

  await evaluate(`window.__barApi.updateScene({ appState: { theme: 'dark' } })`);
  await waitFor(async () => (await evaluate(PROBE)).theme === 'dark', 'the dark theme');
  await sleep(400);
  const darkSeen = await evaluate(PROBE);
  const dark = await readBox(darkSeen.header);
  await shot('05-dark');
  check(`the bar is dark in the dark theme (${hex(dark.background)})`,
        luminance(dark.background) < 0.2, hex(dark.background));
  check('so it is not the light header left over a dark board',
        contrast(light.background, dark.background) > 4,
        `${hex(light.background)} vs ${hex(dark.background)}`);
  check(`and its text is legible on it (${dark.ratio.toFixed(1)}:1)`, dark.ratio >= 4.5,
        `${hex(dark.text)} on ${hex(dark.background)}`);
  check('the bar is still one row in the dark',
        near(darkSeen.header.height, seen.header.height, 2),
        `${Math.round(seen.header.height)}px → ${Math.round(darkSeen.header.height)}px`);

  console.log('\n7. and the restart button on it really restarts the server');
  const before = await (await fetch(`${BASE_URL}/health`)).json();

  await evaluate(`document.querySelector('.restart-server__button').click()`);
  await sleep(250);
  const confirming = await evaluate(`(() => {
    const card = document.querySelector('.restart-server__confirm');
    return card ? { text: card.textContent, costs: card.querySelectorAll('li').length } : null;
  })()`);
  await shot('07-confirmation');
  check('pressing it asks first', confirming !== null, 'no confirmation opened');
  check('and the confirmation names what a restart costs rather than asking `are you sure?`',
        confirming !== null && confirming.costs >= 3
        && /terminal/i.test(confirming.text) && /interrupted/i.test(confirming.text),
        JSON.stringify(confirming));
  check('it says the page comes back on its own, so nobody reloads over a restart',
        confirming !== null && /reload/i.test(confirming.text), JSON.stringify(confirming));

  await evaluate(`(() => {
    const cancel = [...document.querySelectorAll('.restart-server__actions button')]
      .find((button) => /cancel/i.test(button.textContent));
    cancel.click();
  })()`);
  await sleep(250);
  check('cancelling closes it and restarts nothing',
        await evaluate(`document.querySelector('.restart-server__confirm') === null`)
        && (await (await fetch(`${BASE_URL}/health`)).json()).pid === before.pid);

  await evaluate(`document.querySelector('.restart-server__button').click()`);
  await sleep(200);
  await evaluate(`(() => {
    const go = [...document.querySelectorAll('.restart-server__actions button')]
      .find((button) => /^restart$/i.test(button.textContent.trim()));
    go.click();
  })()`);
  check('the button says it is working while it waits',
        await waitFor(async () => /Restarting/.test(
          await evaluate(`document.querySelector('.restart-server__button').textContent`)), 'the waiting state', 40));

  const after = await waitFor(async () => {
    const health = await (await fetch(`${BASE_URL}/health`)).json().catch(() => null);
    return health && health.pid !== before.pid ? health : null;
  }, 'a new pid on the same port', 240);
  if (after?.pid) restarted = after.pid;
  check('a different pid is serving the same board afterwards', after.pid !== before.pid,
        `${before.pid} → ${after.pid}`);
  check('and it kept the registry it was started with', after.workspaces === 'configured',
        JSON.stringify(after));
  check('the button says so once the new server answers',
        await waitFor(async () => /Restarted/.test(
          await evaluate(`document.querySelector('.restart-server__button').textContent`)),
        'the button to report the restart', 240));
  await shot('08-restarted');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  if (restarted) { try { process.kill(restarted); } catch { /* already gone */ } }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
