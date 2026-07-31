#!/usr/bin/env node
/**
 * Checks the mirror's anchor in a real browser.
 *
 * `check-mirror-anchor.mjs` covers the arithmetic; this covers what the arithmetic is wired
 * to, which is the half `CLAUDE.md` is explicit about — three defects in this UI layer
 * compiled perfectly and did none of what they claimed. The region is placed from inside a
 * poll that runs every twenty seconds, and the whole of #99 is about what that poll does to
 * a placement, so a check that never lets one run has not asked the question.
 *
 * Four things only a browser settles:
 *
 *   - a column appearing on GitHub does not move the columns that were already drawn, the
 *     `+` among them — the poll really reads the remembered origin rather than measuring
 *     again;
 *   - an element dropped far above and to the left of everything, which used to drag the
 *     whole region along with it on the next poll, moves nothing;
 *   - `Alt+B` still brings the region into view, which is the only way back to it;
 *   - a card still drags between columns and the move still reaches `gh`.
 *
 * The project is a stub `gh` answering from a file, so a column can be added to it without
 * touching anybody's real board — and adding one there would not be cheap either:
 * `updateProjectV2Field` rewrites the whole option list, and every item's Status is stored
 * against an option id (`docs/project-board.md`).
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes the stub, starts its own canvas server against a
 * throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * It waits out real twenty-second polls, so it takes about a minute and a half.
 *
 * Usage: node scripts/check-mirror-anchor-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const typesPath = join(repoRoot, 'dist', 'core', 'project-board-types.js');
if (!existsSync(typesPath)) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-types.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
/** The canvas's own column, read from the module that reserves it rather than spelled out. */
const NOTES = await import(pathToFileURL(typesPath).href);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project to mirror, and a column it can grow ────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-mirror-anchor-'));
const projectDir = join(workDir, 'anchor-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

// Two options to start with, and the canvas draws a third in front of them: since #97 the
// column observations are written in is the canvas's own and the project declares nothing for
// it. A fixture that still declared a `My Notes` option would be asserting the arrangement
// this repository stopped relying on — and the count this check turns on, three columns
// becoming four, is the same either way.
const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
/** The column that is not there to begin with. GitHub appends a new option last. */
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, title, option) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: `https://github.com/vitorengers/vibemaxxing/issues/${number}`,
    createdAt: '2026-07-20T10:00:00Z',
    state: 'OPEN',
    repository: { nameWithOwner: 'vitorengers/vibemaxxing' },
  },
});

const payload = (options) => JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 3, 'Being worked on', DOING),
      item('PVTI_b', 21, 'Waiting to be picked up', TODO),
    ] },
  } } },
});

/** What the project declares. The canvas draws one more, in front, that is not on this list. */
const TWO = [TODO, DOING];
const THREE_OPTIONS = [TODO, DOING, DONE];

writeFileSync(fixturePath, payload(TWO), 'utf8');
writeFileSync(logPath, '', 'utf8');

/** A `gh` that answers from a file — rewritten mid-run — and logs every call it is given. */
writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'anchor-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Anchor Check',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    // Deliberately off, and it has to be said rather than left to the shell. This check is
    // about the region against the board's own content, and since #200 a terminal block on
    // the canvas is what the region is placed from instead — so a machine that exports
    // `EXCALIDRAW_TERMINAL` would have it measuring something else entirely.
    // `check-mirror-terminal-drift-browser.mjs` is where the two are asked about together.
    EXCALIDRAW_TERMINAL: '',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    STUB_GH_LOG: logPath,
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

const api = (path, init) => fetch(`${BASE}${path}`, {
  headers: { 'Content-Type': 'application/json' }, ...init,
});
const rect = (body) => api('/api/elements?workspace=anchor-check', {
  method: 'POST', body: JSON.stringify(body),
});

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

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

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** A drag with real intermediate moves: the write is made on the *end* of one. */
async function drag(from, to) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(80);
  for (let step = 1; step <= 8; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left', buttons: 1,
      x: from.x + ((to.x - from.x) * step) / 8,
      y: from.y + ((to.y - from.y) * step) / 8,
    });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(400);
}

/** The imperative API, through the container's React fibre — the only honest scene reader. */
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
        window.__anchorCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__anchorCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { columns: [], cards: [], add: null, title: null, authored: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'project-board' && custom.role === 'section') {
      out.columns.push({ col: custom.sectionOptionId, x: element.x, y: element.y });
    }
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                       col: custom.sectionOptionId, itemId: custom.itemId });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (custom.kind === 'project-board' && custom.role === 'title') {
      out.title = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (!custom.kind && !element.containerId) {
      out.authored.push({ id: element.id, x: element.x, y: element.y });
    }
  }
  out.columns.sort((a, b) => a.x - b.x);
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const onScreen = (scene, box) => {
  const point = toViewport(scene, box.x + box.w / 2, box.y + box.h / 2);
  return point.x > 0 && point.x < scene.view.width && point.y > 0 && point.y < scene.view.height;
};

const xs = (scene) => scene.columns.map((column) => column.x);
const columnIds = (scene) => scene.columns.map((column) => column.col);

/** Where the board's own content sits: one shape, well to the right of the mirror. */
const CONTENT = { x: 0, y: -150, width: 600, height: 400 };

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await rect({
    type: 'rectangle', ...CONTENT, backgroundColor: '#f8f9fa', text: 'the board itself',
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
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).columns.length >= 3, 'the mirror to render');

  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-three-columns');

  console.log('1. the region is placed once, against the board\'s own content');
  check('three columns: the canvas\'s own, then the two the project declares, in its order',
        JSON.stringify(columnIds(scene)) === JSON.stringify([NOTES.NOTES_OPTION_ID, TODO.id, DOING.id]),
        JSON.stringify(columnIds(scene)));
  check('its right edge is one gap left of the board\'s own left edge',
        scene.title && Math.abs((scene.title.x + scene.title.w) - (CONTENT.x - 120)) < 1,
        JSON.stringify(scene.title));
  check('and its top is level with the top of that content',
        scene.title && Math.abs(scene.title.y - CONTENT.y) < 1, JSON.stringify(scene.title));

  const placed = { columns: xs(scene), add: scene.add, title: scene.title };
  check('the + is on the first column, which is the notes one',
        scene.add && scene.add.x > placed.columns[0] && scene.add.x < placed.columns[1],
        JSON.stringify(scene.add));

  // ─── A column appears on GitHub ─────────────────────────────

  console.log('\n2. a column added on GitHub leaves the columns already drawn where they are');
  writeFileSync(fixturePath, payload(THREE_OPTIONS), 'utf8');
  const grown = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.columns.length === 4 ? now : null;
  }, 'the poll to bring the fourth column in', 200);
  await shot('02-four-columns');

  check('the fourth column arrived on a poll, with nothing touched on the canvas',
        JSON.stringify(columnIds(grown)) === JSON.stringify([NOTES.NOTES_OPTION_ID, TODO.id, DOING.id, DONE.id]),
        JSON.stringify(columnIds(grown)));
  // The pin turned round with #200: the region is the outermost of the three now and the
  // terminal is placed from its **right** edge, so that is the edge that holds still and the
  // region grows leftward, into canvas nobody is using. What it costs is the columns already
  // drawn stepping left by one column — #99's own objection to the right pin, accepted here
  // because the alternative under this order grows the region onto the blocks.
  check('the region\'s right edge is exactly where it was',
        grown.title && Math.abs((grown.title.x + grown.title.w) - (placed.title.x + placed.title.w)) < 1,
        `${JSON.stringify(placed.title)} became ${JSON.stringify(grown.title)}`);
  check('the columns already drawn each stepped left by one column',
        xs(grown).slice(1).every((x, index) => Math.abs(x - placed.columns[index]) < 1),
        `${JSON.stringify(placed.columns)} became ${JSON.stringify(xs(grown))}`);
  check('the + moved with the column it is on, which is the notes one',
        grown.add && grown.add.x < placed.add.x && Math.abs(grown.add.y - placed.add.y) < 1,
        `${JSON.stringify(placed.add)} became ${JSON.stringify(grown.add)}`);
  check('and the region grew away from the board rather than into the gap it keeps from it',
        grown.title && grown.title.x < placed.title.x - 1,
        `${JSON.stringify(placed.title)} became ${JSON.stringify(grown.title)}`);

  // ─── Something dropped elsewhere on the canvas ──────────────

  console.log('\n3. an element dropped elsewhere on the canvas moves nothing');
  const stray = await (await rect({
    type: 'rectangle', x: -4000, y: -3000, width: 200, height: 200, backgroundColor: '#ffe3e3',
  })).json();
  const strayId = stray?.element?.id ?? stray?.id;
  await waitFor(async () => (await evaluate(PROBE)).authored.some((element) => element.x === -4000),
                'the new shape to reach the canvas');

  // One whole poll, which is what used to drag the region up and to the left with it.
  await sleep(25000);
  const after = await evaluate(PROBE);
  await shot('03-after-a-stray-shape');
  check('the columns are exactly where the poll before left them',
        JSON.stringify(xs(after)) === JSON.stringify(xs(grown)),
        `${JSON.stringify(xs(grown))} became ${JSON.stringify(xs(after))}`);
  check('and so is the region\'s top, which used to follow the topmost element anywhere',
        after.title && Math.abs(after.title.y - grown.title.y) < 1,
        `${grown.title?.y} became ${after.title?.y}`);

  // ─── Still reachable, still draggable ───────────────────────

  console.log('\n4. the region is still a region: Alt+B reaches it and a card still drags');
  // Somewhere else entirely first, so the key has something to undo.
  await evaluate(`(() => { window.__anchorCheckApi.scrollToContent(
    window.__anchorCheckApi.getSceneElements().filter((e) => !(e.customData||{}).kind),
    { fitToViewport: true }); return true; })()`);
  await sleep(600);
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1500);
  scene = await evaluate(PROBE);
  await shot('04-alt-b');
  check('Alt+B brings the region back into view',
        scene.title && onScreen(scene, scene.title), JSON.stringify(scene.title));

  // Out of one of the project's own columns and into another. Not out of the notes column,
  // which since #97 no mirrored card can be in: a drag from there is not a move this server
  // has anywhere to write, and a drag *into* it snaps back on purpose.
  const moving = scene.cards.find((card) => card.col === DOING.id);
  const target = scene.columns.find((column) => column.col === TODO.id);
  check('there is a card in one of the project\'s columns to drag', Boolean(moving), JSON.stringify(scene.cards));

  const before = ghCalls().filter((call) => call.includes('item-edit')).length;
  // Held near the card's top edge rather than its middle, which is where its label is.
  const from = toViewport(scene, moving.x + moving.w / 2, moving.y + 10);
  const to = toViewport(scene, target.x + moving.w / 2, moving.y + 10);
  await drag(from, to);
  await shot('05-dragged');

  const wrote = await waitFor(() => {
    const edits = ghCalls().filter((call) => call.includes('item-edit'));
    return edits.length > before ? edits : null;
  }, 'the move to reach gh', 60);
  check('dropping it in another column writes the move back',
        wrote.length > before, JSON.stringify(wrote.slice(-1)));
  check('and it writes the column it was dropped in',
        wrote[wrote.length - 1].some((argument) => argument === TODO.id
          || (typeof argument === 'string' && argument.includes(TODO.id))),
        JSON.stringify(wrote[wrote.length - 1]));
  check('the region did not move because a card was dragged across it',
        JSON.stringify(xs(await evaluate(PROBE))) === JSON.stringify(xs(after)),
        JSON.stringify(xs(await evaluate(PROBE))));

  if (!strayId) console.log('  (the stray shape had no id in the response; it was left in the throwaway board)');
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

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
