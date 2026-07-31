#!/usr/bin/env node
/**
 * Checks, in a real browser, that the Add-a-project dialog offers a path for the machine the
 * reader is standing on.
 *
 * `check-directory-roots.mjs` covers the two server halves: the roots a POSIX board offers,
 * and the `platform` `GET /health` now reports. Neither puts anything on screen, and the
 * screen is the whole defect — the typed-path field carried `C:/Users/me/Projects/thing`
 * unconditionally, so the only concrete example of a path this tool is ever given stated the
 * wrong syntax for two of its three platforms, on the first screen of the product. A dialog
 * that reads the new field and still renders the old string compiles perfectly.
 *
 * So the questions here are the ones only a browser answers. On a board reporting darwin,
 * does the field suggest a `/Users` path? On linux, a `/home` one? On win32, the `C:` string
 * it always had? And does the listing under it open on the home directory rather than on `/`,
 * which is the other half of the same screen and the only place it is visible?
 *
 * Each board is a real `dist/server.js` started from a launcher that rewrites
 * `process.platform` before importing it — Node's own modules have already chosen by then, so
 * what is simulated is exactly the decision under test: which platform the server reports, and
 * therefore which placeholder the page picks. The page is the built frontend either way.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: throwaway registry, project directory and launchers, three
 * canvas servers on ports the kernel just handed out, all killed at the end. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-directory-picker-placeholder-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const workDir = mkdtempSync(join(tmpdir(), 'check-picker-placeholder-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
/** Stands in for `/Users/me`: the home every one of these boards is told it has. */
const fakeHome = join(workDir, 'home');
const projectDir = join(fakeHome, 'projects', 'thing');
for (const dir of [profileDir, shotDir, projectDir]) mkdirSync(dir, { recursive: true });

writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({ name: 'thing' }, null, 2), 'utf8');

const registryPath = join(workDir, 'registry.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'thing', path: slash(projectDir) }],
}, null, 2), 'utf8');

/** What a reader on each platform should be shown as an example of a path. */
const EXPECTED = {
  win32: 'C:/Users/me/Projects/thing',
  darwin: '/Users/me/Projects/thing',
  linux: '/home/me/projects/thing',
};

const children = [];
let log = '';

function launcher(platform) {
  const server = join(repoRoot, 'dist', 'server.js');
  const file = join(workDir, `canvas-as-${platform}.mjs`);
  writeFileSync(file,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });\n`
    // `dist/server.js` only listens when it is the entry point (`isMainModule`).
    + `process.argv[1] = ${JSON.stringify(server)};\n`
    + `await import(${JSON.stringify(pathToFileURL(server).href)});\n`,
    'utf8');
  return file;
}

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

async function startBoard(platform) {
  const port = await freePort();
  const server = startCanvas({
    port,
    script: launcher(platform),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `board-${platform}.log`),
      // The pidfile and the log are chosen from the platform too, and the home directory is
      // half of what is being asserted: a board told it is a mac must not write into, or read,
      // the operator's real home.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
      EXCALIDRAW_WORKSPACES: registryPath,
    },
  });
  children.push(server.child);
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => (await fetch(`${server.base}/health`)).ok, `the ${platform} canvas server`);
  return server;
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

/** A real click, so nothing passes by calling a handler the reader could not reach. */
const click = (selector) => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`);

const placeholder = () => evaluate(
  `document.querySelector('.workspace-dialog__path')?.placeholder || null`);

const firstEntry = () => evaluate(
  `document.querySelector('.workspace-dialog__entry')?.textContent?.trim() || null`);

/**
 * Open one board, press the `+`, and wait for the dialog to have decided what to suggest.
 *
 * The placeholder is waited for rather than read straight away: it is the answer to a
 * request, and a check that reads it in the same tick asserts whatever the field was born
 * with. Waiting for a non-empty string is the honest form of that — a dialog that never
 * learns the platform times out here rather than passing on the default it started with.
 */
async function openPickerOn(base, platform) {
  await send('Page.navigate', { url: `${base}/?workspace=thing` });
  await sleep(600);
  await waitFor(() => click('.workspace-tabs__add'), `the + on the ${platform} board`);
  await waitFor(() => evaluate(`Boolean(document.querySelector('.workspace-dialog__path'))`),
                `the Add-a-project dialog on the ${platform} board`);
  const shown = await waitFor(placeholder, `a path placeholder on the ${platform} board`);
  await waitFor(firstEntry, `the root listing on the ${platform} board`);
  return shown;
}

try {
  const boards = {};
  for (const platform of ['darwin', 'linux', 'win32']) boards[platform] = await startBoard(platform);

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

  console.log('1. on a board reporting darwin, the example path is a mac one');
  const mac = await openPickerOn(boards.darwin.base, 'darwin');
  await shot('01-darwin');
  check('the placeholder is the darwin path', mac === EXPECTED.darwin, JSON.stringify(mac));
  check('and it is not the Windows one it always was', !/^[A-Z]:/.test(mac ?? ''), JSON.stringify(mac));
  check('the listing opens on the home directory rather than on /',
        (await firstEntry()) === slash(fakeHome), JSON.stringify(await firstEntry()));

  console.log('\n2. on a board reporting linux, it is a Linux one');
  const linux = await openPickerOn(boards.linux.base, 'linux');
  await shot('02-linux');
  check('the placeholder is the linux path', linux === EXPECTED.linux, JSON.stringify(linux));
  check('the listing opens on the home directory there too',
        (await firstEntry()) === slash(fakeHome), JSON.stringify(await firstEntry()));

  console.log('\n3. on a board reporting win32, it is the string it always was');
  const windows = await openPickerOn(boards.win32.base, 'win32');
  await shot('03-win32');
  check('the placeholder is unchanged on Windows', windows === EXPECTED.win32, JSON.stringify(windows));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
