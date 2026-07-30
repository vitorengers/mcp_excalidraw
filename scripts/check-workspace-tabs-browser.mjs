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
 * and switch to it, with no reload? Does the settings dialog on a tab write a name that the
 * strip then shows? And — since #196 — does the strip actually *reorder*, by drag and by the
 * keyboard alone, with the new order still there after a reload?
 *
 * The reorder half is here rather than in `check-workspace-reorder.mjs` for the reason the
 * rest of this file exists: that one proves the route permutes somebody else's registry
 * carefully, and a route nothing on screen can reach is half a feature. Tab order also
 * decides which board a cold start opens — `resolveInitialWorkspace` falls back to
 * `list[0].id` — so an order that looked right and was never written down would be a default
 * that changed back on the next reload.
 *
 * The chord is pressed as a **real key event** through the DevTools input pipeline, and the
 * tab it lands on is reached by pressing Tab from the top of the page, because "reachable
 * from the keyboard alone" is the one claim a `.focus()` in a script cannot make. The drag is
 * dispatched as real `DragEvent`s carrying one `DataTransfer` across the sequence: headless
 * Chrome will not synthesise an HTML5 drag from mouse movement, so this is as close to the
 * gesture as the protocol goes — which is why the keyboard path is the one that presses keys.
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
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

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

// ─── A registry with nothing in it yet ────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-workspace-tabs-'));
const projectsDir = join(workDir, 'projects');
const firstDir = join(projectsDir, 'first-project');
// Reordering needs something to reorder. Three, not two, so that a "move" cannot pass by
// swapping the only pair there is — with three, moving the last to the front and then one
// step right are two different orders, and a strip that merely reversed would fail the second.
const secondDir = join(projectsDir, 'second-project');
const thirdDir = join(projectsDir, 'third-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [firstDir, secondDir, thirdDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

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

/** The names on the strip, left to right — which is the thing being reordered. */
const names = () => evaluate(
  `[...document.querySelectorAll('.workspace-tab__name')].map((label) => label.textContent.trim())`);

/** The ids in the registry file, in file order. The strip's order has to be this one. */
const fileOrder = () => JSON.parse(readFileSync(registryPath, 'utf8'))
  .workspaces.map((entry) => entry.id);

/** What `GET /api/workspaces` says, asked from the page rather than from Node. */
const servedOrder = () => evaluate(
  `fetch('/api/workspaces').then((r) => r.json()).then((r) => (r.workspaces ?? []).map((w) => w.id))`);

/**
 * Add a project through the `+`, the path this file has already proved works.
 *
 * The submit is disabled until the field has a path in it, so the click waits for the button
 * rather than for the typing: a click on a disabled button is silently nothing, and the case
 * that failed would be the one three steps later.
 */
async function addProject(dir) {
  await click('.workspace-tabs__add');
  // The listing has to land *before* anything is typed: opening a folder is also how one is
  // chosen, so `browse()` writes the field — including the `browse('')` the dialog runs on
  // mount, which arrives a moment later and puts the field back to the roots. Typing first
  // and waiting afterwards is a race the field loses.
  await waitFor(() => dialogOpen('.workspace-dialog__entry'), `the directory listing for ${dir}`);
  await type('.workspace-dialog__path', slash(dir));
  await waitFor(
    () => evaluate(`document.querySelector('.workspace-dialog__submit')?.disabled === false`),
    `the add dialog to accept the path for ${dir}`);
  await click('.workspace-dialog__submit');
  // Polled by hand rather than through `waitFor`, which swallows what it catches: a refusal
  // is shown *in* the dialog, so the dialog staying open is the symptom and the text in it is
  // the reason. Timing out without reading it would report the symptom alone.
  for (let attempt = 0; attempt < 120; attempt++) {
    if (!(await dialogOpen('.workspace-dialog'))) return;
    const said = await evaluate(`document.querySelector('.workspace-dialog__error')?.textContent ?? null`);
    if (said) throw new Error(`the board refused ${dir}: ${said}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for the add dialog to close for ${dir}`);
}

// ─── Real key presses ─────────────────────────────────────────

/** CDP's modifier bits. Alt is 1 and Meta 4; neither is wanted here. */
const CTRL = 2;
const SHIFT = 8;

async function press(key, { code = key, keyCode, modifiers = 0 } = {}) {
  const common = { key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...common });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/** Which tab, if any, the caret is on — by name, so it survives the strip being reordered. */
const focusedTab = () => evaluate(`(() => {
  const active = document.activeElement;
  if (!active || !active.classList.contains('workspace-tab__select')) return null;
  return active.querySelector('.workspace-tab__name')?.textContent?.trim() ?? null;
})()`);

/**
 * One HTML5 drag, as three events sharing one `DataTransfer`.
 *
 * Split across awaits on purpose: `dragstart` sets React state that `dragover` and `drop`
 * both read, and firing all three in one turn would test a component that never re-rendered.
 */
async function drag(fromIndex, toIndex) {
  const started = await evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.workspace-tab')];
    const from = tabs[${fromIndex}], to = tabs[${toIndex}];
    if (!from || !to) return false;
    const transfer = new DataTransfer();
    window.__drag = {
      from, to,
      fire: (element, type) => element.dispatchEvent(
        new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })),
    };
    window.__drag.fire(from, 'dragstart');
    return true;
  })()`);
  if (!started) return false;
  await sleep(120);
  await evaluate(`window.__drag.fire(window.__drag.to, 'dragover')`);
  await sleep(120);
  // Mid-gesture, which is the only moment the carried tab and the insertion marker are both
  // on screen. Compiling is not working, and neither is passing: this is the frame a person
  // has to be able to read.
  await shot('09-mid-drag');
  await evaluate(`window.__drag.fire(window.__drag.to, 'drop')`);
  await evaluate(`window.__drag.fire(window.__drag.from, 'dragend')`);
  return true;
}

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
  check('the settings dialog is on screen', settings);
  // The dialog is on screen before its `GET .../config` lands — it opens saying "Reading
  // board.config.json…" and renders the form when the answer arrives. Waiting for the shell
  // and typing straight away therefore types into nothing, silently: `type()` returns false
  // and no case reads it, so the save that follows sends an empty edit and the strip never
  // takes the new name. It was the *dialog* that was being waited for; it is the *form* that
  // has to be there.
  await waitFor(() => dialogOpen('.workspace-config__field[data-field="name"]'),
                'the settings form to be filled in from disk');
  await shot('05-settings');
  await type('.workspace-config__field[data-field="name"]', 'First Project');
  await type('.workspace-config__field[data-field="repo"]', 'vitorengers/first');
  await type('.workspace-config__field[data-field="projectTodoColumn"]', 'Ready');
  await type('.workspace-config__field[data-field="agents.implement.model"]', 'claude-opus-5');
  await shot('06-settings-filled');
  // Asserted rather than assumed: `type()` on a field that is not there returns false, and a
  // save of nothing looks exactly like a save that worked until the strip fails to rename.
  check('the form actually took what was typed',
        (await evaluate(`document.querySelector('.workspace-config__field[data-field="name"]')?.value ?? null`))
          === 'First Project');
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

  console.log('\n5. two more projects, so there is an order to have');
  await addProject(secondDir);
  await addProject(thirdDir);
  const three = await waitFor(async () => {
    const listing = await names();
    return listing.length === 3 ? listing : null;
  }, 'three tabs on the strip');
  await shot('08-three-tabs');
  check('the strip has all three, in the order they were added',
        JSON.stringify(three) === JSON.stringify(['First Project', 'second-project', 'third-project']),
        JSON.stringify(three));
  check('and the registry agrees',
        JSON.stringify(fileOrder()) === JSON.stringify(['first-project', 'second-project', 'third-project']),
        JSON.stringify(fileOrder()));

  console.log('\n6. dragging a tab reorders the strip, and the registry follows');
  check('the drag started on a tab that is there', await drag(2, 0));
  const dragged = await waitFor(async () => {
    const listing = await names();
    return listing[0] === 'third-project' ? listing : null;
  }, 'the dragged tab to arrive at the front');
  await shot('09b-dropped');
  check('the tab that was dragged is now first',
        JSON.stringify(dragged) === JSON.stringify(['third-project', 'First Project', 'second-project']),
        JSON.stringify(dragged));
  const draggedOnDisk = await waitFor(
    async () => (fileOrder()[0] === 'third-project' ? fileOrder() : null),
    'the registry to be written');
  check('and the registry was written, not just the screen',
        JSON.stringify(draggedOnDisk) === JSON.stringify(['third-project', 'first-project', 'second-project']),
        JSON.stringify(draggedOnDisk));
  check('GET /api/workspaces answers in the new order',
        JSON.stringify(await servedOrder())
          === JSON.stringify(['third-project', 'first-project', 'second-project']),
        JSON.stringify(await servedOrder()));
  check('nothing reloaded to get there',
        (await evaluate('window.__noReloadSentinel')) === 'still here');

  console.log('\n7. and it is reachable from the keyboard alone');
  // From the top of the page, by pressing Tab — not by a `.focus()` in a script, which would
  // prove the handler and say nothing about whether anyone can reach it.
  await evaluate('document.activeElement?.blur?.(); window.focus()');
  let presses = 0;
  let onTab = null;
  while (presses < 15 && !onTab) {
    await press('Tab', { keyCode: 9 });
    presses++;
    onTab = await focusedTab();
  }
  check('Tab from the top of the page reaches a tab', Boolean(onTab), `${presses} press(es), focus on ${onTab}`);
  check('and it is the first one, which is the one that was just dragged there',
        onTab === 'third-project', String(onTab));

  await press('ArrowRight', { keyCode: 39, modifiers: CTRL | SHIFT });
  const moved = await waitFor(async () => {
    const listing = await names();
    return listing[0] === 'First Project' ? listing : null;
  }, 'the focused tab to move one to the right');
  await shot('10-keyboard-moved');
  check('Ctrl+Shift+Right moves the focused tab one place right',
        JSON.stringify(moved) === JSON.stringify(['First Project', 'third-project', 'second-project']),
        JSON.stringify(moved));
  check('focus stayed on the tab that moved, so a second press carries it further',
        (await focusedTab()) === 'third-project', String(await focusedTab()));
  const keyedOnDisk = await waitFor(
    async () => (fileOrder()[1] === 'third-project' ? fileOrder() : null),
    'the registry to be written after the chord');
  check('and the keyboard wrote the registry too, not only the drag',
        JSON.stringify(keyedOnDisk) === JSON.stringify(['first-project', 'third-project', 'second-project']),
        JSON.stringify(keyedOnDisk));

  console.log('\n8. the order is still there after a reload');
  await send('Page.reload', { ignoreCache: false });
  await waitFor(async () => {
    const listing = await names();
    return listing.length === 3 ? listing : null;
  }, 'the strip after the reload');
  const reloaded = await names();
  await shot('11-after-reload');
  check('the strip comes back in the order it was left in',
        JSON.stringify(reloaded) === JSON.stringify(['First Project', 'third-project', 'second-project']),
        JSON.stringify(reloaded));
  check('the page really did reload',
        (await evaluate('window.__noReloadSentinel ?? null')) === null,
        'the sentinel survived, so nothing reloaded and this case proves nothing');
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
