#!/usr/bin/env node
/**
 * Checks the terminal's tab strip in a real browser.
 *
 * `check-terminal-tabs.mjs` covers the server: ids on sessions, ids on routes, ids on the
 * socket, and a cap. None of that says the strip works, and this repository has paid for
 * that distinction repeatedly — a panel that never opened, a race in tab initialisation, a
 * click landing on the label instead of the box. All of them compiled.
 *
 * So the questions here are the ones only a browser can answer. Does the strip render, one
 * chip per shell? Does `+` open another and `×` end one? Does switching tabs show *that*
 * session's screen rather than replaying the other one into it — the case one emulator per
 * block would fail? Does a tab detach into a second block, and does a detached tab find its
 * way back into a strip? And, after all of it, does the block's own corner still resize it —
 * which is the question a second pointer-taking region on this overlay exists to be asked.
 *
 * The shell is a stub over pipes (`EXCALIDRAW_TERMINAL_PTY=0`), because these cases are
 * about the strip rather than about terminals: a stub that answers `heard[x]` to `x` makes
 * "this screen is showing that session" something a screenshot of the DOM can settle.
 * `check-terminal-ansi-browser.mjs` is where a real PTY is driven.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-tabs-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

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

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-tabs-'));
const projectDir = join(workDir, 'tabs-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'tabs-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Tabs Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/**
 * A shell that answers a line with `heard[<line>]`.
 *
 * A line at a time rather than a chunk at a time: the browser sends keystrokes as they are
 * pressed, so a shell that answered every chunk would answer `h`, `el`, `lo` and say nothing
 * about which session heard what.
 */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.search(/[\\r\\n]/)) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) process.stdout.write('heard[' + line + ']\\r\\n');
  }
});
setInterval(() => {}, 1000);
`, 'utf8');

const PORT = 35700 + (process.pid % 250);
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
    EXCALIDRAW_TERMINAL: `node "${stubShell.replace(/\\/g, '/')}"`,
    EXCALIDRAW_TERMINAL_PTY: '0',
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

/** One request, with two more goes at the connection rather than at the case. */
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

const sessions = async () => ((await (await api('/api/terminal')).json())?.sessions ?? []);

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
    // The page's own complaints. Most of what can go wrong in here is a warning the browser
    // printed and nobody read — the strip's handlers swallow their failures on purpose, so
    // a case that times out says only that nothing happened.
    if (message.method === 'Runtime.consoleAPICalled') {
      console_lines.push(`${message.params.type}: ${message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      console_lines.push(`exception: ${message.params.exceptionDetails?.exception?.description
        ?? message.params.exceptionDetails?.text}`);
    }
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
}

const console_lines = [];

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
  await sleep(350);
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
    await sleep(40);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined, text = undefined) {
  await send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', code, key, modifiers, windowsVirtualKeyCode, text,
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
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

/**
 * The board and every terminal card on it.
 *
 * The cards come back with the middle of every part that takes a pointer, because that is
 * what a case here does with them: a chip, a `×`, a `+`, a `⧉` and a `⇥` are all things to
 * be clicked, and working out where they are from the outside is the check re-deriving the
 * layout it is supposed to be checking.
 */
const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  if (!api) return { error: 'no api handle' };
  const middle = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height };
  };
  const out = { blocks: [], authored: [], cards: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'terminal') {
      out.blocks.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        sessions: custom.sessions || [], active: custom.active || '' });
    } else if (!custom.kind) {
      out.authored.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.tool = state.activeTool ? state.activeTool.type : null;
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  for (const card of document.querySelectorAll('.terminal-card')) {
    const box = card.getBoundingClientRect();
    const strip = card.querySelector('.terminal-card__tabs');
    const screens = [...card.querySelectorAll('.terminal-card__screen')];
    out.cards.push({
      left: box.left, top: box.top, width: box.width, height: box.height,
      stripPointerEvents: strip ? getComputedStyle(strip).pointerEvents : null,
      tabs: [...card.querySelectorAll('.terminal-card__tab')].map((tab) => ({
        id: tab.getAttribute('data-session'),
        active: tab.classList.contains('terminal-card__tab--active'),
        at: middle(tab),
        close: middle(tab.querySelector('.terminal-card__tab-close')),
        pointerEvents: getComputedStyle(tab).pointerEvents,
      })),
      // Low in the header and in from the left: the middle of the row is where the font
      // buttons and the mode chip are, and those do take the pointer.
      header: (() => {
        const header = card.querySelector('.terminal-card__header');
        if (!header) return null;
        const headerBox = header.getBoundingClientRect();
        return { x: headerBox.left + 6, y: headerBox.top + headerBox.height - 2 };
      })(),
      add: middle(card.querySelector('.terminal-card__add')),
      detach: middle(card.querySelector('.terminal-card__detach')),
      merge: middle(card.querySelector('.terminal-card__merge')),
      // The way into the shell since #112, and the only one since #144 took the strip along
      // the bottom of the block away.
      screenAt: middle(card.querySelector('.terminal-card__body')),
      // Only the screen that is on top. A hidden one still has its rows in the DOM, and a
      // case about "switching shows that session" would pass on the other tab's text.
      screen: screens
        .filter((screen) => getComputedStyle(screen).visibility !== 'hidden')
        .map((screen) => (screen.querySelector('.xterm-rows') || {}).textContent || '')
        .join(' | '),
      screenCount: screens.length,
    });
  }
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** Fit every terminal block into the viewport, so what a case clicks is on screen. */
const fitBlocks = async () => {
  await evaluate(`(() => {
    const api = window.__terminalCheckApi;
    const blocks = api.getSceneElements().filter((element) => (element.customData || {}).kind === 'terminal');
    if (blocks.length) api.scrollToContent(blocks, { fitToViewport: true });
    return blocks.length;
  })()`);
  await sleep(600);
};

/** Type a line into whichever screen has the keyboard, and wait for the stub to answer. */
async function say(word) {
  await typeText(word);
  await pressKey('Enter', 'Enter', 0, 13, '\r');
  await waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.cards.some((card) => card.screen.includes(`heard[${word}]`));
  }, `the shell to answer ${word}`);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so "the right side" has a right side to be on.
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

  console.log('1. the block draws a tab strip, and only the chips take the pointer');
  await waitFor(async () => (await evaluate(PROBE)).cards.length > 0, 'the overlay to render');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length > 0, 'the strip to render');
  await fitBlocks();
  let scene = await evaluate(PROBE);
  await shot('01-one-tab');

  check('one block, one tab', scene.blocks.length === 1 && scene.cards[0].tabs.length === 1,
        JSON.stringify(scene.blocks));
  check('the tab is labelled with the session it stands for',
        scene.cards[0].tabs[0].id === scene.blocks[0].sessions[0],
        `${scene.cards[0].tabs[0].id} vs ${JSON.stringify(scene.blocks[0].sessions)}`);
  check('and it is the one on top', scene.cards[0].tabs[0].active, JSON.stringify(scene.cards[0].tabs));
  // The row spans the block; the block's own top edge is under it. A row that took the
  // pointer would take the resize handles along that edge with it.
  check('the strip itself stays transparent to the pointer',
        scene.cards[0].stripPointerEvents === 'none', String(scene.cards[0].stripPointerEvents));
  check('and only the chips take it', scene.cards[0].tabs[0].pointerEvents === 'auto',
        String(scene.cards[0].tabs[0].pointerEvents));

  console.log('\n2. the first shell is typed into');
  await click(scene.cards[0].screenAt.x, scene.cards[0].screenAt.y);
  check('clicking the screen puts the keyboard in the terminal',
        /xterm/.test((await evaluate(PROBE)).focused), (await evaluate(PROBE)).focused);
  await say('alpha');
  scene = await evaluate(PROBE);
  check('the shell answered, in the block', scene.cards[0].screen.includes('heard[alpha]'),
        scene.cards[0].screen.slice(-160));

  console.log('\n3. + opens a second shell in the same block');
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await sessions()).length === 2, 'a second session on the server');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 2, 'a second chip');
  scene = await evaluate(PROBE);
  await shot('02-two-tabs');
  check('still one block', scene.blocks.length === 1, JSON.stringify(scene.blocks.map((b) => b.id)));
  check('with two tabs in it', scene.blocks[0].sessions.length === 2, JSON.stringify(scene.blocks[0]));
  check('and an emulator for each, not one being reused',
        scene.cards[0].screenCount === 2, String(scene.cards[0].screenCount));
  check('the new tab is the one on top', scene.cards[0].tabs[1].active, JSON.stringify(scene.cards[0].tabs));

  const [first, second] = scene.blocks[0].sessions;
  await click(scene.cards[0].screenAt.x, scene.cards[0].screenAt.y);
  await say('bravo');
  scene = await evaluate(PROBE);
  check('what the second shell said is on the second tab\'s screen',
        scene.cards[0].screen.includes('heard[bravo]'), scene.cards[0].screen.slice(-160));
  check('and the first shell\'s output is not drawn into it',
        !scene.cards[0].screen.includes('heard[alpha]'), scene.cards[0].screen.slice(-160));

  console.log('\n4. switching tabs shows that session\'s screen, not a replay into one emulator');
  await click(scene.cards[0].tabs[0].at.x, scene.cards[0].tabs[0].at.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks[0].active === first, 'the first tab to come up');
  scene = await evaluate(PROBE);
  await shot('03-switched-back');
  check('the first tab is on top again', scene.cards[0].tabs[0].active && !scene.cards[0].tabs[1].active,
        JSON.stringify(scene.cards[0].tabs.map((tab) => tab.active)));
  check('its screen still has what its shell said',
        scene.cards[0].screen.includes('heard[alpha]'), scene.cards[0].screen.slice(-160));
  check('and none of the other session\'s',
        !scene.cards[0].screen.includes('heard[bravo]'), scene.cards[0].screen.slice(-160));

  await click(scene.cards[0].tabs[1].at.x, scene.cards[0].tabs[1].at.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks[0].active === second, 'the second tab to come back');
  scene = await evaluate(PROBE);
  check('and switching back shows the second one\'s screen, still there',
        scene.cards[0].screen.includes('heard[bravo]') && !scene.cards[0].screen.includes('heard[alpha]'),
        scene.cards[0].screen.slice(-160));

  console.log('\n5. a tab detaches into a block of its own');
  await click(scene.cards[0].detach.x, scene.cards[0].detach.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 2, 'a second block');
  await fitBlocks();
  scene = await evaluate(PROBE);
  await shot('04-detached');
  check('there are two blocks now', scene.blocks.length === 2, JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('and two overlays, one per block', scene.cards.length === 2, String(scene.cards.length));
  check('one session in each', scene.blocks.every((block) => block.sessions.length === 1),
        JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('between them they hold both sessions',
        [...scene.blocks[0].sessions, ...scene.blocks[1].sessions].sort().join() === [first, second].sort().join(),
        JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('the two blocks are not on top of one another',
        Math.abs(scene.blocks[0].x - scene.blocks[1].x) > 40
        || Math.abs(scene.blocks[0].y - scene.blocks[1].y) > 40,
        JSON.stringify(scene.blocks.map((b) => [b.x, b.y])));

  // Which side, and not only "some other place". The region is anchored to the far left —
  // `terminalOrigin` puts the first block one gap left of the mirror, because the left is
  // the edge the board does not grow into (#96). A detach that went right would author a
  // block back into the direction that move emptied, and on a board with a mirror the very
  // first one lands on top of it. "Not overlapping the source" passes for that, which is
  // how it went unnoticed, so the side itself is what is asserted here.
  const fromBlock = scene.blocks.find((block) => block.sessions.includes(first));
  const awayBlock = scene.blocks.find((block) => block.sessions.includes(second));
  const geometry = JSON.stringify({ from: fromBlock, away: awayBlock, authored: scene.authored });
  check('the detached block is entirely left of the one it came out of',
        Boolean(fromBlock) && Boolean(awayBlock) && awayBlock.x + awayBlock.w <= fromBlock.x,
        geometry);
  check('and keeps its size and its top edge',
        Boolean(fromBlock) && Boolean(awayBlock)
        && awayBlock.w === fromBlock.w && awayBlock.h === fromBlock.h
        && awayBlock.y === fromBlock.y,
        geometry);
  // The board's own content stands in for the mirror here: it is the region the source block
  // was anchored one gap to the left of, and going right is what lands the detached block on
  // top of it. No `githubProject` is configured for this run, so there is no mirror to use.
  const authoredLeft = Math.min(...scene.authored.map((element) => element.x));
  check('and clear of the region the source was anchored beside',
        Boolean(awayBlock) && Number.isFinite(authoredLeft)
        && awayBlock.x + awayBlock.w <= authoredLeft,
        geometry);
  check('both shells are still running', (await sessions()).length === 2,
        JSON.stringify((await sessions()).map((one) => one.id)));

  const detached = scene.cards.find((card) => card.tabs[0].id === second);
  check('the detached block draws the session it took', Boolean(detached), JSON.stringify(scene.cards.map((c) => c.tabs.map((t) => t.id))));
  check('and its screen is that session\'s',
        Boolean(detached) && detached.screen.includes('heard[bravo]') && !detached.screen.includes('heard[alpha]'),
        String(detached?.screen).slice(-160));

  console.log('\n6. and it re-joins a strip');
  check('a block offers to merge only when there is another one to merge into',
        scene.cards.every((card) => card.merge !== null), JSON.stringify(scene.cards.map((c) => Boolean(c.merge))));
  await click(detached.merge.x, detached.merge.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 1, 'the two blocks to become one');
  await fitBlocks();
  scene = await evaluate(PROBE);
  await shot('05-merged');
  check('one block again', scene.blocks.length === 1 && scene.cards.length === 1,
        `${scene.blocks.length} blocks, ${scene.cards.length} cards`);
  check('with both tabs in it', scene.blocks[0].sessions.length === 2, JSON.stringify(scene.blocks[0].sessions));
  check('and no merge button left, since there is nothing to merge into',
        scene.cards[0].merge === null, JSON.stringify(scene.cards[0].merge));
  check('both shells survived the round trip', (await sessions()).length === 2,
        JSON.stringify((await sessions()).map((one) => one.id)));

  const rejoined = scene.cards[0].tabs.find((tab) => tab.id === second);
  await click(rejoined.at.x, rejoined.at.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks[0].active === second, 'the re-joined tab to come up');
  scene = await evaluate(PROBE);
  check('and the re-joined session still has its screen',
        scene.cards[0].screen.includes('heard[bravo]'), scene.cards[0].screen.slice(-160));

  console.log('\n7. × ends a shell and takes its tab');
  const closing = scene.cards[0].tabs.find((tab) => tab.id === first);
  await click(closing.close.x, closing.close.y);
  await waitFor(async () => (await sessions()).length === 1, 'the closed shell to go');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 1, 'the chip to go');
  scene = await evaluate(PROBE);
  await shot('06-closed');
  check('one session left on the server', (await sessions()).length === 1
        && (await sessions())[0].id === second, JSON.stringify((await sessions()).map((one) => one.id)));
  check('one tab left on the block', scene.blocks[0].sessions.length === 1
        && scene.blocks[0].sessions[0] === second, JSON.stringify(scene.blocks[0].sessions));
  check('the block is still there', scene.blocks.length === 1 && scene.cards.length === 1,
        `${scene.blocks.length} blocks`);
  check('and the surviving session still has its screen',
        scene.cards[0].screen.includes('heard[bravo]'), scene.cards[0].screen.slice(-160));

  console.log('\n8. and the block\'s corner still resizes it');
  const before = { w: scene.blocks[0].w, h: scene.blocks[0].h };
  const gridBefore = (await sessions())[0];

  // A viewport of this case's own rather than whatever the last fit left, and for a reason
  // about the window rather than about the code: since #144 a block is 1140 × 720, so a fit
  // puts its bottom-right corner near the edge and the 200 × 140 this case drags it by lands
  // outside the window. A press dispatched off the viewport is not a press on the handle.
  // Placed at a known spot and zoomed out, there is room to grab it and room to drag it —
  // the same answer `check-terminal-browser.mjs` gives to the same question.
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${200 / 0.5 - scene.blocks[0].x}, scrollY: ${(200 - scene.view.offsetTop) / 0.5 - scene.blocks[0].y}, zoom: { value: 0.5 } } })`);
  await sleep(500);
  scene = await evaluate(PROBE);

  // A click on the header has to select the *shape*. Since #112 the screen below it takes
  // the pointer for the shell, so the header is the whole of what still reaches the block —
  // and if the tab row had taken the pointer too there would be no selection and no handles.
  await click(scene.cards[0].header.x, scene.cards[0].header.y);
  scene = await evaluate(PROBE);
  check('clicking the header selects the block through the overlay',
        scene.selected.includes(scene.blocks[0].id), JSON.stringify(scene.selected));

  const corner = toViewport(scene, scene.blocks[0].x + scene.blocks[0].w, scene.blocks[0].y + scene.blocks[0].h);
  await drag(corner, { x: corner.x + 200, y: corner.y + 140 });
  scene = await evaluate(PROBE);
  await shot('07-resized');
  check('dragging its corner resizes it',
        scene.blocks[0].w > before.w + 50 && scene.blocks[0].h > before.h + 30,
        `${before.w}×${before.h} → ${scene.blocks[0].w}×${scene.blocks[0].h}`);
  check('the overlay grew with it',
        Math.abs(scene.cards[0].width - scene.blocks[0].w * scene.view.zoom) < 2,
        `card ${scene.cards[0].width} for block ${scene.blocks[0].w} at zoom ${scene.view.zoom}`);

  const gridAfter = await waitFor(async () => {
    const [session] = await sessions();
    return session && session.cols > (gridBefore?.cols ?? 0) ? session : null;
  }, 'the new grid to reach the server');
  check('and the session in it was told the new size',
        gridAfter.cols > gridBefore.cols && gridAfter.rows > gridBefore.rows,
        `${gridBefore.cols}×${gridBefore.rows} → ${gridAfter.cols}×${gridAfter.rows}`);

  console.log('\n9. and none of the strip was ever stored');
  await sleep(2400);
  const stored = await (await api('/api/elements')).json();
  check('the authored shape is in the store',
        stored.elements.some((element) => element.width === 200), String(stored.count));
  check('no terminal block is',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
  check('so no session id was ever written to the board',
        !JSON.stringify(stored.elements).includes('"sessions"'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  const complaints = console_lines.filter((line) => !line.startsWith('log:')).slice(-12);
  if (complaints.length > 0) console.error(`the page said:\n${complaints.join('\n')}`);
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
