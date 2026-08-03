#!/usr/bin/env node
/**
 * Checks the surface a person opens when they ask "who can reach my board".
 *
 * `check-device-management.mjs` holds the routes and `check-device-revoke-socket.mjs` holds the
 * socket. Neither says anything about the thing an operator actually uses, and that half
 * compiles exactly as well when it does nothing: a dialog that never opens, a Rename that
 * posts and never redraws, a Revoke whose confirmation names the wrong device. So this drives
 * a real Chrome.
 *
 * What it holds, and each one is a way the surface can be wrong while the API is right:
 *
 *  - the control is **on the bar of a board with no project registered at all**, which is the
 *    state a fresh clone is in and the state the gear it sits beside is not drawn in;
 *  - the list shows the four things a person cannot judge a device without — the name, when it
 *    was last seen, when it was approved, and the address and `Host` it was approved for;
 *  - a **rename lands on disk**, because a field that edits a row and posts nothing looks
 *    identical for as long as the dialog stays open;
 *  - a **revoke asks first, names the device it is about to remove**, and then removes it —
 *    from the list on screen and from the registry;
 *  - and the last device leaving the list says so in words rather than leaving an empty panel,
 *    which is the screen a reader is most likely to mistake for a broken one.
 *
 * The board is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME` and the
 * registry is seeded inside it: there is no pairing exchange yet (#503), and the file is the
 * whole of what the server reads either way. The board runs behind the ordinary opt-out every
 * check in this directory is behind, so the page is the **host** — which is the caller this
 * surface is for.
 *
 * Self-contained: a canvas server on a port the kernel just handed out, one headless Chrome,
 * both killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-devices-panel-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
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

const workDir = mkdtempSync(join(tmpdir(), 'check-devices-panel-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const fakeHome = join(workDir, 'home');
for (const dir of [profileDir, shotDir, fakeHome]) mkdirSync(dir, { recursive: true });

/** Where this board keeps its runtime state, spelled out from the platform rather than imported. */
function stateDir() {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf);
}

const registryFile = join(stateDir(), 'devices.json');

const record = (id, name, extra) => ({
  id,
  name,
  secretHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
  createdAt: '2026-06-01T09:00:00.000Z',
  lastSeenAt: '2026-06-02T09:00:00.000Z',
  ...extra,
});

const seeded = [
  record('dev-laptop', 'MacBook-Pro-3', { approvedFrom: '192.168.1.44', host: 'board.lan:3737' }),
  record('dev-phone', 'Pixel-9', { approvedFrom: '192.168.1.91', host: 'desk.local:3737' }),
];

const onDisk = () => {
  try { return JSON.parse(readFileSync(registryFile, 'utf8')).devices ?? null; } catch { return null; }
};

const children = [];
let log = '';

async function waitFor(fn, what, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
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

/**
 * Press a control by its selector, in the page.
 *
 * `element.click()` rather than a synthesised mouse event at a coordinate: this whole surface
 * is ordinary DOM above the canvas, so there is no Excalidraw hit-testing to satisfy and
 * nothing to be occluded by. The coordinate traps the canvas checks live with — a properties
 * island over the point, a viewport that scrolled — do not apply, and inviting them in would
 * be inventing a way for this check to be flaky.
 */
const press = (selector) => evaluate(`(() => {
  const target = document.querySelector(${JSON.stringify(selector)});
  if (!target) return false;
  target.click();
  return true;
})()`);

/** Type into a React-controlled field, which is not what setting `.value` does. */
const type = (selector, value) => evaluate(`(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/** The dialog as the reader has it: the rows, and what each one says. */
const panel = () => evaluate(`(() => {
  const dialog = document.querySelector('.devices-dialog');
  if (!dialog) return { open: false };
  const fact = (row, name) => {
    const found = row.querySelector('[data-fact="' + name + '"]');
    return found ? found.textContent.trim() : null;
  };
  return {
    open: true,
    empty: dialog.querySelector('.devices-dialog__empty')?.textContent?.trim() ?? null,
    said: dialog.querySelector('.devices-dialog__said')?.textContent?.trim() ?? null,
    warn: dialog.querySelector('.devices-dialog__warn')?.textContent?.trim() ?? null,
    rows: Array.from(dialog.querySelectorAll('.devices-dialog__row')).map((row) => ({
      id: row.getAttribute('data-device'),
      name: row.querySelector('.devices-dialog__name')?.textContent?.trim() ?? null,
      lastSeen: fact(row, 'lastSeen'),
      approved: fact(row, 'approved'),
      from: fact(row, 'approvedFrom'),
      host: fact(row, 'host'),
    })),
  };
})()`);

try {
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, JSON.stringify({ version: 1, devices: seeded }, null, 2), 'utf8');

  const server = startCanvas({
    port: await freePort(),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
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

  const cdpPort = await freePort();
  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,1000',
    'about:blank',
  ], { stdio: 'ignore' }));
  await attach(cdpPort);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: server.base });

  // ─── 1. The control is there, on a board with no project ────

  console.log('1. a board with no project registered still offers the list');
  await waitFor(() => evaluate(`!!document.querySelector('.header')`), 'the header to render');
  const noProjects = await evaluate(`document.querySelectorAll('.workspace-tab').length`);
  check('this board has no project registered, which is a fresh clone', noProjects === 0,
        `${noProjects} tab(s)`);
  check('and there is no project gear to hang the list off',
        await evaluate(`!document.querySelector('.workspace-tab__config')`));
  const control = await waitFor(() => evaluate(`(() => {
    const button = document.querySelector('.devices-button');
    return button ? button.textContent.trim() : null;
  })()`), 'the Devices control on the bar');
  check('the bar carries a control that opens it', control === 'Devices', JSON.stringify(control));
  await shot('01-bar');

  // ─── 2. What the list says about a device ───────────────────

  console.log('\n2. the list says what a person needs to judge a device by');
  check('the control presses', await press('.devices-button'));
  const opened = await waitFor(async () => {
    const state = await panel();
    return state.open && state.rows.length === 2 ? state : null;
  }, 'the device list to be drawn');
  await shot('02-list');

  check('both paired devices are listed', opened.rows.length === 2,
        JSON.stringify(opened.rows.map((row) => row.name)));
  const laptop = opened.rows.find((row) => row.id === 'dev-laptop') ?? {};
  check('under the name the registry holds', laptop.name === 'MacBook-Pro-3',
        JSON.stringify(laptop.name));
  check('with when it was last seen, in words rather than an ISO string',
        typeof laptop.lastSeen === 'string' && laptop.lastSeen.length > 0 && !laptop.lastSeen.includes('T'),
        JSON.stringify(laptop.lastSeen));
  check('and when it was approved', typeof laptop.approved === 'string' && laptop.approved.length > 0,
        JSON.stringify(laptop.approved));
  check('the address it was approved from, verbatim', laptop.from === '192.168.1.44',
        JSON.stringify(laptop.from));
  check('and the Host it was approved for', laptop.host === 'board.lan:3737',
        JSON.stringify(laptop.host));
  check('a second device shows its own Host rather than the first one\'s',
        opened.rows.find((row) => row.id === 'dev-phone')?.host === 'desk.local:3737',
        JSON.stringify(opened.rows.find((row) => row.id === 'dev-phone')?.host));

  // ─── 3. The rename, which has to reach the file ─────────────

  console.log('\n3. the name is editable here, and the edit lands on disk');
  check('a row offers to rename its device',
        await press('[data-device="dev-laptop"] .devices-dialog__rename'));
  await waitFor(() => evaluate(`!!document.querySelector('[data-device="dev-laptop"] [data-field="name"]')`),
                'the name field');
  check('the field opens holding the name it is replacing',
        await evaluate(`document.querySelector('[data-device="dev-laptop"] [data-field="name"]').value`)
          === 'MacBook-Pro-3');
  await type('[data-device="dev-laptop"] [data-field="name"]', "Ana's laptop");
  await shot('03-renaming');
  check('and Save presses', await press('[data-device="dev-laptop"] .devices-dialog__save'));

  const renamed = await waitFor(async () => {
    const state = await panel();
    return state.rows.find((row) => row.id === 'dev-laptop')?.name === "Ana's laptop" ? state : null;
  }, 'the row to be redrawn under the new name');
  check('the row is redrawn under the new name', renamed.rows.length === 2);
  check('and the registry on disk says so, so this was not only on screen',
        (onDisk() ?? []).find((entry) => entry.id === 'dev-laptop')?.name === "Ana's laptop",
        JSON.stringify((onDisk() ?? []).map((entry) => entry.name)));
  await shot('04-renamed');

  // ─── 4. The revoke, which asks first ────────────────────────

  console.log('\n4. revoking asks first, and names the device it is about to remove');
  check('Revoke presses', await press('[data-device="dev-phone"] .devices-dialog__revoke'));
  const asking = await waitFor(async () => {
    const state = await panel();
    return state.warn ? state : null;
  }, 'the confirmation');
  check('the confirmation names the device rather than asking "are you sure"',
        asking.warn.includes('Pixel-9'), JSON.stringify(asking.warn));
  check('and says when the loss of access takes effect', /next request/i.test(asking.warn),
        JSON.stringify(asking.warn));
  check('nothing is revoked by the asking', (onDisk() ?? []).length === 2,
        JSON.stringify((onDisk() ?? []).map((entry) => entry.id)));
  await shot('05-confirming');

  check('the second press goes through',
        await press('[data-device="dev-phone"] .devices-dialog__revoke--go'));
  const revoked = await waitFor(async () => {
    const state = await panel();
    return state.rows.length === 1 ? state : null;
  }, 'the row to leave the list');
  check('the row is gone from the list', revoked.rows.every((row) => row.id !== 'dev-phone'));
  check('and so is the record', (onDisk() ?? []).every((entry) => entry.id !== 'dev-phone'),
        JSON.stringify((onDisk() ?? []).map((entry) => entry.id)));
  check('the dialog says what happened, because the row that would have said it is gone',
        typeof revoked.said === 'string' && revoked.said.includes('Pixel-9'),
        JSON.stringify(revoked.said));
  await shot('06-revoked');

  // ─── 5. An empty list is a sentence, not a blank panel ──────

  console.log('\n5. the last device leaving says so in words');
  await press('[data-device="dev-laptop"] .devices-dialog__revoke');
  await waitFor(() => panel().then((state) => state.warn), 'the second confirmation');
  await press('[data-device="dev-laptop"] .devices-dialog__revoke--go');
  const empty = await waitFor(async () => {
    const state = await panel();
    return state.rows.length === 0 ? state : null;
  }, 'the list to empty');
  check('an empty list says no device has been paired rather than showing nothing',
        typeof empty.empty === 'string' && /no device/i.test(empty.empty), JSON.stringify(empty.empty));
  check('and says where to read about it', /devices\.md/.test(empty.empty ?? ''),
        JSON.stringify(empty.empty));
  check('the registry on disk is empty too', (onDisk() ?? ['not read']).length === 0,
        JSON.stringify(onDisk()));
  await shot('07-empty');

  // ─── 6. It closes ───────────────────────────────────────────

  console.log('\n6. Escape closes it, like every other dialog on this bar');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const closed = await waitFor(async () => {
    const state = await panel();
    return state.open === false ? state : null;
  }, 'the dialog to close');
  check('the dialog is closed', closed.open === false);
  check('and the board is still behind it',
        await evaluate(`!!document.querySelector('.devices-button')`));
  await shot('08-closed');
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
