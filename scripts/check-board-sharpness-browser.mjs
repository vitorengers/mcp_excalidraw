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
 * opened for real by a stub shell. Neither can be seeded into the store instead — both are
 * derived, the autosync strips them on the way out, and a seeded one is gone within a second
 * of the page reading the board. Which of them is on the canvas at the instant the switch
 * fits is therefore a race with how fast `gh` answers, and that is the point rather than a
 * flaw in the setup: the mirror alone already takes the landing below the authored zoom, and
 * the fix is that neither is ever fitted again.
 *
 * Sections 7 and 8 are #267, the same reader again with the zoom now constant at 100%: text is
 * legible while it is being typed and goes soft the moment it is committed. Two rasterisers draw
 * the same string. **Editing is DOM** — Excalidraw creates a real `<textarea class=
 * "excalidraw-wysiwyg">`, which Blink hints and snaps per glyph. **Committed it is a bitmap
 * twice over** — an offscreen element cache at `devicePixelRatio x zoom` whose pixel size is
 * floored, blitted at a fractional destination with `imageSmoothingEnabled` off, onto a scene
 * canvas whose own backing store is `appState.width * devicePixelRatio` **truncated** by the
 * `unsigned long` `canvas.width` attribute (`dist/dev/index.js:23449`).
 *
 * The issue proposed a floor and an amplifier. **The floor is real and the amplifier is not**,
 * and these two sections are why.
 *
 * **The floor is A**, and section 8 measures it rather than arguing it: the same string is
 * photographed with the editor open and again once it is committed, at one fixed zoom, and edge
 * figures are reported for each. Canvas2D text has no hinting and no subpixel antialiasing;
 * committed text cannot match the editor's at any zoom or resolution while the board is a
 * canvas. Nothing in this repository lifts that, and the case that reports it passes before and
 * after — it is a measurement kept honest, not a regression gate.
 *
 * **B was the amplifier, and section 7 retires it.** At a fractional `devicePixelRatio` — Windows
 * scaling at 125% or 150%, or Chrome page zoom — the truncation leaves a backing store that is
 * not `cssWidth x dpr`, so the compositor does rescale the whole canvas layer. But what is
 * discarded is the fractional part of one product, so the shortfall is **bounded below one
 * device pixel** on each axis at any canvas size: measured, 0.75 in 1013.75 and 0.5 in 1216.5,
 * about one part in 1,350 and one in 2,433. That is not "dropping and duplicating pixel columns
 * through every glyph"; it is a rescale nothing can see, and the section asserts the bound
 * rather than the hypothesis.
 *
 * Which also settles what to do about `.excalidraw canvas { image-rendering: pixelated }`
 * (`dist/dev/index.css:5617`), the one rule the issue proposed changing. Overriding it to `auto`
 * was built and measured first, and it is the **wrong direction**: at a scale this close to 1,
 * nearest neighbour copies whole source rows, so every row on screen is one the rasteriser drew,
 * while bilinear blends every row with its neighbour at a near-constant phase. The committed
 * string lost 11% and 14% of its vertical edge figure and gained half again as many midtone
 * pixels — measurably softer, which is the complaint. The upstream rule stays, and the case in
 * section 7 holds it there.
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
import { inflateSync } from 'node:zlib';
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
// Read rather than retyped: what marks a block as the terminal's is the module's to say.
const { TERMINAL_KIND } = await import(pathToFileURL(terminalPath).href);

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
const stubShell = join(workDir, 'stub-shell.mjs');
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

/** A shell that says nothing and stays alive: this check is about geometry. */
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
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
/** A card in the first section, and the 13px body the issue is counting pixels of. */
const CARD = { x: 40, y: 80, width: 290, height: 120 };
const BODY_FONT_SIZE = 13;

/**
 * The string section 8 photographs twice, in the type the blocks #267 is about are drawn in.
 *
 * 16px Excalifont — `CARD_FONT_SIZE` and `fontFamily: 5` in `project-board-layout.ts` — because
 * a handwriting face with thin irregular stems is the worst case for an unhinted canvas, and the
 * blocks the reader was looking at are generated in it rather than authored.
 *
 * Placed well to the right of the section's left edge on purpose: committing the text selects
 * it, and a selected element puts Excalidraw's properties island down the left-hand side of the
 * canvas. A clip taken over that island would be measuring the island.
 */
const SHARPNESS = { x: 520, y: 420 };
const SHARPNESS_FONT_SIZE = 16;
const SHARPNESS_FONT_FAMILY = 5;
const SHARPNESS_TEXT = 'Illustration: the mirror card for #256';

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
  // Named rather than inherited: this machine's shell exports `EXCALIDRAW_TERMINAL=1`, which
  // would open a real shell per board, and a check that only works where the operator's
  // environment happens to say so is not a check.
  EXCALIDRAW_TERMINAL: `node "${stubShell.replace(/\\/g, '/')}"`,
  EXCALIDRAW_TERMINAL_PTY: '0',
};

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
    type: 'rectangle', ...CARD, backgroundColor: '#e7f5ff',
    customData: { docKey: 'architecture' },
  });
  await seed(workspace, {
    type: 'text', x: CARD.x + 18, y: CARD.y + 44, fontSize: BODY_FONT_SIZE,
    text: 'how the pieces fit', customData: { mark: `${workspace}-body` },
  });
  await seed(workspace, {
    type: 'text', ...SHARPNESS, fontSize: SHARPNESS_FONT_SIZE, fontFamily: SHARPNESS_FONT_FAMILY,
    text: SHARPNESS_TEXT, customData: { mark: `${workspace}-sharpness` },
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

/** A real double click, which is the only door into Excalidraw's text editor. */
async function doubleClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  for (const clickCount of [1, 2]) {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount,
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount,
    });
    await sleep(40);
  }
}

const KEYS = {
  Escape: { code: 'Escape', keyCode: 27 },
  End: { code: 'End', keyCode: 35 },
};

async function press(key) {
  const { code, keyCode } = KEYS[key];
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
  }
}

// ─── Pixels, as the screen really has them ────────────────────

/**
 * Enough of a PNG decoder to read a clipped screenshot back. Same shape as the one in
 * `check-terminal-paper-browser.mjs`: eight-bit, colour type 2 or 6, all five row filters,
 * which is all Chrome emits.
 *
 * Nothing in the page can answer section 8 instead. One of the two states being compared is a
 * DOM `<textarea>` and the other is a canvas bitmap composited under a CSS filter; the only
 * surface both have reached is the screen.
 */
function decodePng(buffer) {
  let at = 8;
  let header = null;
  const parts = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const lanes = header?.colour === 6 ? 4 : header?.colour === 2 ? 3 : 0;
  if (!lanes || header.depth !== 8) throw new Error(`unreadable screenshot: ${JSON.stringify(header)}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = header.width * lanes;
  const out = Buffer.alloc(stride * header.height);
  let source = 0;
  for (let row = 0; row < header.height; row++) {
    const filter = raw[source++];
    for (let index = 0; index < stride; index++) {
      const value = raw[source + index];
      const left = index >= lanes ? out[row * stride + index - lanes] : 0;
      const up = row > 0 ? out[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= lanes ? out[(row - 1) * stride + index - lanes] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else {
        const guess = left + up - upLeft;
        const toLeft = Math.abs(guess - left);
        const toUp = Math.abs(guess - up);
        const toCorner = Math.abs(guess - upLeft);
        restored = value + (toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : upLeft);
      }
      out[row * stride + index] = restored & 255;
    }
    source += stride;
  }
  const luminance = (x, y) => {
    const base = y * stride + x * lanes;
    return 0.2126 * out[base] + 0.7152 * out[base + 1] + 0.0722 * out[base + 2];
  };
  return { width: header.width, height: header.height, luminance };
}

/**
 * How hard the edges in a picture of text are, on a 0–255 luminance scale.
 *
 * The mean absolute difference between adjacent pixels — **along each axis separately**, which
 * is the part that matters here. A glyph whose stems land on the pixel grid steps from paper to
 * ink in one column and scores high; the same glyph resampled spreads that step over two or
 * three and scores lower. Section 7's rescale is vertical only on this geometry, so a figure
 * that averaged the two axes together would halve the signal it exists to carry.
 *
 * `midtone` is the same claim counted the other way round: the share of pixels that are neither
 * paper nor ink. It rises when edges are blended and cannot be traded against stroke weight the
 * way a gradient can, which makes it the honest tie-breaker between two pictures of the same
 * string.
 *
 * All three are relative, which is why they are only ever compared against another picture of
 * *the same string at the same size*.
 */
function edgeContrast(png, rect = null) {
  const picture = decodePng(png);
  const area = rect ?? { x: 0, y: 0, width: picture.width, height: picture.height };
  const right = Math.min(area.x + area.width, picture.width);
  const bottom = Math.min(area.y + area.height, picture.height);
  let across = 0;
  let acrossCount = 0;
  let down = 0;
  let downCount = 0;
  let midtone = 0;
  let pixels = 0;
  for (let y = area.y; y < bottom; y++) {
    for (let x = area.x; x < right; x++) {
      const here = picture.luminance(x, y);
      if (x > area.x) { across += Math.abs(here - picture.luminance(x - 1, y)); acrossCount++; }
      if (y > area.y) { down += Math.abs(here - picture.luminance(x, y - 1)); downCount++; }
      if (here > 60 && here < 200) midtone++;
      pixels++;
    }
  }
  return {
    across: acrossCount ? across / acrossCount : 0,
    down: downCount ? down / downCount : 0,
    midtone: pixels ? (100 * midtone) / pixels : 0,
    width: picture.width,
    height: picture.height,
  };
}

/** The three figures, in the order they are argued in. */
const figures = (measured) => `edges across ${measured.across.toFixed(2)}, `
  + `down ${measured.down.toFixed(2)}, ${measured.midtone.toFixed(2)}% of pixels neither `
  + 'paper nor ink';

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
      // How the compositor is told to resample this layer when the two disagree.
      imageRendering: getComputedStyle(canvas).imageRendering,
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
  const landed = await switchTo('Wide Display', WIDE);
  await shot('02-wide-landing');
  // Read after the landing, not at it: the shell takes a moment to open and the block it
  // gets arrives when it arrives. What the fit was handed is whatever had landed by then,
  // which is the race described at the top; what the *reader* looks at is this.
  probe = await waitFor(async () => {
    const seen = await evaluate(PROBE);
    return seen.mirror > 0 && seen.terminal > 0 ? seen : null;
  }, 'the mirror and the terminal block to be drawn', 40).catch(() => evaluate(PROBE));
  const wideScene = boundsOf(probe.boxes);
  check('the mirror is drawn on it', probe.mirror > 0, `${probe.mirror} mirror element(s)`);
  check('a terminal block is standing beside the documentation', probe.terminal === 1,
        `${probe.terminal} block(s)`);
  check('so the scene the reader is looking at is wider than the canvas',
        wideScene.w > probe.view.width,
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
  check('a fit of the whole scene would have gone below it',
        floorFor(landed.view, wideScene.w) < AUTHORED_ZOOM,
        `a whole-scene fit floors at ${floorFor(landed.view, wideScene.w).toFixed(3)}`);
  check('the first section is what the switch landed on',
        onScreen(landed, landed.sections['Project structure']),
        `${show(landed.view)}, scrollX ${landed.view.scrollX.toFixed(1)}`);
  check('and it is drawn at or above the zoom the board was written at',
        landed.view.zoom >= AUTHORED_ZOOM - 0.001, show(landed.view));
  check('so the 13px card body is painted at 13px or more',
        landed.body !== null && landed.body.fontSize * landed.view.zoom >= BODY_FONT_SIZE - 0.01,
        landed.body ? `${(landed.body.fontSize * landed.view.zoom).toFixed(1)}px` : 'no body text found');

  console.log('\n5. the picture has settled by the time the wheel has');
  // Zoomed out by hand, which is the gesture the report is about, and then left alone. Two
  // shots of the same card: at 450ms, past the 300ms `shouldCacheIgnoreZoom` timer, and again
  // three quarters of a second later. Clipped to the canvas so the header's sync status — a
  // clock, which changes on its own — is not what a difference would be measuring.
  for (let notch = 0; notch < 4; notch++) { await wheel(0, 120, 2); await sleep(120); }
  const settled = await evaluate(PROBE);
  const at = toPage(settled.view, CARD.x, CARD.y);
  const clip = { x: Math.round(at.x), y: Math.round(at.y), width: 300, height: 160, scale: 1 };
  check('the wheel zoomed the board out', settled.view.zoom < landed.view.zoom - 0.01,
        `${landed.view.zoom.toFixed(3)} -> ${settled.view.zoom.toFixed(3)}`);
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

  console.log('\n7. at a fractional devicePixelRatio the backing store is short — by under a pixel');
  // #267's case B, and the number that settles it against the issue's own hypothesis.
  //
  // `canvas.width` is an `unsigned long`, so `appState.width * devicePixelRatio` is truncated on
  // assignment; at dpr 1 and 2 over an integer CSS box that is exact and nothing is rescaled. At
  // 1.25 and 1.5 — Windows display scaling, or Chrome page zoom — the remainder has nowhere to
  // go and the compositor rescales the layer to cover it. The issue expected that to be the
  // amplifier: "dropping and duplicating pixel columns through every glyph".
  //
  // It cannot be, and the reason is arithmetic rather than measurement: what is discarded is the
  // *fractional part* of one product, so the shortfall is **bounded below one device pixel** on
  // each axis however large the canvas is. Measured here it is 0.75 of a pixel in 1013.75 and
  // 0.5 in 1216.5 — a rescale of about one part in 1,350 and one in 2,433. Section 8 photographs
  // what that does to a glyph, which is nothing anyone could report.
  //
  // Which makes `image-rendering: pixelated` on `.excalidraw canvas` the *right* rule and not
  // the amplifier either, and this is the case that says so. At a scale this close to 1 nearest
  // neighbour copies whole source rows, so every row on screen is a row the rasteriser drew;
  // bilinear blends *every* row with its neighbour at a near-constant phase. Overriding it to
  // `auto` was built and measured before this was written, and made the committed string
  // measurably softer — down 11% and 14% on the vertical edge figure, with half again as many
  // midtone pixels. The board is sharper for the upstream rule, so the check holds it there.
  for (const dpr of [1.25, 1.5]) {
    await send('Emulation.setDeviceMetricsOverride', {
      ...LAPTOP_VIEWPORT, deviceScaleFactor: dpr, mobile: false,
    });
    await sleep(400);
    await wheel(0, 1);            // one notch, to be sure something has repainted since
    await sleep(700);
    const canvases = await evaluate(CANVAS_PROBE);
    check(`the page is being drawn at devicePixelRatio ${dpr}`, canvases.dpr === dpr,
          `devicePixelRatio ${canvases.dpr}`);
    const stat = canvases.canvases.find((entry) => entry.which === 'static');
    check(`the static canvas exists at dpr ${dpr}`, Boolean(stat),
          JSON.stringify(canvases.canvases.map((entry) => entry.which)));
    if (!stat) continue;
    const wanted = { width: stat.css.width * canvases.dpr, height: stat.css.height * canvases.dpr };
    const short = { width: wanted.width - stat.store.width, height: wanted.height - stat.store.height };
    console.log(`        dpr ${dpr}: backing store ${stat.store.width}x${stat.store.height} for a `
                + `${stat.css.width}x${stat.css.height} CSS box — cssWidth x dpr is `
                + `${wanted.width}x${wanted.height}, short by `
                + `${short.width.toFixed(3)}x${short.height.toFixed(3)} device pixels, `
                + `resampled ${stat.imageRendering}`);
    // Exactly, the way the issue asked — and then bounded, which is the claim it supports.
    check(`the shortfall is a fraction of a device pixel, not a whole one (dpr ${dpr})`,
          short.width >= 0 && short.width < 1 && short.height >= 0 && short.height < 1,
          `short by ${short.width}x${short.height}`);
    check(`so the sub-pixel rescale copies rows rather than blending them (dpr ${dpr})`,
          stat.imageRendering === 'pixelated',
          `image-rendering: ${stat.imageRendering}`);
  }

  console.log('\n8. and the floor under all of it: the editor is DOM, the committed string is a bitmap');
  // #267's case A, measured rather than argued. Back to dpr 1 so that nothing case B is about is
  // in the picture: whatever this pair of numbers says, it says about the two rasterisers alone.
  await send('Emulation.setDeviceMetricsOverride', {
    ...LAPTOP_VIEWPORT, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(800);
  probe = await evaluate(PROBE);
  const string = probe.marks[`${LAPTOP}-sharpness`];
  check('the 16px Excalifont string is on the board', Boolean(string), JSON.stringify(probe.marks));
  if (string) {
    const corner = toPage(probe.view, string.x, string.y);
    const clip = {
      x: Math.round(corner.x) - 4, y: Math.round(corner.y) - 4,
      width: Math.round(string.w * probe.view.zoom) + 8,
      height: Math.round(string.h * probe.view.zoom) + 8,
      scale: 1,
    };
    check('the string is on screen to be photographed, at the zoom it was written at',
          clip.x >= 0 && clip.y >= 0
          && clip.x + clip.width <= probe.view.width + probe.view.offsetLeft
          && clip.y + clip.height <= probe.view.height + probe.view.offsetTop
          && Math.abs(probe.view.zoom - AUTHORED_ZOOM) < 0.001,
          `${JSON.stringify(clip)} at ${show(probe.view)}`);
    console.log(`        the string is at ${JSON.stringify(clip)} in page pixels, `
                + `${show(probe.view)}`);

    // Editing first, because committing is what the reader does last. A double click on the
    // element is the only door in: there is no imperative API for the text editor. It also
    // selects the whole string, and a selection is white-on-blue — a different amount of ink
    // from the state being compared against, which would be most of what a figure measured. End
    // collapses it to a caret, one column wide at the far edge of the clip.
    await doubleClick(clip.x + clip.width / 2, clip.y + clip.height / 2);
    await sleep(700);
    const editing = await evaluate(
      `Boolean(document.querySelector('textarea.excalidraw-wysiwyg'))`);
    check('a double click on it opens Excalidraw\'s DOM text editor', editing === true,
          'no textarea.excalidraw-wysiwyg in the document');
    await press('End');
    await sleep(300);
    const editorFigure = editing ? edgeContrast(await shot('08-editor-open', clip)) : null;

    // Escape commits it — and leaves it selected, whose outline is drawn inside this very clip
    // and would be measured as ink. Clearing that through `updateScene` rather than by clicking
    // empty canvas: three of the six places a click could land sit under Excalidraw's own
    // properties island, which is on screen precisely because something is selected. The
    // pointer moves away too, because a pointer resting on an element is a highlight of its own.
    await press('Escape');
    await sleep(300);
    await evaluate(`window.__sharpnessApi.updateScene({ appState: { selectedElementIds: {} } })`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: 40, y: probe.view.offsetTop + 40, button: 'none', buttons: 0,
    });
    await sleep(900);
    const after = await evaluate(`(() => {
      const api = window.__sharpnessApi;
      return {
        editing: Boolean(document.querySelector('textarea.excalidraw-wysiwyg')),
        selected: Object.keys(api.getAppState().selectedElementIds || {}).length,
      };
    })()`);
    check('Escape commits it back onto the canvas', after.editing === false,
          'the editor is still open');
    check('and leaves nothing selected over it to be photographed instead',
          after.selected === 0, `${after.selected} element(s) still selected`);
    const committedFigure = edgeContrast(await shot('08-committed', clip));

    console.log(`        ${SHARPNESS_FONT_SIZE}px Excalifont, zoom ${probe.view.zoom.toFixed(3)}, `
                + 'dpr 1 — the two rasterisers, same string, same pixels:');
    console.log(`          editor (DOM textarea):  ${editorFigure ? figures(editorFigure) : 'not measured'}`);
    console.log(`          committed (canvas):     ${figures(committedFigure)}`);
    console.log('        That gap is case A, the floor: Canvas2D text has no hinting and no '
                + 'subpixel antialiasing,');
    console.log('        and nothing in this repository lifts it while the board is a canvas.');
    check('both states were measured, so the floor is a number rather than a reading of a bundle',
          editorFigure !== null && editorFigure.across > 0 && committedFigure.across > 0,
          `editor ${JSON.stringify(editorFigure)}, committed ${JSON.stringify(committedFigure)}`);

    // And the same committed string once more with case B switched on: same board, same zoom,
    // same string, photographed at device resolution so that what the compositor did to the
    // layer is in the picture rather than averaged out of it. These are the figures that move
    // when the resampling changes, and they are what the `image-rendering` case in section 7 was
    // decided on.
    //
    // The whole frame, cropped here, rather than a `clip` with a `scale`: what a clip's
    // coordinates mean under an emulated device scale factor is exactly the thing in question,
    // and a mapping that is asserted — the frame comes back `viewportWidth x dpr` across — is
    // worth more here than one that is assumed.
    console.log('        and the same committed string once the sub-pixel rescale is on:');
    for (const dpr of [1.25, 1.5]) {
      await send('Emulation.setDeviceMetricsOverride', {
        ...LAPTOP_VIEWPORT, deviceScaleFactor: dpr, mobile: false,
      });
      await sleep(900);
      const frame = await shot(`08-committed-dpr-${dpr}`);
      const measured = edgeContrast(frame, {
        x: Math.round(clip.x * dpr), y: Math.round(clip.y * dpr),
        width: Math.round(clip.width * dpr), height: Math.round(clip.height * dpr),
      });
      check(`the dpr ${dpr} frame comes back at device resolution, so the crop is where the string is`,
            measured.width === Math.round(LAPTOP_VIEWPORT.width * dpr),
            `${measured.width}x${measured.height} for a ${LAPTOP_VIEWPORT.width} CSS px viewport at dpr ${dpr}`);
      console.log(`          dpr ${dpr}, at device resolution: ${figures(measured)}`);
    }
  }
  await send('Emulation.clearDeviceMetricsOverride');
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
