#!/usr/bin/env node
/**
 * Checks the queue that starts the next Todo issue when a slot frees.
 *
 * The cap refuses rather than defers: the fourth click works and the fifth is told to come
 * back later, which is a person watching the board. The queue is the deferral — on, and the
 * server starts the oldest Todo issue every time a run settles — so what has to be true of
 * it is exactly what a person doing it by hand would get right and a loop would not:
 *
 *  - **Off is off.** A board that never turned it on must start nothing on its own, or the
 *    feature is an agent spawning against somebody's repository unasked.
 *  - **The cap is still the cap.** The queue goes through the same `POST /api/implement`
 *    and inherits the claim made before the first `await`, so a queue pass and a click
 *    arriving together cannot both pass. It reads a `409` as "not yet".
 *  - **Oldest first, from the whole column.** The mirror sorts cards and then truncates to
 *    `projectCardLimit`, so a queue reading what is *drawn* works from a truncated list.
 *    Section 6 makes that load-bearing: every card the limit draws is closed, so the only
 *    issue there is to start is one the drawn board does not contain.
 *  - **Nothing is started twice.** A card already running, already done, or closed is
 *    skipped rather than started again.
 *  - **Off mid-drain stops starting and stops nothing else.** Turning it off must not touch
 *    the runs already in flight.
 *
 * Self-contained, in the style of `check-implement-cap.mjs`: it writes a stub `gh` that
 * answers from a fixture per project number, a stub agent that parks until released, starts
 * its own canvas server on a pid-derived port and kills it. Nothing here talks to GitHub and
 * nothing runs a real coding agent. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-queue.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The project the stub serves ──────────────────────────────

const REPO = 'vitorengers/vibemaxxing';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

/** A day in July 2026, so "oldest" is a fact of the fixture rather than of the clock. */
const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

function item(id, { number, option, createdAt, state = 'OPEN' }) {
  return {
    id,
    fieldValueByName: { optionId: option.id, name: option.name },
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: issueUrl(number),
      createdAt,
      state,
      repository: { nameWithOwner: REPO },
    },
  };
}

const project = (number, nodes) => ({
  data: {
    owner: {
      projectV2: {
        id: `PVT_project${number}`,
        title: `project ${number}`,
        url: `https://github.com/users/someone/projects/${number}`,
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
        items: { pageInfo: { hasNextPage: false }, nodes },
      },
    },
  },
});

/**
 * The board the drain is read off.
 *
 * `#301` is closed and `#307` is the oldest open one — and is put through a run by hand
 * before the queue is ever turned on, so by the time it drains there is a `done` record
 * against it. Between them they are the two ways a card at the head of the column has to be
 * passed over. The rest are in the order the queue must take them: 302, 303, 304, 305, 306.
 *
 * `In Progress` and `Done` hold cards too, and their order is asserted rather than ignored:
 * Todo is drawn oldest-first because it is the queue, and every other column keeps the
 * newest-on-top the mirror has always had.
 */
const QUEUE_ITEMS = [
  item('PVTI_301', { number: 301, option: TODO, createdAt: day(1), state: 'CLOSED' }),
  item('PVTI_307', { number: 307, option: TODO, createdAt: day(2) }),
  item('PVTI_302', { number: 302, option: TODO, createdAt: day(3) }),
  item('PVTI_303', { number: 303, option: TODO, createdAt: day(4) }),
  item('PVTI_304', { number: 304, option: TODO, createdAt: day(5) }),
  item('PVTI_305', { number: 305, option: TODO, createdAt: day(6) }),
  item('PVTI_306', { number: 306, option: TODO, createdAt: day(7) }),
  item('PVTI_310', { number: 310, option: DOING, createdAt: day(8) }),
  item('PVTI_311', { number: 311, option: DOING, createdAt: day(9) }),
  item('PVTI_320', { number: 320, option: DONE, createdAt: day(10) }),
];

/** The order the queue has to take the board above in, oldest first. */
const DRAIN_ORDER = [302, 303, 304, 305, 306];

/**
 * A column deeper than the cap draws, whose every drawn card is closed.
 *
 * Fourteen Todo cards against a default `projectCardLimit` of 12, and the twelve the limit
 * draws are all closed. So the only issue in that column there is to start is one the drawn
 * board does not contain: a dispatcher reading the mirror finds nothing to do and the queue
 * silently never drains, which is the failure this fixture exists to catch.
 */
const DEEP_CLOSED = Array.from({ length: 12 }, (_, index) =>
  item(`PVTI_4${index}`, { number: 401 + index, option: TODO, createdAt: day(index + 1), state: 'CLOSED' }));
const DEEP_ITEMS = [
  ...DEEP_CLOSED,
  item('PVTI_413', { number: 413, option: TODO, createdAt: day(13) }),
  item('PVTI_414', { number: 414, option: TODO, createdAt: day(14) }),
];

/** What the default card limit leaves out of the drawn board — and what the queue must find. */
const HIDDEN = [413, 414];

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-queue-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

writeFileSync(join(workDir, 'project-5.json'), JSON.stringify(project(5, QUEUE_ITEMS)), 'utf8');
writeFileSync(join(workDir, 'project-6.json'), JSON.stringify(project(6, DEEP_ITEMS)), 'utf8');

/** A `gh` answering per project number, so two boards can differ without two servers. */
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);
if (args.includes('graphql')) {
  const number = (args.join(' ').match(/number=(\\d+)/) ?? [])[1] ?? '5';
  process.stdout.write(readFileSync(join(workDir, 'project-' + number + '.json'), 'utf8'));
} else {
  // Every other call is the move to In Progress, which this check does not assert.
  process.stdout.write('{}\\n');
}
`, 'utf8');

/**
 * Stands in for the implement agent: it records that it was started and then parks, so the
 * queue can be looked at while runs are genuinely in flight.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({ cwd: process.cwd() }), 'utf8');
  appendFileSync(join(workDir, 'started.log'), number + '\\n');

  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(join(workDir, 'started.log'), '', 'utf8');

/** Two boards, one per project, so "per workspace" is a claim this can actually test. */
const WORKSPACES = [
  { id: 'board-queue', project: 5 },
  { id: 'board-deep', project: 6 },
];

for (const workspace of WORKSPACES) {
  const dir = join(workDir, workspace.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: workspace.id,
    repo: REPO,
    githubProject: `https://github.com/users/someone/projects/${workspace.project}`,
  }), 'utf8');
  workspace.path = dir.replace(/\\/g, '/');
}

writeFileSync(registryPath, JSON.stringify({
  workspaces: WORKSPACES.map((workspace) => ({ id: workspace.id, path: workspace.path })),
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const CAP = 2;
/** Short enough that a case does not have to wait out a real interval to see a pass. */
const QUEUE_MS = 400;

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let child = null;
let serverOutput = '';

function startCanvas() {
  child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      EXCALIDRAW_IMPLEMENT_CONCURRENCY: String(CAP),
      EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
    },
  }).child;
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${serverOutput}`);
}

async function call(workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const started = (n) => existsSync(join(workDir, `run-${n}.json`));

const setQueue = (workspace, enabled) =>
  call(workspace, '/api/implement/queue', { method: 'POST', body: JSON.stringify({ enabled }) });
const readQueue = async (workspace) => (await call(workspace, '/api/implement')).body?.queue ?? null;

const startByUrl = (workspace, n) =>
  call(workspace, '/api/implement', { method: 'POST', body: JSON.stringify({ url: issueUrl(n) }) });

/** Every record the workspace holds, by issue number. */
async function records(workspace) {
  const listed = await call(workspace, '/api/implement');
  const runs = listed.body?.runs ?? [];
  return Object.fromEntries(runs.map((run) => [Number(/\/issues\/(\d+)/.exec(run.issueUrl)?.[1]), run.state]));
}

const numbersIn = (byNumber, state) =>
  Object.entries(byNumber).filter(([, value]) => value === state).map(([number]) => Number(number)).sort();

const running = async (workspace) => numbersIn(await records(workspace), 'running');

/** Wait until `predicate` holds of the running set, then hand back whatever it saw last. */
async function waitForRunning(workspace, predicate, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  let seen = [];
  while (Date.now() < deadline) {
    seen = await running(workspace);
    if (predicate(seen)) return seen;
    await sleep(150);
  }
  console.error(`  FAIL  timed out waiting for ${what} — saw [${seen.join(', ')}]`);
  failures++;
  return seen;
}

/** Wait for one run to settle, so a later assertion is not racing it. */
async function settle(workspace, n, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const state = (await records(workspace))[n];
    if (state && state !== 'running') return state;
    await sleep(150);
  }
  return 'running';
}

/** Long enough that a start which was going to happen has happened. */
const severalPasses = () => sleep(QUEUE_MS * 6);

const todoOf = (board) => (board?.sections ?? []).find((section) => section.name === TODO.name);
const numbersOf = (section) => (section?.cards ?? []).map((card) => card.number);

try {
  startCanvas();
  await waitForHealth();

  console.log('1. off by default, and off starts nothing');
  const initial = await readQueue('board-queue');
  check('the queue reports itself off after a restart', initial?.enabled === false,
        JSON.stringify(initial));
  check('and names the column it would drain', initial?.column === TODO.name, JSON.stringify(initial));
  await severalPasses();
  check('nothing was started while it was off', (await running('board-queue')).length === 0,
        JSON.stringify(await records('board-queue')));
  check('and no agent was spawned for any Todo issue',
        DRAIN_ORDER.every((n) => !started(n)), DRAIN_ORDER.filter(started).join(', '));

  console.log('\n2. the drawn Todo column reads oldest first, and no other column does');
  const drawn = (await call('board-queue', '/api/project-board')).body?.board;
  const todo = todoOf(drawn);
  check('Todo is drawn oldest first, which is the order the queue takes it in',
        JSON.stringify(numbersOf(todo)) === JSON.stringify([301, 307, 302, 303, 304, 305, 306]),
        JSON.stringify(numbersOf(todo)));
  const doing = (drawn?.sections ?? []).find((section) => section.name === DOING.name);
  check('while In Progress keeps the newest on top', JSON.stringify(numbersOf(doing)) === JSON.stringify([311, 310]),
        JSON.stringify(numbersOf(doing)));

  console.log('\n3. a run that already happened is not started again');
  // Put #307 — the oldest open card on the board — through a run by hand and let it finish,
  // so the drain that follows has a `done` record at the head of the column to pass over.
  const byHand = await startByUrl('board-queue', 307);
  check('the manual start is accepted', byHand.status === 202, `got ${byHand.status}`);
  release(307);
  check('and it settles as done', (await settle('board-queue', 307)) === 'done',
        JSON.stringify(await records('board-queue')));

  console.log('\n4. on, it fills the free slots with the oldest issues and stops at the cap');
  const on = await setQueue('board-queue', true);
  check('the toggle answers with the state it wrote', on.status === 200 && on.body?.queue?.enabled === true,
        `${on.status} ${JSON.stringify(on.body)}`);
  check('and a read agrees', (await readQueue('board-queue'))?.enabled === true,
        JSON.stringify(await readQueue('board-queue')));

  const filled = await waitForRunning('board-queue', (seen) => seen.length >= CAP, `${CAP} runs in flight`);
  check(`exactly ${CAP} runs in flight, which is the cap`, filled.length === CAP, JSON.stringify(filled));
  check('and they are the two oldest startable issues, in that order',
        JSON.stringify(filled) === JSON.stringify([302, 303]), JSON.stringify(filled));
  check('the closed card was passed over', !started(301), 'a closed issue offers no run to start');
  check('and so was the one that already has a run', await settle('board-queue', 307) === 'done'
        && (await records('board-queue'))[307] === 'done', JSON.stringify(await records('board-queue')));

  await severalPasses();
  const stillCapped = await running('board-queue');
  check('and it does not exceed the cap however long it is left',
        stillCapped.length === CAP && JSON.stringify(stillCapped) === JSON.stringify([302, 303]),
        JSON.stringify(stillCapped));

  console.log('\n5. a slot freeing starts exactly one more, the oldest one left');
  release(302);
  check('the run that was released settles', (await settle('board-queue', 302)) === 'done');
  const refilled = await waitForRunning('board-queue', (seen) => seen.includes(304), 'the next issue to start');
  check('the next oldest started', refilled.includes(304), JSON.stringify(refilled));
  check('exactly one more, not the whole column', refilled.length === CAP, JSON.stringify(refilled));
  check('and nothing newer jumped the queue', !started(305) && !started(306),
        `305: ${started(305)}, 306: ${started(306)}`);

  console.log('\n6. the column is read past the card limit, not off the drawn board');
  const deepBoard = (await call('board-deep', '/api/project-board')).body?.board;
  const deepTodo = todoOf(deepBoard);
  check('the drawn board really does leave cards out', deepTodo?.hidden === 2,
        `hidden=${deepTodo?.hidden}, drawn=${(deepTodo?.cards ?? []).length}`);
  check('and the only startable issues there are among the ones it left out',
        HIDDEN.every((n) => !numbersOf(deepTodo).includes(n)), JSON.stringify(numbersOf(deepTodo)));
  await setQueue('board-deep', true);
  const deepRunning = await waitForRunning('board-deep', (seen) => seen.length > 0,
                                           'the queue to reach past the card limit');
  check('the queue started one of them all the same', deepRunning.includes(HIDDEN[0]),
        JSON.stringify(deepRunning));
  check('the older of the two first', deepRunning[0] === HIDDEN[0], JSON.stringify(deepRunning));
  check('and the other board is unaffected by that one being on',
        (await readQueue('board-queue'))?.enabled === true
        && (await running('board-queue')).every((n) => n < 400), JSON.stringify(await running('board-queue')));
  await setQueue('board-deep', false);

  console.log('\n7. off mid-drain stops the starting and leaves the running alone');
  const off = await setQueue('board-queue', false);
  check('the toggle answers off', off.status === 200 && off.body?.queue?.enabled === false,
        JSON.stringify(off.body));
  const beforeRelease = await running('board-queue');
  release(303);
  check('the released run settles', (await settle('board-queue', 303)) === 'done');
  await severalPasses();
  const afterOff = await running('board-queue');
  check('no fifth issue was started', !started(305) && !started(306),
        `305: ${started(305)}, 306: ${started(306)}`);
  check('and the run that was still going is untouched',
        afterOff.includes(304) && beforeRelease.includes(304), JSON.stringify(afterOff));

  console.log('\n8. the queue and a click racing cannot beat the cap');
  // One slot free, two claimants: the queue's next pass and a request for an issue further
  // down the column. Whichever wins, the other has to read its 409 as "not yet".
  const [manual] = await Promise.all([startByUrl('board-queue', 306), setQueue('board-queue', true)]);
  check('the click is answered either way', [202, 409].includes(manual.status),
        `${manual.status} ${JSON.stringify(manual.body)}`);
  await severalPasses();
  const raced = await running('board-queue');
  check('the cap held', raced.length <= CAP, JSON.stringify(raced));
  check('and the run already in flight was not disturbed', raced.includes(304), JSON.stringify(raced));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (let number = 300; number <= 320; number++) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  for (const number of HIDDEN) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  await sleep(600);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
