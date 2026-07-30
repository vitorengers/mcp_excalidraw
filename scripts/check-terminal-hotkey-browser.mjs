#!/usr/bin/env node
/**
 * Checks who owns the board's four keys while the terminal has the keyboard, in a real browser.
 *
 * The keyboard sibling of `check-terminal-focus-browser.mjs`, and #177 is the observation it
 * exists for: with the terminal focused, `Alt+B`, `Alt+T`, `Alt+P` and `Alt+G` did nothing to
 * the board. Three layers had to agree before they could, and each of them was a real stop:
 *
 * - **the guard on the four `window` listeners** stood down for any focused `TEXTAREA`, and a
 *   focused xterm *is* one — the emulator takes the keyboard through a hidden
 *   `.xterm-helper-textarea`;
 * - **the card stops `keydown` propagating**, and React's `stopPropagation` calls the native
 *   one, so the event died at the React root and never reached `window` at all. The issue did
 *   not name this one; it is why fixing only the guard changes nothing a reader can see;
 * - **xterm would still have written the meta escape to the shell**, so a fixed board would
 *   have jumped *and* left an `ESC b` on the reader's command line.
 *
 * So the questions here are the ones only a browser answers, and none of them is "did a
 * handler run":
 *
 * - **does the viewport actually move?** Read off `scrollX`/`scrollY`/`zoom`, once per chord,
 *   with real keystrokes into a focused emulator.
 * - **did the shell get anything?** The server's own `scrollback` is byte-compared across all
 *   four presses, and every `POST /api/terminal/input` the page makes is recorded — the four
 *   chords have to send nothing at all.
 * - **did the emulator keep the keyboard?** A command typed straight afterwards has to run.
 * - **is everything else still the shell's?** `Ctrl+C` still interrupts, and `Alt+click` still
 *   reaches the shell — the two the scope of #177 explicitly leaves alone.
 * - **and does the guard still guard?** `Alt+P` typed into a card's bound label is a keystroke,
 *   not a jump. That case is the whole reason the guard exists, and the fix must not spend it.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-hotkey-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project with a terminal and two sections ───────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-hotkey-'));
const projectDir = join(workDir, 'hotkey-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'hotkey-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board. The
// one this check needs is put into the scene by hand below, which is where a real one lives
// too — a mirror is derived, so it is never in the store.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Hotkey Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = 36400 + (process.pid % 250);
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
    EXCALIDRAW_TERMINAL: '1',
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

/** One request, with two more goes at it — see check-terminal-focus-browser. */
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

/** The server's own transcript, which is the byte-exact one. The screen is a rendering. */
async function scrollbackOf() {
  const body = await (await api('/api/terminal')).json();
  return (body?.sessions ?? []).map((session) => session.scrollback ?? '').join('\u0000');
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

async function click(x, y, modifiers = 0) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1, modifiers });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0, modifiers });
  await sleep(250);
}

async function doubleClick(x, y) {
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  }
  await sleep(400);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(25);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** `Alt` is modifier bit 1 in the DevTools protocol. `Ctrl` is 2. */
const ALT = 1;
const CTRL = 2;

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
        window.__hotkeyCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Every byte the page hands the shell, recorded at the one door they all go through.
 *
 * `POST /api/terminal/input` is that door — `flushTerminalInput` in `App.tsx`. Counting here
 * rather than diffing the screen is what makes "the chord was not sent" a statement about the
 * chord rather than about whether this machine's shell happened to echo it.
 */
const HOOK_INPUT = `(() => {
  if (window.__shellBytes) return true;
  window.__shellBytes = [];
  const real = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/api/terminal/input') && init && typeof init.body === 'string') {
      try { window.__shellBytes.push(JSON.parse(init.body).data); }
      catch { window.__shellBytes.push(init.body); }
    }
    return real(input, init);
  };
  return true;
})()`;

/** Where the board is, what has focus, and what the screen says. */
const PROBE = `(() => {
  const api = window.__hotkeyCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null, mirror: 0, sections: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    }
    if (custom.kind === 'project-board') out.mirror++;
    if (custom.kind === 'board-section') out.sections.push(custom.hotkeyCode);
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.tool = state.activeTool ? state.activeTool.type : null;
  out.editing = Boolean(state.editingTextElement);

  const card = document.querySelector('.terminal-card');
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  out.card = card ? {
    box: boxOf(card),
    body: boxOf(card.querySelector('.terminal-card__body')),
    header: boxOf(card.querySelector('.terminal-card__header')),
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
  } : null;
  const active = document.activeElement || {};
  out.focused = String(active.className || '');
  out.focusedTag = String(active.tagName || '');
  out.sent = (window.__shellBytes || []).length;
  return out;
})()`;

const viewMoved = (before, after) =>
  Math.abs(after.scrollX - before.scrollX) > 2
  || Math.abs(after.scrollY - before.scrollY) > 2
  || Math.abs(after.zoom - before.zoom) > 0.005;

const viewSummary = (before, after) =>
  `${JSON.stringify({ x: Math.round(before.scrollX), y: Math.round(before.scrollY), z: before.zoom })}`
  + ` → ${JSON.stringify({ x: Math.round(after.scrollX), y: Math.round(after.scrollY), z: after.zoom })}`;

/**
 * The board where this check wants it, and low in the window on purpose.
 *
 * Excalidraw draws its hint across the top of the canvas whenever something is selected, and
 * a press that lands on that strip never reaches the shape underneath.
 */
async function placeBoard(zoom = 0.6) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__hotkeyCheckApi.updateScene({ appState: { scrollX: ${300 / zoom - scene.block.x}, scrollY: ${(280 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
}

/**
 * The mirror, drawn into the scene rather than stored.
 *
 * A real one is rebuilt from GitHub on every poll and stripped before every save, so the store
 * is the wrong place to put one. This board has no `githubProject`, which means the poll
 * answers 404 and `clearMirror` takes this shape away again every twenty seconds — so it is
 * put back immediately before the press that needs it rather than once at the start.
 */
async function ensureMirror(around) {
  await evaluate(`(() => {
    const api = window.__hotkeyCheckApi;
    const scene = api.getSceneElements();
    if (scene.some((element) => (element.customData || {}).kind === 'project-board')) return true;
    const seed = scene[0];
    api.updateScene({ elements: [...scene, {
      ...seed,
      id: 'hotkey-check-mirror',
      type: 'rectangle',
      x: ${around.x}, y: ${around.y}, width: ${around.width}, height: ${around.height},
      angle: 0, seed: 12345, version: 1, versionNonce: 12345, isDeleted: false,
      boundElements: null, containerId: null, groupIds: [], frameId: null, link: null, locked: false,
      customData: { kind: 'project-board', role: 'region' },
    }] });
    return true;
  })()`);
  await sleep(300);
}

/** Focus the emulator, from a board placed where the block is reachable. */
async function focusTerminal() {
  const scene = await placeBoard();
  await click(scene.card.body.x, scene.card.body.y);
  return evaluate(PROBE);
}

/** Something to interrupt, and something to say the shell survived being interrupted. */
const LONG_WAIT = isWindows
  ? "Start-Sleep -Seconds 25; Write-Output ('SUR'+'VIVED')"
  : 'sleep 25; echo "SUR""VIVED"';
const MARKER = isWindows
  ? "Write-Output ('IN'+'TERRUPTED')"
  : 'echo "IN""TERRUPTED"';
const AFTERWARDS = isWindows
  ? "Write-Output ('STILL'+'TYPING')"
  : 'echo "STILL""TYPING"';

/** The four the board claims, in the order the reader met them. */
const CHORDS = [
  { name: 'Alt+B (the mirror)', code: 'KeyB', key: 'b', vk: 66, needsMirror: true },
  { name: 'Alt+T (the terminal)', code: 'KeyT', key: 't', vk: 84 },
  { name: 'Alt+P (Project structure)', code: 'KeyP', key: 'p', vk: 80 },
  { name: 'Alt+G (Development)', code: 'KeyG', key: 'g', vk: 71 },
];

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so the block has content to be placed away from, and a card with a
  // bound label — the case the guard on all four listeners exists for.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 260, height: 160,
                           backgroundColor: '#a5d8ff', text: 'a card with a title' }),
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
  await send('Page.bringToFront');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await evaluate(HOOK_INPUT);

  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');

  /**
   * The two sections and the mirror, drawn **around** the block rather than away from it.
   *
   * Each is a different size, so `scrollToContent(fitToViewport)` lands on a different zoom
   * and a different scroll and the jump is unmistakable. Each also *contains* the block, and
   * that is the load-bearing part: a jump that took the block off screen would unmount the
   * card, and an unmounting emulator writes a focus report to the shell — bytes this check
   * would then have to explain away, in the one case that has to be able to say "the shell
   * was sent nothing at all".
   */
  const block = (await evaluate(PROBE)).block;
  const around = (padX, padY) => ({
    x: Math.round(block.x - padX), y: Math.round(block.y - padY),
    width: Math.round(block.w + padX * 2), height: Math.round(block.h + padY * 2),
  });
  const MIRROR_REGION = around(220, 160);

  // Authored through the store, because that is where a section lives: it is board content,
  // and `docs/board.excalidraw` carries the real ones.
  for (const section of [
    { hotkeyCode: 'KeyP', title: 'Project structure', box: around(520, 380) },
    { hotkeyCode: 'KeyG', title: 'Development', box: around(1400, 1000) },
  ]) {
    await api('/api/elements', {
      method: 'POST',
      body: JSON.stringify({
        type: 'rectangle', ...section.box,
        backgroundColor: 'transparent', strokeColor: '#868e96',
        customData: { kind: 'board-section', title: section.title, hotkeyCode: section.hotkeyCode },
      }),
    });
  }
  await waitFor(async () => (await evaluate(PROBE)).sections.length === 2, 'both sections to reach the scene');

  console.log('1. the terminal has the keyboard, and it has it as a TEXTAREA');
  let scene = await focusTerminal();
  await shot('01-focused');
  check('the emulator has the focus', /xterm/.test(scene.focused), scene.focused);
  // Named rather than implied: this is the whole of layer one. The guard on all four
  // listeners stood down on exactly this tag, which is why it could not tell a shell from
  // a card's title.
  check('and what has it is a TEXTAREA, which is what the old guard could not see past',
        scene.focusedTag === 'TEXTAREA', scene.focusedTag);

  // A shell has a REPL to start, and keystrokes into one that is still starting go nowhere.
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt');
  await sleep(700);

  console.log('\n2. each of the four moves the viewport, with the terminal focused');
  const before = { scrollback: await scrollbackOf(), sent: (await evaluate(PROBE)).sent };
  for (const chord of CHORDS) {
    scene = await focusTerminal();
    if (chord.needsMirror) { await ensureMirror(MIRROR_REGION); scene = await evaluate(PROBE); }
    const focused = scene.focused;
    const view = scene.view;
    await pressKey(chord.code, chord.key, ALT, chord.vk);
    await sleep(900);
    const after = await evaluate(PROBE);
    check(`${chord.name} moved the board`, viewMoved(view, after.view),
          `${viewSummary(view, after.view)} (focus was ${focused || '<none>'})`);
  }
  await shot('02-after-the-four');

  console.log('\n3. and the shell was handed none of it');
  const sentDuring = await evaluate(`(window.__shellBytes || []).slice(${before.sent})`);
  // Named one by one rather than counted: `ESC b` is what xterm writes for Alt+B, and it is
  // the `ESC b` left on the reader's command line that made fixing only the guard the wrong
  // half of the fix.
  const metaEscapes = CHORDS.map((chord) => `${chord.key}`);
  check('not one of the four meta escapes reached the shell',
        !sentDuring.some((sent) => metaEscapes.some((escape) => String(sent).includes(escape))),
        JSON.stringify(sentDuring));
  check('and the shell was sent nothing at all', sentDuring.length === 0, JSON.stringify(sentDuring));
  check('so the shell\'s own transcript is byte-identical',
        (await scrollbackOf()) === before.scrollback,
        `${before.scrollback.length} → ${(await scrollbackOf()).length} bytes`);

  console.log('\n4. the emulator kept the keyboard, so typing still reaches the shell');
  scene = await focusTerminal();
  check('the emulator still has the focus after four jumps', /xterm/.test(scene.focused), scene.focused);
  await run(AFTERWARDS);
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).includes('STILLTYPING'),
                'the shell to answer a command typed after the four chords', 80);
  scene = await evaluate(PROBE);
  await shot('03-typed-after');
  check('a command typed straight afterwards ran',
        String(scene.card.screen).includes('STILLTYPING'), String(scene.card.screen).slice(-200));
  check('and none of it reached Excalidraw\'s tools', scene.tool === 'selection', String(scene.tool));

  console.log('\n5. everything else is still the shell\'s');
  await run(LONG_WAIT);
  await sleep(1500);
  await pressKey('KeyC', 'c', CTRL, 67);
  await sleep(800);
  await run(MARKER);
  await waitFor(async () => String((await evaluate(PROBE)).card.screen).includes('INTERRUPTED'),
                'the shell to take a command again after the interrupt', 60);
  scene = await evaluate(PROBE);
  check('Ctrl+C still interrupts the shell',
        !String(scene.card.screen).includes('SURVIVED'), String(scene.card.screen).slice(-300));

  {
    // Alt+click is the other one #177 leaves alone. What it does depends on the shell, so
    // what is asked here is the part that does not: the click still reaches the emulator and
    // the emulator still speaks to the shell. A chord swallowed for the board would send
    // nothing at all.
    scene = await focusTerminal();
    await typeText('abcdefghij');
    await sleep(300);
    const sentBefore = (await evaluate(PROBE)).sent;
    const viewBefore = (await evaluate(PROBE)).view;
    await click(scene.card.body.left + 12, scene.card.body.top + 10, ALT);
    await sleep(500);
    const afterClick = await evaluate(PROBE);
    check('Alt+click still reaches the shell', afterClick.sent > sentBefore,
          `${sentBefore} → ${afterClick.sent}`);
    check('and it did not move the board instead', !viewMoved(viewBefore, afterClick.view),
          viewSummary(viewBefore, afterClick.view));
    await pressKey('Escape', 'Escape', 0, 27);
    await pressKey('KeyU', 'u', CTRL, 85);
  }

  console.log('\n6. the guard still guards: Alt+P in a card\'s label is a keystroke, not a jump');
  {
    // The authored card, wherever the board put it — found on the scene rather than assumed,
    // and scrolled to rather than hoped for: the board has been sitting on the terminal
    // block, which is placed well away from a board's own content.
    await evaluate(`(() => {
      const api = window.__hotkeyCheckApi;
      const state = api.getAppState();
      const found = api.getSceneElements().find((element) =>
        element.type === 'rectangle' && element.width === 260 && element.height === 160);
      if (!found) return false;
      api.updateScene({ appState: { zoom: { value: 1 },
        scrollX: 500 - found.x, scrollY: 420 - state.offsetTop - found.y } });
      return true;
    })()`);
    await sleep(500);
    const card = await evaluate(`(() => {
      const api = window.__hotkeyCheckApi;
      const state = api.getAppState();
      const found = api.getSceneElements().find((element) =>
        element.type === 'rectangle' && element.width === 260 && element.height === 160);
      if (!found) return null;
      return { x: (found.x + found.width / 2 + state.scrollX) * state.zoom.value + state.offsetLeft,
               y: (found.y + found.height / 2 + state.scrollY) * state.zoom.value + state.offsetTop };
    })()`);
    check('the card with a label is on screen to be typed into',
          Boolean(card) && card.x > 0 && card.y > 0, JSON.stringify(card));
    await doubleClick(card.x, card.y);
    const editing = await evaluate(PROBE);
    await shot('04-editing-label');
    check('double-clicking it opened Excalidraw\'s own editor',
          editing.editing || /wysiwyg/.test(editing.focused),
          `${editing.editing} / ${editing.focused}`);
    const viewBeforeLabel = editing.view;
    await pressKey('KeyP', 'p', ALT, 80);
    await sleep(900);
    const afterLabel = await evaluate(PROBE);
    check('Alt+P typed into the label did not jump the board',
          !viewMoved(viewBeforeLabel, afterLabel.view), viewSummary(viewBeforeLabel, afterLabel.view));
    await pressKey('Escape', 'Escape', 0, 27);
  }

  console.log('\n7. and none of it was ever stored');
  await sleep(2400);
  const stored = await (await api('/api/elements')).json();
  check('the sections are in the store',
        stored.elements.filter((element) => element.customData?.kind === 'board-section').length === 2,
        String(stored.count));
  check('the terminal block is not',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData?.kind)));
  check('and neither is the mirror',
        !stored.elements.some((element) => element.customData?.kind === 'project-board'),
        JSON.stringify(stored.elements.map((element) => element.customData?.kind)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
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
