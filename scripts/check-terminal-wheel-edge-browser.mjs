#!/usr/bin/env node
/**
 * Checks who owns the wheel at the *ends* of a terminal's scroll, in a real browser.
 *
 * #112 gave the board every wheel the terminal had no use for, so that a block would not be a
 * hole in the canvas's own navigation, and `docs/terminal.md` wrote the rule down as "the
 * screen is at the bottom, or there is none". #256 is the observation that those are two
 * different situations read as one. A reader scrolling an Implement / Fix run reaches the top
 * of what it printed, keeps wheeling, and the *canvas* pans out from under the block they were
 * reading — while a block with nothing to scroll at all is the case #112 actually answered.
 *
 * So the rule moved off the event and onto the box: **while the terminal has something to
 * scroll, the vertical wheel is the terminal's**, at its ends as much as in its middle.
 *
 * Both of the block's views are asked, because both chained and by two different routes. An
 * Implement / Fix tab is drawn by whichever of them the transcript calls for — a run the board
 * composed carries fold marks and is drawn as a document, everything else stays in the emulator
 * (#246) — so a fix in one of them is a fix the reader meets half the time.
 *
 * - the **emulator** handed the wheel over whenever xterm declined to `preventDefault`, and
 *   `_bubbleScroll` declines at either end of the viewport;
 * - the **rendered transcript** computed the same boundary by hand and forwarded on it.
 *
 * Four sessions, so each case has a tab that is genuinely in the state it names: an emulator
 * with a deep scrollback and one with none, a folded transcript taller than its box and one
 * that fits inside it. All four are stubs named on `POST /api/terminal` rather than commands
 * typed into a shell — what is being asked about is the wheel, and a shell would put this
 * machine's prompt between the question and the answer.
 *
 * The server is started with `EXCALIDRAW_TERMINAL_PTY=0`. That is not a preference either: the
 * fold marks are OSC sequences, a pseudoconsole re-renders what passes through it, and an agent
 * tab is on pipes anyway because a `-p` run is.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it
 * loads the built frontend, so a fix that is only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-terminal-wheel-edge-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

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

const rendererModule = join(repoRoot, 'dist', 'core', 'agent-stream-render.js');
if (!existsSync(rendererModule)) {
  console.error('  FAIL  the compiled renderer exists — dist/core/agent-stream-render.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── What the four tabs hold ──────────────────────────────────

/**
 * A run's `stream-json`, with as many tool calls as the caller asks for.
 *
 * The shapes are the ones `check-agent-stream-render.mjs` took from a real
 * `claude -p --output-format stream-json` capture. What matters here is only the count: a tool
 * call is what the renderer writes a fold mark for, so one of them is what makes the tab a
 * document at all.
 *
 * **Eighty of them, and the count is measured rather than generous.** A folded call is *one*
 * row until it is opened — that is what folding is — so a run of fifteen draws about twenty
 * lines and fits inside a thirty-row block with nothing left to scroll, which is the other
 * case entirely. The document has to be taller than its box for there to be an end of it to
 * reach.
 */
const runStream = (calls) => [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Read'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'll read those files." }] } },
  ...Array.from({ length: calls }, (_, index) => ([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: `src/part-${index}.ts` } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', content: `alpha ${index}\nbravo ${index}\ncharlie ${index}` }] } },
  ])).flat(),
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done, and here is the answer.' }] } },
  { type: 'result', is_error: false, num_turns: calls },
].map((event) => JSON.stringify(event)).join('\n') + '\n';

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-wheel-edge-'));
const projectDir = join(workDir, 'wheel-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'wheel-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Wheel Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/**
 * A stub that prints its lines and then stays alive.
 *
 * Alive is not decoration: a command that exits is dropped from the session map on the spot,
 * so the block would have one fewer tab than this check has cases. They are killed with the
 * server in the `finally` below.
 */
const linesStub = join(workDir, 'stub-lines.mjs');
writeFileSync(linesStub, `#!/usr/bin/env node
const count = Number(process.argv[2]);
let out = '';
for (let line = 1; line <= count; line++) out += 'line ' + line + '\\n';
process.stdout.write(out);
setInterval(() => {}, 60000);
`, 'utf8');

/**
 * The same, for a run the board composed — the renderer's own bytes, fold marks and all.
 *
 * The marks are what `hasFoldMarks` reads to choose the document view over the emulator, so
 * stripping them the way `check-agent-stream-render-browser.mjs` does would give this check
 * two emulator tabs and no transcript at all.
 */
function writeRunStub(name, calls) {
  const path = join(workDir, name);
  writeFileSync(path, `#!/usr/bin/env node
import { AgentStreamRenderer } from ${JSON.stringify(pathToFileURL(rendererModule).href)};
process.stdout.write(new AgentStreamRenderer().feed(${JSON.stringify(runStream(calls))}));
setInterval(() => {}, 60000);
`, 'utf8');
  return path;
}

const longRunStub = writeRunStub('stub-long-run.mjs', 80);
const shortRunStub = writeRunStub('stub-short-run.mjs', 1);

const nodeCommand = (script, argument = '') =>
  `node "${script.replace(/\\/g, '/')}"${argument === '' ? '' : ` ${argument}`}`;

/** The four tabs, in the order they are opened and therefore in the order they are drawn. */
const TABS = [
  { key: 'bare', what: 'an emulator with nothing behind its screen', command: nodeCommand(linesStub, 3) },
  { key: 'deep', what: 'an emulator with two hundred lines behind it', command: nodeCommand(linesStub, 200) },
  { key: 'run', what: 'a folded transcript taller than the block', command: nodeCommand(longRunStub) },
  { key: 'short', what: 'a folded transcript that fits inside it', command: nodeCommand(shortRunStub) },
];

const PORT = 36100 + (process.pid % 250);
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
    // See the header: an OSC sequence has to reach the browser as it was written.
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

/** One request, with two more goes at the connection itself. See check-terminal-focus-browser. */
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

/**
 * Notches of the wheel where the pointer is. Negative `deltaY` is towards the top.
 *
 * `modifiers` is CDP's bitmask — 2 is Ctrl — and it is here for one case: the zoom gesture is
 * left whole on purpose, so a block with a deep scrollback still zooms the board.
 */
async function wheel(x, y, deltaY, notches = 1, deltaX = 0, modifiers = 0) {
  for (let notch = 0; notch < notches; notch++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x, y, deltaX, deltaY, modifiers, button: 'none', buttons: 0,
    });
    await sleep(60);
  }
  await sleep(250);
}

/** The imperative API, through the container's React fibre. See check-terminal-focus-browser. */
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
        window.__wheelCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Where the board is, which tab is on top, and how far its box has left to scroll.
 *
 * `scroller` is the one number both views answer to. An emulator scrolls inside xterm's
 * `.xterm-viewport`; a rendered transcript borrows `.terminal-card__screen` and scrolls
 * itself. Reading `scrollTop` off whichever it is, is how "the terminal scrolled" and "the
 * terminal did not" are told apart from outside either of them.
 */
const PROBE = `(() => {
  const api = window.__wheelCheckApi;
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
  if (!card) return { ...out, card: null };
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height,
             x: box.left + box.width / 2, y: box.top + box.height / 2 };
  };
  const body = card.querySelector('.terminal-card__body');
  out.card = {
    body: boxOf(body),
    grid: (card.querySelector('.terminal-card__grid') || {}).textContent || '',
    tabs: Array.from(card.querySelectorAll('.terminal-card__tab')).map((tab) => ({
      id: tab.getAttribute('data-session'),
      active: tab.classList.contains('terminal-card__tab--active'),
      box: boxOf(tab),
    })),
  };

  const screens = Array.from(card.querySelectorAll('.terminal-card__screen'));
  const shown = screens.find((screen) => getComputedStyle(screen).visibility === 'visible');
  if (!shown) return { ...out, screen: null };
  const scroller = shown.querySelector('.xterm-viewport') || shown;
  out.screen = {
    kind: shown.classList.contains('terminal-transcript') ? 'transcript' : 'emulator',
    // Only the document view carries the id: an emulator's host is a box xterm was opened
    // into and nothing else. Which session is on top is the tab strip's answer, above.
    session: shown.getAttribute('data-session'),
    scrollTop: scroller.scrollTop,
    // What the terminal has to give, in pixels. Zero is the case #112 answered.
    room: scroller.scrollHeight - scroller.clientHeight,
    text: String((shown.querySelector('.xterm-rows') || shown).textContent || '').slice(0, 400),
  };
  return out;
})()`;

/**
 * The board where this check wants it: round numbers, and well down the window.
 *
 * Excalidraw draws its hint across the top of the canvas whenever something is selected, and
 * that strip is inside its container — a block put near the top has its header underneath it.
 * See `check-terminal-focus-browser.mjs`, which places the board the same way and says why.
 */
async function placeBoard(zoom = 0.8) {
  const scene = await evaluate(PROBE);
  await evaluate(`window.__wheelCheckApi.updateScene({ appState: { scrollX: ${320 / zoom - scene.block.x}, scrollY: ${(300 - scene.view.offsetTop) / zoom - scene.block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
}

/** The board where it was, to within the noise of a float. */
const boardStill = (before, after) =>
  Math.abs(after.scrollX - before.scrollX) < 1
  && Math.abs(after.scrollY - before.scrollY) < 1
  && Math.abs(after.zoom - before.zoom) < 0.001;

const boardMoved = (before, after) =>
  Math.abs(after.scrollX - before.scrollX) > 1
  || Math.abs(after.scrollY - before.scrollY) > 1
  || Math.abs(after.zoom - before.zoom) > 0.001;

const say = (view) => `scrollX ${view.scrollX.toFixed(2)}, scrollY ${view.scrollY.toFixed(2)}, zoom ${view.zoom.toFixed(4)}`;

/**
 * Put a tab on top, by pressing it the way a reader does, and wait for the swap.
 *
 * The board is put back first, and that is not tidiness: the tab strip is drawn on the block,
 * the block is on the canvas, and a case that has just been panning the canvas around has left
 * it somewhere a press cannot reach. A press dispatched outside the window is not a press.
 */
async function selectTab(sessionId) {
  const scene = await placeBoard();
  const tab = scene.card.tabs.find((one) => one.id === sessionId);
  if (!tab) throw new Error(`no tab for ${sessionId} among ${JSON.stringify(scene.card.tabs.map((one) => one.id))}`);
  // Towards the left of the tab: the `×` that closes it is at the right end of the same box.
  await click(tab.box.left + 8, tab.box.y);
  await sleep(400);
  return waitFor(async () => {
    const probed = await evaluate(PROBE);
    const active = probed.card?.tabs.find((one) => one.active);
    return active && active.id === sessionId && probed.screen ? probed : null;
  }, `the ${sessionId} tab to come to the top`, 40);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Something authored, so the block has content to be placed away from.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 200, height: 140,
                           backgroundColor: '#a5d8ff', text: 'the board' }),
  });

  // Before the browser: a session opened after the page has loaded arrives as a tab the reader
  // never asked for, and which of them is on top then is the frontend's business rather than
  // this check's. Opened first, they are all there when the block first draws itself.
  for (const tab of TABS) {
    const response = await api('/api/terminal', {
      method: 'POST',
      body: JSON.stringify({ command: tab.command }),
    });
    if (response.status !== 202) {
      throw new Error(`POST /api/terminal for ${tab.key} answered ${response.status}: ${await response.text()}`);
    }
    tab.session = (await response.json()).session.id;
  }

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
  await waitFor(async () => (await evaluate(PROBE)).block, 'the terminal block to be placed');
  await waitFor(async () => {
    const probed = await evaluate(PROBE);
    return probed.card && probed.card.tabs.length === TABS.length ? probed : null;
  }, `all ${TABS.length} tabs to be drawn`);
  await placeBoard();

  const byKey = Object.fromEntries(TABS.map((tab) => [tab.key, tab.session]));

  console.log('1. a block with nothing to scroll still hands the wheel to the board (#112)');
  {
    let scene = await selectTab(byKey.bare);
    scene = await placeBoard();
    // Three lines in a screen thirty rows tall. The premise of the case rather than a
    // measurement of the fix: if this ever has room, the two below are asking nothing.
    check('the bare emulator has nothing behind its screen',
          scene.screen.kind === 'emulator' && scene.screen.room <= 2,
          `${scene.screen.kind}, ${scene.screen.room}px of room, grid ${scene.card.grid}`);

    let before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    let after = (await evaluate(PROBE)).view;
    check('a downward wheel over it pans the board', boardMoved(before, after),
          `${say(before)} → ${say(after)}`);

    scene = await placeBoard();
    before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 2);
    after = (await evaluate(PROBE)).view;
    check('and so does an upward one', boardMoved(before, after),
          `${say(before)} → ${say(after)}`);
    await shot('01-bare-pans-the-board');
  }

  console.log('\n2. the emulator keeps the wheel at both ends of its scrollback (#256)');
  {
    let scene = await selectTab(byKey.deep);
    scene = await placeBoard();
    check('the deep emulator has a scrollback to be at the end of',
          scene.screen.kind === 'emulator' && scene.screen.room > 50,
          `${scene.screen.kind}, ${scene.screen.room}px of room`);
    // It opens parked at the end of the run, which is where the reported case starts.
    check('and it is parked at the bottom of it',
          scene.screen.scrollTop >= scene.screen.room - 2,
          `${scene.screen.scrollTop} of ${scene.screen.room}`);

    let before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, 120, 4);
    let scrolled = await evaluate(PROBE);
    check('four downward notches at the bottom leave the board where it was',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);
    await shot('02-emulator-at-the-bottom');

    // The other half of the ask: nothing was fixed by swallowing the wheel outright.
    before = scrolled.view;
    const parked = scrolled.screen.scrollTop;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 3);
    scrolled = await evaluate(PROBE);
    check('an upward notch in the middle still scrolls the scrollback',
          scrolled.screen.scrollTop < parked - 20,
          `${parked} → ${scrolled.screen.scrollTop}`);
    check('and does not move the board either',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);

    // All the way to the top, and then past it, which is the reported gesture.
    await wheel(scene.card.body.x, scene.card.body.y, -120, 40);
    scrolled = await evaluate(PROBE);
    check('the wheel reaches the top of the scrollback',
          scrolled.screen.scrollTop <= 2, String(scrolled.screen.scrollTop));
    before = scrolled.view;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 4);
    scrolled = await evaluate(PROBE);
    await shot('03-emulator-at-the-top');
    check('four more upward notches at the top leave the board where it was',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);

    // And the zoom gesture is left whole, deliberately: Ctrl reads both axes together and is
    // not a request to scroll a scrollback, so a deep block is still a place to zoom from.
    scene = await placeBoard();
    before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 2, 0, 2);
    scrolled = await evaluate(PROBE);
    check('but Ctrl and the wheel still zoom the board over it',
          Math.abs(scrolled.view.zoom - before.zoom) > 0.001,
          `${say(before)} → ${say(scrolled.view)}`);
  }

  console.log('\n3. the rendered transcript keeps it at both ends too');
  {
    let scene = await selectTab(byKey.run);
    scene = await placeBoard();
    check('the run tab is drawn as a document rather than as a screen',
          scene.screen.kind === 'transcript', scene.screen.kind);
    check('and it is taller than the block',
          scene.screen.room > 50, `${scene.screen.room}px of room`);
    check('and it opens at the end of the run',
          scene.screen.scrollTop >= scene.screen.room - 2,
          `${scene.screen.scrollTop} of ${scene.screen.room}`);

    let before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, 120, 4);
    let scrolled = await evaluate(PROBE);
    check('four downward notches at the bottom leave the board where it was',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);
    await shot('04-transcript-at-the-bottom');

    before = scrolled.view;
    const parked = scrolled.screen.scrollTop;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 3);
    scrolled = await evaluate(PROBE);
    check('an upward notch in the middle still scrolls the transcript',
          scrolled.screen.scrollTop < parked - 20,
          `${parked} → ${scrolled.screen.scrollTop}`);
    check('and does not move the board either',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);

    await wheel(scene.card.body.x, scene.card.body.y, -120, 40);
    scrolled = await evaluate(PROBE);
    check('the wheel reaches the top of the run',
          scrolled.screen.scrollTop <= 2, String(scrolled.screen.scrollTop));
    before = scrolled.view;
    await wheel(scene.card.body.x, scene.card.body.y, -120, 4);
    scrolled = await evaluate(PROBE);
    await shot('05-transcript-at-the-top');
    check('four more upward notches at the top leave the board where it was',
          boardStill(before, scrolled.view), `${say(before)} → ${say(scrolled.view)}`);
  }

  console.log('\n4. a transcript that fits its box has nothing to scroll, so the board answers');
  {
    let scene = await selectTab(byKey.short);
    scene = await placeBoard();
    check('the short run is drawn as a document too',
          scene.screen.kind === 'transcript', scene.screen.kind);
    check('and it fits inside the block',
          scene.screen.room <= 2, `${scene.screen.room}px of room`);

    const before = scene.view;
    await wheel(scene.card.body.x, scene.card.body.y, 120, 2);
    const after = (await evaluate(PROBE)).view;
    await shot('06-short-transcript-pans-the-board');
    check('a wheel over it pans the board', boardMoved(before, after),
          `${say(before)} → ${say(after)}`);
  }

  console.log('\n5. and the sideways axis is still the board\'s, whatever the terminal is doing');
  {
    // #162 and #198, restated here rather than trusted: the change above is on the vertical
    // axis, and the horizontal one is answered before it in the capture phase.
    let scene = await selectTab(byKey.deep);
    scene = await placeBoard();
    const before = scene.view;
    const expected = 120 / before.zoom;
    await wheel(scene.card.body.x, scene.card.body.y, 0, 1, -120);
    const after = (await evaluate(PROBE)).view;
    check('a wheel with only a horizontal axis pans the board sideways',
          Math.abs(after.scrollX - before.scrollX - expected) < expected * 0.35,
          `${before.scrollX} → ${after.scrollX}, wanted +${expected} at zoom ${before.zoom}`);
    check('and does not move it up or down',
          Math.abs(after.scrollY - before.scrollY) < 1,
          `${before.scrollY} → ${after.scrollY}`);
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
