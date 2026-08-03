#!/usr/bin/env node
/**
 * Checks that a board switch cannot write one board's scene into another board's store.
 *
 * #493, measured rather than imagined: on this machine two live boards each held the whole
 * of the other — `board-tool` carrying all 115 elements of Farol's tracked board file, and
 * Farol carrying all 135 of this repository's, named by id, with nothing authored between
 * them. On screen it is two documentation maps drawn on top of each other. Neither tracked
 * file was contaminated and neither board had saved state, so the running server wrote it,
 * from the browser.
 *
 * The window is real and the file already knew about it: a switch names the new board at
 * once and leaves the old board's shapes on the canvas until the new scene lands, so for
 * that stretch `activeWorkspaceRef` and what is drawn disagree. Everything derived from the
 * drawing was moved onto `sceneWorkspaceRef` for exactly this reason — the terminal's keys,
 * its resize report, the viewport. The autosync, which sends the *entire scene*, was not: it
 * posted to `apiUrl(...)`, which reads `activeWorkspaceRef`.
 *
 * What stood in for it was `holdAutoSyncForSwitch`, and the hold does not reach far enough.
 * It raises `suppressAutoSyncCountRef`, which is read by `scheduleAutoSync` — the *debounced*
 * path — and by nothing else. `syncToBackend` never consulted it, and two callers reach
 * `syncToBackend` without going through the debounce at all. One of them fires on every
 * switch: closing the socket and opening a new one puts `socket.onopen` through the flush it
 * makes when a write is owed (#225), and that flush sends the scene as it stands — board A's,
 * still drawn — to `apiUrl`, which by then says board B.
 *
 * This run catches it there, in the first second of the switch, with a sync reading
 * `workspace=board-b` and carrying `a-only-rect`. The timer's expiry is the second way in
 * and the check drives that too: `finishBoardSwitch` used to run on the ceiling as well as on
 * a landing, so an expiry moved `sceneWorkspaceRef` onto a board whose scene had never
 * arrived. Eight seconds is not generous for a board read across a `\\wsl.localhost` share,
 * which is what Farol is.
 *
 * Either way what lands is permanent: the store reconciles by version and never reads absence
 * as a deletion (#1), so nothing takes a foreign element out again.
 *
 * ## What this drives
 *
 * The failing case is "the new board's scene never lands", so that is what is arranged —
 * `window.WebSocket` is wrapped before the first render and drops `initial_elements` for the
 * board being switched to, and nothing else. The rest is the product's own behaviour: a real
 * click on a real tab, and then a real change to the canvas after the hold has run out.
 *
 * Three assertions, and the middle one is the discriminator:
 *
 *   1. **The control.** With both scenes landing normally, a change on each board syncs to
 *      that board. This is what proves the wrapper is not simply breaking the page.
 *   2. **The defect.** With board B's scene withheld, a change made after the hold expires
 *      must not be posted under B, and B's store must not come to hold A's element.
 *   3. **The recovery.** A scene that arrives late still lands, and the board saves to
 *      itself again afterwards — so the fix is not "stop syncing after a slow switch".
 *
 * Against the code before the fix, (2) fails twice over: the sync names `workspace=board-b`
 * and `GET /api/elements?workspace=board-b` comes back holding `a-only-rect`.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it registers two throwaway projects, starts its own canvas
 * server, and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-switch-sync-target-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── Two projects, each with a board of its own ───────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-switch-sync-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const slash = (value) => value.replace(/\\/g, '/');

/**
 * One rectangle per board, each named so the other board can never be mistaken for it.
 *
 * A whole element rather than a marker on one: the defect merges *scenes*, so the assertion
 * that means anything is "board B's store does not contain board A's element", asked by id.
 */
const boardFile = (id, x) => JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'check-board-switch-sync-target',
  elements: [{
    id,
    type: 'rectangle',
    x,
    y: 0,
    width: 200,
    height: 120,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: 1,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  }],
  appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
  files: {},
}, null, 1);

const projects = [
  { id: 'board-a', name: 'Board A', element: 'a-only-rect', x: 0 },
  { id: 'board-b', name: 'Board B', element: 'b-only-rect', x: 4000 },
];

for (const project of projects) {
  const dir = join(workDir, project.id);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'board.excalidraw'), boardFile(project.element, project.x), 'utf8');
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: project.name,
    board: 'docs/board.excalidraw',
  }, null, 1), 'utf8');
  project.dir = dir;
}

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: projects.map((project) => ({ id: project.id, path: slash(project.dir) })),
}, null, 1), 'utf8');

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

/** A real click, so nothing passes by calling a handler the user could not reach. */
const click = (selector) => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`);

/**
 * A real pointer press on the canvas.
 *
 * Not decoration: `scheduleAutoSync` returns without arming anything until
 * `userInteractedRef` is set, and the only things that set it are the canvas container's
 * `onPointerDownCapture` and `onKeyDownCapture`. A check that only drove the scene through
 * the imperative API would produce no sync at all — and would then watch every assertion
 * about *where* a sync went pass for the reason that none was ever made.
 */
async function pressOnCanvas(x = 800, y = 600) {
  await send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1,
  });
  await send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0,
  });
  await sleep(200);
}

/**
 * The instrumentation, installed before anything on the page runs.
 *
 * Two halves, and neither of them touches the application:
 *
 *   - **`fetch`**, recording every `/api/elements/sync` with the workspace it named and the
 *     element ids it carried. The autosync is the only thing that posts there, so this is
 *     the whole record of what was written and under whose name.
 *   - **`WebSocket`**, which is how the failing case is arranged. A socket whose URL names
 *     the board in `window.__withhold` has its `initial_elements` messages dropped — the
 *     board it switched to never lands, which is the case `BOARD_SWITCH_HOLD_MS` exists for
 *     and the case it used to get wrong. Everything else on that socket is passed through
 *     untouched, so the page is connected and live; it simply has no scene.
 *
 * Held ones are kept, so the last step can deliver a withheld scene late and watch it land.
 */
const INSTRUMENT = `(() => {
  window.__withhold = null;
  window.__held = [];
  window.__syncs = [];
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/elements/sync') >= 0) {
      let ids = [];
      try { ids = (JSON.parse((init && init.body) || '{}').elements || []).map((e) => e.id); }
      catch (error) { /* not the shape we log */ }
      const named = /[?&]workspace=([^&]*)/.exec(url);
      window.__syncs.push({ workspace: named ? decodeURIComponent(named[1]) : null, ids });
    }
    return realFetch.apply(this, arguments);
  };
  const RealSocket = window.WebSocket;
  function Wrapped(url, protocols) {
    const instance = protocols === undefined ? new RealSocket(url) : new RealSocket(url, protocols);
    const named = /[?&]workspace=([^&]*)/.exec(String(url));
    const board = named ? decodeURIComponent(named[1]) : null;
    const realAdd = instance.addEventListener.bind(instance);
    let handler = null;
    const filter = (event) => {
      if (board && board === window.__withhold) {
        let kind = null;
        try { kind = JSON.parse(event.data).type; } catch (error) { /* pass it on */ }
        if (kind === 'initial_elements') { window.__held.push({ board, data: event.data }); return; }
      }
      if (handler) handler.call(instance, event);
    };
    realAdd('message', filter);
    Object.defineProperty(instance, 'onmessage', {
      get: () => handler,
      set: (fn) => { handler = fn; },
      configurable: true,
    });
    window.__lastSocket = instance;
    return instance;
  }
  Wrapped.prototype = RealSocket.prototype;
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) Wrapped[key] = RealSocket[key];
  window.WebSocket = Wrapped;
  return true;
})()`;

/** Deliver a scene that was withheld, as the socket would have. */
const releaseHeld = () => evaluate(`(() => {
  const held = window.__held.shift();
  if (!held || !window.__lastSocket || !window.__lastSocket.onmessage) return false;
  window.__withhold = null;
  window.__lastSocket.onmessage({ data: held.data });
  return true;
})()`);

/** Move a shape, which is a change the autosync has to write. */
const nudge = (elementId) => evaluate(`(() => {
  const api = window.__switchCheckApi;
  if (!api) return false;
  const scene = api.getSceneElements();
  const target = scene.find((element) => element.id === ${JSON.stringify(elementId)});
  if (!target) return false;
  api.updateScene({ elements: scene.map((element) => (element.id === target.id
    ? { ...element, x: element.x + 10, version: (element.version || 1) + 1 }
    : element)) });
  return true;
})()`);

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
        window.__switchCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const onCanvas = () => evaluate(
  `(window.__switchCheckApi ? window.__switchCheckApi.getSceneElements() : []).map((e) => e.id)`);

/** What a board's store actually holds, asked of the server rather than of the page. */
const storeOf = async (workspaceId) => {
  const response = await fetch(`${BASE}/api/elements?workspace=${encodeURIComponent(workspaceId)}`);
  const body = await response.json();
  return (body.elements ?? []).map((element) => element.id);
};

/** How long the hold lasts, plus room for the change that follows it. */
const BOARD_SWITCH_HOLD_MS = 8000;

// ─── The run ──────────────────────────────────────────────────

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  await waitFor(async () => (await storeOf('board-a')).includes('a-only-rect'), "board A's seeded scene");
  await waitFor(async () => (await storeOf('board-b')).includes('b-only-rect'), "board B's seeded scene");

  const chrome = spawn(chromePath, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  // Before the first render, so the application's own socket is the wrapped one. A page that
  // installed this afterwards would already have connected.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await send('Page.navigate', { url: `${BASE}/?workspace=board-a` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API');
  await waitFor(async () => (await onCanvas()).includes('a-only-rect'), "board A on the canvas");
  await shot('01-board-a');

  console.log('\n1. the control: a change on each board is written to that board');

  // Empty canvas, well away from the seeded rectangle: this is here to make the page count
  // as interacted-with, not to select anything.
  await pressOnCanvas(1200, 850);
  await nudge('a-only-rect');
  const controlSyncs = await waitFor(async () => {
    const seen = await evaluate('window.__syncs');
    return seen.length > 0 ? seen : null;
  }, 'the autosync to write board A');
  check('the change on board A was posted under board A',
    controlSyncs.some((entry) => entry.workspace === 'board-a' && entry.ids.includes('a-only-rect')),
    JSON.stringify(controlSyncs));
  check("and board B's store is untouched so far",
    !(await storeOf('board-b')).includes('a-only-rect'));

  console.log('\n2. the defect: a switch whose scene never lands must write nothing to the board it named');

  await evaluate(`window.__syncs = []; window.__withhold = 'board-b'; true`);
  const tabs = await evaluate(
    `[...document.querySelectorAll('.workspace-tab')].map((tab) => tab.textContent.trim())`);
  check('the strip is showing both projects', tabs.length === 2, JSON.stringify(tabs));
  // The button inside the tab, not the tab: the outer element carries the drag handle and
  // the settings affordance, and `.click()` on it switches nothing. A check that clicked it
  // would sit on board A for the whole run and watch every assertion below pass because the
  // switch it is about never happened.
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.workspace-tab__select')]
      .find((candidate) => candidate.textContent.indexOf('Board B') >= 0);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  check('the Board B tab is clickable', clicked);
  check('and the strip moved to it', await waitFor(async () => (await evaluate(
    `document.querySelector('.workspace-tab--active')?.textContent?.trim() ?? null`
  ))?.includes('Board B'), 'the strip to show Board B active'));

  // The arrangement itself, asserted rather than assumed: if board B's scene were arriving
  // normally there would be no window here at all, and everything below would pass for the
  // reason that the case never happened.
  await sleep(1500);
  check("board B's scene really is being withheld",
    (await evaluate('window.__held.length')) > 0,
    `held=${await evaluate('window.__held.length')}`);

  // Out the far side of the hold as well, and a change there, so the expiry path is driven
  // too and not only the window at the start of the switch.
  await sleep(BOARD_SWITCH_HOLD_MS + 1500);
  await nudge('a-only-rect');
  await sleep(3000);
  await shot('02-hold-expired');

  /**
   * The invariant, and it is worth stating as one rather than as a stopwatch.
   *
   * Every sync carries ids, and each of these two boards has exactly one element that only
   * it can have. So a sync is *misaddressed* when the board it names is not the board whose
   * element it carries — which is true whenever it happens, however fast or slow the scene
   * landed. An assertion phrased as "board A is still drawn at t+1500ms" would be a race
   * against the HTTP loader, which fills the canvas even when the socket's `initial_elements`
   * never arrives; this cannot be.
   */
  const misaddressed = (entries) => entries.filter((entry) => (
    (entry.workspace === 'board-b' && entry.ids.includes('a-only-rect'))
    || (entry.workspace === 'board-a' && entry.ids.includes('b-only-rect'))
  ));

  const afterSwitch = await evaluate('window.__syncs');
  check('no sync named one board while carrying the other board\'s scene',
    misaddressed(afterSwitch).length === 0, JSON.stringify(misaddressed(afterSwitch)));

  const bStore = await storeOf('board-b');
  check("board B's store does not hold board A's element",
    !bStore.includes('a-only-rect'), JSON.stringify(bStore));
  check("and board B still holds its own", bStore.includes('b-only-rect'), JSON.stringify(bStore));

  console.log('\n3. the recovery: a scene that arrives late still lands, and saves to itself');

  check('the withheld scene was delivered', await releaseHeld());
  await waitFor(async () => (await onCanvas()).includes('b-only-rect'), 'board B on the canvas');
  await shot('03-board-b-landed');

  await evaluate('window.__syncs = []; true');
  await nudge('b-only-rect');
  await sleep(3000);
  const afterLanding = await evaluate('window.__syncs');
  check('a change on board B is now posted under board B',
    afterLanding.some((entry) => entry.workspace === 'board-b' && entry.ids.includes('b-only-rect')),
    JSON.stringify(afterLanding));
  check("and board A's store never took board B's element",
    !(await storeOf('board-a')).includes('b-only-rect'));
  check("and board A still holds its own", (await storeOf('board-a')).includes('a-only-rect'));
} catch (error) {
  failures++;
  console.error(`  FAIL  the run completed — ${error.message}`);
} finally {
  if (socket) { try { socket.close(); } catch { /* going anyway */ } }
  for (const child of children) { try { child.kill(); } catch { /* going anyway */ } }
  await sleep(500);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds the profile */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
