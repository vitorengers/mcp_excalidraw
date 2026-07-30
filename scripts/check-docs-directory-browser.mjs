#!/usr/bin/env node
/**
 * Checks, in a real browser, that the panel says which of the two things went wrong.
 *
 * `check-docs-directory.mjs` covers the route: a board with no docs directory answers with
 * a code of its own, and a missing file answers with another. None of that puts a word on
 * screen, and the word on screen is the whole defect — the panel mapped every 404 to one
 * state and threw the body away, so a board that was one setting away from working reported
 * `No document yet for <key>`, a per-document problem, and nothing pointed at the setting.
 * A panel that reads the new code and still prints the old sentence compiles perfectly.
 *
 * So the questions here are the ones only a browser answers. On a project with no docs
 * directory, does the card say that, and does it name where the folder is set? On a project
 * that has one, does a real document still render — so the new message cannot be the answer
 * to everything — and does a key with no file behind it still read as a missing document?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: throwaway registry and project directories, its own
 * canvas server, both killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-docs-directory-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── Two projects: one that can find its documents, one that cannot ───

const workDir = mkdtempSync(join(tmpdir(), 'check-docs-directory-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [profileDir, shotDir]) mkdirSync(dir, { recursive: true });

/** Registered with no `docsDir`, exactly as the `+` used to leave every project. */
const docless = join(workDir, 'docless-project');
mkdirSync(docless, { recursive: true });
writeFileSync(join(docless, 'board.config.json'), JSON.stringify({ name: 'Docless' }, null, 2), 'utf8');

/** Registered with one, and with a document actually in it. */
const docful = join(workDir, 'docful-project');
mkdirSync(join(docful, 'docs'), { recursive: true });
writeFileSync(join(docful, 'board.config.json'),
  JSON.stringify({ name: 'Docful', docsDir: 'docs' }, null, 2), 'utf8');
writeFileSync(join(docful, 'docs', 'sample-doc.md'),
  '# Sample doc\n\nThe reasoning behind the box.\n', 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'docless', path: slash(docless) },
    { id: 'docful', path: slash(docful) },
  ],
}, null, 2), 'utf8');

const PORT = 36800 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    // The fallback would serve this repository's own documents to a board that has none,
    // which is the case under test.
    EXCALIDRAW_DOCS_DIR: '',
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

/** A shape carrying a `docKey`, which is the only way documentation reaches a board. */
async function makeShape(workspace, docKey, text) {
  const response = await fetch(`${BASE}/api/elements?workspace=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 320, height: 120, text,
      customData: { docKey },
    }),
  });
  const body = await response.json().catch(() => ({}));
  return body?.element?.id ?? null;
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
        window.__docsCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const sceneHas = (id) => `(() => {
  const api = window.__docsCheckApi;
  if (!api) return false;
  return api.getSceneElements().some((element) => element.id === ${JSON.stringify(id)} && !element.isDeleted);
})()`;

const select = (id) =>
  `window.__docsCheckApi.updateScene({ appState: { selectedElementIds: ${JSON.stringify({ [id]: true })} } })`;

const clearSelection = 'window.__docsCheckApi.updateScene({ appState: { selectedElementIds: {} } })';

/**
 * What the card says, once it has something to say.
 *
 * The body rather than the whole card: the card's header is a close button that renders
 * before the fetch has landed, so reading the card itself answers `×` for a panel that has
 * not decided anything yet — and a check that accepts that is a check that races the fetch.
 */
const cardText = `(() => {
  const body = document.querySelector('.docs-card .element-docs');
  if (!body) return null;
  const text = (body.textContent || '').trim();
  if (!text || /Loading /.test(text)) return null;
  return text;
})()`;

async function textFor(id, what) {
  await evaluate(clearSelection);
  await sleep(150);
  await evaluate(select(id));
  return await waitFor(() => evaluate(cardText), `the card for ${what}`);
}

/** Open one board. Each project is its own page load, so nothing carries over. */
async function open(workspace) {
  await send('Page.navigate', { url: `${BASE}/?workspace=${workspace}` });
  await sleep(500);
  await waitFor(() => evaluate(GRAB_API), `the Excalidraw API handle on ${workspace}`);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const doclessShape = await makeShape('docless', 'sample-doc', 'A box with documentation');
  const docfulShape = await makeShape('docful', 'sample-doc', 'A box with documentation');
  const absentShape = await makeShape('docful', 'absent-doc', 'A box whose document is not written yet');
  if (!doclessShape || !docfulShape || !absentShape) {
    throw new Error(`the shapes were not created\n${serverLog}`);
  }

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    `${BASE}/?workspace=docless`,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(() => evaluate(sceneHas(doclessShape)), 'the shape to reach the board');

  console.log('1. on a board with no docs directory, the card says so');
  const docless = await textFor(doclessShape, 'the board with no docs directory');
  await shot('01-no-docs-directory');
  check('the card is on screen', typeof docless === 'string' && docless.length > 0, String(docless));
  check('it does not blame the document',
        !/No document yet/i.test(docless ?? ''),
        JSON.stringify(docless));
  check('it says the board has no docs directory',
        /docs directory/i.test(docless ?? ''), JSON.stringify(docless));
  check('and it names where the folder is set',
        /Docs folder/i.test(docless ?? '') && /project settings/i.test(docless ?? ''),
        JSON.stringify(docless));

  console.log('\n2. on a board that has one, a real document still renders');
  await open('docful');
  await waitFor(() => evaluate(sceneHas(docfulShape)), 'the shape to reach the second board');
  const loaded = await textFor(docfulShape, 'a document that exists');
  await shot('02-document-renders');
  check('the document is shown', /The reasoning behind the box/.test(loaded ?? ''),
        JSON.stringify(loaded));
  check('and the new message is not the answer to everything',
        !/docs directory/i.test(loaded ?? ''), JSON.stringify(loaded));

  console.log('\n3. and a key with no file behind it still reads as a missing document');
  const missing = await textFor(absentShape, 'a key with no file');
  await shot('03-missing-document');
  check('it says no document yet', /No document yet/i.test(missing ?? ''), JSON.stringify(missing));
  check('and names the key', /absent-doc/.test(missing ?? ''), JSON.stringify(missing));
  check('rather than blaming the directory',
        !/docs directory/i.test(missing ?? ''), JSON.stringify(missing));
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
