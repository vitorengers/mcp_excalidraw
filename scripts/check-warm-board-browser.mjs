#!/usr/bin/env node
/**
 * Checks that a board switched away from stays live, and that switching back is a redraw.
 *
 * The observation behind #173 is that a tab left behind goes idle: "I dont want to change to
 * a tab and start loading." What a switch used to pay for was not the shells — those outlive
 * any socket and replay their scrollback — but the *redraw*: a socket belongs to one board for
 * its lifetime, so leaving a board closed it, and coming back meant a new connection, a wait
 * for `initial_elements`, and a canvas that says *Connecting* while it happens. Anything
 * created on that board while it was in the background arrived only because the reconnect
 * pulled the whole store again.
 *
 * So the two halves of the definition of done are asserted as two facts a browser can see,
 * and neither of them is "the element is on the canvas" on its own — the old code puts it
 * there too, one full reconnect later, which is precisely the thing being complained about:
 *
 *   - **no new socket, and no `GET /api/elements`, on the way back.** Both are counted from
 *     inside the page, by wrapping `WebSocket` and `fetch` before the app's own script runs.
 *     With neither of them happening, the only way the element created while the board was in
 *     the background can be on the canvas is that the board's own socket delivered it while
 *     nobody was looking at it.
 *   - **the pill never says Connecting.** Watched with a `MutationObserver` rather than
 *     polled: against a local server a reconnect can finish inside a few milliseconds, and a
 *     sampler that missed that window would pass for the wrong reason.
 *
 * And one guard on what keeping a socket open must *not* cost: `clientsWatching` is what tells
 * an agent that no browser is on a board, and a socket held open for a board nobody is looking
 * at would answer yes. A viewport request for the background board has to be refused at once,
 * as it was before any of this, rather than timing out ten seconds later.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server, both
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-warm-board-browser.mjs [--chrome <path>] [--shots <dir>]
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Two projects, neither of them configured against GitHub ──
//
// No `githubProject`, so the mirror stays dormant: nothing else draws on these boards, and
// nothing else spawns a `gh` while the check is counting requests.

const workDir = mkdtempSync(join(tmpdir(), 'check-warm-board-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const ALPHA = 'alpha-project';
const BETA = 'beta-project';
const alphaDir = join(workDir, ALPHA);
const betaDir = join(workDir, BETA);
for (const dir of [alphaDir, betaDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: ALPHA, path: alphaDir.replace(/\\/g, '/') },
    { id: BETA, path: betaDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
writeFileSync(join(alphaDir, 'board.config.json'),
              JSON.stringify({ name: 'Alpha', repo: 'vitorengers/vibemaxxing' }), 'utf8');
writeFileSync(join(betaDir, 'board.config.json'),
              JSON.stringify({ name: 'Beta', repo: 'vitorengers/vibemaxxing' }), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

// Nothing this machine exports reaches the child: `scripts/lib/spawn-canvas.mjs` strips every
// `EXCALIDRAW_*` before the check's own values go in, so there is no terminal block over the
// board — and no other inherited setting — unless this check asks for it.
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

const seed = (workspace, body) => fetch(`${BASE}/api/elements?workspace=${workspace}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const storeOf = async (workspace) => {
  const response = await fetch(`${BASE}/api/elements?workspace=${workspace}`);
  const body = await response.json();
  return (body.elements ?? []).map((element) => (element.customData ?? {}).mark).filter(Boolean).sort();
};

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

/**
 * Everything the page does that a switch is supposed to stop doing.
 *
 * Installed before the app's own bundle runs, so the very first socket is counted too. The
 * pill is watched rather than sampled: on a local server the old reconnect could be over in
 * a few milliseconds, and a poll that missed it would report the wrong answer.
 */
const INSTRUMENT = `
window.__warm = { sockets: [], requests: [], sawConnecting: false };
(() => {
  const RealWebSocket = window.WebSocket;
  class CountedWebSocket extends RealWebSocket {
    constructor(url, protocols) {
      window.__warm.sockets.push(String(url));
      super(url, protocols);
    }
  }
  window.WebSocket = CountedWebSocket;

  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    window.__warm.requests.push(method + ' ' + url);
    return realFetch(input, init);
  };

  const watch = () => {
    const look = () => {
      const dot = document.querySelector('.status-dot');
      if (dot && /status-connecting/.test(dot.className)) window.__warm.sawConnecting = true;
    };
    new MutationObserver(look).observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
    });
    look();
  };
  if (document.body) watch();
  else document.addEventListener('DOMContentLoaded', watch);
})();
`;

const PROBE = `(() => {
  const api = window.__warmCheckApi;
  if (!api) return { error: 'no api handle' };
  const marks = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.mark) marks.push(custom.mark);
  }
  return {
    marks,
    active: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
    sockets: window.__warm.sockets.slice(),
    requests: window.__warm.requests.slice(),
    sawConnecting: window.__warm.sawConnecting,
  };
})()`;

/** The imperative API, through the container's React fibre. See check-board-sections-browser. */
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
        window.__warmCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** Click the tab with this name on it — the gesture the whole issue is about. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

/** Wait for a shape carrying this mark to be on the canvas. */
const markShowing = (mark) => waitFor(async () => {
  const probe = await evaluate(PROBE);
  return probe.marks && probe.marks.includes(mark) ? probe : null;
}, `a shape marked "${mark}" on the canvas`);

const socketsFor = (probe, workspace) =>
  probe.sockets.filter((url) => url.includes(`workspace=${workspace}`));

const elementPulls = (requests, workspace) => requests.filter((request) =>
  request.startsWith('GET ') && /\/api\/elements\?/.test(request) && request.includes(`workspace=${workspace}`));

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await seed(ALPHA, {
    type: 'rectangle', x: 0, y: 0, width: 320, height: 220,
    backgroundColor: '#e7f5ff', text: 'alpha', customData: { mark: 'alpha' },
  });
  await seed(BETA, {
    type: 'rectangle', x: 0, y: 0, width: 320, height: 220,
    backgroundColor: '#f3f0ff', text: 'beta', customData: { mark: 'beta' },
  });

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
  // Before the bundle, not after it: the socket this whole check counts is opened during load.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await send('Page.navigate', { url: BASE });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  console.log('1. the board opens on Alpha, with one socket for it');
  let probe = await markShowing('alpha');
  check('Alpha is the board in front', /Alpha/.test(probe.active ?? ''), String(probe.active));
  check('one socket was opened, and it named Alpha',
        socketsFor(probe, ALPHA).length === 1 && probe.sockets.length === 1,
        probe.sockets.join(', '));

  console.log('\n2. switching to Beta connects Beta');
  check('Beta has a tab to click', await selectTab('Beta'));
  probe = await markShowing('beta');
  await sleep(800);
  probe = await evaluate(PROBE);
  await shot('01-beta-in-front');
  check('Beta is the board in front', /Beta/.test(probe.active ?? ''), String(probe.active));
  check('a socket was opened for Beta', socketsFor(probe, BETA).length === 1, probe.sockets.join(', '));

  console.log('\n3. an element created on Alpha while Beta is in front');
  await seed(ALPHA, {
    type: 'rectangle', x: 400, y: 0, width: 320, height: 220,
    backgroundColor: '#fff3bf', text: 'late', customData: { mark: 'alpha-late' },
  });
  await sleep(1200);
  probe = await evaluate(PROBE);
  check('it is not drawn on Beta — the boards are still separate',
        !probe.marks.includes('alpha-late'), probe.marks.join(', '));

  // The one thing keeping a socket open must not cost: an agent asking to move the camera on
  // a board nobody is looking at has to be told so, at once, not left to time out.
  const refused = await fetch(`${BASE}/api/viewport?workspace=${ALPHA}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scrollToContent: true }),
  });
  const refusedBody = await refused.json().catch(() => ({}));
  check('a viewport request for the background board is refused at once',
        refused.status === 503, `HTTP ${refused.status} ${JSON.stringify(refusedBody)}`);

  console.log('\n4. and switching back to Alpha is a redraw, not a reconnect');
  const marker = await evaluate(`(() => {
    window.__warm.sawConnecting = false;
    return { sockets: window.__warm.sockets.length, requests: window.__warm.requests.length };
  })()`);
  check('Alpha has a tab to click', await selectTab('Alpha'));
  probe = await markShowing('alpha-late');
  await sleep(800);
  probe = await evaluate(PROBE);
  await shot('02-alpha-returned');

  check('Alpha is the board in front again', /Alpha/.test(probe.active ?? ''), String(probe.active));
  check('what was created while it was in the background is on the canvas',
        probe.marks.includes('alpha-late'), probe.marks.join(', '));
  check('no socket was opened to come back',
        probe.sockets.length === marker.sockets,
        `${probe.sockets.length - marker.sockets} more: ${probe.sockets.slice(marker.sockets).join(', ')}`);
  const pulled = elementPulls(probe.requests.slice(marker.requests), ALPHA);
  check('and the board was not pulled over HTTP either',
        pulled.length === 0, pulled.join(', '));
  check('so the pill never said Connecting', probe.sawConnecting === false);

  console.log('\n5. the boards still have their own stores');
  check('Alpha holds its own two shapes',
        JSON.stringify(await storeOf(ALPHA)) === JSON.stringify(['alpha', 'alpha-late']),
        JSON.stringify(await storeOf(ALPHA)));
  check('Beta holds only its own',
        JSON.stringify(await storeOf(BETA)) === JSON.stringify(['beta']),
        JSON.stringify(await storeOf(BETA)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
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
