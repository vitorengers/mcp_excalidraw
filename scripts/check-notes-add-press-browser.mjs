#!/usr/bin/env node
/**
 * Checks that the notes column's `+` answers every press, and is never left sitting selected.
 *
 * The `+` is a rectangle drawn into the mirror and the press is inferred from the selection
 * landing on it, which is why #244 reports it "selecting as a block" and then refusing to
 * work. Being selectable is not the defect — Excalidraw 0.18 has no way to click a locked
 * shape, so locking it would remove the only trigger the button has. *Staying* selected is,
 * and so is a selection being ignored because it arrived with company:
 *
 * 1. **A selection with company was thrown away.** `syncSelectedDoc` resolved anything but a
 *    single selection to `null`, so a band across the header strip or one shift-click left the
 *    `+` highlighted with nothing happening — a button that looks exactly like a selected
 *    block. The header rectangles are locked and a band never catches them; the `+`, the queue
 *    toggle, every card and every draft are not.
 * 2. **A press left selected is a press that cannot be repeated.** `syncSelectedDoc` bails out
 *    when the selection has not changed, so once the `+` was the last handled selection *and
 *    was still selected*, every further press on it was an unchanged selection and was
 *    dropped. The button was dead until something else was clicked.
 * 3. **Four paths out of `addIssueBlockToColumn` returned in silence**, the reachable one
 *    being a library that ships no issue block: a `console.warn` nobody has open, and the `+`
 *    left selected, which is what 2 then wedged.
 * 4. **A stray-dragged `+` was never put back**, though the layout's comment promised the next
 *    refresh would. The skip signature is built from what the layout *wants*, so a mirror
 *    nobody had a reason to redraw stayed as the drag left it.
 *
 * The cases below run in the order the board allows rather than in the order above: the
 * library one navigates the page to the second board and stays there, so everything that
 * needs the issue block has to be finished first.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh`, starts **two** canvas servers against
 * two throwaway workspaces — one whose library ships the issue block and one whose library
 * ships everything except it — and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first; it loads the built frontend.
 *
 * Usage: node scripts/check-notes-add-press-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── Two projects to mirror ───────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-notes-press-'));
const stockedDir = join(workDir, 'stocked');
const barrenDir = join(workDir, 'barren');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [stockedDir, barrenDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const agentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const stockedRegistry = join(workDir, 'workspaces-stocked.json');
const barrenRegistry = join(workDir, 'workspaces-barren.json');

/**
 * Two columns with one card between them, and no option for the notes column.
 *
 * `Todo` is named so the implementation queue has a column to draw its toggle on: that
 * toggle is the `+`'s twin — a shape the reader presses rather than selects — and case 1
 * asks the same question of both. Its id and the notes column's come from the compiled
 * module that reserves them, so a check that agreed with the code only by being typed the
 * same way could not pass.
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
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 3,
        title: 'Something already on the board',
        url: 'https://github.com/vitorengers/vibemaxxing/issues/3',
        createdAt: '2026-07-01T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: 'vitorengers/vibemaxxing' },
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

/**
 * An agent that is configured and never run.
 *
 * `GET /api/implement` only answers with a queue state when this board could implement
 * something, and the toggle is only drawn when it does. Nothing in this check ever turns the
 * queue on, so nothing ever spawns this.
 */
writeFileSync(agentPath, `#!/usr/bin/env node
process.stdout.write('nothing to do\\n');
`, 'utf8');

/**
 * A library shipping everything except the issue block.
 *
 * Taken from the real one with the issue item filtered out rather than written by hand: what
 * is under test is the `+` finding no template, and a library the reader would recognise is
 * the honest way to have none. `board.config.json` names it, so the workspace carries it
 * without `EXCALIDRAW_LIBRARY` — which is server-wide and would put the issue block back on
 * every board this check starts.
 */
const shipped = JSON.parse(readFileSync(join(repoRoot, 'docs', 'blocks.excalidrawlib'), 'utf8'));
const withoutIssue = (shipped.libraryItems ?? []).filter((item) =>
  !(item?.elements ?? []).some((element) => element?.customData?.kind === 'issue'));
if (withoutIssue.length === (shipped.libraryItems ?? []).length) {
  console.error('  FAIL  docs/blocks.excalidrawlib ships an issue block — nothing was filtered out');
  process.exit(1);
}
writeFileSync(join(barrenDir, 'no-issue.excalidrawlib'),
              JSON.stringify({ ...shipped, libraryItems: withoutIssue }), 'utf8');

writeFileSync(stockedRegistry, JSON.stringify({
  workspaces: [{ id: 'stocked', path: stockedDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(barrenRegistry, JSON.stringify({
  workspaces: [{ id: 'barren', path: barrenDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(stockedDir, 'board.config.json'), JSON.stringify({
  name: 'Stocked',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');
writeFileSync(join(barrenDir, 'board.config.json'), JSON.stringify({
  name: 'Barren',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/someone/projects/5',
  library: 'no-issue.excalidrawlib',
}), 'utf8');

const STOCKED_PORT = await freePort();
const BARREN_PORT = await freePort();
const CDP_PORT = await freePort();
const STOCKED = `http://127.0.0.1:${STOCKED_PORT}`;
const BARREN = `http://127.0.0.1:${BARREN_PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';

/**
 * One canvas server, and whatever it says on the way up kept for the failure report.
 *
 * The operator's own environment is inherited wholesale, and on the machine this project is
 * developed on it carries most of a running board's configuration. Four pieces of it would
 * decide this check's result:
 *
 * - `EXCALIDRAW_TERMINAL` draws a terminal block over the board whose xterm panel is a DOM
 *   overlay, so the `+` ends up underneath and every press is swallowed.
 * - `EXCALIDRAW_LIBRARY` is server-wide, so it puts the issue block back on the board whose
 *   whole purpose is not to have one — the barren half then passes for the wrong reason, or
 *   rather fails claiming the workspace library still carries one.
 * - the agent commands would let a board spawn something; only the stub below is wanted, and
 *   only where it is asked for.
 * - `LOG_FILE_PATH` is the operator's real log, which a throwaway server has no business in.
 */
function startServer(port, registry, extra = {}) {
  // The list this used to delete by hand is now the whole of `EXCALIDRAW_*`, stripped by
  // `scripts/lib/spawn-canvas.mjs` before any of the values below arrive.
  const env = {};
  Object.assign(env, {
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    LOG_FILE_PATH: join(workDir, `server-${port}.log`),
    EXCALIDRAW_WORKSPACES: registry,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
  }, extra);
  const server = startCanvas({
    env,
  }).child;
  children.push(server);
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  return server;
}

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
    // What the page said is evidence here rather than colour: a press the `+` cannot serve
    // warns and returns, so counting the warnings is how "the second press was heard at all"
    // is asked without depending on anything being drawn.
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

/** Shift is 8 in the protocol's modifier bitmask, which is how a selection gains company. */
async function click(x, y, { modifiers = 0, clickCount = 1 } = {}) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1, modifiers,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0, modifiers,
  });
  await sleep(150);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/**
 * Read the scene the way the canvas holds it.
 *
 * Excalidraw draws to a canvas, so there is no DOM to query for a block; the imperative API
 * is the only honest reader, and the component keeps it to itself. It is reachable through
 * the container's React fibre — brittle across Excalidraw versions, but it fails loudly
 * rather than passing on nothing.
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
  const out = { drafts: [], add: null, queue: null, headers: {} };
  const sections = [];
  const sectionLabels = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        col: custom.sectionOptionId });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                  locked: element.locked === true, col: custom.sectionOptionId };
    }
    if (custom.kind === 'project-board' && custom.role === 'queue') {
      out.queue = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                    locked: element.locked === true, col: custom.sectionOptionId,
                    on: custom.queueEnabled === true };
    }
    if (custom.kind === 'project-board' && custom.role === 'section') {
      sections.push({ id: element.id, col: custom.sectionOptionId, x: element.x, y: element.y,
                      w: element.width, h: element.height });
    }
    if (element.containerId && custom.kind === 'project-board' && custom.role === 'label') {
      sectionLabels.push({ containerId: element.containerId, text: element.text || '' });
    }
  }
  for (const section of sections) {
    const label = sectionLabels.find((entry) => entry.containerId === section.id);
    out.headers[section.col] = label ? label.text.replace(/\\s*\\n\\s*/g, ' ') : null;
  }
  out.sections = sections;
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  // Where the reader is told what happened. A toast is a sibling of the canvas, so unlike
  // everything else the mirror draws it can simply be read out of the DOM.
  const toast = document.querySelector('.Toast__message');
  out.toast = toast ? toast.textContent : null;
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/**
 * What a stray drag leaves behind, without the drag.
 *
 * A real pointer drag of the `+` cannot be used here: pressing it *is* the press, so the
 * handler answers mid-gesture and hands the selection to the block it just made — and
 * Excalidraw then drags whatever is selected, which is no longer the `+`. The outcome is
 * what case 4 is about, so the outcome is what is set up: the shape and the label bound to
 * it moved out of the header, exactly where a completed drag would have left them.
 */
const NUDGE_ADD = (id, dx, dy) => `(() => {
  const api = window.__boardCheckApi;
  const moved = api.getSceneElements().map((element) => (
    element.id === ${JSON.stringify(id)} || element.containerId === ${JSON.stringify(id)}
      ? { ...element, x: element.x + ${dx}, y: element.y + ${dy}, version: (element.version || 1) + 1 }
      : element));
  api.updateScene({ elements: moved, captureUpdate: 'NEVER' });
  return true;
})()`;

/** The message the reader was shown, taken down so the next press can be seen to say it again. */
const CLEAR_TOAST = `(() => {
  const api = window.__boardCheckApi;
  if (typeof api.setToast === 'function') { api.setToast(null); return 'setToast'; }
  api.updateScene({ appState: { toast: null }, captureUpdate: 'NEVER' });
  return 'updateScene';
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const centreOf = (scene, box) => toViewport(scene, box.x + box.w / 2, box.y + box.h / 2);

/**
 * Nothing selected, so the next press is a fresh arrival wherever it lands.
 *
 * Through the API rather than by clicking empty canvas: three of the six points a click could
 * land on sit under Excalidraw's own properties island, which is on screen precisely because
 * something is selected.
 */
async function deselect() {
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

const NO_TEMPLATE = 'no issue block';
const saidNoTemplate = () => consoleLog.filter((line) => line.includes(NO_TEMPLATE)).length;

/** Re-attach to whichever board the page is now showing. */
async function openBoard(url) {
  await send('Page.navigate', { url });
  await sleep(1500);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');
  // Alt+B fits the mirror to the viewport, the way a reader brings it into view. Pressed once
  // per board and never again: every coordinate below is computed from the view it settles on.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  return evaluate(PROBE);
}

try {
  startServer(STOCKED_PORT, stockedRegistry, {
    // The `+` drops a block *from the library*, so without one every press is a silent no-op
    // and the first half of this check would fail on its own harness.
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentPath.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '1',
  });
  await waitFor(async () => (await fetch(`${STOCKED}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    STOCKED,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  let scene = await openBoard(STOCKED);
  await shot('01-mirror');
  const plus = centreOf(scene, scene.add);
  const home = { x: scene.add.x, y: scene.add.y };

  check('the + is on the notes column, and the column starts empty',
        scene.add?.col === NOTES.id && scene.drafts.length === 0,
        `${JSON.stringify(scene.add)} / ${JSON.stringify(scene.drafts)}`);
  check('and it is unlocked, because a locked shape cannot be pressed',
        scene.add?.locked === false, JSON.stringify(scene.add));
  check('the queue toggle is drawn too, on another column',
        Boolean(scene.queue) && scene.queue.col === TODO.id && scene.queue.col !== scene.add.col,
        JSON.stringify(scene.queue));

  console.log('\n1. a selection that swept a button up with something else does not keep it');
  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  check('one press made one block to select alongside it', scene.drafts.length === 1,
        `${JSON.stringify(scene.drafts)} selected=${JSON.stringify(scene.selected)}`);
  const draft = scene.drafts[0];

  await deselect();
  const block = centreOf(scene, draft);
  await click(block.x, block.y);
  await sleep(400);
  scene = await evaluate(PROBE);
  check('the block is selected on its own first',
        scene.selected.length === 1 && scene.selected[0] === draft.id, JSON.stringify(scene.selected));

  // Shift-click, which is the cheapest of the gestures that do this. A rubber band across the
  // header strip is the other, and lands in the same place: `selectedElementIds` holding the
  // button and something else at once.
  await click(plus.x, plus.y, { modifiers: 8 });
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('02-plus-with-company');
  check('the + is not left in the selection',
        !scene.selected.includes(scene.add.id),
        `selected=${JSON.stringify(scene.selected)} add=${scene.add.id}`);
  check('what the reader actually selected is still selected',
        scene.selected.includes(draft.id), JSON.stringify(scene.selected));
  check('and no second block was dropped by a press nobody made',
        scene.drafts.length === 1, JSON.stringify(scene.drafts.map((entry) => entry.id)));
  check('the + is still in its header',
        Math.abs(scene.add.x - home.x) < 1 && Math.abs(scene.add.y - home.y) < 1,
        `${JSON.stringify(scene.add)} vs ${JSON.stringify(home)}`);

  const queueBefore = scene.queue.on;
  await deselect();
  await click(block.x, block.y);
  await sleep(400);
  const queuePoint = centreOf(scene, scene.queue);
  await click(queuePoint.x, queuePoint.y, { modifiers: 8 });
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('03-queue-with-company');
  check('the queue toggle is not left in a selection either',
        !scene.selected.includes(scene.queue.id),
        `selected=${JSON.stringify(scene.selected)} queue=${scene.queue.id}`);
  check('and a selection is not a press, so the queue did not flip',
        scene.queue.on === queueBefore, `${queueBefore} → ${scene.queue.on}`);

  console.log('\n2. two presses with nothing pressed in between are both answered');
  await deselect();
  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  const answeredFirst = !scene.selected.includes(scene.add.id)
    && scene.selected.some((id) => scene.drafts.some((entry) => entry.id === id));
  check('the first press is answered with a block, and the + does not stay selected',
        answeredFirst, `selected=${JSON.stringify(scene.selected)} drafts=${scene.drafts.length}`);

  const draftsAfterFirst = scene.drafts.length;
  await click(plus.x, plus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('04-second-press');
  const answeredAgain = !scene.selected.includes(scene.add.id)
    && scene.selected.some((id) => scene.drafts.some((entry) => entry.id === id));
  check('so is the second, with nothing clicked between them',
        answeredAgain, `selected=${JSON.stringify(scene.selected)} drafts=${scene.drafts.length}`);
  check('and the cap still holds — a second empty block is not what answered it',
        scene.drafts.length === draftsAfterFirst,
        `${draftsAfterFirst} → ${scene.drafts.length}`);

  console.log('\n3. a + dragged out of its header is put back by the next refresh');
  await deselect();
  await evaluate(NUDGE_ADD(scene.add.id, 180, 220));
  await sleep(500);
  scene = await evaluate(PROBE);
  await shot('05-nudged');
  check('the + really is out of its header to start with',
        Math.abs(scene.add.x - home.x) > 100, `${JSON.stringify(scene.add)} vs ${JSON.stringify(home)}`);
  const header = scene.sections.find((entry) => entry.col === NOTES.id);
  check('and outside the notes header it belongs in', Boolean(header)
        && (scene.add.y > header.y + header.h || scene.add.x > header.x + header.w),
        `${JSON.stringify(scene.add)} against ${JSON.stringify(header)}`);

  // The board polls every twenty seconds, so this waits one out rather than asking for a
  // redraw: what is under test is that an ordinary refresh corrects it, which is what the
  // layout's own comment promises.
  const restored = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.add && Math.abs(now.add.x - home.x) < 1 && Math.abs(now.add.y - home.y) < 1 ? now : null;
  }, 'the + to be put back where the layout wants it', 140).catch(() => null);
  await shot('06-put-back');
  check('one refresh puts it back where layoutMirror puts it',
        restored !== null, JSON.stringify((await evaluate(PROBE)).add));
  const label = restored === null ? null : await evaluate(`(() => {
    const api = window.__boardCheckApi;
    const add = api.getSceneElements().find((element) => element.id === ${JSON.stringify(scene.add.id)});
    const text = api.getSceneElements().find((element) => element.containerId === ${JSON.stringify(scene.add.id)});
    return text ? { x: text.x, y: text.y, addX: add.x, addY: add.y, w: text.width, h: text.height } : null;
  })()`);
  check('with its + drawn on it rather than left behind', label !== null
        && label.x >= label.addX - 1 && label.y >= label.addY - 1,
        JSON.stringify(label));

  console.log('\n4. a library with no issue block: the press says so, and the next one is heard');
  // Empty rather than absent. Since #305 an unset `EXCALIDRAW_LIBRARY` means the library the
  // package ships — which is the one carrying the issue block — so leaving it off would hand
  // this board a template and the whole of section 4 would be asking nothing. An explicitly
  // empty value is how a board says it wants no shared shapes at all.
  startServer(BARREN_PORT, barrenRegistry, { EXCALIDRAW_LIBRARY: '' });
  await waitFor(async () => (await fetch(`${BARREN}/health`)).ok, 'the second canvas server');
  const said = saidNoTemplate();
  scene = await openBoard(BARREN);
  await shot('07-barren-mirror');
  check('the barren board draws a + as well, on an empty notes column',
        scene.add?.col === NOTES.id && scene.drafts.length === 0,
        `${JSON.stringify(scene.add)} / ${JSON.stringify(scene.drafts)}`);
  check('and its library really ships no issue block',
        (await (await fetch(`${BARREN}/api/library?workspace=barren`)).json()).libraryItems
          .every((item) => !(item?.elements ?? []).some((element) => element?.customData?.kind === 'issue')),
        'the workspace library still carries one');

  const barrenPlus = centreOf(scene, scene.add);
  await click(barrenPlus.x, barrenPlus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('08-nothing-to-drop');
  check('no block is dropped, because there is no template to drop',
        scene.drafts.length === 0, JSON.stringify(scene.drafts));
  check('the + is not left selected',
        !scene.selected.includes(scene.add.id),
        `selected=${JSON.stringify(scene.selected)} add=${scene.add.id}`);
  check('and the reader is told why, on the board rather than in a console nobody has open',
        typeof scene.toast === 'string' && scene.toast.includes(NO_TEMPLATE),
        JSON.stringify(scene.toast));

  // Taken down so the next press can be seen to say it again. Not a click on the canvas: the
  // selection is untouched, which is the whole point of the press that follows.
  await evaluate(CLEAR_TOAST);
  await sleep(300);
  check('the message can be dismissed', (await evaluate(PROBE)).toast === null);

  await click(barrenPlus.x, barrenPlus.y);
  await sleep(1200);
  scene = await evaluate(PROBE);
  await shot('09-second-press-barren');
  check('a second press is still heard, and says the same thing',
        typeof scene.toast === 'string' && scene.toast.includes(NO_TEMPLATE),
        JSON.stringify(scene.toast));
  check('which the page said twice, once per press',
        saidNoTemplate() - said === 2, `${saidNoTemplate() - said} warning(s) for two presses`);
  check('and the + is not left selected by that one either',
        !scene.selected.includes(scene.add.id),
        `selected=${JSON.stringify(scene.selected)} add=${scene.add.id}`);
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
