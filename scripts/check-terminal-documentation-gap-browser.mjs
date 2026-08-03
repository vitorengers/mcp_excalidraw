#!/usr/bin/env node
/**
 * Checks that the documentation comes back when the terminal region gives its room up,
 * whichever gesture gave it up.
 *
 * #200 made the board's own content step aside for the region, and keyed the recompute to the
 * two gestures that were being talked about at the time: `⧉` detach and `⇤` merge. A shell
 * that *exits* — the `×` on a detached block's last tab, or the shell ending on its own — also
 * drops a block, and that path committed the arrangement without asking where the
 * documentation now belongs. What was left was one block with `120 + 40 + width` of empty
 * canvas between its right edge and the content: the spacing of two terminals with one
 * terminal on screen, which is the observation on #255 word for word. It survived a reload,
 * because the displacement is written to `localStorage` and the move itself is authored data.
 *
 * So this asks the round trip with the *other* ending. Detach, then close the detached shell
 * rather than merging it back, and the documentation has to be exactly where the board
 * authored it — one `TERMINAL_GAP` right of the one block that is left — both straight away
 * and after a reload. `scripts/check-terminal-tabs-browser.mjs` covers `⧉` → `⇤`, which was
 * never broken, and its `×` case closes a tab in a block that keeps another one, so the
 * region never shrinks by a block there.
 *
 * The third case is the rule the fix must not break. The recompute on this path only ever
 * *decreases* the displacement, and only when the tool itself dropped a block, because
 * `natural` is derived from where the content currently stands: a pass that settled on every
 * reconcile would answer a reader dragging their block by moving the board.
 *
 * The shell is a stub over pipes (`EXCALIDRAW_TERMINAL_PTY=0`); these cases are about geometry
 * rather than about terminals. Chrome is driven over the DevTools protocol through `ws`, which
 * the server already depends on. Self-contained otherwise. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-documentation-gap-browser.mjs [--chrome <path>] [--shots <dir>]
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

/** The gap every region keeps from the one beside it — `TERMINAL_GAP` in `terminal-block.ts`. */
const GAP = 120;

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

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-doc-gap-'));
const projectDir = join(workDir, 'gap-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'gap-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so the documentation and the region are the only
// two things on this board and every gap here has one cause.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Gap Project',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

/** A shell that answers a line with `heard[<line>]`, so a tab can be seen to be alive. */
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
    EXCALIDRAW_TERMINAL: `node "${stubShell.replace(/\\/g, '/')}"`,
    EXCALIDRAW_TERMINAL_PTY: '0',
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

const consoleLines = [];

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
      consoleLines.push(`${message.params.type}: ${message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`exception: ${message.params.exceptionDetails?.exception?.description
        ?? message.params.exceptionDetails?.text}`);
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(350);
}

/** A drag, in steps: Excalidraw moves a shape on pointer moves, not on where the pointer lands. */
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
  await sleep(400);
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
        window.__gapCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The two regions, and the controls that change which of them is where.
 *
 * `documentation` is every authored shape's left edge, which is the number the whole check is
 * about: it is where `documentationClearance` puts the board's own content.
 */
const PROBE = `(() => {
  const api = window.__gapCheckApi;
  if (!api) return { error: 'no api handle' };
  const middle = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
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
  out.documentation = out.authored.length ? Math.min(...out.authored.map((one) => one.x)) : null;
  out.regionRight = out.blocks.length ? Math.max(...out.blocks.map((one) => one.x + one.w)) : null;
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.shift = (() => {
    try { return (JSON.parse(window.localStorage.getItem('vibemaxxing-documentation-shift') || '{}'))['${WORKSPACE}'] ?? 0; }
    catch (error) { return 'unreadable'; }
  })();
  for (const card of document.querySelectorAll('.terminal-card')) {
    out.cards.push({
      tabs: [...card.querySelectorAll('.terminal-card__tab')].map((tab) => ({
        id: tab.getAttribute('data-session'),
        at: middle(tab),
        close: middle(tab.querySelector('.terminal-card__tab-close')),
      })),
      add: middle(card.querySelector('.terminal-card__add')),
      detach: middle(card.querySelector('.terminal-card__detach')),
      merge: middle(card.querySelector('.terminal-card__merge')),
      mergeGlyph: (card.querySelector('.terminal-card__merge') || {}).textContent || null,
      header: (() => {
        const header = card.querySelector('.terminal-card__header');
        if (!header) return null;
        const box = header.getBoundingClientRect();
        return { x: box.left + 6, y: box.top + box.height - 2 };
      })(),
      screenAt: middle(card.querySelector('.terminal-card__body')),
    });
  }
  out.focused = String((document.activeElement || {}).className || '');
  return out;
})()`;

/** Fit every terminal block into the viewport, so what a case clicks is on screen. */
const fitBlocks = async () => {
  await evaluate(`(() => {
    const api = window.__gapCheckApi;
    const blocks = api.getSceneElements().filter((element) => (element.customData || {}).kind === 'terminal');
    if (blocks.length) api.scrollToContent(blocks, { fitToViewport: true });
    return blocks.length;
  })()`);
  await sleep(600);
};

/** Type a line into whichever screen has the keyboard, and wait for the stub to answer. */
async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(40);
  }
}

async function say(word) {
  await typeText(word);
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 });
  await sleep(200);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // The board's own content, and the only authored thing on it: where this stands is the whole
  // question. One shape rather than a section, because `documentationClearance` measures the
  // region's bounds and a rectangle has the same left edge as a board full of cards.
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

  console.log('1. one block, and the documentation one gap right of it');
  await waitFor(async () => (await evaluate(PROBE)).cards.length > 0, 'the overlay to render');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length > 0, 'the strip to render');
  await fitBlocks();
  let scene = await evaluate(PROBE);
  await shot('01-one-block');

  const natural = scene.documentation;
  check('one block on the board', scene.blocks.length === 1, JSON.stringify(scene.blocks));
  check('the documentation stands exactly one gap right of it',
        Math.abs(scene.documentation - (scene.regionRight + GAP)) < 1,
        JSON.stringify({ documentation: scene.documentation, regionRight: scene.regionRight }));
  check('and nothing has been pushed yet', scene.shift === 0, String(scene.shift));
  // The merge control is the other half of #255: `⧉` puts the new block to the right, so the
  // gesture that brings it back reads leftwards. There is nothing to merge into yet.
  check('a lone block offers no merge', scene.cards[0].merge === null, JSON.stringify(scene.cards[0].merge));

  console.log('\n2. a second shell in the same block moves nothing');
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await sessions()).length === 2, 'a second session on the server');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 2, 'a second chip');
  scene = await evaluate(PROBE);
  check('still one block', scene.blocks.length === 1, JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('and the documentation has not moved', Math.abs(scene.documentation - natural) < 1,
        `${scene.documentation} vs ${natural}`);

  const [first, second] = scene.blocks[0].sessions;

  console.log('\n3. ⧉ detaches, and the documentation steps aside for the second block');
  await click(scene.cards[0].detach.x, scene.cards[0].detach.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 2, 'a second block');
  await fitBlocks();
  scene = await evaluate(PROBE);
  await shot('02-detached');
  check('two blocks now', scene.blocks.length === 2, JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('the documentation was pushed right', scene.documentation > natural + 1,
        `${scene.documentation} vs ${natural}`);
  check('by exactly the room the region now takes',
        Math.abs(scene.documentation - (scene.regionRight + GAP)) < 1,
        JSON.stringify({ documentation: scene.documentation, regionRight: scene.regionRight }));
  check('and the push was written down', scene.shift > 0, String(scene.shift));
  check('both blocks offer to merge, leftwards, into the other',
        scene.cards.length === 2 && scene.cards.every((card) => card.merge !== null
          && card.mergeGlyph === '⇤'),
        JSON.stringify(scene.cards.map((card) => card.mergeGlyph)));

  console.log('\n4. × on the detached shell drops the block, and the documentation comes back');
  const detached = scene.cards.find((card) => card.tabs.length === 1 && card.tabs[0].id === second);
  check('the detached block is the one holding the tab that left', Boolean(detached),
        JSON.stringify(scene.cards.map((card) => card.tabs.map((tab) => tab.id))));
  await click(detached.tabs[0].close.x, detached.tabs[0].close.y);
  await waitFor(async () => (await sessions()).length === 1, 'the closed shell to go');
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 1, 'the emptied block to go');
  await sleep(600);
  scene = await evaluate(PROBE);
  await shot('03-closed');

  check('one block left, holding the shell that stayed',
        scene.blocks.length === 1 && scene.blocks[0].sessions.length === 1
        && scene.blocks[0].sessions[0] === first,
        JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('the documentation is back where the board authored it',
        Math.abs(scene.documentation - natural) < 1, `${scene.documentation} vs ${natural}`);
  check('and stands exactly one gap right of the block that is left',
        Math.abs(scene.documentation - (scene.regionRight + GAP)) < 1,
        JSON.stringify({ documentation: scene.documentation, regionRight: scene.regionRight }));
  check('with nothing left written down as pushed', scene.shift === 0, String(scene.shift));

  console.log('\n5. and it is still back after a reload');
  await send('Page.reload');
  // The handle is re-grabbed on every attempt rather than once: `Page.reload` returns before
  // the old document has gone, so a single grab can hand back the page that is on its way out.
  await sleep(1500);
  const reloaded = async () => {
    await evaluate(GRAB_API);
    const probe = await evaluate(PROBE);
    return probe.blocks?.length === 1 && probe.cards[0]?.tabs.length === 1;
  };
  await waitFor(reloaded, 'the block and its strip to come back after the reload');
  await sleep(800);
  await fitBlocks();
  scene = await evaluate(PROBE);
  await shot('04-reloaded');
  check('one block after the reload', scene.blocks.length === 1, JSON.stringify(scene.blocks.map((b) => b.sessions)));
  check('the documentation is still at its authored x',
        Math.abs(scene.documentation - natural) < 1, `${scene.documentation} vs ${natural}`);
  check('and still one gap right of the block',
        Math.abs(scene.documentation - (scene.regionRight + GAP)) < 1,
        JSON.stringify({ documentation: scene.documentation, regionRight: scene.regionRight }));
  check('and the reload read no push', scene.shift === 0, String(scene.shift));

  console.log('\n6. dragging the block toward the documentation moves nothing');
  const before = { documentation: scene.documentation, x: scene.blocks[0].x };
  // From the header, which is the one part of the overlay that lets the pointer through to the
  // shape — the screen below it takes the pointer for the shell, and the chips, `+`, `⧉` and
  // `⇤` all take their own. `check-terminal-tabs-browser.mjs` selects the block the same way.
  const grab = scene.cards[0].header;
  await drag(grab, { x: grab.x + 90, y: grab.y });
  await sleep(600);
  scene = await evaluate(PROBE);
  await shot('05-dragged');
  const moved = scene.blocks[0].x - before.x;
  check('the block did move — otherwise this case asks nothing', moved > 10, String(moved));
  check('and the documentation stayed where it was',
        Math.abs(scene.documentation - before.documentation) < 1,
        `${scene.documentation} vs ${before.documentation}`);

  // The same question asked of a reconcile rather than of a drag: opening and closing a shell
  // in a block that keeps another one is a pass through the same funnel with no block dropped,
  // and it must leave the reader's block and the board's content exactly as they are.
  scene = await evaluate(PROBE);
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await sessions()).length === 2, 'a second session again');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 2, 'a second chip again');
  scene = await evaluate(PROBE);
  const extra = scene.cards[0].tabs.find((tab) => tab.id !== first);
  await click(extra.close.x, extra.close.y);
  await waitFor(async () => (await sessions()).length === 1, 'the extra shell to go');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 1, 'its chip to go');
  await sleep(600);
  scene = await evaluate(PROBE);
  check('a reconcile that drops no block leaves the documentation alone',
        Math.abs(scene.documentation - before.documentation) < 1,
        `${scene.documentation} vs ${before.documentation}`);
  check('and leaves the block the reader dragged where they put it',
        Math.abs(scene.blocks[0].x - (before.x + moved)) < 1,
        `${scene.blocks[0].x} vs ${before.x + moved}`);

  console.log('\n7. a gap that has gone too wide closes itself back to one gap');

  /**
   * The case #494 was opened about, and the one the arithmetic used to have no answer for.
   *
   * `documentationClearance` was clamped at zero, so a region standing clear of the content
   * asked for nothing: `TERMINAL_GAP` was a floor and not a distance. A block dragged away
   * from the documentation — or, as measured on a real board, one restored at a rect
   * remembered from a layout the content has since moved out of — left a gap of whatever the
   * arithmetic gave, and opening blocks changed nothing until the region had grown back
   * across where the content stands.
   *
   * The asymmetry below is deliberate and is the one case 6 states from the other side. The
   * reconcile path may **give room back and never ask for more**, because it runs on a poll
   * and on every scene replaced, neither of which is a decision about the geometry. So a
   * block dragged *into* the content keeps the reader's placement (case 6), and a block
   * dragged *away* from it brings the content along rather than leaving a hole.
   */
  scene = await evaluate(PROBE);
  const away = scene.cards[0].header;
  await drag(away, { x: away.x - 260, y: away.y });
  await sleep(900);
  scene = await evaluate(PROBE);
  const opened = scene.documentation - scene.regionRight;
  check('the drag opened a gap wider than one gap', opened > GAP + 50,
        `${opened} rather than ${GAP}`);

  // A drag is not by itself a pass through the layout funnel — case 6 makes its point with a
  // shell opened and closed for the same reason. So the settle is asked for the way the board
  // asks for it: a reconcile. This one drops no *block* — the block keeps the session it
  // started with — which is exactly the pass the old guard refused to settle on, and the
  // whole of why a gap that had gone too wide stayed too wide.
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await sessions()).length === 2, 'a shell to reconcile against');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 2, 'its chip');
  scene = await evaluate(PROBE);
  const spare = scene.cards[0].tabs.find((tab) => tab.id !== first);
  await click(spare.close.x, spare.close.y);
  await waitFor(async () => (await sessions()).length === 1, 'the spare shell to go');
  await sleep(900);
  scene = await evaluate(PROBE);
  await shot('06-gap-reclaimed');

  check('still one block, so nothing here is about a block being dropped',
        scene.blocks.length === 1, JSON.stringify(scene.blocks.map((one) => one.sessions)));
  check('and the documentation came back to exactly one gap',
        Math.abs(scene.documentation - (scene.regionRight + GAP)) < 1,
        JSON.stringify({ documentation: scene.documentation, regionRight: scene.regionRight,
                         gap: scene.documentation - scene.regionRight, wanted: GAP }));
  check('which is a pull, written down as a negative shift',
        typeof scene.shift === 'number' && scene.shift < 0, String(scene.shift));

  if (consoleLines.length > 0) {
    console.log('\n(the page said)');
    for (const line of consoleLines.slice(-12)) console.log(`  ${line}`);
  }
} catch (error) {
  failures++;
  console.error(`  FAIL  the run itself — ${error?.message ?? error}`);
  if (consoleLines.length > 0) console.error(consoleLines.slice(-12).join('\n'));
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds the profile */ }
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL — ${failures} check(s)`}`);
console.log(`shots: ${shotDir}`);
process.exit(failures === 0 ? 0 : 1);
