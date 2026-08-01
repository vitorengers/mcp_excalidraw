#!/usr/bin/env node
/**
 * Take the curated screenshots in `docs/media/`, against a board that belongs to nobody.
 *
 * Eighteen loose PNGs were sitting in the working tree root when #337 wrote the images rule,
 * and not one of them could be published: a red banner carrying an operator's home directory
 * in frame, a terminal panel of Portuguese issue text from an unrelated private project, a tab
 * strip naming three repositories that are nobody's business. An image cannot be scanned the
 * way prose can — `check-english-only.mjs` and `check-root-tidy.mjs` both have exactly nothing
 * to say about a PNG — so the only durable answer is to take the picture somewhere there is
 * nothing to leak.
 *
 * That is the whole of this script. It builds a throwaway registry in a temporary directory,
 * with two projects whose names were invented here, starts a canvas server against it through
 * `lib/spawn-canvas.mjs` — which strips every `EXCALIDRAW_*` and `VIBEMAXXING_*` this machine
 * exports, so the operator's real registry, real `gh` and real board cannot reach the frame —
 * and drives a headless Chrome at it. No path is typed into the UI and no directory listing is
 * opened, so nothing on screen comes from the machine it ran on.
 *
 * What it does *not* take is the hero. `docs/media/board-hero.png` is this repository's own
 * board against the real GitHub project, which is the one picture that has to be real, and it
 * was shot by hand through a junction so that the terminal block printed `C:\vibemaxxing`
 * rather than the maintainer's home directory (#342). Re-shooting it means doing that again.
 *
 * Each picture gets the frame that suits it, and every frame is taken at more than one device
 * pixel per CSS pixel: a canvas glyph has no hinting, and a 1x screenshot of a 13px card body
 * is a smear. The whole-board shot is wide and short because the board is — 2324 x 570, which
 * will not fit at the zoom it was written at in a window shaped like the one the panel shot
 * uses — and the board is drawn at 100% either way, because a smaller drawing of it is not
 * what the product puts on screen.
 *
 * Not a check — it writes tracked files and is run by hand, deliberately, when the product's
 * first screen has changed. `scripts/check-readme.mjs` is what holds the result: three or four
 * curated images, each named for what it shows, at least two of them on the front page.
 *
 * Usage: node scripts/capture-media.mjs [--chrome <path>] [--out <dir>] [--keep]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = argOf('--chrome') ?? findChrome();
if (!chromePath) {
  console.error('no Chrome or Edge found — pass --chrome <path>');
  process.exit(1);
}

const outDir = argOf('--out') ?? join(repoRoot, 'docs', 'media');
mkdirSync(outDir, { recursive: true });

if (!existsSync(join(repoRoot, 'dist', 'frontend', 'index.html'))) {
  console.error('dist/frontend/index.html is missing — run ./node_modules/.bin/vite build first');
  process.exit(1);
}

// ─── A registry that belongs to nobody ────────────────────────

/**
 * Two projects, because one tab does not read as a tab strip and the strip is what the first
 * run is about. The names are inventions with no owner: a reader has to be able to see that
 * these are somebody's projects without them being anybody's.
 */
const PROJECTS = [
  { id: 'notes-app', name: 'Notes App' },
  { id: 'design-system', name: 'Design System' },
];

const workDir = mkdtempSync(join(tmpdir(), 'capture-media-'));
const registryPath = join(workDir, 'workspaces.json');
const profileDir = join(workDir, 'chrome-profile');
mkdirSync(profileDir, { recursive: true });

for (const project of PROJECTS) {
  const dir = join(workDir, 'projects', project.id);
  mkdirSync(dir, { recursive: true });
  // No `board`, so each project comes up holding the board this tool ships to a first-time
  // reader — which is exactly what "after a project is added" looks like.
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: project.name }, null, 2), 'utf8');
}
writeFileSync(registryPath, JSON.stringify({
  workspaces: PROJECTS.map((project) => ({
    id: project.id,
    path: join(workDir, 'projects', project.id).replace(/\\/g, '/'),
  })),
}, null, 2), 'utf8');

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
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
    // Its own state directory, so the per-user `default.excalidraw` every check shares is not
    // read and not written — this run has to see the welcome board and nothing else.
    EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    // `canvasEnvironment` sets this empty for the checks, whose click coordinates a 32-shape
    // board would move. Deleting it puts the shipped default back, which is the subject here.
    EXCALIDRAW_WELCOME_BOARD: undefined,
  },
}).child;
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const path = join(outDir, `${name}.png`);
  writeFileSync(path, Buffer.from(data, 'base64'));
  console.log(`wrote ${path}`);
}

async function click(x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(200);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(20);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** The imperative API, through the container's React fibre. See `check-board-drafts-browser.mjs`. */
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
        window.__captureApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** The scene as this script needs to see it: the issue block, and where the canvas is scrolled. */
const PROBE = `(() => {
  const api = window.__captureApi;
  const elements = api.getSceneElements();
  const state = api.getAppState();
  const block = elements.find((element) => element.customData && element.customData.kind === 'issue');
  return {
    count: elements.length,
    block: block ? { id: block.id, x: block.x, y: block.y, w: block.width, h: block.height } : null,
    scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
    offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
    editorOpen: Boolean(document.querySelector('.excalidraw-wysiwyg')),
  };
})()`;

/**
 * Scene coordinates to where they are on screen, which is where a click has to be sent.
 *
 * `offsetTop` is the half that is easy to leave out and impossible to miss afterwards: the
 * canvas sits under the tab strip, so a click computed without it lands 88 px high — on empty
 * canvas just above the issue block, where a double click creates a new text element instead
 * of editing the block's label, and the observation ends up drawn across the whole board.
 */
const toViewport = (scene, x, y) => ({
  x: (x + scene.scrollX) * scene.zoom + scene.offsetLeft,
  y: (y + scene.scrollY) * scene.zoom + scene.offsetTop,
});

/** The frame the next shot is taken in. Each picture gets the one that suits it. */
const frame = (width, height, deviceScaleFactor) =>
  send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });

/** Scroll the canvas so that scene point (x, y) sits at (screenX, screenY) on the page. */
async function placeAt(x, y, screenX, screenY) {
  const scene = await evaluate(PROBE);
  const scrollX = (screenX - scene.offsetLeft) / scene.zoom - x;
  const scrollY = (screenY - scene.offsetTop) / scene.zoom - y;
  await evaluate(`window.__captureApi.updateScene({ appState: { scrollX: ${scrollX}, scrollY: ${scrollY} } })`);
  await sleep(400);
}

/**
 * The observation typed into the block for the picture.
 *
 * About a real thing, in the register a reader would write in, and short enough that the
 * block does not have to grow to hold it — a grown block is a fine thing for the product to
 * do and a distraction in a picture of what the block is.
 */
const OBSERVATION = 'Pressing Escape while the search field is open closes the whole '
  + 'panel instead of just the field.';

/**
 * The top-left corner of the welcome board, in scene coordinates.
 *
 * `docs/welcome.excalidraw` spans (80, 20) to (2404, 590). Read off the file rather than
 * computed from the scene, because the second picture edits the board and the first one has
 * to be framed the same way whether it is taken before or after.
 */
const BOARD_LEFT = 80;
const BOARD_TOP = 20;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=2560,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  // Wide enough for the whole welcome board at the zoom it was written at — 2324 px of it —
  // so that the second region's title is in frame rather than sliced down the middle. The
  // board fits itself on load and will not shrink below 100%, which is the point: this is
  // what the product puts on screen, not a smaller drawing of it.
  await frame(2500, 850, 1.5);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).count > 0, 'the welcome board to render');
  // The board fits itself on load, and the fonts settle a beat after the shapes do: a label
  // measured before the font has loaded is a label with its last characters clipped off.
  await evaluate('document.fonts.ready');
  await sleep(2500);

  // Nudged down off the fit, so that Excalidraw's own toolbar — which floats at the top of the
  // canvas and belongs in the picture — is not sitting across the second region's title.
  await placeAt(BOARD_LEFT, BOARD_TOP, 88, 195);
  await shot('first-run-welcome-board');

  // ─── The issue block, with an observation in it ─────────────

  let scene = await evaluate(PROBE);
  if (!scene.block) throw new Error('the welcome board has no issue block on it');

  const centre = toViewport(scene, scene.block.x + scene.block.w / 2, scene.block.y + scene.block.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(400);
  if (!(await evaluate(PROBE)).editorOpen) throw new Error('the double click did not open the label editor');
  // The first character replaces the template's placeholder, so what is left on screen is the
  // observation and nothing else.
  await typeText(OBSERVATION);
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(600);
  await evaluate('window.__captureApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);

  // A closer frame, because this picture is about one block and the panel beside it rather
  // than about a whole board.
  await frame(1500, 680, 2);
  await sleep(600);
  scene = await evaluate(PROBE);
  // Clear of Excalidraw's properties island, which is on screen precisely because something is
  // selected and would otherwise sit across the left half of the block being shown.
  await placeAt(scene.block.x, scene.block.y, 270, 245);

  // Selected rather than clicked: a click lands somewhere, and where it lands is the thing
  // this picture is not about. The panel opens on selection either way.
  await evaluate(`window.__captureApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(scene.block.id)}: true } } })`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.element-docs'))`), 'the issue panel');
  await sleep(1200);

  await shot('issue-block-panel');
} finally {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  if (!process.argv.includes('--keep')) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows lock */ }
  } else {
    console.log(`kept ${workDir}`);
  }
}
