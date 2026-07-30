#!/usr/bin/env node
/**
 * Checks that one board's terminal block does not decide where another board's goes.
 *
 * `nextTerminalId` counts from 1 per board, so the first shell of *every* board is called
 * `s1`. The browser cached where a block was — and what grid its shells had been told —
 * under the bare session id, with no board in the key. The restore path that puts an
 * erased block back where it was (#93/#98) then completes the leak by itself: switching
 * boards takes the old board's blocks off the scene, which reads as erased, and the shell
 * of the board being switched *to* is also `s1`, so the restore looks `s1` up, finds where
 * the reader had dragged the other project's terminal, and puts this project's block there
 * (#156).
 *
 * Only a browser can answer it. The block is a scene element the page derives — it is
 * never synced, so no board's element store has ever held one — the restore is a timer
 * inside the page, and "where the block ended up" is geometry on a mounted canvas. What
 * *is* visible from outside is the consequence: a shell is told the grid its block stands
 * for, so a block placed at the wrong size means a shell running at the wrong size, and
 * `GET /api/terminal` reports that per board.
 *
 * The move and the resize are made through the scene rather than by dragging the block's
 * frame: the drag itself is `check-terminal-browser.mjs`, and what this check is about is
 * what a *switch* does with the geometry a drag leaves behind.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server, both
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-workspace-isolation-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

/** Where the reader drags Alpha's block, and how small they make it. Nothing like a default. */
const DRAGGED = { x: 2400, y: 1600, width: 700, height: 420 };
/** Longer than TERMINAL_RESTORE_DELAY_MS (250 ms), with room for the reconcile behind it. */
const SETTLE_MS = 2500;

// ─── Two projects, each with a terminal ───────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-workspace-'));
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
// No githubProject on either: the mirror stays dormant, so the terminal block is the only
// thing either board is placing.
writeFileSync(join(alphaDir, 'board.config.json'),
              JSON.stringify({ name: 'Alpha', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
writeFileSync(join(betaDir, 'board.config.json'),
              JSON.stringify({ name: 'Beta', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: '1',
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

/** One board's sessions, as the *server* has them — not as the browser hoped. */
const sessionsOf = async (workspace) => {
  const response = await fetch(`${BASE}/api/terminal?workspace=${workspace}`);
  return (await response.json())?.sessions ?? [];
};

/** One board's stored elements. A terminal block is derived, so none should ever be here. */
const storedOf = async (workspace) => {
  const response = await fetch(`${BASE}/api/elements?workspace=${workspace}`);
  return (await response.json())?.elements ?? [];
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

/** The imperative API, through the container's React fibre. See check-terminal-browser. */
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
        window.__terminalBoardApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__terminalBoardApi;
  if (!api) return { error: 'no api handle' };
  const blocks = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind !== 'terminal') continue;
    blocks.push({
      id: element.id, x: element.x, y: element.y,
      width: element.width, height: element.height,
      sessions: custom.sessions || [],
    });
  }
  return {
    blocks,
    active: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
  };
})()`;

/** Move and resize the block, as a drag and a corner drag leave it. */
const placeBlock = (id, at) => evaluate(`(() => {
  const api = window.__terminalBoardApi;
  const elements = api.getSceneElements().map((element) => (
    element.id === ${JSON.stringify(id)}
      ? { ...element, x: ${at.x}, y: ${at.y}, width: ${at.width}, height: ${at.height}, versionNonce: element.versionNonce + 1 }
      : element
  ));
  api.updateScene({ elements });
  return true;
})()`);

/** Click the tab with this name on it — the gesture the whole issue is about. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

/** Wait for the board named to be in front with exactly one terminal block on it. */
const blockOn = (name) => waitFor(async () => {
  const probe = await evaluate(PROBE);
  if (!probe || probe.error) return null;
  if (!new RegExp(name).test(probe.active ?? '')) return null;
  return probe.blocks.length === 1 ? probe.blocks[0] : null;
}, `one terminal block on ${name}`);

const near = (value, expected, tolerance = 2) => Math.abs(value - expected) <= tolerance;
const at = (block, box) => near(block.x, box.x) && near(block.y, box.y)
  && near(block.width, box.width) && near(block.height, box.height);
const show = (block) => `${Math.round(block.x)},${Math.round(block.y)} ${Math.round(block.width)}×${Math.round(block.height)}`;

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

  console.log('1. Alpha opens a shell, and the reader drags its block somewhere of their own');
  const alphaBlock = await blockOn('Alpha');
  check('Alpha has a terminal block', Boolean(alphaBlock), JSON.stringify(alphaBlock));
  check('with a shell in it', (alphaBlock.sessions ?? []).length === 1, JSON.stringify(alphaBlock.sessions));
  check('and it is the first shell of that board, called s1',
        alphaBlock.sessions[0] === 's1', String(alphaBlock.sessions[0]));

  await placeBlock(alphaBlock.id, DRAGGED);
  await sleep(SETTLE_MS);
  let probe = await evaluate(PROBE);
  await shot('01-alpha-dragged');
  check('the block took the position and size it was given', at(probe.blocks[0], DRAGGED),
        show(probe.blocks[0]));
  const alphaSessions = await sessionsOf(ALPHA);
  check('and its shell was told the grid that block stands for',
        alphaSessions.length === 1 && alphaSessions[0].cols > 0 && alphaSessions[0].rows > 0,
        JSON.stringify(alphaSessions.map((session) => ({ id: session.id, cols: session.cols, rows: session.rows }))));
  const alphaGrid = { cols: alphaSessions[0].cols, rows: alphaSessions[0].rows };

  console.log('\n2. Beta opens its own shell — also called s1 — and it gets its own block');
  check('Beta has a tab to click', await selectTab('Beta'));
  const betaBlock = await blockOn('Beta');
  await sleep(SETTLE_MS);
  probe = await evaluate(PROBE);
  await shot('02-beta-first-visit');
  check('Beta has exactly one terminal block', probe.blocks.length === 1,
        JSON.stringify(probe.blocks.map(show)));
  check('whose shell is Beta\'s own s1, not Alpha\'s',
        probe.blocks[0].sessions[0] === 's1', JSON.stringify(probe.blocks[0].sessions));
  check('and it is not standing where the reader dragged Alpha\'s',
        !at(probe.blocks[0], DRAGGED),
        `Beta's block is at ${show(probe.blocks[0])}, which is where Alpha's was dragged to`);
  // Against Alpha's block as it was *before* the drag rather than against a constant: since
  // #199 the default is a grid, and what rectangle 125 × 30 comes to depends on the cell this
  // page measured. The two boards are the same page, so they are the same rectangle — which is
  // the question here anyway, "did this board get a fresh one".
  check('it is a block placed for this board, at the size a fresh one gets',
        near(probe.blocks[0].width, alphaBlock.width, 4)
        && near(probe.blocks[0].height, alphaBlock.height, 4),
        `${show(probe.blocks[0])}, against Alpha's fresh ${alphaBlock.width}×${alphaBlock.height}`);

  const betaSessions = await sessionsOf(BETA);
  check('Beta has one shell of its own', betaSessions.length === 1,
        JSON.stringify(betaSessions.map((session) => session.id)));
  check('and it was told a grid for Beta\'s block, not for Alpha\'s',
        betaSessions[0].cols > alphaGrid.cols && betaSessions[0].rows > alphaGrid.rows,
        `Alpha ${alphaGrid.cols}×${alphaGrid.rows}, Beta ${betaSessions[0].cols}×${betaSessions[0].rows}`);
  check('Alpha\'s shell was not resized by any of this',
        (await sessionsOf(ALPHA))[0]?.cols === alphaGrid.cols,
        JSON.stringify(await sessionsOf(ALPHA)));

  console.log('\n3. neither board\'s store holds a block, because the block is derived');
  check('Alpha\'s store has no terminal block',
        (await storedOf(ALPHA)).every((element) => element.customData?.kind !== 'terminal'));
  check('Beta\'s store has no terminal block',
        (await storedOf(BETA)).every((element) => element.customData?.kind !== 'terminal'));

  console.log('\n4. and Alpha\'s block is still where the reader put it');
  check('Alpha has a tab to click', await selectTab('Alpha'));
  await blockOn('Alpha');
  await sleep(SETTLE_MS);
  probe = await evaluate(PROBE);
  await shot('03-alpha-returned');
  check('Alpha still has one block', probe.blocks.length === 1, JSON.stringify(probe.blocks.map(show)));
  check('and it came back where it was dragged to', at(probe.blocks[0], DRAGGED), show(probe.blocks[0]));
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
