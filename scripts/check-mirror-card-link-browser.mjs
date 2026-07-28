#!/usr/bin/env node
/**
 * Checks in a real browser that selecting a mirror card covers nothing.
 *
 * `check-mirror-card-link.mjs` covers the layout's output; this covers what that output is
 * wired to, which is the half `CLAUDE.md` is explicit about. The popup is Excalidraw's own
 * and is drawn only when a *linked* element is selected, so a layout that stopped emitting
 * `element.link` still has to be shown not to produce one — through the whole pipeline the
 * card actually travels: server, socket, frontend, scene.
 *
 * Three things only a browser settles:
 *
 *   - selecting a card in a column renders no `.excalidraw-hyperlinkContainer`, so the card
 *     stacked above it stays uncovered — the defect in #130, where the popup sits above the
 *     selected card's own box and lands on its neighbour;
 *   - the card as the browser holds it carries no `link` at all, which is what the badge in
 *     its corner is drawn from as well;
 *   - and the URL is still offered, once, by the issue panel, as a real anchor.
 *
 * The title strip is selected last, as the control: its link is deliberately kept, so the
 * popup must appear for it. A check that only ever asserts an absence passes just as well
 * on a board that never selected anything.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas server
 * against a throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-mirror-card-link-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
  console.log('SKIPPED — no Chrome or Edge found, so the browser check was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  process.exit(0);
}

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

// ─── A project with a column deep enough to cover ─────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-card-link-'));
const projectDir = join(workDir, 'card-link-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };

const PROJECT_URL = 'https://github.com/users/vitorengers/projects/5';
const issueUrl = (number) => `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`;

const item = (id, number, title, option, createdAt) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: issueUrl(number),
    createdAt,
    state: 'OPEN',
    repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
  },
});

// Three cards in one column, newest on top, so the one selected in the middle has a card
// above it for the popup to land on — the arrangement the screenshot on #130 shows.
writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: PROJECT_URL,
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 118, 'The card above, whose text must stay readable', TODO, '2026-07-22T10:00:00Z'),
      item('PVTI_b', 115, 'The card that gets selected', TODO, '2026-07-21T10:00:00Z'),
      item('PVTI_c', 112, 'The card below', TODO, '2026-07-20T10:00:00Z'),
      item('PVTI_d', 99, 'Something else entirely', DOING, '2026-07-19T10:00:00Z'),
    ] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'card-link-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Card Link Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: PROJECT_URL,
}), 'utf8');

const PORT = 35700 + (process.pid % 250);
const CDP_PORT = PORT + 260;
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(900);
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
        window.__cardLinkApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__cardLinkApi;
  if (!api) return { error: 'no api handle' };
  const out = { cards: [], title: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                       col: custom.sectionOptionId, itemId: custom.itemId,
                       link: element.link ?? null, issueUrl: custom.issueUrl ?? null });
    }
    if (custom.kind === 'project-board' && custom.role === 'title') {
      out.title = { x: element.x, y: element.y, w: element.width, h: element.height,
                    link: element.link ?? null };
    }
  }
  out.cards.sort((a, b) => a.y - b.y);
  const state = api.getAppState();
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
               width: state.width, height: state.height };
  return out;
})()`;

/** What the popup looks like from the DOM, and where it sits if it is there. */
const POPUP = `(() => {
  const node = document.querySelector('.excalidraw-hyperlinkContainer');
  if (!node) return null;
  const box = node.getBoundingClientRect();
  return { href: node.querySelector('a')?.href ?? null,
           x: box.x, y: box.y, width: box.width, height: box.height };
})()`;

const PANEL = `(() => {
  const panel = document.querySelector('.element-docs');
  if (!panel) return null;
  const anchor = panel.querySelector('.element-docs__issue-link');
  return { title: panel.querySelector('.element-docs__title')?.textContent ?? '',
           href: anchor?.getAttribute('href') ?? null,
           text: panel.textContent ?? '' };
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

/** Do two viewport boxes overlap? The whole of the defect, stated as geometry. */
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width
  && a.y < b.y + b.height && b.y < a.y + a.height;

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
  await waitFor(async () => ((await evaluate(PROBE)).cards ?? []).length >= 4, 'the mirror to render');

  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1500);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  console.log('1. the card the browser holds carries its URL once, in customData');
  const todoCards = scene.cards.filter((card) => card.col === TODO.id);
  check('the Todo column holds its three cards', todoCards.length === 3, `got ${todoCards.length}`);
  check('no card in the scene carries element.link',
        scene.cards.every((card) => !card.link),
        scene.cards.filter((card) => card.link).map((card) => `${card.itemId} -> ${card.link}`).join(', '));
  check('every card still carries customData.issueUrl',
        scene.cards.every((card) => typeof card.issueUrl === 'string' && card.issueUrl.length > 0),
        scene.cards.map((card) => String(card.issueUrl)).join(', '));

  // ─── Selecting the middle card ──────────────────────────────

  console.log('\n2. selecting a card in a column covers nothing above it');
  const middle = todoCards[1];
  const above = todoCards[0];
  check('there is a card above the one to be selected', Boolean(middle && above));

  // Near the top edge rather than the middle: the middle is where the card's label is, and
  // a click there lands on the label instead of the box — a defect this repository has
  // already paid for once.
  const point = toViewport(scene, middle.x + middle.w / 2, middle.y + 10);
  await click(point.x, point.y);
  await shot('02-card-selected');

  scene = await evaluate(PROBE);
  check('the card really is selected — an absence proves nothing if nothing was selected',
        scene.selected.includes(middle.id), JSON.stringify(scene.selected));

  const popup = await evaluate(POPUP);
  check('no hyperlink popup is rendered', popup === null, JSON.stringify(popup));
  if (popup) {
    const aboveBox = toViewport(scene, above.x, above.y);
    const coveredBox = { x: aboveBox.x, y: aboveBox.y,
                         width: above.w * scene.view.zoom, height: above.h * scene.view.zoom };
    check('and the card above is not covered by it', !overlaps(popup, coveredBox),
          `${JSON.stringify(popup)} over ${JSON.stringify(coveredBox)}`);
  } else {
    check('and the card above is therefore uncovered — there is nothing to cover it with', true);
  }

  // ─── The panel is still where the URL lives ─────────────────

  console.log('\n3. the same selection still opens the issue panel with a working link');
  const panel = await waitFor(async () => {
    const now = await evaluate(PANEL);
    return now && now.href ? now : null;
  }, 'the issue panel to show the issue link', 80);
  check('the panel offers the issue URL as a real anchor',
        panel.href === issueUrl(115), String(panel.href));
  check('and it is the issue the selected card names',
        /#?115/.test(panel.title) || panel.text.includes('115'), panel.title);

  // ─── The control: an ordinary shape that does carry a link ──

  console.log('\n4. an ordinary linked shape still gets its popup');
  // Two things at once. It is the control — a check that only ever asserts an absence
  // passes just as well on a harness that cannot see a popup in the first place — and it
  // is the boundary #130 drew: `link` stays a working property of anything a reader or an
  // MCP client draws. Only the mirror's generated cards gave it up.
  const drawn = await (await fetch(`${BASE}/api/elements?workspace=card-link-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 320, height: 160,
      backgroundColor: '#fff3bf', link: PROJECT_URL,
    }),
  })).json();
  const drawnId = drawn?.element?.id ?? drawn?.id;
  const authored = await waitFor(async () => {
    const found = await evaluate(`(() => {
      const element = (window.__cardLinkApi?.getSceneElements() ?? [])
        .find((candidate) => candidate.id === ${JSON.stringify(drawnId)});
      if (!element) return null;
      const state = window.__cardLinkApi.getAppState();
      return { x: element.x, y: element.y, w: element.width, h: element.height,
               link: element.link ?? null,
               view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
                       offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
                       width: state.width, height: state.height } };
    })()`);
    return found;
  }, 'the drawn shape to reach the canvas');
  check('the shape kept the link it was drawn with', authored.link === PROJECT_URL, String(authored.link));

  await evaluate(`(() => { window.__cardLinkApi.scrollToContent(
    window.__cardLinkApi.getSceneElements().filter((element) => element.id === ${JSON.stringify(drawnId)}),
    { fitToViewport: true, viewportZoomFactor: 0.5 }); return true; })()`);
  await sleep(800);
  const placed = await evaluate(`(() => {
    const element = window.__cardLinkApi.getSceneElements()
      .find((candidate) => candidate.id === ${JSON.stringify(drawnId)});
    const state = window.__cardLinkApi.getAppState();
    return { x: (element.x + state.scrollX) * state.zoom.value + state.offsetLeft,
             y: (element.y + 10 + state.scrollY) * state.zoom.value + state.offsetTop,
             w: element.width * state.zoom.value };
  })()`);
  await click(placed.x + placed.w / 2, placed.y);
  await shot('03-authored-shape-selected');
  const authoredPopup = await waitFor(() => evaluate(POPUP), 'the drawn shape\'s hyperlink popup', 24);
  check('selecting it does render one, so the absence above is the change and not the harness',
        Boolean(authoredPopup) && authoredPopup.href === PROJECT_URL, JSON.stringify(authoredPopup));

  console.log('\n5. the title strip kept its link — the board\'s only route to the project');
  check('the strip in the scene still carries element.link',
        scene.title?.link === PROJECT_URL, String(scene.title?.link));
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
