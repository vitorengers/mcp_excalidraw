#!/usr/bin/env node
/**
 * Checks the surface a person opens when they ask "who can reach my board", end to end.
 *
 * `check-device-management.mjs` holds the routes and `check-device-revoke-socket.mjs` holds the
 * socket. Neither says anything about the thing an operator actually uses, and that half compiles
 * exactly as well when it does nothing: a dialog that never opens, a Rename that posts and never
 * redraws, a Revoke whose confirmation names the wrong device, a panel nobody without a mouse can
 * reach. So this drives a real Chrome.
 *
 * Three disciplines, and they are what make the sections below evidence rather than description:
 *
 *  - **the devices are paired through the real routes.** `POST /api/pair/request`,
 *    `POST /api/pair/approve`, `GET /api/pair/status` — the gesture a second machine performs,
 *    not a `devices.json` written here. A seeded file proves the panel can render a shape this
 *    check invented; a real pairing proves it renders the shape the board writes, and it is the
 *    only way to hold a device's **credential**, which two of the cases below turn on.
 *  - **what landed is asked of the server's registry**, over `GET /api/devices`, never of the
 *    page. This is the discipline `check-board-switch-sync-target-browser.mjs` sets: a panel that
 *    updates its own state and calls nothing passes every DOM assertion ever written about it.
 *  - **the buttons are pressed where they are drawn**, with `Input.dispatchMouseEvent` at the
 *    middle of the element, after `document.elementFromPoint` has agreed that the middle of the
 *    element is what a press there would find. A `.click()` in a script reaches a control that is
 *    behind something, off screen, or nought pixels tall.
 *
 * **The board is started with its token on** — `EXCALIDRAW_NO_AUTH: undefined`, against the
 * default in `lib/spawn-canvas.mjs`. Every other check in this directory wants the opt-out; this
 * one cannot have it. Half of what is asserted here is *which credential a caller holds*: that a
 * renamed device's credential still verifies, that a revoked one's next request is refused, that
 * a page holding a device's credential is told which row is its own. On a board that admits
 * everybody all three of those pass without the feature existing.
 *
 * Three devices rather than one, because a rename or a revoke that writes to the wrong record is
 * invisible against a list of one, and because *last seen* has three answers worth telling apart:
 * a device that made a request a moment ago, one nobody has opened in months, and one that has
 * never been used at all.
 *
 * The board is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME`, so its
 * token and its device registry land inside this check's own temporary directory and the
 * operator's real state directory is never read or written. Where they land is spelled out here
 * from the platform rather than imported: a check that asks the code under test where it put a
 * file agrees with any answer it gives.
 *
 * Self-contained: a canvas server on a port the kernel just handed out, one headless Chrome, both
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend.
 *
 * Usage: node scripts/check-devices-panel-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Spelled out rather than imported, for the reason the banner gives. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = argOf('--chrome') ?? findChrome();
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

const children = [];
let log = '';

async function waitFor(fn, what, tries = 80) {
  const value = await settle(fn, tries);
  if (value) return value;
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

/**
 * The same wait, answering null rather than throwing.
 *
 * Used by the sections whose failure is a *case* rather than the end of the run: a throw out of
 * section 2 would leave sections 3 to 8 unrun, and a check proved red on its first assertion is
 * evidence about that assertion and about nothing after it.
 */
async function settle(fn, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  return null;
}

// ─── Talking to the board ─────────────────────────────────────

let board = null;
let hostToken = '';

/** A call to the board as whoever holds `credential`; the host by default. */
async function api(method, path, body = null, credential = null) {
  const response = await fetch(`${board.base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      [TOKEN_HEADER]: credential ?? hostToken,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* an error page, which the caller may want raw */ }
  return { status: response.status, body: parsed, text };
}

/** Every device this board holds, as the board itself reports them. The registry, not the page. */
const registry = async () => (await api('GET', '/api/devices')).body?.devices ?? [];
const inRegistry = async (id) => (await registry()).find((entry) => entry.id === id) ?? null;

/**
 * A device asking to pair, under the authority it reached this board as.
 *
 * Raw `http` rather than `fetch`, because the `Host` header is the point: it is the authority the
 * operator is shown at approval and the one the panel prints back, and `fetch` will not let a
 * caller set it. `POST /api/pair/request` is deliberately not pinned to an authority this board
 * already answers for (`verifySameAuthority` in `core/origin-gate.ts`) — a device that has not
 * been approved yet reaches this board under a name nobody has configured, which is the whole
 * reason the gesture exists.
 */
function ask(name, host) {
  const payload = JSON.stringify({ name });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: board.port,
      path: '/api/pair/request',
      method: 'POST',
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(text)); } catch { reject(new Error(`${response.statusCode}: ${text}`)); }
      });
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/** The whole gesture: the device asks, the operator approves, the device collects its secret. */
async function pair(name, host) {
  const asked = await ask(name, host);
  if (!asked?.success) throw new Error(`pairing request refused: ${JSON.stringify(asked)}`);
  const approved = await api('POST', '/api/pair/approve', { requestId: asked.requestId, code: asked.code });
  if (approved.status !== 200) throw new Error(`approval refused: ${approved.status} ${approved.text}`);
  const collected = await api('GET', `/api/pair/status?requestId=${encodeURIComponent(asked.requestId)}`);
  if (collected.body?.state !== 'approved') {
    throw new Error(`the secret was never handed over: ${collected.text}`);
  }
  return { id: collected.body.deviceId, credential: collected.body.credential, name, host };
}

/**
 * Move a device's *last seen* back, in the registry file.
 *
 * The one fact on this panel that no route can produce on demand: the server writes `lastSeenAt`
 * when a device calls, so *a moment ago* and *never* are both reachable from here and *three
 * months ago* is only reachable by waiting three months. Nothing is memoised — `listDevices`
 * re-reads the file on every call, and `core/device-registry.ts` says why at length — so an edit
 * here is a fact the board reads on its next request, the same as one it wrote itself.
 */
function age(id, iso) {
  const file = JSON.parse(readFileSync(registryFile, 'utf8'));
  const device = file.devices.find((entry) => entry.id === id);
  if (!device) throw new Error(`no device ${id} in ${registryFile}`);
  device.lastSeenAt = iso;
  writeFileSync(registryFile, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
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
 * Press a control where it is drawn.
 *
 * The middle of the element, after the page has agreed that the middle of the element is what a
 * press there finds — a control behind the confirmation it opened, scrolled out of the dialog's
 * own overflow, or laid out nought pixels tall is a control nobody can press, and `.click()` in a
 * script reaches all three.
 */
async function pressOn(selector) {
  const aim = await evaluate(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return { why: 'no such element' };
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return { why: 'it is ' + rect.width + 'x' + rect.height };
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const at = document.elementFromPoint(x, y);
    if (!at) return { why: 'the middle of it is off the page at ' + x + ',' + y };
    if (at !== target && !target.contains(at)) {
      return { why: 'a press there finds ' + at.tagName + '.' + String(at.className || '') };
    }
    return { x, y };
  })()`);
  if (aim.why) return aim.why;
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: aim.x, y: aim.y, button: 'none', buttons: 0 });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type, x: aim.x, y: aim.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
  return null;
}

/** Pressed, or the reason nobody could have — `check` reads the second as the failure detail. */
const pressed = async (selector) => {
  const why = await pressOn(selector);
  return { ok: why === null, why: why ?? '' };
};

const SHIFT = 8;

/** A key, as the keyboard sends it. `text` is what makes Enter activate the control under focus. */
async function key(name, { code = name, keyCode, modifiers = 0, text } = {}) {
  const common = { key: name, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', ...common, ...(text ? { text } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
}

/** Type into a React-controlled field, which is not what setting `.value` does. */
const type = (selector, value) => evaluate(`(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(field, ${JSON.stringify(value)});
  field.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

/** Where the caret is, and whether it is anywhere a keyboard reader could act from. */
const caret = () => evaluate(`(() => {
  const active = document.activeElement;
  if (!active) return null;
  const name = (active.getAttribute('aria-label') || active.textContent || '').trim().slice(0, 60);
  return {
    tag: active.tagName,
    className: typeof active.className === 'string' ? active.className : '',
    name,
    inDialog: Boolean(active.closest && active.closest('.devices-dialog')),
    onControl: Boolean(active.classList && active.classList.contains('devices-button')),
  };
})()`);

/** The dialog as the reader has it: the rows, and what each one says. */
const panel = () => evaluate(`(() => {
  const dialog = document.querySelector('.devices-dialog');
  if (!dialog) return { open: false, rows: [] };
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
      badge: row.querySelector('.devices-dialog__badge')?.textContent?.trim() ?? null,
      lastSeen: fact(row, 'lastSeen'),
      lastSeenExact: row.querySelector('[data-fact="lastSeen"]')?.getAttribute('title') ?? null,
      approved: fact(row, 'approved'),
      from: fact(row, 'approvedFrom'),
      host: fact(row, 'host'),
    })),
  };
})()`);

const rowsOf = (state) => state.rows.map((row) => row.name);
const rowFor = (state, id) => state.rows.find((row) => row.id === id) ?? {};

/** Open the board's page as whoever the arguments say, and wait for the bar. */
async function openBoard({ token = null, credential = null }) {
  await evaluate(`(() => {
    try { window.sessionStorage.clear() } catch { /* nothing remembered */ }
    try {
      if (${JSON.stringify(credential)}) {
        window.localStorage.setItem('vibemaxxing.device.credential', ${JSON.stringify(credential ?? '')});
      } else {
        window.localStorage.removeItem('vibemaxxing.device.credential');
      }
    } catch { /* nothing remembered */ }
    return true;
  })()`);
  await send('Page.navigate', { url: token ? `${board.base}/?t=${encodeURIComponent(token)}` : board.base });
  await waitFor(() => evaluate(`!!document.querySelector('.devices-button')`), 'the Devices control on the bar');
}

/** Open the list, however it is opened, and wait for `count` rows to be drawn. */
async function openList(count) {
  const why = await pressOn('.devices-button');
  if (why) throw new Error(`the Devices control could not be pressed: ${why}`);
  return waitFor(async () => {
    const state = await panel();
    return state.open && state.rows.length === count ? state : null;
  }, `the device list to be drawn with ${count} row(s)`);
}

try {
  // ─── The board, with its token on ───────────────────────────

  const port = await freePort();
  board = startCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
      // Against `canvasEnvironment`'s default, for the reason the banner gives: this check is
      // about which credential a caller holds, and a board that admits everybody cannot say.
      EXCALIDRAW_NO_AUTH: undefined,
    },
  });
  children.push(board.child);
  board.child.stdout.on('data', (chunk) => { log += chunk; });
  board.child.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => (await fetch(`${board.base}/health`)).ok, 'the canvas server');

  const tokenFile = join(stateDir(), `server-${port}.token`);
  hostToken = (await waitFor(
    () => (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null),
    'the board to write its token',
  ));

  // ─── The devices, paired the way a second machine pairs ─────

  const laptop = await pair('MacBook-Pro-3', 'mac.lan:3737');
  const phone = await pair('Pixel-9', 'phone.local:3737');
  const tablet = await pair('Tablet in a drawer', 'tablet.lan:3737');

  // One of them has just been used, one has not been opened in months, one never at all. The
  // first is a real request carrying its own credential — which is also the first proof that the
  // credential a pairing handed over is one this board accepts.
  const usedIt = await api('GET', '/api/devices', null, laptop.credential);
  if (usedIt.status !== 200) throw new Error(`the laptop's credential was refused: ${usedIt.status}`);
  await waitFor(async () => (await inRegistry(laptop.id))?.lastSeenAt, 'the laptop to be marked as seen');
  age(phone.id, new Date(Date.now() - 92 * 24 * 60 * 60 * 1000).toISOString());

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

  // ─── 1. The control is there, on a board with no project ────

  console.log('1. a board with no project registered still offers the list');
  await openBoard({ token: hostToken });
  await waitFor(() => evaluate(`!!document.querySelector('.header')`), 'the header to render');
  const noProjects = await evaluate(`document.querySelectorAll('.workspace-tab').length`);
  check('this board has no project registered, which is a fresh clone', noProjects === 0,
        `${noProjects} tab(s)`);
  check('and there is no project gear to hang the list off',
        await evaluate(`!document.querySelector('.workspace-tab__config')`));
  check('the bar carries a control that opens it',
        (await evaluate(`document.querySelector('.devices-button').textContent.trim()`)) === 'Devices');
  await shot('01-bar');

  // ─── 2. The panel is reachable and operable by keyboard ─────

  console.log('\n2. the panel is reachable and operable without a mouse');
  // From the top of the page, by pressing Tab — not by a `.focus()` in a script, which proves the
  // handler and says nothing about whether a keyboard reader can get there.
  await evaluate('document.activeElement?.blur?.(); window.focus()');
  let presses = 0;
  let onControl = false;
  while (presses < 40 && !onControl) {
    await key('Tab', { keyCode: 9 });
    presses++;
    onControl = (await caret())?.onControl === true;
  }
  check('Tab from the top of the page reaches the Devices control', onControl,
        `${presses} press(es), focus on ${JSON.stringify(await caret())}`);

  await key('Enter', { keyCode: 13, text: '\r' });
  const byKeyboard = await settle(async () => {
    const state = await panel();
    return state.open ? state : null;
  }, 20);
  check('and Enter on it opens the list', byKeyboard?.open === true);

  const landed = await settle(async () => {
    const where = await caret();
    return where?.inDialog ? where : null;
  }, 12);
  check('the focus moves into the dialog, so the next key press is about it',
        landed?.inDialog === true, JSON.stringify(landed ?? await caret()));

  // Tab is trapped: the dialog is drawn over the board but sits *before* the bar in the document,
  // so a caret that walks out of it walks into the canvas behind it — controls a reader cannot
  // see, under a modal they think they are in.
  let escaped = null;
  for (let step = 0; step < 14 && !escaped; step++) {
    await key('Tab', { keyCode: 9 });
    const where = await caret();
    if (!where?.inDialog) escaped = where;
  }
  check('Tab does not walk out of it into the board behind', escaped === null,
        JSON.stringify(escaped));
  let escapedBack = null;
  for (let step = 0; step < 4 && !escapedBack; step++) {
    await key('Tab', { keyCode: 9, modifiers: SHIFT });
    const where = await caret();
    if (!where?.inDialog) escapedBack = where;
  }
  check('and neither does Shift+Tab', escapedBack === null, JSON.stringify(escapedBack));
  await shot('02-keyboard');

  await key('Escape', { keyCode: 27 });
  const shut = await settle(async () => ((await panel()).open === false ? 'shut' : null), 20);
  check('Escape closes it', shut === 'shut');
  const returned = await caret();
  check('and hands the focus back to the control that opened it',
        returned?.onControl === true, JSON.stringify(returned));
  // Whatever the two cases above found, the next section needs the dialog shut: a control behind
  // an open backdrop cannot be pressed, and a failure there would name the wrong thing.
  if ((await panel()).open) {
    await pressOn('.devices-dialog .workspace-dialog__cancel');
    await waitFor(async () => (await panel()).open === false, 'the dialog to close on its own Close');
  }

  // ─── 3. What the list says about a device ───────────────────

  console.log('\n3. the list says what a person needs to judge a device by');
  const opened = await openList(3);
  await shot('03-list');
  check('every paired device is listed', opened.rows.length === 3, JSON.stringify(rowsOf(opened)));
  check('under the name each of them proposed for itself',
        rowFor(opened, laptop.id).name === 'MacBook-Pro-3', JSON.stringify(rowsOf(opened)));

  const held = await registry();
  const recordFor = (id) => held.find((entry) => entry.id === id) ?? {};
  check('the address it was approved from, as the registry holds it',
        rowFor(opened, laptop.id).from === recordFor(laptop.id).approvedFrom,
        `${rowFor(opened, laptop.id).from} vs ${recordFor(laptop.id).approvedFrom}`);
  check('and the Host it was approved for', rowFor(opened, laptop.id).host === 'mac.lan:3737',
        JSON.stringify(rowFor(opened, laptop.id).host));
  check('a second device shows its own Host rather than the first one\'s',
        rowFor(opened, phone.id).host === 'phone.local:3737',
        JSON.stringify(rowFor(opened, phone.id).host));

  // Last seen is the column somebody tidying this list is actually reading, and its three answers
  // have to be three answers.
  check('a device that called a moment ago reads as a time a person reads',
        rowFor(opened, laptop.id).lastSeen === 'just now',
        JSON.stringify(rowFor(opened, laptop.id).lastSeen));
  check('one nobody has opened in months says so, rather than repeating the same words',
        /months ago$/.test(rowFor(opened, phone.id).lastSeen ?? ''),
        JSON.stringify(rowFor(opened, phone.id).lastSeen));
  check('and one that has never been used says that, not an old date',
        rowFor(opened, tablet.id).lastSeen === 'never',
        JSON.stringify(rowFor(opened, tablet.id).lastSeen));
  check('none of the three is an ISO timestamp',
        opened.rows.every((row) => !/\d{4}-\d\d-\d\dT/.test(row.lastSeen ?? '')),
        JSON.stringify(opened.rows.map((row) => row.lastSeen)));
  check('the exact instant is still there for whoever wants it, in the title',
        rowFor(opened, laptop.id).lastSeenExact === recordFor(laptop.id).lastSeenAt,
        JSON.stringify(rowFor(opened, laptop.id).lastSeenExact));
  check('and when it was approved is there too',
        typeof rowFor(opened, laptop.id).approved === 'string'
          && rowFor(opened, laptop.id).approved.length > 0,
        JSON.stringify(rowFor(opened, laptop.id).approved));

  // ─── 4. The rename, which has to reach the registry ─────────

  console.log('\n4. the name is editable here, and the edit reaches the registry');
  const renamePress = await pressed(`[data-device="${laptop.id}"] .devices-dialog__rename`);
  check('a row offers to rename its device, where it is drawn', renamePress.ok, renamePress.why);
  await waitFor(() => evaluate(`!!document.querySelector('[data-device="${laptop.id}"] [data-field="name"]')`),
                'the name field');
  check('the field opens holding the name it is replacing',
        await evaluate(`document.querySelector('[data-device="${laptop.id}"] [data-field="name"]').value`)
          === 'MacBook-Pro-3');
  await type(`[data-device="${laptop.id}"] [data-field="name"]`, "Ana's laptop");
  await shot('04-renaming');
  const savePress = await pressed(`[data-device="${laptop.id}"] .devices-dialog__save`);
  check('and Save presses', savePress.ok, savePress.why);

  const renamed = await waitFor(async () => {
    const state = await panel();
    return rowFor(state, laptop.id).name === "Ana's laptop" ? state : null;
  }, 'the row to be redrawn under the new name');
  check('the row is redrawn under the new name', renamed.rows.length === 3, JSON.stringify(rowsOf(renamed)));
  check('and the server\'s registry says so, so this was not only on screen',
        (await inRegistry(laptop.id))?.name === "Ana's laptop",
        JSON.stringify((await registry()).map((entry) => entry.name)));
  check('the other two devices are untouched, so the write found the right record',
        (await inRegistry(phone.id))?.name === 'Pixel-9'
          && (await inRegistry(tablet.id))?.name === 'Tablet in a drawer',
        JSON.stringify((await registry()).map((entry) => entry.name)));
  await shot('05-renamed');

  // ─── 5. And it survives a reload, credential and all ────────

  console.log('\n5. the new name outlives the page, and the device it named still gets in');
  await send('Page.reload', { ignoreCache: false });
  await waitFor(() => evaluate(`!!document.querySelector('.devices-button')`), 'the bar after the reload');
  const afterReload = await openList(3);
  await shot('06-after-reload');
  check('the renamed device comes back under the name it was given',
        rowFor(afterReload, laptop.id).name === "Ana's laptop", JSON.stringify(rowsOf(afterReload)));
  // The half a rename could quietly cost: the record is rewritten, and a rewrite that dropped the
  // stored digest would take a working device off the board without saying so.
  const stillIn = await api('GET', '/api/devices', null, laptop.credential);
  check('and its credential still verifies, asserted by making a call with it',
        stillIn.status === 200, `got ${stillIn.status}`);
  check('the board answers that call as that device, and names its row',
        stillIn.body?.self === laptop.id, JSON.stringify(stillIn.body?.self));

  // ─── 6. The revoke, which asks first ────────────────────────

  console.log('\n6. revoking asks first, says what it costs, and then bites');
  const askPress = await pressed(`[data-device="${phone.id}"] .devices-dialog__revoke`);
  check('Revoke presses, where it is drawn', askPress.ok, askPress.why);
  const asking = await waitFor(async () => {
    const state = await panel();
    return state.warn ? state : null;
  }, 'the confirmation');
  check('the confirmation names the device rather than asking "are you sure"',
        asking.warn.includes('Pixel-9'), JSON.stringify(asking.warn));
  check('and says what it costs, and when', /next request/i.test(asking.warn),
        JSON.stringify(asking.warn));
  // The press that opened this took its own button off the page. A reader who arrived on the
  // keyboard would otherwise be standing on `<body>`, with the control they asked for somewhere
  // they have to go looking; and the answer they are left on is the one that costs nothing.
  const onConfirm = await settle(async () => {
    const where = await caret();
    return where?.inDialog ? where : null;
  }, 12);
  check('the confirmation takes the focus, and on the answer that keeps the device',
        onConfirm?.className.includes('devices-dialog__keep') === true,
        JSON.stringify(onConfirm ?? await caret()));
  check('nothing is revoked by the asking', (await registry()).length === 3,
        JSON.stringify((await registry()).map((entry) => entry.id)));
  await shot('07-confirming');

  await evaluate('window.__noReloadSentinel = "still here"');
  const goPress = await pressed(`[data-device="${phone.id}"] .devices-dialog__revoke--go`);
  check('the second press goes through', goPress.ok, goPress.why);
  const revoked = await waitFor(async () => {
    const state = await panel();
    return state.rows.length === 2 ? state : null;
  }, 'the row to leave the list');
  check('the row is gone from the list', revoked.rows.every((row) => row.id !== phone.id));
  check('and nothing reloaded to get there',
        (await evaluate('window.__noReloadSentinel')) === 'still here');
  check('the server\'s registry has let it go too', (await inRegistry(phone.id)) === null,
        JSON.stringify((await registry()).map((entry) => entry.name)));
  check('the dialog says what happened, because the row that would have said it is gone',
        typeof revoked.said === 'string' && revoked.said.includes('Pixel-9'),
        JSON.stringify(revoked.said));
  const refused = await api('GET', '/api/devices', null, phone.credential);
  check('and the revoked device\'s next request is refused', refused.status === 401,
        `got ${refused.status}`);
  check('while the one beside it on the list still gets in',
        (await api('GET', '/api/devices', null, laptop.credential)).status === 200);
  await shot('08-revoked');

  // ─── 7. An empty list is a sentence, not a blank panel ──────

  console.log('\n7. the last device leaving says so in words');
  for (const id of [laptop.id, tablet.id]) {
    const first = await pressed(`[data-device="${id}"] .devices-dialog__revoke`);
    check(`Revoke presses on ${id}`, first.ok, first.why);
    await waitFor(() => panel().then((state) => state.warn), `the confirmation on ${id}`);
    const second = await pressed(`[data-device="${id}"] .devices-dialog__revoke--go`);
    check(`and the confirmation on ${id} presses`, second.ok, second.why);
    await waitFor(async () => (await panel()).rows.every((row) => row.id !== id), `${id} to go`);
  }
  const empty = await waitFor(async () => {
    const state = await panel();
    return state.rows.length === 0 ? state : null;
  }, 'the list to empty');
  check('an empty registry says no device has been paired rather than showing nothing',
        typeof empty.empty === 'string' && /no device/i.test(empty.empty), JSON.stringify(empty.empty));
  check('and says where to read about it', /devices\.md/.test(empty.empty ?? ''),
        JSON.stringify(empty.empty));
  check('the server\'s registry is empty too', (await registry()).length === 0,
        JSON.stringify(await registry()));
  await shot('09-empty');

  // ─── 8. Signing out the device you are reading this on ──────

  console.log('\n8. revoking the device you are reading this on is allowed, and warned about');
  // The page reloads holding a device's credential and nothing else — no token in the address bar
  // and none on the tab. That is the whole of what makes a page a device: `frontend/src/auth.ts`
  // presents the token when there is one and this otherwise, and the board judges the caller by
  // what arrives rather than by which machine it came from.
  const desk = await pair('Desk machine', `127.0.0.1:${port}`);
  await openBoard({ credential: desk.credential });
  const own = await openList(1);
  await shot('10-as-the-device');
  check('a page holding a device\'s credential is shown the list',
        own.rows.length === 1, JSON.stringify(rowsOf(own)));
  check('and its own row is marked as the device it is being read on',
        rowFor(own, desk.id).badge === 'this device', JSON.stringify(rowFor(own, desk.id)));

  const ownAsk = await pressed(`[data-device="${desk.id}"] .devices-dialog__revoke`);
  check('Revoke on its own row presses rather than being refused', ownAsk.ok, ownAsk.why);
  const ownWarn = await waitFor(async () => {
    const state = await panel();
    return state.warn ? state : null;
  }, 'the warning about signing this machine out');
  check('the warning says this is the device being read on', /this device|this machine/i.test(ownWarn.warn),
        JSON.stringify(ownWarn.warn));
  check('and says what it costs — paired afresh, not merely "removed"',
        /paired afresh/i.test(ownWarn.warn), JSON.stringify(ownWarn.warn));
  await shot('11-signing-out');

  const ownGo = await pressed(`[data-device="${desk.id}"] .devices-dialog__revoke--go`);
  check('the confirmation goes through rather than refusing the caller its own row', ownGo.ok, ownGo.why);
  const signedOut = await waitFor(async () => {
    const state = await panel();
    return state.said ? state : null;
  }, 'the dialog to say what it did');
  check('it says the machine was signed out rather than that a stranger was revoked',
        /this device|this machine/i.test(signedOut.said), JSON.stringify(signedOut.said));
  check('and the server\'s registry no longer holds it', (await inRegistry(desk.id)) === null,
        JSON.stringify(await registry()));
  check('so the page that pressed it is refused on its next request',
        (await api('GET', '/api/devices', null, desk.credential)).status === 401);
  await shot('12-signed-out');
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
