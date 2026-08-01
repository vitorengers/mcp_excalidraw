#!/usr/bin/env node
/**
 * Checks that `Clear Canvas` asks first, and that nothing it empties is gone for good.
 *
 * The button used to be one press with no dialog behind it, and one press cost the whole
 * board. That was survivable while the store was memory only: a drawing is somebody's to
 * redraw. Since #225 every board is written back to disk a second after it changes, so the
 * press reaches the *file* — the store empties, the save listener fires, and
 * `<workspace>.excalidraw` beside the registry is rewritten with an empty element list a
 * second later. The only recovery the product had was `restore_snapshot`, which clears the
 * canvas before restoring and reports `canvas was cleared` when the restore fails.
 *
 * Four questions, and each of them is one of the four things #345 asks for:
 *
 *   1. does a press with elements on the board open a confirmation that names *this* board
 *      and how many elements it is about to take, rather than asking "are you sure?" — and
 *      does dismissing it leave the store and the disk exactly as they were;
 *   2. does a confirmed clear leave a copy of what was there beside the board's saved state,
 *      and does the canvas say where it went — a backup nobody is told about is a backup
 *      nobody restores;
 *   3. does `DELETE /api/elements/clear` take that copy *itself*? The guard belongs in the
 *      UI and the copy in the route, because the MCP `clear_canvas` tool, the CLI's
 *      `clear --yes` and `restore_snapshot` all go through the route with no confirmation of
 *      any kind, and a dialog in front of the route would break an agent-facing contract;
 *   4. and are snapshots per board? They were one module-level Map keyed by name across every
 *      workspace, so a snapshot named `before` taken on one board was read — and silently
 *      overwritten — from another.
 *
 * Sections 1 and 2 are the browser: the guard is a control, and a control that compiles is
 * not a control that opens. Sections 3 and 4 are HTTP against the same server, because that
 * is the whole of the surface they are about.
 *
 * Counts are read from the board rather than assumed. A board draws things this check never
 * seeded — the project mirror is elements too — so what the dialog has to agree with is what
 * `GET /api/elements` says at the moment it opened, not the number of rectangles posted here.
 *
 * Self-contained: a throwaway registry and project directory, its own canvas server on a port
 * the kernel just handed out, its own Chrome profile, all killed at the end. The saved-board
 * directory is the one the registry derives — `workspaces.json` keeps its boards in
 * `workspaces-state/` beside it — so the copy is asserted where a real board would put it.
 * Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first: it loads the
 * built frontend.
 *
 * Usage: node scripts/check-clear-canvas-guard.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── A board with somewhere to save ───────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-clear-guard-'));
const projectDir = join(workDir, 'clear-guard');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
/** What `boardStateDir()` derives from that registry: the directory the copy must land in. */
const stateDir = join(workDir, 'workspaces-state');

const WORKSPACE = 'clear-guard';
const BOARD_NAME = 'Clear Guard';

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: BOARD_NAME,
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = startCanvas({
  env: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
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

const api = (path, options = {}) => fetch(`${BASE}${path}`, {
  headers: { 'Content-Type': 'application/json' },
  ...options,
});

const json = async (path, options) => (await api(path, options)).json();

/** Every element id a workspace's store currently holds. */
async function idsOn(workspace) {
  const body = await json(`/api/elements?workspace=${encodeURIComponent(workspace)}`);
  return (body.elements ?? []).map((element) => element.id);
}

async function seed(workspace, text, x) {
  const body = await json(`/api/elements?workspace=${encodeURIComponent(workspace)}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x, y: 0, width: 160, height: 100, text }),
  });
  return body.element.id;
}

/** The copies this board has beside its saved state, newest last. */
const copies = () => (existsSync(stateDir) ? readdirSync(stateDir) : [])
  .filter((name) => /^clear-guard\.cleared-.*\.excalidraw$/.test(name))
  .sort();

/** Every element id a copy on disk holds. */
const idsIn = (file) => (JSON.parse(readFileSync(file, 'utf8')).elements ?? [])
  .map((element) => element.id);

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();
const consoleLog = [];

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
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
      consoleLog.push(`${message.params.type}: ${text}`);
      return;
    }
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

/** A real press at a measured centre. The label-versus-box trap is already paid for here. */
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
}

/**
 * The page as this check reads it: where the three controls are, what the dialog says, and
 * everything the board has told the reader in words.
 *
 * `innerText` of the whole page for the last of those, because the toast `sayOnCanvas` raises
 * is Excalidraw's own and this check has no business knowing its class name.
 */
const PROBE = `(() => {
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height };
  };
  // By its words, not by a class this change introduces: the button is found the same way
  // whether or not the guard is there, so a missing guard fails the case about the guard
  // rather than the harness that looks for the button.
  const button = Array.from(document.querySelectorAll('.header button'))
    .find((node) => (node.textContent || '').trim() === 'Clear Canvas') || null;
  const confirm = document.querySelector('.clear-canvas__confirm');
  return {
    button: boxOf(button),
    buttonLabel: (button?.textContent || '').trim(),
    confirm: boxOf(confirm),
    confirmText: (confirm?.innerText || '').replace(/\\s+/g, ' ').trim(),
    cancel: boxOf(document.querySelector('.clear-canvas__cancel')),
    go: boxOf(document.querySelector('.clear-canvas__go')),
    said: (document.body.innerText || '').replace(/\\s+/g, ' '),
  };
})()`;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const seeded = [
    await seed(WORKSPACE, 'one', 0),
    await seed(WORKSPACE, 'two', 220),
    await seed(WORKSPACE, 'three', 440),
  ];

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  const found = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.button ? seen : null;
  }, 'the Clear Canvas button');

  console.log('1. the button is still the one the bar has always carried');
  check('it says Clear Canvas', found.buttonLabel === 'Clear Canvas', found.buttonLabel);
  check('and nothing is open in front of it', found.confirm === null, JSON.stringify(found.confirm));

  console.log('\n2. a press opens a confirmation naming this board and what it would take');
  const countBefore = (await idsOn(WORKSPACE)).length;
  await click(found.button.x, found.button.y);
  const opened = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.confirm ? seen : null;
  }, 'the confirmation to open', 40).catch(() => null);
  await shot('01-confirmation');
  check('the confirmation opened', opened !== null, (await evaluate(PROBE)).said.slice(0, 200));
  if (opened) {
    check('it names the board', opened.confirmText.includes(BOARD_NAME), opened.confirmText);
    check('and how many elements it would take',
          new RegExp(`\\b${countBefore}\\b`).test(opened.confirmText),
          `${countBefore} not in: ${opened.confirmText}`);
    check('it offers a way out as well as a way through',
          opened.cancel !== null && opened.go !== null,
          JSON.stringify({ cancel: opened.cancel, go: opened.go }));
  }

  console.log('\n3. and nothing has been deleted, in the store or on disk');
  await sleep(1500); // longer than the save debounce: a clear would already have reached disk
  {
    const still = await idsOn(WORKSPACE);
    check('every seeded element is still in the store',
          seeded.every((id) => still.includes(id)), JSON.stringify(still));
    check('and no copy has been written yet', copies().length === 0, JSON.stringify(copies()));
  }

  console.log('\n4. dismissing it changes nothing');
  if (opened?.cancel) {
    await click(opened.cancel.x, opened.cancel.y);
    const closed = await evaluate(PROBE);
    check('the confirmation closed', closed.confirm === null, JSON.stringify(closed.confirm));
    const still = await idsOn(WORKSPACE);
    check('the board is untouched', seeded.every((id) => still.includes(id)), JSON.stringify(still));
    check('and still nothing on disk', copies().length === 0, JSON.stringify(copies()));
  } else {
    check('there was a confirmation to dismiss', false, 'no way out was on the page');
  }

  console.log('\n5. a confirmed clear empties the board and leaves the copy beside its saved state');
  {
    // One press, then wait — a loop that pressed again on every attempt would toggle the
    // dialog shut as often as it opened it. Whether the press is the first of two or the
    // whole gesture, the board ends up cleared: without a guard the press alone did it, and
    // this section is about what it left behind either way.
    await click(found.button.x, found.button.y);
    const reopened = await waitFor(async () => {
      const seen = await evaluate(PROBE);
      return seen.go ? seen : null;
    }, 'the confirmation to open again', 20).catch(() => null);
    if (reopened) await click(reopened.go.x, reopened.go.y);

    const emptied = await waitFor(async () => (await idsOn(WORKSPACE)).length === 0, 'the board to empty', 40)
      .catch(() => false);
    await shot('02-cleared');
    check('the store is empty', emptied === true, JSON.stringify(await idsOn(WORKSPACE)));

    const written = await waitFor(() => (copies().length ? copies() : null), 'the copy on disk', 40)
      .catch(() => null);
    check('a copy sits beside the saved board', written !== null, `${stateDir}: ${JSON.stringify(copies())}`);
    if (written) {
      const held = idsIn(join(stateDir, written[written.length - 1]));
      check('and it holds every element that was cleared',
            seeded.every((id) => held.includes(id)), JSON.stringify(held));
      const said = (await evaluate(PROBE)).said;
      check('the canvas says where it went',
            said.includes(written[written.length - 1]), said.slice(0, 300));
    }
  }

  console.log('\n6. the route takes the same copy on its own, with nobody to confirm');
  {
    const other = 'route-copy';
    const ids = [await seed(other, 'alpha', 0), await seed(other, 'beta', 220)];
    const cleared = await json(`/api/elements/clear?workspace=${other}`, { method: 'DELETE' });
    check('the response says where the copy went',
          typeof cleared.backup === 'string' && cleared.backup.length > 0, JSON.stringify(cleared));
    if (typeof cleared.backup === 'string') {
      check('the file is there', existsSync(cleared.backup), cleared.backup);
      const held = existsSync(cleared.backup) ? idsIn(cleared.backup) : [];
      check('and holds what the route emptied', ids.every((id) => held.includes(id)), JSON.stringify(held));
    }
    check('the store is empty', (await idsOn(other)).length === 0, JSON.stringify(await idsOn(other)));
  }

  console.log('\n7. a snapshot belongs to the board it was taken on');
  {
    const a = 'snap-a';
    const b = 'snap-b';
    const onA = await seed(a, 'only on a', 0);
    const onB = await seed(b, 'only on b', 0);

    await json(`/api/snapshots?workspace=${a}`, { method: 'POST', body: JSON.stringify({ name: 'before' }) });
    await json(`/api/snapshots?workspace=${b}`, { method: 'POST', body: JSON.stringify({ name: 'before' }) });

    const fromA = await json(`/api/snapshots/before?workspace=${a}`);
    const fromB = await json(`/api/snapshots/before?workspace=${b}`);
    const heldByA = (fromA.snapshot?.elements ?? []).map((element) => element.id);
    const heldByB = (fromB.snapshot?.elements ?? []).map((element) => element.id);

    check('`before` on one board is not the other board’s `before`',
          heldByA.includes(onA) && !heldByA.includes(onB), JSON.stringify(heldByA));
    check('and taking it on the second did not overwrite the first',
          heldByB.includes(onB) && !heldByB.includes(onA), JSON.stringify(heldByB));

    const listedOnA = await json(`/api/snapshots?workspace=${a}`);
    const listedElsewhere = await json('/api/snapshots?workspace=snap-c');
    check('a board lists its own', (listedOnA.snapshots ?? []).some((entry) => entry.name === 'before'),
          JSON.stringify(listedOnA));
    check('and a board that took none lists none', (listedElsewhere.count ?? -1) === 0,
          JSON.stringify(listedElsewhere));
    check('a board that took none cannot read one either',
          (await api('/api/snapshots/before?workspace=snap-c')).status === 404,
          String((await api('/api/snapshots/before?workspace=snap-c')).status));
  }
} catch (error) {
  failures++;
  console.error(`  FAIL  the check ran to the end — ${error.message}`);
  if (consoleLog.length) console.error(`        page console:\n        ${consoleLog.slice(-12).join('\n        ')}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  if (!argOf('--shots')) { try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows lock */ } }
  else console.log(`\nScreenshots in ${shotDir}`);
}

console.log(failures === 0 ? '\nAll clear-canvas guard cases passed.' : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
