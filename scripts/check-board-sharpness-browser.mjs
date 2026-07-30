#!/usr/bin/env node
/**
 * Checks why a board reads as blurry, and what a board switch is allowed to do about it.
 *
 * #245 is a reader on a big, high-resolution display saying the writing goes blurry when the
 * board is zoomed out, and asking for the resolution to be raised. There is no resolution to
 * raise, and the first half of this script says so **by measurement rather than by reading a
 * bundle**: Excalidraw hands `window.devicePixelRatio` to both renderers and rasterises every
 * element cache at `devicePixelRatio x zoom`, so the static canvas's backing store is exactly
 * `round(cssWidth x dpr)` — at dpr 1 and, the case that settles it, at dpr 2. Nothing is being
 * drawn below what the display can show, and no `EXCALIDRAW_*` variable could change it.
 *
 * What is being discarded is the board's own **zoom**. A fit takes the width of what it is
 * given, and a board switch used to give it the whole scene: on this repository's board that
 * is a 1320-wide mirror, a ~1282-wide terminal block and 2324 of documentation, two 120-unit
 * gaps apart — over 5,000 units against the ~2,544 CSS pixels a maximised 2560 display gives.
 * The landing was 0.4, the 13px card body was drawn at 5px, and canvas glyphs have no hinting,
 * so 5px reads as blurry rather than as small. It is #185's complaint arriving by the width
 * instead of by the height, and this was the last path that chose a zoom for the reader.
 *
 * So a board switch lands on the board's **first section** — the same shape `Alt+P` reaches —
 * and a section is 1130 wide, which is under the canvas at both widths checked here. Sections
 * 4 and 6 are the two that were red before the fix, at 0.69 on a 2560-wide canvas and 0.39 on
 * a laptop one. Section 7 is the other half of the reported symptom, and the half nothing here
 * can fix: during a wheel gesture Excalidraw deliberately keeps smoothing on and suppresses
 * cache regeneration (`shouldCacheIgnoreZoom`, cleared 300ms after the last wheel event), so
 * the question worth asking is whether the picture is still changing once the wheel stops. It
 * is not — which is what makes the blur at rest a question about the zoom and not the gesture.
 *
 * Only a browser can answer any of it. `zoom.value` lives on the `appState` of a mounted
 * component, a canvas backing store exists only once something has painted, and "the picture
 * stopped changing" is a claim about pixels. All of it type-checks either way.
 *
 * The scene is the live board's, not the tracked file's, because that is the whole point of
 * the issue: the mirror is drawn for real from a stubbed `gh`, and the terminal block is
 * **seeded into the store** at the size `terminalSizeFor` gives it. Seeded rather than opened
 * because the block a shell opens arrives a few hundred milliseconds after the scene does —
 * a race the reader never sees, having been on the board for minutes, but one that would
 * otherwise decide whether this check's premise held on any given run.
 *
 * Self-contained: throwaway registry and project directories, its own canvas server and its
 * own Chrome, all killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend and reads the layout
 * constants off the compiled server.
 *
 * Usage: node scripts/check-board-sharpness-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const terminalPath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
if (!existsSync(terminalPath)) {
  console.error(`  FAIL  the compiled server exists — ${terminalPath} not found`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
// Read rather than retyped: the block's size and the gap it stands in are what make the live
// scene twice the width of the display, and a copy of them here would be a second definition.
const { TERMINAL_KIND, TERMINAL_GAP, TERMINAL_SIZE } =
  await import(pathToFileURL(terminalPath).href);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Three boards: one to start on, and the same documentation board at two widths ──
//
// Two copies rather than one visited twice, because the landing under check happens on a
// board's *first* visit and a viewport is remembered per board from then on. Clearing that
// memory would mean reaching into a React ref; a second board is the honest way to ask the
// same question again at another canvas width.

const workDir = mkdtempSync(join(tmpdir(), 'check-board-sharpness-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
const OTHER = 'other-board';
const WIDE = 'wide-display';
const LAPTOP = 'laptop-display';
const dirs = Object.fromEntries([OTHER, WIDE, LAPTOP].map((id) => [id, join(workDir, id)]));
for (const dir of [...Object.values(dirs), profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

// Three columns, so the mirror draws four with its own Notes column: the 1320 units the
// issue's width table starts from.
const COLUMNS = [
  { id: 'f75ad846', name: 'Todo' },
  { id: '47fc9ee4', name: 'In Progress' },
  { id: '98236657', name: 'Done' },
];

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_sharpness',
    title: 'Sharpness',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: COLUMNS },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: COLUMNS[0].id, name: COLUMNS[0].name },
      content: {
        __typename: 'Issue',
        number: 245,
        title: 'Zoomed out the board is blurry',
        url: 'https://github.com/vitorengers/mcp_excalidraw/issues/245',
        createdAt: '2026-07-30T10:00:00Z',
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

writeFileSync(registryPath, JSON.stringify({
  workspaces: [OTHER, WIDE, LAPTOP].map((id) => ({ id, path: dirs[id].replace(/\\/g, '/') })),
}), 'utf8');
// No project on the board the page opens on: nothing draws a mirror there, so the only
// mirrors in this run are the ones drawn on the boards being switched *to*.
writeFileSync(join(dirs[OTHER], 'board.config.json'),
              JSON.stringify({ name: 'Somewhere Else' }), 'utf8');
for (const [id, name] of [[WIDE, 'Wide Display'], [LAPTOP, 'Laptop Display']]) {
  writeFileSync(join(dirs[id], 'board.config.json'), JSON.stringify({
    name,
    repo: 'vitorengers/mcp_excalidraw',
    githubProject: 'https://github.com/users/vitorengers/projects/5',
  }), 'utf8');
}

/** The documentation, as this repository's board draws it: two sections, side by side. */
const SECTION_WIDTH = 1130;
const SECTION_HEIGHT = 1400;
const SECTION_GAP = 44;
const STRUCTURE = { x: 0, y: 0, width: SECTION_WIDTH, height: SECTION_HEIGHT };
const DEVELOPMENT = { x: SECTION_WIDTH + SECTION_GAP, y: 0, width: SECTION_WIDTH, height: SECTION_HEIGHT };
/** The block one gap left of the documentation, which is where #200 put the region. */
const TERMINAL = {
  x: -(TERMINAL_GAP + TERMINAL_SIZE.width), y: 0,
  width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height,
};
/** A card in the first section, and the 13px body the issue is counting pixels of. */
const CARD = { x: 40, y: 80, width: 290, height: 120 };
const BODY_FONT_SIZE = 13;

/** The zoom the board is written at. Restated: a check that imports it cannot be red. */
const AUTHORED_ZOOM = 1;

const WINDOW = { width: 2560, height: 1440 };
const LAPTOP_VIEWPORT = { width: 1440, height: 900 };

const PORT = 36100 + (process.pid % 180);
const CDP_PORT = PORT + 260;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
  STUB_GH_FIXTURE: fixturePath,
};
// This machine's shell exports it, and a real shell would open a *second* terminal block
// beside the seeded one and drop the seeded one for having no session.
delete serverEnv.EXCALIDRAW_TERMINAL;

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: serverEnv,
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

const seed = (workspace, body) => fetch(`${BASE}/api/elements?workspace=${workspace}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

/** The documentation, the terminal block beside it, and a card to read. */
async function seedBoard(workspace) {
  await seed(workspace, {
    type: 'rectangle', ...STRUCTURE, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Project structure', hotkeyCode: 'KeyP', mark: workspace },
  });
  await seed(workspace, {
    type: 'rectangle', ...DEVELOPMENT, backgroundColor: 'transparent',
    customData: { kind: 'board-section', title: 'Development', hotkeyCode: 'KeyG' },
  });
  await seed(workspace, {
    type: 'rectangle', ...TERMINAL, backgroundColor: '#faf6ee',
    customData: { kind: TERMINAL_KIND },
  });
  await seed(workspace, {
    type: 'rectangle', ...CARD, backgroundColor: '#e7f5ff',
    customData: { docKey: 'architecture' },
  });
  await seed(workspace, {
    type: 'text', x: CARD.x + 18, y: CARD.y + 44, fontSize: BODY_FONT_SIZE,
    text: 'how the pieces fit', customData: { mark: `${workspace}-body` },
  });
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

async function shot(name, clip = undefined) {
  const { data } = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
  return Buffer.from(data, 'base64');
}

/** The reader's own wheel, and with Ctrl held, the reader's own zoom. */
async function wheel(deltaX, deltaY, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 600, y: 500, deltaX, deltaY, modifiers, button: 'none', buttons: 0,
  });
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
        window.__sharpnessApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__sharpnessApi;
  if (!api) return { error: 'no api handle' };
  const out = { sections: {}, marks: {}, boxes: [], mirror: 0, terminal: 0, body: null };
  for (const element of api.getSceneElements()) {
    if (element.isDeleted) continue;
    const custom = element.customData || {};
    const box = { x: element.x, y: element.y, w: element.width, h: element.height };
    out.boxes.push(box);
    if (custom.kind === 'board-section') out.sections[custom.title] = box;
    if (custom.kind === 'project-board') out.mirror++;
    if (custom.kind === ${JSON.stringify(TERMINAL_KIND)}) out.terminal++;
    if (custom.mark) out.marks[custom.mark] = box;
    if (element.type === 'text' && (custom.mark || '').endsWith('-body')) {
      out.body = { ...box, fontSize: element.fontSize };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  out.active = (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null;
  return out;
})()`;

/** What the browser is actually rasterising into, and what it was asked for. */
const CANVAS_PROBE = `(() => {
  const out = { dpr: window.devicePixelRatio, canvases: [] };
  for (const canvas of document.querySelectorAll('canvas.excalidraw__canvas')) {
    const rect = canvas.getBoundingClientRect();
    out.canvases.push({
      which: canvas.classList.contains('static') ? 'static'
        : canvas.classList.contains('interactive') ? 'interactive' : 'other',
      store: { width: canvas.width, height: canvas.height },
      css: { width: rect.width, height: rect.height },
    });
  }
  return out;
})()`;

/** Click the tab with this name on it. */
const selectTab = (name) => evaluate(`(() => {
  const tab = [...document.querySelectorAll('.workspace-tab__select')]
    .find((button) => (button.textContent || '').includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`);

const boundsOf = (boxes) => {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
};

/**
 * The zoom a fit of content this wide is not allowed to go below (`board-fit.ts`).
 *
 * Restated rather than imported: a check that asks the code under test what the answer
 * should be cannot be red.
 */
const floorFor = (view, contentWidth) => Math.min(AUTHORED_ZOOM, view.width / contentWidth);

/** Where a scene point is painted, in page coordinates. */
const toPage = (view, x, y) => ({
  x: (x + view.scrollX) * view.zoom + view.offsetLeft,
  y: (y + view.scrollY) * view.zoom + view.offsetTop,
});

/**
 * Has the fit landed on this box — is the reader looking at the start of it?
 *
 * Across the middle and at the **top**, the way `check-board-zoom-browser` asks it: a
 * section taller than the canvas is top-aligned since #232, so its middle is off the bottom
 * of the screen on a landing that is perfectly correct.
 */
const onScreen = (probe, box) => {
  const x = (box.x + box.w / 2 + probe.view.scrollX) * probe.view.zoom;
  const y = (box.y + probe.view.scrollY) * probe.view.zoom;
  return x > 0 && x < probe.view.width && y >= 0 && y < probe.view.height;
};

const show = (view) =>
  `zoom ${view.zoom.toFixed(3)} on a ${Math.round(view.width)}x${Math.round(view.height)} canvas`;

/** Wait for the board carrying this mark to be the one on the canvas. */
const boardShowing = (mark) => waitFor(async () => {
  const probe = await evaluate(PROBE);
  return probe.marks && probe.marks[mark] ? probe : null;
}, `the ${mark} board's own scene`);

/**
 * Switch onto a board for the first time, and report where the switch put the reader.
 *
 * The wait is for the landing rather than for the scene: `finishBoardSwitch` fits once the
 * new board's elements are on the canvas, and the mirror is drawn a moment after that.
 */
async function switchTo(name, mark) {
  check(`${name} has a tab to click`, await selectTab(name));
  await boardShowing(mark);
  await sleep(2000);
  return evaluate(PROBE);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await seed(OTHER, {
    type: 'rectangle', x: 0, y: 0, width: 320, height: 220,
    backgroundColor: '#e7f5ff', text: 'somewhere else', customData: { mark: OTHER },
  });
  await seedBoard(WIDE);
  await seedBoard(LAPTOP);

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

  console.log('1. the page opens on a board that is not the one under check');
  let probe = await boardShowing(OTHER);
  check('Somewhere Else is the board in front', /Somewhere Else/.test(probe.active ?? ''),
        String(probe.active));
  check('and the canvas is as wide as the display it was reported on',
        probe.view.width >= 2400, show(probe.view));

  console.log('\n2. switching onto the documentation board draws the live scene');
  probe = await switchTo('Wide Display', WIDE);
  await shot('02-wide-landing');
  const wideScene = boundsOf(probe.boxes);
  check('the mirror is drawn on it', probe.mirror > 0, `${probe.mirror} mirror element(s)`);
  check('a terminal block is standing beside the documentation', probe.terminal === 1,
        `${probe.terminal} block(s)`);
  check('so the scene is over twice the width of the canvas',
        wideScene.w > 2 * probe.view.width,
        `${Math.round(wideScene.w)} units against a ${Math.round(probe.view.width)}px canvas`);

  console.log('\n3. nothing is being rasterised below what the display can show');
  for (const dpr of [1, 2]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: WINDOW.width, height: WINDOW.height, deviceScaleFactor: dpr, mobile: false,
    });
    await sleep(300);
    await wheel(0, 1);            // one notch, to be sure something has repainted since
    await sleep(700);
    const canvases = await evaluate(CANVAS_PROBE);
    check(`the page is being drawn at devicePixelRatio ${dpr}`, canvases.dpr === dpr,
          `devicePixelRatio ${canvases.dpr}`);
    const stat = canvases.canvases.find((entry) => entry.which === 'static');
    check(`the static canvas exists at dpr ${dpr}`, Boolean(stat),
          JSON.stringify(canvases.canvases.map((entry) => entry.which)));
    if (!stat) continue;
    const wanted = Math.round(stat.css.width * canvases.dpr);
    check(`and its backing store is cssWidth x dpr, not a fixed resolution (dpr ${dpr})`,
          Math.abs(stat.store.width - wanted) <= 1,
          `${stat.store.width} backing pixels for ${stat.css.width} CSS px at dpr ${canvases.dpr}`);
  }
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);

  console.log('\n4. so what a board switch may not do is choose a zoom below the authored one');
  const structure = probe.sections['Project structure'];
  check('the whole scene could not have been fitted at the authored zoom',
        floorFor(probe.view, wideScene.w) < AUTHORED_ZOOM,
        `a whole-scene fit floors at ${floorFor(probe.view, wideScene.w).toFixed(3)}`);
  check('the first section is what the switch landed on', onScreen(probe, structure),
        `${show(probe.view)}, scrollX ${probe.view.scrollX.toFixed(1)}`);
  check('and it is drawn at or above the zoom the board was written at',
        probe.view.zoom >= AUTHORED_ZOOM - 0.001, show(probe.view));
  check('so the 13px card body is painted at 13px or more',
        probe.body !== null && probe.body.fontSize * probe.view.zoom >= BODY_FONT_SIZE - 0.01,
        probe.body ? `${(probe.body.fontSize * probe.view.zoom).toFixed(1)}px` : 'no body text found');

  console.log('\n5. the picture has settled by the time the wheel has');
  // Zoomed out by hand, which is the gesture the report is about, and then left alone. Two
  // shots of the same card: at 450ms, past the 300ms `shouldCacheIgnoreZoom` timer, and again
  // three quarters of a second later. Clipped to the canvas so the header's sync status — a
  // clock, which changes on its own — is not what a difference would be measuring.
  for (let notch = 0; notch < 4; notch++) { await wheel(0, 120, 2); await sleep(120); }
  const settled = await evaluate(PROBE);
  const at = toPage(settled.view, CARD.x, CARD.y);
  const clip = { x: Math.round(at.x), y: Math.round(at.y), width: 300, height: 160, scale: 1 };
  check('the wheel zoomed the board out', settled.view.zoom < probe.view.zoom - 0.01,
        `${probe.view.zoom.toFixed(3)} -> ${settled.view.zoom.toFixed(3)}`);
  check('and the card is still on screen to be photographed',
        clip.x >= 0 && clip.y >= 0
        && clip.x + clip.width <= settled.view.width + settled.view.offsetLeft
        && clip.y + clip.height <= settled.view.height + settled.view.offsetTop,
        JSON.stringify(clip));
  await sleep(450);
  const early = await shot('05-settled-450ms', clip);
  await sleep(750);
  const late = await shot('05-settled-1200ms', clip);
  check('the same pixels 450ms and 1200ms after the last wheel event',
        early.equals(late),
        `${early.length} vs ${late.length} bytes — the picture was still changing at rest`);

  console.log('\n6. and the same landing on a laptop-width canvas');
  await send('Emulation.setDeviceMetricsOverride', { ...LAPTOP_VIEWPORT, deviceScaleFactor: 1, mobile: false });
  await sleep(800);
  probe = await switchTo('Laptop Display', LAPTOP);
  await shot('06-laptop-landing');
  const laptopScene = boundsOf(probe.boxes);
  check('the canvas is a laptop\'s now', probe.view.width <= 1500, show(probe.view));
  check('the whole scene could not have been fitted at the authored zoom here either',
        floorFor(probe.view, laptopScene.w) < AUTHORED_ZOOM,
        `a whole-scene fit floors at ${floorFor(probe.view, laptopScene.w).toFixed(3)}`);
  check('the first section is what the switch landed on',
        onScreen(probe, probe.sections['Project structure']), show(probe.view));
  check('and it is drawn at or above the zoom the board was written at',
        probe.view.zoom >= AUTHORED_ZOOM - 0.001, show(probe.view));
  check('so the 13px card body is painted at 13px or more here too',
        probe.body !== null && probe.body.fontSize * probe.view.zoom >= BODY_FONT_SIZE - 0.01,
        probe.body ? `${(probe.body.fontSize * probe.view.zoom).toFixed(1)}px` : 'no body text found');
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
