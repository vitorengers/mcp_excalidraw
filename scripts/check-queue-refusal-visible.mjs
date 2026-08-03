#!/usr/bin/env node
/**
 * Checks that a queue pass which refused every card says so instead of drawing a healthy board.
 *
 * `beginImplement` answers **403** when the account behind `gh` cannot push to the checkout's
 * origin (`src/core/github-push.ts`), and that refusal is deliberate and permanent: the same
 * account will be refused on the next pass, and on every pass after it, until somebody forks the
 * repository and repoints the remote. `scripts/check-implement-no-push.mjs` already pins the
 * re-refusal as the right answer to a person clicking twice — the queue clicks every interval.
 *
 * The start loop read only `202` and `409`. Everything else was a `logger.warn` and a
 * fall-through to the next card, so the pass reached its `finally` with `outcome` still at its
 * default — `nothing-startable`, which `reasonStalls` classifies as healthy and `reasonAnnounces`
 * suppresses. The board therefore drew a normal idle queue every interval while the same oldest
 * card was refused for ever: the silence #263 exists to end, arriving through a door #263 did not
 * cover.
 *
 * So the cases are the refusal and the three states it must not have swallowed:
 *
 *  - a pass whose every startable card is refused reports `refused`, `stalled` and `announce`,
 *    with a detail naming how many were refused and the first refusal's status and sentence;
 *  - a column that genuinely holds nothing still reports `nothing-startable`, and stays quiet;
 *  - a cap that is full still reports `cap-full`, still stalls, and is still not announced;
 *  - the reason is not sticky: an account that gains push access starts the run on the next pass.
 *
 * And one case with no server in it at all. `QueuePassReason` is a union, which has no runtime
 * representation, so "every reason is classified" is unassertable without `QUEUE_PASS_REASONS`.
 * Section 4 iterates it against a table written out here, so a reason added to the taxonomy with
 * no decision recorded about whether it stalls and whether it interrupts a reader is red — the
 * predicates are deny-lists and would otherwise classify a new member silently, correctly or not.
 *
 * Self-contained, in the style of `check-implement-queue.mjs` and `check-implement-no-push.mjs`:
 * throwaway git projects with origins it invents, a stub `gh` answering per project number and
 * per repository, a stub agent that parks until released, its own canvas server on a port the
 * kernel just handed it. Nothing here talks to GitHub and nothing runs a real coding agent. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-queue-refusal-visible.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

// ─── The projects the stub serves ─────────────────────────────

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

/** A day in July 2026, so "oldest" is a fact of the fixture rather than of the clock. */
const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

const issueUrl = (repo, number) => `https://github.com/${repo}/issues/${number}`;

function item(id, { repo, number, option, createdAt, state = 'OPEN' }) {
  return {
    id,
    fieldValueByName: { optionId: option.id, name: option.name },
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: issueUrl(repo, number),
      createdAt,
      state,
      repository: { nameWithOwner: repo },
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

const READ_ONLY = 'someone/read-only';
const WRITABLE = 'someone/writable';

/** Two open cards, both of which the READ account is refused for. */
const REFUSED_ITEMS = [
  item('PVTI_601', { repo: READ_ONLY, number: 601, option: TODO, createdAt: day(1) }),
  item('PVTI_602', { repo: READ_ONLY, number: 602, option: TODO, createdAt: day(2) }),
  item('PVTI_610', { repo: READ_ONLY, number: 610, option: DONE, createdAt: day(3) }),
];

/** A Todo column that exists and holds nothing this queue may start: every card is closed. */
const EMPTY_ITEMS = [
  item('PVTI_651', { repo: WRITABLE, number: 651, option: TODO, createdAt: day(1), state: 'CLOSED' }),
  item('PVTI_652', { repo: WRITABLE, number: 652, option: TODO, createdAt: day(2), state: 'CLOSED' }),
];

/** Three startable cards against a cap of two, so the third pass finds every slot taken. */
const CAP_ITEMS = [
  item('PVTI_701', { repo: WRITABLE, number: 701, option: TODO, createdAt: day(1) }),
  item('PVTI_702', { repo: WRITABLE, number: 702, option: TODO, createdAt: day(2) }),
  item('PVTI_703', { repo: WRITABLE, number: 703, option: TODO, createdAt: day(3) }),
];

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `queue-refusal-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');
/** What `gh repo view` says about the read-only repository. Section 5 rewrites it. */
const permissionPath = join(workDir, 'permission.txt');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

writeFileSync(join(workDir, 'project-5.json'), JSON.stringify(project(5, REFUSED_ITEMS)), 'utf8');
writeFileSync(join(workDir, 'project-6.json'), JSON.stringify(project(6, EMPTY_ITEMS)), 'utf8');
writeFileSync(join(workDir, 'project-7.json'), JSON.stringify(project(7, CAP_ITEMS)), 'utf8');
writeFileSync(permissionPath, 'READ', 'utf8');
writeFileSync(join(workDir, 'started.log'), '', 'utf8');

/**
 * A `gh` that answers the project per number, the permission per repository, and an issue body
 * with no dependency declaration in it.
 *
 * The permission for the read-only repository is read off a file on every call rather than
 * baked in, because section 5 flips it while the server is up — which is the whole of "the
 * reason is not sticky".
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2);

if (args.includes('graphql')) {
  const number = (args.join(' ').match(/number=(\\d+)/) ?? [])[1] ?? '5';
  process.stdout.write(readFileSync(join(workDir, 'project-' + number + '.json'), 'utf8'));
  process.exit(0);
}

if (args[0] === 'repo' && args[1] === 'view') {
  const repo = args[2] ?? '';
  const permission = repo === ${JSON.stringify(READ_ONLY)}
    ? readFileSync(${JSON.stringify(permissionPath)}, 'utf8').trim()
    : 'WRITE';
  process.stdout.write(JSON.stringify({ viewerPermission: permission }) + '\\n');
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'view') {
  const number = (String(args[2] ?? '').match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'Issue ' + number,
    // No "Depends on #N" line, so nothing here is blocked and the refusal is the only reason
    // a pass can end on.
    body: 'Nothing declared.',
    state: 'OPEN',
    url: String(args[2] ?? ''),
    comments: [],
  }) + '\\n');
  process.exit(0);
}

// Every other call is the move to In Progress, which this check does not assert.
process.stdout.write('{}\\n');
`, 'utf8');

/**
 * Stands in for the implement agent: it records that it was started and then parks, so a run
 * that was allowed is genuinely in flight while the queue is looked at.
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
  process.stdout.write('https://github.com/' + 'someone/writable' + '/pull/' + number + '\\n');
});
`, 'utf8');

/**
 * One board per state a pass can end in, each a real git repository with an `origin` of its
 * own: the push probe reads the remote rather than the configured `repo`, so a board that is
 * refused and a board that is not are two checkouts, not two settings.
 */
const BOARDS = [
  { id: 'board-refused', project: 5, repo: READ_ONLY, origin: `https://github.com/${READ_ONLY}.git` },
  { id: 'board-empty', project: 6, repo: WRITABLE, origin: `https://github.com/${WRITABLE}.git` },
  { id: 'board-cap', project: 7, repo: WRITABLE, origin: `https://github.com/${WRITABLE}.git` },
];

for (const board of BOARDS) {
  const dir = join(workDir, board.id);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: board.id,
    repo: board.repo,
    githubProject: `https://github.com/users/someone/projects/${board.project}`,
  }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${board.id}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  git(dir, ['remote', 'add', 'origin', board.origin]);
  board.path = dir.replace(/\\/g, '/');
}

writeFileSync(registryPath, JSON.stringify({
  workspaces: BOARDS.map((board) => ({ id: board.id, path: board.path })),
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

const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: String(CAP),
    EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
    // The push probe sits behind this memo, and section 5 changes the answer while the server
    // is up. Off, so a pass asks rather than remembering — the memo is not what is under test.
    EXCALIDRAW_GH_STATUS_MEMO_MS: '0',
  },
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the canvas server exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${server.read()}`);
}

async function call(workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const setQueue = (workspace, enabled) =>
  call(workspace, '/api/implement/queue', { method: 'POST', body: JSON.stringify({ enabled }) });

const queueOf = async (workspace) => (await call(workspace, '/api/implement')).body?.queue ?? null;

const started = (n) => existsSync(join(workDir, `run-${n}.json`));
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');

/**
 * Wait for a pass the predicate accepts, and hand back whatever was seen last either way.
 *
 * On a timeout it prints the queue state it did see, which is the point: against the build this
 * check was written for, section 1 times out and the line it prints is the defect verbatim.
 */
async function waitForPass(workspace, predicate, what, ms = 9000) {
  const deadline = Date.now() + ms;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await queueOf(workspace);
    if (seen?.lastPass && predicate(seen)) return seen;
    await sleep(120);
  }
  console.error(`  FAIL  timed out waiting for ${what} — last saw ${JSON.stringify(seen)}`);
  failures++;
  return seen;
}

/**
 * Wait for the stub agent to record that it ran.
 *
 * The record leads the agent: a slot is claimed before the first `await` and the pass reports in
 * its `finally`, while the stub only writes its file once its prompt has arrived on stdin. So
 * "the queue says it started two" and "two agents exist" are not the same instant, and asserting
 * the second one straight off the first is a race rather than a claim about the queue.
 */
async function waitForStarted(numbers, what, ms = 9000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (numbers.every(started)) return true;
    await sleep(100);
  }
  console.error(`  FAIL  timed out waiting for ${what} — `
                + numbers.map((n) => `${n}: ${started(n)}`).join(', '));
  failures++;
  return false;
}

/** Long enough that a pass which was going to happen has happened, several times over. */
const severalPasses = () => sleep(QUEUE_MS * 6);

const EVERY_RUN = [601, 602, 651, 652, 701, 702, 703];

try {
  await waitForHealth();

  console.log('1. a pass that refused every card says so, and it stalls');
  const on = await setQueue('board-refused', true);
  check('the toggle answers on', on.status === 200 && on.body?.queue?.enabled === true,
        `${on.status} ${JSON.stringify(on.body)}`);
  const refusedPass = await waitForPass('board-refused',
                                        (queue) => queue.lastPass.reason === 'refused',
                                        'the pass to report the refusal');
  const pass = refusedPass?.lastPass ?? {};
  check('the reason is the refusal, not an idle column', pass.reason === 'refused',
        JSON.stringify(refusedPass));
  check('and the queue reports itself stalled', refusedPass?.stalled === true,
        JSON.stringify(refusedPass));
  check('and worth interrupting a reader for', refusedPass?.announce === true,
        JSON.stringify(refusedPass));
  const said = String(pass.detail ?? '');
  check('the detail says how many cards were refused', /\b2 card/.test(said), said || '(no detail)');
  check('and the status the first refusal came back with', said.includes('403'), said);
  check('and the sentence that refusal carried', /\bfork/i.test(said) && said.includes(READ_ONLY), said);
  check('nothing was started for either card', !started(601) && !started(602),
        `601: ${started(601)}, 602: ${started(602)}`);

  await severalPasses();
  const stillRefused = await queueOf('board-refused');
  check('and it goes on saying it rather than settling back to idle',
        stillRefused?.lastPass?.reason === 'refused' && stillRefused?.stalled === true,
        JSON.stringify(stillRefused));

  console.log('\n2. a column that really holds nothing is still quiet');
  await setQueue('board-empty', true);
  const empty = await waitForPass('board-empty',
                                  (queue) => queue.lastPass.reason === 'nothing-startable',
                                  'the empty column to report itself idle');
  check('the reason is nothing-startable', empty?.lastPass?.reason === 'nothing-startable',
        JSON.stringify(empty));
  check('which is not a stall', empty?.stalled === false, JSON.stringify(empty));
  check('and is not announced', empty?.announce === false, JSON.stringify(empty));
  await setQueue('board-empty', false);

  console.log('\n3. a full cap is still a full cap, and is still not announced');
  await setQueue('board-cap', true);
  await waitForPass('board-cap', (queue) => queue.lastPass.reason === 'started',
                    `the queue to fill both slots`);
  const capped = await waitForPass('board-cap', (queue) => queue.lastPass.reason === 'cap-full',
                                   'the next pass to find every slot taken');
  check('the reason is cap-full', capped?.lastPass?.reason === 'cap-full', JSON.stringify(capped));
  check('which stalls', capped?.stalled === true, JSON.stringify(capped));
  check('and is still not announced', capped?.announce === false, JSON.stringify(capped));
  await waitForStarted([701, 702], 'both allowed runs to reach the agent');
  check('the two oldest cards are the ones running', started(701) && started(702),
        `701: ${started(701)}, 702: ${started(702)}`);
  check('and the third was not started over the cap', !started(703), 'a third run started');
  await setQueue('board-cap', false);

  console.log('\n4. every reason in the taxonomy is classified, and the classification is asserted');
  const queueModule = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'implement-queue.js')).href
  );
  const { QUEUE_PASS_REASONS, reasonStalls, reasonAnnounces } = queueModule;
  /**
   * What each reason means, written out here rather than derived.
   *
   * `reasonStalls` and `reasonAnnounces` are deny-lists — anything they do not name stalls and
   * announces — so a reason added to the union is classified whether or not anybody decided
   * what it should be. This table is the decision, and the two directions below are what make
   * a missing one red: a member of `QUEUE_PASS_REASONS` with no row, or a row naming a reason
   * the taxonomy no longer has.
   */
  const CLASSIFIED = {
    'started': { stalls: false, announces: false },
    'nothing-startable': { stalls: false, announces: false },
    'cap-full': { stalls: true, announces: false },
    'reclaimed': { stalls: false, announces: false },
    'no-column': { stalls: true, announces: true },
    'no-project': { stalls: true, announces: true },
    'blocked': { stalls: false, announces: false },
    'deadlocked': { stalls: true, announces: true },
    'refused': { stalls: true, announces: true },
    'unreadable': { stalls: true, announces: true },
  };
  check('the reasons are exported at runtime at all', Array.isArray(QUEUE_PASS_REASONS),
        `got ${typeof QUEUE_PASS_REASONS}`);
  check('as a frozen array, so nothing can edit the taxonomy under a reader',
        Object.isFrozen(QUEUE_PASS_REASONS ?? {}), JSON.stringify(QUEUE_PASS_REASONS ?? null));
  const listed = [...(QUEUE_PASS_REASONS ?? [])];
  const unclassified = listed.filter((reason) => !(reason in CLASSIFIED));
  check('every exported reason has a decision recorded about it', unclassified.length === 0,
        `unclassified: ${unclassified.join(', ')}`);
  const missing = Object.keys(CLASSIFIED).filter((reason) => !listed.includes(reason));
  check('and every reason this check knows about is still in the taxonomy', missing.length === 0,
        `not exported: ${missing.join(', ')}`);
  for (const reason of listed) {
    const wanted = CLASSIFIED[reason];
    if (!wanted) continue;
    check(`${reason} ${wanted.stalls ? 'stalls' : 'does not stall'}`,
          reasonStalls(reason) === wanted.stalls, `reasonStalls("${reason}") = ${reasonStalls(reason)}`);
    check(`${reason} ${wanted.announces ? 'is announced' : 'is not announced'}`,
          reasonAnnounces(reason) === wanted.announces,
          `reasonAnnounces("${reason}") = ${reasonAnnounces(reason)}`);
  }
  check('the refusal is one of them', listed.includes('refused'), JSON.stringify(listed));

  console.log('\n5. the reason is not sticky: push access granted starts the run');
  writeFileSync(permissionPath, 'WRITE', 'utf8');
  const draining = await waitForPass('board-refused', (queue) => queue.lastPass.reason === 'started',
                                     'the queue to start the card it had been refused');
  check('the pass now reports what it started', draining?.lastPass?.reason === 'started',
        JSON.stringify(draining));
  check('which is not a stall', draining?.stalled === false, JSON.stringify(draining));
  check('nor announced', draining?.announce === false, JSON.stringify(draining));
  await waitForStarted([601], 'the card that had been refused to reach the agent');
  check('and the oldest refused card is the one that ran', started(601),
        JSON.stringify(await queueOf('board-refused')));
  await setQueue('board-refused', false);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const number of EVERY_RUN) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  await sleep(800);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
  await sleep(200);
  for (const board of BOARDS) {
    const dir = join(workDir, board.id);
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  // Forgiven: on Windows a killed server's handles are released asynchronously, and a run that
  // reported failure because it could not delete a temporary directory would be wrong about the
  // thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
