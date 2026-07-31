#!/usr/bin/env node
/**
 * Checks that the block in front of the PTY is a terminal, in a real browser.
 *
 * `check-terminal-pty.mjs` proves the shell gets a tty. That is half of #75 and on its own
 * it makes things worse: a shell on a tty writes cursor moves, colours and alternate-screen
 * switches, and a `<pre>` renders every one of those bytes as characters to look at. The
 * screenshot in the issue already showed the smaller version of it — `[33m` and `[39m` on
 * screen as literal text.
 *
 * So the three questions here are the ones only a browser answers:
 *
 * - **is the escape stream interpreted?** A command emitting SGR must arrive as a colour,
 *   and the literal `[33m` must appear nowhere in the block's DOM.
 * - **can a key that is not a line be pressed?** Ctrl+C is the one that matters — with a
 *   PTY and no way to send it, a reader who starts something long has no way out of it.
 * - **is the block still a block?** A terminal emulator brings its own DOM and its own
 *   pointer handling, and losing the shape underneath is the regression that most plausibly
 *   causes. Since #112 the emulator has the pointer over its screen and the header is the
 *   band that selects and drags the block, so that is where this asks.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own
 * canvas server and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-ansi-browser.mjs [--chrome <path>] [--shots <dir>]
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
const isWindows = process.platform === 'win32';

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

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-ansi-'));
const projectDir = join(workDir, 'ansi-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'ansi-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'ANSI Project',
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

/**
 * One request, with two more goes at it.
 *
 * Not a retry of the *case* — a 4xx comes straight back. This is for the connection itself,
 * which on this machine occasionally refuses with `fetch failed` while several servers and a
 * headless Chrome are competing for sockets. Reported as a case failure that says nothing,
 * it reads as the feature being broken.
 */
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
  await sleep(250);
}

/** A drag, in steps: Excalidraw resizes on pointer moves, not on where the pointer lands. */
async function drag(from, to, steps = 12) {
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
  await sleep(300);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(20);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** A line, ending in the carriage return a terminal actually sends for Enter. */
async function run(line) {
  await typeText(line);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
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
        window.__ansiCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * What the block looks like from the outside.
 *
 * `screen` is the emulator's own text — what a reader sees — and `styled` is every span in
 * it that carries a colour, which is the difference between an escape that was interpreted
 * and one that was printed.
 */
const PROBE = `(() => {
  const api = window.__ansiCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null };
  for (const element of api.getSceneElements()) {
    if ((element.customData || {}).kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  const card = document.querySelector('.terminal-card');
  if (!card) return { ...out, card: null };
  const box = card.getBoundingClientRect();
  const body = card.querySelector('.terminal-card__body');
  const bodyBox = body ? body.getBoundingClientRect() : null;
  const header = card.querySelector('.terminal-card__header');
  const headerBox = header ? header.getBoundingClientRect() : null;
  out.card = {
    left: box.left, top: box.top, width: box.width, height: box.height,
    pointerEvents: body ? getComputedStyle(body).pointerEvents : null,
    headerPointerEvents: header ? getComputedStyle(header).pointerEvents : null,
    // Low in the header and in from the left: the middle of the row is where the font
    // buttons and the mode chip are, and those do take the pointer.
    header: headerBox
      ? { x: headerBox.left + 6, y: headerBox.top + headerBox.height - 2 }
      : null,
    // The way into the shell since #112, and the only one since #144 took the strip along
    // the bottom of the block away.
    screenAt: bodyBox
      ? { x: bodyBox.left + bodyBox.width / 2, y: bodyBox.top + bodyBox.height / 2 }
      : null,
    emulator: Boolean(card.querySelector('.xterm')),
    dom: card.textContent || '',
    // The rendered screen alone. The card's own textContent also holds the stylesheet the
    // emulator injects for its palette, which is text as far as textContent is concerned.
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
    styled: Array.from(card.querySelectorAll('span'))
      .filter((span) => (span.textContent || '').includes('YELLOW'))
      .map((span) => ({ className: span.className, color: getComputedStyle(span).color })),
  };
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/**
 * The commands, spelled so their own echo cannot answer the question.
 *
 * The block shows what was typed as well as what came back, so a command containing the
 * literal `ESC [ 3 3 m` would put that text on screen by itself and satisfy — or in this
 * case break — an assertion about it. Every marker word is joined from halves for the same
 * reason `check-terminal.mjs` does it.
 */
const script = isWindows
  ? {
    escapeVariable: '$e=[char]27',
    coloured: "Write-Output ($e+'['+'33'+'m'+'YEL'+'LOW'+$e+'['+'39'+'m')",
    long: "Start-Sleep -Seconds 25; Write-Output ('SUR'+'VIVED')",
    marker: "Write-Output ('IN'+'TERRUPTED')",
  }
  : {
    escapeVariable: "e=$(printf '\\033')",
    coloured: "printf '%s[%sm%s%s[%sm\\n' \"$e\" 33 YEL LOW \"$e\" 39",
    long: 'sleep 25; echo "SUR""VIVED"',
    marker: 'echo "IN""TERRUPTED"',
  };

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

  console.log('1. the block draws a terminal emulator, not a transcript');
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');
  // Alt+T, so the block is at a readable zoom and fully on screen before anything is typed.
  await pressKey('KeyT', 't', 1, 84);
  await sleep(1400);
  let scene = await evaluate(PROBE);
  await shot('01-placed');
  check('there is an emulator in the block', scene.card.emulator === true,
        `no .xterm inside the card: ${String(scene.card.dom).slice(0, 120)}`);
  check('and its screen takes the pointer, so a click in it is the shell\'s',
        scene.card.pointerEvents === 'auto', String(scene.card.pointerEvents));
  check('while the header does not, so the shape underneath is still a shape',
        scene.card.headerPointerEvents === 'none' && Boolean(scene.card.header),
        String(scene.card.headerPointerEvents));

  console.log('\n2. clicking that screen puts the keyboard in the terminal');
  await click(scene.card.screenAt.x, scene.card.screenAt.y);
  scene = await evaluate(PROBE);
  check('the emulator has the focus', /xterm/.test(scene.focused), scene.focused);

  // A shell on a terminal has a REPL to start, and keystrokes sent into one that is still
  // starting go nowhere. A reader waits for the prompt to be drawn; so does this.
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(500);

  console.log('\n3. an SGR escape arrives as a colour, not as four characters');
  await run(script.escapeVariable);
  await sleep(600);
  await run(script.coloured);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('YELLOW'),
                'the coloured word to be drawn');
  scene = await evaluate(PROBE);
  await shot('02-coloured');
  check('the word came back', String(scene.card.screen).includes('YELLOW'),
        String(scene.card.screen).slice(-200));
  check('the escape itself is nowhere on screen',
        !String(scene.card.dom).includes('[33m') && !String(scene.card.dom).includes('[39m')
        && !String(scene.card.dom).includes(String.fromCharCode(0x1b)),
        JSON.stringify(String(scene.card.dom).slice(-300)));
  check('and it was applied: the word is drawn in a colour of its own',
        scene.card.styled.some((span) => /xterm-fg-|xterm-bold/.test(span.className)),
        JSON.stringify(scene.card.styled));

  console.log('\n4. Ctrl+C gets out of something that is still running');
  await run(script.long);
  await sleep(1500);
  await pressKey('KeyC', 'c', 2, 67);
  await sleep(800);
  await run(script.marker);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('INTERRUPTED'),
                'the shell to answer after the interrupt', 60);
  scene = await evaluate(PROBE);
  await shot('03-interrupted');
  check('the shell took a command again, so the interrupt reached it',
        String(scene.card.screen).includes('INTERRUPTED'), String(scene.card.screen).slice(-200));
  check('and the long command never finished, because it was killed rather than waited out',
        !String(scene.card.screen).includes('SURVIVED'), String(scene.card.screen).slice(-300));

  console.log('\n5. and the block is still a block: its corner still resizes it');

  // A viewport of this case's own, rather than whatever the board was left at.
  //
  // The corner handle sits *on* the block's bottom-right vertex, so the press has to be that
  // point converted back — and `(clientX / zoom) - scrollX` does not always give the vertex
  // back exactly. A tenth of a picometre past it reads as the shape rather than the handle,
  // and the block moves instead of growing: the case then fails on floating point rather than
  // on anything the code did. Round numbers, chosen here, convert back exactly.
  {
    // 0.5 rather than the 0.8 it was: since #199 a fresh block is 30 rows of 18px text, a
    // thousand scene units tall, and at 0.8 its bottom-right corner sat below a 950-tall window.
    const zoom = 0.5;
    await evaluate(`window.__ansiCheckApi.updateScene({ appState: { scrollX: ${300 / zoom - scene.block.x}, scrollY: ${(150 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
    await sleep(400);
    scene = await evaluate(PROBE);
  }

  await click(scene.card.header.x, scene.card.header.y);
  scene = await evaluate(PROBE);
  check('clicking the header selects the block through the overlay',
        scene.selected.includes(scene.block.id), JSON.stringify(scene.selected));

  const before = { w: scene.block.w, h: scene.block.h };
  const corner = toViewport(scene, scene.block.x + scene.block.w, scene.block.y + scene.block.h);
  // A few pixels *outside* the corner rather than exactly on it: the handle is a square
  // centred there, so both land on it, but the point exactly on the corner is also the card's own
  // last pixel, and which of the two takes the press is a rounding — one the block size decides,
  // and #199 changed the block size. See check-terminal-geometry-browser.
  await drag({ x: corner.x + 5, y: corner.y + 5 }, { x: corner.x + 185, y: corner.y + 125 });
  scene = await evaluate(PROBE);
  await shot('04-resized');
  check('dragging its corner still resizes it',
        scene.block.w > before.w + 50 && scene.block.h > before.h + 30,
        `${before.w}×${before.h} → ${scene.block.w}×${scene.block.h}`);
  check('and the overlay grew with it',
        Math.abs(scene.card.width - scene.block.w * scene.view.zoom) < 2
        && Math.abs(scene.card.height - scene.block.h * scene.view.zoom) < 2,
        `card ${scene.card.width}×${scene.card.height} for block ${scene.block.w}×${scene.block.h}`);

  const grid = await waitFor(async () => {
    const [session] = (await (await api('/api/terminal')).json())?.sessions ?? [];
    return session && session.cols > 20 ? session : null;
  }, 'the session to report a grid');
  check('and the shell was told the size it now has',
        grid.cols > 20 && grid.rows > 5, JSON.stringify(grid));
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
