#!/usr/bin/env node
/**
 * Checks, in a real browser, that the board says what a stalled queue is doing — and that a
 * card which arrives after the switch really does start on screen.
 *
 * `check-implement-queue-newcard.mjs` covers the server: a Todo card that appears while the
 * queue is on starts by itself, a full cap defers it, and `GET /api/implement` names the
 * reason. All of that compiles either way, and this project has paid three times for
 * believing a UI change because it type-checked. So the questions here are the ones only a
 * browser settles:
 *
 *  - **a card that arrives after switch-on starts, and the mirror draws it running**, with
 *    nobody clicking anything between the toggle and the run;
 *  - **a queue that is on and idle looks different from a queue that is on and stuck.** That
 *    is #263's third complaint, and it is the one the toggle could not answer: on was on,
 *    whether the passes were starting runs or hitting a wall every thirty seconds;
 *  - **the reason is there to be asked for and is not pushed at anybody.** A full cap is a
 *    queue at capacity: the outline breaks, `GET /api/implement` names the runs holding the
 *    slots, and nothing is put over the canvas (#483).
 *    `check-implement-queue-cap-quiet-browser.mjs` is where that is driven through a whole
 *    rotation, and where the stalls that *are* worth a box still get exactly one.
 *
 * The fixture is rewritten mid-run, which is the whole point: the project gains a Todo card
 * while the page is open and the queue is already draining. Cap two, so the sequence is
 * on → one run → idle-but-on → a card arrives → two runs → cap full → stalled → released →
 * draining again, and every one of those is a different thing for the toggle to draw.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: a stub `gh`, a stub agent that parks until released, its own
 * canvas server against a throwaway workspace, and both killed at the end. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-implement-queue-newcard-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project to mirror, and to change underneath the page ───

const workDir = mkdtempSync(join(tmpdir(), 'check-queue-newcard-'));
const projectDir = join(workDir, 'queue-newcard');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const agentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const REPO = 'vitorengers/vibemaxxing';
const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, createdAt, option, state = 'OPEN') => ({
  id,
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    createdAt,
    state,
    repository: { nameWithOwner: REPO },
  },
});

/** Rewrite what `gh` answers. The stub re-reads the file per call, so this lands at once. */
const setFixture = (nodes) => writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes },
  } } },
}), 'utf8');

/** The board as it stands when the toggle is pressed: one closed card and one open one. */
const AT_SWITCH_ON = [
  item('PVTI_a', 41, '2026-07-01T10:00:00Z', TODO, 'CLOSED'),
  item('PVTI_b', 42, '2026-07-02T10:00:00Z', TODO),
  item('PVTI_e', 45, '2026-07-09T10:00:00Z', DONE),
];
/** The card GitHub gains afterwards, which nothing on this page has ever seen. */
const ARRIVES_LATER = item('PVTI_c', 43, '2026-07-03T10:00:00Z', TODO);

setFixture(AT_SWITCH_ON);

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

/** An agent that parks until this check releases it, so a slot frees when the check says. */
writeFileSync(agentPath, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('done\\nhttps://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'queue-newcard', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Queue New Card',
  repo: REPO,
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short, so "within one interval" is a thing this check can wait out. */
const QUEUE_MS = 1500;

let serverLog = '';
const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
  EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentPath.replace(/\\/g, '/')}" -p`,
  // Two, so the board passes through every state the toggle has to draw: one run with a slot
  // still free (on and idle), then two (on and stuck), then one again (draining).
  EXCALIDRAW_IMPLEMENT_CONCURRENCY: '2',
  EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
  STUB_GH_FIXTURE: fixturePath,
};
// A terminal block's xterm panel is a DOM overlay over the mirror, and clicks aimed at the
// toggle land on it instead. This board needs no terminal, and gets none: nothing this
// machine exports reaches the child.

const server = startCanvas({
  env: serverEnv,
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(150);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The imperative API, through the container's React fibre. See check-board-drafts-browser. */
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
        window.__boardCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Watch the toast, which is a sibling of the canvas and lives for ten seconds.
 *
 * Recorded as it appears rather than looked for afterwards: the poll that raises it runs
 * every twenty seconds and the toast is gone long before the next one, so a check that only
 * looked at the end would be asserting on whether it happened to be looking.
 */
const WATCH_TOASTS = `(() => {
  window.__toasts = [];
  window.setInterval(() => {
    const node = document.querySelector('.Toast__message');
    const text = node && node.textContent ? node.textContent.trim() : '';
    if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
  }, 100);
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { queue: null, cards: [], headers: [], toasts: window.__toasts || [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind !== 'project-board') continue;
    if (custom.role === 'card') {
      out.cards.push({ url: custom.issueUrl || null, col: custom.sectionOptionId,
                       run: custom.implementState || null,
                       strokeStyle: element.strokeStyle, strokeWidth: element.strokeWidth });
    }
    if (custom.role === 'section') {
      out.headers.push({ col: custom.sectionOptionId, x: element.x, y: element.y,
                         w: element.width, h: element.height });
    }
    if (custom.role === 'queue') {
      out.queue = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                    col: custom.sectionOptionId, on: custom.queueEnabled === true,
                    stalled: custom.queueStalled === true, fill: element.backgroundColor,
                    stroke: element.strokeColor, strokeWidth: element.strokeWidth,
                    strokeStyle: element.strokeStyle };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const implementState = async () =>
  (await (await fetch(`${BASE}/api/implement?workspace=queue-newcard`)).json());
const serverQueue = async () => (await implementState()).queue ?? null;
const serverRuns = async () => (await implementState()).runs ?? [];
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;
const stateOf = async (number) =>
  (await serverRuns()).find((run) => run.issueUrl === issueUrl(number))?.state ?? null;
const release = (number) => writeFileSync(join(workDir, `release-${number}`), '', 'utf8');
const cardFor = (scene, number) => (scene.cards ?? []).find((card) => card.url === issueUrl(number));

/** The toggle as the board currently draws it, once the page has caught up with a change. */
const drawnQueue = (predicate, what, tries = 200) => waitFor(async () => {
  const now = await evaluate(PROBE);
  return now.queue && predicate(now.queue) ? now : null;
}, what, tries);

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
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await evaluate(WATCH_TOASTS);
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 3, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.queue ? now : null;
  }, 'the queue toggle to be drawn');
  await shot('01-off');

  console.log('1. off, and drawn as a queue nobody has switched on');
  check('the toggle is off', scene.queue.on === false, JSON.stringify(scene.queue));
  check('and not drawn as stalled, because there is nothing to stall',
        scene.queue.stalled === false && scene.queue.strokeStyle === 'solid',
        JSON.stringify(scene.queue));
  const offLook = { ...scene.queue };

  console.log('\n2. switched on from the board, it drains what is already there');
  const spot = toViewport(scene, scene.queue.x + scene.queue.w / 2, scene.queue.y + scene.queue.h / 2);
  await click(spot.x, spot.y);
  await sleep(900);
  check('the server agrees it is on', (await serverQueue())?.enabled === true,
        JSON.stringify(await serverQueue()));
  await waitFor(async () => (await stateOf(42)) === 'running', 'the open Todo card to start');
  check('the open card started', (await stateOf(42)) === 'running', JSON.stringify(await serverRuns()));
  check('and the closed one above it was passed over', (await stateOf(41)) === null,
        JSON.stringify(await serverRuns()));

  const idle = await waitFor(async () => {
    const queue = await serverQueue();
    return queue?.lastPass?.reason === 'nothing-startable' ? queue : null;
  }, 'a pass with nothing left to start');
  check('with a slot still free, the queue reports itself on and idle',
        idle.stalled === false && idle.lastPass.reason === 'nothing-startable',
        JSON.stringify(idle));
  const onIdle = await drawnQueue((queue) => queue.on === true, 'the toggle to be drawn on');
  await shot('02-on-idle');
  check('and the board draws it on, with an unbroken outline',
        onIdle.queue.on === true && onIdle.queue.stalled === false
        && onIdle.queue.strokeStyle === 'solid', JSON.stringify(onIdle.queue));
  check('which is a different shape from off, in fill and in weight',
        onIdle.queue.fill !== offLook.fill && onIdle.queue.strokeWidth !== offLook.strokeWidth,
        `${JSON.stringify(offLook)} → ${JSON.stringify(onIdle.queue)}`);
  const onLook = { ...onIdle.queue };

  console.log('\n3. a card that arrives after switch-on starts, with nobody clicking anything');
  setFixture([...AT_SWITCH_ON, ARRIVES_LATER]);
  const arrived = await waitFor(async () => (await stateOf(43)) === 'running' ? true : null,
                                'the card that arrived after switch-on to start');
  check('the new Todo card started by itself', arrived === true, JSON.stringify(await serverRuns()));
  const drawing = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return cardFor(now, 43)?.run === 'running' ? now : null;
  }, 'the mirror to draw the new card as running', 240);
  await shot('03-new-card-running');
  check('and the mirror draws its card with the outline a run in flight has',
        cardFor(drawing, 43)?.strokeStyle === 'dashed' && cardFor(drawing, 43)?.strokeWidth === 2,
        JSON.stringify(cardFor(drawing, 43)));

  console.log('\n4. the cap fills, and the board stops looking like a queue that is merely idle');
  const stalled = await waitFor(async () => {
    const queue = await serverQueue();
    return queue?.stalled === true ? queue : null;
  }, 'the queue to report itself stalled');
  check('the server names the reason', stalled.lastPass?.reason === 'cap-full',
        JSON.stringify(stalled.lastPass));
  check('and says which runs are holding the slots',
        String(stalled.lastPass?.detail ?? '').includes(issueUrl(42))
        && String(stalled.lastPass?.detail ?? '').includes(issueUrl(43)),
        JSON.stringify(stalled.lastPass?.detail));

  const stuck = await drawnQueue((queue) => queue.stalled === true,
                                 'the toggle to be drawn as stalled');
  await shot('04-stalled');
  check('the toggle is drawn stalled — still on, with its outline broken',
        stuck.queue.on === true && stuck.queue.strokeStyle === 'dashed',
        JSON.stringify(stuck.queue));
  check('which is what tells it apart from the on-and-idle it was a moment ago',
        stuck.queue.strokeStyle !== onLook.strokeStyle,
        `${onLook.strokeStyle} → ${stuck.queue.strokeStyle}`);
  check('and it is the same button, not a second shape', stuck.queue.id === onLook.id,
        `${onLook.id} vs ${stuck.queue.id}`);

  console.log('\n5. the reason reaches the reader without a box over what they are reading');
  // A full cap is a queue at capacity and not a queue that is stuck, so it is drawn and
  // answered and never announced (#483). The rotation that used to raise one of these per
  // completed run is driven by check-implement-queue-cap-quiet-browser.mjs, which also holds
  // the other half of the rule: a stall that is a stall still speaks, once.
  await sleep(Math.max(2 * QUEUE_MS, 3000));
  const said = await evaluate('window.__toasts || []');
  check('the board did not interrupt the reader about a cap its own runs are holding',
        said.filter((text) => text.includes('starting nothing')).length === 0,
        JSON.stringify(said));
  const capped = await serverQueue();
  check('and the sentence is still there to be asked for, naming who holds the slots',
        String(capped?.lastPass?.detail ?? '').includes(issueUrl(42))
        && String(capped?.lastPass?.detail ?? '').includes(issueUrl(43)),
        JSON.stringify(capped?.lastPass));

  console.log('\n6. a slot freeing puts the toggle back to a queue that is simply on');
  release(42);
  await waitFor(async () => (await stateOf(42)) === 'done', 'the released run to finish');
  const recovered = await waitFor(async () => {
    const queue = await serverQueue();
    return queue?.stalled === false ? queue : null;
  }, 'the queue to stop reporting itself stalled');
  check('the server stops calling it stalled', recovered.stalled === false,
        JSON.stringify(recovered));
  const solid = await drawnQueue((queue) => queue.stalled === false && queue.on === true,
                                 'the toggle to be drawn on and unbroken again');
  await shot('05-draining-again');
  check('and the board draws it on with a whole outline again',
        solid.queue.strokeStyle === 'solid' && solid.queue.on === true,
        JSON.stringify(solid.queue));
  check('with the run that was left alone still in flight', (await stateOf(43)) === 'running',
        JSON.stringify(await serverRuns()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const number of [41, 42, 43, 45]) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
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
