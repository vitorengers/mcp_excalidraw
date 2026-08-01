#!/usr/bin/env node
/**
 * Checks, in a real browser, that a full cap says nothing on the canvas — and that a genuine
 * stall still does, once.
 *
 * A cap held by live runs is a queue at capacity, not a queue that is stuck: nothing is wrong,
 * nothing is for the reader to do, and it clears itself the moment a run ends. The board used
 * to toast `The implementation queue is on and starting nothing. All 4 slot(s) are taken…`
 * over the mirror every time that happened, which on a saturated board is roughly one box per
 * completed run (#483). The taxonomy already draws this line twice — `nothing-startable` and
 * `blocked` are quiet for the same reason — and `cap-full` now joins them.
 *
 * There are two ways the old announcement repeated, and each is a section here:
 *
 *  - **a pass in between re-arms it.** `announceQueueStall` forgets what it said whenever the
 *    queue is not stalled, so cap-full → a slot frees → cap-full is a fresh interruption;
 *  - **the dedupe key is the whole sentence, and the sentence names the holders.** Rotate one
 *    run out and another in and the string differs, so it is a new stall to the browser even
 *    with no non-stalled pass the reader ever saw.
 *
 * `check-implement-queue-newcard-browser.mjs` waits two polls while the cap stays full and
 * unchanged, which is neither of those.
 *
 * **The reader's polls are driven rather than waited for.** The mirror re-reads every twenty
 * seconds and only while its tab is on screen, so this check shadows `document.visibilityState`
 * with a flag of its own: hidden, the timer ticks and fetches nothing, and a `visibilitychange`
 * dispatched with the flag flipped back runs exactly one poll through the same
 * `refreshProjectBoard` a reader returning to the tab does. That is what makes "and then it
 * said nothing for two more polls" a fact rather than a wait, and what makes the second section
 * above testable at all: the holders can be swapped between two reads with certainty that no
 * third read slipped in.
 *
 * Self-contained: a stub `gh` reading a fixture this check rewrites, a stub agent that parks
 * until released, its own canvas server against a throwaway workspace, and both killed at the
 * end. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the
 * built frontend.
 *
 * Usage: node scripts/check-implement-queue-cap-quiet-browser.mjs [--shots <dir>]
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

const workDir = mkdtempSync(join(tmpdir(), 'check-queue-cap-quiet-'));
const projectDir = join(workDir, 'queue-cap-quiet');
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
/** The same column under a name the workspace is not configured for, which is `no-column`. */
const RENAMED = { id: 'f75ad846', name: 'Backlog' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, createdAt, option) => ({
  id,
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    createdAt,
    state: 'OPEN',
    repository: { nameWithOwner: REPO },
  },
});

/** Rewrite what `gh` answers. The stub re-reads the file per call, so this lands at once. */
const setFixture = (todo, numbers) => writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [todo, DOING, DONE] },
    items: {
      pageInfo: { hasNextPage: false },
      nodes: numbers.map((number, index) =>
        item(`PVTI_${number}`, number, `2026-07-0${index + 1}T10:00:00Z`, todo)),
    },
  } } },
}), 'utf8');

/** Two open cards and a cap of two, so the first pass fills the cap and the next one hits it. */
setFixture(TODO, [42, 43]);

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
  workspaces: [{ id: 'queue-cap-quiet', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Queue Cap Quiet',
  repo: REPO,
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Short, so a rotation this check asks for is over in seconds rather than in half a minute. */
const QUEUE_MS = 1000;

let serverLog = '';
const server = startCanvas({
  env: {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentPath.replace(/\\/g, '/')}" -p`,
    // Two, because a full cap is the subject and two parked stubs are the cheapest full cap.
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '2',
    EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
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
 * Recorded as it appears rather than looked for afterwards: this check asserts that a box was
 * *not* raised, and a box raised and gone between two looks is exactly the failure it exists
 * to catch.
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

/**
 * Take the mirror's poll off its timer and put it on this check's hand.
 *
 * The page polls only while its tab is on screen, so a shadowed `visibilityState` of `hidden`
 * leaves the timer running and every tick a no-op. `window.__poll()` flips the flag, dispatches
 * the event the page already listens for, and flips it back — one read through
 * `refreshProjectBoard`, which is the function the timer calls and the one that announces.
 * `__implementReads` counts the reads that got as far as `GET /api/implement`, so waiting for
 * one is waiting for the poll rather than for a guessed number of milliseconds.
 */
const DRIVE_POLLS = `(() => {
  window.__visibility = 'hidden';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => window.__visibility,
  });
  window.__implementReads = 0;
  const real = window.fetch;
  window.fetch = function (...args) {
    const url = String(args[0] && args[0].url ? args[0].url : args[0]);
    const answer = real.apply(this, args);
    if (url.includes('/api/implement?')) answer.then(() => { window.__implementReads++; }, () => {});
    return answer;
  };
  window.__poll = () => {
    window.__visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.__visibility = 'hidden';
  };
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { cards: [], toasts: window.__toasts || [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'project-board' && custom.role === 'card') {
      out.cards.push({ url: custom.issueUrl || null, run: custom.implementState || null });
    }
  }
  return out;
})()`;

const implementState = async () =>
  (await (await fetch(`${BASE}/api/implement?workspace=queue-cap-quiet`)).json());
const serverQueue = async () => (await implementState()).queue ?? null;
const serverRuns = async () => (await implementState()).runs ?? [];
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;
const stateOf = async (number) =>
  (await serverRuns()).find((run) => run.issueUrl === issueUrl(number))?.state ?? null;
const release = (number) => writeFileSync(join(workDir, `release-${number}`), '', 'utf8');

const reads = () => evaluate('window.__implementReads || 0');
const toasts = () => evaluate('window.__toasts || []');
const spoken = async () =>
  (await toasts()).filter((text) => text.includes('starting nothing'));

/** One read of the board by the page, and the announcement it does or does not make. */
async function poll() {
  const before = await reads();
  await evaluate('window.__poll(), true');
  await waitFor(async () => (await reads()) > before, 'the page to read the run records');
  // The announcement is two awaits past the response this counted, and the toast is polled
  // into `__toasts` every 100ms after that.
  await sleep(600);
}

/** The last pass the server recorded, once it says what this check is waiting for. */
const passWhere = (predicate, what) => waitFor(async () => {
  const queue = await serverQueue();
  return queue?.lastPass && predicate(queue.lastPass) ? queue : null;
}, what);

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
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 2, 'the mirror to render');
  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(800);
  // Only now: the load above wants the ordinary poll, and everything below wants this one.
  await evaluate(DRIVE_POLLS);

  console.log('1. the cap fills, and the board does not interrupt anybody about it');
  const on = await (await fetch(`${BASE}/api/implement/queue?workspace=queue-cap-quiet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  })).json();
  check('the queue is on', on?.queue?.enabled === true, JSON.stringify(on));
  await waitFor(async () => (await stateOf(42)) === 'running' && (await stateOf(43)) === 'running',
                'both Todo cards to start');
  const capped = await passWhere((pass) => pass.reason === 'cap-full', 'the cap to fill');
  check('the server still names the cap and who is holding it',
        capped.lastPass.reason === 'cap-full'
        && String(capped.lastPass.detail).includes(issueUrl(42))
        && String(capped.lastPass.detail).includes(issueUrl(43)),
        JSON.stringify(capped.lastPass));
  await poll();
  await shot('01-cap-full');
  check('and the board said nothing about a queue starting nothing',
        (await spoken()).length === 0, JSON.stringify(await toasts()));
  const firstSentence = String(capped.lastPass.detail);

  console.log('\n2. a slot frees, a pass is not a stall, and the cap fills again');
  release(42);
  await waitFor(async () => (await stateOf(42)) === 'done', 'the released run to finish');
  const drained = await passWhere((pass) => pass.stalled === false,
                                  'a pass that is not a stall');
  check('the pass in between is not a stall, which is what re-armed the announcement',
        drained.stalled === false, JSON.stringify(drained.lastPass));
  // The reader sees it, which is what clears the memory of whatever was last announced. This
  // is the whole of path 1: it is why a saturated board got one box per completed run.
  await poll();
  const afterDrain = (await spoken()).length;

  setFixture(TODO, [42, 43, 44]);
  await waitFor(async () => (await stateOf(44)) === 'running', 'the freed slot to be refilled');
  const refilled = await passWhere((pass) => pass.reason === 'cap-full', 'the cap to fill again');
  await poll();
  await shot('02-cap-full-again');
  check('the cap is full again', refilled.lastPass.reason === 'cap-full',
        JSON.stringify(refilled.lastPass));
  check('and the cap filling a second time raises nothing either',
        (await spoken()).length === afterDrain, JSON.stringify(await toasts()));

  console.log('\n3. the holders change with no pass the reader ever saw in between');
  const secondSentence = String(refilled.lastPass.detail);
  const afterRefill = (await spoken()).length;
  const before = await reads();
  release(43);
  await waitFor(async () => (await stateOf(43)) === 'done', 'the second run to finish');
  setFixture(TODO, [42, 43, 44, 45]);
  await waitFor(async () => (await stateOf(45)) === 'running', 'the third card to start');
  const rotated = await passWhere(
    (pass) => pass.reason === 'cap-full' && String(pass.detail).includes(issueUrl(45)),
    'the cap to fill with a different pair'
  );
  check('no read of the run records happened while the holders were swapping',
        (await reads()) === before, `${before} → ${await reads()}`);
  const thirdSentence = String(rotated.lastPass.detail);
  check('so the reader goes from one full cap straight to another, worded differently',
        thirdSentence !== secondSentence && secondSentence !== firstSentence,
        `${firstSentence}\n→ ${secondSentence}\n→ ${thirdSentence}`);
  await poll();
  await shot('03-cap-full-rotated');
  check('and a sentence it has never seen is still not worth a box',
        (await spoken()).length === afterRefill, JSON.stringify(await toasts()));

  console.log('\n4. a genuine stall still speaks, and speaks once');
  // A slot has to free first: the cap is looked at before the board is read, so a full cap is
  // the only thing a pass can report however broken the project underneath it is.
  setFixture(RENAMED, [42, 43, 44, 45]);
  release(44);
  await waitFor(async () => (await stateOf(44)) === 'done', 'a slot to free for the pass to get past');
  const stalled = await passWhere((pass) => pass.reason === 'no-column',
                                  'the column the queue drains to be renamed away');
  check('the server reports a stall that is not the cap', stalled.stalled === true
        && stalled.lastPass.reason === 'no-column', JSON.stringify(stalled.lastPass));
  const quiet = (await spoken()).length;
  await poll();
  await shot('04-no-column');
  const said = await spoken();
  check('the board says the queue is on and starting nothing', said.length === quiet + 1,
        JSON.stringify(await toasts()));
  check('and names the column it cannot find',
        said.at(-1)?.includes('"Todo"') === true, JSON.stringify(said.at(-1)));
  await poll();
  await poll();
  check('and it says it once rather than at every pass',
        (await spoken()).length === quiet + 1, JSON.stringify(await toasts()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const number of [42, 43, 44, 45]) {
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
