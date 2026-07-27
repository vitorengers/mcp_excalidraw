#!/usr/bin/env node
/**
 * Checks pasting a screenshot onto an issue block, in a real browser.
 *
 * `check-pasted-images.mjs` covers the arithmetic; this covers what the arithmetic is
 * wired to. It has to be a browser, and not because of a preference: the whole question
 * here is which of two `paste` listeners on `document` wins. Excalidraw registers one and
 * turns the image into a scene element, and the ordinary gesture — click the block, panel
 * opens, Ctrl+V — leaves focus inside the Excalidraw container with the cursor over the
 * canvas, which is exactly the case Excalidraw claims. None of that is visible from a type
 * check; the first attempt at this feature is precisely the one that compiles, attaches
 * nothing, and drops the screenshot on the board instead.
 *
 * So the claims are asserted where they happen:
 *
 *  1. with a draft block selected, a paste attaches — a thumbnail in the card and an id in
 *     `customData.issueImages`, with bytes behind it, which is what the run reads;
 *  2. the same paste does not also become an image element on the canvas;
 *  3. text is not swallowed, and neither is a paste landing in something being typed into;
 *  4. a block whose issue already exists is not claimed at all, so it behaves as it did.
 *
 * The paste is a constructed `ClipboardEvent` rather than a real Ctrl+V, because there is
 * no way to put a bitmap on a headless machine's clipboard. Everything else is real: the
 * mouse is moved over the canvas and the Excalidraw container focused first, so both
 * listeners see the two facts they decide on — what has focus, and what is under the
 * pointer.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it starts its own canvas server against a
 * throwaway workspace and kills it. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-pasted-images-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** A real 1×1 PNG — small, but a screenshot as far as every decision here is concerned. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ─── A board with two issue blocks on it ──────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-pasted-images-'));
const projectDir = join(workDir, 'paste-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'paste-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Paste Check',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = 35200 + (process.pid % 300);
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

async function api(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=paste-check`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** An issue block, in whichever state the case needs. */
async function makeBlock(x, y, text, custom) {
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x, y, width: 320, height: 120, text,
      customData: { kind: 'issue', ...custom },
    }),
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

/** The same reach for the imperative API that `check-board-drafts-browser.mjs` uses. */
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
        window.__pasteCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Paste something, the way the gesture pastes it.
 *
 * `where` is `canvas` for the ordinary gesture — the Excalidraw container focused, the
 * event dispatched on the canvas — and `field` for a paste landing in something being
 * typed into, which is a real textarea, focused, exactly as the shape's own text editor
 * is. Both listeners decide on those two facts and nothing else.
 *
 * Answers with whether the event ever reached the document-level listeners. That is the
 * one signal that says which handler won, and it says it without depending on what
 * Excalidraw then does with what it got: the panel takes a paste by capturing at
 * `document` and stopping it there, so an event that reaches the bubble phase is an event
 * the panel let through — which is exactly what "not swallowed" means.
 */
const pasteScript = (kind, where = 'canvas') => `(async () => {
  const canvas = document.querySelector('.excalidraw canvas');
  if (!canvas) return { error: 'no canvas' };

  // Registered where Excalidraw registers its own, and answering the same question.
  let reachedDocument = false;
  const probe = () => { reachedDocument = true; };
  document.addEventListener('paste', probe, false);

  let target = canvas;
  if (${JSON.stringify(where)} === 'field') {
    const field = document.createElement('textarea');
    field.id = 'paste-check-field';
    document.body.appendChild(field);
    field.focus();
    target = field;
  } else {
    const container = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
    if (container) { container.tabIndex = -1; container.focus(); }
  }

  const transfer = new DataTransfer();
  if (${JSON.stringify(kind)} === 'image') {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  } else {
    transfer.setData('text/plain', 'an observation typed somewhere else');
  }

  const event = new ClipboardEvent('paste', {
    clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
  });
  target.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 900));
  document.removeEventListener('paste', probe, false);
  document.getElementById('paste-check-field')?.remove();
  return { panelTook: !reachedDocument, defaultPrevented: event.defaultPrevented };
})()`;

/** What the board and the card look like right now. */
const PROBE = `(() => {
  const api = window.__pasteCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { blocks: [], images: 0, card: null };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    if (element.type === 'image') out.images++;
    const custom = element.customData || {};
    if (custom.kind === 'issue') {
      out.blocks.push({
        id: element.id,
        state: custom.issueState || 'draft',
        attached: Array.isArray(custom.issueImages) ? custom.issueImages.slice() : [],
      });
    }
  }
  const card = document.querySelector('.docs-card');
  if (card) {
    out.card = {
      thumbnails: card.querySelectorAll('.element-docs__image img').length,
      attachOffered: Boolean(card.querySelector('.element-docs__attach')),
      error: card.querySelector('.element-docs__error') ? card.querySelector('.element-docs__error').textContent : null,
    };
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  return out;
})()`;

const select = (id) =>
  `window.__pasteCheckApi.updateScene({ appState: { selectedElementIds: ${JSON.stringify({ [id]: true })} } })`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** The element as the server holds it — the record the run actually reads. */
const stored = async (id) => (await api(`/api/elements/${id}`)).body?.element?.customData ?? {};

const attachedTo = (scene, id) => scene.blocks.find((entry) => entry.id === id)?.attached ?? [];

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const draftId = await makeBlock(0, 0, 'The panel is picker-only', {});
  const createdId = await makeBlock(0, 400, 'Already an issue', {
    issueState: 'created',
    issueUrl: 'https://github.com/vitorengers/mcp_excalidraw/issues/1',
    issueTitle: 'Already an issue',
  });
  if (!draftId || !createdId) throw new Error(`the blocks were not created\n${serverLog}`);

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
  await waitFor(async () => (await evaluate(PROBE)).blocks.length >= 2, 'both blocks to render');

  console.log('1. a screenshot pasted onto a draft block is attached to it');
  await evaluate(select(draftId));
  let scene = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return probed.card ? probed : null;
  }, 'the card to open on the draft block');
  check('the card offers attaching, which is the state that takes a paste',
        scene.card.attachOffered === true, JSON.stringify(scene.card));
  const imagesBefore = scene.images;

  // Over the canvas and outside the card: the case Excalidraw claims today.
  const overBlock = toViewport(scene, 160, 60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: overBlock.x, y: overBlock.y });
  await sleep(150);

  let pasted = await evaluate(pasteScript('image'));
  check('the panel took the paste before Excalidraw could see it',
        pasted.panelTook === true, JSON.stringify(pasted));
  check('and cancelled the default, so nothing else acts on it either',
        pasted.defaultPrevented === true, JSON.stringify(pasted));

  scene = await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return attachedTo(probed, draftId).length ? probed : null;
  }, 'the pasted image to land on the block').catch(() => evaluate(PROBE));
  await shot('01-pasted');

  check('an id landed on the block', attachedTo(scene, draftId).length === 1,
        JSON.stringify(scene.blocks));
  check('and a thumbnail is drawn in the card', (scene.card?.thumbnails ?? 0) === 1,
        JSON.stringify(scene.card));
  check('with no error shown', !scene.card?.error, scene.card?.error ?? '');

  const record = await stored(draftId);
  check('the server holds the same id, which is what the run reads',
        Array.isArray(record.issueImages) && record.issueImages.length === 1
        && record.issueImages[0] === attachedTo(scene, draftId)[0],
        JSON.stringify(record.issueImages));

  const fileId = Array.isArray(record.issueImages) ? record.issueImages[0] : null;
  const file = fileId ? (await api(`/api/files/${encodeURIComponent(fileId)}`)).body?.file : null;
  check('and there are bytes behind it in the file store',
        typeof file?.dataURL === 'string' && file.dataURL.startsWith('data:image/png;base64,'),
        String(file?.dataURL).slice(0, 40));

  console.log('\n2. and it is not also dropped on the board');
  check('no image element was added to the scene', scene.images === imagesBefore,
        `${imagesBefore} → ${scene.images}`);

  console.log('\n3. what is not a screenshot for this block is left alone');
  const text = await evaluate(pasteScript('text'));
  scene = await evaluate(PROBE);
  check('text on the clipboard is not swallowed', text.panelTook === false, JSON.stringify(text));
  check('and it attached nothing', attachedTo(scene, draftId).length === 1,
        JSON.stringify(attachedTo(scene, draftId)));

  // The card is open and would take a screenshot from the canvas — but not out of
  // something being typed into. Excalidraw bails on a writable target too, so an
  // unclaimed event here is a paste that reaches the field, which is the whole point.
  const field = await evaluate(pasteScript('image', 'field'));
  scene = await evaluate(PROBE);
  check('a paste landing in a text field is left to the field',
        field.panelTook === false && field.defaultPrevented === false, JSON.stringify(field));
  check('and nothing was attached behind the reader\'s back',
        attachedTo(scene, draftId).length === 1, JSON.stringify(attachedTo(scene, draftId)));

  console.log('\n4. a block whose issue exists is not claimed at all');
  await evaluate(select(createdId));
  await sleep(900);
  scene = await evaluate(PROBE);
  check('the card does not offer attaching', scene.card?.attachOffered !== true,
        JSON.stringify(scene.card));
  pasted = await evaluate(pasteScript('image'));
  scene = await evaluate(PROBE);
  await shot('02-created-block');
  check('the panel did not take the paste, so the board behaves as it did',
        pasted.panelTook === false, JSON.stringify(pasted));
  check('and nothing was attached to it', attachedTo(scene, createdId).length === 0,
        JSON.stringify(attachedTo(scene, createdId)));
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
