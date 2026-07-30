#!/usr/bin/env node
/**
 * Checks what a paste into a terminal block sends the shell, in a real browser.
 *
 * #224 is the observation: a screenshot on the clipboard used to reach the agent running in
 * a block with `Ctrl+V`, and after #136 only `Alt+V` did. Nothing was written for `Alt+V` —
 * it works because nothing claims it, so xterm sends `ESC v` and the program in the block
 * reads that as "go and fetch the image". What #136 changed is `Ctrl+V`: it is handed to the
 * browser on purpose, and the browser's paste into xterm reads one flavour
 * (`clipboardData.getData('text/plain')`), so a clipboard holding a bitmap and no text
 * pastes an empty string. The block then sends the program **nothing at all** — not the
 * image, which cannot travel over a PTY, and no longer the `\x16` that `Ctrl+V` has always
 * meant on a terminal.
 *
 * So the rule this asks about is written on **what the clipboard is offering** rather than
 * on the chord, and that is what makes it checkable twice over:
 *
 *  1. text on the clipboard pastes into the shell, exactly as it did — that is what #136
 *     bought, and what pasting a path or a command relies on;
 *  2. an image and no text sends `\x16`, so the program can pull the bitmap off the system
 *     clipboard itself;
 *  3. an image *and* text is a text paste, because text paste is the older promise;
 *  4. and none of that is keyed to a chord, so `Cmd+V` on a Mac behaves as `Ctrl+V` does.
 *
 * Two instruments, because the interesting half is hard to arrange and the deterministic
 * half is not:
 *
 * - **the real chord against the real clipboard.** `Browser.grantPermissions` over the
 *   browser target, `navigator.clipboard.write` with an `image/png` `ClipboardItem`, and
 *   then `Ctrl+V` and `Cmd+V` pressed for real. This is the one that answers the
 *   observation. It is skipped with a printed reason where the write is refused, since a
 *   headless clipboard is the machine's rather than this check's.
 * - **a synthesised `paste`.** A constructed `ClipboardEvent` dispatched at the emulator's
 *   own textarea, which is how `check-pasted-images-browser.mjs` asks the same kind of
 *   question. It carries whatever the case needs and needs no clipboard at all, so it runs
 *   everywhere and is the regression guard.
 *
 * Either way the assertion is read off what the page **sent** — every
 * `POST /api/terminal/input` recorded at the one door they all go through — rather than off
 * the screen, which is this machine's shell answering a question that was not asked.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-paste-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

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

/** Control characters, spelled so a failure prints something a reader can compare. */
const readable = (text) => JSON.stringify(
  String(text).replace(/\x1b/g, '<ESC>').replace(/\x16/g, '<^V>').replace(/\x15/g, '<^U>')
    .replace(/\x03/g, '<^C>').replace(/\r/g, '<CR>'));

/** What a terminal has always sent for `Ctrl+V`, and the whole of what this asks for. */
const PASTE_BYTE = '\x16';

/** A real 1×1 PNG — small, but a screenshot as far as every decision here is concerned. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * The text half, with no newline in it on purpose.
 *
 * xterm rewrites a `\n` in a paste into the `\r` a terminal sends for Enter, so a marker
 * carrying one would be a command submitted into whatever shell this machine runs rather
 * than a string this check can compare against.
 */
const PASTED_TEXT = 'a-path-from-somewhere-else';

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-paste-'));
const projectDir = join(workDir, 'paste-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const WORKSPACE = 'paste-project';

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Paste Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
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
 * `Browser.grantPermissions` is refused on a page session, and without it Chrome answers
 * `navigator.clipboard.write` with `NotAllowedError` — which section 1 would then be unable
 * to tell apart from the block never asking. Same arrangement as
 * `check-terminal-focus-browser.mjs`, which needs the write half for `Ctrl+C`.
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(250);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(250);
}

/** `Alt` is modifier bit 1 in the DevTools protocol, `Ctrl` 2, `Meta` 4. */
const MODIFIER_BIT = { alt: 1, ctrl: 2, meta: 4 };

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
        window.__pasteCheckApi = value;
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
  const api = window.__pasteCheckApi;
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
  return out;
})()`;

/**
 * The board where this check wants it, and low in the window on purpose.
 *
 * Excalidraw draws its hint across the top of the canvas whenever something is selected, and
 * a click that lands on that strip never reaches the shape underneath.
 */
async function placeBoard(zoom = 0.6) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__pasteCheckApi.updateScene({ appState: { scrollX: ${300 / zoom - scene.block.x}, scrollY: ${(280 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
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

/** The page ready to be typed into again: no half-written line, nothing selected. */
async function clearLine() {
  await pressKey('Escape', 'Escape', 0, 27);
  await pressKey('KeyC', 'c', MODIFIER_BIT.ctrl, 67);
  await sleep(400);
}

/** Attach the recorder and find the block. */
async function readyPage() {
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await evaluate(HOOK_INPUT);
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => (await evaluate(PROBE)).card, 'the overlay to render');
  await waitFor(async () => String((await evaluate(PROBE)).card?.screen).trim().length > 3,
                'the shell to draw its first prompt', 320);
  await sleep(700);
}

// ─── Putting things on the clipboard, for real ────────────────

/**
 * The system clipboard, loaded with whatever the case is about.
 *
 * `write` rather than `writeText` even for the text-only case, so all four cases go through
 * one path and a refusal is one refusal rather than two different ones. Answers with why it
 * was refused instead of throwing: a headless machine's clipboard is the machine's, and a
 * check that cannot reach it should say so rather than fail as if the block were wrong.
 */
const putOnClipboard = (kinds) => `(async () => {
  try {
    const parts = {};
    if (${JSON.stringify(kinds)}.includes('image')) {
      const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0));
      parts['image/png'] = new Blob([bytes], { type: 'image/png' });
    }
    if (${JSON.stringify(kinds)}.includes('text')) {
      parts['text/plain'] = new Blob([${JSON.stringify(PASTED_TEXT)}], { type: 'text/plain' });
    }
    await navigator.clipboard.write([new ClipboardItem(parts)]);
    return { ok: true };
  } catch (error) {
    return { ok: false, why: String((error && error.message) || error) };
  }
})()`;

/**
 * A `paste` the emulator's own textarea receives, carrying whatever the case needs.
 *
 * Dispatched at the textarea rather than at the card, because that is where a real paste
 * lands: xterm reads the keyboard through a hidden `.xterm-helper-textarea`, and both the
 * emulator's listener and any handler above it decide on an event whose target is that
 * node. Anything dispatched higher up would skip the emulator entirely and prove nothing
 * about which of the two answered.
 */
const synthesisePaste = (kinds) => `(async () => {
  const active = document.activeElement;
  const target = (active && active.classList && active.classList.contains('xterm-helper-textarea'))
    ? active
    : document.querySelector('.terminal-card .xterm-helper-textarea');
  if (!target) return { error: 'no emulator textarea to paste into' };
  const transfer = new DataTransfer();
  if (${JSON.stringify(kinds)}.includes('image')) {
    const bytes = Uint8Array.from(atob(${JSON.stringify(PNG_BASE64)}), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
  }
  if (${JSON.stringify(kinds)}.includes('text')) {
    transfer.setData('text/plain', ${JSON.stringify(PASTED_TEXT)});
  }
  const event = new ClipboardEvent('paste', {
    clipboardData: transfer, bubbles: true, cancelable: true, composed: true,
  });
  target.dispatchEvent(event);
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { defaultPrevented: event.defaultPrevented };
})()`;

/**
 * Did a paste send the byte, the text, or neither?
 *
 * The text is asked for with `includes` rather than by equality, and that is not laziness:
 * a shell with bracketed paste on has xterm wrapping the text in `ESC[200~`/`ESC[201~`, so
 * an equality would be asserting which shell this machine runs. The byte is asked for
 * exactly, since nothing wraps a control character.
 */
function describe(sent) {
  return {
    byte: sent.includes(PASTE_BYTE),
    text: sent.includes(PASTED_TEXT),
    raw: sent,
  };
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
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await grantClipboard();
  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');

  await readyPage();

  console.log('1. the real chord, against the real clipboard');
  {
    await focusTerminal();
    const loaded = await evaluate(putOnClipboard(['image']));
    if (!loaded?.ok) {
      console.log(`  SKIP  this machine's clipboard refused the write (${loaded?.why ?? 'no reason given'}),`);
      console.log('        so the real-chord half was not run. Section 2 asks the same rules of a');
      console.log('        synthesised paste and needs no clipboard.');
    } else {
      // `Cmd+V` is asked for only on a Mac, and the reason is worth writing down rather than
      // working around: which chord fires the browser's *paste* is the platform Chrome is
      // running on, not `navigator.platform`, so no user-agent override reaches it — press
      // `Meta+V` on Windows and no paste event happens at all. That is a statement about
      // Chrome rather than about this block, and section 2 is what stands in for it here:
      // the same rule answered with no keyboard in it, which is what "keyboard-agnostic"
      // means and the whole reason the rule lives at the paste.
      const chords = [{ name: 'Ctrl+V', modifier: 'ctrl' }];
      if (process.platform === 'darwin') chords.push({ name: 'Cmd+V', modifier: 'meta' });
      else console.log('  SKIP  Cmd+V — off a Mac it is not the browser\'s paste chord, so no'
                       + ' paste fires.\n        Section 2 asks the same rule with no keyboard in it.');
      for (const chord of chords) {
        await evaluate(putOnClipboard(['image']));
        await sleep(200);
        let before = (await evaluate(PROBE)).sent;
        await pressKey('KeyV', 'v', MODIFIER_BIT[chord.modifier], 86);
        await sleep(700);
        let seen = describe(await sentSince(before));
        check(`a screenshot and no text: ${chord.name} sends ${readable(PASTE_BYTE)}`,
              seen.byte, `sent ${readable(seen.raw)}`);
        await clearLine();
      }

      await evaluate(putOnClipboard(['text']));
      await sleep(200);
      let before = (await evaluate(PROBE)).sent;
      await pressKey('KeyV', 'v', MODIFIER_BIT.ctrl, 86);
      await sleep(700);
      let seen = describe(await sentSince(before));
      check('text on the clipboard: Ctrl+V still pastes it', seen.text, `sent ${readable(seen.raw)}`);
      check('and does not also send the byte', !seen.byte, `sent ${readable(seen.raw)}`);
      // Taken here rather than at the end of the section, so it is a picture of something:
      // the pasted text sitting on the shell's own command line, before `clearLine` takes it
      // away again. A shot of a tidied prompt says nothing about any of this.
      await shot('01-text-pasted-into-the-shell');
      await clearLine();

      await evaluate(putOnClipboard(['image', 'text']));
      await sleep(200);
      before = (await evaluate(PROBE)).sent;
      await pressKey('KeyV', 'v', MODIFIER_BIT.ctrl, 86);
      await sleep(700);
      seen = describe(await sentSince(before));
      check('an image and text together is a text paste, which is the older promise',
            seen.text && !seen.byte, `sent ${readable(seen.raw)}`);
      await clearLine();
    }
  }

  console.log('\n2. the same rules, asked of a synthesised paste');
  {
    await focusTerminal();

    let before = (await evaluate(PROBE)).sent;
    let pasted = await evaluate(synthesisePaste(['image']));
    check('the emulator textarea took the event', !pasted?.error, JSON.stringify(pasted));
    let seen = describe(await sentSince(before));
    check(`a screenshot and no text sends ${readable(PASTE_BYTE)}`, seen.byte,
          `sent ${readable(seen.raw)}`);
    await clearLine();

    before = (await evaluate(PROBE)).sent;
    await evaluate(synthesisePaste(['text']));
    seen = describe(await sentSince(before));
    check('text pastes into the shell, exactly as it did', seen.text, `sent ${readable(seen.raw)}`);
    check('and the byte is not sent as well', !seen.byte, `sent ${readable(seen.raw)}`);
    await clearLine();

    before = (await evaluate(PROBE)).sent;
    await evaluate(synthesisePaste(['image', 'text']));
    seen = describe(await sentSince(before));
    check('an image and text together pastes the text and nothing else',
          seen.text && !seen.byte, `sent ${readable(seen.raw)}`);
    await clearLine();
    await shot('02-synthesised');
  }

  console.log('\n3. and nothing on the clipboard is still nothing');
  {
    // The empty case is worth its own line: a rule written on "no text" rather than on "an
    // image" would fire here too, and send the shell a `\x16` nobody asked for.
    await focusTerminal();
    const before = (await evaluate(PROBE)).sent;
    await evaluate(synthesisePaste([]));
    const seen = describe(await sentSince(before));
    check('an empty clipboard sends the shell nothing at all', seen.raw === '',
          `sent ${readable(seen.raw)}`);
    await clearLine();
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
