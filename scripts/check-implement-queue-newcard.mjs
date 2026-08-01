#!/usr/bin/env node
/**
 * Checks the one queue path nothing covered: a card that arrives *after* the switch went on.
 *
 * `check-implement-queue.mjs` writes its fixture once and the `gh` stub re-reads that same
 * file on every call, so the project it drains never changes underneath a queue that is
 * already running. Every case there is about the initial drain, a slot freeing, the card
 * limit, off mid-drain and a race — and the observation behind #263 is about none of them.
 * It is about the column gaining a card while the queue is on, which is precisely what the
 * timer exists for and what nothing asserted.
 *
 * So the fixture here is rewritten mid-run, and what has to be true of the queue is:
 *
 *  - **A card that arrives with a slot free starts by itself**, within an interval or two,
 *    with nobody clicking anything. That is the timer path, and it is the whole observation.
 *  - **A card that arrives with the cap full waits, and the board can say so.** A queue that
 *    is on and cannot start anything must not look like a queue that is on and idle: the
 *    last pass names its reason through `GET /api/implement`, and for a full cap it names
 *    the runs holding the slots.
 *  - **A slot freeing then starts it**, which is the settle path for a card the queue had
 *    never seen when it was switched on.
 *  - **A pass that never returns cannot wedge the workspace.** `dispatchQueue` guards itself
 *    against overlapping passes; a pass that hangs inside that guard used to hold it for as
 *    long as the hang lasted, and the queue was dead for the whole of it with the toggle
 *    still drawn on. A `gh` that never answers is the reachable version of that hang.
 *
 * Self-contained, in the style of `check-implement-queue.mjs`: a stub `gh` answering from a
 * fixture per project number — one of which can be told to hang forever — a stub agent that
 * parks until released, its own canvas server on a pid-derived port, and no GitHub and no
 * coding agent anywhere. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-queue-newcard.mjs
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

// ─── The projects the stub serves ─────────────────────────────

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

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-queue-newcard-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** Rewrite what the stub answers for one project. This is the whole point of the check. */
const setProject = (number, nodes) =>
  writeFileSync(join(workDir, `project-${number}.json`), JSON.stringify(project(number, nodes)), 'utf8');

/**
 * Project 5 — the timer path. Nothing startable at switch-on, so a run that appears later
 * can only have come from a pass that re-read the board.
 */
setProject(5, [
  item('PVTI_500', { number: 500, option: TODO, createdAt: day(1), state: 'CLOSED' }),
  item('PVTI_520', { number: 520, option: DONE, createdAt: day(2) }),
]);

/** Project 6 — the cap. Two startable cards for a cap of two, and a third arrives later. */
const CAP_ITEMS = [
  item('PVTI_601', { number: 601, option: TODO, createdAt: day(1) }),
  item('PVTI_602', { number: 602, option: TODO, createdAt: day(2) }),
];
setProject(6, CAP_ITEMS);

/** Project 7 — the hang. One card, which must still start once `gh` answers again. */
setProject(7, [item('PVTI_701', { number: 701, option: TODO, createdAt: day(1) })]);

/**
 * A `gh` answering per project number, and hanging forever when told to.
 *
 * The hang is decided **once, at startup**, and never rechecked: a stub that noticed the
 * flag going away would answer the very call that was meant to be stuck, and the check would
 * pass against a server that had simply waited it out. What has to be true is that the queue
 * recovers while that first call is still hanging.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);
if (args.includes('graphql')) {
  const number = (args.join(' ').match(/number=(\\d+)/) ?? [])[1] ?? '5';
  if (existsSync(join(workDir, 'hang-' + number))) {
    // Never answers, never exits. Killed by the caller's own timeout, which is the point.
    setInterval(() => {}, 1000000);
  } else {
    process.stdout.write(readFileSync(join(workDir, 'project-' + number + '.json'), 'utf8'));
  }
} else {
  // Every other call is the move to In Progress, which this check does not assert.
  process.stdout.write('{}\\n');
}
`, 'utf8');

/** Records that it was started and then parks, so runs can be genuinely in flight. */
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

/** One board per project, so each case has a queue of its own to switch on. */
const WORKSPACES = [
  { id: 'board-new', project: 5 },
  { id: 'board-cap', project: 6 },
  { id: 'board-hang', project: 7 },
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

/**
 * Watch the queue until a pass reports it started something, and hand that pass back.
 *
 * `lastPass` is one slot, overwritten by every pass — so `started` is a state the queue is in
 * for one interval and then leaves, because the pass after it finds the column empty and says
 * `nothing-startable` truthfully. Reading it once, straight after the *record* says the run is
 * in flight, races that: the slot is claimed before the first `await` in `beginImplement` and
 * the pass only reports in its `finally`, so the record leads the report by however long the
 * guards between them take. Anything that lengthens those guards — #355 added a `gh` probe to
 * them — turns the race into a reliable failure under load.
 *
 * So the pass is *observed* rather than sampled: every reading is kept, and the first one that
 * says `started` is the answer however soon it is replaced.
 */
async function waitForStarted(workspace, ms = 8_000) {
  const deadline = Date.now() + ms;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await readQueue(workspace);
    if (seen?.lastPass?.reason === 'started' && seen?.lastPass?.started >= 1) return seen;
    await sleep(50);
  }
  return seen;
}

/** Wait until the last pass reports one of these reasons, so an assertion is not racing it. */
async function waitForReason(workspace, reasons, ms = 6_000) {
  const deadline = Date.now() + ms;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await readQueue(workspace);
    if (reasons.includes(seen?.lastPass?.reason)) return seen;
    await sleep(150);
  }
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
const severalPasses = () => sleep(QUEUE_MS * 8);

try {
  startCanvas();
  await waitForHealth();

  console.log('1. a card that arrives after the switch, with a slot free, starts by itself');
  const on = await setQueue('board-new', true);
  check('the toggle answers on', on.status === 200 && on.body?.queue?.enabled === true,
        `${on.status} ${JSON.stringify(on.body)}`);
  await severalPasses();
  check('and with nothing startable in the column it starts nothing',
        (await running('board-new')).length === 0, JSON.stringify(await records('board-new')));

  const idle = await readQueue('board-new');
  check('a pass over an empty column says so rather than going quiet',
        idle?.lastPass?.reason === 'nothing-startable', JSON.stringify(idle));
  check('and an idle queue is not reported as stalled', idle?.stalled === false, JSON.stringify(idle));

  // The card GitHub gains while the queue is already on. Nothing is clicked after this line.
  setProject(5, [
    item('PVTI_500', { number: 500, option: TODO, createdAt: day(1), state: 'CLOSED' }),
    item('PVTI_501', { number: 501, option: TODO, createdAt: day(3) }),
    item('PVTI_520', { number: 520, option: DONE, createdAt: day(2) }),
  ]);

  const arrived = await waitForRunning('board-new', (seen) => seen.includes(501),
                                       'the card that arrived after switch-on to start', 12_000);
  check('the new Todo card started with nobody clicking anything', arrived.includes(501),
        JSON.stringify(arrived));
  const drained = await waitForStarted('board-new');
  check('and the pass that started it says it started something',
        drained?.lastPass?.reason === 'started' && drained?.lastPass?.started >= 1,
        JSON.stringify(drained));

  console.log('\n2. a card that arrives with the cap full waits, and the board can say why');
  await setQueue('board-cap', true);
  const capped = await waitForRunning('board-cap', (seen) => seen.length >= CAP,
                                      `${CAP} runs in flight`);
  check(`the cap filled with the two oldest`, JSON.stringify(capped) === JSON.stringify([601, 602]),
        JSON.stringify(capped));

  setProject(6, [...CAP_ITEMS, item('PVTI_603', { number: 603, option: TODO, createdAt: day(3) })]);
  await severalPasses();
  check('the card that arrived while the cap was full was not started', !started(603),
        'a full cap has to defer, not exceed itself');

  const stalled = await waitForReason('board-cap', ['cap-full']);
  check('a queue that can start nothing reports itself stalled', stalled?.stalled === true,
        JSON.stringify(stalled));
  check('and names the reason', stalled?.lastPass?.reason === 'cap-full', JSON.stringify(stalled));
  check('and says which runs are holding the slots',
        typeof stalled?.lastPass?.detail === 'string'
        && stalled.lastPass.detail.includes(issueUrl(601))
        && stalled.lastPass.detail.includes(issueUrl(602)),
        JSON.stringify(stalled?.lastPass?.detail));

  console.log('\n3. and the slot freeing starts it, though the queue never saw it at switch-on');
  release(601);
  check('the released run settles', (await settle('board-cap', 601)) === 'done');
  const refilled = await waitForRunning('board-cap', (seen) => seen.includes(603),
                                        'the card added after switch-on to take the free slot');
  check('the card added after switch-on took the freed slot', refilled.includes(603),
        JSON.stringify(refilled));

  console.log('\n4. a queue switched off is not a queue that is stalled');
  const off = await setQueue('board-cap', false);
  check('the toggle answers off', off.status === 200 && off.body?.queue?.enabled === false,
        JSON.stringify(off.body));
  const afterOff = await readQueue('board-cap');
  check('and it carries no stall from when it was on',
        afterOff?.stalled === false && afterOff?.lastPass === null, JSON.stringify(afterOff));

  console.log('\n5. a pass that never returns does not leave the workspace undrainable');
  writeFileSync(join(workDir, 'hang-7'), '', 'utf8');
  await setQueue('board-hang', true);
  // Long enough that the pass is inside its `gh` call and holding the guard.
  await sleep(800);
  check('nothing started while the read was stuck', !started(701), 'the pass never got a board');
  rmSync(join(workDir, 'hang-7'), { force: true });

  // The stuck `gh` is still stuck — it never rechecks the flag — so the only way out is for
  // the guard to stop believing in a pass that is not coming back.
  const recovered = await waitForRunning('board-hang', (seen) => seen.includes(701),
                                         'the queue to drain past a pass that never returned',
                                         15_000);
  check('the queue drained once a later pass could read the board', recovered.includes(701),
        JSON.stringify(recovered));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  rmSync(join(workDir, 'hang-7'), { force: true });
  for (const number of [500, 501, 601, 602, 603, 701]) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  await sleep(600);
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
