#!/usr/bin/env node
/**
 * Checks the two surfaces of the pairing gesture: the approval on the host, and the waiting
 * screen on the device asking.
 *
 * #503 built the exchange and gave it four routes. It gave it no screens, so the gesture it
 * describes — open the board on the second machine, read a code off it, approve it on the machine
 * running the board — could be performed only by somebody holding `curl` and the request
 * identifier. This is the half a person does with two screens and no documentation, and it is
 * checked here because both of its halves are things that compile perfectly while doing none of
 * what they claim.
 *
 * Four shapes, and the numbered sections below are them:
 *
 *   1. **the dialog on the host** — the code large enough to compare across a desk, the name the
 *      device *proposed* marked as its own claim, the address it came from and the `Host` it
 *      asked for verbatim, and the sentence saying what approval grants. Refuse is the focus the
 *      dialog opens on and Escape is a refusal rather than a deferral, which is the difference
 *      between a control a person can dismiss and one they have to answer.
 *   2. **what approval grants, held to the routes it grants** — the sentence is
 *      `PAIRING_GRANT_SENTENCE` in `src/core/pairing-grants.ts`, and every clause in it names a
 *      route. Each of those routes is asked, on a board where it is switched on, whether it is
 *      behind the credential every other route is behind: 401 to a caller with none, something
 *      other than 401 to a caller with one. A sentence promising a shell on a board with no
 *      terminal route is the drift this section exists to stop.
 *   3. **the waiting screen on the device** — a second Chrome, at an authority this board does
 *      not answer for, which is what a second machine *is*. It gets a screen rather than the
 *      403 the page itself used to answer with, and the code on it is compared — as a string —
 *      with the code in the dialog on the host.
 *   4. **refused, and asked again** — a device the operator refused says so and offers to ask
 *      again, rather than sitting on a spinner until an expiry it cannot see.
 *
 * Section 3 needs a non-loopback IPv4 address on this machine, because an origin that is
 * genuinely not this one cannot be simulated by a header in a browser: Chrome sets `Host` from
 * the URL and there is no way to ask it not to. **It binds `0.0.0.0` for the length of that
 * section**, the way `check-pairing-handshake.mjs` and `check-non-loopback-github-browser.mjs`
 * already do. On a machine with no such address the section says so and is skipped rather than
 * passing vacuously.
 *
 * Two Chrome processes rather than two tabs of one. They are two devices — separate profiles,
 * separate storage, separate origins — and a background tab in headless Chrome is throttled,
 * which is a slow flake in a check whose whole subject is two screens being looked at together.
 *
 * The boards are given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME`, so the
 * token and the device registry land inside this check's own temporary directory and the
 * operator's real state directory is never read or written.
 *
 * Self-contained: canvas servers on ports the kernel just handed out, two headless Chromes, all
 * killed at the end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * this drives the built server and the built frontend, and a stale `dist/frontend` is a green run
 * about code that is not there.
 *
 * Usage: node scripts/check-pairing-surfaces-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

// `dist/core/pairing-grants.js` is deliberately not in this list: section 2 is what asserts it
// exists, and a preflight that exits here would report the whole check as unbuilt rather than
// reporting the feature as missing — which is the difference between a red run and a run.
for (const built of ['dist/server.js', 'dist/frontend/index.html']) {
  if (!existsSync(join(repoRoot, built))) {
    console.error(`  FAIL  the tree is built — ${built} not found`);
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

/**
 * One numbered section, whose failure is recorded rather than allowed to end the run.
 *
 * A check that stops at the first defect cannot say how much of a feature is missing, which is
 * exactly the question being put to it when it is run against the old code on purpose.
 */
async function stage(title, body) {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${title} did not finish — ${error.message}`);
  }
}

/** The one header name the server, the page and this check all have to agree on. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-pairing-surfaces-'));
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(shotDir, { recursive: true });

/** The home each board is told it has, and the only place it may keep state. */
function newHome(name) {
  const home = join(workDir, name);
  mkdirSync(home, { recursive: true });
  return home;
}

/** Where a state file has to appear, spelled out from the platform rather than imported. */
function conventionalStateFile(home, name) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const root = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : home;
  return join(root, leaf, name);
}

const children = [];
const servers = [];
let log = '';

async function waitFor(fn, what, tries = 150) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The same wait, answering `null` rather than throwing when it never came.
 *
 * Every wait on a surface this check is *about* is one of these. A throwing wait ends its
 * section at the first thing that is missing, so a run against the code before the feature
 * reports three sections that "did not finish" instead of the twenty cases that are red — and
 * the whole reason to run a check against the old code first is to read that list.
 */
async function settle(fn, tries = 60) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(200);
  }
  return null;
}

/** A JSON file's contents, or a stand-in that fails a case rather than a section. */
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * A board of this check's own, with the token gate **on**.
 *
 * `EXCALIDRAW_NO_AUTH: undefined` is load-bearing: `canvasEnvironment` sets that variable for
 * every check in this directory, and what is being asserted here is which screen a caller with
 * no credential gets. Behind the opt-out there is no such caller.
 */
async function startBoard({ host = '127.0.0.1', reachAt = '127.0.0.1', home, env = {} } = {}) {
  const port = await freePort();
  const server = startCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      EXCALIDRAW_NO_AUTH: undefined,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: home,
      XDG_STATE_HOME: home,
      ...env,
    },
  });
  children.push(server.child);
  servers.push(server);
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'the canvas server');
  const token = readFileSync(conventionalStateFile(home, `server-${port}.token`), 'utf-8').trim();
  return { port, reachAt, token, home, base: `http://${reachAt}:${port}` };
}

/**
 * One request, over `node:http` rather than `fetch`.
 *
 * `Host` is a forbidden header for `fetch`, and naming an authority a board does not answer for
 * is half of what a second origin is.
 */
function call(board, path, { method = 'GET', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: board.reachAt,
      port: board.port,
      path,
      method,
      headers: {
        ...(payload === null
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(host ? { Host: host } : {}),
        ...headers,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* HTML, or nothing */ }
        resolve({ status: response.statusCode, text, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/** The address a second machine would reach this one on, or null when there is no such address. */
function externalAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

// ─── Talking to a Chrome ──────────────────────────────────────

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

/**
 * One headless Chrome, attached to, as a small object with the four verbs a section needs.
 *
 * Its own profile directory, because two of these run at once and they are standing in for two
 * machines: a shared profile would give the "device" the host's storage.
 */
async function openChrome(name) {
  const profileDir = join(workDir, `chrome-${name}`);
  mkdirSync(profileDir, { recursive: true });
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

  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, `a Chrome page target for ${name}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const pending = new Map();
  let nextId = 1;
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };

  return {
    name,
    send,
    evaluate,
    navigate: (url) => send('Page.navigate', { url }),
    /** A real key, dispatched the way a person presses one. */
    key: async (key, code, keyCode) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    },
    shot: async (label) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(shotDir, `${label}.png`), Buffer.from(data, 'base64'));
    },
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

/** The text of one node, trimmed, or null when it is not on the page. */
const textOf = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  return node ? node.textContent.trim() : null;
})()`;

/** Press a button by clicking it, so what is asserted is a control a person could reach. */
const clickOn = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return false;
  node.click();
  return true;
})()`;

// ─── The cases ────────────────────────────────────────────────

try {
  // ─── 1. The dialog on the host ──────────────────────────────

  const hostHome = newHome('host-home');
  const board = await startBoard({ home: hostHome });
  const hostChrome = await openChrome('host');

  /** What the operator's board is showing, in one round trip. */
  const DIALOG = `(() => {
    const dialog = document.querySelector('[data-pairing-approval]');
    if (!dialog) return null;
    const text = (selector) => {
      const node = dialog.querySelector(selector);
      return node ? node.textContent.trim() : null;
    };
    const focused = document.activeElement;
    return {
      role: dialog.getAttribute('role'),
      modal: dialog.getAttribute('aria-modal'),
      code: text('[data-pairing-code]'),
      claimedName: text('[data-pairing-claimed-name]'),
      host: text('[data-pairing-host]'),
      address: text('[data-pairing-address]'),
      grants: text('[data-pairing-grants]'),
      refuse: text('[data-pairing-refuse]'),
      approve: text('[data-pairing-approve]'),
      all: dialog.textContent.replace(/\\s+/g, ' ').trim(),
      focusedAction: focused ? focused.getAttribute('data-pairing-refuse') !== null ? 'refuse'
        : focused.getAttribute('data-pairing-approve') !== null ? 'approve' : 'elsewhere' : 'nothing',
    };
  })()`;

  let sentence = '';
  let clauses = [];

  await stage('1. the dialog on the host says what a person has to judge', async () => {
    await hostChrome.navigate(`${board.base}/?t=${encodeURIComponent(board.token)}`);
    await waitFor(() => hostChrome.evaluate('document.querySelector(".app") !== null'),
                  'the board to mount on the host');

    const quiet = await hostChrome.evaluate('document.querySelector("[data-pairing-approval]") !== null');
    check('no dialog while nothing is asking', quiet === false, String(quiet));

    const asked = await call(board, '/api/pair/request', {
      method: 'POST',
      body: { name: 'a laptop by the window' },
      host: `board.somewhere.test:${board.port}`,
    });
    check('a device with no credential asks', asked.status === 200,
          `${asked.status} ${asked.text.slice(0, 200)}`);

    const dialog = await settle(() => hostChrome.evaluate(DIALOG));
    await hostChrome.shot('01-host-dialog');

    check('the request raises a dialog on the board', Boolean(dialog), JSON.stringify(dialog));
    check('and it is a dialog, marked as one', dialog?.role === 'dialog' && dialog?.modal === 'true',
          JSON.stringify({ role: dialog?.role, modal: dialog?.modal }));
    check('showing the code', dialog?.code === asked.body?.code,
          `${JSON.stringify(dialog?.code)} vs ${JSON.stringify(asked.body?.code)}`);
    check('the name the device proposed', String(dialog?.claimedName ?? '').includes('a laptop by the window'),
          JSON.stringify(dialog?.claimedName));
    check('marked as the device\'s own claim rather than as a fact',
          /calls itself|says it is|claims/i.test(String(dialog?.all ?? '')),
          JSON.stringify(dialog?.all ?? '').slice(0, 300));
    check('the Host it asked for, verbatim',
          String(dialog?.host ?? '').includes(`board.somewhere.test:${board.port}`),
          JSON.stringify(dialog?.host));
    check('and the address it came from, verbatim',
          /127\.0\.0\.1|::1|::ffff:127/.test(String(dialog?.address ?? '')),
          JSON.stringify(dialog?.address));
    check('and what approval grants, in a sentence of its own',
          Boolean(dialog?.grants) && dialog.grants.length > 40, JSON.stringify(dialog?.grants));

    check('refuse is offered as prominently as approve',
          Boolean(dialog?.refuse) && Boolean(dialog?.approve), JSON.stringify(dialog));
    check('and refuse is what the dialog opens focused on', dialog?.focusedAction === 'refuse',
          String(dialog?.focusedAction));

    // Tab, and back to where it started: a dialog a person can leave by tabbing is one they can
    // answer by pressing Enter on whatever the page behind it had focused.
    await hostChrome.key('Tab', 'Tab', 9);
    const afterTab = await hostChrome.evaluate(DIALOG);
    check('tabbing moves to approve rather than out of the dialog',
          afterTab?.focusedAction === 'approve', String(afterTab?.focusedAction));
    await hostChrome.key('Tab', 'Tab', 9);
    const wrapped = await hostChrome.evaluate(DIALOG);
    check('and tabbing again comes back to refuse', wrapped?.focusedAction === 'refuse',
          String(wrapped?.focusedAction));

    sentence = dialog?.grants ?? '';

    // Escape: a refusal, and not a deferral. The device is what has to be told.
    await hostChrome.key('Escape', 'Escape', 27);
    const closed = await settle(
      async () => (await hostChrome.evaluate('document.querySelector("[data-pairing-approval]") === null')) || null,
      25);
    // `dialog` in the condition on purpose: a page that never raised one closes it trivially,
    // and this case has to be red on the code that has no dialog rather than green on it.
    check('Escape dismisses the dialog', Boolean(dialog) && closed === true, String(closed));

    const afterEscape = await call(board,
      `/api/pair/status?requestId=${encodeURIComponent(asked.body?.requestId ?? '')}`);
    check('and dismissing it refused the device rather than deferring it',
          afterEscape.body?.state === 'refused', afterEscape.text.slice(0, 200));

    const stillListed = await call(board, '/api/pair/pending', { headers: { [TOKEN_HEADER]: board.token } });
    check('so the request is off the operator\'s screen for good',
          (stillListed.body?.requests ?? []).length === 0, stillListed.text.slice(0, 200));

    // And then the other answer, on a second request: approve, by pressing the button.
    const second = await call(board, '/api/pair/request', {
      method: 'POST', body: { name: 'the same laptop, asking again' },
    });
    const showing = await settle(async () => {
      const value = await hostChrome.evaluate(DIALOG);
      return value?.code === second.body?.code ? value : null;
    });
    check('a device that asks again is shown again', Boolean(showing), JSON.stringify(showing?.code));

    const pressed = await hostChrome.evaluate(clickOn('[data-pairing-approve]'));
    check('approve is a control a press reaches', pressed === true, String(pressed));

    const collected = await settle(async () => {
      const answer = await call(board,
        `/api/pair/status?requestId=${encodeURIComponent(second.body?.requestId ?? '')}`);
      return answer.body?.state === 'approved' ? answer.body : null;
    }, 25);
    check('and the press mints the device its credential',
          typeof collected?.credential === 'string' && collected.credential.includes('.'),
          JSON.stringify(collected ? { ...collected, credential: '<credential>' } : null));

    const registry = conventionalStateFile(hostHome, 'devices.json');
    const devices = readJson(registry)?.devices ?? [];
    const record = devices.find((entry) => entry.name === 'the same laptop, asking again');
    const secret = String(collected?.credential ?? '').split('.')[1] ?? '';
    check('written down where a restart will find it, as a hash and never the secret',
          Boolean(record) && Boolean(secret)
          && record.secretHash === createHash('sha256').update(secret).digest('hex'),
          `${registry}: ${devices.length} device(s)`);

    const emptied = await settle(
      async () => (await hostChrome.evaluate('document.querySelector("[data-pairing-approval]") === null')) || null,
      25);
    check('and the dialog closes once it has been answered',
          Boolean(showing) && emptied === true, String(emptied));
  });

  // ─── 2. What approval grants, held to the routes ────────────

  await stage('2. the granted-capability sentence names routes that exist and are behind the credential', async () => {
    let grants = null;
    let why = '';
    try {
      grants = await import(new URL('../dist/core/pairing-grants.js', import.meta.url).href);
    } catch (error) { why = String(error?.message ?? error); }
    check('the sentence and the routes it names live in one built module',
          Boolean(grants), why);

    const PAIRING_GRANT_SENTENCE = grants?.PAIRING_GRANT_SENTENCE ?? '';
    const PAIRING_GRANTS = grants?.PAIRING_GRANTS ?? [];
    clauses = PAIRING_GRANTS;

    check('the sentence is one constant, so there is one copy of it to drift from',
          PAIRING_GRANT_SENTENCE.length > 40, JSON.stringify(PAIRING_GRANT_SENTENCE));
    check('and it is the sentence the dialog rendered',
          PAIRING_GRANT_SENTENCE.length > 0 && sentence === PAIRING_GRANT_SENTENCE,
          `${JSON.stringify(sentence)}\n        vs ${JSON.stringify(PAIRING_GRANT_SENTENCE)}`);
    check('it says a shell, without softening it', /\bshell\b/i.test(PAIRING_GRANT_SENTENCE),
          JSON.stringify(PAIRING_GRANT_SENTENCE));
    check('and coding agents', /coding agent/i.test(PAIRING_GRANT_SENTENCE),
          JSON.stringify(PAIRING_GRANT_SENTENCE));
    check('and that it lasts until the device is revoked',
          /revoke/i.test(PAIRING_GRANT_SENTENCE), JSON.stringify(PAIRING_GRANT_SENTENCE));
    check('and that it runs as this account', /account/i.test(PAIRING_GRANT_SENTENCE),
          JSON.stringify(PAIRING_GRANT_SENTENCE));

    check('every clause it is held to is a clause it actually contains',
          clauses.length > 0 && clauses.every((grant) => PAIRING_GRANT_SENTENCE.includes(grant.clause)),
          JSON.stringify(clauses.map((grant) => grant.clause)));
    check('and every clause names a route to hold it to',
          clauses.length > 0 && clauses.every((grant) => grant.route?.method && grant.route?.path),
          JSON.stringify(clauses.map((grant) => grant.route ?? null)));

    // A board with the two things the sentence promises switched on. Without them the routes
    // answer 404 for a reason that has nothing to do with the guard, and this section would be
    // asserting that a disabled feature is disabled.
    const grantHome = newHome('grants-home');
    const project = join(workDir, 'grants-project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'board.config.json'), JSON.stringify({ name: 'grants' }), 'utf8');
    const registryPath = join(workDir, 'grants-workspaces.json');
    writeFileSync(registryPath, JSON.stringify({
      workspaces: [{ id: 'grants', path: project.replace(/\\/g, '/') }],
    }), 'utf8');
    const granting = await startBoard({
      home: grantHome,
      env: {
        EXCALIDRAW_WORKSPACES: registryPath,
        EXCALIDRAW_TERMINAL: '1',
        EXCALIDRAW_IMPLEMENT_AGENT: 'node --version',
      },
    });

    for (const grant of clauses) {
      const { method, path } = grant.route ?? {};
      if (!method || !path) continue;
      const withNothing = await call(granting, path, { method, body: method === 'POST' ? {} : null });
      check(`“${grant.clause}” — ${method} ${path} refuses a caller with no credential`,
            withNothing.status === 401, `${withNothing.status} ${withNothing.text.slice(0, 160)}`);

      const withOne = await call(granting, path, {
        method,
        headers: { [TOKEN_HEADER]: granting.token },
        body: method === 'POST' ? { workspace: 'grants' } : null,
      });
      check(`“${grant.clause}” — and answers a caller that holds one`,
            withOne.status !== 401 && withOne.status !== 404,
            `${withOne.status} ${withOne.text.slice(0, 160)}`);
    }
  });

  // ─── 3 and 4. The device asking, at an origin of its own ────

  const external = externalAddress();
  if (!external) {
    console.log('\n3. the waiting screen on the device asking');
    console.log('  note  this machine has no non-loopback IPv4 address, so a second origin cannot '
                + 'be made here — sections 3 and 4 skipped');
  } else {
    const pairHome = newHome('pair-home');
    // `0.0.0.0` is a bind address, and the two browsers below reach it at two of the addresses it
    // includes. Deliberately no `EXCALIDRAW_ALLOWED_HOSTS`: the authority the device reaches this
    // board under is one this board does not answer for, and that is what a second machine is.
    const open = await startBoard({ host: '0.0.0.0', home: pairHome });
    const deviceChrome = await openChrome('device');
    const operatorChrome = await openChrome('operator');

    const WAITING = `(() => {
      const screen = document.querySelector('[data-pairing-waiting]');
      if (!screen) return null;
      const text = (selector) => {
        const node = screen.querySelector(selector);
        return node ? node.textContent.trim() : null;
      };
      return {
        state: screen.getAttribute('data-state'),
        code: text('[data-pairing-code]'),
        askAgain: text('[data-pairing-ask-again]'),
        all: screen.textContent.replace(/\\s+/g, ' ').trim(),
        board: document.querySelector('.app') !== null,
      };
    })()`;

    await stage('3. the waiting screen on the device asking', async () => {
      await deviceChrome.navigate(`http://${external}:${open.port}/`);
      const waiting = await settle(async () => {
        const value = await deviceChrome.evaluate(WAITING);
        return value?.state === 'waiting' ? value : null;
      });
      await deviceChrome.shot('02-device-waiting');

      check('the page loads on a machine this board does not answer for', Boolean(waiting),
            JSON.stringify(waiting));
      check('and what loads is the waiting screen rather than the board',
            waiting?.board === false, String(waiting?.board));
      check('it says it is waiting', /waiting/i.test(String(waiting?.all ?? '')),
            String(JSON.stringify(waiting?.all ?? "")).slice(0, 300));
      check('and where to go and approve it',
            /approve/i.test(String(waiting?.all ?? '')), String(JSON.stringify(waiting?.all ?? "")).slice(0, 300));
      check('and it shows a code', Boolean(waiting?.code), JSON.stringify(waiting?.code));

      await operatorChrome.navigate(`http://127.0.0.1:${open.port}/?t=${encodeURIComponent(open.token)}`);
      const dialog = await settle(async () => {
        const value = await operatorChrome.evaluate(DIALOG);
        return value?.code ? value : null;
      });
      await operatorChrome.shot('03-operator-dialog');

      check('the code shown on the two ends is the same string', dialog?.code === waiting?.code,
            `host ${JSON.stringify(dialog?.code)} vs device ${JSON.stringify(waiting?.code)}`);
      check('and the operator is shown the authority the device reached this board under',
            String(dialog?.host ?? '').includes(external), JSON.stringify(dialog?.host));
      check('and the address it arrived from', String(dialog?.address ?? '').includes(external),
            JSON.stringify(dialog?.address));

      // 4. Refused, and asked again.
      console.log('\n4. a device the operator refused says so, and offers to ask again');
      await operatorChrome.evaluate(clickOn('[data-pairing-refuse]'));
      const refused = await settle(async () => {
        const value = await deviceChrome.evaluate(WAITING);
        return value?.state === 'refused' ? value : null;
      });
      await deviceChrome.shot('04-device-refused');
      check('the device says it was refused rather than sitting on a spinner',
            /refus/i.test(String(refused?.all ?? '')), String(JSON.stringify(refused?.all ?? "")).slice(0, 300));
      check('and offers to ask again', Boolean(refused?.askAgain), JSON.stringify(refused));

      await deviceChrome.evaluate(clickOn('[data-pairing-ask-again]'));
      const asking = await settle(async () => {
        const value = await deviceChrome.evaluate(WAITING);
        return value?.state === 'waiting' && value.code && value.code !== refused?.code ? value : null;
      });
      check('asking again puts a new code on both screens', Boolean(asking?.code),
            JSON.stringify(asking?.code));

      const second = await settle(async () => {
        const value = await operatorChrome.evaluate(DIALOG);
        return value?.code && value.code === asking?.code ? value : null;
      });
      check('and the operator sees the same new string',
            Boolean(asking?.code) && second?.code === asking?.code,
            `host ${JSON.stringify(second?.code)} vs device ${JSON.stringify(asking?.code)}`);

      await operatorChrome.evaluate(clickOn('[data-pairing-approve]'));

      // The device collects the credential on its next poll and reloads. What it is *then* able
      // to drive is the rest of this milestone's — #501 moved the guard to the caller, and its
      // answer to a remote socket is still "refused", credential or no credential — so what is
      // asserted here is that the gesture completed and left the device holding a credential of
      // its own, rather than asking over and over.
      const held = await settle(async () => {
        const value = await deviceChrome.evaluate(
          'window.localStorage.getItem("vibemaxxing.device.credential")');
        return value || null;
      });
      await deviceChrome.shot('05-device-paired');
      check('the device collects a credential of its own and keeps it', Boolean(held),
            JSON.stringify(held ? '<credential>' : held));

      const devices = readJson(conventionalStateFile(pairHome, 'devices.json'))?.devices ?? [];
      const secret = String(held).split('.')[1] ?? '';
      const record = devices.find((entry) => entry.id === String(held).split('.')[0]);
      check('and it is the one the board wrote down, by its hash',
            Boolean(record) && record.secretHash === createHash('sha256').update(secret).digest('hex'),
            JSON.stringify(record ?? devices));
      check('and the authority it was approved for is the one it reached the board under',
            String(record?.host ?? '').includes(external), JSON.stringify(record?.host));

      const settled = await deviceChrome.evaluate(WAITING);
      check('a device that holds a credential does not go on asking',
            settled === null || settled.state !== 'waiting', JSON.stringify(settled));
    });

    deviceChrome.close();
    operatorChrome.close();
  }

  hostChrome.close();
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.stack ?? error.message}`);
} finally {
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  for (const server of servers) server.stop();
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  if (process.env.PAIRING_SURFACES_LOG) console.error(log);
  process.exit(1);
}
console.log('All pairing surface checks passed.');
