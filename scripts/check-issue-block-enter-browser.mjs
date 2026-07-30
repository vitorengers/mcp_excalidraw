#!/usr/bin/env node
/**
 * Checks that Enter finishes writing an issue block, in a real browser.
 *
 * There is nothing here a type check could be asked. The keystroke is decided inside
 * Excalidraw's own bound-label editor — a real `textarea.excalidraw-wysiwyg` whose
 * `onkeydown` is assigned as an element property — and the whole claim is that a
 * capture-phase listener on `document` runs first and takes the key away from it. Which of
 * two handlers wins is exactly the kind of question this project has been burnt by three
 * times: a panel that never opened, a race in tab initialisation, a click landing on the
 * label. All three compiled.
 *
 * So the claims are asserted where they happen, on a board with two shapes on it — one
 * issue block and one plain rectangle, because "only the issue block" is half the feature:
 *
 *  1. Shift+Enter leaves the editor open and puts a newline in it;
 *  2. Enter closes it, and what was typed reaches the block's bound label with no newline
 *     of its own added;
 *  3. the block is still selected afterwards, so its card is still on screen — a finish
 *     that deselected would close the panel the reader wants next;
 *  4. nothing was started by it: no `POST /api/issue-block/:id` left the page and the
 *     block's `issueState` is what it was;
 *  5. Escape and Ctrl+Enter still finish, since removing a keystroke people already have
 *     in their fingers buys nothing;
 *  6. in the plain rectangle's label editor, on the same canvas, Enter still inserts a
 *     newline.
 *
 * Enter is dispatched with its text (`\r`) rather than as a bare key, because a newline in
 * a textarea is the *default action* of the keypress: a key event with no text attached
 * would appear to pass every case here while inserting nothing, which is the check quietly
 * agreeing with itself.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it starts its own canvas server against a
 * throwaway workspace on a free port and kills it. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-issue-block-enter-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A board with one issue block and one plain shape ─────────

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-enter-'));
const projectDir = join(workDir, 'enter-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'enter-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Enter Check',
  repo: 'vitorengers/mcp_excalidraw',
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
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
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

async function api(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=enter-check`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/**
 * A shape with no label yet.
 *
 * The label is made by the double click, which is how a reader makes one: the `+` drops a
 * block and the reader opens its text. Creating it here would test a different gesture.
 */
async function makeShape(x, y, customData) {
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x, y, width: 360, height: 140, customData }),
  });
  return created.body?.element?.id;
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

async function attachToChrome() {
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
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(200);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(30);
  }
}

const SHIFT = 8;
const CTRL = 2;

/**
 * Enter, carrying the text that makes it insert a newline.
 *
 * Without `text` the browser raises a key event and nothing else, so the default action —
 * the newline — never happens and "no newline was inserted" would be true of every build.
 */
async function pressEnter(modifiers = 0) {
  const base = {
    key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers,
  };
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: '\r', unmodifiedText: '\r' });
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  await sleep(400);
}

async function pressEscape() {
  const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' });
  await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  await sleep(400);
}

/** The same reach for the imperative API the other browser checks use. */
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
        window.__enterCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Watch what the page asks the server for.
 *
 * "The keystroke starts no run" is a claim about a request that was never made, and the
 * only place that is observable is the page's own `fetch`.
 */
const WATCH_FETCH = `(() => {
  if (window.__enterCheckCalls) return true;
  window.__enterCheckCalls = [];
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    window.__enterCheckCalls.push(method.toUpperCase() + ' ' + url);
    return real(input, init);
  };
  return true;
})()`;

/** What the board, the editor and the card look like right now. */
const PROBE = `(() => {
  const api = window.__enterCheckApi;
  if (!api) return { error: 'no api handle' };
  const state = api.getAppState();
  const out = { shapes: {}, labels: {}, calls: (window.__enterCheckCalls || []).slice() };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    if (element.type === 'text' && element.containerId) {
      out.labels[element.containerId] = element.originalText ?? element.text ?? '';
      continue;
    }
    out.shapes[element.id] = {
      x: element.x, y: element.y, w: element.width, h: element.height,
      state: (element.customData || {}).issueState ?? null,
      selected: Boolean(state.selectedElementIds && state.selectedElementIds[element.id]),
    };
  }
  const editor = document.querySelector('textarea.excalidraw-wysiwyg');
  out.editor = editor ? { value: editor.value } : null;
  out.editingContainer = state.editingTextElement
    ? String(state.editingTextElement.containerId || state.editingTextElement.id) : null;
  out.card = Boolean(document.querySelector('.docs-card'));
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  return out;
})()`;

const DESELECT = `(() => {
  window.__enterCheckApi.updateScene({ appState: { selectedElementIds: {} } });
  return true;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const centreOf = (scene, id) => {
  const shape = scene.shapes[id];
  if (!shape) throw new Error(`no shape ${id} in the scene`);
  return toViewport(scene, shape.x + shape.w / 2, shape.y + shape.h / 2);
};

/** Open the label editor on a shape, from a canvas with nothing selected. */
async function openEditor(id) {
  await evaluate(DESELECT);
  await sleep(250);
  const scene = await evaluate(PROBE);
  const centre = centreOf(scene, id);
  await click(centre.x, centre.y, 1);
  await click(centre.x, centre.y, 2);
  await sleep(500);
  return evaluate(PROBE);
}

/** The element as the server holds it — what a run would actually read. */
const stored = async (id) => (await api(`/api/elements/${id}`)).body?.element?.customData ?? {};

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const blockId = await makeShape(0, 0, { kind: 'issue', issueState: 'draft' });
  const plainId = await makeShape(0, 400, {});
  if (!blockId || !plainId) throw new Error(`the shapes were not created\n${serverLog}`);

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

  await attachToChrome();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).shapes[blockId]), 'the shapes to load');
  await evaluate(WATCH_FETCH);

  // Both shapes brought into view at a readable zoom, so a click lands where the
  // arithmetic says it does.
  await evaluate(`(() => {
    const api = window.__enterCheckApi;
    api.scrollToContent(api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.6 });
    return true;
  })()`);
  await sleep(800);
  await shot('01-board');

  console.log('1. Shift+Enter breaks the line; Enter finishes the block');
  let scene = await openEditor(blockId);
  check('a double click opens the label editor on the block',
        Boolean(scene.editor) && scene.editingContainer === blockId,
        `editor=${JSON.stringify(scene.editor)} editing=${scene.editingContainer}`);

  await typeText('alpha');
  await pressEnter(SHIFT);
  scene = await evaluate(PROBE);
  await shot('02-shift-enter');
  check('Shift+Enter leaves the editor open',
        Boolean(scene.editor), `editing=${scene.editingContainer}`);
  check('and puts a newline in it',
        scene.editor?.value === 'alpha\n', JSON.stringify(scene.editor?.value));

  await typeText('beta');
  const callsBefore = (await evaluate(PROBE)).calls.length;
  await pressEnter();
  await sleep(600);
  scene = await evaluate(PROBE);
  await shot('03-enter');
  check('Enter removes the editor from the DOM',
        scene.editor === null && scene.editingContainer === null,
        `editor=${JSON.stringify(scene.editor)} editing=${scene.editingContainer}`);
  check('what was typed reached the block\'s bound label',
        scene.labels[blockId] === 'alpha\nbeta', JSON.stringify(scene.labels[blockId]));

  console.log('\n2. the block is still selected, so its card is still on screen');
  check('the block is selected', scene.shapes[blockId]?.selected === true,
        JSON.stringify(scene.shapes[blockId]));
  check('and the card is on screen', scene.card === true);

  console.log('\n3. nothing was started by the keystroke');
  const newCalls = scene.calls.slice(callsBefore);
  check('no POST /api/issue-block/:id left the page',
        !newCalls.some((call) => /^POST .*\/api\/issue-block\//.test(call)),
        newCalls.join(' | '));
  check('the block is still a draft in the browser',
        (scene.shapes[blockId]?.state ?? 'draft') === 'draft', String(scene.shapes[blockId]?.state));
  const held = await stored(blockId);
  check('and still a draft on the server',
        (held.issueState ?? 'draft') === 'draft', JSON.stringify(held));

  console.log('\n4. Escape and Ctrl+Enter still finish the edit');
  scene = await openEditor(blockId);
  check('the editor opens again', Boolean(scene.editor), `editing=${scene.editingContainer}`);
  await pressEscape();
  scene = await evaluate(PROBE);
  check('Escape finishes it', scene.editor === null, JSON.stringify(scene.editor?.value));

  scene = await openEditor(blockId);
  check('the editor opens once more', Boolean(scene.editor), `editing=${scene.editingContainer}`);
  await pressEnter(CTRL);
  scene = await evaluate(PROBE);
  await shot('04-ctrl-enter');
  check('Ctrl+Enter finishes it', scene.editor === null, JSON.stringify(scene.editor?.value));
  check('and the text is unchanged by either of them',
        scene.labels[blockId] === 'alpha\nbeta', JSON.stringify(scene.labels[blockId]));

  console.log('\n5. a plain shape on the same canvas keeps Enter as a newline');
  scene = await openEditor(plainId);
  check('a double click opens its label editor',
        Boolean(scene.editor) && scene.editingContainer === plainId,
        `editor=${JSON.stringify(scene.editor)} editing=${scene.editingContainer}`);
  await typeText('plain');
  await pressEnter();
  scene = await evaluate(PROBE);
  await shot('05-plain-shape');
  check('Enter leaves that editor open', Boolean(scene.editor),
        `editing=${scene.editingContainer}`);
  check('and inserts a newline the way it always did',
        scene.editor?.value === 'plain\n', JSON.stringify(scene.editor?.value));
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
