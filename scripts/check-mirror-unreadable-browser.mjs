#!/usr/bin/env node
/**
 * Checks, in a real browser, what a board shows when its project cannot be read.
 *
 * `check-mirror-unreadable.mjs` covers the strip's arithmetic. This covers what the
 * arithmetic is wired to, which is the half `CLAUDE.md` is explicit about: the defect #254
 * reports is not in any layout, it is one line in `refreshProjectBoard` that threw the
 * server's answer away —
 *
 *     if (!body?.success || !body.board) return
 *
 * — and a check that never lets a failing poll run has not asked the question. The server was
 * never the quiet part: `GET /api/project-board` answers 502 with `gh`'s own message in it.
 *
 * Three states, in the order a board actually meets them, driven by a stub `gh` that is
 * rewritten between them:
 *
 *   1. **cold, and `gh` fails** — nothing has ever been drawn, so nothing is what used to
 *      stay on the screen. A red strip now says so, and says `gh`'s own sentence.
 *   2. **`gh` recovers** — the real mirror replaces the strip in place, pinned by the same
 *      right edge, and the strip is gone rather than left behind under the columns.
 *   3. **warm, and `gh` fails again** — the mirror is left exactly as it is. A blip must not
 *      wipe a region somebody is reading, which is the half the old `return` had right and
 *      the reason this is a cold-only answer.
 *
 * It also asks the rule the whole mirror is built on, which the strip is no exception to: the
 * shapes are derived, so none of them reaches the server's store.
 *
 * A failing poll is not free to wait for — `gh.ts` gives every call three attempts with a
 * backoff — and the poll itself is twenty seconds, so this waits out real polls and takes
 * about a minute and a half. It counts the stub's own calls to know a poll has been and gone,
 * because "nothing changed" needs a positive sign that something ran.
 *
 * Self-contained: it writes the stub, starts its own canvas server against a throwaway
 * workspace, and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite
 * build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-mirror-unreadable-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

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

const layoutPath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(layoutPath)) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-layout.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const layout = await import(pathToFileURL(layoutPath).href);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project, and a `gh` that can be broken and mended ──────

const WS_ID = 'unreadable-check';
const workDir = mkdtempSync(join(tmpdir(), 'check-mirror-unreadable-'));
const projectDir = join(workDir, WS_ID);
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const modePath = join(workDir, 'mode');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

/** What #252 actually got, and the sentence the canvas threw away. */
const GH_MISSING = 'bash: line 1: C:\\Program Files\\GitHub CLI\\gh.exe: command not found';

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };

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

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 3, 'Being worked on', DOING),
      item('PVTI_b', 21, 'Waiting to be picked up', TODO),
    ] },
  } } },
}), 'utf8');
writeFileSync(logPath, '', 'utf8');
writeFileSync(modePath, 'fail', 'utf8');

/**
 * A `gh` that fails or answers depending on a file, and logs every call.
 *
 * Failing the way the real one did: the message on stderr and a non-zero exit, which is what
 * `gh.ts` turns into the error the route reports. It is not `gh` refusing a query — it is the
 * shell saying the executable is not there, which is the whole of #252.
 */
writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const mode = readFileSync(process.env.STUB_GH_MODE, 'utf8').trim();
if (mode === 'fail') {
  process.stderr.write(process.env.STUB_GH_MESSAGE + '\\n');
  process.exit(127);
}
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WS_ID, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Unreadable Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    // Off deliberately: a terminal block is a DOM overlay over this very region, and a
    // machine that exports the variable would have the check pressing on the card.
    EXCALIDRAW_TERMINAL: '',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    STUB_GH_MODE: modePath,
    STUB_GH_MESSAGE: GH_MISSING,
    STUB_GH_LOG: logPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

const api = async (path, options = {}) => {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${WS_ID}`, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const ghCalls = () => readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length;

/** Wait for the poll to have been round again, whatever it found. */
async function nextPoll(what) {
  const before = ghCalls();
  await waitFor(() => ghCalls() > before, `a poll to reach gh again (${what})`);
  // The answer still has to get back to the browser and be drawn.
  await sleep(2500);
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
        window.__unreadableCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__unreadableCheckApi;
  if (!api) return { error: 'no api handle' };
  const elements = api.getSceneElements();
  const text = (id) => {
    const label = elements.find((element) => element.containerId === id);
    return label ? label.text : '';
  };
  const labelOf = (id) => {
    const label = elements.find((element) => element.containerId === id);
    return label ? { x: label.x, y: label.y, w: label.width, h: label.height,
                     size: label.fontSize, family: label.fontFamily } : null;
  };
  const out = { strip: null, title: null, columns: [], cards: [], mirror: 0, authored: 0 };
  for (const element of elements) {
    const custom = element.customData || {};
    if (custom.kind === 'project-board') out.mirror++;
    else if (!element.containerId) out.authored++;
    if (custom.kind !== 'project-board') continue;
    const box = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height };
    if (custom.role === 'title' && custom.unreadable === true) out.strip = { ...box, text: text(element.id), label: labelOf(element.id), stroke: element.strokeColor, locked: element.locked };
    else if (custom.role === 'title') out.title = { ...box, text: text(element.id) };
    else if (custom.role === 'section') out.columns.push({ ...box, col: custom.sectionOptionId });
    else if (custom.role === 'card') out.cards.push({ ...box, itemId: custom.itemId });
  }
  out.columns.sort((a, b) => a.x - b.x);
  out.cards.sort((a, b) => a.x - b.x || a.y - b.y);
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  return out;
})()`;

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** Whether a box's middle is somewhere a reader can actually see it. */
const onScreen = (scene, box) => {
  const x = (box.x + box.w / 2 + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft;
  const y = (box.y + box.h / 2 + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop;
  return x > 0 && x < scene.view.width && y > 0 && y < scene.view.height;
};

/** Where the board's own content sits: one shape, well to the right of the region. */
const CONTENT = { x: 0, y: -150, width: 600, height: 400 };

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', ...CONTENT, backgroundColor: '#f8f9fa', text: 'the board itself' }),
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

  // ─── 1. cold, and gh fails ──────────────────────────────────

  console.log('1. a cold board whose read fails says so, and says why');

  await waitFor(async () => (await evaluate(PROBE)).strip, 'the strip a failed read draws');
  // The region sits well to the left of the board's own content, so the strip is drawn where
  // a reader would look for the mirror rather than where they happen to be looking. `Alt+B`
  // is the way back to it, and it is the way back to this too — a sign nothing reaches is
  // not much better than the silence it replaces.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  const cold = await evaluate(PROBE);
  await shot('01-cold-failure');

  check('a strip is drawn where the mirror would have been', Boolean(cold.strip));
  check('and Alt+B brings it into view, the way it reaches the region itself',
        cold.strip && onScreen(cold, cold.strip), JSON.stringify(cold.view));
  check('it carries gh\'s own sentence rather than "could not read"',
        String(cold.strip.text).replace(/\n/g, ' ').includes(GH_MISSING),
        JSON.stringify(cold.strip.text));
  check('it is red', cold.strip.stroke === '#e03131', String(cold.strip.stroke));
  check('it is locked, so it cannot be dragged out of the region', cold.strip.locked === true);
  check('and nothing else of a mirror is drawn — there is no board behind it',
        cold.columns.length === 0 && cold.cards.length === 0 && !cold.title,
        JSON.stringify({ columns: cold.columns.length, cards: cold.cards.length }));
  check('the board\'s own content is still on the canvas', cold.authored >= 1, String(cold.authored));

  check('its right edge is one gap left of the board\'s own left edge',
        Math.abs((cold.strip.x + cold.strip.w) - (CONTENT.x - layout.MIRROR_GAP)) < 1,
        JSON.stringify(cold.strip));
  check('the sentence is wrapped rather than left on one line to be clipped',
        String(cold.strip.text).split('\n').length >= 3,
        JSON.stringify(cold.strip.text));

  // A second failing poll, because the reader is looking at this for as long as it is wrong.
  // Nothing may move: the signature the mirror keeps is what makes an unchanged failure cost
  // no scene write at all, and a strip that flickered every twenty seconds would be its own
  // defect. The shot is taken here rather than on the first paint — a label measured before
  // the handwriting font has loaded is drawn narrow and settles afterwards, which is a
  // standing trap on this board and not what this is meant to be showing.
  await nextPoll('the same failure again');
  const again = await evaluate(PROBE);
  await shot('01b-cold-failure-settled');
  check('a second failing poll leaves the strip exactly where it was',
        JSON.stringify(again.strip) === JSON.stringify(cold.strip),
        JSON.stringify(again.strip));

  /**
   * The label, as the page settled it, against what the page says the same text measures.
   *
   * The one thing a scene reader cannot see is a clip: the element carries the whole sentence
   * whatever gets drawn, so `strip.text` is green on a strip whose ends are cut off. Excalidraw
   * draws bound text to the width the element carries, so the honest question is whether that
   * width is at least what the browser makes of the text with the fonts in — measured here, in
   * the page, because the estimate in `text-layout.ts` is the thing under suspicion.
   */
  const measured = await evaluate(`(() => {
    const api = window.__unreadableCheckApi;
    const label = api.getSceneElements().find((element) => element.containerId === ${JSON.stringify(cold.strip.id)});
    if (!label) return null;
    const canvas = document.createElement('canvas').getContext('2d');
    const family = getComputedStyle(document.body).getPropertyValue('--font-family-handdrawn')
      || 'Excalifont, Virgil, Segoe UI Emoji';
    canvas.font = label.fontSize + 'px ' + family;
    const widest = Math.max(...String(label.text).split('\\n').map((line) => canvas.measureText(line).width));
    return { width: label.width, widest, font: canvas.font, ready: document.fonts.status };
  })()`);
  check('the label is at least as wide as the browser makes of its own text',
        measured && measured.width + 0.5 >= measured.widest, JSON.stringify(measured));

  // ─── 2. it is derived, so the store never sees it ───────────

  console.log('\n2. the strip is derived, so it stays off the server and out of the export');

  // Give the autosync every chance to have sent the scene back.
  await sleep(2500);
  const { body: storedBody } = await api('/api/elements');
  const stored = storedBody.elements ?? [];
  check('no shape of the mirror\'s reached the store',
        stored.every((element) => (element.customData || {}).kind !== 'project-board'),
        JSON.stringify(stored.map((element) => (element.customData || {}).kind)));
  check('while the board\'s own shape did',
        stored.some((element) => !(element.customData || {}).kind && !element.containerId),
        String(stored.length));

  // ─── 3. gh recovers ────────────────────────────────────────

  console.log('\n3. when gh answers again the mirror replaces the strip in place');

  writeFileSync(modePath, 'ok', 'utf8');
  await nextPoll('gh mended');
  const warm = await waitFor(async () => {
    const scene = await evaluate(PROBE);
    return scene.columns.length >= 3 ? scene : null;
  }, 'the mirror to be drawn');
  await shot('02-recovered');

  check('the columns are drawn: the canvas\'s own and the two the project declares',
        warm.columns.length === 3, JSON.stringify(warm.columns.map((column) => column.col)));
  check('the cards are drawn', warm.cards.length === 2, String(warm.cards.length));
  check('the strip is gone rather than left behind under them', warm.strip === null,
        JSON.stringify(warm.strip));
  check('and the mirror kept the edge the strip was pinned by',
        warm.title && Math.abs((warm.title.x + warm.title.w) - (cold.strip.x + cold.strip.w)) < 1,
        JSON.stringify({ strip: cold.strip.x + cold.strip.w, title: warm.title && warm.title.x + warm.title.w }));

  // ─── 4. warm, and gh fails again ───────────────────────────

  console.log('\n4. a warm mirror is left exactly as it is when the next read fails');

  writeFileSync(modePath, 'fail', 'utf8');
  await nextPoll('gh broken again');
  await nextPoll('and once more, so it is not one unlucky poll');
  const after = await evaluate(PROBE);
  await shot('03-warm-failure');

  check('no strip appeared over the region somebody is reading', after.strip === null,
        JSON.stringify(after.strip));
  check('the columns are all still there',
        JSON.stringify(after.columns.map((column) => column.col))
        === JSON.stringify(warm.columns.map((column) => column.col)),
        JSON.stringify(after.columns.map((column) => column.col)));
  check('so are the cards, unmoved',
        JSON.stringify(after.cards) === JSON.stringify(warm.cards),
        JSON.stringify(after.cards));
  check('and the title still names the project rather than the failure',
        after.title && String(after.title.text).includes('mcp_excalidraw'),
        JSON.stringify(after.title && after.title.text));
} catch (error) {
  failures++;
  console.error(`  FAIL  the run itself — ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(500);
  if (failures === 0) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds files */ }
  } else {
    console.error(`\n        shots and logs left in ${workDir}`);
  }
}

console.log(
  failures === 0
    ? '\nAll good — a cold board says why its project could not be read, and a warm one is left alone.'
    : `\n${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
