#!/usr/bin/env node
/**
 * Checks where `Alt+B` and `Alt+P` put a target that is taller than the canvas.
 *
 * #232 is a reader on a Mac saying the mirror "goes to back of the top bar" — its column
 * headers and its title are not on the screen the key just brought them to. The report
 * guessed at a resolution difference, and the arithmetic says the guess is the right shape:
 * it is canvas *height*, and nothing else. Since #185 the fit has a floor, so where the
 * height is the tighter of the two axes the zoom is put back above it and the target is then
 * taller than the canvas — and Excalidraw **centres** the bounds it is given, splitting that
 * overflow half above and half below. The half above is the top of the thing being read. A
 * full `Todo` column is about 900 scene pixels: taller than a laptop canvas, shorter than a
 * maximised desktop one, which is the whole of "on Windows the behavior is different".
 *
 * Two rules are asserted here, and the second is the fix:
 *
 *   - a target taller than the canvas is **top-aligned**, not centred;
 *   - Excalidraw's own floating menus are **reserved**, because they are painted over the
 *     canvas and its hamburger and properties island sit in the top-left corner — the corner
 *     the mirror is drawn in. So the assertion is not `y > 0`, which a landing buried under
 *     the toolbar passes; it is `y >= the bottom of the toolbar`.
 *
 * Both at **two viewports**, one tall enough for the mirror and one too short for it, and
 * both with `Hide Menus` on and off — with the menus hidden the toolbar reserves nothing and
 * the top-alignment has to hold on its own, which is what keeps one rule from masking the
 * other. The tall viewport is the control: it was already right, and it must stay right.
 *
 * `Alt+P` is asserted alongside `Alt+B` on purpose. Sections share `fitLegibly`, and
 * `docs/board-sections.md` had accepted the centring for them deliberately — that decision is
 * reversed by this change, so it is checked rather than only rewritten.
 *
 * Only a browser can answer any of it. The landing is Excalidraw's own camera arithmetic over
 * a real canvas size, and the reserved band is the rendered height of a toolbar that depends
 * on what is selected. All of it type-checks perfectly whether or not it works — the category
 * `CLAUDE.md` names as having compiled and done nothing three times.
 *
 * The project is a stub `gh` answering from a file, so a real mirror is drawn without
 * touching anybody's board. Self-contained otherwise: throwaway registry and project
 * directory, its own canvas server, both killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-board-landing-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project with one very tall column ──────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-board-landing-'));
const projectDir = join(workDir, 'landing-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const REVIEW = { id: '11aa22bb', name: 'In Review' };
const DONE = { id: '98236657', name: 'Done' };

const item = (number, title, option) => ({
  id: `PVTI_${number}`,
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

/**
 * Fourteen in `Todo`, so the region is about as tall as this repository's own.
 *
 * `48 + 24 + 44 + n x (52 + 12) + 24` — a title strip, the padding, a column header and one
 * card per item (`src/core/project-board-layout.ts`). Fourteen is ~1040 scene pixels, which
 * is taller than a laptop canvas and shorter than the tall viewport below: the two cases this
 * check exists to tell apart. The titles are one short word so a wrap does not move the
 * number around between runs.
 */
const nodes = [
  ...Array.from({ length: 14 }, (_, index) => item(100 + index, `Queued ${index + 1}`, TODO)),
  item(200, 'Running', DOING),
  item(201, 'Reading', REVIEW),
  item(202, 'Landed', DONE),
];

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, REVIEW, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes },
  } } },
}), 'utf8');

/** A `gh` that answers the project read from a file and nothing else. */
writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'landing-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Landing Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

/** A section as tall as a real one, for the `Alt+P` half. */
const SECTION = { x: 0, y: 0, width: 900, height: 2200 };

const PORT = 36400 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

/**
 * The two canvas sizes the whole check turns on.
 *
 * `TALL` is a maximised desktop window, where the mirror fits and the landing was already
 * right. `SHORT` is the 14" MacBook Pro of the report, less its chrome — the canvas is about
 * 600 pixels of a ~1040 region, so the floor overrules the height fit and the old centring
 * threw half the difference off the top.
 */
const TALL = { width: 1500, height: 1500 };
const SHORT = { width: 1500, height: 740 };
const WINDOW = { width: TALL.width, height: 1000 };

// Off deliberately, and said rather than left to the shell: this machine exports
// EXCALIDRAW_TERMINAL=1, and a terminal block would put a DOM overlay over the mirror and an
// extra shape into every bound measured here.
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    EXCALIDRAW_TERMINAL: '',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 160) {
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

/** Alt and a letter, which is what a board hotkey means on the page. */
async function altPress(code, key, virtualKey) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, code, key, modifiers: 1, windowsVirtualKeyCode: virtualKey,
    });
  }
  // scrollToContent animates; the assertion is about where it lands, not how it gets there.
  await sleep(1600);
}

/**
 * Resize the canvas the way dragging the window would, and let the page settle into it.
 *
 * Waited out by watching the number the assertions are about — `appState.height` — rather
 * than by sleeping a guessed interval: Excalidraw takes the new size from a resize observer,
 * so a probe taken too early reports the old canvas and every landing computed against it is
 * arithmetic about a window nobody is looking at.
 */
async function useViewport(size) {
  const before = (await evaluate(PROBE)).view?.height ?? 0;
  await send('Emulation.setDeviceMetricsOverride', {
    width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false,
  });
  await waitFor(async () => {
    const probe = await evaluate(PROBE);
    // Shorter than the viewport, because the page's own header and tab strip are above it,
    // and not what it was.
    return probe.view && probe.view.height !== before
      && probe.view.height > 0 && probe.view.height < size.height;
  }, `the canvas to take a ${size.width}x${size.height} viewport`);
  await sleep(600);
}

/** The imperative API, through the container's React fibre. See check-board-sections-browser. */
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
        window.__landingApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Everything one assertion needs, read off the page in one go.
 *
 * The reserved band is measured here rather than imported from `board-fit.ts`: a check that
 * asks the code under test what the answer should be cannot go red. It is the same two nodes
 * Excalidraw's own `getEditorUIOffsets` measures — the toolbar across the top and the
 * properties island on the left — taken relative to the canvas box, because that is the box
 * the landing is expressed in. A `display: none` node answers with a rect of zeros, which is
 * how `Hide Menus` reaches this side without a flag.
 */
const PROBE = `(() => {
  const api = window.__landingApi;
  if (!api) return { error: 'no api handle' };
  const state = api.getAppState();
  const view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                 width: state.width, height: state.height };

  const box = document.querySelector('.excalidraw-container').getBoundingClientRect();
  const bandOf = (selector, edge) => {
    const node = document.querySelector(selector);
    if (!node) return 0;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) return 0;
    return Math.max(edge(rect, box), 0);
  };
  const reserved = {
    top: bandOf('.App-toolbar', (rect, container) => rect.bottom - container.top),
    left: bandOf('.App-menu__left', (rect, container) => rect.right - container.left),
  };

  const bounds = (test) => {
    let box = null;
    for (const element of api.getSceneElements()) {
      if (element.isDeleted || !test(element)) continue;
      const one = { x: element.x, y: element.y, w: element.width, h: element.height };
      box = box === null ? one : {
        x: Math.min(box.x, one.x),
        y: Math.min(box.y, one.y),
        w: Math.max(box.x + box.w, one.x + one.w) - Math.min(box.x, one.x),
        h: Math.max(box.y + box.h, one.y + one.h) - Math.min(box.y, one.y),
      };
    }
    return box;
  };

  const custom = (element) => element.customData || {};
  return {
    view,
    reserved,
    mirror: bounds((element) => custom(element).kind === 'project-board'),
    section: bounds((element) => custom(element).kind === 'board-section'),
    menusHidden: document.querySelector('.app').getAttribute('data-chrome') === 'hidden',
  };
})()`;

/** `Hide Menus` / `Show Menus`, the button in the page's own header. */
const toggleMenus = () => evaluate(`(() => {
  const button = document.querySelector('.chrome-toggle');
  if (!button) return false;
  button.click();
  return true;
})()`);

/** The top edge of a scene box, in canvas pixels — what the reader's eye is at. */
const topEdge = (view, box) => (box.y + view.scrollY) * view.zoom;

/** How tall this box is drawn, against how much canvas there is to draw it in. */
const overflows = (view, box) => box.h * view.zoom > view.height;

const describe = (view, box, reserved) =>
  `top edge ${topEdge(view, box).toFixed(1)}, reserved ${reserved.top.toFixed(1)}, `
  + `canvas ${view.height}, drawn ${(box.h * view.zoom).toFixed(1)} at zoom ${view.zoom.toFixed(3)}`;

/**
 * One landing, asserted.
 *
 * The whole point of #232 is in the comparison: not `topEdge > 0`, which a landing buried
 * under the toolbar passes, but `topEdge >= the bottom of the toolbar`. And bounded above, so
 * a camera that fixed the top by scrolling the region off the bottom is not read as a pass.
 */
function assertLanding(label, probe, box) {
  const top = topEdge(probe.view, box);
  check(`${label}: its top edge is clear of Excalidraw's own toolbar`,
        top >= probe.reserved.top - 1, describe(probe.view, box, probe.reserved));
  check(`${label}: and it starts on the screen rather than below it`,
        top < probe.view.height, describe(probe.view, box, probe.reserved));
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Seeded before the page opens, so the region is placed against it once and stays there.
  await fetch(`${BASE}/api/elements?workspace=landing-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'rectangle', ...SECTION, backgroundColor: 'transparent',
      customData: { kind: 'board-section', title: 'Project structure', hotkeyCode: 'KeyP' },
    }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${WINDOW.width},${WINDOW.height}`,
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  console.log('1. the stub project is mirrored onto the canvas');
  let probe = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.mirror ? seen : null;
  }, 'the mirror to be drawn');
  check('the mirror is on the board', probe.mirror !== null, JSON.stringify(probe.mirror));
  check('and it is as tall as a real one', (probe.mirror?.h ?? 0) > 800,
        `${probe.mirror?.w?.toFixed(0)} x ${probe.mirror?.h?.toFixed(0)}`);

  console.log('\n2. a canvas tall enough for the mirror — the case that was already right');
  await useViewport(TALL);
  await altPress('KeyB', 'b', 66);
  probe = await evaluate(PROBE);
  await shot('02-tall-menus-shown');
  check('Excalidraw is drawing its toolbar, so there is a band to be clear of',
        probe.reserved.top > 0, `reserved ${probe.reserved.top}`);
  check('the mirror fits this canvas',
        !overflows(probe.view, probe.mirror), describe(probe.view, probe.mirror, probe.reserved));
  assertLanding('Alt+B on a tall canvas', probe, probe.mirror);

  console.log('\n3. and the same with the menus hidden');
  check('the Hide Menus button is there to press', await toggleMenus());
  await sleep(400);
  await altPress('KeyB', 'b', 66);
  probe = await evaluate(PROBE);
  await shot('03-tall-menus-hidden');
  check('the menus are hidden', probe.menusHidden === true);
  check('so nothing is reserved at the top', probe.reserved.top === 0, `reserved ${probe.reserved.top}`);
  assertLanding('Alt+B on a tall canvas, menus hidden', probe, probe.mirror);

  console.log('\n4. a canvas too short for the mirror, menus hidden — the report, without the chrome');
  await useViewport(SHORT);
  await altPress('KeyB', 'b', 66);
  probe = await evaluate(PROBE);
  await shot('04-short-menus-hidden');
  check('the mirror is taller than this canvas, so the fit has an overflow to place',
        overflows(probe.view, probe.mirror), describe(probe.view, probe.mirror, probe.reserved));
  assertLanding('Alt+B on a short canvas, menus hidden', probe, probe.mirror);

  console.log('\n5. and with the menus back, which is where the report was');
  check('the Show Menus button is there to press', await toggleMenus());
  await sleep(400);
  await altPress('KeyB', 'b', 66);
  probe = await evaluate(PROBE);
  await shot('05-short-menus-shown');
  check('the menus are showing again', probe.menusHidden === false);
  check('Excalidraw is drawing its toolbar over the canvas',
        probe.reserved.top > 0, `reserved ${probe.reserved.top}`);
  check('the mirror is still taller than this canvas',
        overflows(probe.view, probe.mirror), describe(probe.view, probe.mirror, probe.reserved));
  assertLanding('Alt+B on a short canvas', probe, probe.mirror);

  console.log('\n6. Alt+P lands the same way — sections share the rule, they are not exempt');
  await altPress('KeyP', 'p', 80);
  probe = await evaluate(PROBE);
  await shot('06-short-alt-p');
  check('the section is taller than this canvas too',
        overflows(probe.view, probe.section), describe(probe.view, probe.section, probe.reserved));
  assertLanding('Alt+P on a short canvas', probe, probe.section);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
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
