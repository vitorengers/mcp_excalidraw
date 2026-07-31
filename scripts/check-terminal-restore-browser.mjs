#!/usr/bin/env node
/**
 * Checks that the terminal block survives being erased, and that there is a way back in.
 *
 * The observation behind #93 is two things at once. The block can be erased — `locked` is
 * the only thing Excalidraw's eraser respects, and locking the block would take away the
 * drag and the corner resize that *are* the interface. And nothing put it back except one
 * hotkey written down only in markdown, which was inert in exactly the cases that need it:
 * a shell that had exited, and a board that never opened a session at all.
 *
 * Erasing the block never killed the shell. So what an erase used to leave behind was a
 * running process with the one-per-board slot still taken, its output accumulating into
 * state nothing drew, and — because the keyboard reaches the shell only through the overlay
 * — no way to Ctrl+C whatever was running in it.
 *
 * Only a browser can answer any of this, which is why it is here and not in
 * `check-terminal.mjs`: the eraser is a pointer gesture, the block coming back is a scene
 * update, and "the same shell" is a pid on the far side of both. Chrome is driven over the
 * DevTools protocol the way `check-terminal-browser.mjs` does. Self-contained otherwise: it
 * builds a throwaway workspace, starts its own canvas server and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-terminal-restore-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Distinctive enough that finding it in a transcript means something. */
const MARKER = 'terminal-survives-the-eraser';

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-restore-'));
const projectDir = join(workDir, 'restore-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'restore-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Restore Project',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

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

/** One request, with two more goes at it. See `check-terminal-browser.mjs`. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}) => request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
  headers: { 'Content-Type': 'application/json' },
  ...options,
});

/**
 * The board's one session, in the shape this file was written against.
 *
 * `GET /api/terminal` lists sessions since #94, because a board may hold several. Nothing
 * here opens a second one, so the first is *the* session — and `session: null` still means
 * "none", which is what most of the cases below turn on.
 */
const terminalState = async () => {
  const body = await (await api('/api/terminal')).json();
  const [session] = body?.sessions ?? [];
  return { session: session ?? null, scrollback: session?.scrollback ?? '' };
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
}

/** A drag, in steps: the eraser takes what the pointer *crosses*, not where it lands. */
async function drag(from, to, steps = 20) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(400);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(50);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(250);
}

/** The imperative API, through the container's React fibre. See check-board-drafts-browser. */
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
        window.__terminalCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null, authored: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    } else if (!custom.kind) {
      out.authored.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.tool = state.activeTool ? state.activeTool.type : null;
  out.sentinel = window.__noReloadSentinel || null;

  const card = document.querySelector('.terminal-card');
  if (card) {
    const box = card.getBoundingClientRect();
    const body = card.querySelector('.terminal-card__body');
    const bodyBox = body ? body.getBoundingClientRect() : null;
    out.card = {
      left: box.left, top: box.top, width: box.width, height: box.height,
      // The way into the shell since #112, and the only one since #144 took the strip along
      // the bottom of the block away.
      screenAt: bodyBox
        ? { x: bodyBox.left + bodyBox.width / 2, y: bodyBox.top + bodyBox.height / 2 }
        : null,
      // What a block with no shell left says, at the home #144 gave it: over the transcript
      // rather than in a row of its own, so the frame does not change height when a shell
      // dies. The sentence is the same one, and it is still the only place Alt+T is written
      // down where a reader will be looking.
      hint: (card.querySelector('.terminal-card__ended') || {}).textContent || '',
      where: (card.querySelector('.terminal-card__where') || {}).textContent || '',
      // The rendered screen alone. The body also holds the stylesheet the emulator injects
      // for its palette, which is text as far as textContent is concerned.
      screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
    };
  } else {
    out.card = null;
  }
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const occurrences = (haystack, needle) => String(haystack ?? '').split(needle).length - 1;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so the block has content to be placed away from.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 200, height: 140,
                           backgroundColor: '#a5d8ff', text: 'the board' }),
  });

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
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  // A mark on this document. Every case below asserts it is still there, because "with no
  // reload" is the whole of what makes a recovery a recovery.
  await evaluate('window.__noReloadSentinel = "kept"');

  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');

  // A viewport that shows the block, and room to its left.
  //
  // Since #96 the block sits a mirror's width to the *left* of the board's own content, so
  // the view a board opens at does not contain it and every coordinate below would be
  // dispatched at empty canvas. Placed by hand rather than with Alt+T: the eraser case drags
  // right across the block and a control shape beyond it, and fitting the block alone leaves
  // no room on either side for that.
  {
    const opening = await evaluate(PROBE);
    const zoom = 0.7;
    await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${360 / zoom - opening.block.x}, scrollY: ${(150 - opening.view.offsetTop) / zoom - opening.block.y}, zoom: { value: ${zoom} } } })`);
    await sleep(400);
  }

  console.log('0. a shell with something in its transcript');
  let scene = await evaluate(PROBE);
  await click(scene.card.screenAt.x, scene.card.screenAt.y);
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(500);
  await typeText(`echo ${MARKER}`);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => occurrences((await evaluate(PROBE)).card?.screen, MARKER) >= 2,
                'the shell to answer the echo');
  const before = await terminalState();
  check('the session has a pid to compare against', Number.isFinite(before.session?.pid),
        JSON.stringify(before.session));
  check('and the marker is in the scrollback the server holds',
        occurrences(before.scrollback, MARKER) >= 2, String(before.scrollback ?? '').slice(-200));

  scene = await evaluate(PROBE);
  const placed = { ...scene.block };
  const placedCard = { left: scene.card.left, top: scene.card.top };
  await shot('01-before-erase');

  console.log('\n1. the real eraser takes the block, and the block comes back');
  // A control shape in the eraser's path, so a drag that erased nothing cannot pass this
  // case by leaving the block where it already was.
  // Centred on the line the pointer will take, or the drag passes under it and the case
  // proves nothing about the eraser.
  const control = await (await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: Math.round(placed.x - 180),
                           y: Math.round(placed.y + placed.h / 2 - 55),
                           width: 111, height: 111, backgroundColor: '#ffd8a8' }),
  })).json();
  await waitFor(async () => (await evaluate(PROBE)).authored.some((element) => element.w === 111),
                'the control shape to reach the canvas');

  // Clicking the canvas takes the keyboard back from the shell — an emulator with focus
  // swallows the eraser's own shortcut, exactly as it swallows Alt+T.
  await click(40, 700);
  await pressKey('KeyE', 'e', 0, 69, 'e');
  scene = await evaluate(PROBE);
  check('the eraser is the active tool', scene.tool === 'eraser', String(scene.tool));

  const from = toViewport(scene, control.element ? control.element.x - 40 : placed.x - 260,
                          placed.y + placed.h / 2);
  const to = toViewport(scene, placed.x + placed.w - 30, placed.y + placed.h / 2);
  await drag(from, to);
  await pressKey('KeyV', 'v', 0, 86, 'v');
  await shot('02-erased');

  await waitFor(async () => !(await evaluate(PROBE)).authored.some((element) => element.w === 111),
                `the control shape to be erased (dragged ${JSON.stringify(from)} → ${JSON.stringify(to)}`
                + ` across a ${scene.view.width}×${scene.view.height} viewport)`, 20);
  check('the drag really did erase what it crossed',
        !(await evaluate(PROBE)).authored.some((element) => element.w === 111),
        'the control shape is still on the canvas, so this case proved nothing');

  const restored = await waitFor(async () => (await evaluate(PROBE)).block, 'the block to come back');
  check('the block is on the board again', Boolean(restored), JSON.stringify(restored));
  check('and where it was, rather than re-anchored somewhere else',
        Math.abs(restored.x - placed.x) < 1 && Math.abs(restored.y - placed.y) < 1
        && Math.abs(restored.w - placed.w) < 1 && Math.abs(restored.h - placed.h) < 1,
        `${JSON.stringify(placed)} → ${JSON.stringify(restored)}`);

  const back = await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to come back');
  check('the overlay came with it', Math.abs(back.left - placedCard.left) < 2
        && Math.abs(back.top - placedCard.top) < 2,
        `${JSON.stringify(placedCard)} → ${JSON.stringify({ left: back.left, top: back.top })}`);
  await shot('03-restored');

  const after = await terminalState();
  check('it is the same shell, not a new one', after.session?.pid === before.session?.pid,
        `${before.session?.pid} → ${after.session?.pid}`);
  check('with the transcript it had', occurrences(after.scrollback, MARKER) >= 2,
        String(after.scrollback ?? '').slice(-200));
  check('and the block draws that transcript again',
        occurrences(back.screen, MARKER) >= 2, String(back.screen).slice(-200));
  check('none of which was a reload', (await evaluate(PROBE)).sentinel === 'kept');

  console.log('\n2. and the restored block is still derived');
  // The erase was a real edit by a real pointer, so the autosync has run by now.
  await sleep(2600);
  const stored = await (await api('/api/elements')).json();
  check('the authored shape is in the store',
        stored.elements.some((element) => element.width === 200), String(stored.count));
  check('the terminal block is not',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData)));

  console.log('\n3. a shell that exited can be replaced without a reload');
  scene = await evaluate(PROBE);
  await click(scene.card.screenAt.x, scene.card.screenAt.y);
  await typeText('exit');
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => (await terminalState()).session === null, 'the shell to exit');
  const gone = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.card && /gone/.test(probe.card.hint) ? probe : null;
  }, 'the block to say the shell has gone');
  await shot('04-exited');
  check('the block says the shell has gone', /gone/.test(gone.card.hint), gone.card.hint);
  check('and says on the block itself how to get another',
        /alt\+t/i.test(gone.card.hint), gone.card.hint);

  // The keyboard is in the emulator after typing `exit`, and Alt+T there is a keystroke for
  // the shell rather than a jump. Clicking the canvas is how a reader gives it back.
  await click(40, 700);
  await pressKey('KeyT', 't', 1, 84);
  const opened = await waitFor(async () => (await terminalState()).session, 'a new session to open');
  check('the key opened a new session', Number.isFinite(opened.pid), JSON.stringify(opened));
  check('a different shell from the one that exited', opened.pid !== before.session?.pid,
        `${before.session?.pid} → ${opened.pid}`);
  check('still no reload', (await evaluate(PROBE)).sentinel === 'kept');
  const running = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.card && !/gone/.test(probe.card.hint) ? probe : null;
  }, 'the block to stop saying the shell has gone');
  check('and the block is live again', Boolean(running.block) && !/gone/.test(running.card.hint),
        running.card.hint);
  await shot('05-reopened');

  console.log('\n4. and a board that never opened one at all');
  await api('/api/terminal', { method: 'DELETE' });
  await waitFor(async () => (await terminalState()).session === null, 'the session to close');

  // The board's own attempt is made to fail, which is the honest way to reach the state the
  // issue names: no session was ever opened here, so there is no block and no overlay, and
  // the key is the only thing left that can start one.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const original = window.fetch;
      window.fetch = function (input, init) {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (!window.__allowTerminalOpen && method === 'POST' && /\\/api\\/terminal(\\?|$)/.test(url)) {
          return Promise.reject(new Error('the check refused this one'));
        }
        return original.apply(this, arguments);
      };
    })()`,
  });
  await send('Page.reload');
  await sleep(1500);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the reload');
  await evaluate('window.__noReloadSentinel = "kept-after-reload"');
  await sleep(2500);

  scene = await evaluate(PROBE);
  await shot('06-no-session');
  check('no session is open', (await terminalState()).session === null);
  check('so there is no block', scene.block === null, JSON.stringify(scene.block));
  check('and no overlay', scene.card === null, JSON.stringify(scene.card));

  await evaluate('window.__allowTerminalOpen = true');
  await pressKey('KeyT', 't', 1, 84);
  const fromNothing = await waitFor(async () => (await terminalState()).session,
                                    'the key to open a session on a board that had none');
  check('the key opens one anyway', Number.isFinite(fromNothing.pid), JSON.stringify(fromNothing));
  const drawn = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.block && probe.card ? probe : null;
  }, 'the block and its overlay to be drawn');
  check('and the block is drawn for it', Boolean(drawn.block), JSON.stringify(drawn.block));
  check('with the overlay over it',
        Math.abs(drawn.card.left - toViewport(drawn, drawn.block.x, drawn.block.y).x) < 2
        && Math.abs(drawn.card.top - toViewport(drawn, drawn.block.x, drawn.block.y).y) < 2,
        `card at ${drawn.card.left},${drawn.card.top}`);
  // Waited for rather than read the moment the block appears. The key scrolls with
  // `animate: true`, and since #96 the block is far enough from where a board opens that
  // half way through the animation it is still off screen — it used to land a few hundred
  // units from the origin, close enough that the assertion held before the scroll had
  // finished. A block that never arrives still fails this, on the timeout.
  const arrived = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    if (!probe.block) return null;
    const centre = toViewport(probe, probe.block.x + probe.block.w / 2, probe.block.y + probe.block.h / 2);
    return centre.x > 0 && centre.x < probe.view.width ? probe : null;
  }, 'Alt+T to scroll the block into view');
  check('and it is in the viewport, because the key scrolls to it as well', Boolean(arrived),
        JSON.stringify(arrived && toViewport(arrived, arrived.block.x, arrived.block.y)));
  check('and nothing reloaded to get there', arrived.sentinel === 'kept-after-reload');
  await shot('07-opened-from-nothing');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  // The server's own output, because the most confusing way for this to fail is a `fetch
  // failed` from a canvas server that died, which says nothing about why.
  if (server.exitCode !== null) console.error(`the canvas server exited (${server.exitCode}):\n${serverLog}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
