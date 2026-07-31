#!/usr/bin/env node
/**
 * Checks that a board started with nothing configured can add its first project.
 *
 * This is the first screen of the product, and it was a dead end. With no
 * `EXCALIDRAW_WORKSPACES` the registry path was `undefined`, so `GET /api/workspaces`
 * answered `configured: false`, the tab strip removed itself entirely — `if (!configured &&
 * workspaces.length === 0) return null` — and the `+` that registers a project is *inside*
 * that strip. The one affordance for configuring the board was hidden exactly when there was
 * nothing configured. Behind it the server half was complete and unreachable: the directory
 * picker worked on all three platforms and `POST /api/workspaces` refused with a 503 naming
 * the variable a first-run reader has never heard of.
 *
 * So the registry path always resolves now — the variable when it is set, and otherwise a
 * file in the per-OS state directory that everything else here already writes to. The
 * questions are therefore one per half:
 *
 *   - the server: does a board with **no** `EXCALIDRAW_*` at all report itself as somewhere a
 *     project can be added, does the `POST` succeed, and does the registry land at the path
 *     the platform's convention names — `LOCALAPPDATA` on Windows, `Library/Application
 *     Support` on macOS, `XDG_STATE_HOME` on Linux;
 *   - the page: is the strip on screen at all with an empty list, and is its control legible
 *     as "Add a project" rather than as a bare `+` floating in an otherwise empty header.
 *
 * The second half is why this needs a browser. A route that answers `configured: true` while
 * the component still returns `null` compiles perfectly and ships the same dead end.
 *
 * The board is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME`, so the
 * conventional path it resolves is inside this check's own temporary directory and the
 * operator's real state directory is never read or written. The expected path is spelled out
 * here from the platform rather than imported, so that a change to the convention has to be
 * made twice on purpose.
 *
 * Self-contained: a throwaway project directory, one canvas server on a port the kernel just
 * handed out, one headless Chrome, all killed at the end. `EXCALIDRAW_NO_DOTENV=1` is the one
 * `EXCALIDRAW_*` the child gets, from `scripts/lib/spawn-canvas.mjs`, and it is there to stop
 * a stray `.env` configuring the board this check is asserting is unconfigured.
 *
 * Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the
 * built frontend.
 *
 * Usage: node scripts/check-first-run-browser.mjs [--chrome <path>] [--shots <dir>]
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-first-run-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
/** The home this board is told it has, and the only place it may keep state. */
const fakeHome = join(workDir, 'home');
/** The project a first-run reader would pick in the directory picker. */
const projectDir = join(workDir, 'projects', 'first-project');
for (const dir of [profileDir, shotDir, fakeHome, join(projectDir, 'docs')]) {
  mkdirSync(dir, { recursive: true });
}

/**
 * Where the registry has to appear, spelled out from the platform.
 *
 * The same three answers `stateDir()` gives — `Library/Application Support` on macOS,
 * `LOCALAPPDATA` on Windows, `XDG_STATE_HOME` on Linux — with the directory leaf the tool
 * writes today. Written out rather than imported on purpose: a check that asks the code under
 * test where it put the file agrees with any answer it gives.
 */
function conventionalRegistry() {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  if (process.platform === 'darwin') {
    return join(fakeHome, 'Library', 'Application Support', leaf, 'workspaces.json');
  }
  return join(fakeHome, leaf, 'workspaces.json');
}

const expectedRegistry = conventionalRegistry();

const children = [];
let log = '';

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

async function startBoard() {
  const server = startCanvas({
    port: await freePort(),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      // Every spelling of "where this user keeps things", so whichever one the platform
      // reads lands inside the temporary directory. `os.homedir()` reads `HOME` on POSIX and
      // `USERPROFILE` on Windows, and neither is an `EXCALIDRAW_*` the harness strips.
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

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
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

/** What the strip looks like from the reader's side, in one round trip. */
const stripState = () => evaluate(`(() => {
  const strip = document.querySelector('.workspace-tabs');
  const add = document.querySelector('.workspace-tabs__add');
  return {
    strip: Boolean(strip),
    add: Boolean(add),
    label: add ? (add.textContent || '').trim() : null,
    name: add ? add.getAttribute('aria-label') : null,
    visible: add ? add.getClientRects().length > 0 : false,
    tabs: [...document.querySelectorAll('.workspace-tab__name')].map((tab) => tab.textContent.trim()),
  };
})()`);

/** A real click, so nothing passes by calling a handler the reader could not reach. */
const click = (selector) => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`);

try {
  const board = await startBoard();

  console.log('1. a board with nothing configured is somewhere a project can be added');
  const listed = await call(board.base, '/api/workspaces');
  check('GET /api/workspaces answers', listed.status === 200, `got ${listed.status}`);
  check('it says the board is configured — the registry path always resolves now',
        listed.body?.configured === true, JSON.stringify(listed.body));
  check('and the list is empty', Array.isArray(listed.body?.workspaces) && listed.body.workspaces.length === 0,
        JSON.stringify(listed.body?.workspaces));
  check('starting the board wrote no registry — reading one that is not there is the empty one',
        !existsSync(expectedRegistry), expectedRegistry);
  const bareHealth = (await call(board.base, '/health')).body;
  check('/health still says this one has no projects, which is what tells a board from a scratch canvas',
        bareHealth?.workspaces === 'none', JSON.stringify(bareHealth?.workspaces));

  console.log('\n2. the tab strip is on screen with an empty list, and says what the control does');
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

  await send('Page.navigate', { url: board.base });
  const empty = await waitFor(async () => {
    const state = await stripState();
    return state.strip ? state : null;
  }, 'the tab strip on a board with no projects');
  await shot('01-empty-board');
  check('the strip renders rather than removing itself', empty.strip === true, JSON.stringify(empty));
  check('the control that adds a project is in the DOM', empty.add === true, JSON.stringify(empty));
  check('and on screen', empty.visible === true, JSON.stringify(empty));
  check('it reads "Add a project" rather than a bare +', /Add a project/i.test(empty.label ?? ''),
        JSON.stringify(empty.label));
  check('its accessible name says the same', empty.name === 'Add a project', JSON.stringify(empty.name));
  check('there are no tabs yet', empty.tabs.length === 0, JSON.stringify(empty.tabs));

  check('pressing it opens the Add-a-project dialog', await click('.workspace-tabs__add'));
  const dialog = await waitFor(
    () => evaluate(`Boolean(document.querySelector('.workspace-dialog__path'))`),
    'the Add-a-project dialog');
  await shot('02-dialog');
  check('the dialog a first-run reader needs is reachable from it', dialog === true);

  console.log('\n3. the first project is registered, at the path this platform keeps state in');
  const added = await call(board.base, '/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ path: slash(projectDir) }),
  });
  check('the POST succeeds', added.status === 201, `got ${added.status} ${JSON.stringify(added.body)}`);
  check('and the project it registered is the one that was named',
        added.body?.workspace?.id === 'first-project', JSON.stringify(added.body?.workspace));
  check('the registry file is at the conventional path for this platform', existsSync(expectedRegistry),
        expectedRegistry);
  const written = existsSync(expectedRegistry)
    ? JSON.parse(readFileSync(expectedRegistry, 'utf8'))
    : {};
  check('and it lists exactly the one project',
        (written.workspaces ?? []).length === 1 && written.workspaces[0].id === 'first-project',
        JSON.stringify(written));
  const afterHealth = (await call(board.base, '/health')).body;
  check('/health now reports a board rather than a scratch canvas',
        afterHealth?.workspaces === 'configured', JSON.stringify(afterHealth?.workspaces));

  console.log('\n4. and the strip shows it, with the control back to a plain +');
  await send('Page.navigate', { url: board.base });
  const filled = await waitFor(async () => {
    const state = await stripState();
    return state.tabs.length ? state : null;
  }, 'the new project on the strip');
  await shot('03-first-project');
  check('the project has a tab', filled.tabs.includes('first-project'), JSON.stringify(filled.tabs));
  check('the add control is still there', filled.add === true, JSON.stringify(filled));
  check('and it is the compact + again, now that the label has tabs to sit beside',
        filled.label === '+', JSON.stringify(filled.label));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(300);
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
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
