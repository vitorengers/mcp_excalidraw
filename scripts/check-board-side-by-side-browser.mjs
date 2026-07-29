#!/usr/bin/env node
/**
 * Checks that this board's two sections stand side by side, and that both keys still land.
 *
 * The board was drawn as one column: Project structure on top, Development 1892 below it,
 * both at the same `x` and the same width. Reading it meant scrolling the whole height of
 * the board to get from what the tool *is* to how it got that way, and the canvas has room
 * to the right that nothing was using. #217 puts them beside each other instead —
 * `Project structure | Development`, tops level.
 *
 * Nothing in the code lays a section out: `src/core/board-sections.ts` reads the marks off
 * whatever a board declares and returns bindings. So this is board data, and what is worth
 * holding is what the data has to keep being true about itself:
 *
 *   - the two sections share a top edge, do not overlap, and Project structure's right edge
 *     is at or left of Development's left edge;
 *   - every card with a document still sits inside one of them;
 *   - both keys still resolve, to the section each is meant to reach. This is the case that
 *     the move puts at risk in a way the geometry does not show: the resolver sorts
 *     `(a.y - b.y) || (a.x - b.x)`, so with equal `y` the tie-break falls through to `x` and
 *     "the section higher on the board" quietly becomes "the leftmost". Asserted rather than
 *     observed.
 *
 * Then the part only a browser can answer. `Alt+P` and `Alt+G` are `scrollToContent` onto a
 * shape, and a board twice as wide is a different fit: #185 is this project's record of a
 * fit that type-checked, looked right in the numbers and drew the 13px card body at 6px. So
 * the whole-board fit is measured **off the screenshot** — the distance in real pixels
 * between Project structure's left border and Development's right border, over the width
 * those two are authored at — rather than read back out of `appState`, which is the number
 * the page believes rather than the one it painted.
 *
 * The window is 2560x1440 on purpose: that is the display #185 was reported on, and the
 * question the side-by-side board raises is whether widening the content past it costs the
 * fit its 100%. At this size the board is 2324 wide against a ~2544 canvas, so the floor is
 * still 1 — stated here, and checked, so that a board that grows wider than the display goes
 * red here instead of arriving as "the writing is blurry" again.
 *
 * The geometry runs with or without Chrome. Only the browser half is skipped when there is
 * none. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first: the
 * resolver is a compiled module and the page is the built frontend.
 *
 * Usage: node scripts/check-board-side-by-side-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const STRUCTURE = 'Project structure';
const DEVELOPMENT = 'Development';

// ─── 1. The board file: two sections, beside each other ───────

const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
const boardPath = resolve(repoRoot, config.board);
const scene = JSON.parse(readFileSync(boardPath, 'utf8'));
const elements = (scene.elements ?? []).filter((element) => !element.isDeleted);

const customOf = (element) => element?.customData ?? {};
const boxOf = (element) => ({
  id: element.id,
  minX: element.x,
  minY: element.y,
  maxX: element.x + element.width,
  maxY: element.y + element.height,
  w: element.width,
  h: element.height,
});
const show = (box) => `${box.minX},${box.minY} ${box.w}x${box.h}`;

const sections = elements.filter((element) => customOf(element).kind === 'board-section');
const byTitle = new Map(sections.map((element) => [customOf(element).title, element]));

console.log(`1. ${STRUCTURE} and ${DEVELOPMENT} stand side by side`);
check('the board declares both sections',
      byTitle.has(STRUCTURE) && byTitle.has(DEVELOPMENT),
      `found ${[...byTitle.keys()].map((title) => JSON.stringify(title)).join(', ') || 'none'}`);

let structure = null;
let development = null;
if (byTitle.has(STRUCTURE) && byTitle.has(DEVELOPMENT)) {
  structure = boxOf(byTitle.get(STRUCTURE));
  development = boxOf(byTitle.get(DEVELOPMENT));

  // Level tops rather than centred: the two are very different heights, and a section whose
  // title starts halfway down the screen reads as a section somebody forgot to align.
  check('they share a top edge', Math.abs(structure.minY - development.minY) < 0.5,
        `${STRUCTURE} at y ${structure.minY}, ${DEVELOPMENT} at y ${development.minY}`);
  check(`${STRUCTURE} ends at or before ${DEVELOPMENT} begins`,
        structure.maxX <= development.minX,
        `${structure.maxX} against ${development.minX}`);
  check('and the two do not overlap',
        structure.maxX <= development.minX || development.maxX <= structure.minX
        || structure.maxY <= development.minY || development.maxY <= structure.minY,
        `${show(structure)} against ${show(development)}`);
  // The whole point of the move: they are beside each other rather than stacked, so the
  // vertical bands they occupy have to overlap. A section pushed right *and* down would
  // satisfy every rule above and still be a column.
  check('and they are read across rather than down',
        Math.min(structure.maxY, development.maxY) > Math.max(structure.minY, development.minY),
        `${show(structure)} against ${show(development)}`);
}

console.log('\n2. every card is still inside a section, and each key still reaches its own');
const encloses = (section, element) =>
  section.x <= element.x
  && section.y <= element.y
  && section.x + section.width >= element.x + element.width
  && section.y + section.height >= element.y + element.height;

const homeless = elements
  .filter((element) => typeof customOf(element).docKey === 'string' && customOf(element).docKey)
  .filter((element) => !sections.some((section) => encloses(section, element)));
check('no card with a document was left behind by the move', homeless.length === 0,
      `${homeless.length}: ${homeless.map((element) => customOf(element).docKey).join(', ')}`);

// A card is not the only thing a section holds. Anything that was inside Development before
// the move — its title, the bodies beside the cards — has to have come with it, or the move
// moved the box and left the contents on the old canvas.
if (structure && development) {
  const inside = (box, element) =>
    box.minX <= element.x && box.minY <= element.y
    && box.maxX >= element.x + element.width && box.maxY >= element.y + element.height;
  const loose = elements.filter((element) =>
    customOf(element).kind !== 'board-section'
    && !inside(structure, element) && !inside(development, element));
  // The board's own title and strapline stand above both sections and always have.
  check('nothing but the board title is outside both sections', loose.length <= 2,
        `${loose.length}: ${loose.map((element) => `${element.id} at ${element.x},${element.y}`).join('; ')}`);
}

const modulePath = join(repoRoot, 'dist', 'core', 'board-sections.js');
if (!existsSync(modulePath)) {
  failures++;
  console.error('  FAIL  the section resolver is compiled — dist/core/board-sections.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
} else {
  const { resolveBoardSectionHotkeys } = await import(pathToFileURL(modulePath).href);
  const { bindings, ignored } = resolveBoardSectionHotkeys(elements);
  const boundTo = (title) => bindings.find((binding) => binding.title === title)?.code ?? null;
  // The tie-break at `(a.y - b.y) || (a.x - b.x)` now decides on `x`, because the two `y` are
  // equal. Nothing about the *binding* may change for it: each key goes where it went.
  check(`${STRUCTURE} still answers to Alt+P`, boundTo(STRUCTURE) === 'KeyP',
        JSON.stringify(bindings));
  check(`${DEVELOPMENT} still answers to Alt+G`, boundTo(DEVELOPMENT) === 'KeyG',
        JSON.stringify(bindings));
  check('and nothing is thrown away', ignored.length === 0, JSON.stringify(ignored));
}

// ─── Chrome, or an honest skip ────────────────────────────────

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
const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');

if (!chromePath || !existsSync(frontend)) {
  console.log(`\nSKIPPED — the browser half did not run: ${
    chromePath ? 'dist/frontend/index.html not found (run ./node_modules/.bin/vite build)'
               : 'no Chrome or Edge found (pass --chrome <path> or set CHROME_PATH)'}`);
  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nthe board-file cases passed');
  process.exit(0);
}

// ─── A throwaway board, seeded from the one this repository ships ──

const workDir = mkdtempSync(join(tmpdir(), 'check-board-side-by-side-'));
const projectDir = join(workDir, 'board-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

copyFileSync(boardPath, join(projectDir, 'board.excalidraw'));

// Two projects, because the fit this check is about only happens on a board that *lands*.
// An ordinary page load leaves the camera where a load has always put it — #185's second
// half is that a board with no remembered camera is not fitted at mount, on purpose. So the
// board is reached the way a reader reaches it: by clicking its tab. Alpha opens first
// because it is first in the registry.
const otherDir = join(workDir, 'alpha-project');
mkdirSync(otherDir, { recursive: true });
const registryPath = join(workDir, 'workspaces.json');
const OTHER = 'alpha-project';
const WORKSPACE = 'board-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: OTHER, path: otherDir.replace(/\\/g, '/') },
    { id: WORKSPACE, path: projectDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so the only thing on this canvas is
// the board itself and every bound measured here is the board's own.
writeFileSync(join(otherDir, 'board.config.json'), JSON.stringify({
  name: 'Alpha',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Board',
  repo: 'vitorengers/mcp_excalidraw',
  board: 'board.excalidraw',
}), 'utf8');

/** The display #185 was reported on. The floor this check states is the floor at this size. */
const WINDOW = { width: 2560, height: 1440 };

const PORT = 36400 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

// The terminal block is deleted out of the child's environment on purpose: this machine's
// shell exports EXCALIDRAW_TERMINAL=1, and a terminal block would put an extra shape into
// the scene bounds every fit here is measured against, and a DOM overlay over the canvas.
const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_BOARD_STATE: join(workDir, 'board-state'),
};
delete serverEnv.EXCALIDRAW_TERMINAL;

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: serverEnv,
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

async function shot(name, clip = undefined) {
  const { data } = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const buffer = Buffer.from(data, 'base64');
  writeFileSync(join(shotDir, `${name}.png`), buffer);
  return buffer;
}

async function pressKey(code, key, modifiers, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
}

/** Alt and a letter, which is what a section's `hotkeyCode` means on the page. */
const altPress = async (code, key, virtualKey) => {
  await pressKey(code, key, 1, virtualKey);
  // scrollToContent animates; the assertion is about where it lands, not how it gets there.
  await sleep(1600);
};

/** The imperative API, through the container's React fibre. See check-board-zoom-browser. */
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
        window.__sideBySideApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__sideBySideApi;
  if (!api) return { error: 'no api handle' };
  const out = { sections: {}, boxes: [] };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    const custom = element.customData || {};
    const box = { x: element.x, y: element.y, w: element.width, h: element.height };
    out.boxes.push(box);
    if (custom.kind === 'board-section') out.sections[custom.title] = box;
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.dpr = window.devicePixelRatio;
  out.active = (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null;
  return out;
})()`;

/** Click the tab with this name on it. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

const toScreenX = (view, x) => (x + view.scrollX) * view.zoom + view.offsetLeft;
const toScreenY = (view, y) => (y + view.scrollY) * view.zoom + view.offsetTop;
const toSceneY = (view, y) => (y - view.offsetTop) / view.zoom - view.scrollY;

const boundsOf = (boxes) => ({
  minX: Math.min(...boxes.map((box) => box.x)),
  minY: Math.min(...boxes.map((box) => box.y)),
  maxX: Math.max(...boxes.map((box) => box.x + box.w)),
  maxY: Math.max(...boxes.map((box) => box.y + box.h)),
});

/**
 * The floor the fit is not allowed to go below, for content this wide.
 *
 * The rule the frontend applies, restated here rather than imported: a check that asks the
 * code under test what the answer should be cannot be red.
 */
const floorFor = (view, contentWidth) => Math.min(1, view.width / contentWidth);

// ─── Pixels, as the screen really has them ────────────────────

/**
 * Enough of a PNG decoder to read a clipped screenshot back. See check-terminal-paper-browser.
 *
 * Eight-bit, colour type 2 or 6, which is all Chrome emits; the five row filters are all
 * handled because which one it picks for a given strip is its business, not ours.
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
    at: (x, y) => {
      const base = y * stride + x * lanes;
      return [out[base], out[base + 1], out[base + 2]];
    },
  };
}

/** Anything that is not the board's white paper. A stroke is far below this; paper is 255. */
const INK = 200;
const isInk = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b < INK;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  await waitFor(async () => {
    const response = await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`);
    const body = await response.json();
    return (body.elements ?? body ?? []).length > 50;
  }, 'the board to be seeded from the file');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).active, 'a board to be in front');
  await selectTab('Board');
  await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.sections?.[STRUCTURE] && probe.sections?.[DEVELOPMENT] ? probe : null;
  }, 'both sections to reach the canvas');
  await sleep(1600);   // the first-visit fit animates

  console.log('\n3. the whole board still opens at the size it was written at');
  let probe = await evaluate(PROBE);
  await shot('01-whole-board');
  const whole = boundsOf(probe.boxes);
  // Said out loud, because everything below it is a measurement of where the fit put the
  // board: a page still sitting at 0, 0 would measure a board half off the side of the
  // canvas and call the missing part a smaller zoom.
  check('the board was fitted when it landed, not left at the origin',
        probe.view.scrollX !== 0 || probe.view.scrollY !== 0,
        `${JSON.stringify(probe.view)} on ${probe.active}`);
  const wholeWidth = whole.maxX - whole.minX;
  const wholeFloor = floorFor(probe.view, wholeWidth);
  check('the canvas is the width #185 was reported at', probe.view.width > 2400,
        `${probe.view.width} x ${probe.view.height}`);
  check('the side-by-side board still fits it at 100%', wholeFloor >= 1 - 0.001,
        `${wholeWidth.toFixed(1)} wide against a ${probe.view.width} canvas — floor ${wholeFloor.toFixed(3)}`);
  check('and it is taller than the canvas, so this is the fit the floor is protecting',
        probe.view.height / (whole.maxY - whole.minY) < wholeFloor,
        `height fit ${(probe.view.height / (whole.maxY - whole.minY)).toFixed(3)}`);

  // Measured off the screen rather than read out of appState. A strip of real pixels taken
  // across both sections at once: the distance between their outermost borders, over the
  // width the two are authored at, *is* the zoom — and the same strip is what proves they
  // are side by side, because one horizontal line crosses both.
  const left = probe.sections[STRUCTURE];
  const right = probe.sections[DEVELOPMENT];
  const authored = (right.x + right.w) - left.x;
  const band = {
    top: Math.max(left.y, right.y),
    bottom: Math.min(left.y + left.h, right.y + right.h),
  };
  check('a single horizontal line crosses both sections', band.bottom > band.top,
        `${JSON.stringify(band)}`);

  // A strip rather than a single line, because a section's border is **dashed**: any one row
  // can fall in a gap, and a gap read as "no border there" would move the measurement 20
  // units in to the first card instead — a 3% error that looks exactly like a fit that
  // shrank. STRIP_ROWS is far more than one dash.
  const STRIP_ROWS = 48;
  const stripTop = Math.round(Math.min(
    Math.max(toScreenY(probe.view, (band.top + band.bottom) / 2) - STRIP_ROWS / 2, 200),
    probe.view.height - 120 - STRIP_ROWS
  ));
  const sceneTop = toSceneY(probe.view, stripTop);
  const sceneBottom = toSceneY(probe.view, stripTop + STRIP_ROWS);
  check('and that strip is on screen, inside the band',
        sceneTop > band.top && sceneBottom < band.bottom,
        `strip at scene y ${sceneTop.toFixed(1)}..${sceneBottom.toFixed(1)}, band ${band.top}..${band.bottom}`);

  const SLACK = 34;
  const clipX = Math.max(0, Math.round(toScreenX(probe.view, left.x) - SLACK));
  const clipRight = Math.min(probe.view.width, Math.round(toScreenX(probe.view, right.x + right.w) + SLACK));
  const strip = decodePng(await shot('02-the-strip', {
    x: clipX, y: stripTop, width: clipRight - clipX, height: STRIP_ROWS, scale: 1,
  }));

  // The leftmost ink anywhere in the strip is Project structure's left border: the nearest
  // card inside the section is 20 units further in, and there is nothing at all outside it.
  // The rightmost ink is Development's right border, for the same reason.
  let leftEdge = null;
  let rightEdge = null;
  for (let x = 0; x < strip.width; x++) {
    for (let y = 0; y < strip.height; y++) {
      if (!isInk(strip.at(x, y))) continue;
      if (leftEdge === null) leftEdge = x;
      rightEdge = x;
      break;
    }
  }
  const inkReport = `ink from ${leftEdge} to ${rightEdge} in a ${strip.width} px strip clipped at ${clipX}`
    + ` (borders expected at ${(toScreenX(probe.view, left.x) - clipX).toFixed(1)}`
    + ` and ${(toScreenX(probe.view, right.x + right.w) - clipX).toFixed(1)})`;
  check('both outer borders are painted in that strip', leftEdge !== null && rightEdge !== null
        && leftEdge < 2 * SLACK && rightEdge > strip.width - 2 * SLACK, inkReport);
  console.log(`        ${inkReport}`);

  if (leftEdge !== null && rightEdge !== null) {
    const painted = (rightEdge - leftEdge) / (probe.dpr || 1);
    const measured = painted / authored;
    check('the zoom the screen was painted at is at or above the floor',
          measured >= wholeFloor - 0.02,
          `${painted.toFixed(1)} px across ${authored} authored units = ${measured.toFixed(3)}, floor ${wholeFloor.toFixed(3)}`);
    check('and it agrees with what the page believes it is drawing at',
          Math.abs(measured - probe.view.zoom) < 0.02,
          `screen ${measured.toFixed(3)}, appState ${probe.view.zoom.toFixed(3)}`);
  }

  console.log('\n4. each key still lands on its own section');
  // Parked a long way off, so "it is in view" is not just where the board happened to open.
  await evaluate('window.__sideBySideApi.updateScene({ appState: { scrollX: -5200, scrollY: -4200, zoom: { value: 0.4 } } })');
  await sleep(500);

  // Side by side on a 2560 canvas, one section in view means part of the other is too — the
  // board is only 2324 wide altogether. So the question is not which one is visible, it is
  // which one the key *landed on*: where the middle of the screen ended up.
  const landedOn = (view) => {
    const centre = (view.width / 2 - view.offsetLeft) / view.zoom - view.scrollX;
    if (centre >= left.x && centre <= left.x + left.w) return STRUCTURE;
    if (centre >= right.x && centre <= right.x + right.w) return DEVELOPMENT;
    return `neither (scene x ${centre.toFixed(1)})`;
  };
  const wholeOnScreen = (view, box) =>
    toScreenX(view, box.x) >= -1 && toScreenX(view, box.x + box.w) <= view.width + 1;

  await altPress('KeyP', 'p', 80);
  probe = await evaluate(PROBE);
  await shot('03-alt-p');
  check(`Alt+P lands on ${STRUCTURE}`, landedOn(probe.view) === STRUCTURE, landedOn(probe.view));
  check('with the whole of it between the sides of the canvas', wholeOnScreen(probe.view, left),
        JSON.stringify(probe.view));

  await altPress('KeyG', 'g', 71);
  probe = await evaluate(PROBE);
  await shot('04-alt-g');
  check(`Alt+G lands on ${DEVELOPMENT}`, landedOn(probe.view) === DEVELOPMENT, landedOn(probe.view));
  check('with the whole of it between the sides of the canvas', wholeOnScreen(probe.view, right),
        JSON.stringify(probe.view));
  check(`and it moved the board: ${DEVELOPMENT} is not where ${STRUCTURE} was`,
        Math.abs(right.x - left.x) > 100, `${left.x} against ${right.x}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
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
