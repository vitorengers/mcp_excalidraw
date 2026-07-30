#!/usr/bin/env node
/**
 * Checks, in a real browser on a cold profile, that no label is measured before its font.
 *
 * Excalidraw does not keep the `width` a text element was authored with. Everything this app
 * puts on the canvas goes through `convertToExcalidrawElements`, and its `text` branch calls
 * `newTextElement`, which throws the incoming width away and re-measures the string with
 * `measureText` — a `CanvasRenderingContext2D` and whatever font the browser has *at that
 * instant*. On a cold profile that instant is before any webfont has arrived, so the number it
 * records is the fallback font's. When Excalifont lands, `Fonts.onLoaded` invalidates the shape
 * cache and repaints — but it never re-measures, so the glyphs are now wider than the width the
 * element is clipped to and the tail of every label is cut. Nothing later fixes it: these are
 * authored elements, and nothing redraws them (#234).
 *
 * The two questions this asks are the two halves of that, and each is made deterministic
 * rather than left to a race that a fast machine wins by accident:
 *
 *   - **The fonts come from the board's own server.** `esm.sh` is blocked outright, which is
 *     what a machine with no internet looks like. Excalidraw's `ExcalidrawFontFace.createUrls`
 *     falls back to `https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` unless the page
 *     sets `window.EXCALIDRAW_ASSET_PATH`, so before #234 this was the *only* source and the
 *     board could not draw its own font offline at all.
 *   - **Every label is at the width the page measures for it.** Every `woff2` response is held
 *     back 2.5 s, which is a cold profile in slow motion. The scene has to wait for the font
 *     rather than measure ahead of it.
 *
 * The expectation is taken **off the page, not off the file**: each text element's stored width
 * is compared against `measureText` of the same string, in the same font, run in the page once
 * the fonts are in. A stored width in `docs/board.excalidraw` is only what somebody wrote there
 * — several of them are hand-written estimates — so the file cannot be the authority. What the
 * running app measures with the real font is.
 *
 * **`document.fonts.check` is not what any of this waits on**, and case 1 is why: on a page with
 * no Excalifont anywhere it answers `true`, because a family nothing has registered resolves to
 * a system font that is by definition already loaded. The predicate used here is the `FontFace`
 * status *plus* a measurement — Cascadia has to come out monospace, and Excalifont has to
 * measure differently from a family that does not exist.
 *
 * Self-contained: throwaway registry and project directory seeded from `docs/board.excalidraw`,
 * its own canvas server, its own Chrome profile per scenario, all killed at the end. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend, so proving it red against the old code needs the old code *built*.
 *
 * Usage: node scripts/check-canvas-fonts-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const slash = (value) => String(value).replace(/\\/g, '/');

/** How long every `woff2` response is held back in the second scenario. */
const FONT_DELAY_MS = 2500;

// ─── One project, seeded from this repository's own board ─────
//
// The issue was measured on another board and says so; confirming it on `docs/board.excalidraw`
// is the first thing it asks for, because the defect is in the restore path rather than in any
// board's data. No `githubProject`, so the mirror stays dormant and nothing but the seed draws.

const workDir = mkdtempSync(join(tmpdir(), 'check-canvas-fonts-'));
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const projectDir = join(workDir, 'board-project');
mkdirSync(projectDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const boardPath = join(repoRoot, 'docs', 'board.excalidraw');
writeFileSync(join(projectDir, 'board.excalidraw'), readFileSync(boardPath));
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Board', board: 'board.excalidraw' }, null, 2), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'board', path: slash(projectDir) }],
}, null, 2), 'utf8');

const PORT = 36400 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
};
// This machine's shell exports it, and a terminal block would put a DOM overlay over the board.
delete serverEnv.EXCALIDRAW_TERMINAL;

const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

/**
 * The two labels the issue measured, in this board's own words.
 *
 * One carries accents, because Excalifont is split into several `unicodeRange` subsets and
 * `Especificação` needs a different `woff2` file from `Especificacao`: a wait that loads only
 * the ASCII subset is a wait that still measures the accented label wrong. The other is 12 px
 * Cascadia, the code font, which is the one a monospace test can speak for.
 */
const PROBES = [
  { text: 'Especificação técnica', fontSize: 20, fontFamily: 5 },
  { text: 'docs/technical-spec.md', fontSize: 12, fontFamily: 3 },
];

async function seedProbes() {
  const ids = [];
  for (const [index, probe] of PROBES.entries()) {
    const response = await fetch(`${BASE}/api/elements?workspace=board`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'text', x: -900, y: -900 + index * 60, ...probe,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (body?.element?.id) ids.push(body.element.id);
  }
  return ids;
}

// ─── What the page is asked ───────────────────────────────────

/** The same reach for the imperative API the other browser checks use. */
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
        window.__fontCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Excalidraw's own `getFontString` and `measureText`, restated in the page.
 *
 * Restated rather than imported: the check has to be able to disagree with the built bundle,
 * and a measurement taken through the same code that produced the defect could not.
 */
const MEASURE_HELPERS = `
window.__fontFamilyName = (id) => ({
  1: 'Virgil', 2: 'Helvetica', 3: 'Cascadia', 5: 'Excalifont',
  6: 'Nunito', 7: 'Lilita One', 8: 'Comic Shanns', 9: 'Liberation Sans',
}[id] || null);
window.__fontString = (element) => {
  const name = window.__fontFamilyName(element.fontFamily);
  const fallbacks = element.fontFamily === 5 ? ', Xiaolai, Segoe UI Emoji' : ', Segoe UI Emoji';
  return element.fontSize + 'px ' + name + fallbacks;
};
window.__measureWidth = (text, font) => {
  const context = (window.__fontCanvas = window.__fontCanvas
    || document.createElement('canvas')).getContext('2d');
  context.font = font;
  const normalized = String(text).replace(/\\r\\n?/g, '\\n').replace(/\\t/g, '        ');
  let width = 0;
  for (const line of normalized.split('\\n')) {
    width = Math.max(width, context.measureText(line || ' ').width);
  }
  return width;
};
true`;

/**
 * The honest answer to "have the canvas fonts arrived".
 *
 * Three things, and `document.fonts.check` is deliberately none of them. A `FontFace` of each
 * family has to exist — that is Excalidraw having registered them — and to say `loaded`. Then
 * Cascadia has to measure monospace, which no proportional substitute does; and Excalifont has
 * to measure differently from a family nothing has ever heard of, which is what a substitution
 * would measure exactly the same as.
 */
const FONTS_READY = `(() => {
  const status = {};
  document.fonts.forEach((face) => {
    status[face.family] = status[face.family] || new Set();
    status[face.family].add(face.status);
  });
  const loaded = (family) => Boolean(status[family] && status[family].has('loaded'));
  if (!loaded('Excalifont') || !loaded('Cascadia')) return false;
  const narrow = window.__measureWidth('iiiiiiiiii', '12px Cascadia');
  const wide = window.__measureWidth('MMMMMMMMMM', '12px Cascadia');
  if (narrow === 0 || Math.abs(narrow - wide) > 0.01) return false;
  const real = window.__measureWidth('Especificação técnica', '20px Excalifont');
  const substituted = window.__measureWidth('Especificação técnica', '20px __no-such-family__');
  return Math.abs(real - substituted) > 0.5;
})()`;

/**
 * Every text element on the board, with the width the page would measure for it now.
 *
 * Unbound text only. A label bound into a container is wrapped to the container rather than to
 * its own advance width, so the two numbers are not the same question — and the elements this
 * is about are the authored ones, which is what an unbound text element is.
 */
const WIDTH_DRIFT = `(() => {
  return window.__fontCheckApi.getSceneElements()
    .filter((element) => element.type === 'text' && !element.isDeleted
                         && !element.containerId && element.autoResize !== false
                         && window.__fontFamilyName(element.fontFamily))
    .map((element) => {
      const measured = window.__measureWidth(element.text, window.__fontString(element));
      return {
        text: element.text.slice(0, 32),
        stored: element.width,
        measured,
        drift: Math.abs(element.width - measured),
      };
    })
    .sort((a, b) => b.drift - a.drift);
})()`;

// ─── Talking to Chrome ────────────────────────────────────────

/**
 * One Chrome, one profile, one scenario — then killed.
 *
 * A profile per scenario rather than a reload, because "cold" is the whole premise: a second
 * board opened in a browser that has already fetched Excalifont measures everything correctly
 * however broken the code is.
 */
class Session {
  constructor(name, cdpPort) {
    this.name = name;
    this.cdpPort = cdpPort;
    this.profileDir = join(workDir, `chrome-${name}`);
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.fontRequests = [];
    this.delayMs = 0;
    mkdirSync(this.profileDir, { recursive: true });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async start() {
    this.chrome = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--window-size=1400,900',
      'about:blank',
    ], { stdio: 'ignore' });
    children.push(this.chrome);

    const target = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${this.cdpPort}/json/list`);
      return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
    }, `a Chrome page target for ${this.name}`);
    this.socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
    this.socket.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    // A cold profile keeps nothing, and neither does this.
    await this.send('Network.setCacheDisabled', { cacheDisabled: true });
  }

  onMessage(message) {
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const hold = /\.woff2(\?|$)/i.test(request.url) ? this.delayMs : 0;
      setTimeout(() => { this.send('Fetch.continueRequest', { requestId }).catch(() => { }); }, hold);
      return;
    }
    if (message.method === 'Network.requestWillBeSent' && /\.woff2(\?|$)/i.test(message.params.request.url)) {
      this.fontRequests.push({ id: message.params.requestId, url: message.params.request.url });
    }
    if (message.method === 'Network.responseReceived') {
      const hit = this.fontRequests.find((entry) => entry.id === message.params.requestId);
      if (hit) hit.status = message.params.response.status;
    }
    if (message.method === 'Network.loadingFailed') {
      const hit = this.fontRequests.find((entry) => entry.id === message.params.requestId);
      if (hit) hit.status = `failed: ${message.params.errorText}`;
    }
    const waiting = message.id && this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }

  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  }

  async openBoard() {
    await this.send('Page.navigate', { url: `${BASE}/?workspace=board` });
    await waitFor(() => this.evaluate(GRAB_API), `the Excalidraw API handle in ${this.name}`);
    await this.evaluate(MEASURE_HELPERS);
    await waitFor(() => this.evaluate('window.__fontCheckApi.getSceneElements().length > 0'),
                  `the board to reach the canvas in ${this.name}`);
  }

  async stop() {
    try { this.socket?.close(); } catch { /* already gone */ }
    await sleep(200);
    if (this.chrome?.exitCode === null) {
      try { this.chrome.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  const probeIds = await seedProbes();
  if (probeIds.length !== PROBES.length) {
    throw new Error(`the probe labels were not created\n${serverLog}`);
  }

  // ─── 1. The trap `document.fonts.check` sets ────────────────

  console.log('1. fonts.check answers yes for a font that is not there');
  const cold = new Session('trap', PORT + 400);
  await cold.start();
  await cold.evaluate(MEASURE_HELPERS);
  const trap = await cold.evaluate(`(() => {
    let excalifontFaces = 0;
    document.fonts.forEach((face) => { if (face.family === 'Excalifont') excalifontFaces++; });
    return {
      faces: excalifontFaces,
      check: document.fonts.check('20px Excalifont, Xiaolai, Segoe UI Emoji'),
      ready: ${FONTS_READY},
    };
  })()`);
  check('the page has no Excalifont at all', trap.faces === 0, JSON.stringify(trap));
  check('and fonts.check still says it is there', trap.check === true, JSON.stringify(trap));
  check('so the predicate this check waits on says no', trap.ready === false, JSON.stringify(trap));
  await cold.stop();

  // ─── 2. The board draws its own font with no internet ───────

  console.log('\n2. with esm.sh unreachable, the fonts come from the board');
  const offline = new Session('offline', PORT + 401);
  await offline.start();
  await offline.send('Network.setBlockedURLs', { urls: ['*esm.sh*'] });
  await offline.openBoard();
  let offlineReady = false;
  try {
    offlineReady = await waitFor(() => offline.evaluate(FONTS_READY), 'the canvas fonts offline', 40);
  } catch { /* the case below is the report */ }
  await offline.shot('02-offline');
  // `/assets/fonts/…` specifically, not merely same-origin: Vite bundles Assistant, the UI
  // font, into `/assets/Assistant-…woff2`, and that has always been served from here. It says
  // nothing about the fonts the *canvas* draws with.
  const served = offline.fontRequests.filter(
    (entry) => entry.url.startsWith(`${BASE}/assets/fonts/`) && entry.status === 200);
  const cdn = offline.fontRequests.filter((entry) => entry.url.includes('esm.sh'));
  check('the canvas fonts really loaded', offlineReady === true,
        JSON.stringify(offline.fontRequests.slice(0, 6)));
  check('the board served the woff2 itself', served.length > 0,
        JSON.stringify(offline.fontRequests.slice(0, 6)));
  check('and nothing depended on the CDN answering',
        cdn.every((entry) => entry.status !== 200), JSON.stringify(cdn.slice(0, 4)));
  await offline.stop();

  // ─── 3. Every label at the width the page measures ──────────

  console.log(`\n3. with every woff2 held back ${FONT_DELAY_MS} ms, no label is measured early`);
  const slow = new Session('slow', PORT + 402);
  slow.delayMs = FONT_DELAY_MS;
  await slow.start();
  await slow.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  await slow.openBoard();
  await waitFor(() => slow.evaluate(FONTS_READY), 'the canvas fonts to arrive slowly', 80);
  // Past the point where anything the page does on its own could still be in flight: what is
  // being asserted is that nothing repairs these, so settling time can only help the old code.
  await sleep(3000);
  await slow.shot('03-slow-fonts');
  const drift = await slow.evaluate(WIDTH_DRIFT);
  const worst = drift[0] ?? null;
  const off = drift.filter((entry) => entry.drift > 0.5);
  check('the board has labels to measure', drift.length >= 20, `${drift.length} text elements`);
  check('every label is at the width the page measures for it',
        off.length === 0,
        `${off.length} of ${drift.length} are not — worst ${JSON.stringify(worst)}`);
  const probes = drift.filter((entry) => /Especificação|technical-spec/.test(entry.text));
  check('including the accented one and the monospace one',
        probes.length === PROBES.length && probes.every((entry) => entry.drift <= 0.5),
        JSON.stringify(probes));
  await slow.stop();
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(400);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
