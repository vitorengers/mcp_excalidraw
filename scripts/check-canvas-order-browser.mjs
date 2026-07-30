#!/usr/bin/env node
/**
 * Checks the order the three regions stand in on the canvas, left to right:
 *
 *     mirror | terminals | documentation
 *
 * #200 is the reversal that produced it. The board used to read `terminal | mirror |
 * documentation`: both regions stepped leftward off the documentation, which was the fixed
 * reference frame, and the block went to the far left in #96 because it is placed once and
 * never re-anchored, so it had to sit on the edge the board does not grow into. The
 * observation reverses the first of those decisions and pays for it with the second: the
 * terminal region now sits between the mirror and the documentation, detaches grow it
 * **rightward**, and the documentation is moved aside to make the room. `⇤` merges a block
 * back and the documentation comes back with it.
 *
 * So the questions here are the ones only a browser can answer, and `CLAUDE.md` is explicit
 * about why they have to be asked in one: three defects in this layer compiled perfectly and
 * did none of what they claimed.
 *
 *   - Are the three regions in that order, disjoint, at the gaps that place them?
 *   - Does a detach land the new block to the right, and does the documentation move out of
 *     its way rather than being drawn on?
 *   - Does a merge put the documentation back **exactly** — the round trip the second
 *     observation on #200 asked for, since anything inexact walks the board right by the
 *     rounding once per shell?
 *   - Do `Alt+P` and `Alt+G` still land on their sections once the documentation has moved?
 *   - Does the order survive a reload, and a board switched away from and back?
 *   - And on a board with no `githubProject`, where no mirror is ever drawn, does the block
 *     take the vacant slot with the order holding for the two regions that exist?
 *
 * The project is a stub `gh` answering from a file, and the shell is a stub over pipes
 * (`EXCALIDRAW_TERMINAL_PTY=0`) — neither this check nor anybody's real board is touched.
 * Self-contained otherwise: it starts its own canvas server against two throwaway
 * workspaces and kills it. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite
 * build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-canvas-order-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
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

const terminalPath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
const layoutPath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
for (const path of [terminalPath, layoutPath]) {
  if (!existsSync(path)) {
    console.error(`  FAIL  the compiled server exists — ${path} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
}

// Read rather than retyped: the two gaps are what the order is measured by, and a copy of
// them here would be a second definition to drift from the one under test.
const { TERMINAL_KIND, TERMINAL_GAP, TERMINAL_GRID, TERMINAL_FONT_FAMILY, TERMINAL_FONT_SIZE, terminalSizeFor } =
  await import(pathToFileURL(terminalPath).href);
const { MIRROR_GAP } = await import(pathToFileURL(layoutPath).href);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Two boards, one of them with a project to mirror ──────────

const workDir = mkdtempSync(join(tmpdir(), 'check-canvas-order-'));
const projectDir = join(workDir, 'order-check');
const plainDir = join(workDir, 'order-plain');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, plainDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');
const stubShell = join(workDir, 'stub-shell.mjs');

const PROJECT = 'order-check';
const PLAIN = 'order-plain';

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_order',
    title: 'Order',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 7,
        title: 'Waiting to be picked up',
        url: 'https://github.com/vitorengers/mcp_excalidraw/issues/7',
        createdAt: '2026-07-20T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
      },
    }] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

/** A shell that says nothing and stays alive: these cases are about geometry. */
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: PROJECT, path: projectDir.replace(/\\/g, '/') },
    { id: PLAIN, path: plainDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Order Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');
// No project on this one, so no mirror is ever drawn on it — which is the case the last
// phase is about, and somewhere else to switch to for the phase before it.
writeFileSync(join(plainDir, 'board.config.json'), JSON.stringify({ name: 'Plain Board' }), 'utf8');

const PORT = 35700 + (process.pid % 190);
const CDP_PORT = PORT + 320;
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
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
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

const api = (path, workspace, init = {}) => fetch(
  `${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${workspace}`,
  { headers: { 'Content-Type': 'application/json' }, ...init }
);

const sessions = async (workspace = PROJECT) =>
  ((await (await api('/api/terminal', workspace)).json())?.sessions ?? []);

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();
const console_lines = [];

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
  await sleep(400);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(200);
}

/** The imperative API, through the container's React fibre — the only honest scene reader. */
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
        window.__orderCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The three regions as boxes, plus what a case has to click.
 *
 * The documentation is everything the board authored — no mark of its own, which is what
 * authored means here — and it is read as one region on purpose: #200 treats it as opaque
 * throughout, so that #217's two sections side by side change none of this arithmetic.
 */
const PROBE = `(() => {
  const api = window.__orderCheckApi;
  if (!api) return { error: 'no api handle' };
  const box = (elements) => {
    if (elements.length === 0) return null;
    return {
      minX: Math.min(...elements.map((e) => e.x)),
      minY: Math.min(...elements.map((e) => e.y)),
      maxX: Math.max(...elements.map((e) => e.x + e.width)),
      maxY: Math.max(...elements.map((e) => e.y + e.height)),
    };
  };
  const middle = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  };
  const scene = api.getSceneElements();
  const kindOf = (e) => (e.customData || {}).kind;
  // Everything the board authored, the section shapes included — they carry a mark, but the
  // mark is the board's own and they are saved like anything else. What is *not* authored is
  // the mirror and the terminal, which are the two the placement is about. A label bound to
  // an authored shape sits inside it, so leaving it out changes no bound.
  const derived = (e) => kindOf(e) === 'project-board' || kindOf(e) === ${JSON.stringify(TERMINAL_KIND)};
  const authored = scene.filter((e) => !derived(e) && !e.containerId);
  const state = api.getAppState();
  return {
    mirror: box(scene.filter((e) => kindOf(e) === 'project-board')),
    terminal: box(scene.filter((e) => kindOf(e) === ${JSON.stringify(TERMINAL_KIND)})),
    docs: box(authored),
    blocks: scene.filter((e) => kindOf(e) === ${JSON.stringify(TERMINAL_KIND)})
      .map((e) => ({ id: e.id, x: e.x, y: e.y, w: e.width, h: e.height,
                     sessions: (e.customData || {}).sessions || [] })),
    sections: scene.filter((e) => kindOf(e) === 'board-section')
      .map((e) => ({ code: (e.customData || {}).hotkeyCode, minX: e.x, minY: e.y,
                     maxX: e.x + e.width, maxY: e.y + e.height })),
    cards: [...document.querySelectorAll('.terminal-card')].map((card) => ({
      tabs: [...card.querySelectorAll('.terminal-card__tab')].map((tab) => tab.getAttribute('data-session')),
      add: middle(card.querySelector('.terminal-card__add')),
      detach: middle(card.querySelector('.terminal-card__detach')),
      merge: middle(card.querySelector('.terminal-card__merge')),
    })),
    view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
            width: state.width, height: state.height,
            offsetLeft: state.offsetLeft, offsetTop: state.offsetTop },
  };
})()`;

const intersects = (a, b) => Boolean(a) && Boolean(b)
  && a.minX < b.maxX - 0.5 && b.minX < a.maxX - 0.5
  && a.minY < b.maxY - 0.5 && b.minY < a.maxY - 0.5;

const at = (box) => (box ? `[${Math.round(box.minX)}…${Math.round(box.maxX)}]` : 'nothing');

/** The whole of the order, asserted the same way in every phase it has to hold. */
const inOrder = (scene, what, { mirror = true } = {}) => {
  const where = `mirror ${at(scene.mirror)}, terminals ${at(scene.terminal)}, `
    + `documentation ${at(scene.docs)}`;
  if (mirror) {
    check(`${what}: the mirror is left of the terminals`,
          scene.mirror && scene.terminal && scene.mirror.maxX <= scene.terminal.minX + 0.5, where);
    check(`${what}: and does not overlap them`, !intersects(scene.mirror, scene.terminal), where);
    check(`${what}: nor the documentation`, !intersects(scene.mirror, scene.docs), where);
  }
  check(`${what}: the terminals are left of the documentation`,
        scene.terminal && scene.docs && scene.terminal.maxX <= scene.docs.minX + 0.5, where);
  check(`${what}: and do not overlap it`, !intersects(scene.terminal, scene.docs), where);
};

/**
 * The whole board in one frame, for the eye rather than for a case.
 *
 * `CLAUDE.md` asks for a look in a browser, and the order this check is about is the one
 * thing a number cannot show: three regions side by side is a picture. Every other shot here
 * is fitted to whatever a case was clicking.
 */
const wide = async (name) => {
  await evaluate(`(() => {
    const api = window.__orderCheckApi;
    const all = api.getSceneElements();
    if (all.length) api.scrollToContent(all, { fitToViewport: true });
    return all.length;
  })()`);
  await sleep(700);
  await shot(name);
};

/** Fit every terminal block into the viewport, so what a case clicks is on screen. */
const fitBlocks = async () => {
  await evaluate(`(() => {
    const api = window.__orderCheckApi;
    const blocks = api.getSceneElements().filter((e) => (e.customData || {}).kind === 'terminal');
    if (blocks.length) api.scrollToContent(blocks, { fitToViewport: true });
    return blocks.length;
  })()`);
  await sleep(700);
};

/** The board's own content: two shapes, each inside a section that carries a key. */
async function authorTheBoard(workspace) {
  const section = (title, code, y, height) => ({
    type: 'rectangle', x: 0, y, width: 900, height,
    backgroundColor: 'transparent',
    customData: { kind: 'board-section', title, hotkeyCode: code },
  });
  await api('/api/elements', workspace, {
    method: 'POST', body: JSON.stringify(section('Project structure', 'KeyP', 0, 600)),
  });
  await api('/api/elements', workspace, {
    method: 'POST', body: JSON.stringify(section('Development', 'KeyG', 700, 400)),
  });
  await api('/api/elements', workspace, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 60, y: 60, width: 300, height: 160,
                           backgroundColor: '#a5d8ff', text: 'what the tool is' }),
  });
  await api('/api/elements', workspace, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 60, y: 760, width: 300, height: 160,
                           backgroundColor: '#b2f2bb', text: 'how it got that way' }),
  });
}

/** Move to another board the way the reader does — the tab strip above the canvas. */
async function switchTo(name) {
  const where = await waitFor(async () => evaluate(`(() => {
    const tab = [...document.querySelectorAll('.workspace-tab__select')]
      .find((one) => (one.textContent || '').includes(${JSON.stringify(name)}));
    if (!tab) return null;
    const rect = tab.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`), `the tab for ${name}`);
  await click(where.x, where.y);
}

/** Whether a box is inside the viewport the board is currently showing. */
const onScreen = (view, box) => {
  const left = -view.scrollX;
  const top = -view.scrollY;
  const right = left + view.width / view.zoom;
  const bottom = top + view.height / view.zoom;
  return box.minX < right && left < box.maxX && box.minY < bottom && top < box.maxY;
};

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');
  await authorTheBoard(PROJECT);
  await authorTheBoard(PLAIN);

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    `${BASE}/?workspace=${PROJECT}`,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).mirror, 'the mirror to render');
  await waitFor(async () => (await evaluate(PROBE)).docs, 'the board\'s own content to arrive');

  // ─── 1. The order, on a board that has all three regions ─────

  console.log('1. mirror | terminals | documentation, at the gaps that place them');
  await pressKey('KeyT', 't', 1, 84);
  let scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.terminal && now.mirror && now.docs ? now : null;
  }, 'the terminal block to be placed', 200);
  await wide('01-three-regions');

  inOrder(scene, 'a fresh spawn');
  check('the block is one gap left of the documentation, which is what places it',
        Math.abs((scene.docs.minX - scene.terminal.maxX) - TERMINAL_GAP) < 1,
        `the gap is ${Math.round(scene.docs.minX - scene.terminal.maxX)}, not ${TERMINAL_GAP}`);
  check('and the mirror one gap left of the block, which is what places it',
        Math.abs((scene.terminal.minX - scene.mirror.maxX) - MIRROR_GAP) < 1,
        `the gap is ${Math.round(scene.terminal.minX - scene.mirror.maxX)}, not ${MIRROR_GAP}`);
  check('the block is level with the top of the documentation',
        Math.abs(scene.terminal.minY - scene.docs.minY) < 1,
        `block at ${scene.terminal.minY}, documentation at ${scene.docs.minY}`);

  const home = scene.docs.minX;
  const sectionsAtHome = scene.sections.map((section) => ({ ...section }));
  check('the board declares the two sections this phase will scroll onto',
        sectionsAtHome.length === 2, JSON.stringify(sectionsAtHome));

  // ─── 2. A second block, to the right, and the documentation aside ──

  console.log('\n2. a detached block goes right, and the documentation moves out of its way');
  await fitBlocks();
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.cards[0]?.add ? now : null;
  }, 'the block\'s overlay');
  await click(scene.cards[0].add.x, scene.cards[0].add.y);
  await waitFor(async () => (await sessions()).length === 2, 'a second session on the server');
  await waitFor(async () => (await evaluate(PROBE)).cards[0].tabs.length === 2, 'a second chip');

  scene = await evaluate(PROBE);
  // The tab that will be taken out is the one on top, which is the one `+` just opened.
  const [stays, leaves] = scene.blocks[0].sessions;
  await click(scene.cards[0].detach.x, scene.cards[0].detach.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 2, 'a second block');
  await sleep(600);
  scene = await evaluate(PROBE);
  await wide('02-detached');

  const source = scene.blocks.find((block) => block.sessions.includes(stays));
  const detached = scene.blocks.find((block) => block.sessions.includes(leaves));
  const sides = JSON.stringify({ source, detached });
  check('the two blocks are side by side, not stacked',
        Boolean(source) && Boolean(detached) && Math.abs(source.y - detached.y) < 1, sides);
  check('the detached block is entirely right of the one it came out of',
        Boolean(source) && Boolean(detached) && detached.x >= source.x + source.w, sides);
  inOrder(scene, 'after a detach');
  check('the documentation was pushed to exactly one gap clear of the region',
        Math.abs((scene.docs.minX - scene.terminal.maxX) - TERMINAL_GAP) < 1,
        `the gap is ${Math.round(scene.docs.minX - scene.terminal.maxX)}`);
  check('so it moved, rather than being drawn over', scene.docs.minX > home + 1,
        `${home} → ${scene.docs.minX}`);

  const shift = scene.docs.minX - home;
  check('and the sections moved with what they hold, all by the one distance',
        scene.sections.length === sectionsAtHome.length
        && scene.sections.every((section) => {
          const before = sectionsAtHome.find((one) => one.code === section.code);
          return before && Math.abs((section.minX - before.minX) - shift) < 1;
        }),
        JSON.stringify({ shift, before: sectionsAtHome, after: scene.sections }));

  for (const [code, key, name] of [['KeyP', 'p', 'Alt+P'], ['KeyG', 'g', 'Alt+G']]) {
    await pressKey(code, key, 1);
    await sleep(900);
    const after = await evaluate(PROBE);
    const section = after.sections.find((one) => one.code === code);
    check(`${name} still lands on its section once the documentation has moved`,
          Boolean(section) && onScreen(after.view, section),
          JSON.stringify({ section, view: after.view }));
  }
  await shot('03-after-alt-g');

  // ─── 3. And a merge puts it back, exactly ────────────────────

  console.log('\n3. ⇤ merges the block back and the documentation comes back with it');
  await fitBlocks();
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.cards.length === 2 && now.cards.every((card) => card.merge) ? now : null;
  }, 'both overlays, each offering to merge');
  await click(scene.cards[1].merge.x, scene.cards[1].merge.y);
  await waitFor(async () => (await evaluate(PROBE)).blocks.length === 1, 'the two blocks to become one');
  await sleep(600);
  scene = await evaluate(PROBE);
  await wide('04-merged');

  check('the documentation is back exactly where it was, not near it',
        Math.abs(scene.docs.minX - home) < 0.01, `${home} → ${scene.docs.minX}`);
  check('and the sections with it',
        scene.sections.every((section) => {
          const before = sectionsAtHome.find((one) => one.code === section.code);
          return before && Math.abs(section.minX - before.minX) < 0.01;
        }),
        JSON.stringify({ before: sectionsAtHome, after: scene.sections }));
  inOrder(scene, 'after a merge');
  check('both shells survived the round trip', (await sessions()).length === 2,
        JSON.stringify((await sessions()).map((one) => one.id)));

  // ─── 4. A reload ─────────────────────────────────────────────

  console.log('\n4. the order survives a reload');
  await send('Page.navigate', { url: `${BASE}/?workspace=${PROJECT}` });
  await sleep(1500);
  await waitFor(() => evaluate(GRAB_API), 'the API handle after the reload');
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.mirror && now.terminal && now.docs ? now : null;
  }, 'the three regions after the reload', 200);
  await shot('05-reloaded');
  inOrder(scene, 'after a reload');

  // ─── 5. Away to another board, and back ──────────────────────

  console.log('\n5. and a board switched away from and back');
  await switchTo('Plain Board');
  await sleep(2500);
  await switchTo('Order Check');
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.mirror && now.terminal && now.docs ? now : null;
  }, 'the three regions after the switch', 200);
  await sleep(800);
  scene = await evaluate(PROBE);
  await shot('06-switched-back');
  inOrder(scene, 'after a switch away and back');

  // ─── 6. A board with no project, so no mirror ────────────────

  console.log('\n6. with no githubProject the block takes the vacant mirror slot');
  await send('Page.navigate', { url: `${BASE}/?workspace=${PLAIN}` });
  await sleep(1500);
  await waitFor(() => evaluate(GRAB_API), 'the API handle on the plain board');
  await waitFor(async () => (await evaluate(PROBE)).docs, 'the plain board\'s content');
  await pressKey('KeyT', 't', 1, 84);
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.terminal && now.docs ? now : null;
  }, 'the block on the plain board', 200);
  await wide('07-no-mirror');

  check('no mirror is drawn on a board with no project', scene.mirror === null,
        JSON.stringify(scene.mirror));
  inOrder(scene, 'with no mirror', { mirror: false });
  check('the block is one gap left of the content, in the slot the mirror would have had',
        Math.abs((scene.docs.minX - scene.terminal.maxX) - TERMINAL_GAP) < 1,
        `the gap is ${Math.round(scene.docs.minX - scene.terminal.maxX)}`);
  // Derived rather than named: since #199 the default is 125 × 30 cells, and what that is in
  // scene units depends on the cell this page measured. Same arithmetic the page ran, off the
  // same measurement — the grid itself is `check-terminal-default-grid-browser.mjs`'s question.
  const cell = await evaluate(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '${TERMINAL_FONT_SIZE}px ' + ${JSON.stringify(TERMINAL_FONT_FAMILY)};
    const metrics = ctx.measureText('W');
    return { advance: metrics.width,
             lineBox: metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent };
  })()`);
  const fresh = terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_SIZE, cell.lineBox, cell.advance);
  check(`at the size a fresh block is drawn at, ${TERMINAL_GRID.cols} columns of this page's cell`,
        Math.abs(scene.terminal.maxX - scene.terminal.minX - fresh.width) < 1,
        `${scene.terminal.maxX - scene.terminal.minX} wide, wanted ${fresh.width}`);
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
