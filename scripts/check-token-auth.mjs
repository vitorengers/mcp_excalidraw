#!/usr/bin/env node
/**
 * Checks that the board is behind a token, and that a reader never has to know it exists.
 *
 * Until #350 there was no authentication anywhere. The whole of the control was the loopback
 * bind, and loopback is not a permission boundary between accounts: every other process on the
 * machine — a second user, a sandboxed process, an `npm postinstall` in a project the operator
 * had just opened — could drive an API that starts real shells and coding agents with repository
 * write access. `docs/SECURITY.md` documented that rather than closing it.
 *
 * What closes it is a file. The server generates a secret at startup, writes it beside its
 * pidfile with owner-only permissions, and refuses everything under `/api` and every WebSocket
 * upgrade that does not carry it. The launcher puts it in the URL it opens; the page reads it
 * once, keeps it for the tab and takes it out of the address bar.
 *
 * So there are two halves here and only one of them compiles:
 *
 *   - **the gate** — 401 without, 200 with, on the header and on the query; the socket refused;
 *     `GET /` and `/health` deliberately still open, because the page cannot read a token out of
 *     an address bar it has not loaded yet; the token file's mode denying group and other;
 *   - **the bootstrap** — which is entirely a browser behaviour. A page that reads `?t=`, keeps
 *     it and strips it compiles exactly as well as one that reads nothing, and the failure is a
 *     board that loads and then quietly does nothing. So this needs a real Chrome: it navigates
 *     to the launcher URL, waits for the socket to say *connected* — which it can only do
 *     through the gate — finds an element that was seeded over the API, and then reads the
 *     address bar back.
 *
 * It also asserts the opt-out, because the opt-out is what every other check in this directory
 * runs behind (`scripts/lib/spawn-canvas.mjs`). A switch nothing exercises is a switch that
 * stops working on the day it is needed, and the day it is needed is every other check.
 *
 * And the restart, which is the one exit that is not a stop: the board is replaced on the same
 * port while a tab watches, so the secret has to travel with it. Per-start secrets and nothing
 * else would leave that tab holding one nothing accepts — a board that reports itself back up
 * and then refuses everything it is asked.
 *
 * The board is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME`, so the
 * token lands inside this check's own temporary directory and the operator's real state
 * directory is never read or written. Where it lands is spelled out here from the platform
 * rather than imported, so that a change to the convention has to be made twice on purpose.
 *
 * Self-contained: canvas servers on ports the kernel just handed out, one headless Chrome, all
 * killed at the end — the replacement a restart brings up included, since a detached one nothing
 * tracked would leave a port held on whichever machine ran this. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend, and it runs the
 * built CLI.
 *
 * Usage: node scripts/check-token-auth.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas } from './lib/spawn-canvas.mjs';

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

/** The one header name the server, the page and this check all have to agree on. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-token-auth-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
/** The home each board is told it has, and the only place it may keep state. */
const fakeHome = join(workDir, 'home');
for (const dir of [profileDir, shotDir, fakeHome]) mkdirSync(dir, { recursive: true });

/**
 * Where the token has to appear, spelled out from the platform.
 *
 * The three answers `stateDir()` gives — `Library/Application Support` on macOS, `LOCALAPPDATA`
 * on Windows, `XDG_STATE_HOME` on Linux — with the directory leaf the tool writes today, and the
 * file named the way the pidfile beside it is. Written out rather than imported on purpose: a
 * check that asks the code under test where it put a file agrees with any answer it gives.
 */
function conventionalTokenFile(port) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf, `server-${port}.token`);
}

const children = [];
/** The board the restart case brings up: detached, so it is not one of `children`. */
let replacementPid = null;
let log = '';

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

/**
 * A board of this check's own.
 *
 * `EXCALIDRAW_NO_AUTH: undefined` is the point of the whole file: `canvasEnvironment` sets that
 * variable for every check in this directory, and this is the one that has to take it back off.
 */
async function startBoard({ auth }) {
  const server = startCanvas({
    port: await freePort(),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      EXCALIDRAW_NO_AUTH: auth ? undefined : '1',
      // Every spelling of "where this user keeps things", so whichever one the platform reads
      // lands inside the temporary directory rather than in the operator's real state directory.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
    },
  });
  children.push(server.child);
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => (await fetch(`${server.base}/health`)).ok, 'the canvas server');
  return server;
}

async function call(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* HTML, or nothing */ }
  return { status: response.status, text, body };
}

/**
 * What a WebSocket handshake against `url` does: open, or be refused with a status.
 *
 * Resolved either way rather than thrown, because "refused" is the expected answer in half the
 * cases here and an exception would make the two shapes read differently.
 */
function handshake(url, headers = {}) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = new WebSocket(url, { headers });
    } catch (error) {
      resolve({ opened: false, status: null, message: String(error?.message ?? error) });
      return;
    }
    const done = (outcome) => {
      try { socket.close(); } catch { /* already gone */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => done({ opened: false, status: null, message: 'no answer' }), 5000);
    socket.once('open', () => { clearTimeout(timer); done({ opened: true, status: 101, message: '' }); });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      done({ opened: false, status: response.statusCode, message: response.statusMessage ?? '' });
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      done({ opened: false, status: null, message: String(error?.message ?? error) });
    });
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

async function attach(cdpPort) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
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

/** The board as the reader has it: what the socket says, and what is on the canvas. */
const boardState = () => evaluate(`(() => {
  const dot = document.querySelector('.status-dot');
  const classes = dot ? dot.className : '';
  const api = window.__tokenCheckApi;
  return {
    dot: classes,
    connected: /status-connected/.test(classes),
    labels: api ? api.getSceneElements().map((element) => element.text || '').filter(Boolean) : null,
  };
})()`);

/**
 * The Excalidraw API handle, off the React fiber. The same walk the other browser checks do —
 * there is no other way to read the scene the reader is actually looking at.
 */
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
        window.__tokenCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

try {
  // ─── 1. A board with a token, and where it put it ───────────

  console.log('1. the server writes a token beside its pidfile, readable by this account alone');
  const board = await startBoard({ auth: true });
  const tokenFile = conventionalTokenFile(board.port);
  check('the token file is at the conventional path for this platform', existsSync(tokenFile), tokenFile);

  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  check('it holds a secret long enough to be one', token.length >= 32, `${token.length} characters`);
  check('and it is hex, so it survives a URL and a header unescaped', /^[0-9a-f]+$/.test(token));

  if (process.platform === 'win32') {
    // Windows has no POSIX mode bits: `fs.statSync().mode` reports a synthesised `0o666`/`0o444`
    // whatever the ACL says, so an assertion here would be about Node's fiction rather than about
    // the file. What protects it there is the ACL on `%LOCALAPPDATA%`, and the POSIX case below
    // is asserted on every other platform this ships to — CI runs it on Linux and macOS.
    console.log('  ..    the mode case is POSIX-only; this platform has no mode bits to read');
  } else {
    const mode = statSync(tokenFile).mode & 0o777;
    check('its permissions deny group and other', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
    check('and grant the owner read and write', (mode & 0o600) === 0o600, `mode ${mode.toString(8)}`);
  }

  // ─── 2. The gate over HTTP ──────────────────────────────────

  console.log('\n2. everything under /api needs the token, and the bootstrap does not');
  const bare = await call(board.base, '/api/elements');
  check('GET /api/elements with no token answers 401', bare.status === 401, `got ${bare.status}`);
  check('the refusal says where a program finds the token', /token/i.test(bare.body?.error ?? ''),
        JSON.stringify(bare.body));
  check('and never echoes the token itself back', !bare.text.includes(token));

  const withHeader = await call(board.base, '/api/elements', { headers: { [TOKEN_HEADER]: token } });
  check('GET /api/elements with the token from the state directory answers 200',
        withHeader.status === 200, `got ${withHeader.status}`);
  check('and it is the board, not a stub', Array.isArray(withHeader.body?.elements),
        JSON.stringify(withHeader.body).slice(0, 200));

  const withQuery = await call(board.base, `/api/elements?token=${encodeURIComponent(token)}`);
  check('?token= works too, because the socket has no other door', withQuery.status === 200,
        `got ${withQuery.status}`);

  const wrong = await call(board.base, '/api/elements', { headers: { [TOKEN_HEADER]: 'f'.repeat(token.length) } });
  check('a token of the right shape and the wrong value is still 401', wrong.status === 401,
        `got ${wrong.status}`);

  const writing = await call(board.base, '/api/elements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }),
  });
  check('a write with no token is refused as well as a read', writing.status === 401, `got ${writing.status}`);

  const health = await call(board.base, '/health');
  check('/health stays open — it is how anything finds out what is on a port', health.status === 200,
        `got ${health.status}`);
  const page = await call(board.base, '/');
  check('GET / stays open, because the page reads the token and cannot before it has loaded',
        page.status === 200, `got ${page.status}`);

  // ─── 3. The gate over the socket ────────────────────────────

  console.log('\n3. the upgrade is gated too — it streams the scene and every shell on connect');
  const wsBase = board.base.replace(/^http/, 'ws');
  const refused = await handshake(`${wsBase}/?workspace=default`);
  check('a WebSocket handshake with no token is refused', !refused.opened,
        `opened with ${refused.status ?? refused.message}`);
  check('and refused with 401 rather than dropped', refused.status === 401,
        `got ${refused.status ?? refused.message}`);

  const accepted = await handshake(`${wsBase}/?workspace=default&token=${encodeURIComponent(token)}`);
  check('the same handshake with the token opens', accepted.opened, accepted.message);

  const byHeader = await handshake(`${wsBase}/?workspace=default`, { [TOKEN_HEADER]: token });
  check('a program that can set headers may use the header there too', byHeader.opened, byHeader.message);

  // ─── 4. The bootstrap, in a real browser ────────────────────

  console.log('\n4. the launcher URL loads a working board, and the address bar does not keep the token');
  // Seeded before the page opens, so "the board works" is a shape the reader can see rather than
  // an empty canvas that would look the same if every request had been refused.
  const seeded = await call(board.base, '/api/elements', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
    body: JSON.stringify({ type: 'text', x: 40, y: 40, text: 'token-check-shape' }),
  });
  check('a shape is seeded over the API for the page to find', seeded.status === 201 || seeded.status === 200,
        `got ${seeded.status} ${JSON.stringify(seeded.body).slice(0, 200)}`);

  const cdpPort = await freePort();
  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' }));
  await attach(cdpPort);
  await send('Page.enable');
  await send('Runtime.enable');

  // The bare URL first, and in this order on purpose: the tab remembers the token for the rest of
  // its life once it has one, so the un-launched case has to be asked before the launched one.
  await send('Page.navigate', { url: board.base });
  await waitFor(async () => (await boardState()).dot !== '', 'the header to render');
  await sleep(4000);
  const unlaunched = await boardState();
  await shot('01-no-token');
  check('the bare URL, opened by hand, does not reach the board', unlaunched.connected === false,
        JSON.stringify(unlaunched.dot));

  await send('Page.navigate', { url: `${board.base}/?t=${encodeURIComponent(token)}` });
  const live = await waitFor(async () => {
    const state = await boardState();
    return state.connected ? state : null;
  }, 'the board to connect through the gate');
  await shot('02-launcher-url');
  check('opening the launcher URL connects the socket', live.connected === true, JSON.stringify(live.dot));

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const drawn = await waitFor(async () => {
    const state = await boardState();
    return state.labels?.includes('token-check-shape') ? state : null;
  }, 'the seeded shape on the canvas');
  check('and the page loads the scene over HTTP, so its requests carry the token too',
        drawn.labels.includes('token-check-shape'), JSON.stringify(drawn.labels));

  const address = await evaluate('JSON.stringify({ href: location.href, search: location.search })');
  const parsed = JSON.parse(address);
  check('the address bar no longer contains the token', !parsed.href.includes(token), parsed.href);
  check('nor the parameter it arrived in', !/[?&]t=/.test(parsed.search), parsed.search);

  const remembered = await evaluate(`window.sessionStorage.getItem('vibemaxxing.board-token')`);
  check('the tab remembers it in sessionStorage, which is where a reload finds it',
        remembered === token);
  const persisted = await evaluate(`window.localStorage.getItem('vibemaxxing.board-token')`);
  check('and not in localStorage, which would outlive the server that issued it', persisted === null);

  await send('Page.navigate', { url: board.base });
  const reloaded = await waitFor(async () => {
    const state = await boardState();
    return state.connected ? state : null;
  }, 'the board to connect again after a reload with no token in the URL');
  check('a reload of the bare URL still works, from what the tab remembered',
        reloaded.connected === true, JSON.stringify(reloaded.dot));

  // ─── 5. The CLI, which reads the same file ──────────────────

  console.log('\n5. the CLI reads the token off disk, so nothing there needs a flag');
  /** A `vibemaxxing` run against this board, with `home` as the only place it may look. */
  const runCli = (home) => spawnSync(
    process.execPath,
    // `--url`, and not the variable that would also work: `check-no-external-server.mjs` forbids a
    // check from naming that variable at all, because a check whose target is decided by
    // something somebody exported months ago is a check that asserts an unknown server. The flag
    // is the explicit spelling of the same thing, and it is what points this run at the board
    // three lines up rather than at whatever is on 3737.
    [join(repoRoot, 'dist', 'bin.js'), '--url', board.base, 'describe'],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: canvasEnvironment({
        LOG_LEVEL: 'error',
        LOG_FILE_PATH: join(workDir, 'cli.log'),
        HOME: home,
        USERPROFILE: home,
        LOCALAPPDATA: home,
        XDG_STATE_HOME: home,
      }),
    },
  );

  const reading = runCli(fakeHome);
  check('`describe` against a board behind a token succeeds', reading.status === 0,
        `exit ${reading.status}: ${(reading.stderr ?? '').slice(-300)}`);
  check('and it read the actual board, so the token came out of the state directory',
        (reading.stdout ?? '').includes('token-check-shape'), (reading.stdout ?? '').slice(0, 300));

  // The other half, and it is the one that makes the first mean anything: a caller that cannot
  // read the file is refused. Without it, "succeeded" would also be the answer for a board that
  // was never gated.
  const strangerHome = join(workDir, 'stranger');
  mkdirSync(strangerHome, { recursive: true });
  const stranger = runCli(strangerHome);
  check('a CLI that cannot see the state directory is refused', stranger.status !== 0,
        `exit ${stranger.status}: ${(stranger.stdout ?? '').slice(0, 200)}`);

  // ─── 6. The opt-out every other check runs behind ───────────

  console.log('\n6. the opt-out is real, because every other check in this directory is behind it');
  const open = await startBoard({ auth: false });
  const openRead = await call(open.base, '/api/elements');
  check('a board started with the opt-out answers /api with no token', openRead.status === 200,
        `got ${openRead.status}`);
  check('and writes no token file, so nothing is left on disk claiming otherwise',
        !existsSync(conventionalTokenFile(open.port)), conventionalTokenFile(open.port));
  const openSocket = await handshake(`${open.base.replace(/^http/, 'ws')}/?workspace=default`);
  check('its socket opens with no token either', openSocket.opened, openSocket.message);

  // ─── 7. A restart is a replacement, not a stop ──────────────

  console.log('\n7. a restart hands the secret on, so the tab watching it does not go dead');
  const replaced = await startBoard({ auth: true });
  const carried = readFileSync(conventionalTokenFile(replaced.port), 'utf8').trim();
  const wasPid = (await call(replaced.base, '/health')).body?.pid ?? null;
  check('the board about to be restarted names a pid', typeof wasPid === 'number', String(wasPid));

  const asked = await call(replaced.base, '/api/restart', {
    method: 'POST',
    headers: { [TOKEN_HEADER]: carried },
  });
  check('POST /api/restart is itself behind the token, and this one carries it',
        asked.status === 200 && asked.body?.success === true,
        `got ${asked.status} ${JSON.stringify(asked.body).slice(0, 200)}`);

  // The replacement is a detached process the supervisor starts, so it is not one of `children`.
  // Its pid is read here and killed in the `finally`; a check that orphaned a canvas would leave
  // a port held on the machine that runs it.
  const back = await waitFor(async () => {
    const now = await call(replaced.base, '/health');
    const pid = now.body?.pid;
    return typeof pid === 'number' && pid !== wasPid ? pid : null;
  }, 'a different pid to answer on the same port', 200);
  replacementPid = back;
  check('a different process answers on the same port', back !== wasPid, `${wasPid} -> ${back}`);

  const afterRestart = await call(replaced.base, '/api/elements', { headers: { [TOKEN_HEADER]: carried } });
  check('the secret the open tab is holding still works against the replacement',
        afterRestart.status === 200, `got ${afterRestart.status}`);
  check('and the handover file is gone, consumed by the start that used it',
        !existsSync(join(dirname(conventionalTokenFile(replaced.port)), `server-${replaced.port}.handover`)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(300);
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  if (replacementPid) { try { process.kill(replacementPid); } catch { /* already gone */ } }
  await sleep(400);
  // Windows can still hold a handle on a directory a killed browser was reading; a temporary
  // directory left behind is not a failed check.
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
}

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
