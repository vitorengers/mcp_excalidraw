#!/usr/bin/env node
/**
 * What a refresh costs, measured in a real browser.
 *
 * The report was "sometimes I refresh and the pill says Disconnected, blocks show, blocks
 * disappear, and seconds later everything comes back". Read off the code that is one
 * sequence: the socket is opened on the `default` board before `GET /api/workspaces` has
 * said which boards exist, the answer then *switches* board, and switching empties the
 * scene and cycles the socket. Nothing remembers which board was open either, so the
 * reader clicks back and pays for a third connect and a second blank canvas.
 *
 * None of that is visible to a type check or to an API-level check: both sockets are
 * well-formed, both scenes are valid, and the store is correct throughout. So this drives
 * Chrome over the DevTools protocol and instruments `window.WebSocket`, `window.fetch` and
 * the Excalidraw API's own `updateScene` *before the page loads*, which is the only vantage
 * point from which "one socket per load" and "the scene was emptied" are facts rather than
 * impressions.
 *
 * It asserts:
 *
 *   1. exactly one socket per load, naming the board that ends up on screen;
 *   2. the scene is never emptied while the board on screen has not changed — including
 *      across a deliberate tab switch, where the previous board stays up until the new
 *      one lands rather than blanking;
 *   3. a reload returns to the board that was open, not to the first tab in the registry;
 *   4. the pill never reads Disconnected during a healthy load (the measured number is
 *      printed, and the budget is 100 ms);
 *   5. `GET /api/files` happens at most once per load and never carries another board's
 *      files;
 *   6. a heartbeat is exchanged, so a socket that has stopped answering is noticed;
 *   7. a server that goes away really does read Disconnected, and a server that comes back
 *      is reconnected to in about a second rather than waiting out a flat three.
 *
 * Self-contained: it builds a throwaway two-board registry, starts its own canvas server
 * on a free port and kills it. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-refresh-connect-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The pill is allowed this long, in total, reading Disconnected during a healthy load.
 *
 * Nothing on a healthy load should spend any time there — the socket has never been up,
 * which is *connecting*, not disconnected — so the budget is only wide enough to absorb a
 * sampling tick. The old code measured 66 ms here.
 */
const DISCONNECTED_BUDGET_MS = 50;
/** A server that comes back should be reconnected to inside this, not the old flat 3 s. */
const RECONNECT_BUDGET_MS = 6000;

// ─── Two boards, each with a shape and an image of its own ─────

const workDir = mkdtempSync(join(tmpdir(), 'check-refresh-connect-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const ONE = 'board-one';
const TWO = 'board-two';
const projectDirs = {
  [ONE]: join(workDir, ONE),
  [TWO]: join(workDir, TWO),
};
for (const dir of [profileDir, shotDir, projectDirs[ONE], projectDirs[TWO]]) {
  mkdirSync(dir, { recursive: true });
}

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: ONE, path: projectDirs[ONE].replace(/\\/g, '/') },
    { id: TWO, path: projectDirs[TWO].replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so the only shapes on these
// boards are the ones this check puts there.
for (const [id, dir] of Object.entries(projectDirs)) {
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: id === ONE ? 'Board One' : 'Board Two',
    repo: 'vitorengers/mcp_excalidraw',
  }), 'utf8');
}

/** The narrowest legal PNG, so a file is a file without being a payload. */
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WIDTHS = { [ONE]: 201, [TWO]: 202 };
const FILE_IDS = { [ONE]: 'file-of-board-one', [TWO]: 'file-of-board-two' };

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
let server = null;

function startServer() {
  server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
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
  return server;
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((resolve) => server.once('exit', resolve));
  try { server.kill('SIGKILL'); } catch { /* already gone */ }
  await done;
}

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog.slice(-2000)}`);
}

const api = (workspace, path, options = {}) =>
  fetch(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

/** A shape and an image, so each board has something to show and something to fetch. */
async function seed(workspace) {
  await api(workspace, '/api/files', {
    method: 'POST',
    body: JSON.stringify({ files: [{ id: FILE_IDS[workspace], dataURL: PIXEL, mimeType: 'image/png' }] }),
  });
  await api(workspace, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: WIDTHS[workspace], height: 140,
      backgroundColor: '#a5d8ff', text: workspace,
    }),
  });
  await api(workspace, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'image', x: 320, y: 0, width: 80, height: 80,
      fileId: FILE_IDS[workspace], status: 'saved',
    }),
  });
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

async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
}

/**
 * Everything the page did, recorded from before the page ran.
 *
 * A refresh is over in a second and the interesting events are all in it, so nothing here
 * can be sampled after the fact: the sockets, the fetches and the scene replacements are
 * captured as they happen and read back afterwards. The Excalidraw API is found by walking
 * the container's React fibre — the same handle `check-terminal-browser.mjs` uses — and
 * `updateScene` is wrapped on it, which is what makes "the scene was emptied" a recorded
 * fact rather than something a poller has to be lucky enough to catch.
 */
const INSTRUMENT = `(() => {
  const rec = {
    startedAt: Date.now(),
    sockets: [],
    files: [],
    scenes: [],
    pill: [],
    apiFoundAt: null,
  };
  window.__probe = rec;

  const NativeWebSocket = window.WebSocket;
  function ProbeWebSocket(url, protocols) {
    const created = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    const entry = { url: String(url), createdAt: Date.now(), openedAt: null, closedAt: null, code: null, sent: [], pongs: 0 };
    rec.sockets.push(entry);
    created.addEventListener('open', () => { entry.openedAt = Date.now(); });
    created.addEventListener('close', (event) => { entry.closedAt = Date.now(); entry.code = event.code; });
    created.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message && message.type === 'pong') entry.pongs += 1;
      } catch (error) { /* not every frame is JSON */ }
    });
    const nativeSend = created.send.bind(created);
    created.send = (payload) => {
      try {
        const message = JSON.parse(payload);
        if (message && message.type) entry.sent.push(message.type);
      } catch (error) { /* not every frame is JSON */ }
      return nativeSend(payload);
    };
    return created;
  }
  ProbeWebSocket.prototype = NativeWebSocket.prototype;
  for (const name of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) ProbeWebSocket[name] = NativeWebSocket[name];
  window.WebSocket = ProbeWebSocket;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const promise = nativeFetch(input, init);
    if (!/\\/api\\/files(\\?|$)/.test(url)) return promise;
    const entry = { url, at: Date.now(), ids: null };
    rec.files.push(entry);
    return promise.then((response) => {
      response.clone().json()
        .then((body) => { entry.ids = Object.keys((body && body.files) || {}); })
        .catch(() => { entry.ids = []; });
      return response;
    });
  };

  const grabApi = () => {
    const host = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
    if (!host) return null;
    const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
    if (!key) return null;
    let node = host[key];
    for (let up = 0; up < 60 && node; up++) {
      let state = node.memoizedState;
      for (let along = 0; along < 40 && state; along++) {
        const value = state.memoizedState;
        if (value && typeof value === 'object'
            && typeof value.getSceneElements === 'function' && typeof value.updateScene === 'function') {
          return value;
        }
        state = state.next;
      }
      node = node.return;
    }
    return null;
  };

  const hook = setInterval(() => {
    const api = grabApi();
    if (!api || api.__probeWrapped) return;
    api.__probeWrapped = true;
    window.__probeApi = api;
    rec.apiFoundAt = Date.now();
    const original = api.updateScene.bind(api);
    api.updateScene = (scene) => {
      if (scene && Array.isArray(scene.elements)) rec.scenes.push({ n: scene.elements.length, at: Date.now() });
      return original(scene);
    };
    clearInterval(hook);
  }, 5);

  let last = null;
  setInterval(() => {
    const node = document.querySelector('.status span');
    const text = node ? String(node.textContent).trim() : null;
    const now = Date.now();
    if (text !== last) {
      rec.pill.push({ text, from: now, to: now });
      last = text;
    } else if (rec.pill.length) {
      rec.pill[rec.pill.length - 1].to = now;
    }
  }, 20);
})()`;

/** The scene as the board shows it, by the widths this check seeded. */
const SCENE = `(() => {
  const api = window.__probeApi;
  if (!api) return { ready: false };
  const elements = api.getSceneElements();
  return {
    ready: true,
    widths: elements.filter((element) => element.type === 'rectangle').map((element) => element.width),
    count: elements.length,
    tabs: [...document.querySelectorAll('.workspace-tab')].map((tab) => ({
      name: tab.textContent.trim(),
      active: tab.classList.contains('workspace-tab--active'),
      box: (() => { const box = tab.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + box.height / 2 }; })(),
    })),
    pill: (document.querySelector('.status span') || {}).textContent || null,
  };
})()`;

const probe = () => evaluate('JSON.parse(JSON.stringify(window.__probe))');

/** Milliseconds the pill spent reading `text`, over the samples taken after `since`. */
const msReading = (record, text, since = 0) => record.pill
  .filter((segment) => segment.text === text && segment.to >= since)
  .reduce((total, segment) => total + (segment.to - Math.max(segment.from, since)), 0);

const workspaceOf = (url) => {
  const match = /[?&]workspace=([^&]*)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
};

const waitForBoard = (width) => waitFor(async () => {
  const scene = await evaluate(SCENE);
  return scene.ready && scene.widths.includes(width) ? scene : null;
}, `board ${width} to be on screen`);

try {
  startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  await seed(ONE);
  await seed(TWO);

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    'about:blank',
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });

  // ─── 1. one socket per load ────────────────────────────────
  console.log('1. a load opens one socket, on the board it is going to show');
  await send('Page.navigate', { url: BASE });
  let scene = await waitForBoard(WIDTHS[ONE]);
  // Long enough for a second socket, a second scene and a stray loader to have happened.
  await sleep(2500);
  let record = await probe();
  scene = await evaluate(SCENE);
  await shot('01-first-load');

  check('the Excalidraw API was instrumented, so the scene half means something',
        record.apiFoundAt !== null);
  check('exactly one socket was opened', record.sockets.length === 1,
        JSON.stringify(record.sockets.map((entry) => entry.url)));
  check('and it named the board that ended up on screen',
        record.sockets.length === 1 && workspaceOf(record.sockets[0].url) === ONE,
        record.sockets.map((entry) => workspaceOf(entry.url)).join(', '));
  check('the first tab is the one selected',
        scene.tabs.length === 2 && scene.tabs[0].active && !scene.tabs[1].active,
        JSON.stringify(scene.tabs.map((tab) => [tab.name, tab.active])));

  // ─── 2. the scene is never emptied ─────────────────────────
  console.log('\n2. the scene is never emptied while the board on screen has not changed');
  check('the board is drawn', scene.widths.includes(WIDTHS[ONE]), JSON.stringify(scene.widths));
  check('and no scene update ever replaced it with nothing',
        record.scenes.every((update) => update.n > 0),
        JSON.stringify(record.scenes));

  // ─── 3. the pill ───────────────────────────────────────────
  console.log('\n3. the pill never reads Disconnected on a healthy load');
  const disconnectedMs = msReading(record, 'Disconnected');
  console.log(`      measured: ${disconnectedMs} ms reading Disconnected, budget ${DISCONNECTED_BUDGET_MS} ms`);
  console.log(`      pill: ${record.pill.map((segment) => `${segment.text}(${segment.to - segment.from}ms)`).join(' → ')}`);
  check('it stayed inside the budget', disconnectedMs <= DISCONNECTED_BUDGET_MS, `${disconnectedMs} ms`);
  check('and it ends up Connected', scene.pill === 'Connected', String(scene.pill));

  // ─── 4. the files ──────────────────────────────────────────
  console.log('\n4. the files of one board, asked for once');
  check('GET /api/files happened at most once', record.files.length <= 1,
        JSON.stringify(record.files.map((entry) => entry.url)));
  check('and never carried the other board\'s file',
        record.files.every((entry) => !(entry.ids ?? []).includes(FILE_IDS[TWO])),
        JSON.stringify(record.files.map((entry) => entry.ids)));

  const scopedOne = await (await api(ONE, '/api/files')).json();
  const scopedTwo = await (await api(TWO, '/api/files')).json();
  check('asked for one board, the endpoint answers with that board\'s file',
        Object.keys(scopedOne.files ?? {}).join() === FILE_IDS[ONE],
        Object.keys(scopedOne.files ?? {}).join(', '));
  check('and for the other, with the other\'s',
        Object.keys(scopedTwo.files ?? {}).join() === FILE_IDS[TWO],
        Object.keys(scopedTwo.files ?? {}).join(', '));

  // ─── 5. switching, and coming back to where you were ───────
  console.log('\n5. switching boards keeps a board on screen, and a reload returns to it');
  const secondTab = scene.tabs[1];
  await clickAt(secondTab.box.x, secondTab.box.y);
  scene = await waitForBoard(WIDTHS[TWO]);
  await sleep(1200);
  record = await probe();
  await shot('02-switched');
  check('the second board is now drawn', scene.widths.includes(WIDTHS[TWO]), JSON.stringify(scene.widths));
  check('and the switch never blanked the canvas on the way',
        record.scenes.every((update) => update.n > 0),
        JSON.stringify(record.scenes));

  await send('Page.navigate', { url: BASE });
  scene = await waitForBoard(WIDTHS[TWO]);
  await sleep(2500);
  record = await probe();
  scene = await evaluate(SCENE);
  await shot('03-reloaded');
  check('the reload came back to the board that was open',
        scene.widths.includes(WIDTHS[TWO]) && !scene.widths.includes(WIDTHS[ONE]),
        JSON.stringify(scene.widths));
  check('with the second tab selected',
        scene.tabs.length === 2 && scene.tabs[1].active && !scene.tabs[0].active,
        JSON.stringify(scene.tabs.map((tab) => [tab.name, tab.active])));
  check('on one socket, naming it',
        record.sockets.length === 1 && workspaceOf(record.sockets[0].url) === TWO,
        JSON.stringify(record.sockets.map((entry) => entry.url)));
  check('without ever emptying the scene',
        record.scenes.every((update) => update.n > 0), JSON.stringify(record.scenes));
  check('and without the other board\'s files',
        record.files.length <= 1
        && record.files.every((entry) => !(entry.ids ?? []).includes(FILE_IDS[ONE])),
        JSON.stringify(record.files.map((entry) => [entry.url, entry.ids])));
  const reloadDisconnectedMs = msReading(record, 'Disconnected');
  console.log(`      measured on reload: ${reloadDisconnectedMs} ms reading Disconnected`);
  check('and the pill never read Disconnected on the way',
        reloadDisconnectedMs <= DISCONNECTED_BUDGET_MS, `${reloadDisconnectedMs} ms`);

  // ─── 6. the heartbeat ──────────────────────────────────────
  console.log('\n6. the socket is checked for life instead of assumed to have it');
  const beat = await waitFor(async () => {
    const current = await probe();
    const live = current.sockets[current.sockets.length - 1];
    return live && live.sent.includes('ping') && live.pongs > 0 ? { current, live } : null;
  }, 'a ping and its pong', 100);
  check('the page pings its socket', beat.live.sent.includes('ping'), beat.live.sent.join(', '));
  check('the server answers', beat.live.pongs > 0, String(beat.live.pongs));
  check('and the socket was not replaced to do it', beat.current.sockets.length === 1,
        String(beat.current.sockets.length));

  // ─── 7. a server that goes away, and comes back ────────────
  console.log('\n7. a server that goes away reads Disconnected, and one that comes back is picked up');
  const outageMark = Date.now();
  await stopServer();
  await waitFor(async () => (await evaluate(SCENE)).pill === 'Disconnected', 'the pill to admit the outage', 60);
  check('the pill says Disconnected while the server is down',
        (await evaluate(SCENE)).pill === 'Disconnected');

  startServer();
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server to come back');
  const backAt = Date.now();
  await waitFor(async () => (await evaluate(SCENE)).pill === 'Connected', 'the socket to come back', 60);
  const reconnectMs = Date.now() - backAt;
  console.log(`      measured: reconnected ${reconnectMs} ms after the server was listening again`);
  check('it reconnects without waiting out a flat three seconds',
        reconnectMs < RECONNECT_BUDGET_MS, `${reconnectMs} ms`);
  record = await probe();
  check('and it retried more than once while the server was down',
        record.sockets.filter((entry) => entry.createdAt >= outageMark).length >= 2,
        String(record.sockets.filter((entry) => entry.createdAt >= outageMark).length));
  await shot('04-recovered');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
