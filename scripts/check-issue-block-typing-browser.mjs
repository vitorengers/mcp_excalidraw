#!/usr/bin/env node
/**
 * Checks that a scene write arriving from the server cannot take an observation out from
 * under the caret, and that a block that outgrew its template still holds its own label.
 *
 * `check-board-drafts-typing-browser.mjs` covers the other half of the same ground and is
 * deliberately narrower: it exercises `relayoutForDrafts`, which #132 taught to leave the
 * block under the caret alone, and it asserts `originalText` only — stated at its own
 * :290-292. `originalText` is what the editor holds; `text` is the wrapped copy the canvas
 * *draws*. A rebuild that re-derives one from a stale copy of the other looks perfect to
 * that check and shows the reader a word that has gone.
 *
 * So this asks the questions that check declines to:
 *
 * 1. **A remote `element_updated` mid-typing changes nothing under the caret.** Every
 *    socket event goes through `mergeAndApplySceneElements`, which runs the whole scene
 *    through `convertToExcalidrawElements` — a deep clone that rebuilds a bound label
 *    through `newTextElement`, taking `text` verbatim and re-measuring it. Nothing on that
 *    path ever asked whether a label editor was open. The event is a real one: a `PUT` on
 *    the block, which is what pasting a screenshot into the issue panel does.
 *
 *    Read back: the label's `text` — not only `originalText` — holds every character typed;
 *    the editor is still open (`appState.editingTextElement` still set and the textarea
 *    still in the DOM); and the container and the label are still the same *objects*, which
 *    is what `check-board-drafts-typing-browser.mjs:559-561` asserts for the relayout.
 *
 *    Which of those fails distinguishes the two hypotheses in #190 — a stale `text` on a
 *    still-open editor is A, an editor that closed itself is B — so the run says which it
 *    found either way.
 *
 * 2. **A label taller than the block's template still sits inside the block.** The library
 *    ships a 400x140 issue block, and nothing in the browser ever makes that container fit
 *    its bound text: the height is on loan from Excalidraw's editor-only auto-grow, and a
 *    rebuild hands it back. `recenterBoundShapeTextElements` then centres a ~180px label in
 *    a 140px box, which puts its top ~20px *above* the block — the cut first lines in the
 *    report. Asserted as `label.y >= container.y`, with the editor closed, so it cannot pass
 *    on the strength of the guard in case 1.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas server against a
 * throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-issue-block-typing-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
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

const WORKSPACE = 'issue-typing-check';
const workDir = mkdtempSync(join(tmpdir(), 'check-issue-typing-'));
const projectDir = join(workDir, WORKSPACE);
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const notesModule = await import(pathToFileURL(
  join(repoRoot, 'dist', 'core', 'project-board-types.js')
).href);
const NOTES = { id: notesModule.NOTES_OPTION_ID, name: notesModule.NOTES_NAME };
const TODO = { id: 'f75ad846', name: 'Todo' };
const DONE = { id: '98236657', name: 'Done' };
void NOTES;

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
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Issue Typing Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = 35700 + (process.pid % 200);
const CDP_PORT = PORT + 250;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The terminal block's xterm panel is a DOM overlay over the canvas, and a click aimed at a
// block would land on it instead. This board wants no terminals, whatever this machine's
// shell happens to export.
const serverEnv = { ...process.env };
delete serverEnv.EXCALIDRAW_TERMINAL;

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...serverEnv,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
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
    await sleep(35);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
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
        window.__issueTypingApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The scene, with both halves of every bound label read back.
 *
 * `text` as well as `originalText`: the first is the wrapped copy the canvas paints and the
 * second is what the editor holds, and the whole of case 1 is that they can disagree.
 */
const PROBE = `(() => {
  const api = window.__issueTypingApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], cards: [], labels: {}, add: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, h: element.height, col: custom.sectionOptionId });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (element.type === 'text' && element.containerId) {
      out.labels[element.containerId] = {
        id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
        text: element.text, originalText: element.originalText,
      };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editingId = state.editingTextElement ? state.editingTextElement.id : null;
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/** Hold on to the element objects behind a set of ids. See `check-board-drafts-typing-browser.mjs`. */
const WATCH = (ids) => `(() => {
  const api = window.__issueTypingApi;
  const wanted = new Set(${JSON.stringify(ids)});
  window.__issueTypingWatch = new Map();
  for (const element of api.getSceneElementsIncludingDeleted()) {
    if (wanted.has(element.id)) window.__issueTypingWatch.set(element.id, element);
  }
  return window.__issueTypingWatch.size;
})()`;

/** Which of the watched elements are no longer the objects they were. */
const REPLACED = `(() => {
  const api = window.__issueTypingApi;
  const now = new Map(api.getSceneElementsIncludingDeleted().map((element) => [element.id, element]));
  const out = [];
  for (const [id, element] of window.__issueTypingWatch) {
    if (now.get(id) !== element) out.push(id);
  }
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/**
 * Long enough to wrap several times over and to outgrow the block's 140px template.
 *
 * The report is of an observation of about this length losing words out of the middle of it
 * and its first lines off the top, so this is the length the check types.
 */
const TYPED = 'When I am writing an issue in the issue block the rest of the sentence very '
  + 'often disappears and only the word being typed is left on the canvas, and past a '
  + 'certain length the first lines stop being shown at all. This one is long enough to '
  + 'wrap well past the hundred and forty pixels the library template ships, so the block '
  + 'has to have grown to hold it by the time the last word is in.';

/** Typed in pieces, so the block can be asked what it holds between the keystrokes. */
const CHUNK = 24;

/** One line, however it happens to have been wrapped. A dropped word survives this. */
const oneLine = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Make the server send this block an `element_updated`, the way a pasted screenshot does.
 *
 * A real `PUT /api/elements/:id` with a real `customData` write — `writeIssueImages` is
 * exactly this request — so the event the page receives is the product's own, not one
 * synthesised into its socket.
 */
async function injectRemoteUpdate(elementId, marker) {
  const listed = await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`);
  const body = await listed.json();
  const stored = (body.elements ?? []).find((element) => element.id === elementId);
  if (!stored) throw new Error(`the server has never heard of ${elementId}`);
  const response = await fetch(`${BASE}/api/elements/${elementId}?workspace=${WORKSPACE}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customData: { ...(stored.customData ?? {}), issueImages: [marker] },
    }),
  });
  if (!response.ok) throw new Error(`PUT ${elementId} — HTTP ${response.status}`);
  // Long enough for the broadcast to cross the socket and for React to have written it.
  await sleep(600);
  // What the page was sent, which is the server's whole copy and not just the field written.
  return stored;
}

const sampleOf = async (blockId) => {
  const scene = await evaluate(PROBE);
  return {
    block: scene.drafts.find((draft) => draft.id === blockId) ?? null,
    label: scene.labels[blockId] ?? null,
    editingId: scene.editingId,
    editorOpen: scene.editorOpen,
    replaced: await evaluate(REPLACED),
  };
};

const detailOf = (sample) => `text=${JSON.stringify(sample.label?.text ?? null)} `
  + `originalText=${JSON.stringify(sample.label?.originalText ?? null)} `
  + `label=${JSON.stringify(sample.label && { x: sample.label.x, y: sample.label.y, h: sample.label.h })} `
  + `block=${JSON.stringify(sample.block)} `
  + `editingId=${sample.editingId} editorOpen=${sample.editorOpen} `
  + `replaced=${JSON.stringify(sample.replaced)}`;

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
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 1, 'the mirror to render');

  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  console.log('1. a remote update mid-typing leaves the observation under the caret alone');

  const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
  await click(plus.x, plus.y);
  await sleep(900);
  // Nothing selected before the double click: a selected block puts Excalidraw's properties
  // island over the left of the canvas, and the first column is under it.
  await evaluate('window.__issueTypingApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  check('the + dropped one issue block', scene.drafts.length === 1, JSON.stringify(scene.drafts));
  const block = scene.drafts[0];
  const labelId = scene.labels[block.id]?.id ?? null;
  check('the block has a bound label', Boolean(labelId), JSON.stringify(scene.labels));

  const centre = toViewport(scene, block.x + block.w / 2, block.y + block.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(500);
  check('a double click opens the label editor', (await evaluate(PROBE)).editorOpen);

  // The first character replaces the library's placeholder, so everything read back below is
  // the typed observation and nothing else.
  await typeText(TYPED[0]);
  await sleep(300);
  check('the first character replaced the block\'s placeholder',
        (await evaluate(PROBE)).labels[block.id]?.originalText === TYPED[0],
        JSON.stringify((await evaluate(PROBE)).labels[block.id]?.originalText));

  // The block has to be on the server before it can be updated from there: the autosync is
  // what puts it there, and it is debounced.
  await waitFor(async () => {
    const listed = await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`);
    const body = await listed.json();
    return (body.elements ?? []).some((element) => element.id === block.id);
  }, 'the autosync to put the block on the server');

  check('the container was found in the scene', (await evaluate(WATCH([block.id]))) === 1, block.id);

  // Type the rest in chunks, with one real remote update landing in the middle of it.
  //
  // The container is watched throughout: Excalidraw grows one by mutating it in place and
  // never hands back a new object for a container whose label is being edited, so a
  // different object at any sample is one this page's own redraw put there.
  //
  // The label cannot be watched the same way, and this is why the check has to be careful
  // about it: Excalidraw replaces the *text* element on every keystroke — that is how it
  // writes the text — so across a chunk a new object means nothing. It is snapshotted
  // immediately before the remote update instead, and read immediately after, with no
  // keystroke in between: anything replaced across that gap was replaced by the update.
  const samples = [];
  let replacedByUpdate = null;
  for (let at = 1; at < TYPED.length; at += CHUNK) {
    const piece = TYPED.slice(at, at + CHUNK);
    await typeText(piece);
    if (replacedByUpdate === null && at + CHUNK >= TYPED.length / 2) {
      await evaluate(WATCH([block.id, labelId]));
      await injectRemoteUpdate(block.id, 'probe-mid-typing');
      replacedByUpdate = await evaluate(REPLACED);
      // Taken here rather than after the loop: everything after the last keystroke is
      // spending the autosync debounce that case 2 needs unspent.
      await shot('02-typed-with-remote-update');
      await evaluate(WATCH([block.id]));
    }
    samples.push({ typed: TYPED.slice(0, at + piece.length), ...(await sampleOf(block.id)) });
  }
  check('a remote update really did land mid-typing', replacedByUpdate !== null);

  const end = samples[samples.length - 1];
  const after = samples.filter((sample) => sample.typed.length >= TYPED.length / 2);

  // The case itself. `text` is what the canvas paints, and it is the assertion
  // `check-board-drafts-typing-browser.mjs` declines to make.
  const wrongText = after.find((sample) => oneLine(sample.label?.text) !== oneLine(sample.typed));
  check('the label the canvas paints held every character typed, at every sample',
        !wrongText, detailOf(wrongText ?? end));
  const wrongOriginal = after.find((sample) => sample.label?.originalText !== sample.typed);
  check('and so did the copy the editor holds',
        !wrongOriginal, detailOf(wrongOriginal ?? end));

  const closed = after.find((sample) => !sample.editingId || !sample.editorOpen);
  check('the editor stayed open across the remote update',
        !closed, detailOf(closed ?? end));

  check('the update rebuilt neither the container nor the label under the caret',
        Array.isArray(replacedByUpdate) && replacedByUpdate.length === 0,
        JSON.stringify(replacedByUpdate));

  const rebuilt = after.find((sample) => sample.replaced.length > 0);
  check('and the container is still the same object at every sample after it',
        !rebuilt, detailOf(rebuilt ?? end));

  // #190 leaves open which of its two hypotheses operates. Whichever this run saw is worth
  // saying out loud: the fix covers both, but only one of them is a defect anybody else has
  // to go on looking for.
  console.log(`        hypothesis: ${
    closed ? 'B — the editor closed itself under the update'
      : wrongText ? 'A — the editor stayed open and the painted text went stale'
        : 'neither reproduced in this run'}`);

  console.log('\n2. a label taller than the template still sits inside its block');

  // The caret leaves first, so nothing below can pass on the strength of case 1's guard —
  // and it leaves *without a pause*, because the pause is the whole point. The autosync is
  // debounced by 1200 ms and a keystroke re-arms it, so through a burst of typing the
  // server's copy of the container is the one from before it grew. Any `element_updated`
  // for the block in that window — a pasted screenshot is the reported one — is merged over
  // the live element field by field, and hands the container its template height back while
  // the label bound to it is twice that. `recenterBoundShapeTextElements` then centres the
  // label in a box too short for it, and half the overflow goes off the top.
  await pressKey('Escape', 'Escape', 0, 27);

  const grown = await sampleOf(block.id);
  check('the block outgrew the 140px template, so there is something to hold',
        Boolean(grown.block) && grown.block.h > 140, JSON.stringify(grown.block));
  check('the editor is closed, so nothing here can pass on the guard in case 1',
        !grown.editingId && !grown.editorOpen, detailOf(grown));

  const stale = await injectRemoteUpdate(block.id, 'probe-after-typing');
  const settled = await sampleOf(block.id);
  await shot('03-after-rebuild');

  // Stated rather than assumed: without a stale copy on the server there is nothing here to
  // revert the height, and the case below would pass for the wrong reason.
  check('the update the server sent really was from before the block grew',
        Number(stale?.height) < Number(grown.block?.h),
        `server ${stale?.height} vs canvas ${grown.block?.h}`);

  check('the label still holds what was typed after the rebuild',
        oneLine(settled.label?.text) === oneLine(TYPED), detailOf(settled));
  check('the label\'s top edge is not above the block\'s',
        Boolean(settled.label) && Boolean(settled.block)
        && settled.label.y >= settled.block.y - 0.5, detailOf(settled));
  check('and its bottom edge is not below the block\'s',
        Boolean(settled.label) && Boolean(settled.block)
        && settled.label.y + settled.label.h <= settled.block.y + settled.block.h + 0.5,
        detailOf(settled));
} catch (error) {
  failures++;
  console.error(`  FAIL  the run finished — ${error.message}`);
} finally {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds the profile */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
process.exit(failures === 0 ? 0 : 1);
