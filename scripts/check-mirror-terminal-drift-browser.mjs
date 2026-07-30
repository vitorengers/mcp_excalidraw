#!/usr/bin/env node
/**
 * Checks that the mirror and the terminal block stay where they were put, side by side.
 *
 * The observation behind #188 was a board holding nothing but those two, on which they
 * sometimes landed on top of each other and separated again on their own. Neither one is
 * dragged and no z-order changes — both are geometry. The mirror re-decides its origin on
 * every twenty-second poll; the block is placed once and never re-anchored (`docs/terminal.md`),
 * so the region moves under it.
 *
 * The two ways it moved, and both are reproduced here:
 *
 *   - **the unmeasured fallback is a content-independent constant.** `resolveMirrorOrigin`
 *     answered an empty anchor set with `{ x: -(width + MIRROR_GAP), y: 0 }` and did not
 *     remember it, so every poll decided again — and `width` is GitHub's, so a column added
 *     to the project moved the region one column-width further left, straight onto a block
 *     anchored to where the region used to be. A board holding only a mirror and a terminal
 *     has an empty anchor set on *every* poll, which is the board this is about.
 *   - **the region re-anchors to a shape inside itself.** The anchor set excludes the
 *     mirror, the terminal and the draft blocks by their marks, and a block that lost its
 *     draft mark — or never carried one — is an ordinary authored shape sitting inside the
 *     notes column. Measured against it, the region lands one mirror-width further left,
 *     over the block, and that origin *is* remembered, so it stays there.
 *
 * Both are wired to a poll, and `CLAUDE.md` is explicit about what that means: three defects
 * in this layer compiled perfectly and did none of what they claimed. So this drives a real
 * Chrome, opens a real terminal against a real shell, and asks what the numbers are after
 * ten refreshes, a column appearing, a shape dropped inside the region, and a board switched
 * away from and back.
 *
 * `check-mirror-anchor.mjs` covers the arithmetic offline, `check-mirror-anchor-browser.mjs`
 * the same region against a board that has content. This one is about the board that has
 * none, which is the case where the two regions have only each other to be placed from.
 *
 * The polls are driven by `visibilitychange`, which the canvas already answers with a
 * refresh — the same `refreshProjectBoard` the timer calls, and the event the definition of
 * done names. One real twenty-second poll is waited out as well, so nothing here passes by
 * only ever taking the shortcut.
 *
 * The project is a stub `gh` answering from a file, so a column can be added to it without
 * touching anybody's real board. Self-contained otherwise: it writes the stub, starts its
 * own canvas server against two throwaway workspaces, and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-mirror-terminal-drift-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const typesPath = join(repoRoot, 'dist', 'core', 'project-board-types.js');
const layoutPath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
for (const path of [terminalPath, typesPath, layoutPath]) {
  if (!existsSync(path)) {
    console.error(`  FAIL  the compiled server exists — ${path} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
}

// Read rather than retyped: the separation this whole check is about is these two numbers,
// and a copy of them here would be a second definition to drift from the one under test.
const { TERMINAL_KIND, TERMINAL_GAP, TERMINAL_SIZE } = await import(pathToFileURL(terminalPath).href);
const { MIRROR_GAP } = await import(pathToFileURL(layoutPath).href);
const NOTES = await import(pathToFileURL(typesPath).href);

/**
 * What stands between the two regions' near edges.
 *
 * Since #200 the canvas reads mirror | terminals | documentation, so the mirror is the
 * outermost region and its **right** edge is what the block is placed one gap from. Read out
 * of the module rather than retyped: the separation this check is about is that number.
 */
const SEPARATION = MIRROR_GAP;

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── Two boards, one of them with a project to mirror ──────────

const workDir = mkdtempSync(join(tmpdir(), 'check-mirror-drift-'));
const projectDir = join(workDir, 'drift-check');
const otherDir = join(workDir, 'drift-other');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, otherDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
/** The column that is not there to begin with. GitHub appends a new option last. */
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, title, option) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`,
    createdAt: '2026-07-20T10:00:00Z',
    state: 'OPEN',
    repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
  },
});

const payload = (options) => JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'Drift',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 3, 'Being worked on', DOING),
      item('PVTI_b', 21, 'Waiting to be picked up', TODO),
    ] },
  } } },
});

const TWO = [TODO, DOING];
const THREE_OPTIONS = [TODO, DOING, DONE];

writeFileSync(fixturePath, payload(TWO), 'utf8');
writeFileSync(logPath, '', 'utf8');

/** A `gh` that answers from a file — rewritten mid-run — and logs every call it is given. */
writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'drift-check', path: projectDir.replace(/\\/g, '/') },
    { id: 'drift-other', path: otherDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Drift Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');
// The board switched to and back from. No project on it, so nothing here draws a mirror —
// it exists to be somewhere else, which is all the switch needs it to be.
writeFileSync(join(otherDir, 'board.config.json'), JSON.stringify({ name: 'Somewhere Else' }), 'utf8');

const PORT = 35700 + (process.pid % 200);
const CDP_PORT = PORT + 250;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    // The block is half of what this check is about, so it is switched on deliberately here
    // rather than inherited from whatever the shell happened to export.
    EXCALIDRAW_TERMINAL: '1',
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    STUB_GH_LOG: logPath,
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

const api = (path, init) => fetch(`${BASE}${path}`, {
  headers: { 'Content-Type': 'application/json' }, ...init,
});

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const graphqlCalls = () => ghCalls().filter((call) => call.includes('graphql')).length;

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

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
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
        window.__driftCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__driftCheckApi;
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
  const scene = api.getSceneElements();
  const kindOf = (e) => (e.customData || {}).kind;
  const mirrorParts = scene.filter((e) => kindOf(e) === 'project-board');
  const terminalParts = scene.filter((e) => kindOf(e) === ${JSON.stringify(TERMINAL_KIND)});
  return {
    mirror: box(mirrorParts),
    terminal: box(terminalParts),
    columns: mirrorParts
      .filter((e) => (e.customData || {}).role === 'section')
      .map((e) => ({ col: (e.customData || {}).sectionOptionId, x: e.x }))
      .sort((a, b) => a.x - b.x),
    title: (() => {
      const strip = mirrorParts.find((e) => (e.customData || {}).role === 'title');
      return strip ? { x: strip.x, y: strip.y, w: strip.width } : null;
    })(),
    stray: scene
      .filter((e) => !kindOf(e) && !e.containerId)
      .map((e) => ({ id: e.id, x: e.x, y: e.y })),
  };
})()`;

/** One poll, through the door the canvas already opens for a tab coming back on screen. */
const refresh = async () => {
  const before = graphqlCalls();
  await evaluate(`(() => { document.dispatchEvent(new Event('visibilitychange')); return true; })()`);
  await waitFor(() => graphqlCalls() > before, 'the refresh to reach gh', 40);
  // The answer still has to travel back and be drawn.
  await sleep(600);
};

const intersects = (a, b) => Boolean(a) && Boolean(b)
  && a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

const at = (box) => (box ? `(${Math.round(box.minX)}, ${Math.round(box.minY)})` : 'nothing');
const columnIds = (scene) => scene.columns.map((column) => column.col);

/** Where the region started, so every later phase is measured against one number. */
let placed = null;

/**
 * The region has not moved — asked of the edge it pins, which since #200 is the **right**
 * one. That is the edge the block is placed from, so it is the edge that has to hold still;
 * a column added on GitHub grows the region leftward, into canvas nobody is using, and its
 * left edge moving is the growth rather than a drift. `MirrorAnchor` has the whole argument.
 */
const stillThere = (scene, what) => {
  check(`${what}: the region's pinned edge is where it was first drawn, ${at(placed)}`,
        scene.mirror
        && Math.abs(scene.mirror.maxX - placed.maxX) < 1
        && Math.abs(scene.mirror.minY - placed.minY) < 1,
        `it is at ${at(scene.mirror)}, ${Math.round(scene.mirror.maxX - placed.maxX)} across `
        + `and ${Math.round(scene.mirror.minY - placed.minY)} down from where it was put`);
  check(`${what}: the region and the block do not overlap`,
        !intersects(scene.mirror, scene.terminal),
        `mirror ${JSON.stringify(scene.mirror)} over terminal ${JSON.stringify(scene.terminal)}`);
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
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => (await evaluate(PROBE)).columns.length >= 3, 'the mirror to render');

  // ─── 1. A board holding only a mirror and a terminal ──────────

  console.log('1. the two are placed side by side, at the separation the block is anchored by');

  // The block after the mirror rather than before it, so this phase measures a settled
  // arrangement rather than a race: since #200 the block is placed from the documentation and
  // the *region* steps aside for it, which takes a poll on a board that had none.
  await pressKey('KeyT', 't', 1, 84);
  let scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.terminal && now.mirror && now.mirror.maxX <= now.terminal.minX + 1 ? now : null;
  }, 'the terminal block to be placed', 200);
  await shot('01-side-by-side');

  check('the board has a mirror and a block on it, and nothing else',
        scene.mirror && scene.terminal && scene.stray.length === 0,
        JSON.stringify({ mirror: scene.mirror, terminal: scene.terminal, stray: scene.stray }));
  check(`the region's right edge is ${SEPARATION} left of the block's, which is what places it`,
        Math.abs((scene.terminal.minX - scene.mirror.maxX) - SEPARATION) < 1,
        `the separation is ${Math.round(scene.terminal.minX - scene.mirror.maxX)}`);
  check('and its top is level with the region\'s top',
        Math.abs(scene.mirror.minY - scene.terminal.minY) < 1,
        `mirror at y ${scene.mirror.minY}, block at y ${scene.terminal.minY}`);
  check('so they do not overlap', !intersects(scene.mirror, scene.terminal),
        `mirror ${JSON.stringify(scene.mirror)} over terminal ${JSON.stringify(scene.terminal)}`);

  placed = { minX: scene.mirror.minX, maxX: scene.mirror.maxX, minY: scene.mirror.minY };
  const firstColumns = columnIds(scene);

  // ─── 2. Ten polls, and one of them the real twenty seconds ────

  console.log('\n2. ten polls later, with nobody touching either, both are where they were');
  for (let poll = 0; poll < 10; poll++) await refresh();
  scene = await evaluate(PROBE);
  await shot('02-after-ten-polls');
  stillThere(scene, 'after ten refreshes');

  // The refreshes above go through the same `refreshProjectBoard` the timer calls, but a
  // check that only ever took the shortcut would not have let the timer itself run once.
  await sleep(21000);
  scene = await evaluate(PROBE);
  stillThere(scene, 'after a real twenty-second poll');

  // ─── 3. A column appears on GitHub ───────────────────────────

  console.log('\n3. a column added on GitHub grows the region rather than moving it');
  writeFileSync(fixturePath, payload(THREE_OPTIONS), 'utf8');
  scene = await waitFor(async () => {
    await refresh();
    const now = await evaluate(PROBE);
    return now.columns.length === firstColumns.length + 1 ? now : null;
  }, 'the poll to bring the fourth column in', 40);
  await shot('03-column-added');

  check('the fourth column arrived, with nothing touched on the canvas',
        JSON.stringify(columnIds(scene))
          === JSON.stringify([NOTES.NOTES_OPTION_ID, TODO.id, DOING.id, DONE.id]),
        JSON.stringify(columnIds(scene)));
  stillThere(scene, 'with a wider region');
  check('the region grew leftward, into the empty canvas, rather than rightward onto the block',
        scene.mirror.minX < placed.minX - 1 && scene.mirror.maxX <= scene.terminal.minX,
        JSON.stringify({ mirror: scene.mirror, wasAt: placed, title: scene.title }));

  // ─── 4. A shape dropped inside the region ────────────────────

  console.log('\n4. a shape inside the region does not become what the region is measured from');
  // Inside the notes column, below its header — where a block that lost its draft mark sits,
  // which is the shape the wrong-state screenshot showed.
  const strayAt = { x: Math.round(scene.mirror.minX + 50), y: Math.round(scene.mirror.minY + 150) };
  check('the spot chosen for it really is inside the region',
        strayAt.x > scene.mirror.minX && strayAt.x < scene.mirror.maxX
        && strayAt.y > scene.mirror.minY && strayAt.y < scene.mirror.maxY,
        `${JSON.stringify(strayAt)} against ${JSON.stringify(scene.mirror)}`);

  await api('/api/elements?workspace=drift-check', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', ...strayAt, width: 260, height: 60, backgroundColor: '#ffe3e3',
    }),
  });
  await waitFor(async () => (await evaluate(PROBE)).stray.some((element) => element.x === strayAt.x),
                'the shape to reach the canvas');
  await refresh();
  await refresh();
  scene = await evaluate(PROBE);
  await shot('04-shape-inside-the-region');
  stillThere(scene, 'with a shape inside it');

  // ─── 5. Away to another board and back ───────────────────────

  console.log('\n5. switching away and back does not re-decide where the region goes');
  const clickTab = (name) => evaluate(`(() => {
    const tabs = [...document.querySelectorAll('.workspace-tab')];
    const wanted = tabs.find((tab) => (tab.textContent || '').includes(${JSON.stringify(name)}));
    if (!wanted) return false;
    const button = wanted.querySelector('.workspace-tab__select') || wanted;
    button.click();
    return true;
  })()`);

  check('the other board has a tab to switch to', await clickTab('Somewhere Else'));
  await waitFor(async () => (await evaluate(PROBE)).columns.length === 0,
                'the other board to take the canvas', 80);
  await shot('05-other-board');
  await sleep(1500);

  check('and this one has a tab to come back to', await clickTab('Drift Check'));
  scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.mirror && now.terminal ? now : null;
  }, 'the board to come back with both regions on it', 200);
  await refresh();
  scene = await evaluate(PROBE);
  await shot('06-back-again');
  stillThere(scene, 'after a switch away and back');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
