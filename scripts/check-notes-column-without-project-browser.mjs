#!/usr/bin/env node
/**
 * Checks that a board whose workspace has no GitHub project still draws the column the canvas
 * owns, and that a run started from a block on it refuses in words rather than in silence.
 *
 * The issue block is the feature this tool is built around, and until #316 it was unreachable
 * until a `githubProject` was written into `board.config.json`. `refreshProjectBoard` read the
 * 404 that a project-less workspace gets from `/api/project-board` as `clearMirror()`, and the
 * notes column and its `+` are drawn by the mirror — so a freshly registered project, which
 * registration never writes a `githubProject` for, had no route to the feature and no sentence
 * saying why: `addIssueBlockToColumn` warned to the browser console, where nobody is looking.
 *
 * The notes column does not mirror anything. It is the one column the canvas draws for itself,
 * under a reserved option id no project can rename away, and every block in it is an
 * observation somebody wrote. None of that needs GitHub, so this asserts it does not ask for
 * it:
 *
 * 1. The workspace really has no project — `/api/project-board` answers 404 — and the board
 *    draws one column, the notes one, with the `+` inside its header.
 * 2. Pressing that `+` puts a draft block *in the server's store*, carrying
 *    `customData.kind === "issue"`. In the store rather than only in the scene, because a
 *    block the autosync never sent is a block that is gone on the next reload.
 * 3. The same press is answered at another zoom. `layoutMirror` computes the notes column's
 *    position relative to the mirrored ones, and drawing it alone means placing a region one
 *    column wide — geometry that compiles identically whether or not it is where a reader can
 *    press it, which is the class of defect CLAUDE.md says this project has paid for three
 *    times. Both zooms are screenshotted as well, so the failure can be looked at.
 * 4. Starting a run on such a block refuses, names what is missing, and writes the reason onto
 *    the block. Writing the observation down is the part that has to work before GitHub is
 *    connected; creating the issue is not, and a run that spawned an agent to find that out
 *    minutes later would be the silent no-op moved rather than removed. The stub agent writes
 *    a marker file if it is ever spawned, so "refused before the agent" is asserted rather
 *    than assumed.
 *
 * Self-contained: it writes one throwaway workspace with a `board.config.json` naming nothing
 * but the project's name, `git init`s it so no `origin` can be inherited from whatever the
 * temporary directory happens to sit under, starts its own canvas server on a port the kernel
 * just handed out, drives headless Chrome over the DevTools protocol, and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first; it loads the built
 * frontend.
 *
 * Usage: node scripts/check-notes-column-without-project-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── One project, configured with nothing ─────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-notes-no-project-'));
const projectDir = join(workDir, 'solo');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const ghStub = join(workDir, 'stub-gh.mjs');
const agentStub = join(workDir, 'stub-agent.mjs');
const agentRan = join(workDir, 'the-agent-ran');

/**
 * What registration writes, and nothing else.
 *
 * `src/core/workspaces.ts` writes `name` and, when it finds one, `docsDir` — never a
 * `githubProject` and never a `repo`. This is that file, so the board under test is every
 * newly registered project rather than a shape invented for the check.
 */
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Solo',
}, null, 2), 'utf8');

/**
 * A git repository with no remote, so the run has nothing to fall back to.
 *
 * `originRepo` reads `git remote get-url origin` in the project, and a temporary directory
 * that happened to sit inside somebody's checkout would answer with *their* repository —
 * the refusal case 4 asserts would then never be reached and the check would pass for the
 * wrong reason. An initialised repository with no origin cannot inherit one.
 */
const git = spawnSync('git', ['init', '-b', 'main'], { cwd: projectDir, encoding: 'utf8' });
if (git.status !== 0) {
  console.error(`  FAIL  git init in the throwaway project — ${git.stderr || git.error?.message}`);
  process.exit(1);
}

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'solo', path: projectDir.replace(/\\/g, '/') }],
}, null, 2), 'utf8');

/** A `gh` that fails loudly: nothing on this board has a project to ask GitHub about. */
writeFileSync(ghStub, `#!/usr/bin/env node
process.stderr.write('a gh stub with no fixture was called: ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`, 'utf8');

/**
 * An agent that records having been spawned and creates nothing.
 *
 * It is configured because an unconfigured one makes the run route answer 404 before it can
 * reach the refusal under test — and the marker it writes is what turns "the run refused" into
 * "the run refused *before* spending minutes finding out".
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(agentRan)}, process.argv.slice(2).join(' '), 'utf8');
process.stdout.write('https://github.com/nobody/nothing/issues/1\\n');
`, 'utf8');

const PORT = await freePort();
const SECOND_PORT = await freePort();
const CDP_PORT = await freePort();
const BOARD = `http://127.0.0.1:${PORT}`;
const SECOND_BOARD = `http://127.0.0.1:${SECOND_PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Where the server saves this workspace's board: beside the registry, named after it. */
const boardStateFile = join(workDir, 'workspaces-state', 'solo.excalidraw');

let serverLog = '';

/**
 * One canvas server, with an environment this check decides and the machine does not.
 *
 * `startCanvas` strips every inherited `EXCALIDRAW_*` first — this machine's shell carries
 * most of a running board's configuration, and `EXCALIDRAW_TERMINAL` alone would put an xterm
 * overlay over the mirror and swallow every press aimed at the `+`.
 */
function startServer(port) {
  const server = startCanvas({
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `server-${port}.log`),
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    },
  }).child;
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  return server;
}

// The reserved id, the column's name and what the strip says come from the compiled modules
// that declare them: a check that agreed with the code only by being typed the same way could
// not pass, and could not fail for the right reason either.
const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const layoutModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-layout.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const NO_PROJECT_TITLE = layoutModule.NO_PROJECT_TITLE;

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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
  });
  await sleep(150);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** Ctrl+wheel, which is how a reader zooms — a real gesture rather than a written app state. */
async function zoomOut(x, y, steps = 8) {
  for (let step = 0; step < steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX: 0, deltaY: 120, modifiers: 2,
    });
    await sleep(120);
  }
  await sleep(600);
}

/** See `check-notes-add-press-browser.mjs`: the canvas has no DOM for a block to be read from. */
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
  const out = { drafts: [], add: null, sections: [], title: null, labels: {} };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        col: custom.sectionOptionId, kind: custom.kind });
    }
    if (custom.kind !== 'project-board') continue;
    if (custom.role === 'add') {
      out.add = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                  locked: element.locked === true, col: custom.sectionOptionId };
    }
    if (custom.role === 'section') {
      out.sections.push({ id: element.id, col: custom.sectionOptionId, x: element.x, y: element.y,
                          w: element.width, h: element.height });
    }
    if (custom.role === 'title') {
      out.title = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (custom.role === 'label' && element.containerId) {
      out.labels[element.containerId] = element.text || '';
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  const toast = document.querySelector('.Toast__message');
  out.toast = toast ? toast.textContent : null;
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/**
 * The panel's own buttons, which are ordinary DOM rather than canvas.
 *
 * Pressed by their text, because that is what a reader presses. `element.click()` reaches
 * React's handler — the panel is rendered by the same page — so this is the run being started
 * the way it is started, not a `fetch` written in the shape of one.
 */
const RUN_LABEL = 'Research and create the issue';
const PANEL_BUTTONS = `[...document.querySelectorAll('button')].map((button) => button.textContent)`;
const PRESS_RUN = `(() => {
  const button = [...document.querySelectorAll('button')]
    .find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(RUN_LABEL)}));
  if (!button) return 'no button';
  button.click();
  return 'pressed';
})()`;
const PANEL_ERROR = `(() => {
  const error = document.querySelector('.element-docs__error');
  return error ? error.textContent : null;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const centreOf = (scene, box) => toViewport(scene, box.x + box.w / 2, box.y + box.h / 2);

const onScreen = (scene, point) =>
  point.x > 0 && point.y > 0 && point.x < scene.view.width && point.y < scene.view.height;

const inside = (box, outer) =>
  box.x >= outer.x - 1 && box.y >= outer.y - 1
  && box.x + box.w <= outer.x + outer.w + 1 && box.y + box.h <= outer.y + outer.h + 1;

const storedElements = async () => {
  const response = await fetch(`${BOARD}/api/elements?workspace=solo`);
  const body = await response.json();
  return body.elements ?? [];
};

async function deselect() {
  await evaluate('window.__boardCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

try {
  // First in `children`, because case 5 kills it by that position to restart the board.
  children.push(startServer(PORT));
  await waitFor(async () => (await fetch(`${BOARD}/health`)).ok, 'the canvas server');

  console.log('\n1. the board really has no project, and draws the column that is not one');
  const boardResponse = await fetch(`${BOARD}/api/project-board?workspace=solo`);
  const boardBody = await boardResponse.json().catch(() => ({}));
  check('/api/project-board answers 404 for a workspace with no githubProject',
        boardResponse.status === 404, `${boardResponse.status} ${JSON.stringify(boardBody)}`);
  check('and says so in words a reader could act on',
        typeof boardBody.error === 'string' && boardBody.error.includes('githubProject'),
        JSON.stringify(boardBody));

  check('the library still ships an issue block for the + to drop',
        ((await (await fetch(`${BOARD}/api/library?workspace=solo`)).json()).libraryItems ?? [])
          .some((item) => (item?.elements ?? []).some((element) => element?.customData?.kind === 'issue')),
        'nothing in the library carries customData.kind === "issue"');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    BOARD,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add),
                'the notes column to be drawn on a board with no project');
  // Alt+B brings the region into view, the way a reader does. Every coordinate below is
  // computed from the view it settles on.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-notes-column');

  check('exactly one column is drawn, and it is the notes column',
        scene.sections.length === 1 && scene.sections[0]?.col === NOTES.id,
        JSON.stringify(scene.sections));
  check('its header names it', (scene.labels[scene.sections[0]?.id] ?? '').includes(NOTES.name),
        JSON.stringify(scene.labels[scene.sections[0]?.id]));
  check('the + is on that column, and unlocked so it can be pressed',
        scene.add?.col === NOTES.id && scene.add?.locked === false, JSON.stringify(scene.add));
  check('and it is inside the header rather than loose on the canvas',
        Boolean(scene.sections[0]) && inside(scene.add, scene.sections[0]),
        `${JSON.stringify(scene.add)} against ${JSON.stringify(scene.sections[0])}`);
  check('the strip says what the region is instead of naming a project it has none of',
        Boolean(scene.title) && (scene.labels[scene.title.id] ?? '').trim() === NO_PROJECT_TITLE,
        `${JSON.stringify(scene.labels[scene.title?.id])} rather than ${JSON.stringify(NO_PROJECT_TITLE)}`);
  check('nothing was drawn for a column GitHub never answered with',
        scene.drafts.length === 0, JSON.stringify(scene.drafts));

  console.log('\n2. the + drops an observation, and the server keeps it');
  const plus = centreOf(scene, scene.add);
  check('the + is somewhere a reader could press', onScreen(scene, plus), JSON.stringify(plus));
  await click(plus.x, plus.y);
  await sleep(1500);
  scene = await evaluate(PROBE);
  await shot('02-block-dropped');
  check('one press drops one block', scene.drafts.length === 1,
        `${JSON.stringify(scene.drafts)} toast=${JSON.stringify(scene.toast)}`);
  check('in the notes column it was pressed on',
        scene.drafts[0]?.col === NOTES.id, JSON.stringify(scene.drafts[0]));
  check('and it really is an issue block',
        scene.drafts[0]?.kind === 'issue', JSON.stringify(scene.drafts[0]));

  const stored = await waitFor(async () => {
    const elements = await storedElements();
    const draft = elements.find((element) => element.customData?.kind === 'issue'
      && element.customData?.projectBoardDraft === true);
    return draft ?? null;
  }, 'the block to reach the server', 40).catch(() => null);
  check('the block reached the store, so a reload would still have it',
        stored !== null, `${(await storedElements()).length} element(s) in the store`);
  check('and the store agrees it is the block the canvas drew',
        stored !== null && stored.id === scene.drafts[0]?.id,
        `${stored?.id} vs ${scene.drafts[0]?.id}`);

  console.log('\n3. the same press is answered at another zoom');
  await deselect();
  // Measured against the zoom `Alt+B` settled on rather than against 1: fitting one column
  // into a 1400x900 window lands at whatever ceiling `boardFitOptions` sets, which is above 1.
  const fitZoom = scene.view.zoom;
  await zoomOut(scene.view.width / 2, scene.view.height / 2);
  scene = await evaluate(PROBE);
  await shot('03-zoomed-out');
  check('the view really changed', scene.view.zoom < fitZoom * 0.8,
        `zoom ${fitZoom} → ${scene.view.zoom}`);
  check('the + is still inside its header at that zoom',
        Boolean(scene.add) && Boolean(scene.sections[0]) && inside(scene.add, scene.sections[0]),
        `${JSON.stringify(scene.add)} against ${JSON.stringify(scene.sections[0])}`);
  const zoomedPlus = centreOf(scene, scene.add);
  check('and still on screen', onScreen(scene, zoomedPlus),
        `${JSON.stringify(zoomedPlus)} in ${scene.view.width}x${scene.view.height}`);

  await click(zoomedPlus.x, zoomedPlus.y);
  await sleep(1500);
  scene = await evaluate(PROBE);
  await shot('04-pressed-zoomed-out');
  // The cap: at most one block nobody has written into, so the press is answered by handing
  // the waiting one back *selected*. That the selection landed on it is the evidence the press
  // was heard at this zoom — a second block would mean the cap broke, not that it worked.
  check('the press is answered — the block already waiting is handed back, selected',
        scene.drafts.length === 1 && scene.selected.includes(scene.drafts[0]?.id),
        `drafts=${JSON.stringify(scene.drafts)} selected=${JSON.stringify(scene.selected)}`);
  check('and the + is not left selected, so it can be pressed again',
        !scene.selected.includes(scene.add?.id),
        `selected=${JSON.stringify(scene.selected)} add=${scene.add?.id}`);

  console.log('\n4. a run on that block refuses, and says what is missing');
  const blockId = scene.drafts[0]?.id;
  // Through the panel the block is already showing rather than through `fetch`: what is under
  // test is a *visible* refusal, and the reader's route to a run is that button.
  check('the panel offers the run', await evaluate(PRESS_RUN) === 'pressed',
        JSON.stringify(await evaluate(PANEL_BUTTONS)));
  const shown = await waitFor(async () => await evaluate(PANEL_ERROR), 'the refusal to be shown',
                              40).catch(() => null);
  await shot('05-refused');
  check('and the refusal is on screen rather than in a console',
        typeof shown === 'string' && /repo/i.test(shown), JSON.stringify(shown));
  check('no agent was spawned to find that out', !existsSync(agentRan),
        'the stub agent wrote its marker, so the run got as far as spawning it');

  const refused = await waitFor(async () => {
    const element = (await storedElements()).find((candidate) => candidate.id === blockId);
    return element?.customData?.issueState === 'failed' ? element : null;
  }, 'the refusal to be written onto the block', 40).catch(() => null);
  check('the reason is on the block, not only in a response nobody kept',
        refused !== null && typeof refused.customData?.issueError === 'string'
          && /repo/i.test(refused.customData.issueError),
        JSON.stringify((await storedElements()).find((candidate) => candidate.id === blockId)?.customData));

  console.log('\n5. the observation outlives the server that took it');
  // The whole point of writing one down before GitHub is connected: a block that is gone at
  // the next start is a note nobody can rely on. The board state is saved beside the registry
  // for every registered workspace, so this asks the second server what the first one kept.
  await waitFor(async () => existsSync(boardStateFile), 'the board to be written to disk', 60);
  children[0].kill('SIGKILL');
  await sleep(800);
  const restarted = startServer(SECOND_PORT);
  children.push(restarted);
  await waitFor(async () => (await fetch(`${SECOND_BOARD}/health`)).ok, 'the restarted canvas server');
  const restored = await (await fetch(`${SECOND_BOARD}/api/elements?workspace=solo`)).json();
  const kept = (restored.elements ?? []).find((element) => element.id === blockId);
  check('the block is still there after a restart', Boolean(kept),
        `${(restored.elements ?? []).length} element(s) came back`);
  check('and it is still an issue block with its observation',
        kept?.customData?.kind === 'issue' && kept?.customData?.projectBoardDraft === true,
        JSON.stringify(kept?.customData));
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
