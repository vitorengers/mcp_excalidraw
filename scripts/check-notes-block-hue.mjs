#!/usr/bin/env node
/**
 * Checks that a block written under the notes column is drawn in that column's own hue.
 *
 * Two rules used to meet here and disagree. A column header takes its stroke from where the
 * column sits — the notes column is always the first, so always `COLUMN_STROKES[0]` — while a
 * block took its colours from its stage, a yellow ramp that knows nothing about columns. The
 * notes column is the one place on the board where those two populations stack under one
 * header, and the reader read them as one thing, reasonably: visually they are one.
 *
 * So the first stage is now the notes column's hue, and the reading #54 bought is kept — the
 * second stage is the first one step down the same ramp, with the outline closing.
 *
 * **The header's stroke is read out of the layout, never retyped here.** A hex copied into
 * this file would let the two drift apart quietly, which is the whole defect one level up: a
 * check that agrees with the code only because it was typed the same way cannot fail when
 * somebody reorders the palette.
 *
 * Three parts, and the last one needs a browser because `CLAUDE.md` is explicit that
 * compiling is not working:
 *
 * 1. Offline, against `dist/`: the mapping, the layout and the library all agree.
 * 2. Offline: a board saved before this change is repainted when it is read back, rather
 *    than coming up orange under a blue header for ever.
 * 3. In a real Chrome, against a real board: the `+` drops a block, and the pixels on the
 *    screen are the ones the header is drawn in. Colour is the one thing a type check has
 *    nothing to say about.
 *
 * The browser half is self-contained: a stub `gh`, its own canvas server on its own port,
 * and both killed at the end. It is skipped, not failed, on a machine with no Chrome.
 * Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — the offline
 * halves read the compiled modules and the browser half loads the built frontend.
 *
 * Usage: node scripts/check-notes-block-hue.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** A compiled module, or null with a failure recorded, so a first run reports everything. */
async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    failures++;
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(modulePath).href);
}

const appearance = await importDist(join('core', 'issue-appearance.js'), 'the issue appearance mapping');
const layout = await importDist(join('core', 'project-board-layout.js'), 'the mirror layout');
const types = await importDist(join('core', 'project-board-types.js'), 'the reserved notes column');
const seed = await importDist(join('core', 'board-seed.js'), 'the board seed');

if (!appearance?.issueBlockAppearance || !layout?.layoutBoard || !types?.NOTES_OPTION_ID) {
  console.error('\nnothing to check against — the compiled modules are missing pieces');
  process.exit(1);
}

const DRAFT = appearance.issueBlockAppearance('draft');
const CREATED = appearance.issueBlockAppearance('created');

// ─── 1. The block, the column and the library agree ───────────

console.log('1. the notes column\'s hue is the hue of the blocks in it');

/** A project board with the notes column in front, laid out the way the canvas lays one out. */
function board(sections) {
  return {
    projectId: 'PVT_hue',
    projectTitle: 'Hue check',
    projectUrl: 'https://github.com/users/someone/projects/5',
    fieldId: 'PVTSSF_hue',
    fieldName: 'Stage',
    sections,
    morePages: false,
  };
}

const card = (number) => ({
  itemId: `PVTI_${number}`,
  contentType: 'Issue',
  number,
  title: `Issue number ${number}`,
  url: `https://github.com/vitorengers/vibemaxxing/issues/${number}`,
  state: 'OPEN',
  createdAt: '2026-07-01T00:00:00Z',
  repository: 'vitorengers/vibemaxxing',
  draggable: true,
});

const mirrored = layout.layoutBoard(
  board([layout.notesSection(), { optionId: 'opt-todo', name: 'Icebox', cards: [card(1)], hidden: 0 }]),
  { x: 0, y: 0 }
);

const roleOf = (elements, role, optionId) => elements.find((element) =>
  element.customData?.role === role
  && (optionId === undefined || element.customData?.sectionOptionId === optionId));

const notesHeader = roleOf(mirrored.elements, 'section', types.NOTES_OPTION_ID);
const plus = roleOf(mirrored.elements, 'add');

check('the layout draws a header for the notes column', Boolean(notesHeader),
      JSON.stringify(mirrored.elements.map((element) => element.customData?.role)));
check('and the + on it', Boolean(plus) && plus?.customData?.sectionOptionId === types.NOTES_OPTION_ID,
      JSON.stringify(plus?.customData));

check('a block with no issue behind it is drawn in the stroke of the header it sits under',
      DRAFT.strokeColor === notesHeader?.strokeColor,
      `block ${DRAFT.strokeColor} vs header ${notesHeader?.strokeColor}`);
check('so the + and the block it drops are the same colour',
      DRAFT.strokeColor === plus?.strokeColor,
      `block ${DRAFT.strokeColor} vs + ${plus?.strokeColor}`);

// The fill the layout gives the first column, read off a card in it. The notes column holds
// no cards by construction, so the tint it computes lands on nothing there — which is what
// made `COLUMN_FILLS[0]` a colour this board calculated and never showed anybody.
const firstColumn = layout.layoutBoard(
  board([{ optionId: 'opt-first', name: 'Icebox', cards: [card(2)], hidden: 0 }]),
  { x: 0, y: 0 }
);
const firstCard = firstColumn.elements.find((element) => element.customData?.role === 'card');
const firstHeader = roleOf(firstColumn.elements, 'section');

check('the notes column is the first column, so it takes the first hue',
      Boolean(firstHeader) && firstHeader.strokeColor === notesHeader?.strokeColor,
      `${firstHeader?.strokeColor} vs ${notesHeader?.strokeColor}`);
check('and a block is filled with the tint that column gives its cards',
      Boolean(firstCard) && DRAFT.backgroundColor === firstCard.backgroundColor,
      `block ${DRAFT.backgroundColor} vs column ${firstCard?.backgroundColor}`);

console.log('\n2. and the stage is still read off the same block');

const channels = (hex) => [1, 3, 5].map((at) => parseInt(String(hex).slice(at, at + 2), 16));
/** Which channel leads, and which follows: the same order twice is the same hue family. */
const rank = (hex) => channels(hex)
  .map((value, index) => [value, index])
  .sort((left, right) => right[0] - left[0])
  .map(([, index]) => index)
  .join('');
const darker = (from, to) => {
  const [fr, fg, fb] = channels(from);
  const [tr, tg, tb] = channels(to);
  return tr <= fr && tg <= fg && tb <= fb && (tr < fr || tg < fg || tb < fb);
};

check('a block with no issue behind it is dashed', DRAFT.strokeStyle === 'dashed', DRAFT.strokeStyle);
check('one that produced an issue is solid', CREATED.strokeStyle === 'solid', CREATED.strokeStyle);
check('the second stage is one step down the same ramp, not another colour',
      rank(DRAFT.strokeColor) === rank(CREATED.strokeColor) && darker(DRAFT.strokeColor, CREATED.strokeColor),
      `${DRAFT.strokeColor} -> ${CREATED.strokeColor}`);
check('and so is its fill',
      rank(DRAFT.backgroundColor) === rank(CREATED.backgroundColor)
      && darker(DRAFT.backgroundColor, CREATED.backgroundColor),
      `${DRAFT.backgroundColor} -> ${CREATED.backgroundColor}`);

// The library is the only definition of the first stage a dragged-in block ever sees. A
// mapping that disagreed with it would repaint every block the first time anything touched it.
const library = JSON.parse(readFileSync(join(repoRoot, 'docs', 'blocks.excalidrawlib'), 'utf8'));
const shipped = library.libraryItems
  .flatMap((item) => item.elements ?? [])
  .find((element) => element?.customData?.kind === 'issue');
check('the library ships a block in the column\'s hue too',
      shipped?.strokeColor === DRAFT.strokeColor
      && shipped?.backgroundColor === DRAFT.backgroundColor
      && shipped?.strokeStyle === DRAFT.strokeStyle,
      JSON.stringify({ shipped: shipped?.strokeColor, mapped: DRAFT.strokeColor }));

// ─── 3. A board written before the change ─────────────────────

console.log('\n3. blocks written before the change are repainted, not left behind');

/** What a block on a board saved before this change carries: the old yellow ramp. */
const WAS = {
  draft: { strokeColor: '#f08c00', backgroundColor: '#fff9db', strokeStyle: 'dashed' },
  created: { strokeColor: '#e67700', backgroundColor: '#fff3bf', strokeStyle: 'solid' },
};

if (seed?.parseBoardScene) {
  const saved = JSON.stringify({
    type: 'excalidraw',
    version: 2,
    elements: [
      { id: 'old-draft', type: 'rectangle', x: 0, y: 0, width: 400, height: 140, ...WAS.draft,
        customData: { kind: 'issue', projectBoardDraft: true, sectionOptionId: types.NOTES_OPTION_ID } },
      { id: 'old-created', type: 'rectangle', x: 0, y: 200, width: 400, height: 140, ...WAS.created,
        customData: { kind: 'issue', issueState: 'created',
                      issueUrl: 'https://github.com/vitorengers/vibemaxxing/issues/54' } },
      { id: 'not-a-block', type: 'rectangle', x: 0, y: 400, width: 100, height: 100, ...WAS.draft,
        customData: { docKey: 'issue-block' } },
    ],
    files: {},
  });
  const read = seed.parseBoardScene(saved);
  const byId = new Map(read.elements.map((element) => [element.id, element]));

  const oldDraft = byId.get('old-draft');
  check('a draft saved in the old hue comes back in the new one',
        oldDraft?.strokeColor === DRAFT.strokeColor && oldDraft?.backgroundColor === DRAFT.backgroundColor,
        `${oldDraft?.strokeColor} / ${oldDraft?.backgroundColor}`);
  check('and it is still dashed, because it still has no issue behind it',
        oldDraft?.strokeStyle === 'dashed', oldDraft?.strokeStyle);

  const oldCreated = byId.get('old-created');
  check('a block that produced an issue comes back one step down the new ramp',
        oldCreated?.strokeColor === CREATED.strokeColor
        && oldCreated?.backgroundColor === CREATED.backgroundColor,
        `${oldCreated?.strokeColor} / ${oldCreated?.backgroundColor}`);
  check('with the issue it produced untouched',
        oldCreated?.customData?.issueState === 'created'
        && oldCreated?.customData?.issueUrl?.endsWith('/54'),
        JSON.stringify(oldCreated?.customData));

  // Repainting the board's own shapes would be this change reaching a long way past what it
  // was asked about. Only a block is a block.
  const other = byId.get('not-a-block');
  check('a shape that is not a block keeps whatever it was drawn in',
        other?.strokeColor === WAS.draft.strokeColor && other?.backgroundColor === WAS.draft.backgroundColor,
        `${other?.strokeColor} / ${other?.backgroundColor}`);
} else {
  failures++;
  console.error('  FAIL  parseBoardScene is exported');
}

// ─── 4. On a real board, in a real browser ────────────────────

const chromePath = findChrome();
const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');

// A missing browser and a missing `dist/frontend` are answered separately since #273: the
// first is the shared probe's, and exit 3 under --strict is what makes it countable.
if (!chromePath) {
  skipWithoutChrome({ lead: '\n4. ', failures, after: () => console.log('\nall offline cases passed') });
}
if (!existsSync(frontend)) {
  console.log('\n4. SKIPPED — dist/frontend/index.html not found, so the browser half was not run');
  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall offline cases passed');
  process.exit(0);
}

console.log('\n4. the + drops a block the colour of the bar above it, on screen');

const workDir = mkdtempSync(join(tmpdir(), 'check-notes-hue-'));
const projectDir = join(workDir, 'notes-hue');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO] },
    items: { pageInfo: { hasNextPage: false }, nodes: [] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'notes-hue', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Notes Hue',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
  STUB_GH_FIXTURE: fixturePath,
  // The `+` drops a block *from the library*, so without one every click is a silent no-op.
  EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
};
// Nothing this machine exports reaches the child: `scripts/lib/spawn-canvas.mjs` strips every
// `EXCALIDRAW_*` before the check's own values go in, so there is no terminal block over the
// board — and no other inherited setting — unless this check asks for it.

let serverLog = '';
const server = startCanvas({
  env: serverEnv,
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

let socket = null;
let nextId = 1;
const pending = new Map();
const consoleLog = [];

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
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? []).map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
      consoleLog.push(`${message.params.type}: ${text}`);
      return;
    }
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
 * One point of the screen, decoded from a 1×1 screenshot.
 *
 * The declared colour is not the question. Excalidraw ships dark mode as a filter on the
 * canvas, so a scene element is declared one way and painted another, and a check that
 * compared a field against a hex would agree with itself while the screen showed something
 * else (#147). This asks the screen.
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

async function pixelAt(x, y) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1, scale: 1 },
  });
  return decodePng(Buffer.from(data, 'base64'))(0, 0);
}

const rgbOf = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const apart = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
const asHex = (rgb) => `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(150);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The scene as the canvas holds it, reached through the container's React fibre. */
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
        window.__boardCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], add: null, notesHeader: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        stroke: element.strokeColor, fill: element.backgroundColor,
                        style: element.strokeStyle });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height, col: custom.sectionOptionId };
    }
    if (custom.kind === 'project-board' && custom.role === 'section'
        && custom.sectionOptionId === ${JSON.stringify(types.NOTES_OPTION_ID)}) {
      out.notesHeader = { x: element.x, y: element.y, w: element.width, h: element.height,
                          stroke: element.strokeColor };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.theme = state.theme;
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

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
    '--force-device-scale-factor=1',
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view. Pressed
  // once: every coordinate below is computed from the view it settles on.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  check('the mirror is up, with the + on the notes column and nothing under it',
        scene.add?.col === types.NOTES_OPTION_ID && scene.drafts.length === 0,
        `${JSON.stringify(scene.add)} / ${scene.drafts.length} drafts`);

  const at = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
  await click(at.x, at.y);
  await waitFor(async () => (await evaluate(PROBE)).drafts.length === 1, 'the + to drop a block');
  await sleep(600);
  scene = await evaluate(PROBE);
  await shot('02-block-under-the-header');

  let block = scene.drafts[0];
  check('the block the + dropped is stroked like the header above it',
        Boolean(block) && Boolean(scene.notesHeader) && block.stroke === scene.notesHeader.stroke,
        `block ${block?.stroke} vs header ${scene.notesHeader?.stroke}`);
  check('and it is the colour the mapping says, so nothing repainted it on the way',
        block?.stroke === DRAFT.strokeColor && block?.fill === DRAFT.backgroundColor,
        `${block?.stroke} / ${block?.fill}`);

  // Nothing selected before anything is read off the screen. A block is selected the moment
  // it is dropped, and a selection puts Excalidraw's properties island over the left of the
  // canvas and this project's own panel over the right — both DOM overlays, both painted
  // exactly where the notes column is drawn, and a sample that lands on one reports the
  // island's white rather than the board.
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(800);
  scene = await evaluate(PROBE);
  await shot('03-deselected');
  block = scene.drafts[0];

  // What is on the screen, not what the element says. Above the label, which is centred in
  // the block, and well inside the outline, which is drawn rough.
  const declared = rgbOf(DRAFT.backgroundColor);
  const inside = toViewport(scene, block.x + block.w * 0.5, block.y + block.h * 0.15);
  const painted = await pixelAt(inside.x, inside.y);
  check('and the pixels inside it are that colour on screen',
        apart(painted, declared) <= 8,
        `screen ${asHex(painted)} vs ${DRAFT.backgroundColor} (theme ${scene.theme})`);

  // The gap between the header and the block, which is board and nothing else. Without it
  // the case above would pass just as happily on a block that was never filled in.
  const gap = toViewport(scene, block.x + block.w * 0.5,
                         (scene.notesHeader.y + scene.notesHeader.h + block.y) / 2);
  const behind = await pixelAt(gap.x, gap.y);
  check('the block is drawn against a background it is telling apart from',
        apart(painted, behind) > 8, `block ${asHex(painted)} vs board ${asHex(behind)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) {
  if (consoleLog.length) console.error(`\nthe page said:\n  ${consoleLog.slice(-30).join('\n  ')}`);
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
