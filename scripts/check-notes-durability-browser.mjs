#!/usr/bin/env node
/**
 * Checks that a My Notes draft survives everything that can take it away.
 *
 * #225: "Drafts created in the My Notes (even the ones that hasnt started to be researched)
 * section should be saved somewhere. It cannot be lost for some refresh, server restart or any
 * other unexpected occurences." A draft is the one thing on the canvas that exists nowhere
 * else — no issue, no branch, no project item, and until #225 no file either. Two independent
 * ways it was lost, and this check asks about both:
 *
 *   1. **A dropped socket.** `scheduleAutoSync` opened with a bare `return` when
 *      `!isConnected`, so a change made while the socket was down was left with no timer
 *      behind it and nothing that would ever arm one — #92's defect, untreated, in the same
 *      function that treats it six lines below. The reconnect then destroyed the evidence:
 *      `initial_elements` replaced the scene wholesale from a store that had never heard of
 *      the draft, so it left the canvas as well.
 *   2. **A store that is memory only.** The board was read from `boardFile` at startup (#184)
 *      and never written back, so every draft since the last hand-run `scripts/export-board.mjs`
 *      died with the process.
 *
 * What it does, in the order a person would hit it: drop a draft, take the socket away, type
 * one into the dark, bring the socket back, then kill the server outright — `SIGKILL`, because
 * "any other unexpected occurrences" is not a graceful shutdown — and start another on the same
 * registry. The controls are as important as the cases: the mirror's cards and the terminal
 * block are derived and must *not* come back, a run that was in flight must come back demoted
 * rather than asserted as running, and nothing may be written into the project directory.
 *
 * The socket is taken away inside the page rather than by stopping the server: `WebSocket` is
 * wrapped before the document runs, and while `window.__blockSockets` is up every socket the
 * page opens is pointed at a port nothing listens on. That is a genuine drop — `onclose` with a
 * non-1000 code, the reconnect ladder, the pill going grey — with the HTTP side still up, which
 * is what makes "the change reaches the server once the socket returns" a question about the
 * autosync rather than about the server being back.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas servers against a
 * throwaway workspace and a throwaway state directory, and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-notes-durability-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project to draft in, and the stubs behind it ───────────

const workDir = mkdtempSync(join(tmpdir(), 'check-notes-durability-'));
const projectDir = join(workDir, 'durability');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

/**
 * The notes column's id and name from the compiled module that reserves them.
 *
 * A check that agreed with the code only by being typed the same way could not fail when the
 * code moved, and this column's id is exactly the sort of thing that moves (#117).
 */
const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const TODO = { id: 'f75ad846', name: 'Todo' };
const REPO = 'vitorengers/mcp_excalidraw';

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 9,
        title: 'Something already researched',
        url: `https://github.com/${REPO}/issues/9`,
        createdAt: '2026-07-05T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: REPO },
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
  workspaces: [{ id: 'durability', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No `board` on purpose: this project declares no board file, so everything that comes back
// after the restart came back through the save half and through nothing else.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Durability',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const DEAD_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WORKSPACE = 'durability';
// Where the board is expected to be saved, worked out the way the server works it out: beside
// the registry that lists the project, in a directory named after it. Nothing here sets
// `EXCALIDRAW_BOARD_STATE` — the default is what every board actually uses, and following the
// registry is also what keeps this check's `durability` from colliding with anybody's.
const STATE_FILE = join(workDir, 'workspaces-state', `${WORKSPACE}.excalidraw`);
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'info',
  // Only warnings and errors reach stderr; what a board was read back from is an `info`, and
  // the file is the only place it is written.
  LOG_FILE_PATH: join(workDir, 'server.log'),
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
  STUB_GH_FIXTURE: fixturePath,
  // The `+` drops a block *from the library*, so without one every click is a silent no-op
  // and the check would fail on its own harness rather than on the feature.
  EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
};
// Nothing this machine exports reaches the child: `scripts/lib/spawn-canvas.mjs` strips every
// `EXCALIDRAW_*` before the check's own values go in, so there is no terminal block over the
// board — and no other inherited setting — unless this check asks for it.

let serverLog = '';
let server = null;

function startServer() {
  const child = startCanvas({
    env: serverEnv,
  }).child;
  children.push(child);
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  return child;
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
    await sleep(30);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/**
 * Take the socket away without taking the server away.
 *
 * Installed before the document runs, so the very first socket the page opens goes through it.
 * While the flag is up every new socket is pointed at a port nothing listens on: the page sees
 * a refusal, `onclose` with a non-1000 code, and the reconnect ladder — a real drop, with the
 * HTTP side still answering.
 */
const WRAP_SOCKETS = `(() => {
  const Real = window.WebSocket;
  window.__sockets = [];
  window.__blockSockets = false;
  const Wrapped = function (url, protocols) {
    const target = window.__blockSockets ? 'ws://127.0.0.1:${DEAD_PORT}/blocked' : url;
    const socket = protocols === undefined ? new Real(target) : new Real(target, protocols);
    window.__sockets.push(socket);
    return socket;
  };
  Wrapped.prototype = Real.prototype;
  Wrapped.CONNECTING = Real.CONNECTING;
  Wrapped.OPEN = Real.OPEN;
  Wrapped.CLOSING = Real.CLOSING;
  Wrapped.CLOSED = Real.CLOSED;
  window.WebSocket = Wrapped;
})()`;

/** The Excalidraw imperative API, through the container's React fibre. */
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
        window.__durabilityApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__durabilityApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], add: null, sockets: [] };
  const labels = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        col: custom.sectionOptionId || null, text: null });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height, col: custom.sectionOptionId };
    }
    if (element.containerId && element.type === 'text') {
      labels.push({ containerId: element.containerId, text: element.originalText || element.text || '' });
    }
  }
  for (const draft of out.drafts) {
    const label = labels.find((entry) => entry.containerId === draft.id);
    draft.text = label ? label.text.replace(/\\s+/g, ' ').trim() : null;
  }
  for (const socket of (window.__sockets || [])) {
    out.sockets.push({ url: socket.url, state: socket.readyState });
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
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
  await evaluate('window.__durabilityApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

const api = async (path, options = {}) => {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${WORKSPACE}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/** Everything the server holds for this board, by id. */
async function storedElements() {
  const { body } = await api('/api/elements');
  return body.elements ?? [];
}

async function stored(id) {
  const elements = await storedElements();
  const block = elements.find((element) => element.id === id) ?? null;
  const text = elements.filter((element) => element.containerId === id)
    .map((label) => (label.originalText ?? label.text ?? '').trim())
    .filter(Boolean)
    .join(' ⏐ ');
  return { block, text };
}

/** Wait for a condition on the store, and answer how long it took — or null. */
async function reaches(predicate, budgetMs) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(150);
  }
  return null;
}

/** Put one element straight into the store, the way anything but the browser writes. */
async function postElement(element) {
  return api('/api/elements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(element),
  });
}

const KEPT = 'Kept across a restart';
const TYPED = 'Written while the socket was down';

try {
  server = startServer();
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
    'about:blank',
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  // Before the document, so the page's own socket is the first one through the wrapper.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: WRAP_SOCKETS });
  await send('Page.navigate', { url: BASE });

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view. Pressed once
  // and never again: every coordinate below is computed from the view it settles on.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  check('the + is on the notes column, and the column starts empty',
        scene.add?.col === NOTES.id && scene.drafts.length === 0,
        `${JSON.stringify(scene.add)} / ${JSON.stringify(scene.drafts)}`);
  const plus = plusAt(scene);

  console.log('\n1. a draft dropped with the socket up reaches the server');
  for (let attempt = 0; attempt < 3 && scene.drafts.length === 0; attempt++) {
    await deselect();
    await click(plus.x, plus.y);
    await sleep(700);
    scene = await evaluate(PROBE);
  }
  check('the + drops one block', scene.drafts.length === 1, JSON.stringify(scene.drafts));
  const first = scene.drafts[0];
  const firstArrived = await reaches(async () => Boolean((await stored(first.id)).block), 6000);
  check('and it is in the store', firstArrived !== null, `still absent after 6000 ms (${first?.id})`);

  // Written into, and not only because an observation is what a draft is for: the `+` hands
  // back the block nobody has written into rather than dropping a second one (#150), so a
  // block still holding the library's sentence would make the offline case below impossible.
  await deselect();
  scene = await evaluate(PROBE);
  const firstCentre = toViewport(scene, first.x + first.w / 2, first.y + first.h / 2);
  await click(firstCentre.x, firstCentre.y, 2);
  await sleep(400);
  check('a double click opens the text editor on it', (await evaluate(PROBE)).editorOpen);
  await typeText(KEPT);
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(400);
  const keptArrived = await reaches(async () => (await stored(first.id)).text.includes(KEPT), 8000);
  check('and what is typed into it reaches the store while the socket is up',
        keptArrived !== null, `the store has ${JSON.stringify((await stored(first.id)).text)}`);
  await shot('01-first-draft');

  console.log('\n2. the socket goes down, and a draft typed into the dark is not lost');
  await evaluate('window.__blockSockets = true');
  await evaluate(`(() => {
    const sockets = window.__sockets || [];
    const live = sockets[sockets.length - 1];
    if (live) live.close(4001, 'check-notes-durability');
    return true;
  })()`);
  // Down means the page tried again and failed: the last socket it opened points at the dead
  // port and is not open. Waiting on that rather than on a stopwatch.
  const wentDown = await waitFor(async () => {
    const sockets = (await evaluate(PROBE)).sockets;
    const live = sockets[sockets.length - 1];
    return live && live.url.includes(`:${DEAD_PORT}`) && live.state !== 1;
  }, 'the socket to be down', 40);
  check('the socket is down', Boolean(wentDown));

  await deselect();
  scene = await evaluate(PROBE);
  await click(plusAt(scene).x, plusAt(scene).y);
  await sleep(700);
  scene = await evaluate(PROBE);
  const second = scene.drafts.find((draft) => draft.id !== first.id) ?? null;
  check('a second block is dropped while the socket is down',
        Boolean(second), JSON.stringify(scene.drafts));

  if (second) {
    await deselect();
    scene = await evaluate(PROBE);
    const centre = toViewport(scene, second.x + second.w / 2, second.y + second.h / 2);
    await click(centre.x, centre.y, 2);
    await sleep(400);
    check('a double click opens the text editor on it', (await evaluate(PROBE)).editorOpen);
    await typeText(TYPED);
    await pressKey('Escape', 'Escape', 0, 27);
    await sleep(400);
    await shot('02-typed-offline');

    const onScreen = (await evaluate(PROBE)).drafts.find((draft) => draft.id === second.id)?.text ?? '';
    check('the observation is in the block on screen', onScreen.includes(TYPED),
          `the block reads ${JSON.stringify(onScreen)}`);

    // The control for the case below: what was typed cannot have reached the server yet, so
    // what arrives after the reconnect arrived *because of* the reconnect. Asked of the text
    // rather than of the block, because a debounce armed before the socket dropped can still
    // carry the shape up — it is the writing that is stranded, and the writing is the draft.
    check('and what was typed has not reached the server while the socket is down',
          !(await stored(second.id)).text.includes(TYPED),
          'the store already holds it');

    console.log('\n3. the socket comes back');
    await evaluate('window.__blockSockets = false');
    const backUp = await waitFor(async () => {
      const sockets = (await evaluate(PROBE)).sockets;
      const live = sockets[sockets.length - 1];
      return live && !live.url.includes(`:${DEAD_PORT}`) && live.state === 1;
    }, 'the socket to come back', 60);
    check('the socket is back', Boolean(backUp));

    // Both halves, and the second is the one #225 is about: a reconnect that replaces the
    // scene from a store which never heard of this draft takes it off the canvas as well.
    const typedArrived = await reaches(
      async () => (await stored(second.id)).text.includes(TYPED), 10000);
    check('the draft typed while the socket was down reaches the server once it returns',
          typedArrived !== null,
          `still absent 10 s after the socket came back — the store has ${JSON.stringify((await stored(second.id)).text)}`);
    const stillDrawn = (await evaluate(PROBE)).drafts.find((draft) => draft.id === second.id) ?? null;
    check('and it is still on the canvas',
          Boolean(stillDrawn) && String(stillDrawn.text ?? '').includes(TYPED),
          JSON.stringify(stillDrawn));
    await shot('03-reconnected');
  }

  console.log('\n4. what a restart must and must not bring back');
  // Two runs that were in flight when the process stopped, and two shapes that are nobody's to
  // save. Written straight into the store, which is where a saved board would find them.
  await postElement({
    id: 'pbdraft-inflight-nourl', type: 'rectangle', x: -8000, y: -8000, width: 300, height: 90,
    customData: {
      kind: 'issue', projectBoardDraft: true, sectionOptionId: NOTES.id, draftCreatedAt: 1,
      issueState: 'running', issueStartedAt: new Date().toISOString(),
    },
  });
  await postElement({
    id: 'pbdraft-inflight-url', type: 'rectangle', x: -8000, y: -7800, width: 300, height: 90,
    customData: {
      kind: 'issue', projectBoardDraft: true, sectionOptionId: NOTES.id, draftCreatedAt: 2,
      issueState: 'running', issueUrl: `https://github.com/${REPO}/issues/9`,
    },
  });
  await postElement({
    id: 'derived-mirror-card', type: 'rectangle', x: -9000, y: -9000, width: 300, height: 90,
    customData: { kind: 'project-board', role: 'card', sectionOptionId: TODO.id },
  });
  await postElement({
    id: 'derived-terminal-block', type: 'rectangle', x: -9000, y: -8800, width: 300, height: 90,
    customData: { kind: 'terminal' },
  });
  // The save is debounced; a kill a moment later is what "unexpected occurrence" means, but a
  // kill *before* anything could have been written would only be measuring the debounce.
  await sleep(2500);

  const projectFilesBefore = readdirSync(projectDir).sort();

  // Nothing on the page can help once it is on about:blank, which is the point: everything
  // asserted below came out of the save half and out of nothing else.
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(500);

  // SIGKILL: no shutdown hook runs, no `close` handler, nothing gets a last word.
  server.kill('SIGKILL');
  await waitFor(async () => {
    try { await fetch(`${BASE}/health`); return false; } catch { return true; }
  }, 'the server to be gone', 40);

  const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
  check('the board was saved outside the project, on its own',
        Boolean(saved) && Array.isArray(saved.elements) && saved.elements.length > 0,
        `nothing at ${STATE_FILE}`);
  check('and nothing was written into the project directory',
        JSON.stringify(readdirSync(projectDir).sort()) === JSON.stringify(projectFilesBefore),
        `${JSON.stringify(projectFilesBefore)} became ${JSON.stringify(readdirSync(projectDir).sort())}`);

  serverLog = '';
  const logBefore = existsSync(join(workDir, 'server.log'))
    ? readFileSync(join(workDir, 'server.log'), 'utf8').length
    : 0;
  server = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the second canvas server');
  await waitFor(async () => (await storedElements()).length > 0, 'the saved board to be read back');

  const back = await storedElements();
  const byId = new Map(back.map((element) => [element.id, element]));
  const textOf = async (id) => (await stored(id)).text;

  check('the draft dropped with the socket up survives the restart, with what was typed into it',
        byId.has(first.id) && (await textOf(first.id)).includes(KEPT),
        `${first.id} among ${back.length} element(s): ${JSON.stringify(await textOf(first.id))}`);
  if (second) {
    check('the draft typed while the socket was down survives it too',
          byId.has(second.id) && (await textOf(second.id)).includes(TYPED),
          `${second.id}: ${JSON.stringify(await textOf(second.id))}`);
  }
  check('a never-researched draft comes back with no issue on it',
        byId.get(first.id) && !byId.get(first.id).customData?.issueUrl
        && !byId.get(first.id).customData?.issueState,
        JSON.stringify(byId.get(first.id)?.customData));
  check('and still in the notes column',
        byId.get(first.id)?.customData?.sectionOptionId === NOTES.id,
        JSON.stringify(byId.get(first.id)?.customData));

  console.log('\n5. the controls');
  check('a run that was in flight comes back demoted to a draft, not asserted as running',
        byId.has('pbdraft-inflight-nourl')
        && !byId.get('pbdraft-inflight-nourl').customData?.issueState,
        JSON.stringify(byId.get('pbdraft-inflight-nourl')?.customData));
  check('and one that had already produced an issue comes back as created',
        byId.get('pbdraft-inflight-url')?.customData?.issueState === 'created',
        JSON.stringify(byId.get('pbdraft-inflight-url')?.customData));
  check("the mirror's cards are not persisted", !byId.has('derived-mirror-card'),
        JSON.stringify(byId.get('derived-mirror-card')?.customData));
  check('nor is the terminal block', !byId.has('derived-terminal-block'),
        JSON.stringify(byId.get('derived-terminal-block')?.customData));
  check('and neither is in the saved file either',
        Boolean(saved) && !saved.elements.some((element) => ['project-board', 'terminal']
          .includes(element?.customData?.kind)),
        JSON.stringify((saved?.elements ?? []).map((element) => element?.customData?.kind)));
  // Non-vacuous: the page is on about:blank and cannot have put any of this back, and the
  // server names the file it read rather than leaving the reader to guess which of the two
  // sources answered.
  const restartLog = readFileSync(join(workDir, 'server.log'), 'utf8').slice(logBefore);
  check('the server says which file it read the board back from',
        new RegExp(`Loaded \\d+ element\\(s\\) into "${WORKSPACE}" from .*${WORKSPACE}\\.excalidraw`)
          .test(restartLog.replace(/\\/g, '/')),
        restartLog.slice(-600));

  console.log('\n6. and the reader sees it back in the notes column');
  await send('Page.navigate', { url: BASE });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the restart');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render again');
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1500);
  const after = await evaluate(PROBE);
  await shot('04-after-restart');
  const drawnFirst = after.drafts.find((draft) => draft.id === first.id) ?? null;
  check('the first draft is drawn again, in the notes column',
        Boolean(drawnFirst) && drawnFirst.col === NOTES.id, JSON.stringify(after.drafts));
  if (second) {
    const drawnSecond = after.drafts.find((draft) => draft.id === second.id) ?? null;
    check('and so is the one typed while the socket was down, with what was typed into it',
          Boolean(drawnSecond) && String(drawnSecond.text ?? '').includes(TYPED),
          JSON.stringify(after.drafts));
  }
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
