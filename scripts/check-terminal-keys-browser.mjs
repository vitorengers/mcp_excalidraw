#!/usr/bin/env node
/**
 * Checks the word-motion and line-editing chords the terminal block sends to the shell.
 *
 * The keyboard sibling of `check-terminal-hotkey-browser.mjs`, and #186 is the observation it
 * exists for: `Ctrl+Backspace` deleted one character instead of a word, and the macOS `Cmd`
 * chords did nothing at all. Both were xterm.js defaults nobody here had ever looked at —
 * `attachCustomKeyEventHandler` claimed the four board keys, `Ctrl+C` and `Ctrl+V`, and handed
 * everything else over. What xterm hands over is not always a chord any line editor answers:
 *
 * - `Ctrl+Backspace` was `\b`, which is also `Ctrl+H`, which readline reads as
 *   `backward-delete-char` — one character. ConPTY rewrites it into a `VK_BACK + LEFT_CTRL`
 *   key event so PSReadLine did the right thing, which is why this only ever looked broken
 *   against `bash`.
 * - `Cmd+Left` and `Cmd+Right` were dropped on the floor (`if (ev.metaKey) break;`), and
 *   `Cmd+Backspace` sent `\x7f` — one character again, because that branch never consults
 *   `metaKey`.
 * - `Shift+Enter` was a bare `\r`, the same byte as Enter, because `case 13` reads only
 *   `altKey`. That is #238: a reader asking for a line break submitted instead. Same shape,
 *   same place, and the sequence the fix sends — `ESC CR` — is the one xterm has been
 *   sending for `Alt+Enter` all along.
 *
 * So there are two questions here and they need two different instruments:
 *
 * - **what does the page send?** Real keystrokes into a focused emulator, and every
 *   `POST /api/terminal/input` recorded at the one door they all go through. That is a
 *   statement about the chord rather than about whichever shell this machine happens to run,
 *   and it is the only half a Mac chord can be asked about from a Windows box at all — so the
 *   macOS table is asked for a second time with `navigator.platform` emulated (`Emulation.
 *   setUserAgentOverride`), and skipped with a printed reason if the override does not take.
 * - **does the shell move?** A known line typed into a real shell, the chord pressed, and the
 *   server's own scrollback asserted to hold what the motion would leave. That is the half a
 *   byte table cannot answer: `\x17` and `ESC DEL` are both "delete a word" and only one of
 *   them survives ConPTY. The PowerShell/ConPTY path runs through the browser; `bash` runs
 *   over the API against a WSL-backed workspace when a distro exists, and prints why it is
 *   skipped when none does.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-keys-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: wsl
 */

import { execFileSync, spawn } from 'node:child_process';
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

/** Control characters, spelled so a failure prints something a reader can compare. */
const readable = (text) => JSON.stringify(
  String(text).replace(/\x1b/g, '<ESC>').replace(/\x17/g, '<^W>').replace(/\x15/g, '<^U>')
    .replace(/\x08/g, '<^H>').replace(/\x7f/g, '<DEL>').replace(/\x03/g, '<^C>')
    .replace(/\r/g, '<CR>').replace(/\x07/g, '<BEL>'));

// ─── The chords, and the bytes each one is supposed to send ───

/**
 * One table, read twice: once as this machine's own platform and once as a Mac.
 *
 * `mac` and `other` are the same string wherever the answer does not depend on the reader's
 * keyboard, which is most of it — the divergences are the two places where one line editor
 * answers a sequence the other one prints:
 *
 * - `Alt` is `Option` on a Mac and a third-level shift everywhere else, so the `Option`
 *   entries are ours only on a Mac; off it they stay xterm's, which is what they already were.
 * - `Cmd+Backspace` is "delete to the start of the line", and there is no one sequence for it:
 *   readline answers `^U` and prints `^U` under ConPTY, PSReadLine answers `ESC[1;5H`
 *   (`Ctrl+Home`) and readline ignores it silently. Measured, both ways, in both shells.
 */
const CHORDS = [
  { name: 'Ctrl+Left', code: 'ArrowLeft', key: 'ArrowLeft', vk: 37, modifier: 'ctrl',
    mac: '\x1b[1;5D', other: '\x1b[1;5D', intent: 'word left' },
  { name: 'Ctrl+Right', code: 'ArrowRight', key: 'ArrowRight', vk: 39, modifier: 'ctrl',
    mac: '\x1b[1;5C', other: '\x1b[1;5C', intent: 'word right' },
  { name: 'Ctrl+Backspace', code: 'Backspace', key: 'Backspace', vk: 8, modifier: 'ctrl',
    mac: '\x17', other: '\x17', intent: 'delete the word to the left' },
  { name: 'Ctrl+Delete', code: 'Delete', key: 'Delete', vk: 46, modifier: 'ctrl',
    mac: '\x1b[3;5~', other: '\x1b[3;5~', intent: 'delete the word to the right' },

  { name: 'Alt/Option+Left', code: 'ArrowLeft', key: 'ArrowLeft', vk: 37, modifier: 'alt',
    mac: '\x1bb', other: '\x1b[1;5D', intent: 'word left' },
  { name: 'Alt/Option+Right', code: 'ArrowRight', key: 'ArrowRight', vk: 39, modifier: 'alt',
    mac: '\x1bf', other: '\x1b[1;5C', intent: 'word right' },
  { name: 'Alt/Option+Backspace', code: 'Backspace', key: 'Backspace', vk: 8, modifier: 'alt',
    mac: '\x1b\x7f', other: '\x1b\x7f', intent: 'delete the word to the left' },
  { name: 'Alt/Option+Delete', code: 'Delete', key: 'Delete', vk: 46, modifier: 'alt',
    mac: '\x1bd', other: '\x1b[3;3~', intent: 'delete the word to the right' },

  { name: 'Cmd+Left', code: 'ArrowLeft', key: 'ArrowLeft', vk: 37, modifier: 'meta',
    mac: '\x1b[H', other: '\x1b[H', intent: 'the start of the line' },
  { name: 'Cmd+Right', code: 'ArrowRight', key: 'ArrowRight', vk: 39, modifier: 'meta',
    mac: '\x1b[F', other: '\x1b[F', intent: 'the end of the line' },
  { name: 'Cmd+Backspace', code: 'Backspace', key: 'Backspace', vk: 8, modifier: 'meta',
    mac: '\x15', other: '\x1b[1;5H', intent: 'delete to the start of the line' },

  // #238, and the one row with `Shift` in it. xterm's `case 13` reads only `altKey`, so
  // Shift+Enter and Enter were the same bare `\r` and every program behind the block read
  // them as one keystroke — a submit where a line break was meant. `ESC CR` is what Claude
  // Code's own `/terminal-setup` writes into VS Code, Cursor, Alacritty and Zed, and it is
  // byte for byte what xterm already sends for `Alt+Enter`. Not keyboard-conditional: the
  // two extended-key encodings are, because a program that never asked for them prints them.
  { name: 'Shift+Enter', code: 'Enter', key: 'Enter', vk: 13, modifier: 'shift',
    mac: '\x1b\r', other: '\x1b\r', intent: 'a line break, not a submit' },
];

/** `Alt` is modifier bit 1 in the DevTools protocol, `Ctrl` 2, `Meta` 4, `Shift` 8. */
const MODIFIER_BIT = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-keys-'));
const projectDir = join(workDir, 'keys-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const WORKSPACE = 'keys-project';
const WSL_WORKSPACE = 'keys-wsl';

/**
 * A WSL-backed workspace, when this machine has a distro — the only way to reach `bash`.
 *
 * A workspace whose path is a `\\wsl.localhost\<distro>\...` UNC is WSL-backed
 * (`src/core/workspace-paths.ts`), and `defaultShellCommand` gives one `bash` rather than
 * PowerShell. That is the whole point: `Ctrl+Backspace` was only ever broken against
 * readline, and a check that never runs one is checking the shell that already worked.
 */
function findDistro() {
  if (!isWindows) return null;
  try {
    const listed = execFileSync('wsl.exe', ['-l', '-q'], { encoding: 'utf16le', timeout: 20000 });
    const names = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    // `docker-desktop` is a distro by name and not a place anybody's shell lives.
    return names.find((name) => !/^docker/i.test(name)) ?? null;
  } catch { return null; }
}

/**
 * A throwaway project *inside* the distro, reached over the UNC share.
 *
 * A workspace is only usable with a `board.config.json` in it, so the registry cannot simply
 * point at `/tmp`. Written through `\\wsl.localhost\...` rather than through `wsl.exe` so the
 * same `writeFileSync` builds it as builds the Windows one; returns null if the share is not
 * reachable, which is what a distro that has never been started looks like.
 */
function makeWslProject(name) {
  if (!name) return null;
  const inner = `\\\\wsl.localhost\\${name}\\tmp\\mcp-excalidraw-keys-check`;
  try {
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, 'board.config.json'), JSON.stringify({
      name: 'Keys WSL', repo: 'vitorengers/mcp_excalidraw',
    }), 'utf8');
    return inner;
  } catch { return null; }
}

const distro = findDistro();
const wslProject = makeWslProject(distro);
const workspaces = [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }];
if (wslProject) workspaces.push({ id: WSL_WORKSPACE, path: wslProject });

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({ workspaces }), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Keys Project',
  repo: 'vitorengers/mcp_excalidraw',
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

/** One request, with two more goes at it — see check-terminal-focus-browser. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}, workspace = WORKSPACE) =>
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

/** The server's own transcript, which is the byte-exact one. The screen is a rendering. */
async function scrollbackOf(workspace = WORKSPACE) {
  const body = await (await api('/api/terminal', {}, workspace)).json();
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

/**
 * The clipboard permission, granted over the **browser** target rather than the page's.
 *
 * Section 5 asks that `Ctrl+V` still pastes, and a paste with nothing on the clipboard is a
 * case that passes for the wrong reason. `Browser.grantPermissions` is refused on a page
 * session — same arrangement as `check-terminal-focus-browser.mjs`.
 */
async function grantClipboard() {
  const endpoint = await waitFor(async () =>
    (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl,
  'the Chrome browser target');
  await new Promise((resolve, reject) => {
    const browserSocket = new WebSocket(endpoint);
    browserSocket.once('open', () => browserSocket.send(JSON.stringify({
      id: 1,
      method: 'Browser.grantPermissions',
      params: { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] },
    })));
    browserSocket.once('message', () => { browserSocket.close(); resolve(); });
    browserSocket.once('error', reject);
  });
}

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
  await sleep(220);
}

const pressChord = (chord) => pressKey(chord.code, chord.key, MODIFIER_BIT[chord.modifier], chord.vk);

/** A line, ending in the carriage return a terminal actually sends for Enter. */
const enter = () => pressKey('Enter', 'Enter', 0, 13, '\r');

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
        window.__keysCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** Every byte the page hands the shell, recorded at the one door they all go through. */
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
  const api = window.__keysCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { block: null };
  for (const element of api.getSceneElements()) {
    if ((element.customData || {}).kind === 'terminal') {
      out.block = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  const card = document.querySelector('.terminal-card');
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  out.card = card ? {
    body: boxOf(card.querySelector('.terminal-card__body')),
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
  } : null;
  const active = document.activeElement || {};
  out.focused = String(active.className || '');
  out.sent = (window.__shellBytes || []).length;
  out.platform = String((navigator.userAgentData && navigator.userAgentData.platform)
                        || navigator.platform || '');
  return out;
})()`;

/**
 * The board where this check wants it, and low in the window on purpose.
 *
 * Excalidraw draws its hint across the top of the canvas whenever something is selected, and
 * a press that lands on that strip never reaches the shape underneath.
 */
async function placeBoard(zoom = 0.6) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__keysCheckApi.updateScene({ appState: { scrollX: ${300 / zoom - scene.block.x}, scrollY: ${(280 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
}

/** Focus the emulator, from a board placed where the block is reachable. */
async function focusTerminal() {
  const scene = await placeBoard();
  await click(scene.card.body.x, scene.card.body.y);
  return evaluate(PROBE);
}

/** Everything the page has sent since `from`, as one string. Batching is the page's business. */
const sentSince = async (from) =>
  (await evaluate(`(window.__shellBytes || []).slice(${from}).join('')`)) ?? '';

/**
 * The page ready to be typed into again: no half-written line, nothing selected.
 *
 * `Ctrl+C` rather than `Ctrl+U`, and that is one of this issue's own measurements: PSReadLine
 * has no binding for `^U` and prints it, so the tidy-up would leave behind exactly the kind of
 * junk it is there to remove. `Ctrl+C` cancels the line in both editors.
 */
async function clearLine() {
  await pressKey('Escape', 'Escape', 0, 27);
  await pressKey('KeyC', 'c', MODIFIER_BIT.ctrl, 67);
  await sleep(400);
}

/** Attach the recorder and find the block. Run again after every reload. */
async function readyPage() {
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await evaluate(HOOK_INPUT);
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');
  // Generously, and not for the shell's sake: this runs three times, and the two after the
  // first are a reload, where the page has to reconnect and replay the transcript before
  // anything is on the screen at all.
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt', 320);
  await sleep(700);
}

/**
 * The whole table, pressed once each, against whatever platform the page believes it is on.
 *
 * Read off what the page *sent* rather than off what the screen shows: the screen is this
 * machine's shell answering, and the question here is what the block put on the wire.
 */
async function assertTable(label, side) {
  await focusTerminal();
  for (const chord of CHORDS) {
    const before = (await evaluate(PROBE)).sent;
    await pressChord(chord);
    await sleep(400);
    const sent = await sentSince(before);
    check(`${label}: ${chord.name} sends ${readable(chord[side])} (${chord.intent})`,
          sent === chord[side], `sent ${readable(sent)}`);
  }
  await clearLine();
}

// ─── The shell half, in whichever shell ───────────────────────

/**
 * A line typed at a real prompt, a motion made, and the line finished off — then run.
 *
 * The marker is glued together out of two pieces on purpose, the way the other terminal
 * checks do it: the shell echoes every character typed at it, so a marker that appears in
 * the typed line as well as in the output proves nothing about which one the assertion
 * found. `('A'+'A foo K1')` is echoed as itself and printed as `AA foo K1`.
 */
function scenarios(shell) {
  const open = shell === 'bash' ? 'echo "A""A ' : "Write-Output ('A'+'A ";
  const close = shell === 'bash' ? '"' : "')";
  return [
    // Two acceptable answers, and the difference is the whole of assumption 6 on the issue:
    // readline's `unix-word-rubout` takes the whitespace before the word with it and
    // PSReadLine's `BackwardKillWord` leaves it. Both deleted the *word*, which is what is
    // being asked; neither leaves `ba` or `baz` behind, which is what failure looks like.
    { name: 'Ctrl+Backspace deletes a word, not a character',
      typed: `${open}foo baz`, chords: ['Ctrl+Backspace'], then: `K1${close}`,
      expect: ['AA foo K1', 'AA fooK1'] },
    { name: 'Ctrl+Delete deletes the word to the right',
      typed: `${open}foo baz`, chords: ['Ctrl+Left', 'Ctrl+Delete'], then: `K2${close}`,
      expect: ['AA foo K2'] },
    { name: 'Ctrl+Left steps back over a word',
      typed: `${open}foo baz`, chords: ['Ctrl+Left'], then: 'K3', end: true, after: close,
      expect: ['AA foo K3baz'] },
    { name: 'Cmd+Left reaches the start of the line',
      typed: `${open.slice(1)}K4${close}`, chords: ['Cmd+Left'], then: open.slice(0, 1),
      expect: ['AA K4'] },
    // Started from a cursor that is genuinely not at the end, and closed with a character
    // *after* the tail rather than before it. A `Cmd+Right` that does nothing would then
    // close the string early, and neither shell prints `zzz-` out of that.
    { name: 'Cmd+Right reaches the end of the line',
      typed: `${open}K5 zzz`, chords: ['Ctrl+Left', 'Cmd+Right'], then: `-${close}`,
      expect: ['AA K5 zzz-'] },
    { name: 'Cmd+Backspace clears back to the start',
      typed: 'qqq', chords: ['Cmd+Backspace'], then: `${open}K6${close}`, expect: ['AA K6'] },
    // #238, and last in the list on purpose: a shell that ended up at a continuation prompt
    // because this one failed takes every case after it down with it.
    //
    // Neither line editor *inserts* a break for `ESC CR` — measured, both ways: PSReadLine
    // does nothing at all with it and readline rings the bell. What is being asked here is
    // the half that matters at a prompt, which is that it does not **submit** and does not
    // clear: the line survives the chord and runs whole. `AA onetwo` is the tell, and it is
    // the one answer neither of the other outcomes produces — a bare `\r` submits
    // `...('A'+'A one` and both shells then open a continuation prompt, so the finished
    // string carries a newline and prints as `AA one` / `two` across two lines.
    { name: 'Shift+Enter leaves the line alone rather than running it',
      typed: `${open}one`, chords: ['Shift+Enter'], then: `two${close}`,
      expect: ['AA onetwo'] },
  ];
}

/** Did any of the answers this scenario accepts turn up in the shell's own transcript? */
async function sawAny(scenario, workspace) {
  const transcript = await scrollbackOf(workspace);
  return scenario.expect.some((wanted) => transcript.includes(wanted));
}

const chordNamed = (name) => CHORDS.find((chord) => chord.name === name);

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
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await grantClipboard();
  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');

  // Two sections, so `Alt+P` and `Alt+G` are keys this board actually owns — section 5 asks
  // whether the new table stepped on them, and a board with no marks would answer "no"
  // because there was nothing there to step on.
  for (const section of [
    { hotkeyCode: 'KeyP', title: 'Project structure', box: { x: -600, y: -400, width: 900, height: 700 } },
    { hotkeyCode: 'KeyG', title: 'Development', box: { x: -600, y: 400, width: 900, height: 700 } },
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

  await readyPage();

  console.log('1. the byte table, on this machine\'s own platform');
  await assertTable('here', isWindows || process.platform === 'linux' ? 'other' : 'mac');
  await shot('01-table-native');

  console.log('\n2. the same table, with the page told it is on a Mac');
  {
    // The `Option` and `Cmd` conventions are a reader's keyboard rather than a server's
    // shell, and this box has no Mac on it. What the page *sends* is still assertable —
    // `navigator.platform` is what decides it, and CDP can say what that reads.
    const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
                   + ' (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    try {
      await send('Emulation.setUserAgentOverride', {
        userAgent: MAC_UA,
        platform: 'MacIntel',
        userAgentMetadata: { platform: 'macOS', platformVersion: '14.0', architecture: 'x86',
                             model: '', mobile: false, brands: [] },
      });
    } catch {
      // Older builds reject `userAgentMetadata`; the two fields that matter are the others.
      await send('Emulation.setUserAgentOverride', { userAgent: MAC_UA, platform: 'MacIntel' });
    }
    await send('Page.reload');
    await sleep(1500);
    await readyPage();
    const seen = (await evaluate(PROBE)).platform;
    if (!/mac/i.test(seen)) {
      console.log(`  SKIP  the macOS table — the platform override did not take (page reads "${seen}")`);
    } else {
      await assertTable('as a Mac', 'mac');
      await shot('02-table-mac');
    }
    await send('Emulation.setUserAgentOverride', { userAgent: '', platform: '' });
    await send('Page.reload');
    await sleep(1500);
    await readyPage();
  }

  console.log('\n3. Enter is still a submit, and Shift+Enter is no longer one');
  {
    // The byte half of #238 is two assertions and they mean something only together: a table
    // that claimed Enter as well would send `ESC CR` for both and break every prompt there
    // is. What Shift+Enter sends is asserted by the table above, twice over; what is left to
    // ask is that the key underneath it was not touched on the way.
    await focusTerminal();
    const before = (await evaluate(PROBE)).sent;
    await enter();
    await sleep(400);
    const plain = await sentSince(before);
    check('Enter still sends a bare CR', plain === '\r', `sent ${readable(plain)}`);

    // And the shell half, asked the plainest way there is: a **complete** command, then
    // Shift+Enter. A bare CR runs it there and then; `ESC CR` does not, in either editor.
    await clearLine();
    const marker = isWindows ? "Write-Output ('A'+'A K7')" : 'echo "A""A K7"';
    await typeText(marker);
    await sleep(300);
    await pressChord(chordNamed('Shift+Enter'));
    await sleep(1400);
    check('a finished command is not run by Shift+Enter', !(await scrollbackOf()).includes('AA K7'),
          'the shell ran it, so the chord reached it as a bare CR');
    await enter();
    let ranOnEnter = false;
    try { await waitFor(async () => (await scrollbackOf()).includes('AA K7'), 'AA K7', 40); ranOnEnter = true; }
    catch { /* reported below */ }
    check('and the Enter after it still runs it', ranOnEnter,
          `never saw "AA K7" — tail was ${readable((await scrollbackOf()).slice(-220))}`);
    await clearLine();
  }

  console.log(`\n4. and the shell moves: ${isWindows ? 'PowerShell over ConPTY' : 'the login shell'}`);
  {
    const shell = isWindows ? 'powershell' : 'bash';
    for (const scenario of scenarios(shell)) {
      await focusTerminal();
      await typeText(scenario.typed);
      await sleep(300);
      for (const name of scenario.chords) await pressChord(chordNamed(name));
      await sleep(300);
      if (scenario.then) await typeText(scenario.then);
      if (scenario.end) { await pressKey('End', 'End', 0, 35); await typeText(scenario.after); }
      await enter();
      let seen = false;
      try { await waitFor(() => sawAny(scenario), scenario.expect.join(' or '), 40); seen = true; }
      catch { /* reported below */ }
      check(scenario.name, seen, seen ? ''
            : `never saw ${scenario.expect.map((one) => `"${one}"`).join(' or ')} — tail was `
              + readable((await scrollbackOf()).slice(-220)));
      await clearLine();
    }
    await shot('03-shell-moved');
  }

  console.log('\n5. the four board keys are still the board\'s, and Ctrl+V is still a paste');
  {
    // The neighbouring checks own these; what is asked here is only that a table inserted
    // *before* the AltGr bail did not step on any of them.
    await focusTerminal();
    let before = (await evaluate(PROBE)).sent;
    for (const [code, key, vk] of [['KeyB', 'b', 66], ['KeyT', 't', 84], ['KeyP', 'p', 80], ['KeyG', 'g', 71]]) {
      await pressKey(code, key, MODIFIER_BIT.alt, vk);
    }
    await sleep(500);
    check('Alt+B/T/P/G sent the shell nothing', (await sentSince(before)) === '',
          readable(await sentSince(before)));

    // `Ctrl+V` used to be asserted here as sending nothing, and since #224 that is no longer
    // the contract: the chord is still left to the browser, but *what the shell gets* is
    // decided at the paste, where the clipboard's contents are knowable — text pastes, a
    // screenshot sends `\x16`, and `check-terminal-paste-browser.mjs` owns that rule. So the
    // clipboard is given a known string and the question here is only that the table did not
    // step on the chord: nothing reached the shell but the text.
    const PASTED = 'keys-check-paste';
    const loaded = await evaluate(`(async () => {
      try { await navigator.clipboard.writeText(${JSON.stringify(PASTED)}); return { ok: true }; }
      catch (error) { return { ok: false, why: String((error && error.message) || error) }; }
    })()`);
    before = (await evaluate(PROBE)).sent;
    await pressKey('KeyV', 'v', MODIFIER_BIT.ctrl, 86);
    await sleep(600);
    // `includes` rather than equality: a shell with bracketed paste on has xterm wrapping the
    // text in `ESC[200~`/`ESC[201~`, which is the shell's business and not this chord's.
    const pasted = await sentSince(before);
    if (loaded?.ok) {
      check('Ctrl+V sent the shell nothing but the text on the clipboard',
            pasted.includes(PASTED) && !pasted.includes('\x16'), readable(pasted));
    } else {
      check('Ctrl+V on a clipboard this machine would not load sent the shell nothing',
            pasted === '', readable(pasted));
      console.log(`  note  the clipboard write was refused (${loaded?.why ?? 'no reason given'}),`
                  + ' so the text half was not asked here.');
    }
    await clearLine();
  }

  console.log('\n6. and the same bytes move readline, not only PSReadLine');
  if (!wslProject) {
    console.log(`  SKIP  ${distro ? `the "${distro}" share was not reachable` : 'no WSL distro on this machine'},`
                + ' so `bash` was not run.');
    console.log('        `Ctrl+Backspace` is the one that was only ever broken there.');
  } else {
    /**
     * Over the API rather than through the browser, and that is the honest split.
     *
     * The page renders one board at a time and this shell lives in a second workspace, so
     * driving it in Chrome would mean a second page. The chord half is already settled
     * above — what is left to ask of `bash` is whether the bytes that table sends actually
     * move a readline, and `POST /api/terminal/input` asks exactly that.
     */
    const created = await api('/api/terminal', { method: 'POST', body: JSON.stringify({}) }, WSL_WORKSPACE);
    const body = await created.json();
    const sessionId = body?.session?.id ?? body?.sessions?.[0]?.id ?? null;
    check('a bash session opened in the WSL workspace', Boolean(sessionId),
          `${created.status} ${JSON.stringify(body).slice(0, 200)}`);
    if (sessionId) {
      const write = (data) => api('/api/terminal/input', {
        method: 'POST', body: JSON.stringify({ sessionId, data }),
      }, WSL_WORKSPACE);
      await waitFor(async () => (await scrollbackOf(WSL_WORKSPACE)).includes('$'),
                    'the bash prompt', 80);
      for (const scenario of scenarios('bash')) {
        await write(scenario.typed);
        await sleep(300);
        for (const name of scenario.chords) {
          // `Cmd+Backspace` is the one sequence that differs, and on a Mac keyboard in
          // front of a readline it is the `mac` side that gets sent.
          const chord = chordNamed(name);
          await write(chord.name === 'Cmd+Backspace' ? chord.mac : chord.other);
          await sleep(200);
        }
        if (scenario.then) await write(scenario.then);
        if (scenario.end) { await write('\x1b[F'); await write(scenario.after); }
        await write('\r');
        let seen = false;
        try { await waitFor(() => sawAny(scenario, WSL_WORKSPACE), scenario.expect.join(' or '), 40); seen = true; }
        catch { /* reported below */ }
        check(`bash: ${scenario.name}`, seen, seen ? ''
              : `never saw ${scenario.expect.map((one) => `"${one}"`).join(' or ')} — tail was `
                + readable((await scrollbackOf(WSL_WORKSPACE)).slice(-220)));
        await write('\x15');
        await sleep(200);
      }
    }
  }
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
