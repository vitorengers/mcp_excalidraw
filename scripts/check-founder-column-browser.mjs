#!/usr/bin/env node
/**
 * Checks in a real browser that the founder column is drawn, and that a card dropped out of
 * it goes back without a word being sent to GitHub.
 *
 * `check-founder-column-canvas.mjs` covers the arithmetic. This covers what that arithmetic is
 * wired to, which is the half `AGENTS.md` is explicit about — through the whole pipeline a
 * founder card actually travels: a record on disk, the project-board answer, the frontend, the
 * scene, and a pointer dragged across it.
 *
 * Four things only a browser settles:
 *
 *   - a record written before the server started is drawn as a card, in a column of its own,
 *     on a board whose project declares no such column;
 *   - the card can be **selected**, which is a claim about `locked` and nothing else: a
 *     locked shape is not selectable, and the panel that will answer these (#548) needs one
 *     that is;
 *   - dragging it into another column snaps it back and sends **no**
 *     `POST /api/project-board/move`. There is no project item to address a move to, and the
 *     absence of `customData.itemId` is what makes `settleMirrorDrag` take that branch;
 *   - and the strip says how many are waiting.
 *
 * **The control is the third case's other half.** A check that only asserts that no request
 * was sent passes just as well on a harness that cannot see a request at all, so the same
 * drag is performed on a real GitHub card in the same scene, and that one has to send one.
 *
 * The records are seeded by writing `founder-store.ts`'s own file into a board state
 * directory of this check's own, which is exactly how a blocker noticed by a previous process
 * reaches this one (#537). Nothing here writes to the operator's boards.
 *
 * **Run against the code before the change it fails on the first thing it looks for**: the
 * mirror comes up with no founder column at all, so there is no card to select and nowhere to
 * drop from. The later sections are bounded rather than left to a wait that throws, so the
 * output names every case rather than stopping at the first.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh`, starts its own canvas server against a
 * throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-founder-column-browser.mjs [--chrome <path>] [--shots <dir>]
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

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome({ what: 'the browser check was not run.' });

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
/** A case that could not even be attempted. Named rather than skipped, so red says what. */
const missed = (name, detail) => check(name, false, detail);

// ─── A project, and two blockers noticed before this process started ──

const workDir = mkdtempSync(join(tmpdir(), 'check-founder-column-'));
const projectDir = join(workDir, 'founder-column-check');
const stateDir = join(workDir, 'board-state');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const directory of [projectDir, stateDir, profileDir, shotDir]) {
  mkdirSync(directory, { recursive: true });
}

const WORKSPACE = 'founder-column-check';
const FOUNDER_COLUMN = 'Founder Actions';

const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };

const PROJECT_URL = 'https://github.com/users/someone/projects/5';
const issueUrl = (number) => `https://github.com/vitorengers/vibemaxxing/issues/${number}`;

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
    repository: { nameWithOwner: 'vitorengers/vibemaxxing' },
  },
});

// Deliberately no column called `Founder Actions` on the project: the whole point is a column
// the canvas owns, on a board that declares nothing for it.
writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: PROJECT_URL,
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', 118, 'An issue that is really on GitHub', TODO, '2026-07-22T10:00:00Z'),
      item('PVTI_b', 99, 'Something else entirely', DOING, '2026-07-19T10:00:00Z'),
    ] },
  } } },
}), 'utf8');

// `project item-edit` answers as a success, so a move that *is* attempted goes all the way
// through rather than failing for a reason this check would then have to tell apart.
writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Founder Column Check',
  repo: 'vitorengers/vibemaxxing',
  githubProject: PROJECT_URL,
}), 'utf8');

/**
 * The blockers, in `founder-store.ts`'s own file and its own directory.
 *
 * Written before the server starts, which is the case the store exists for: the credit is
 * still missing after a restart and nothing on disk anywhere else says a person was asked. A
 * third record is `resolved`, so this also asserts that a column of open work is what is
 * drawn rather than everything ever recorded.
 */
const WAITING = [
  { key: `${WORKSPACE}:gh-login`, title: 'Sign the GitHub CLI in to your account' },
  { key: `${WORKSPACE}:gh-billing`, title: 'GitHub is refusing work until billing is settled' },
];
const record = (key, kind, title, state) => ({
  key,
  kind,
  workspaceId: WORKSPACE,
  fields: {
    title,
    what: 'Something on this machine is in the way, and the board cannot get past it.',
    why: 'No machine here can do this one, so the board is waiting on you.',
    steps: ['Open a terminal.', 'Do the thing this card asks for.'],
    confirm: 'The board stops asking.',
  },
  evidence: {},
  state,
  createdAt: '2026-08-01T09:00:00Z',
  lastSeenAt: '2026-08-03T09:00:00Z',
  chat: [],
});
writeFileSync(join(stateDir, `${WORKSPACE}.founder-actions.json`), JSON.stringify({
  type: 'founder-actions',
  version: 1,
  workspaceId: WORKSPACE,
  savedAt: '2026-08-03T09:00:00Z',
  actions: [
    record(WAITING[0].key, 'gh-login', WAITING[0].title, 'open'),
    record(WAITING[1].key, 'gh-billing', WAITING[1].title, 'open'),
    record(`${WORKSPACE}:gh-scope`, 'gh-scope', 'This one was already dealt with', 'resolved'),
  ],
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_BOARD_STATE: stateDir,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
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
  await sleep(700);
}

/**
 * Drag from one point to another, in steps.
 *
 * In steps because Excalidraw decides a drag has begun from the pointer moving while a button
 * is down; one jump from the press to the release is a click that happens to land elsewhere.
 */
async function drag(from, to, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
  await sleep(80);
  await send('Input.dispatchMouseEvent',
             { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(120);
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(40);
  }
  await sleep(150);
  await send('Input.dispatchMouseEvent',
             { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(1600);
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
        window.__founderApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Every request the page makes to the move route, recorded as it is made.
 *
 * Installed over `window.fetch` rather than read out of the server's log, because what is
 * being asserted is that the *canvas* did not ask — a server that answered 400 would look the
 * same from the outside as one that was never asked.
 */
const WATCH_MOVES = `(() => {
  if (window.__moves) return true;
  window.__moves = [];
  const original = window.fetch;
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (url.includes('/api/project-board/move')) {
      window.__moves.push({ url, body: (init && init.body) || null });
    }
    return original.apply(this, arguments);
  };
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__founderApi;
  if (!api) return { error: 'no api handle' };
  const out = { cards: [], headers: [], title: null, adds: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind !== 'project-board') continue;
    if (custom.role === 'card') {
      out.cards.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                       col: custom.sectionOptionId, itemId: custom.itemId ?? null,
                       founderKey: custom.founderKey ?? null,
                       locked: element.locked === true, draggable: custom.draggable ?? null });
    }
    if (custom.role === 'section') {
      const label = api.getSceneElements().find((other) => other.containerId === element.id);
      out.headers.push({ col: custom.sectionOptionId, x: element.x, w: element.width,
                         text: (label && label.text) || '' });
    }
    if (custom.role === 'add') out.adds.push({ col: custom.sectionOptionId });
    if (custom.role === 'title') {
      const label = api.getSceneElements().find((other) => other.containerId === element.id);
      out.title = { text: (label && label.text) || '', w: element.width };
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

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const cardOf = (scene, id) => scene.cards.find((card) => card.id === id) ?? null;
const headerOf = (scene, col) => scene.headers.find((header) => header.col === col) ?? null;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // The founder column has to be on the answer the mirror is drawn from, and this says so
  // before a pixel is involved — so a red browser section can be told from a red server one.
  console.log('1. the project-board answer carries what is waiting');
  const answer = await (await fetch(`${BASE}/api/project-board?workspace=${WORKSPACE}`)).json();
  check('the board itself was read', answer?.success === true && Boolean(answer.board),
        JSON.stringify(answer?.error ?? answer).slice(0, 200));
  check('and the founder column rides along with it',
        answer?.founder?.columnName === FOUNDER_COLUMN && Array.isArray(answer?.founder?.cards),
        JSON.stringify(answer?.founder));
  check('carrying the two that are open and not the one that was settled',
        (answer?.founder?.cards ?? []).map((card) => card.key).join(',')
          === WAITING.map((entry) => entry.key).join(','),
        JSON.stringify((answer?.founder?.cards ?? []).map((card) => card.key)));

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => ((await evaluate(PROBE)).cards ?? []).length >= 2, 'the mirror to render');
  await evaluate(WATCH_MOVES);

  // Alt+B fits the region. Taken after the mirror has rendered, because a fit taken before it
  // is a fit around whatever was there instead — and the founder column is the rightmost thing
  // on the mirror, so a stale fit is exactly what would put it off screen.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1800);
  let scene = await evaluate(PROBE);
  await shot('01-mirror');

  console.log('\n2. the column is drawn, on a project that declares no such column');
  const founderCards = scene.cards.filter((card) => typeof card.founderKey === 'string');
  check('both blockers are drawn as cards', founderCards.length === WAITING.length,
        `${founderCards.length} founder card(s) of ${scene.cards.length} card(s)`);
  check('under a column the project never declared',
        founderCards.every((card) => card.col === 'canvas:founder'),
        founderCards.map((card) => String(card.col)).join(', '));
  check('with a header that counts them',
        headerOf(scene, 'canvas:founder')?.text.replace(/\s*\n\s*/g, ' ')
          === `${FOUNDER_COLUMN} (${WAITING.length})`,
        JSON.stringify(headerOf(scene, 'canvas:founder')?.text));
  check('and the strip says how many are waiting',
        (scene.title?.text ?? '').includes(`${WAITING.length} founder actions waiting`),
        JSON.stringify(scene.title?.text));
  check('the + is still on the notes column alone',
        scene.adds.length === 1 && scene.adds[0]?.col === 'canvas:notes',
        JSON.stringify(scene.adds));
  check('and the columns read from GitHub are still there beside it',
        Boolean(headerOf(scene, TODO.id)) && Boolean(headerOf(scene, DOING.id)),
        scene.headers.map((header) => header.col).join(', '));

  const subject = founderCards[0] ?? null;
  const target = headerOf(scene, TODO.id);

  console.log('\n3. the card can be selected, which is a claim about locked');
  if (!subject) {
    missed('there is a founder card to select', 'no founder column was drawn');
    missed('it is not locked', 'no founder column was drawn');
    missed('and a click on it selects it', 'no founder column was drawn');
  } else {
    check('it is not locked', subject.locked === false, JSON.stringify(subject));
    // Near the top edge rather than the middle: the middle is where the card's label is, and
    // a click there lands on the label instead of the box.
    const at = toViewport(scene, subject.x + subject.w / 2, subject.y + 10);
    await click(at.x, at.y);
    await shot('02-founder-card-selected');
    scene = await evaluate(PROBE);
    check('and a click on it selects it', scene.selected.includes(subject.id),
          JSON.stringify(scene.selected));
  }

  console.log('\n4. dragging it into another column puts it back, and sends nothing');
  if (!subject || !target) {
    missed('the founder card was dragged into another column', 'no founder column to drag from');
    missed('it snapped back to the column it came from', 'no founder column to drag from');
    missed('and no move was sent', 'no founder column to drag from');
  } else {
    const before = cardOf(scene, subject.id) ?? subject;
    const from = toViewport(scene, before.x + before.w / 2, before.y + 10);
    const to = toViewport(scene, target.x + target.w / 2, before.y + 200);
    check('both ends of the drag are on the screen',
          from.x > 0 && from.y > 0 && from.x < scene.view.width && from.y < scene.view.height
          && to.x > 0 && to.y > 0 && to.x < scene.view.width && to.y < scene.view.height,
          `${JSON.stringify(from)} → ${JSON.stringify(to)} in ${scene.view.width}x${scene.view.height}`);
    await drag(from, to);
    await shot('03-after-founder-drag');
    scene = await evaluate(PROBE);
    const after = cardOf(scene, subject.id);
    check('the card is still on the canvas after the drag', Boolean(after),
          scene.cards.map((card) => card.id).join(', '));
    check('it snapped back to the column it came from',
          Math.abs((after?.x ?? -1) - before.x) < 1 && after?.col === 'canvas:founder',
          `${before.x} → ${after?.x} (${after?.col})`);
    const moves = await evaluate('window.__moves || []');
    check('and no move was sent to the project', Array.isArray(moves) && moves.length === 0,
          JSON.stringify(moves));
    check('nothing on the card claims a move failed either — there was no move to fail',
          !(scene.title?.text ?? '').includes('!'), JSON.stringify(scene.title?.text));
  }

  console.log('\n5. the control: the same drag on a real card does send one');
  // Without this, "no request was sent" would pass on a harness that cannot see a request, or
  // on a drag that never happened at all.
  const real = scene.cards.find((card) => typeof card.itemId === 'string' && card.col === TODO.id);
  const doing = headerOf(scene, DOING.id);
  if (!real || !doing) {
    missed('a card read from GitHub was dragged into the next column',
           `real=${JSON.stringify(real)} doing=${JSON.stringify(doing)}`);
    missed('and that one did send a move', 'the control drag could not be performed');
  } else {
    const from = toViewport(scene, real.x + real.w / 2, real.y + 10);
    const to = toViewport(scene, doing.x + doing.w / 2, real.y + 160);
    await drag(from, to);
    await shot('04-after-real-drag');
    const moves = await evaluate('window.__moves || []');
    check('and that one did send a move', Array.isArray(moves) && moves.length === 1,
          JSON.stringify(moves));
    check('naming the item id the founder card does not have',
          String(moves?.[0]?.body ?? '').includes(real.itemId),
          String(moves?.[0]?.body));
  }
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
