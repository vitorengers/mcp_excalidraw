#!/usr/bin/env node
/**
 * Checks that the rect a terminal block was dragged to survives the two doors this page's
 * memory does not: a reload, and a switch of project and back (#154).
 *
 * The block's geometry lived in two `useRef` maps and nowhere else, so both doors dropped it
 * and the block came back at `TERMINAL_SIZE` in the anchored slot. That is not only a shape
 * moving: the freshly placed default reports its own grid, and the server pushes it at the
 * live shell, so a full-screen program repaints into a smaller screen than the reader left it
 * at. Both halves are asked about here — the shape off the scene, and the grid off
 * `GET /api/terminal`, which is the server's own answer rather than the browser's hope.
 *
 * The size is put there by a **real pointer on a real corner handle** and the position by a
 * real drag of the header, for the reason `check-terminal-size-browser.mjs` gives: a rect
 * written into the scene by `updateScene` is not the gesture the observation is about, and
 * the resize path is exactly what has to have run for the server to know a new grid.
 *
 * Two projects, because "per board" is the decision being checked and a global memory passes
 * every single-board case. The second board has content of its own at a different `x`, so its
 * anchored origin is a number the first board's remembered rect cannot be mistaken for.
 *
 * At **zoom 0.8 and a placed viewport**, the way `check-terminal-browser.mjs` does it: fitted
 * to the block, the corner handle and the overlay's own frame end at the same pixel, and which
 * of them takes the press is decided by a rounding rather than by the code under check.
 *
 * Chrome is driven over the DevTools protocol through `ws`, the way the other browser checks
 * do it. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas
 * server and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-terminal-geometry-browser.mjs [--chrome <path>] [--shots <dir>]
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * What a block is drawn at when nobody has resized it, and the gap it is anchored by.
 *
 * The size was two numbers here until #199 and is a **grid** now: 125 × 30 cells, which is only
 * a rectangle once a page has measured its own font, and two font stacks measure two cells. So
 * it is derived below from what the page really has rather than written down — read from the
 * module for the same reason `TERMINAL_GAP` is, that a copy here is a second definition to
 * drift from the one under test.
 */
const modulePath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the terminal block module is built — dist/core/terminal-block.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { TERMINAL_GAP, TERMINAL_GRID, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, terminalSizeFor } =
  await import(pathToFileURL(modulePath).href);

/** A scene unit, which is the tolerance the definition of done asks for. */
const CLOSE = 1;

// ─── Two projects, one of which gets dragged ──────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-terminal-geometry-'));
const firstDir = join(workDir, 'first-project');
const secondDir = join(workDir, 'second-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [firstDir, secondDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const FIRST = 'first-project';
const SECOND = 'second-project';
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: FIRST, path: firstDir.replace(/\\/g, '/') },
    { id: SECOND, path: secondDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so the anchored origin is measured
// against the board's own content and nothing else is drawing on these boards.
writeFileSync(join(firstDir, 'board.config.json'), JSON.stringify({
  name: 'First Project', repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');
writeFileSync(join(secondDir, 'board.config.json'), JSON.stringify({
  name: 'Second Project', repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = 36900 + (process.pid % 200);
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

/** One request, with two more goes at it — the connection, not the case. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (workspace, path, options = {}) =>
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

/** The board's sessions, as the *server* has them — not as the browser hoped. */
const sessionsOf = async (workspace) =>
  (await (await api(workspace, '/api/terminal')).json())?.sessions ?? [];

/** The grid one session is holding, which is what a `pty.resize` moves. */
const gridOf = async (workspace, sessionId) => {
  const session = (await sessionsOf(workspace)).find((entry) => entry.id === sessionId);
  return session ? { cols: session.cols, rows: session.rows } : null;
};

const sameGrid = (a, b) => Boolean(a) && Boolean(b) && a.cols === b.cols && a.rows === b.rows;
const showGrid = (grid) => (grid ? `${grid.cols}×${grid.rows}` : 'none');

/**
 * Every grid the shell is seen holding over a window of time.
 *
 * The point is what is *not* in it. A block put back at the default reports the default grid,
 * and the server pushes it at the live shell before anything else can correct it — so a
 * restore that went down and back up would leave a second pair here even if the pair at the
 * end were right.
 */
async function gridsSeen(workspace, sessionId, ms = 3000) {
  const seen = [];
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const grid = await gridOf(workspace, sessionId);
    const label = showGrid(grid);
    if (grid && seen[seen.length - 1] !== label) seen.push(label);
    await sleep(120);
  }
  return seen;
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
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
  await sleep(400);
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
        window.__terminalCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** The blocks on the board, the card drawn over the first of them, and what is selected. */
const PROBE = `(() => {
  const api = window.__terminalCheckApi;
  const out = { blocks: [], cards: [], tabs: [], shapes: [] };
  if (api) {
    for (const element of api.getSceneElements()) {
      if ((element.customData || {}).kind === 'terminal') {
        out.blocks.push({ id: element.id, x: element.x, y: element.y,
                          width: element.width, height: element.height,
                          sessions: (element.customData || {}).sessions || [] });
      // What the board itself authored, which is how this check tells one board's scene from
      // another's: nothing else on screen carries the project it came from.
      } else if (!(element.customData || {}).kind && !element.containerId) {
        out.shapes.push({ x: element.x, y: element.y });
      }
    }
    const state = api.getAppState();
    out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                 offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
    out.selected = Object.keys(state.selectedElementIds || {})
      .filter((id) => state.selectedElementIds[id]);
  }

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2,
             width: box.width, height: box.height,
             left: box.left, top: box.top, right: box.right, bottom: box.bottom };
  };

  for (const card of document.querySelectorAll('.terminal-card')) {
    out.cards.push({
      box: boxOf(card),
      header: boxOf(card.querySelector('.terminal-card__header')),
      body: boxOf(card.querySelector('.terminal-card__body')),
    });
  }
  for (const tab of document.querySelectorAll('.workspace-tab')) {
    out.tabs.push({
      name: (tab.querySelector('.workspace-tab__name') || {}).textContent || '',
      active: tab.classList.contains('workspace-tab--active'),
    });
  }
  out.workspace = new URLSearchParams(window.location.search).get('workspace');
  return out;
})()`;

/**
 * Switch board by pressing the tab's own button.
 *
 * Through the DOM rather than with a pointer: the tab strip is at the top of the page and a
 * terminal card is an overlay that can be over it, so a coordinate would be a case failing on
 * where a block happens to sit. The button is the same one a reader presses either way.
 */
const switchTo = (name) => evaluate(`(() => {
  for (const tab of document.querySelectorAll('.workspace-tab')) {
    const label = (tab.querySelector('.workspace-tab__name') || {}).textContent || '';
    if (label.trim() === ${JSON.stringify(name)}) {
      tab.querySelector('.workspace-tab__select').click();
      return true;
    }
  }
  return false;
})()`);

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** Put the block somewhere with room around it, so a corner is a corner and not an edge. */
async function place(block, zoom = 0.8) {
  await evaluate(`window.__terminalCheckApi.updateScene({ appState: { scrollX: ${375 - block.x}, scrollY: ${76.25 - block.y}, zoom: { value: ${zoom} } } })`);
  await sleep(500);
  return evaluate(PROBE);
}

const blockOn = async (what) =>
  waitFor(async () => {
    const probe = await evaluate(PROBE);
    return probe.blocks.length > 0 && probe.cards.length > 0 ? probe.blocks[0] : null;
  }, what);

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Content on each board, at a different `x`, so the two anchored origins are different
  // numbers — a block width and a gap to the left of each, and since #199 that width is
  // whatever 125 columns of this page's cell comes to rather than a number this file knows.
  await api(FIRST, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 200, height: 140,
                           backgroundColor: '#a5d8ff', text: 'the first board' }),
  });
  await api(SECOND, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 600, y: 0, width: 200, height: 140,
                           backgroundColor: '#b2f2bb', text: 'the second board' }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1700,1320',
    `${BASE}/?workspace=${FIRST}`,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const fresh = await blockOn('the first board to place a terminal block');

  console.log('\n1. a board that has never had one placed gets the default, at the anchor');
  // The rectangle 125 × 30 comes to on *this* page, measured the way the page measures it.
  // Since #199 there is no constant to compare against: the same grid is 1282 units wide
  // against Comic Shanns and 1360 against the fallback stack, and both are the default.
  const cell = await evaluate(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '${TERMINAL_FONT_SIZE}px ' + ${JSON.stringify(TERMINAL_FONT_FAMILY)};
    const metrics = ctx.measureText('W');
    return { advance: metrics.width,
             lineBox: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent };
  })()`);
  const DEFAULT_SIZE = terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_SIZE, cell.lineBox, cell.advance);
  const FIRST_ANCHOR = { x: 0 - TERMINAL_GAP - DEFAULT_SIZE.width, y: 0 };
  const SECOND_ANCHOR = { x: 600 - TERMINAL_GAP - DEFAULT_SIZE.width, y: 0 };

  check(`the block is ${DEFAULT_SIZE.width}×${DEFAULT_SIZE.height}, `
        + `which is ${TERMINAL_GRID.cols}×${TERMINAL_GRID.rows} on this page`,
        fresh.width === DEFAULT_SIZE.width && fresh.height === DEFAULT_SIZE.height,
        `${fresh.width}×${fresh.height}`);
  check(`and at the anchored origin ${FIRST_ANCHOR.x},${FIRST_ANCHOR.y}`,
        Math.abs(fresh.x - FIRST_ANCHOR.x) < CLOSE && Math.abs(fresh.y - FIRST_ANCHOR.y) < CLOSE,
        `${fresh.x},${fresh.y}`);
  const [firstSession] = await waitFor(async () => {
    const live = await sessionsOf(FIRST);
    return live.length > 0 ? live : null;
  }, 'the first board to open a shell');
  const defaultGrid = await waitFor(async () => gridOf(FIRST, firstSession.id), 'a grid on the shell');
  await shot('01-default');

  console.log('\n2. a real pointer drags it to a rect of its own');
  let scene = await place(fresh);
  await click(scene.cards[0].header.x, scene.cards[0].header.y);
  scene = await evaluate(PROBE);
  check('clicking the header selects the block through the overlay',
        scene.selected.includes(scene.blocks[0].id), JSON.stringify(scene.selected));

  // Aimed a few pixels *outside* the corner rather than exactly on it. The handle is a square
  // centred on the corner, so both land on it — but the point exactly on the corner is also on
  // the selection's south edge and on the card's own last pixel, and which of the three takes
  // the press is a rounding. It resolved as the south edge once #199 made the block a third
  // taller, and a south drag is a resize this case would have called a pass on height alone.
  const corner = toViewport(scene, fresh.x + fresh.width, fresh.y + fresh.height);
  await drag({ x: corner.x + 5, y: corner.y + 5 }, { x: corner.x + 205, y: corner.y + 135 });
  scene = await evaluate(PROBE);
  const resized = scene.blocks[0];
  check('dragging the corner resizes it',
        resized.width > fresh.width + 100 && resized.height > fresh.height + 60,
        `${fresh.width}×${fresh.height} → ${resized.width}×${resized.height}`);

  // And moved, because a size restored into the anchor's slot would put a block the reader
  // had dragged aside back in front of the content. They are one rect and one gesture.
  scene = await evaluate(PROBE);
  await drag({ x: scene.cards[0].header.x, y: scene.cards[0].header.y },
             { x: scene.cards[0].header.x + 90, y: scene.cards[0].header.y + 70 });
  scene = await evaluate(PROBE);
  const dragged = scene.blocks[0];
  check('dragging the header moves it',
        Math.abs(dragged.x - resized.x) > 40 && Math.abs(dragged.y - resized.y) > 20,
        `${resized.x},${resized.y} → ${dragged.x},${dragged.y}`);
  await shot('02-dragged');

  const draggedGrid = await waitFor(async () => {
    const grid = await gridOf(FIRST, firstSession.id);
    return grid && !sameGrid(grid, defaultGrid) ? grid : null;
  }, 'the dragged grid to reach the shell');
  check('and the shell was told the bigger grid',
        draggedGrid.cols > defaultGrid.cols && draggedGrid.rows > defaultGrid.rows,
        `${showGrid(defaultGrid)} → ${showGrid(draggedGrid)}`);

  console.log('\n3. a reload puts the block back where it was left, at the size it was left');
  await send('Page.reload');
  await sleep(1200);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the reload');
  const reloaded = await blockOn('a terminal block after the reload');
  // Scrolled to before the shot only. A reload puts the viewport back at the origin and the
  // block sits at a large negative `x`, so the screenshot would otherwise be of the empty
  // canvas beside it — and this shot is the browser look `CLAUDE.md` asks for.
  await place(reloaded);
  await shot('03-reloaded');
  check('the block is the width it was dragged to',
        Math.abs(reloaded.width - dragged.width) <= CLOSE,
        `${dragged.width} → ${reloaded.width}`);
  check('and the height it was dragged to',
        Math.abs(reloaded.height - dragged.height) <= CLOSE,
        `${dragged.height} → ${reloaded.height}`);
  check('and where it was dragged to',
        Math.abs(reloaded.x - dragged.x) <= CLOSE && Math.abs(reloaded.y - dragged.y) <= CLOSE,
        `${dragged.x},${dragged.y} → ${reloaded.x},${reloaded.y}`);
  check('and it holds the shell that was already running',
        reloaded.sessions.includes(firstSession.id), JSON.stringify(reloaded.sessions));

  console.log('\n4. and the shell was never resized down and back up to get there');
  const seen = await gridsSeen(FIRST, firstSession.id);
  check('every grid the shell held after the reload is the dragged one',
        seen.length > 0 && seen.every((grid) => grid === showGrid(draggedGrid)),
        `saw ${JSON.stringify(seen)}, wanted only ${showGrid(draggedGrid)}`);

  console.log('\n5. the second board gets its own default, not the first board\'s rect');
  check('there is a tab for it', await switchTo('Second Project'), 'no such workspace tab');
  await waitFor(async () => (await evaluate(PROBE)).workspace === SECOND, 'the second board to open');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle on the second board');

  // Waited for by *this board's own shapes* being on screen, not by "a block is on the
  // board". A switch leaves the board you left up until the new one lands — deliberately,
  // because a canvas that goes blank for the length of a reconnect reads as data loss — so
  // for a second or so the block up is the first board's, at the first board's rect, and a
  // check that measured it would report this failure whether or not it happened.
  //
  // Nor do the session ids separate them: they are numbered per board, so both boards' first
  // shell is `s1`. That collision is not only the check's problem — it is why the geometry a
  // page remembers per session has to stop being written while a switch is in flight.
  await waitFor(async () => (await sessionsOf(SECOND)).length > 0, 'the second board to open a shell');
  const other = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    const landed = probe.shapes.some((shape) => Math.abs(shape.x - 600) < CLOSE);
    if (!landed || probe.cards.length === 0 || probe.blocks.length === 0) return null;
    return probe.blocks[0];
  }, 'the second board to land with a terminal block of its own');
  await shot('04-second-board');
  check(`the block is ${DEFAULT_SIZE.width}×${DEFAULT_SIZE.height}, the default again`,
        other.width === DEFAULT_SIZE.width && other.height === DEFAULT_SIZE.height,
        `${other.width}×${other.height}`);
  check(`and at this board's own anchor ${SECOND_ANCHOR.x},${SECOND_ANCHOR.y}`,
        Math.abs(other.x - SECOND_ANCHOR.x) < CLOSE && Math.abs(other.y - SECOND_ANCHOR.y) < CLOSE,
        `${other.x},${other.y}`);

  console.log('\n6. and coming back to the first board is the same rect again, with no reload');
  check('the tab is still there', await switchTo('First Project'), 'no such workspace tab');
  await waitFor(async () => (await evaluate(PROBE)).workspace === FIRST, 'the first board to come back');
  const returned = await waitFor(async () => {
    const probe = await evaluate(PROBE);
    const landed = probe.shapes.some((shape) => Math.abs(shape.x - 0) < CLOSE);
    if (!landed || probe.cards.length === 0 || probe.blocks.length === 0) return null;
    return probe.blocks[0];
  }, 'the first board\'s block to come back');
  await shot('05-back');
  check('the block is the size it was dragged to',
        Math.abs(returned.width - dragged.width) <= CLOSE
        && Math.abs(returned.height - dragged.height) <= CLOSE,
        `${dragged.width}×${dragged.height} → ${returned.width}×${returned.height}`);
  check('and where it was dragged to',
        Math.abs(returned.x - dragged.x) <= CLOSE && Math.abs(returned.y - dragged.y) <= CLOSE,
        `${dragged.x},${dragged.y} → ${returned.x},${returned.y}`);
  const backGrid = await gridOf(FIRST, firstSession.id);
  check('and the shell still holds the grid it was dragged to',
        sameGrid(backGrid, draggedGrid), `${showGrid(draggedGrid)} → ${showGrid(backGrid)}`);
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
