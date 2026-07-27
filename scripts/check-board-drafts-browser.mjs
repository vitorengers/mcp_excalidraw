#!/usr/bin/env node
/**
 * Checks the draft blocks in a real browser.
 *
 * `check-board-drafts.mjs` covers the arithmetic; this covers what the arithmetic is
 * wired to, which is the half that has burnt this project before — a panel that never
 * opened, a race in tab initialisation, a click landing on the label. All three compiled.
 * Here the questions are whether the `+` really drops its block above the ones already
 * there, and whether a block growing under a caret really pushes the cards below it down
 * without waiting for the twenty-second poll. It earned its place: it caught a second
 * draft still overlapping the one being typed into, which the pure check could not see.
 *
 * It also reads the **section header** back out of the scene after a click. `check-board-counts.mjs`
 * covers what the header says; this covers whether the click redraws it at all, which is the
 * half that compiles either way — the count is drawn from the same relayout the block itself
 * triggers, so a drop that moved the cards but left the header stale would look identical here
 * until somebody read the text.
 *
 * The fixture is a **three-column** project, and the browser draws four. The fourth is the
 * column observations are written in, which is the canvas's own: #97 took it off GitHub, where
 * it had been an option holding no item and existing only to lend its id to blocks that live
 * here. So the things only a browser settles are that a column with no option behind it is
 * drawn at all, that it is first and carries the `+`, that the project's own columns are drawn
 * after it in the order the project declares them, and that a block dropped into it is stamped
 * with an id the project cannot rename away. The last case then does what a finished research
 * run does to a block — writes the issue URL onto it while that issue's card sits in a
 * *different* column — because the reconciliation matches on the URL and a check that put the
 * card in the same column could not tell the two rules apart. It is no longer possible to put
 * the card in the same column, which is the point: no project item can be in this one.
 *
 * It also asserts what orders that stack. `customData.draftCreatedAt` is the key; the stamp
 * in the element id is only a fallback for blocks made before the field existed. Both are
 * written from one `Date.now()`, so they agree by construction and a passing order proves
 * nothing about which of them was read — which is how a scene built by a stale bundle, whose
 * blocks carried no field at all, was once read as the field being dropped. So the field is
 * asserted present in the scene, and then made to disagree with the id to see which wins.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on, rather than by adding a browser-automation dependency. Self-contained
 * otherwise: it writes a stub `gh`, starts its own canvas server against a throwaway
 * workspace, and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite
 * build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-drafts-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

if (!existsSync(join(repoRoot, 'dist', 'core', 'project-board-types.js'))) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-types.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project to mirror ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-board-drafts-'));
const projectDir = join(workDir, 'mirror-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

/**
 * Three columns, in the order the project declares them — and no option for the notes one.
 *
 * That absence is the fixture's whole point: the column observations are written in has to
 * be drawn from nothing the project says. Its id and its name are read from the compiled
 * module that reserves them rather than written out here, so a check that agreed with the
 * code only by being typed the same way could not pass.
 *
 * A researched issue is moved out of the notes column into `Todo`, so `Todo` here already
 * holds one card that has been through that.
 */
const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, title, createdAt, option) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`,
    createdAt,
    state: 'OPEN',
    repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
  },
});

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 3, 'Oldest one', '2026-07-01T10:00:00Z', DOING),
      item('PVTI_b', 21, 'Newest one', '2026-07-20T10:00:00Z', DOING),
      item('PVTI_c', 12, 'Middle one', '2026-07-10T10:00:00Z', DOING),
      item('PVTI_d', 9, 'Researched already', '2026-07-05T10:00:00Z', TODO),
    ] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'mirror-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Mirror Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = 34600 + (process.pid % 300);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    // The `+` drops a block *from the library* — `addIssueBlockToColumn` looks for a
    // template carrying `customData.kind === "issue"` and, finding none, warns to the
    // console and returns. Without this the server serves an empty library, every click is
    // a silent no-op, and the check fails on its own harness rather than on the feature.
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
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

async function click(x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(150);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(40);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/**
 * Read the scene the way the canvas holds it.
 *
 * Excalidraw draws to a canvas, so there is no DOM to query for a card; the imperative
 * API is the only honest reader, and the component keeps it to itself. It is reachable
 * through the container's React fibre — brittle across Excalidraw versions, but it fails
 * loudly rather than passing on nothing.
 */
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
  const out = { drafts: [], cards: [], add: null, headers: {} };
  const sections = [];
  const labels = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        col: custom.sectionOptionId, at: custom.draftCreatedAt });
    }
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, h: element.height, col: custom.sectionOptionId });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height,
                  col: custom.sectionOptionId };
    }
    // The header is a rectangle; what a reader actually sees is the text bound to it, so
    // both halves are collected and joined once the whole scene has been walked.
    if (custom.kind === 'project-board' && custom.role === 'section') {
      sections.push({ id: element.id, col: custom.sectionOptionId, x: element.x });
    }
    if (element.containerId && custom.kind === 'project-board' && custom.role === 'label') {
      labels.push({ containerId: element.containerId, text: element.text || '' });
    }
  }
  for (const section of sections) {
    const label = labels.find((entry) => entry.containerId === section.id);
    // A label may be wrapped over two lines; the header reads as one sentence either way.
    out.headers[section.col] = label ? label.text.replace(/\\s*\\n\\s*/g, ' ') : null;
  }
  // Left to right, which is the order the project declares its options in.
  out.columns = sections.slice().sort((a, b) => a.x - b.x).map((section) => section.col);
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editingId = state.editingTextElement ? state.editingTextElement.id : null;
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.cards.sort((a, b) => a.y - b.y);
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/**
 * Rewrite one draft's timestamp in the scene, and nudge it so the relayout notices.
 *
 * The height is what carries the write: `relayoutForDrafts` keeps a signature of the draft
 * heights, and a `customData` edit on its own moves nothing in it, so the column would not
 * be laid out again until the twenty-second poll came round.
 */
const SETSTAMP = (id, at) => `(() => {
  const api = window.__boardCheckApi;
  const elements = api.getSceneElements().map((element) => element.id === ${JSON.stringify(id)}
    ? { ...element,
        height: element.height + 1,
        version: (element.version || 1) + 1,
        customData: { ...(element.customData || {}), draftCreatedAt: ${at} } }
    : element);
  api.updateScene({ elements, captureUpdate: 'NEVER' });
  return true;
})()`;

/** The stamp the fallback would read off an id, for asserting it says the opposite. */
const stampInId = (id) => {
  const digits = /^pbdraft-(\d+)/.exec(id)?.[1];
  return digits ? Number(digits) : null;
};

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});
/**
 * The mirrored cards in the column the drafts are dropped into.
 *
 * Always none of them, and that is asserted rather than assumed: the column is the canvas's
 * own and no project item can carry its id. It used to be the busiest column on the fixture,
 * which is what made a `+` on "whichever option is first" look reasonable.
 */
const notesCards = (scene) => scene.cards.filter((element) => element.col === NOTES.id);

/** Every card the project put on the board — all of them in a column of the project's. */
const projectCards = (scene) => scene.cards.filter((element) => element.col !== NOTES.id);

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
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 4, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  console.log('1. the canvas\'s own column first, then the three the project declares, with the + on it');
  check('a column is drawn for the notes, though the project declares no option for it',
        scene.columns.includes(NOTES.id), JSON.stringify(scene.columns));
  check('first, and the project\'s own columns after it in the project\'s own order',
        JSON.stringify(scene.columns) === JSON.stringify([NOTES.id, TODO.id, DOING.id, DONE.id]),
        JSON.stringify(scene.columns));
  check('and the + is on it, not on the first option the project happens to declare',
        scene.add?.col === NOTES.id, JSON.stringify(scene.add));
  check('nothing mirrored is in it, because nothing on the project can be',
        notesCards(scene).length === 0 && projectCards(scene).length === 4,
        JSON.stringify(scene.cards.map((card) => card.col)));

  console.log('\n2. the + drops its block above the blocks already in the column');
  // What the header said before anything was dropped: nothing, because the column holds
  // nothing until the reader writes something into it.
  const headerBefore = scene.headers[NOTES.id];
  check('the header starts empty, the column having no card it could ever hold',
        headerBefore === `${NOTES.name} (0)`, JSON.stringify(scene.headers));

  const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
  await click(plus.x, plus.y);
  await sleep(900);
  scene = await evaluate(PROBE);
  await shot('02-one-draft');
  check('one click, one block', scene.drafts.length === 1, JSON.stringify(scene.drafts));
  check('in the notes column, carrying the reserved id rather than an option id',
        scene.drafts[0]?.col === NOTES.id, JSON.stringify(scene.drafts[0]));
  check('at the top of it, with no mirrored card anywhere below it to make room',
        scene.drafts.length === 1 && notesCards(scene).length === 0,
        `${JSON.stringify(scene.drafts[0])} vs ${JSON.stringify(notesCards(scene))}`);
  // #79: the block just dropped was invisible to the only number above it. #86 gave it a
  // column of its own and the number went back to being one — of everything the column
  // holds, drafts included, which is the half a plain revert would have lost. #97 took the
  // column off GitHub, so drafts are now the only thing that number can ever count. It is
  // read off the scene rather than off the layout, because the layout is where it was
  // already right — the question here is whether the click redraws the header at all.
  check('and the header now counts it',
        scene.headers[NOTES.id] === `${NOTES.name} (1)`, JSON.stringify(scene.headers));
  check('while a column with no drafts in it is untouched',
        scene.headers[TODO.id] === 'Todo (1)', JSON.stringify(scene.headers));
  check('and an empty one still reads zero',
        scene.headers[DONE.id] === 'Done (0)', JSON.stringify(scene.headers));

  // The second one is where the report came from: it went underneath the first.
  await click(plus.x, plus.y);
  await sleep(1000);
  scene = await evaluate(PROBE);
  await shot('03-two-drafts');
  check('a second block', scene.drafts.length === 2, JSON.stringify(scene.drafts));
  check('each block reached the scene carrying the timestamp that orders it',
        scene.drafts.length === 2 && scene.drafts.every((draft) => typeof draft.at === 'number'),
        scene.drafts.map((draft) => `${draft.id}: draftCreatedAt=${draft.at}`).join(' | '));
  check('and the newer one is on top, not under the one already there',
        scene.drafts.length === 2 && scene.drafts[0].at > scene.drafts[1].at,
        scene.drafts.map((draft) => `${draft.id}@${draft.y}`).join(' | '));
  check('and neither of them overlaps the other',
        scene.drafts.length === 2 && scene.drafts[1].y >= scene.drafts[0].y + scene.drafts[0].h,
        JSON.stringify(scene.drafts));
  check('and the header moved with the second one, on the click rather than on the poll',
        scene.headers[NOTES.id] === `${NOTES.name} (2)`, JSON.stringify(scene.headers));

  console.log('\n3. typing into a block pushes what is below it down, with no wait for the poll');
  // Nothing selected before the click. A block left selected puts Excalidraw's properties
  // island over the left edge of the canvas and this project's own panel over the middle of
  // it, and a four-column mirror fitted to this window leaves the first column under one of
  // them — so the double click meant for a block would land on a panel instead. This is the
  // trap `docs/project-board.md` already records in another form: the click that never
  // reached the box.
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  const top = scene.drafts[0];
  const below = scene.drafts[1];
  // What has to move: the block under the one being typed into. What must not: every card
  // on the board, all of which are in the project's own columns now that this one holds
  // none. Before #97 the first of those was the same column and both claims were one.
  const belowBefore = below.y;
  const cardsBefore = projectCards(scene).map((card) => card.y);
  const centre = toViewport(scene, top.x + top.w / 2, top.y + top.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(500);
  check('a double click opens the text editor', (await evaluate(PROBE)).editorOpen);

  // Typed until the container outgrows its template height, then probed at once: the whole
  // claim is that the reflow lands in the same instant rather than on the next poll.
  let grewAfterMs = null;
  for (let round = 0; round < 14 && grewAfterMs === null; round++) {
    const started = Date.now();
    await typeText('An observation long enough to outgrow the block it is typed into. ');
    scene = await evaluate(PROBE);
    const now = scene.drafts.find((draft) => draft.id === top.id);
    if (now && now.h > top.h) grewAfterMs = Date.now() - started;
  }
  await shot('04-typing');
  const grown = scene.drafts.find((draft) => draft.id === top.id);
  const belowAfter = scene.drafts.find((draft) => draft.id === below.id)?.y ?? null;
  const cardsAfter = projectCards(scene).map((card) => card.y);
  check('the block grew as it was typed into', Boolean(grown) && grown.h > top.h, `${top.h} → ${grown?.h}`);
  check('the editor stayed open throughout', scene.editorOpen, `editingId=${scene.editingId}`);
  check('the block below it had already moved down in the probe that saw it grow',
        grewAfterMs !== null && belowAfter !== null && belowAfter > belowBefore,
        `${belowBefore} → ${belowAfter}`);
  check('by exactly what the block grew by',
        Boolean(grown) && belowAfter !== null
        && Math.abs((belowAfter - belowBefore) - (grown.h - top.h)) < 1,
        `grew ${grown && grown.h - top.h}, the block below moved ${belowAfter - belowBefore}`);
  check('and no card in any of the project\'s columns moved at all',
        cardsAfter.length === cardsBefore.length
        && cardsAfter.every((y, index) => Math.abs(y - cardsBefore[index]) < 1),
        `${cardsBefore.join(',')} → ${cardsAfter.join(',')}`);
  check('and the block under the caret did not move',
        Boolean(grown) && Math.abs(grown.y - top.y) < 1 && Math.abs(grown.x - top.x) < 1,
        `${JSON.stringify(top)} → ${JSON.stringify(grown)}`);
  check('nor did the block below it get overlapped',
        (belowAfter ?? 0) >= grown.y + grown.h,
        `${JSON.stringify(grown)} over ${JSON.stringify(scene.drafts.find((draft) => draft.id === below.id))}`);

  console.log('\n4. leaving the editor changes nothing that was already right');
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(1200);
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(300);
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1400);
  scene = await evaluate(PROBE);
  await shot('05-column');
  check('the cards are where the last relayout put them',
        projectCards(scene).every((card, index) => Math.abs(card.y - cardsAfter[index]) < 1),
        `${cardsAfter.join(',')} → ${projectCards(scene).map((card) => card.y).join(',')}`);
  check('the blocks still stack newest-first',
        scene.drafts.length === 2 && scene.drafts[0].id === top.id,
        scene.drafts.map((draft) => `${draft.id}@${draft.y}`).join(' | '));
  check('and the header still counts two — typing into a block does not make a third',
        scene.headers[NOTES.id] === `${NOTES.name} (2)`, JSON.stringify(scene.headers));
  const column = [...scene.drafts, ...notesCards(scene)].sort((a, b) => a.y - b.y);
  check('and nothing in the column overlaps anything else',
        column.every((box, index) => index === 0 || box.y >= column[index - 1].y + column[index - 1].h),
        column.map((box) => `${box.id}:${box.y}+${box.h}`).join(' | '));

  console.log('\n5. the stack is ordered by the field, not by the stamp in the id');
  // Nothing above tells the two keys apart: one `Date.now()` produces both, so they agree
  // and either would put the same block on top. Here the lower block's field is made the
  // newest of the two while its id keeps the older stamp. If `draftCreatedAt` is what the
  // layout reads, the blocks swap; if the fallback is quietly doing the work, they do not.
  const lower = scene.drafts[1];
  const upper = scene.drafts[0];
  check('the two ids do carry the opposite order, so the swap is a real disagreement',
        stampInId(lower.id) !== null && stampInId(upper.id) !== null
        && stampInId(lower.id) < stampInId(upper.id),
        `${lower.id} vs ${upper.id}`);
  await evaluate(SETSTAMP(lower.id, upper.at + 5000));
  await sleep(1500);
  scene = await evaluate(PROBE);
  await shot('06-restamped');
  check('the block whose field is newest is on top, though its id is the older stamp',
        scene.drafts.length === 2 && scene.drafts[0].id === lower.id,
        scene.drafts.map((draft) => `${draft.id}@${draft.y} at=${draft.at}`).join(' | '));

  console.log('\n6. a researched block goes when its issue turns up as a card — in any column');
  // What a finished run leaves behind: the block carries the URL of the issue it produced,
  // and the server has since moved that issue out of the column the block was written in.
  // The card is under Todo and the block is in the notes column, which is not a column the
  // card could be in at all, so a reconciliation that matched on the column would keep the
  // block forever and the reader would end up with both. Written through the API rather
  // than into the scene, so the update reaches the browser the way a real run's does —
  // over the socket.
  const researched = scene.drafts[0];
  const RESEARCHED_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/9';
  check('the card for that issue really is in another column',
        scene.cards.some((card) => card.col === TODO.id),
        JSON.stringify(scene.cards.map((card) => card.col)));

  // Named on the read as well as on the write: each workspace has an element store of its
  // own, and a call without it answers from the default board instead.
  const held = await (await fetch(`${BASE}/api/elements/${researched.id}?workspace=mirror-check`)).json();
  await fetch(`${BASE}/api/elements/${researched.id}?workspace=mirror-check`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customData: { ...(held.element?.customData ?? {}), issueState: 'created', issueUrl: RESEARCHED_URL },
    }),
  });

  // The next poll is what reconciles; nothing here forces one, because a run finishing in
  // the browser does not either. Twenty seconds plus the margin the poll is allowed to run in.
  let reconciled = null;
  for (let attempt = 0; attempt < 60 && reconciled === null; attempt++) {
    await sleep(1000);
    const now = await evaluate(PROBE);
    if (!now.drafts.some((draft) => draft.id === researched.id)) reconciled = now;
  }
  await shot('07-reconciled');
  check('the block is gone, matched on the issue URL rather than on where it sat',
        reconciled !== null,
        JSON.stringify((await evaluate(PROBE)).drafts));
  check('the other block, which has no issue, is left exactly where it was',
        reconciled?.drafts.length === 1 && reconciled.drafts[0].id === upper.id,
        JSON.stringify(reconciled?.drafts));
  check('and the header counts one fewer',
        reconciled?.headers[NOTES.id] === `${NOTES.name} (1)`, JSON.stringify(reconciled?.headers));
  check('while the column the issue was moved into is unchanged',
        reconciled?.headers[TODO.id] === 'Todo (1)', JSON.stringify(reconciled?.headers));
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
