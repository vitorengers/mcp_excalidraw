#!/usr/bin/env node
/**
 * Checks that an image put on a board survives the board.
 *
 * The canvas had a whole half of a file store and none of the other half. `POST /api/files`
 * existed, `GET /api/files` served what one board's elements point at, the socket carried
 * `files_added`, and the seed read `scene.files` back — but nothing on the way *out* ever
 * called any of it. The autosync sent elements alone, so a pasted screenshot produced an
 * element whose `fileId` reached the store and bytes that never left the browser: reload and
 * the board came back with a hole where the image was, and a second window never saw it at
 * all. That is not a restart-only limit, which is what the documentation used to say; it was
 * every reload of every board.
 *
 * So the four claims are asserted where they happen, end to end:
 *
 *  1. a screenshot pasted on the canvas is served by `GET /api/files?workspace=<id>` within
 *     one autosync — the bytes, not just the id;
 *  2. a window that was already open is handed those bytes over the socket, and a second
 *     window opened on the same board draws the image without being reloaded;
 *  3. the saved board on disk carries them, so the next process has something to read;
 *  4. and after a real restart the new process serves the same id, and a reloaded page holds
 *     the bytes again.
 *
 * The already-open window is asserted on the *bytes* and not on the picture, and that is a
 * deliberate limit rather than a weaker claim. `POST /api/elements/sync` broadcasts a count
 * and not the elements, so no change made in one window has ever reached another one live —
 * the drawing does not travel either, and a case asserting the picture there would be red for
 * that far wider gap rather than for anything about files. What this board does carry live is
 * `files_added`, so that is what is checked live; the whole image is checked in a window
 * opened afterwards, which is the case the release actually promises.
 *
 * It has to be a browser. The upload is a decision made inside `syncToBackend` about what
 * `excalidrawAPI.getFiles()` holds and what the server has already been told, and neither of
 * those exists outside a running canvas — the first attempt at this feature is exactly the
 * one that type-checks, posts nothing, and leaves the board looking right until it is
 * reloaded. The paste is a constructed `ClipboardEvent`, because there is no way to put a
 * bitmap on a headless machine's clipboard; everything else is real, including the click
 * that tells the page a person is using it, which is what arms the autosync at all.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a throwaway registry, starts its own canvas on a
 * free port, restarts it on that same port, and kills everything. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-board-images.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * A real 4×4 PNG, and a distinctive one.
 *
 * Bigger than the 1×1 the paste checks use on purpose: Excalidraw names a file by the hash
 * of its bytes, and a degenerate image is the one that is most likely to be special-cased
 * somewhere between the clipboard and the scene.
 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHElEQVR4nGP8z8DwnwEK'
  + 'mBgYGBhGBaMCAQEAJhkDA6+3JXsAAAAASUVORK5CYII=';

// ─── A board of its own, in a directory of its own ────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-board-images-'));
const projectDir = join(workDir, 'image-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'image-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Image Check',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

/** Where `board-state.ts` puts a board saved beside this registry. */
const savedBoardFile = join(workDir, 'workspaces-state', 'image-check.excalidraw');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sessions = [];
/** The page sessions among them, which are the ones that can be navigated off the board. */
const pages = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
let server = null;

function startServer() {
  const started = startCanvas({
    port: PORT,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      // The overlay is a DOM layer over the canvas, and a click meant for the board lands on
      // it instead. This machine's shell exports the variable; the check does not want it.
      EXCALIDRAW_TERMINAL: undefined,
    },
  });
  started.child.stdout.on('data', (chunk) => { serverLog += chunk; });
  started.child.stderr.on('data', (chunk) => { serverLog += chunk; });
  children.push(started.child);
  server = started.child;
  return started;
}

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

async function filesOnServer() {
  const response = await fetch(`${BASE}/api/files?workspace=image-check`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).files ?? {};
}

// ─── Talking to Chrome ────────────────────────────────────────

/** One page, one socket, one id counter. Two of these is what "a second window" means here. */
function makeSession() {
  const pending = new Map();
  const session = {
    socket: null,
    nextId: 1,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = session.nextId++;
        pending.set(id, { resolve, reject });
        session.socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async open(url) {
      session.socket = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
      await new Promise((resolve, reject) => {
        session.socket.once('open', resolve);
        session.socket.once('error', reject);
      });
      session.socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        const waiting = message.id && pending.get(message.id);
        if (!waiting) return;
        pending.delete(message.id);
        if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
        else waiting.resolve(message.result);
      });
    },
    async evaluate(expression) {
      const result = await session.send('Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    async shot(name) {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
    },
    close() { try { session.socket?.close(); } catch { /* already gone */ } },
  };
  return session;
}

const pageTargets = async () => {
  const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return (await response.json()).filter((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
};

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
        window.__imageCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** What this page thinks the board is: its image elements, and the bytes it holds for them. */
const PROBE = `(() => {
  const api = window.__imageCheckApi;
  if (!api) return { error: 'no api handle' };
  const held = api.getFiles() || {};
  const images = [];
  for (const element of api.getSceneElements()) {
    if (element.isDeleted || element.type !== 'image') continue;
    const bytes = held[element.fileId];
    images.push({
      id: element.id,
      fileId: element.fileId ?? null,
      bytes: typeof bytes?.dataURL === 'string' ? bytes.dataURL.length : 0,
    });
  }
  const state = api.getAppState();
  return {
    images,
    heldIds: Object.keys(held),
    view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
            offsetLeft: state.offsetLeft, offsetTop: state.offsetTop },
  };
})()`;

/**
 * Paste a screenshot onto the canvas, the way the gesture pastes one.
 *
 * Nothing is selected, so this is Excalidraw's own paste rather than the issue panel's —
 * `check-pasted-images-browser.mjs` covers the other side of that fork. The event is
 * constructed because a headless machine has no clipboard; the focus and the pointer
 * position, which are the two facts both listeners decide on, are real.
 */
const PASTE_IMAGE = `(async () => {
  const canvas = document.querySelector('.excalidraw canvas');
  if (!canvas) return { error: 'no canvas' };
  const container = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
  if (container) { container.tabIndex = -1; container.focus(); }

  const transfer = new DataTransfer();
  const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0));
  transfer.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));

  canvas.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
  }));
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { pasted: true };
})()`;

try {
  const first = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  if (first.child.exitCode !== null) throw new Error(`the server exited early\n${serverLog}`);

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

  const firstTarget = await waitFor(async () => (await pageTargets())[0], 'a Chrome page target');
  const page = makeSession();
  sessions.push(page);
  pages.push(page);
  await page.open(firstTarget.webSocketDebuggerUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await waitFor(() => page.evaluate(GRAB_API), 'the Excalidraw API handle');

  const browserEndpoint = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
  const browser = makeSession();
  sessions.push(browser);
  await browser.open(browserEndpoint.webSocketDebuggerUrl);

  const opened = new Set([firstTarget.id]);

  /** Another window on the same board, driven the same way as the first. */
  async function openWindow(what) {
    await browser.send('Target.createTarget', { url: BASE, newWindow: true });
    const target = await waitFor(
      async () => (await pageTargets()).find((entry) => !opened.has(entry.id)),
      what
    );
    opened.add(target.id);
    const session = makeSession();
    await session.open(target.webSocketDebuggerUrl);
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await waitFor(() => session.evaluate(GRAB_API), `${what} to come up`);
    sessions.push(session);
    pages.push(session);
    return session;
  }

  // This one is opened *before* the paste: what a socket hands a page that was already there
  // is a different claim from what a page fetches when it loads, and only one of the two
  // survives being tested by opening the window afterwards.
  const other = await openWindow('a window open before the paste');

  console.log('1. a screenshot pasted on the board reaches the server');

  const before = await page.evaluate(PROBE);
  check('the board starts with no images on it', before.images.length === 0,
        JSON.stringify(before.images));

  // A real press, because `scheduleAutoSync` refuses to arm until the page has seen a person
  // touch it — an autosync that never fires would fail every case below for the wrong reason.
  const middle = { x: 700, y: 500 };
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...middle });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...middle, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...middle, button: 'left', clickCount: 1 });
  await sleep(200);

  const pasted = await page.evaluate(PASTE_IMAGE);
  if (pasted?.error) throw new Error(`the paste could not be dispatched: ${pasted.error}`);

  const scene = await waitFor(async () => {
    const probed = await page.evaluate(PROBE);
    return probed.images.length ? probed : null;
  }, 'the pasted screenshot to become an image element');
  await page.shot('01-pasted');

  const fileId = scene.images[0]?.fileId;
  check('the paste became an image element naming a file', typeof fileId === 'string' && fileId.length > 0,
        JSON.stringify(scene.images));
  check('and this page holds the bytes for it', (scene.images[0]?.bytes ?? 0) > 0,
        JSON.stringify(scene.images));

  const startedWaiting = Date.now();
  const served = await waitFor(async () => {
    const files = await filesOnServer();
    return files[fileId] ? files : null;
  }, `the server to serve ${fileId} on GET /api/files`).catch(() => null);
  check('the server serves it on GET /api/files within an autosync',
        Boolean(served && served[fileId]),
        `${Math.round((Date.now() - startedWaiting) / 1000)}s and still not there`);
  check('with the bytes behind it, not just the id',
        typeof served?.[fileId]?.dataURL === 'string'
        && served[fileId].dataURL.startsWith('data:image/png;base64,'),
        String(served?.[fileId]?.dataURL).slice(0, 40));

  const stored = await (await fetch(`${BASE}/api/elements?workspace=image-check`)).json();
  const storedImage = (stored.elements ?? []).find((element) => element.type === 'image');
  check('and the element that names it is in the store too', storedImage?.fileId === fileId,
        JSON.stringify(storedImage?.fileId ?? null));

  console.log('\n2. a second window on the same board draws it, with no reload');

  const alreadyOpen = await waitFor(async () => {
    const probed = await other.evaluate(PROBE);
    return probed.heldIds.includes(fileId) ? probed : null;
  }, 'the open window to be handed the bytes').catch(() => other.evaluate(PROBE));
  check('the window that was already open is handed the bytes over the socket',
        alreadyOpen.heldIds.includes(fileId), JSON.stringify(alreadyOpen.heldIds));

  const fresh = await openWindow('a window opened after the paste');
  const freshScene = await waitFor(async () => {
    const probed = await fresh.evaluate(PROBE);
    return probed.images.some((image) => image.fileId === fileId && image.bytes > 0) ? probed : null;
  }, 'the new window to draw the image').catch(() => fresh.evaluate(PROBE));
  await fresh.shot('02-second-window');
  check('a window opened on the board has the image element',
        freshScene.images.some((image) => image.fileId === fileId),
        JSON.stringify(freshScene.images));
  check('and the bytes for it, without being reloaded',
        freshScene.images.some((image) => image.fileId === fileId && image.bytes > 0),
        JSON.stringify(freshScene.images));

  console.log('\n3. the board is saved with its images');

  const savedScene = await waitFor(() => {
    const raw = JSON.parse(readFileSync(savedBoardFile, 'utf8'));
    return raw.files && raw.files[fileId] ? raw : null;
  }, `${savedBoardFile} to carry the file`).catch(() => {
    try { return JSON.parse(readFileSync(savedBoardFile, 'utf8')); } catch { return null; }
  });
  check('the saved board names the file', Boolean(savedScene?.files?.[fileId]),
        JSON.stringify(Object.keys(savedScene?.files ?? {})));
  check('and carries its bytes, so the next process has something to read',
        typeof savedScene?.files?.[fileId]?.dataURL === 'string'
        && savedScene.files[fileId].dataURL.startsWith('data:image/png;base64,'),
        String(savedScene?.files?.[fileId]?.dataURL).slice(0, 40));
  check('while still saving the element that points at it',
        (savedScene?.elements ?? []).some((element) => element.fileId === fileId),
        `${(savedScene?.elements ?? []).length} element(s)`);

  console.log('\n4. and a restart does not take it away');

  // Every window off the board first, and that is what makes this section evidence about the
  // *save*. A page left open reconnects to the new process and re-uploads what it is holding
  // — a real and wanted property, and one that would let this pass with nothing written to
  // disk at all. With no page connected, the only thing that can put the file in a fresh
  // process is the file the last one wrote.
  for (const open of pages) await open.send('Page.navigate', { url: 'about:blank' });
  await sleep(500);

  server.kill('SIGKILL');
  await waitFor(async () => server.exitCode !== null || server.signalCode !== null, 'the server to stop');
  await sleep(600);
  const restarted = startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server to come back');
  if (restarted.child.exitCode !== null) throw new Error(`the restarted server exited\n${serverLog}`);

  const afterRestart = await waitFor(async () => {
    const files = await filesOnServer();
    return files[fileId] ? files : null;
  }, 'the new process to serve the file').catch(() => null);
  check('the new process serves the same id', Boolean(afterRestart?.[fileId]),
        JSON.stringify(Object.keys(afterRestart ?? {})));
  // Required to be a real PNG dataURL as well as an equal one, so that two absent files
  // cannot agree with each other and read as a pass.
  check('with the same bytes',
        typeof afterRestart?.[fileId]?.dataURL === 'string'
        && afterRestart[fileId].dataURL.startsWith('data:image/png;base64,')
        && afterRestart[fileId].dataURL === served?.[fileId]?.dataURL,
        `${String(afterRestart?.[fileId]?.dataURL).slice(0, 32)} vs ${String(served?.[fileId]?.dataURL).slice(0, 32)}`);

  await page.send('Page.navigate', { url: BASE });
  await sleep(1500);
  await waitFor(() => page.evaluate(GRAB_API), 'the reloaded page');
  const reloaded = await waitFor(async () => {
    const probed = await page.evaluate(PROBE);
    return probed.images.some((image) => image.fileId === fileId && image.bytes > 0) ? probed : null;
  }, 'the reloaded board to render the image').catch(() => page.evaluate(PROBE));
  await page.shot('03-after-restart');
  check('and a reloaded board draws the image rather than a hole',
        reloaded.images.some((image) => image.fileId === fileId && image.bytes > 0),
        JSON.stringify(reloaded.images));

} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const session of sessions) session.close();
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
