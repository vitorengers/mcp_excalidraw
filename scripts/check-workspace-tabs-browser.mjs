#!/usr/bin/env node
/**
 * Checks the `+` and the project settings in a real browser.
 *
 * `check-workspace-create.mjs` and `check-workspace-settings.mjs` cover the routes. None
 * of that puts a button on screen, and the button is half the feature: the tab strip used
 * to render nothing at all for an empty list, so a board whose registry had no projects
 * yet could never bootstrap its first one — and a `+` that renders but never opens its
 * dialog, or a dialog that adds a project without the strip noticing, compiles perfectly.
 *
 * This repository has already paid for that three times, and `docs/project-board.md`
 * records a browser check that read a stale `dist/frontend` and believed it. So the
 * questions here are the ones only a browser can answer. Is the `+` on the strip when the
 * strip is otherwise empty? Does clicking it open the dialog? Does completing it add a tab
 * and switch to it, with no reload? And does the settings dialog on a tab write a name
 * that the strip then shows?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: throwaway registry and project directories, its
 * own canvas server, both killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-workspace-tabs-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── A registry with nothing in it yet ────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-workspace-tabs-'));
const projectsDir = join(workDir, 'projects');
const firstDir = join(projectsDir, 'first-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [firstDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({ workspaces: [] }, null, 2), 'utf8');

const PORT = 36400 + (process.pid % 200);
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
 * Type into a controlled input the way React hears it.
 *
 * Assigning `.value` alone updates the DOM and tells React nothing, so the component's
 * state stays empty and the submit sends an empty path.
 */
const type = (selector, value) => evaluate(`(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

const strip = () => evaluate(`(() => {
  const bar = document.querySelector('.workspace-tabs');
  return {
    present: Boolean(bar),
    add: Boolean(document.querySelector('.workspace-tabs__add')),
    tabs: [...document.querySelectorAll('.workspace-tab')].map((tab) => tab.textContent.trim()),
    active: document.querySelector('.workspace-tab--active')?.textContent?.trim() ?? null,
  };
})()`);

const dialogOpen = (selector) => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);

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

  console.log('1. the strip is there with the + on it, even with no projects at all');
  const empty = await waitFor(async () => {
    const state = await strip();
    return state.present ? state : null;
  }, 'the workspace tab strip');
  await shot('01-empty-strip');
  check('the strip renders for an empty registry', empty.present, JSON.stringify(empty));
  check('the + is on it', empty.add, JSON.stringify(empty));
  check('and there are no tabs yet', empty.tabs.length === 0, JSON.stringify(empty.tabs));

  console.log('\n2. clicking it opens the dialog');
  // A sentinel that only survives if the page is never reloaded.
  await evaluate('window.__noReloadSentinel = "still here"');
  check('the + is clickable', await click('.workspace-tabs__add'));
  const opened = await waitFor(() => dialogOpen('.workspace-dialog'), 'the add-a-project dialog');
  await shot('02-dialog');
  check('the dialog is on screen', opened);
  const browsable = await waitFor(
    async () => await evaluate(`document.querySelectorAll('.workspace-dialog__entry').length > 0`),
    'the server-side directory listing');
  check('and it lists directories the server can see, because the browser cannot', browsable);

  const where = () => evaluate(`document.querySelector('.workspace-dialog__where')?.textContent ?? null`);
  const startedAt = await where();
  check('it says where it is looking', typeof startedAt === 'string', String(startedAt));
  // Walking the listing is the gesture the picker exists for, and it is the half a typed
  // path never exercises.
  check('a listed directory can be opened',
        await evaluate(`(() => {
          const entry = [...document.querySelectorAll('.workspace-dialog__entry')]
            .find((button) => !button.classList.contains('workspace-dialog__entry--up'));
          if (!entry) return false;
          entry.click();
          return true;
        })()`));
  const walkedIn = await waitFor(async () => {
    const now = await where();
    return now && now !== startedAt ? now : null;
  }, 'the listing to move into the directory that was clicked');
  check('and the listing follows it in', walkedIn !== startedAt, `${startedAt} → ${walkedIn}`);
  check('with a way back up', await evaluate(`Boolean(document.querySelector('.workspace-dialog__entry--up'))`));

  console.log('\n3. completing it adds a tab and switches to it, with no reload');
  await type('.workspace-dialog__path', slash(firstDir));
  await shot('03-path-typed');
  check('the dialog accepts a path', await click('.workspace-dialog__submit'));
  const added = await waitFor(async () => {
    const state = await strip();
    return state.tabs.length === 1 ? state : null;
  }, 'the new tab to appear');
  await shot('04-tab-added');
  check('a tab appeared for it', added.tabs.length === 1, JSON.stringify(added.tabs));
  check('it names the project', /first-project/i.test(added.tabs[0] ?? ''), JSON.stringify(added.tabs));
  check('and the board switched to it', /first-project/i.test(added.active ?? ''), JSON.stringify(added.active));
  check('the dialog closed', !(await dialogOpen('.workspace-dialog')));
  check('nothing reloaded the page',
        (await evaluate('window.__noReloadSentinel')) === 'still here',
        'the sentinel is gone, so the tab arrived by reload rather than by state');
  check('the + is still on the strip', added.add, JSON.stringify(added));

  console.log('\n4. the tab carries a settings surface, and it writes the project config');
  check('the settings control is reachable', await click('.workspace-tab__config'));
  const settings = await waitFor(() => dialogOpen('.workspace-config'), 'the project settings dialog');
  await shot('05-settings');
  check('the settings dialog is on screen', settings);
  await type('.workspace-config__field[data-field="name"]', 'First Project');
  await type('.workspace-config__field[data-field="repo"]', 'vitorengers/first');
  await type('.workspace-config__field[data-field="projectTodoColumn"]', 'Ready');
  await type('.workspace-config__field[data-field="agents.implement.model"]', 'claude-opus-5');
  await shot('06-settings-filled');
  check('the settings can be saved', await click('.workspace-config__save'));

  const renamed = await waitFor(async () => {
    const state = await strip();
    return /First Project/.test(state.active ?? '') ? state : null;
  }, 'the tab to take the new name');
  await shot('07-renamed');
  check('the strip shows the new name', /First Project/.test(renamed.active ?? ''),
        JSON.stringify(renamed.tabs));
  check('and nothing reloaded to get there',
        (await evaluate('window.__noReloadSentinel')) === 'still here');

  const onDisk = JSON.parse(readFileSync(join(firstDir, 'board.config.json'), 'utf8'));
  check('the project config on disk has the name', onDisk.name === 'First Project', JSON.stringify(onDisk));
  check('and the repository', onDisk.repo === 'vitorengers/first', JSON.stringify(onDisk));
  check('and the column a researched issue is moved to',
        onDisk.projectTodoColumn === 'Ready', JSON.stringify(onDisk));
  check('and the per-project agent model the observation asked for',
        onDisk.agents?.implement?.model === 'claude-opus-5', JSON.stringify(onDisk.agents));
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
