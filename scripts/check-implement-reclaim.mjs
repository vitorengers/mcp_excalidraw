#!/usr/bin/env node
/**
 * Checks that a `running` record has a way to stop being one.
 *
 * A run whose bookkeeping never closed held its slot forever. Observed on 2026-07-30: a run
 * started at 18:01:26 was still `running` at 22:50, more than four hours later, while its work
 * had landed — the pull request merged, the issue closed. Nothing was lost except the *record*,
 * and the record is what the cap counts: when the queue was switched on with four slots, three
 * runs started and the board could say only `cap-full`.
 *
 * The wedge is reproduced here rather than simulated, because its shape decides whether it is
 * detectable at all. `runAgent` resolves on the child's **close**, which waits for the process to
 * exit *and* for its stdio to reach end of file — so an agent that leaves a detached grandchild
 * holding stdout exits, is reaped, and `close` never fires. The stub agent for the wedged case
 * does exactly that: it spawns a grandchild on its own stdout and exits 0. `process.kill(pid, 0)`
 * then answers ESRCH while the server is still waiting, which is the evidence this feature turns
 * on.
 *
 * Five things have to be true, and the third is the one that keeps the other four honest:
 *
 *  - **A record whose process is gone stops holding a slot**, on its own, with nobody asking.
 *  - **A record whose issue is closed and whose pull request merged stops holding one too** —
 *    the case actually observed, and the one a restart cannot fix, because the record outlives
 *    the process either way.
 *  - **A run that is genuinely still working is never reclaimed.** A reclaim is not a kill, but a
 *    slot given back while an agent is still writing puts another agent on the machine beside it.
 *    So the run with a live process and an open issue must come through untouched.
 *  - **`GET /api/implement` says which evidence closed a record**, so a reclaimed run is
 *    distinguishable from one that reported for itself.
 *  - **The board shows the reclaim** rather than only the `cap-full` that preceded it: the pass
 *    that reclaims records itself as `reclaimed`, and the next one starts the runs.
 *
 * Self-contained, in the style of `check-implement-queue.mjs`: a stub `gh` answering from
 * fixtures, a stub agent that either wedges or parks, its own canvas server on a port the kernel
 * hands out, and no browser. Nothing here talks to GitHub and nothing runs a real coding agent.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-reclaim.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const pullUrl = (number) => `https://github.com/${REPO}/pull/${1000 + number}`;

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };

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

/**
 * The three runs under test sit in **In Progress**, and the two the queue may start sit in Todo.
 *
 * Deliberately: the queue is turned on while every slot is taken, so nothing in Todo can start
 * until a slot comes back. A card in Todo that could start straight away would make "the queue
 * started again" true for a reason that has nothing to do with a reclaim.
 */
const ITEMS = [
  item('PVTI_401', { number: 401, option: DOING, createdAt: day(1) }),
  item('PVTI_402', { number: 402, option: DOING, createdAt: day(2), state: 'CLOSED' }),
  item('PVTI_403', { number: 403, option: DOING, createdAt: day(3) }),
  item('PVTI_404', { number: 404, option: TODO, createdAt: day(4) }),
  item('PVTI_405', { number: 405, option: TODO, createdAt: day(5) }),
];

/**
 * What `gh issue view` says, per number.
 *
 * `402` is the observed case written down: closed, with a pull request that merged. Everything
 * else is an ordinary open issue, which is what makes 401's reclaim rest on its process alone
 * and 403's survival rest on there being no positive evidence about it anywhere.
 */
const ISSUES = {
  401: { state: 'OPEN', closedBy: [] },
  402: { state: 'CLOSED', closedBy: [402] },
  403: { state: 'OPEN', closedBy: [] },
  501: { state: 'OPEN', closedBy: [] },
};

/** What `gh pr view` says, per pull request number. */
const PULLS = {
  [1000 + 402]: { state: 'MERGED', mergedAt: '2026-07-30T21:15:00Z' },
};

/** The issues whose stub agent wedges: it exits while a grandchild holds its stdout open. */
const WEDGING = [401, 501];

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-reclaim-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');
const grandchildLog = join(workDir, 'grandchildren.log');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

writeFileSync(join(workDir, 'project.json'), JSON.stringify({
  data: {
    owner: {
      projectV2: {
        id: 'PVT_project7',
        title: 'project 7',
        url: 'https://github.com/users/someone/projects/7',
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING] },
        items: { pageInfo: { hasNextPage: false }, nodes: ITEMS },
      },
    },
  },
}), 'utf8');

writeFileSync(join(workDir, 'issues.json'), JSON.stringify(ISSUES), 'utf8');
writeFileSync(join(workDir, 'pulls.json'), JSON.stringify(PULLS), 'utf8');
writeFileSync(grandchildLog, '', 'utf8');

/**
 * A `gh` that answers the three questions this check turns on and shrugs at the rest.
 *
 * The rest is the card move to In Progress, which happens on every start and which nothing here
 * asserts — an empty object is enough for the server to log a warning and carry on.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);
const line = args.join(' ');

if (args.includes('graphql')) {
  process.stdout.write(readFileSync(join(workDir, 'project.json'), 'utf8'));
} else if (args[0] === 'issue' && args[1] === 'view') {
  const number = (line.match(/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  const issues = JSON.parse(readFileSync(join(workDir, 'issues.json'), 'utf8'));
  const answer = issues[number] ?? { state: 'OPEN', closedBy: [] };
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'Issue ' + number,
    body: '',
    state: answer.state,
    comments: [],
    stateReason: answer.state === 'CLOSED' ? 'COMPLETED' : null,
    closedByPullRequestsReferences: (answer.closedBy ?? []).map((n) => ({
      number: 1000 + n,
      url: 'https://github.com/${REPO}/pull/' + (1000 + n),
    })),
  }) + '\\n');
} else if (args[0] === 'pr' && args[1] === 'view') {
  const number = (line.match(/pull\\/(\\d+)/) ?? [])[1] ?? '0';
  const pulls = JSON.parse(readFileSync(join(workDir, 'pulls.json'), 'utf8'));
  const answer = pulls[number];
  if (!answer) { process.stderr.write('stub gh: no such pull request ' + number + '\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: answer.state, mergedAt: answer.mergedAt }) + '\\n');
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

/**
 * The agent, in its two shapes.
 *
 * **Wedging** is the defect, reproduced: a detached grandchild is spawned onto this process's own
 * stdout and this process exits 0. The pid the server recorded is then gone — `kill(pid, 0)`
 * answers ESRCH — while the pipe stays open, so the `close` the server is waiting on never
 * arrives and the record stays `running` forever. Its pid is written to a log so the check can
 * kill it afterwards rather than leave a process behind for twenty minutes.
 *
 * **Parking** is a healthy run in flight: it waits for a release file and then prints its pull
 * request. That is what a run that must not be reclaimed looks like from outside.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const wedging = ${JSON.stringify(WEDGING)};

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = Number((input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? 0);
  writeFileSync(join(workDir, 'started-' + number), String(process.pid), 'utf8');

  if (wedging.includes(number)) {
    const grand = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 240000)'], {
      stdio: ['ignore', 1, 2],
      detached: true,
      windowsHide: true,
    });
    grand.unref();
    appendFileSync(${JSON.stringify(grandchildLog)}, grand.pid + '\\n');
    process.exit(0);
  }

  for (let attempt = 0; attempt < 3000; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/${REPO}/pull/' + (1000 + number) + '\\n');
});
`, 'utf8');

const boardDir = join(workDir, 'board');
mkdirSync(boardDir, { recursive: true });
writeFileSync(join(boardDir, 'board.config.json'), JSON.stringify({
  name: 'board',
  repo: REPO,
  githubProject: 'https://github.com/users/someone/projects/7',
}), 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'board', path: boardDir.replace(/\\/g, '/') }],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

// ─── The server ───────────────────────────────────────────────

/** Short enough that a case does not have to wait out a real interval to see a pass. */
const QUEUE_MS = 600;
/** The same, for the grace a record whose process is gone waits before its slot comes back. */
const RECLAIM_MS = 500;

let child = null;
let serverOutput = '';
let BASE = '';

async function startCanvas(env = {}) {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const started = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'warn',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
      EXCALIDRAW_IMPLEMENT_RECLAIM_MS: String(RECLAIM_MS),
      ...env,
    },
  });
  child = started.child;
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });

  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${serverOutput}`);
}

async function stopCanvas() {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
  await sleep(300);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const start = (number) => call('/api/implement?workspace=board', {
  method: 'POST',
  body: JSON.stringify({ url: issueUrl(number) }),
});

const listing = () => call('/api/implement?workspace=board').then((answer) => answer.body);

async function recordFor(number) {
  const body = await listing();
  return (body.runs ?? []).find((run) => run.issueUrl === issueUrl(number)) ?? null;
}

/** Wait until a record satisfies `wanted`, and give back whatever it was last seen as. */
async function waitFor(number, wanted, attempts = 200) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await recordFor(number);
    if (last && wanted(last)) return last;
    await sleep(100);
  }
  return last;
}

/** Wait until the stub agent for an issue has written down that it started. */
async function waitForAgent(number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(join(workDir, `started-${number}`))) return true;
    await sleep(100);
  }
  return false;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Every `lastPass` the queue reported while something else was being waited for. */
const passesSeen = [];
let watching = false;
async function watchPasses() {
  watching = true;
  while (watching) {
    try {
      const body = await listing();
      const pass = body?.queue?.lastPass;
      if (pass && passesSeen.at(-1)?.at !== pass.at) passesSeen.push(pass);
    } catch { /* the server may be going down */ }
    await sleep(60);
  }
}

try {
  console.log('1. three runs fill every slot, and one of them wedges');
  await startCanvas({ EXCALIDRAW_IMPLEMENT_CONCURRENCY: '3' });
  for (const number of [401, 402, 403]) {
    const answer = await start(number);
    check(`#${number} started`, answer.status === 202, JSON.stringify(answer));
  }
  check('#401 spawned an agent', await waitForAgent(401));
  check('#402 spawned an agent', await waitForAgent(402));
  check('#403 spawned an agent', await waitForAgent(403));

  const wedged = await waitFor(401, (run) => run.pid !== null && run.pid !== undefined);
  check('the record says which process the run is in', Number.isInteger(wedged?.pid),
        JSON.stringify(wedged));
  // The wedge itself: the process is gone and the server has not noticed.
  for (let attempt = 0; attempt < 100 && alive(wedged?.pid); attempt++) await sleep(100);
  check('and that process is gone while the record still says running',
        !alive(wedged?.pid) && (await recordFor(401))?.state === 'running',
        JSON.stringify(await recordFor(401)));

  // Deliberately not a fourth click: a click is one of the two doors the reclaim is fitted to,
  // so asking for one here would give the slot back before the queue ever looked. Section 7 is
  // where that door is tested, on a server of its own. What matters now is only that every slot
  // is spoken for and the cap has no idea one of the runs holding one is over.
  const holding = (await listing()).runs.filter((run) => run.state === 'running');
  check('every slot is spoken for', holding.length === 3, JSON.stringify(holding.map((r) => r.state)));

  console.log('\n2. the queue reclaims the wedged slot with nobody asking');
  // Both evidences are given time to ripen before the queue is switched on, so that the pass
  // below is one that could reconcile everything rather than one that arrives too early for
  // half of it. The grace on a gone process and the floor under asking GitHub about a run are
  // the same number, and a run started a moment ago is deliberately not what either is for.
  await sleep(RECLAIM_MS + 400);
  void watchPasses();
  const on = await call('/api/implement/queue?workspace=board', {
    method: 'POST',
    body: JSON.stringify({ enabled: true }),
  });
  check('the queue is on', on.body?.queue?.enabled === true, JSON.stringify(on.body));

  const reclaimed401 = await waitFor(401, (run) => run.state !== 'running');
  check('#401 stops holding a slot', reclaimed401?.state !== 'running', JSON.stringify(reclaimed401));
  check('and is interrupted, which Resume already understands',
        reclaimed401?.state === 'interrupted', JSON.stringify(reclaimed401));
  check('the evidence that closed it is on the record',
        reclaimed401?.reclaimed?.evidence === 'no-process', JSON.stringify(reclaimed401?.reclaimed));
  check('and it says so in words a reader can act on',
        String(reclaimed401?.reclaimed?.detail ?? '').includes(String(wedged?.pid)),
        JSON.stringify(reclaimed401?.reclaimed));
  check('it ended, so nothing is still counting time for it', Boolean(reclaimed401?.endedAt),
        JSON.stringify(reclaimed401));
  check('its checkout is still named, so the work can be resumed',
        typeof reclaimed401?.worktree === 'string' || reclaimed401?.worktree === null,
        JSON.stringify(reclaimed401));

  console.log('\n3. a run whose issue closed and whose pull request merged stops holding one too');
  const reclaimed402 = await waitFor(402, (run) => run.state !== 'running');
  check('#402 stops holding a slot', reclaimed402?.state !== 'running', JSON.stringify(reclaimed402));
  check('and is done: its work landed', reclaimed402?.state === 'done', JSON.stringify(reclaimed402));
  check('the pull request that closed it is on the record',
        reclaimed402?.url === pullUrl(402), JSON.stringify(reclaimed402));
  check('the evidence that closed it is on the record',
        reclaimed402?.reclaimed?.evidence === 'landed', JSON.stringify(reclaimed402?.reclaimed));
  check('and it names the pull request',
        String(reclaimed402?.reclaimed?.detail ?? '').includes(pullUrl(402)),
        JSON.stringify(reclaimed402?.reclaimed));

  console.log('\n4. the run that is genuinely still working is untouched');
  const working = await recordFor(403);
  check('#403 is still running', working?.state === 'running', JSON.stringify(working));
  check('nothing was reclaimed about it', !working?.reclaimed, JSON.stringify(working));
  check('its process is still there', alive(working?.pid), JSON.stringify(working));

  console.log('\n5. the queue starts again, and the board is told about the reclaim');
  const started404 = await waitFor(404, (run) => run.state === 'running');
  check('the oldest Todo issue starts in a reclaimed slot',
        started404?.state === 'running', JSON.stringify(started404));
  const started405 = await waitFor(405, (run) => run.state === 'running');
  check('and so does the next one', started405?.state === 'running', JSON.stringify(started405));

  watching = false;
  await sleep(200);
  const reclaimPasses = passesSeen.filter((pass) => pass.reason === 'reclaimed');
  check('a pass reported itself as a reclaim rather than as cap-full',
        reclaimPasses.length > 0, JSON.stringify(passesSeen.map((pass) => pass.reason)));
  // Across passes rather than within one, and that is the design rather than a concession: a
  // gone process is never acted on at first sight, so the pass that notices one and the pass
  // that gives its slot back cannot be the same pass. What has to be true is that every slot
  // was given back and the board was told about each, not that it happened in one breath.
  const saidBack = reclaimPasses.map((pass) => pass.detail).join(' ');
  check('and between them they name both runs given back',
        saidBack.includes(issueUrl(401)) && saidBack.includes(issueUrl(402)),
        JSON.stringify(passesSeen));
  check('each naming the evidence in words',
        /its process is gone/.test(saidBack) && /its work landed/.test(saidBack), saidBack);
  check('a reclaim is not a stall — the queue did something',
        reclaimPasses.every((pass) => pass.stalled === false), JSON.stringify(reclaimPasses));
  check('and it was said out loud, not only in the log file',
        /[Rr]eclaim/.test(serverOutput), serverOutput.slice(-600));

  console.log('\n6. GET /api/implement tells a reclaimed record from a working one');
  const body = await listing();
  const byUrl = Object.fromEntries((body.runs ?? []).map((run) => [run.issueUrl, run]));
  check('every record carries the field', (body.runs ?? []).every((run) => 'reclaimed' in run),
        JSON.stringify(body.runs));
  check('the wedged one names its evidence',
        byUrl[issueUrl(401)]?.reclaimed?.evidence === 'no-process');
  check('the landed one names its evidence',
        byUrl[issueUrl(402)]?.reclaimed?.evidence === 'landed');
  check('the working one names none', byUrl[issueUrl(403)]?.reclaimed === null,
        JSON.stringify(byUrl[issueUrl(403)]));
  check('and the runs that were started afterwards name none either',
        byUrl[issueUrl(404)]?.reclaimed === null && byUrl[issueUrl(405)]?.reclaimed === null);
  await stopCanvas();

  console.log('\n7. a click gets the slot back too, without any queue');
  // The queue is never turned on here: the reclaim has to happen where the cap is counted, or a
  // board that never drains automatically keeps the defect it was the whole reason to fix.
  await startCanvas({ EXCALIDRAW_IMPLEMENT_CONCURRENCY: '1' });
  const only = await start(501);
  check('#501 takes the only slot', only.status === 202, JSON.stringify(only));
  check('#501 spawned an agent', await waitForAgent(501));
  const held = await waitFor(501, (run) => run.pid !== null && run.pid !== undefined);
  for (let attempt = 0; attempt < 100 && alive(held?.pid); attempt++) await sleep(100);
  check('its process is gone', !alive(held?.pid), JSON.stringify(held));

  // Two attempts: the first is what notices the process is gone, the second is past the grace.
  let second = await start(502);
  for (let attempt = 0; attempt < 60 && second.status === 409; attempt++) {
    await sleep(200);
    second = await start(502);
  }
  check('the next click is accepted rather than refused by a slot nobody holds',
        second.status === 202, JSON.stringify(second));
  const abandoned = await recordFor(501);
  check('and the wedged record was reclaimed', abandoned?.state === 'interrupted',
        JSON.stringify(abandoned));
  check('on the evidence of its own process', abandoned?.reclaimed?.evidence === 'no-process',
        JSON.stringify(abandoned?.reclaimed));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  watching = false;
  if (child && child.exitCode === null) child.kill('SIGKILL');
  // The grandchildren are the point of the fixture and would otherwise sit here for minutes.
  try {
    for (const line of readFileSync(grandchildLog, 'utf8').split('\n')) {
      const pid = Number(line.trim());
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  } catch { /* nothing was ever wedged */ }
  await sleep(200);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
