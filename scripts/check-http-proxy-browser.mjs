#!/usr/bin/env node
/**
 * Checks that a workspace-tagged request reaches the machine that owns the board.
 *
 * Everything the milestone built before this had no caller. A tab for another machine's project
 * exists, its id is namespaced so a socket cannot land on the wrong board, the registry says how
 * to reach that machine and the client knows how to ask it — and a request naming that project
 * was answered from an empty local store all the same, silently, because `elementsFor` yields an
 * empty store for an unknown id *by design*. The tab drew a blank canvas that reads as the
 * reader's own board with the drawing gone. That is the defect, and it is invisible to anything
 * that only looks at one machine.
 *
 * **Two boards, one recorder and one Chrome**, and each of the three earns its place.
 *
 *  - The **peer board** is a real server with a real project on it, seeded with one element only
 *    it can have. *Served from the right machine* is then an invariant about element ids rather
 *    than a stopwatch, and *a write crossed* is read from that board's own store rather than from
 *    the page that made it.
 *  - The **recorder** is a second peer that is not a board at all: an HTTP listener that writes
 *    down every request it is given and answers. It is the only way to assert what the peer
 *    *actually received* — that this board's token crossed in neither spelling, that exactly one
 *    credential arrived and it was the peer's, that `x-client-id` came through byte-identical,
 *    that the board is named once and in the peer's own spelling. A real board would answer those
 *    requests correctly whether or not the headers were right.
 *  - **Chrome** is what answers the half a type checker cannot. The page drives a real pointer
 *    press before switching tabs: `scheduleAutoSync` arms nothing until `userInteractedRef` is
 *    set, so a check that only drove the imperative API would watch every assertion pass because
 *    nothing was ever written. It switches by clicking `.workspace-tab__select`, because the
 *    outer `.workspace-tab` switches nothing.
 *
 * The peer's projects are seeded here as **local registry entries under the namespaced id**,
 * because the route that draws a peer's projects as tabs is a different issue in the same
 * milestone and lands separately. What that stands in for is one thing only — a tab existing —
 * and every id is minted by `core/remote-workspace-id.ts` rather than typed, so the strip the
 * reader ends up with and the strip this drives name the same boards.
 *
 * The token gate is off, as it is for every check in this directory (`canvasEnvironment` sets
 * `EXCALIDRAW_NO_AUTH`). That is not a hole in section 2: what is asserted there is that both
 * spellings of a local token are **taken off** an outgoing request and the peer's own credential
 * written in their place, so the token is one this check invents and sends, and the recorder is
 * asked whether it arrived.
 *
 * Three sections and a preamble:
 *
 *   0. **the seam** — `src/server.ts` learns a name and nothing else: one import, one `app.use`,
 *      no route. And the two reply-half paths this file names are the two on
 *      `PATHS_THAT_STAY_HERE`, reached through that list rather than beside it.
 *   1. **the control** — a request genuinely crossed the link, read from the peer's own store, by
 *      each of the three spellings the board name arrives in. Without it every *nothing crossed
 *      boards* assertion below passes vacuously.
 *   2. **the defect** — the peer's scene answers through the local board while the local store
 *      for that id stays empty; every request shape that belongs to this machine is answered
 *      here, named one at a time rather than sampled; the reply halves go through the ledger; an
 *      export or a viewport move does not wait out its timeout; and the credential discipline is
 *      read off the request the peer received.
 *   3. **recovery** — a peer that is not there produces a stated status and a sentence, not a
 *      hang and not a 500, and a peer that comes back answers again.
 *
 * **Red first against today's build**: with no forwarder the remote tab answers from this
 * machine's own empty store, so the control finds nothing crossed and the browser draws a blank
 * canvas where the peer's drawing should be.
 *
 * Self-contained: throwaway registries, state directories and project directories, its own
 * servers on ports the kernel just handed out, all killed at the end. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-http-proxy-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

for (const built of ['dist/server.js', 'dist/core/peer-proxy.js', 'dist/frontend/index.html']) {
  if (!existsSync(join(repoRoot, built))) {
    console.error(`  FAIL  ${built} exists`);
    console.error('        (run ./node_modules/.bin/tsc and ./node_modules/.bin/vite build first)');
    process.exit(1);
  }
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const load = (name) => import(pathToFileURL(join(repoRoot, 'dist', 'core', `${name}.js`)).href);

const { mintRemoteWorkspaceId } = await load('remote-workspace-id');
const { PATHS_THAT_STAY_HERE } = await load('peer-request-rewrite');
const { TOKEN_HEADER, TOKEN_QUERY } = await load('board-token');
const { createReplyLedger } = await load('reply-ledger');
const proxyModule = await load('peer-proxy');
const {
  createPeerProxy, peerProxy, peerReplyLedger,
  REPLY_HALF_PATHS, PEER_RESPONSE_HEADERS_THAT_CROSS, PEER_FAILURE_STATUS, replyHalfOf
} = proxyModule;

// ─── The two machines, named ──────────────────────────────────

const DESK = 'desk';
const RECORDER = 'recorder';
const PROJECT = 'notebook';
const DESK_SECRET = 'a-credential-the-desk-minted';
const RECORDER_SECRET = 'a-credential-the-recorder-minted';
/** A token that is this board's own. It must come off every outgoing request, in both spellings. */
const LOCAL_TOKEN = 'a-token-that-belongs-to-this-machine';
const CLIENT_ID = 'a-client-id-that-must-survive-the-hop';

const deskBoard = mintRemoteWorkspaceId(DESK, PROJECT);
const recorderBoard = mintRemoteWorkspaceId(RECORDER, PROJECT);
if (!deskBoard.ok || !recorderBoard.ok) {
  console.error(`  FAIL  the namespaced ids could be minted — ${deskBoard.refusal ?? recorderBoard.refusal}`);
  process.exit(1);
}
const DESK_BOARD = deskBoard.id;
const RECORDER_BOARD = recorderBoard.id;

const ONLY_ON_THE_PEER = 'only-the-desk-can-have-this';
const WRITTEN_THROUGH_THE_LINK = 'written-through-the-link';

// ─── Directories, registries and the peer file ────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-http-proxy-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');

const project = (name) => {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name }), 'utf8');
  return dir.replace(/\\/g, '/');
};

const peerRegistryFile = join(workDir, 'peer-workspaces.json');
writeFileSync(peerRegistryFile, JSON.stringify({
  workspaces: [{ id: PROJECT, path: project('the-desks-notebook') }]
}), 'utf8');

const localRegistryFile = join(workDir, 'local-workspaces.json');
writeFileSync(localRegistryFile, JSON.stringify({
  workspaces: [
    { id: 'here', path: project('a-project-of-this-machines-own') },
    // The stand-in for the tab strip a peer's projects land on: a row so the strip draws
    // something to click. The id is minted, never typed.
    { id: DESK_BOARD, path: project('desk-notebook-tab') },
    { id: RECORDER_BOARD, path: project('recorder-tab') }
  ]
}), 'utf8');

/** Where `core/settings.ts` puts per-user state under a `STATE_HOME` a check hands it. */
const stateLeaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
const localStateHome = join(workDir, 'state-local');
const localStateDir = join(localStateHome, stateLeaf);
mkdirSync(localStateDir, { recursive: true });
const peersFile = join(localStateDir, 'peers.json');

const [localPort, peerPort, recorderPort, cdpPort] = await freePorts(4);
const LOCAL = `http://127.0.0.1:${localPort}`;
const PEER = `http://127.0.0.1:${peerPort}`;
const RECORDER_URL = `http://127.0.0.1:${recorderPort}`;

/** The peer file, written afresh whenever this check changes which machines it knows. */
function writePeers(peers) {
  writeFileSync(peersFile, `${JSON.stringify({ version: 1, peers }, null, 2)}\n`, 'utf8');
}

const DESK_PEER = {
  id: DESK, name: 'The desk', baseUrl: PEER, secret: DESK_SECRET,
  addedAt: '2026-08-03T00:00:00.000Z', lastSeenAt: null
};
const RECORDER_PEER = {
  id: RECORDER, name: 'The recorder', baseUrl: RECORDER_URL, secret: RECORDER_SECRET,
  addedAt: '2026-08-03T00:00:00.000Z', lastSeenAt: null
};
writePeers([DESK_PEER, RECORDER_PEER]);

// ─── The recorder: a peer that is a notebook rather than a board ──

const received = [];
const recorder = createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    received.push({
      method: request.method,
      url: request.url,
      headers: { ...request.headers },
      body: Buffer.concat(chunks).toString('utf8')
    });
    response.setHeader('content-type', 'application/json');
    // A header nobody named, to prove the response side is a list rather than a pass-through.
    response.setHeader('set-cookie', 'a-session-of-the-peers=must-not-cross');
    response.statusCode = 200;
    response.end(JSON.stringify({ success: true, servedBy: 'the-recorder' }));
  });
});
await new Promise((resolve) => recorder.listen(recorderPort, '127.0.0.1', resolve));

// ─── The two boards ───────────────────────────────────────────

const children = [];
const logs = new Map();

function board(port, env) {
  const server = startCanvas({ port, cwd: workDir, env: { LOG_LEVEL: 'warn', ...env } });
  children.push(server.child);
  logs.set(port, server);
  return server;
}

async function answering(server, what, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`${what} exited early:\n${server.read()}`);
    try { if ((await fetch(`${server.base}/health`)).ok) return server; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`${what} never answered on ${server.base}:\n${server.read()}`);
}

let peer = board(peerPort, { EXCALIDRAW_WORKSPACES: peerRegistryFile });
const local = board(localPort, {
  EXCALIDRAW_WORKSPACES: localRegistryFile,
  EXCALIDRAW_STATE_HOME: localStateHome
});

// ─── Talking to a board ───────────────────────────────────────

const ask = async (base, path, init = {}) => {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON, which is itself an answer */ }
  return { status: response.status, headers: response.headers, text, json };
};

const post = (base, path, body, headers = {}) => ask(base, path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

const marksOn = (answer) => (answer.json?.elements ?? [])
  .map((element) => element?.customData?.mark).filter(Boolean);

const seed = (base, workspace, mark, x) => post(base, `/api/elements?workspace=${workspace}`, {
  type: 'rectangle', x, y: 0, width: 300, height: 200,
  backgroundColor: '#e7f5ff', customData: { mark }
});

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function waitFor(fn, what, tries = 120, every = 250) {
  let last = '';
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; }
    catch (error) { last = error.message; }
    await sleep(every);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${last})` : ''}`);
}

async function attach() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
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
  try {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  } catch { /* a screenshot is evidence, never a case */ }
}

/** The imperative API, through the container's React fibre. See check-workspace-viewport-browser. */
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
        window.__proxyCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__proxyCheckApi;
  if (!api) return { error: 'no api handle' };
  return {
    marks: api.getSceneElements().map((element) => (element.customData || {}).mark).filter(Boolean),
    active: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
    tabs: [...document.querySelectorAll('.workspace-tab__select')].map((tab) => tab.textContent || '')
  };
})()`;

/** Click the tab whose name contains this — the gesture, on the element that switches. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

/** A real press on the canvas. Nothing arms `scheduleAutoSync` until one has happened. */
async function press(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1
    });
  }
  await sleep(150);
}

// ─── Driving the middleware directly, for the ledger ──────────

/**
 * One request through a proxy built here, with the seams this check supplies.
 *
 * The ledger's `peer` branch cannot be reached from outside the process yet: an entry is created
 * by the socket forwarder, which is a later issue in this milestone. What it can be asked is the
 * decision — given an entry, does this middleware send the reply to that machine — and that is a
 * question about the seam rather than about a socket.
 */
async function driveProxy(proxy, request) {
  const written = { status: null, header: {}, json: null, body: null, nexted: false };
  const response = {
    status(code) { written.status = code; return response; },
    setHeader(name, value) { written.header[name] = value; },
    json(value) { written.json = value; },
    end(chunk) { written.body = chunk; }
  };
  proxy(request, response, () => { written.nexted = true; });
  for (let attempt = 0; attempt < 200; attempt++) {
    if (written.nexted || written.status !== null) return written;
    await sleep(10);
  }
  return written;
}

/** A `callPeer` that answers whatever the case decided, and writes down what it was asked. */
function callerSaying(result) {
  const call = async (target, request) => { call.asked.push({ target, request }); return result; };
  call.asked = [];
  return call;
}

// ─── The run ──────────────────────────────────────────────────

for (const dir of [profileDir, shotDir]) mkdirSync(dir, { recursive: true });

try {
  // ── 0. The seam ─────────────────────────────────────────────

  console.log('0. src/server.ts learns a name, and the reply halves are named through one list');

  const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
  const mentions = serverSource.split('\n')
    .map((line, at) => ({ line: line.trim(), at: at + 1 }))
    .filter(({ line }) => /peer-proxy|peerProxy/.test(line));
  check('src/server.ts names the forwarder on exactly two lines', mentions.length === 2,
        mentions.map(({ at, line }) => `${at}: ${line}`).join(' | '));
  check('one of them is the import',
        mentions.some(({ line }) => /^import .* from '\.\/core\/peer-proxy\.js';$/.test(line)),
        mentions.map(({ line }) => line).join(' | '));
  check('and the other is one app.use, registering no path',
        mentions.some(({ line }) => line === 'app.use(peerProxy);'),
        mentions.map(({ line }) => line).join(' | '));
  check('no route is registered for it — the route count does not move',
        !/app\.(get|post|put|patch|delete|all)\([^)]*peerProxy/.test(serverSource));

  check('the middleware is what src/server.ts is handed', typeof peerProxy === 'function',
        typeof peerProxy);
  check('and it can be built with seams of its own', typeof createPeerProxy === 'function');
  check('the ledger both forwarders consult is one value, exported',
        peerReplyLedger !== undefined && typeof peerReplyLedger.record === 'function'
        && typeof peerReplyLedger.resolve === 'function');
  check('the response headers that cross are named rather than filtered',
        Array.isArray(PEER_RESPONSE_HEADERS_THAT_CROSS)
        && PEER_RESPONSE_HEADERS_THAT_CROSS.length > 0
        && PEER_RESPONSE_HEADERS_THAT_CROSS.every((name) => name === name.toLowerCase()),
        JSON.stringify(PEER_RESPONSE_HEADERS_THAT_CROSS));
  check('a peer that is not there is a gateway timeout and a peer that refuses is a bad gateway',
        PEER_FAILURE_STATUS?.unreachable === 504 && PEER_FAILURE_STATUS?.refused === 502,
        JSON.stringify(PEER_FAILURE_STATUS));
  check('and neither of them is a 500',
        Object.values(PEER_FAILURE_STATUS ?? {}).every((status) => status !== 500),
        JSON.stringify(PEER_FAILURE_STATUS));

  const stayHere = PATHS_THAT_STAY_HERE.map((entry) => entry.path);
  check('both reply-half paths are on the list of paths that stay here',
        REPLY_HALF_PATHS.every((path) => stayHere.includes(path)),
        `${JSON.stringify(REPLY_HALF_PATHS)} against ${JSON.stringify(stayHere)}`);
  check('and each is recognised as one, through that list rather than beside it',
        REPLY_HALF_PATHS.every((path) => replyHalfOf(path) === path)
        && replyHalfOf('/API/viewport/result/') === '/api/viewport/result',
        JSON.stringify(REPLY_HALF_PATHS.map((path) => replyHalfOf(path))));
  check('a path that stays here for another reason is not one of them',
        replyHalfOf('/api/restart') === null && replyHalfOf('/api/elements') === null);

  // ── The boards come up ──────────────────────────────────────

  await answering(peer, 'the peer board');
  await answering(local, 'the local board');

  await seed(PEER, PROJECT, ONLY_ON_THE_PEER, 0);
  const peerSeeded = await ask(PEER, `/api/elements?workspace=${PROJECT}`);
  check('the peer holds one element only it can have',
        marksOn(peerSeeded).join(',') === ONLY_ON_THE_PEER, JSON.stringify(marksOn(peerSeeded)));

  // ── 1. The control ──────────────────────────────────────────

  console.log('\n1. the control: a request really does cross the link, in all three spellings');

  const byQuery = await ask(LOCAL, `/api/elements?workspace=${DESK_BOARD}`);
  check('the peer\'s scene answers through the local board', byQuery.status === 200
        && marksOn(byQuery).includes(ONLY_ON_THE_PEER),
        `${byQuery.status} ${byQuery.text.slice(0, 200)}\n${local.read().slice(-400)}`);

  const byHeader = await ask(LOCAL, '/api/elements', { headers: { 'x-workspace-id': DESK_BOARD } });
  check('a request naming its board by header routes exactly like one naming it by query',
        byHeader.status === 200 && marksOn(byHeader).includes(ONLY_ON_THE_PEER),
        `${byHeader.status} ${byHeader.text.slice(0, 200)}`);

  const bodySpelling = await ask(LOCAL, '/api/elements/search', {
    method: 'GET', headers: { 'x-workspace-id': DESK_BOARD }
  });
  check('and so does a read of the peer\'s board through another route',
        bodySpelling.status === 200, `${bodySpelling.status} ${bodySpelling.text.slice(0, 200)}`);

  const written = await post(LOCAL, `/api/elements?workspace=${DESK_BOARD}`, {
    type: 'rectangle', x: 900, y: 0, width: 200, height: 120,
    customData: { mark: WRITTEN_THROUGH_THE_LINK }
  });
  check('a write through the local board is accepted', written.status === 200 || written.status === 201,
        `${written.status} ${written.text.slice(0, 200)}`);
  const onThePeer = await ask(PEER, `/api/elements?workspace=${PROJECT}`);
  check('and it is in the peer\'s own store — this is the control',
        marksOn(onThePeer).includes(WRITTEN_THROUGH_THE_LINK), JSON.stringify(marksOn(onThePeer)));

  const localOwn = await ask(LOCAL, '/api/elements?workspace=here');
  check('nothing of the peer\'s reached this board\'s own project',
        !marksOn(localOwn).includes(ONLY_ON_THE_PEER)
        && !marksOn(localOwn).includes(WRITTEN_THROUGH_THE_LINK),
        JSON.stringify(marksOn(localOwn)));

  // ── 2. The defect ───────────────────────────────────────────

  console.log('\n2a. every request shape that belongs to this machine is answered here');

  // The recorder is the instrument: a request that was forwarded is a line in its notebook, and
  // a request that stayed here leaves none. `/api/restart` is asked as a GET on purpose — the
  // decision is about the path and the method has no vote, and a POST would end the board this
  // check is asserting against, taking every agent it hosts with it.
  const localShapes = [
    { path: '/health', method: 'GET' },
    { path: '/api/restart', method: 'GET' },
    { path: '/api/fs/directories', method: 'GET' },
    { path: '/api/agent-limits', method: 'GET' },
    { path: '/api/files', method: 'GET' },
    { path: '/api/files/a-file-nobody-stored', method: 'GET', under: '/api/files' },
    { path: '/api/export/image/result', method: 'POST', body: { requestId: 'nobody-asked-for-this' } },
    { path: '/api/viewport/result', method: 'POST', body: { requestId: 'nobody-asked-for-this' } },
    { path: '/api/pair/pending', method: 'GET', under: '/api/pair' },
    { path: '/api/devices', method: 'GET' },
    { path: '/api/devices/a-device-nobody-approved', method: 'GET', under: '/api/devices' }
  ];

  // The control for this section: a path that is *not* on the list, asked of the same board,
  // reaches the recorder. Without it every assertion below passes on a recorder nothing works on.
  received.length = 0;
  await ask(LOCAL, `/api/elements?workspace=${RECORDER_BOARD}`);
  check('the control: a path that is not on the list does cross to the recorder',
        received.length === 1, `${received.length} request(s): ${JSON.stringify(received.map((r) => r.url))}`);

  for (const shape of localShapes) {
    received.length = 0;
    const query = `${shape.path.includes('?') ? '&' : '?'}workspace=${RECORDER_BOARD}`;
    const answer = shape.method === 'POST'
      ? await post(LOCAL, `${shape.path}${query}`, shape.body)
      : await ask(LOCAL, `${shape.path}${query}`);
    check(`${shape.method} ${shape.path} named a peer's board and stayed on this machine`,
          received.length === 0 && answer.text !== null
          && !answer.text.includes('the-recorder'),
          `the recorder saw ${received.length}: ${JSON.stringify(received.map((r) => r.url))}`
          + ` — answered ${answer.status} ${answer.text.slice(0, 120)}`);
  }

  const named = new Set(localShapes.map((shape) => shape.under ?? shape.path));
  const missed = stayHere.filter((path) => !named.has(path));
  check('and each one on the list was named rather than sampled', missed.length === 0,
        `never asked: ${missed.join(', ')}`);

  console.log('\n2b. the reply halves route through the ledger, never through the workspace key');

  {
    const ledger = createReplyLedger();
    const recorded = ledger.record({ requestId: 'r-1', peerId: DESK, type: 'export_image_request' });
    check('an entry can be put on a ledger', recorded.ok === true, JSON.stringify(recorded));

    const caller = callerSaying({
      ok: true, kind: 'answered', liveness: 'online', status: 200,
      headers: { 'content-type': 'application/json' }, body: Buffer.from('{"success":true}')
    });
    const proxy = createPeerProxy({
      ledger, call: caller,
      peerFor: (id) => (id === DESK ? { id: DESK, baseUrl: PEER, secret: DESK_SECRET } : null)
    });

    const sent = await driveProxy(proxy, {
      method: 'POST', originalUrl: '/api/export/image/result',
      headers: { 'content-type': 'application/json' }, body: { requestId: 'r-1', format: 'png', data: 'x' }
    });
    check('a reply whose request came down a link is sent to the machine that asked',
          caller.asked.length === 1 && caller.asked[0]?.target?.baseUrl === PEER,
          JSON.stringify(caller.asked.map((one) => one.target)));
    check('and it is not answered by this machine', sent.nexted === false && sent.status === 200,
          JSON.stringify(sent));
    check('the path it was sent on is the reply half itself',
          caller.asked[0]?.request?.path === '/api/export/image/result',
          JSON.stringify(caller.asked[0]?.request?.path));
    check('and the reply half carries no workspace key at all — there is none to route on',
          !JSON.stringify(caller.asked[0]?.request?.path ?? '').includes('workspace'));

    const again = await driveProxy(proxy, {
      method: 'POST', originalUrl: '/api/export/image/result',
      headers: {}, body: { requestId: 'r-1' }
    });
    check('the same id a second time is spent, so it is answered here rather than sent twice',
          again.nexted === true && caller.asked.length === 1,
          `${caller.asked.length} call(s), nexted ${again.nexted}`);

    const unknown = await driveProxy(proxy, {
      method: 'POST', originalUrl: '/api/viewport/result',
      headers: {}, body: { requestId: 'a-request-of-this-machines-own' }
    });
    check('a reply nobody asked for through this board is this machine\'s own',
          unknown.nexted === true && caller.asked.length === 1, JSON.stringify(unknown));
  }

  {
    // An entry that expired: the peer stopped waiting, so the answer goes nowhere and says so.
    let clock = 1_000;
    const ledger = createReplyLedger({ now: () => clock });
    ledger.record({ requestId: 'r-2', peerId: DESK, type: 'set_viewport' });
    clock += 60_000;
    const caller = callerSaying({ ok: false, kind: 'transport', liveness: 'unreachable', reason: 'no' });
    const proxy = createPeerProxy({
      ledger, call: caller, peerFor: () => ({ id: DESK, baseUrl: PEER, secret: DESK_SECRET })
    });
    const late = await driveProxy(proxy, {
      method: 'POST', originalUrl: '/api/viewport/result', headers: {}, body: { requestId: 'r-2' }
    });
    check('an answer that arrived after its own budget is not sent anywhere',
          caller.asked.length === 0, JSON.stringify(caller.asked));
    check('and it is answered with a sentence rather than a silence',
          late.status === 200 && late.json?.delivered === false
          && typeof late.json?.reason === 'string' && late.json.reason.length > 0,
          JSON.stringify(late.json));
  }

  console.log('\n2c. an export or a viewport move against a remote board does not wait out its timeout');

  {
    const started = Date.now();
    const exported = await post(LOCAL, `/api/export/image?workspace=${DESK_BOARD}`, { format: 'png' });
    const took = Date.now() - started;
    check('an export against a peer\'s board comes back long before the 30 s an export waits',
          took < 10_000, `took ${took} ms`);
    check('and what comes back is the owning machine\'s own answer about its own board',
          exported.status !== 500 && /No frontend client is on the board/.test(exported.text)
          && exported.text.includes(PROJECT),
          `${exported.status} ${exported.text.slice(0, 200)}`);
  }
  {
    const started = Date.now();
    const moved = await post(LOCAL, `/api/viewport?workspace=${DESK_BOARD}`, { scrollToContent: true });
    const took = Date.now() - started;
    check('a viewport move against a peer\'s board comes back long before the 10 s it waits',
          took < 5_000, `took ${took} ms`);
    check('and it too is the owning machine\'s answer', moved.status !== 500
          && /No frontend client is on the board/.test(moved.text),
          `${moved.status} ${moved.text.slice(0, 200)}`);
  }

  console.log('\n2d. what the peer actually received');

  received.length = 0;
  const crossed = await ask(
    LOCAL,
    `/api/elements?workspace=${RECORDER_BOARD}&${TOKEN_QUERY}=${LOCAL_TOKEN}&keep=this`,
    {
      headers: {
        [TOKEN_HEADER]: LOCAL_TOKEN,
        'x-client-id': CLIENT_ID,
        'x-workspace-id': 'a-second-spelling-of-the-board',
        cookie: 'a-session-of-this-machines=must-not-cross',
        accept: 'application/json'
      }
    }
  );
  const got = received[0];
  check('the request reached the peer', received.length === 1 && got !== undefined,
        `${received.length} request(s)`);
  const sentText = JSON.stringify(got ?? {});
  check('this board\'s token crossed in neither spelling', !sentText.includes(LOCAL_TOKEN),
        sentText.slice(0, 300));
  check('exactly one credential arrived, and it was the peer\'s own',
        got?.headers?.[TOKEN_HEADER] === RECORDER_SECRET,
        JSON.stringify(got?.headers?.[TOKEN_HEADER]));
  check('and the query spelling of a token is not on the wire',
        !new URL(got?.url ?? '/', RECORDER_URL).searchParams.has(TOKEN_QUERY), got?.url);
  check('x-client-id arrived byte-identical, so a local write is not echoed back at its author',
        got?.headers?.['x-client-id'] === CLIENT_ID, JSON.stringify(got?.headers?.['x-client-id']));
  check('the board is named exactly once, in the peer\'s own spelling',
        new URL(got?.url ?? '/', RECORDER_URL).searchParams.getAll('workspace').join(',') === PROJECT,
        got?.url);
  check('and the other two spellings of the board name came off',
        got?.headers?.['x-workspace-id'] === undefined
        && !String(got?.url).includes('a-second-spelling-of-the-board'),
        `${got?.headers?.['x-workspace-id']} ${got?.url}`);
  check('the rest of the query is the caller\'s and survived',
        new URL(got?.url ?? '/', RECORDER_URL).searchParams.get('keep') === 'this', got?.url);
  check('this machine\'s cookie stayed on this machine', got?.headers?.cookie === undefined,
        JSON.stringify(got?.headers?.cookie));

  check('the peer\'s secret is nowhere in what the browser is handed back',
        !crossed.text.includes(RECORDER_SECRET) && !crossed.text.includes(DESK_SECRET)
        && ![...crossed.headers.values()].some((value) => String(value).includes(RECORDER_SECRET)),
        crossed.text.slice(0, 200));
  check('and neither is a header of the peer\'s that nobody named',
        crossed.headers.get('set-cookie') === null, String(crossed.headers.get('set-cookie')));
  check('what did come back is the peer\'s own body and its content type',
        crossed.status === 200 && crossed.json?.servedBy === 'the-recorder'
        && String(crossed.headers.get('content-type')).includes('application/json'),
        `${crossed.status} ${crossed.text.slice(0, 200)}`);

  // ── 2e. The browser ─────────────────────────────────────────

  console.log('\n2e. the page draws the peer\'s board, and writes nothing into this machine\'s store');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    LOCAL
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  const opened = await evaluate(PROBE);
  check('the strip has a tab for the peer\'s project',
        (opened.tabs ?? []).some((tab) => tab.includes('desk-notebook-tab')),
        JSON.stringify(opened.tabs));

  check('the tab can be clicked, on the element that switches', await selectTab('desk-notebook-tab'));
  const showing = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.marks?.includes(ONLY_ON_THE_PEER) ? probe : null;
  }, 'the peer\'s own drawing to be on this page', 80).catch((error) => ({ error: error.message }));
  await shot('01-the-peers-board-through-the-link');
  check('the peer\'s own drawing is what the page is showing',
        showing?.marks?.includes(ONLY_ON_THE_PEER) === true,
        JSON.stringify(showing ?? {}));
  check('and the tab in front is the peer\'s', /desk-notebook-tab/.test(showing?.active ?? ''),
        String(showing?.active));

  // The press is the point: nothing arms `scheduleAutoSync` until `userInteractedRef` is set, so
  // without it every assertion below would pass because nothing was ever written anywhere.
  await press(700, 500);
  await press(720, 520);
  await sleep(3_000);

  const peerAfter = await ask(PEER, `/api/elements?workspace=${PROJECT}`);
  check('the peer still holds its own board after the page has been touched',
        marksOn(peerAfter).includes(ONLY_ON_THE_PEER), JSON.stringify(marksOn(peerAfter)));

  // Asked of the store rather than of the page: with the peer forgotten the id stops being
  // routable, so the local routes answer for it — which is exactly the store this board would
  // have filled if nothing had been forwarded.
  await evaluate('window.location.href = "about:blank"');
  await sleep(1_000);
  writePeers([RECORDER_PEER]);
  const localStore = await ask(LOCAL, `/api/elements?workspace=${DESK_BOARD}`);
  check('and the local store for that id is still empty — nothing was manufactured here',
        localStore.status === 200 && (localStore.json?.elements?.length ?? -1) === 0,
        `${localStore.status} ${localStore.text.slice(0, 200)}`);
  writePeers([DESK_PEER, RECORDER_PEER]);

  // ── 3. Recovery ─────────────────────────────────────────────

  console.log('\n3. a peer that is not there answers, and a peer that comes back answers again');

  peer.stop();
  for (let attempt = 0; attempt < 100 && peer.child.exitCode === null; attempt++) await sleep(50);

  const started = Date.now();
  const asleep = await ask(LOCAL, `/api/elements?workspace=${DESK_BOARD}`);
  const took = Date.now() - started;
  check('a board on a machine that is not answering does not hang', took < 15_000, `took ${took} ms`);
  check('the status is stated, and it is not a 500',
        asleep.status === PEER_FAILURE_STATUS.unreachable || asleep.status === PEER_FAILURE_STATUS.refused,
        `${asleep.status} ${asleep.text.slice(0, 200)}`);
  check('and what comes back is a sentence a reader can act on',
        asleep.json?.success === false && typeof asleep.json?.error === 'string'
        && asleep.json.error.length > 20,
        JSON.stringify(asleep.json).slice(0, 300));
  check('which names the machine rather than this one\'s stack',
        String(asleep.json?.error).includes(`127.0.0.1:${peerPort}`)
        && !/at .*\.js:\d+/.test(String(asleep.json?.error)),
        String(asleep.json?.error).slice(0, 300));
  check('and neither secret is in it', !JSON.stringify(asleep.json ?? {}).includes(DESK_SECRET));

  peer = board(peerPort, { EXCALIDRAW_WORKSPACES: peerRegistryFile });
  await answering(peer, 'the peer board, restarted');
  await seed(PEER, PROJECT, ONLY_ON_THE_PEER, 0);

  const back = await waitFor(async () => {
    const answer = await ask(LOCAL, `/api/elements?workspace=${DESK_BOARD}`);
    return answer.status === 200 && marksOn(answer).includes(ONLY_ON_THE_PEER) ? answer : null;
  }, 'the peer\'s board to answer again', 40).catch((error) => ({ error: error.message }));
  check('a peer that comes back answers again, with no restart on this side',
        back?.status === 200, JSON.stringify(back?.error ?? back?.status));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  console.error(error.stack);
} finally {
  try { if (socket) socket.close(); } catch { /* already gone */ }
  await new Promise((resolve) => recorder.close(resolve));
  await sleep(200);
  for (const child of children) if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
