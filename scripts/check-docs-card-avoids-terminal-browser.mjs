#!/usr/bin/env node
/**
 * Checks that the documentation card does not open underneath a terminal block, in a browser.
 *
 * #241. Placement knew two rectangles — the shape and the viewport — and the terminal was
 * neither. Sides are tried right, left, below, above, and "room" was measured against the
 * viewport edges only, so the card was placed to the right of the shape with room to spare and
 * a terminal panel standing in that room. Both overlays carry `--board-z-overlay` and the
 * panels are later in the DOM, so the terminal takes the pixels and about a third of the card
 * is invisible: a title cut mid-word, a body cut off along the panel's left edge.
 *
 * Why a browser, and why real geometry. Two DOM overlays that overlap compile perfectly, type
 * check perfectly and unit-test perfectly — `scripts/check-anchored-placement.mjs` can only ask
 * the arithmetic what it thinks, not what the page did with it. The rectangles compared here
 * are `getBoundingClientRect` of the live `.docs-card` and the live `.terminal-card`, and the
 * hit tests are `document.elementFromPoint`, which applies the stacking order the same way a
 * reader's eye does.
 *
 * The arrangement is the board's own, at the zoom that produces it: the canvas reads
 * `mirror | terminals | documentation` (#200), so a card in the mirror has the terminal region
 * immediately to its right — the first side placement tries — and no room for a 720px card on
 * its left, the mirror being the leftmost region. Every case therefore states its own setup
 * first: unless the card really *would* have landed on the terminal, the rest proves nothing.
 *
 * The last section is the control. A terminal panned out of the way must leave placement
 * exactly as it was, or the fix has traded one misplacement for another.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own canvas server
 * on a free port and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite
 * build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-docs-card-avoids-terminal-browser.mjs [--chrome <path>] [--shots <dir>]
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

/** The card the component renders. Placement is computed from these, not from the paint. */
const CARD_WIDTH = 720;
const GAP = 16;

/** Do two boxes share any pixel? Touching edges do not count. */
const overlap = (a, b) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** How much of `a`'s width the two share, which is what a reader loses. */
const covered = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));

// ─── A project with a document and a terminal ─────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-docs-avoid-'));
const projectDir = join(workDir, 'avoid-project');
const docsDir = join(projectDir, 'docs');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, docsDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'avoid-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so the only overlays on this board are the
// card being placed and the terminal panel it has to avoid.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Avoid Project',
  repo: 'vitorengers/mcp_excalidraw',
  docsDir: 'docs',
}), 'utf8');

const DOC_KEY = 'avoid-sample';
writeFileSync(join(docsDir, `${DOC_KEY}.md`), [
  '# Avoid sample',
  '',
  'A document long enough that the card is worth reading, and worth seeing all of.',
  '',
  '- one',
  '- two',
  '- three',
  '',
].join('\n'), 'utf8');

const PORT = 36700 + (process.pid % 200);
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

/** One request, with two more goes at the connection. See check-terminal-focus-browser. */
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
        window.__avoidApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The scene, the two overlays, and what a click on the card would hit.
 *
 * `predict` is the same conversion the app uses — `(scene + scroll) * zoom + offset` — kept here
 * so the shape the card belongs to can be turned into a box without a DOM node to measure. It
 * is checked against the terminal panel, whose box *is* measurable: if the prediction matches
 * that one, it can be trusted for the other.
 */
const PROBE = `(() => {
  const api = window.__avoidApi;
  if (!api) return { error: 'no api handle' };
  const state = api.getAppState();
  const view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                 offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  const predict = (element) => ({
    left: (element.x + view.scrollX) * view.zoom + view.offsetLeft,
    top: (element.y + view.scrollY) * view.zoom + view.offsetTop,
    right: (element.x + element.width + view.scrollX) * view.zoom + view.offsetLeft,
    bottom: (element.y + element.height + view.scrollY) * view.zoom + view.offsetTop,
  });

  const out = { view, blocks: [], anchors: {} };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    const data = element.customData || {};
    if (data.kind === 'terminal') {
      out.blocks.push({ id: element.id, scene: { x: element.x, y: element.y, width: element.width, height: element.height },
                        box: predict(element) });
    } else if (data.docKey === '${DOC_KEY}' && data.title) {
      out.anchors[data.title] = { id: element.id, scene: { x: element.x, y: element.y, width: element.width, height: element.height },
                                  box: predict(element) };
    }
  }

  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
             width: box.width, height: box.height };
  };
  const nameOf = (node) => {
    if (!node) return 'nothing';
    const tag = node.tagName ? node.tagName.toLowerCase() : '?';
    const cls = typeof node.className === 'string' && node.className
      ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    return tag + cls;
  };

  const card = document.querySelector('.docs-card');
  const panels = Array.from(document.querySelectorAll('.terminal-card'));
  out.panels = panels.map(boxOf);
  out.canvas = boxOf(document.querySelector('.canvas-container'));
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  if (!card) return { ...out, card: null };

  out.card = { box: boxOf(card), side: card.dataset.side, clamped: card.dataset.clamped };
  // Five points of the card, and for each the element a reader's click would reach. The
  // question is only ever whether a terminal took it: Excalidraw's own properties island is on
  // screen because something is selected, and it is entitled to whatever it covers.
  const box = out.card.box;
  const points = [
    { name: 'top left', x: box.left + 12, y: box.top + 12 },
    { name: 'top right', x: box.right - 12, y: box.top + 12 },
    { name: 'middle', x: box.left + box.width / 2, y: box.top + box.height / 2 },
    { name: 'bottom left', x: box.left + 12, y: box.bottom - 12 },
    { name: 'bottom right', x: box.right - 12, y: box.bottom - 12 },
  ];
  out.hits = points.map((point) => {
    const found = document.elementFromPoint(point.x, point.y);
    return {
      name: point.name,
      found: nameOf(found),
      onTerminal: panels.some((panel) => found && (panel === found || panel.contains(found))),
    };
  });
  return out;
})()`;

const setView = async (scrollX, scrollY, zoom) => {
  await evaluate(`window.__avoidApi.updateScene({ appState: { scrollX: ${scrollX}, scrollY: ${scrollY}, zoom: { value: ${zoom} } } })`);
  await sleep(400);
  return evaluate(PROBE);
};

const select = async (id) => {
  await evaluate(`window.__avoidApi.updateScene({ appState: { selectedElementIds: { '${id}': true } } })`);
  await sleep(500);
  return evaluate(PROBE);
};

const deselect = async () => {
  await evaluate('window.__avoidApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
};

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
    '--window-size=1500,1000',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const start = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen && seen.blocks && seen.blocks.length === 1 ? seen : null;
  }, 'the terminal block to reach the canvas');
  await waitFor(async () => (await evaluate(PROBE)).panels.length === 1, 'the terminal panel to render');

  // ─── The board's arrangement, at the zoom that produces it ───
  //
  // The terminal is about half the screen wide, as it is on the board; the shape the card
  // belongs to stands 700px to its left, as a mirror card does. Both numbers are in screen
  // pixels and converted back through the zoom, because that is the space placement works in.
  const block = start.blocks[0].scene;
  const zoom = Math.round((720 / block.width) * 1000) / 1000;
  const scenePixels = (screenPixels) => screenPixels / zoom;

  const shapes = [
    // The trap: near enough for the card to its right to land on the terminal, and nowhere
    // near enough room on its left for a 720px card.
    { title: 'trap', left: 700, top: 150 },
    // The control: the same shape with the terminal off the right of the screen.
    { title: 'clear', left: 2600, top: 150 },
  ];
  for (const shape of shapes) {
    await api('/api/elements', {
      method: 'POST',
      body: JSON.stringify({
        type: 'rectangle',
        x: block.x - scenePixels(shape.left),
        y: block.y + scenePixels(shape.top),
        width: scenePixels(200),
        height: scenePixels(120),
        backgroundColor: '#e7f5ff',
        customData: { docKey: DOC_KEY, title: shape.title },
      }),
    });
  }
  const placed = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.anchors.trap && seen.anchors.clear ? seen : null;
  }, 'the documented shapes to reach the canvas');

  console.log('1. the board is arranged the way the reader has it: mirror-side shape, terminal to its right');
  let scene = await setView(60 / zoom - placed.anchors.trap.scene.x,
                            150 / zoom - placed.anchors.trap.scene.y, zoom);
  {
    const panel = scene.panels[0];
    const predicted = scene.blocks[0].box;
    // If the prediction and the measurement disagree, every box below is guesswork.
    check('the predicted box of a block is the box its panel is drawn at',
          Math.abs(panel.left - predicted.left) < 2 && Math.abs(panel.top - predicted.top) < 2
          && Math.abs(panel.right - predicted.right) < 2,
          `panel ${Math.round(panel.left)},${Math.round(panel.top)} vs predicted ${Math.round(predicted.left)},${Math.round(predicted.top)}`);
    check('the terminal panel is on screen', panel.left < scene.canvas.right && panel.right > scene.canvas.left,
          `${Math.round(panel.left)}..${Math.round(panel.right)} in ${Math.round(scene.canvas.left)}..${Math.round(scene.canvas.right)}`);
    check('and stands to the right of the shape', panel.left > scene.anchors.trap.box.right,
          `panel from ${Math.round(panel.left)}, shape ends at ${Math.round(scene.anchors.trap.box.right)}`);

    // The reproduction, stated as geometry: the side placement tries first is inside the panel.
    const wouldBe = {
      left: scene.anchors.trap.box.right + GAP,
      right: scene.anchors.trap.box.right + GAP + CARD_WIDTH,
      top: scene.anchors.trap.box.top,
      bottom: scene.anchors.trap.box.top + 460,
    };
    check('a card placed to its right would land on the terminal', overlap(wouldBe, panel),
          `${Math.round(covered(wouldBe, panel))}px of the card's width under the panel`);
    check('and there is no room for one on its left either',
          scene.anchors.trap.box.left - scene.canvas.left < CARD_WIDTH + GAP + 12,
          `${Math.round(scene.anchors.trap.box.left - scene.canvas.left)}px to the left edge`);
  }

  console.log('\n2. selecting it opens the whole card, clear of the terminal');
  scene = await select(placed.anchors.trap.id);
  await shot('01-trap-selected');
  {
    check('the card opened', Boolean(scene.card), 'no .docs-card on the page');
    if (scene.card) {
      const panel = scene.panels[0];
      check('it shares no pixel with the terminal panel', !overlap(scene.card.box, panel),
            `card ${Math.round(scene.card.box.left)}..${Math.round(scene.card.box.right)} `
            + `vs panel ${Math.round(panel.left)}..${Math.round(panel.right)} `
            + `(${Math.round(covered(scene.card.box, panel))}px covered, side=${scene.card.side})`);
      check('and none of it is off the canvas area',
            scene.card.box.left >= scene.canvas.left - 1 && scene.card.box.right <= scene.canvas.right + 1
            && scene.card.box.top >= scene.canvas.top - 1 && scene.card.box.bottom <= scene.canvas.bottom + 1,
            `card ${Math.round(scene.card.box.left)},${Math.round(scene.card.box.top)}..`
            + `${Math.round(scene.card.box.right)},${Math.round(scene.card.box.bottom)} in `
            + `${Math.round(scene.canvas.left)},${Math.round(scene.canvas.top)}..`
            + `${Math.round(scene.canvas.right)},${Math.round(scene.canvas.bottom)}`);
      check('it is still full width — moved, not squeezed',
            Math.abs(scene.card.box.width - CARD_WIDTH) < 2, `width ${Math.round(scene.card.box.width)}`);
      check('and it did not have to be forced on screen', scene.card.clamped === 'false',
            `clamped=${scene.card.clamped}`);
      for (const hit of scene.hits) {
        check(`a click at its ${hit.name} does not reach the terminal`, !hit.onTerminal, hit.found);
      }
    }
  }

  console.log('\n3. with the terminal out of the way the card goes back where it always went');
  await deselect();
  scene = await setView(60 / zoom - placed.anchors.clear.scene.x,
                        150 / zoom - placed.anchors.clear.scene.y, zoom);
  {
    const panel = scene.panels[0];
    check('the terminal is off the right of the screen', panel.left > scene.canvas.right,
          `panel from ${Math.round(panel.left)}, canvas ends at ${Math.round(scene.canvas.right)}`);
  }
  scene = await select(placed.anchors.clear.id);
  await shot('02-clear-selected');
  {
    check('the card opened', Boolean(scene.card), 'no .docs-card on the page');
    if (scene.card) {
      check('to the right of the shape, as it always has been', scene.card.side === 'right',
            `side=${scene.card.side}`);
      check('one gap away from it',
            Math.abs(scene.card.box.left - (scene.anchors.clear.box.right + GAP)) < 2,
            `card at ${Math.round(scene.card.box.left)}, shape ends at ${Math.round(scene.anchors.clear.box.right)}`);
      check('aligned with the top of the shape',
            Math.abs(scene.card.box.top - scene.anchors.clear.box.top) < 2,
            `card ${Math.round(scene.card.box.top)} vs shape ${Math.round(scene.anchors.clear.box.top)}`);
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
