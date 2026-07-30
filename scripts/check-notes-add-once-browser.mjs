#!/usr/bin/env node
/**
 * Checks that the notes column's `+` makes at most one draft nobody has written into yet.
 *
 * The `+` is not a button with a click handler — it is a rectangle drawn into the mirror,
 * and the click is inferred from the selection landing on it. Two things follow, and both
 * are what this checks:
 *
 * 1. **Nothing counted the drafts already there.** `addIssueBlockToColumn` instantiated the
 *    library template on every arrival, so a double click made two blocks and five clicks
 *    made five. The reader asked for one observation and got a stack of empty ones.
 * 2. **A selection can arrive without a click.** `selectedElementIds` is part of
 *    Excalidraw's observed app state, so undo restores it: `Ctrl+Z` deleted the block *and*
 *    put the selection back on the `+`, which read as a fresh arrival and made another
 *    block. The undo could never win.
 *
 * This file used to say the second was answered by arming the trigger with a real pointer
 * press. **There is no such arming, and there never was** — `userInteractedRef` is the only
 * thing on the page that knows a pointer went down, and the only thing that reads it is the
 * autosync (#244). What answers it is Excalidraw's history: the undo restores the selection
 * to what it was *before* the press rather than to the `+`, so nothing fires, which is what
 * `docs/project-board.md` records and what case 1 below keeps true. The cap on unpopulated
 * drafts is a genuinely separate guard and does not cover this case at all — after an undo
 * there is no draft left for a cap to find.
 *
 * The cap is on *unpopulated* drafts only, so it must not get in the way of real work: an
 * observation that has been typed into is somebody's, and the `+` still owes them a fresh
 * block. Same for a draft a research run has already turned into an issue.
 *
 * The column is never emptied between cases, deliberately. Deleting a draft through the API
 * makes the server broadcast the removal, the browser puts the scene back with the viewport
 * at the origin, and every coordinate computed afterwards aims off screen — a reset is more
 * fragile than the thing under test. The undo case runs first instead, and leaves the column
 * empty for the two that need it empty.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas server
 * against a throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-notes-add-once-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

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

const workDir = mkdtempSync(join(tmpdir(), 'check-notes-add-'));
const projectDir = join(workDir, 'add-once');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

/**
 * Two columns with one card between them, and no option for the notes column.
 *
 * The project's own columns are scenery here — what is under test is the column the canvas
 * draws for itself. Its id and its name come from the compiled module that reserves them,
 * so a check that agreed with the code only by being typed the same way could not pass.
 */
const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const TODO = { id: 'f75ad846', name: 'Todo' };
const DONE = { id: '98236657', name: 'Done' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 3,
        title: 'Something already on the board',
        url: 'https://github.com/vitorengers/mcp_excalidraw/issues/3',
        createdAt: '2026-07-01T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
      },
    }] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'add-once', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Add Once',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = 'add-once';
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
  STUB_GH_FIXTURE: fixturePath,
  // The `+` drops a block *from the library*, so without one every click is a silent
  // no-op and the check would fail on its own harness rather than on the feature.
  EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
};
// Whoever runs this may have the terminal switched on in their own shell, and the whole
// environment is inherited. A terminal block is drawn over the board and its xterm panel is
// a DOM overlay: with it on, the `+` ends up underneath and every click is swallowed. The
// board this check is about has no terminal on it, so neither does this one.
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
    // The `+` answers a click it cannot serve by warning to the console and returning, so a
    // silent no-op is only silent while nobody is listening. Kept for the failure report.
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
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

async function click(x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(150);
}

/**
 * The gesture the report was about: two presses, nothing between them.
 *
 * `click(x, y, 2)` sends one press carrying `clickCount: 2`, which is a double click as far
 * as the DOM is concerned but only *one* pointer-down — and a pointer-down is what selects
 * the `+`. The duplicate needs both presses, so both are sent, with no wait: the second
 * lands while the first block is still being drawn, which is exactly the reader's
 * impatient second click.
 */
async function doubleClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 2, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 2, buttons: 0 });
  await sleep(150);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(30);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** Ctrl+Z, as a reader presses it. `rawKeyDown` is what a shortcut handler reads. */
async function undo() {
  await send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', code: 'KeyZ', key: 'z', modifiers: 2, windowsVirtualKeyCode: 90, commands: ['undo'],
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyZ', key: 'z', modifiers: 2, windowsVirtualKeyCode: 90 });
  await sleep(150);
}

/**
 * Read the scene the way the canvas holds it.
 *
 * Excalidraw draws to a canvas, so there is no DOM to query for a block; the imperative
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
  const out = { drafts: [], add: null, headers: {} };
  const sections = [];
  const sectionLabels = [];
  const draftLabels = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        col: custom.sectionOptionId, at: custom.draftCreatedAt,
                        issueUrl: custom.issueUrl || null, issueState: custom.issueState || null,
                        text: null });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height, col: custom.sectionOptionId };
    }
    if (custom.kind === 'project-board' && custom.role === 'section') {
      sections.push({ id: element.id, col: custom.sectionOptionId, x: element.x });
    }
    if (element.containerId && custom.kind === 'project-board' && custom.role === 'label') {
      sectionLabels.push({ containerId: element.containerId, text: element.text || '' });
    }
    if (element.containerId && element.type === 'text') {
      draftLabels.push({ containerId: element.containerId, text: element.originalText || element.text || '' });
    }
  }
  for (const draft of out.drafts) {
    const label = draftLabels.find((entry) => entry.containerId === draft.id);
    draft.text = label ? label.text : null;
  }
  for (const section of sections) {
    const label = sectionLabels.find((entry) => entry.containerId === section.id);
    // A label may be wrapped over two lines; the header reads as one sentence either way.
    out.headers[section.col] = label ? label.text.replace(/\\s*\\n\\s*/g, ' ') : null;
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/** Write a finished run's result onto a draft, the way the browser sees one arrive. */
const MARK_RESEARCHED = (id, url) => `(() => {
  const api = window.__boardCheckApi;
  const elements = api.getSceneElements().map((element) => element.id === ${JSON.stringify(id)}
    ? { ...element,
        version: (element.version || 1) + 1,
        customData: { ...(element.customData || {}), issueState: 'created', issueUrl: ${JSON.stringify(url)} } }
    : element);
  api.updateScene({ elements, captureUpdate: 'NEVER' });
  return true;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const plusAt = (view) => toViewport(view, view.add.x + view.add.w / 2, view.add.y + view.add.h / 2);

/**
 * Nothing selected, so the next click is a fresh arrival wherever it lands.
 *
 * Also gets Excalidraw's properties island off the left of the canvas, which is where the
 * notes column is drawn — a click meant for a block there lands on the island instead.
 */
async function deselect() {
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

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
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view. Pressed
  // once and never again: every coordinate below is computed from the view it settles on.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  check('the + is on the notes column, and the column starts empty',
        scene.add?.col === NOTES.id && scene.drafts.length === 0,
        `${JSON.stringify(scene.add)} / ${JSON.stringify(scene.drafts)}`);
  check('and its header says so',
        scene.headers[NOTES.id] === `${NOTES.name} (0)`, JSON.stringify(scene.headers));

  const plus = plusAt(scene);

  console.log('\n1. undo takes the block away, and nothing puts another back');
  await click(plus.x, plus.y);
  await sleep(900);
  scene = await evaluate(PROBE);
  await shot('02-one-draft');
  check('one click made one draft to undo', scene.drafts.length === 1,
        `${JSON.stringify(scene.drafts.map((d) => d.id))} selected=${JSON.stringify(scene.selected)}`);

  await undo();
  await sleep(600);
  scene = await evaluate(PROBE);
  await shot('03-undone');
  check('Ctrl+Z leaves no draft at all',
        scene.drafts.length === 0, JSON.stringify(scene.drafts.map((d) => d.id)));

  // The undo restores the selection along with the elements — `selectedElementIds` is part
  // of Excalidraw's observed app state — so the `+` is selected again with nobody having
  // clicked it. Whether that counts as a click is the whole of this case.
  let reappeared = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await sleep(250);
    const now = await evaluate(PROBE);
    if (now.drafts.length > 0) { reappeared = now; break; }
  }
  await shot('04-still-undone');
  check('and none comes back within a second of it',
        reappeared === null, JSON.stringify(reappeared?.drafts.map((d) => d.id)));

  console.log('\n2. one gesture, one block');
  // The undo left the `+` selected, and a shape already selected is not selected again by
  // the next press. Cleared here so the double click below is a real arrival on it.
  await deselect();
  await doubleClick(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('05-double-click');
  check('a double click on the + leaves exactly one draft',
        scene.drafts.length === 1, `${scene.drafts.length}: ${JSON.stringify(scene.drafts.map((d) => d.id))}`);
  check('and the header counts one',
        scene.headers[NOTES.id] === `${NOTES.name} (1)`, JSON.stringify(scene.headers));

  console.log('\n3. and clicking it again, with nothing typed, still leaves one');
  for (let round = 0; round < 5; round++) {
    await click(plus.x, plus.y);
    await sleep(500);
  }
  await sleep(900);
  scene = await evaluate(PROBE);
  await shot('06-five-clicks');
  check('five more clicks on the + leave exactly one draft',
        scene.drafts.length === 1, `${scene.drafts.length}: ${JSON.stringify(scene.drafts.map((d) => d.id))}`);
  check(`and the header still reads ${NOTES.name} (1)`,
        scene.headers[NOTES.id] === `${NOTES.name} (1)`, JSON.stringify(scene.headers));

  console.log('\n4. the cap does not get in the way of a second observation');
  const first = scene.drafts[0];
  await deselect();
  scene = await evaluate(PROBE);
  const blank = scene.drafts.find((draft) => draft.id === first.id);
  const centre = toViewport(scene, blank.x + blank.w / 2, blank.y + blank.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(500);
  check('the block opens for typing', (await evaluate(PROBE)).editorOpen);
  await typeText('The + makes more than one empty block. ');
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(1000);
  await deselect();
  scene = await evaluate(PROBE);
  await shot('07-typed');
  const observation = scene.drafts.find((draft) => draft.id === first.id);
  check('what was typed is on the block',
        Boolean(observation) && observation.text !== blank.text
        && observation.text.includes('more than one empty block'),
        JSON.stringify(observation?.text));

  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('08-second-draft');
  check('the + makes a second draft once the first has been written into',
        scene.drafts.length === 2, JSON.stringify(scene.drafts.map((d) => d.id)));
  check('and the header counts two',
        scene.headers[NOTES.id] === `${NOTES.name} (2)`, JSON.stringify(scene.headers));
  const kept = scene.drafts.find((draft) => draft.id === first.id);
  check('with the observation untouched',
        Boolean(kept) && kept.text === observation.text,
        `${JSON.stringify(observation?.text)} → ${JSON.stringify(kept?.text)}`);

  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  check('and a further click, with that second draft still empty, leaves two',
        scene.drafts.length === 2, JSON.stringify(scene.drafts.map((d) => d.id)));

  console.log('\n5. a draft a run has already turned into an issue is not an empty one');
  const empty = scene.drafts.find((draft) => draft.id !== first.id);
  // Issue 999, which has no card on the fixture: a draft whose issue *is* on the board is
  // reconciled away, and this one has to stay put to be in the way.
  const RESEARCHED_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/999';
  const held = await (await fetch(`${BASE}/api/elements/${empty.id}?workspace=${WORKSPACE}`)).json();
  await fetch(`${BASE}/api/elements/${empty.id}?workspace=${WORKSPACE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customData: { ...(held.element?.customData ?? {}), issueState: 'created', issueUrl: RESEARCHED_URL },
    }),
  });
  await evaluate(MARK_RESEARCHED(empty.id, RESEARCHED_URL));
  await sleep(700);
  await deselect();
  scene = await evaluate(PROBE);
  const researched = scene.drafts.find((draft) => draft.id === empty.id);
  check('the block carries its issue now, though nobody typed into it',
        researched?.issueUrl === RESEARCHED_URL && researched?.issueState === 'created',
        JSON.stringify(researched));

  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('09-fresh-after-researched');
  check('so the + makes a fresh draft rather than handing that one back',
        scene.drafts.length === 3, JSON.stringify(scene.drafts.map((d) => `${d.id}:${d.issueUrl}`)));
  check('and exactly one draft in the column is an empty one with no issue on it',
        scene.drafts.filter((draft) => !draft.issueUrl && draft.text === blank.text).length === 1,
        JSON.stringify(scene.drafts.map((d) => `${d.id}:${d.issueUrl}:${JSON.stringify(d.text)}`)));
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
