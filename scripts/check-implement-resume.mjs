#!/usr/bin/env node
/**
 * Checks that a run killed with its server comes back as something, and can be resumed.
 *
 * The state of an implementation lived only in a `Map` in the process that started it, so
 * killing the canvas server did not merely stop five runs — it erased the fact that they had
 * ever happened. `GET /api/implement` on the restarted process answered `0 runs recorded`
 * while two worktrees sat on disk holding 377 uncommitted lines, and the only control the
 * panel offered was **Implement / Fix**, which starts over on top of work it did not write.
 *
 * So the cases here are about what survives a restart, and the answer is the worktree: it
 * *is* the work, so it cannot lie about it. A checkout named `issue-<n>` with commits the base
 * does not have, or with a dirty tree, is a run that was interrupted; a clean one with nothing
 * ahead is nothing to resume, which is an answer rather than a gap.
 *
 * Self-contained, in the shape of `check-implement-parallel.mjs`: it builds a throwaway git
 * repository, writes a stub implement agent that hangs so it can be killed at a known point,
 * starts its own canvas servers on free ports and kills them. Nothing here talks to GitHub.
 * Run `./node_modules/.bin/tsc` first — the last case reads the compiled panel predicates.
 *
 * Usage: node scripts/check-implement-resume.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

/** One spelling for paths that arrive from git, from Node and from an API. */
function samePath(a, b) {
  const clean = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

async function waitFor(predicate, what, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true;
    await sleep(100);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The throwaway world ──────────────────────────────────────

// Deliberately not named after this check: the worktree paths below end up *inside* the
// prompt, and a directory called `implement-resume-…` would satisfy every assertion about
// what the agent was told without a line of the feature existing.
const workDir = join(tmpdir(), `implement-restart-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const REPO = 'vitorengers/mcp_excalidraw';

/** A real git repository, because worktrees are the thing detection reads. */
function makeProject(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name, repo: REPO }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

const projectDir = makeProject('project');
const worktreeRoot = join(workDir, 'project-worktrees');

/**
 * Stands in for the implement agent.
 *
 * It reports where it was started, on which branch, and — the fact the resume cases turn on —
 * the prompt it was handed over stdin. `commit-<n>` makes it leave a real commit behind and
 * `dirty-<n>` an uncommitted file, which between them are the two shapes of "there is work
 * here". Then it hangs until released, so the server can be killed while it is still running.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  let branch = '';
  try { branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); } catch {}

  if (existsSync(join(workDir, 'commit-' + number))) {
    try {
      writeFileSync(join(process.cwd(), 'landed-' + number + '.txt'), 'committed work\\n', 'utf8');
      execSync('git add -A && git commit -m "work in progress"', { stdio: 'ignore' });
    } catch {}
  }
  if (existsSync(join(workDir, 'dirty-' + number))) {
    writeFileSync(join(process.cwd(), 'unfinished-' + number + '.txt'), 'work in progress\\n', 'utf8');
  }

  writeFileSync(join(workDir, 'run-' + number + '.json'),
    JSON.stringify({ cwd: process.cwd(), branch, prompt: input }), 'utf8');

  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'resume', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

const running = [];

function startCanvas(port) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    },
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

const firstPort = await freePort();
const secondPort = await freePort();
const FIRST = `http://127.0.0.1:${firstPort}`;
const SECOND = `http://127.0.0.1:${secondPort}`;

async function call(base, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=resume`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const issue = (n) => `https://github.com/${REPO}/issues/${n}`;
const start = (base, n, body = {}) =>
  call(base, '/api/implement', { method: 'POST', body: JSON.stringify({ url: issue(n), ...body }) });
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const marker = (name) => writeFileSync(join(workDir, name), '', 'utf8');
const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));
const started = (n) => existsSync(join(workDir, `run-${n}.json`));
const forget = (n) => { try { unlinkSync(join(workDir, `run-${n}.json`)); } catch { /* never ran */ } };

async function listRuns(base) {
  return (await call(base, '/api/implement')).body?.runs ?? [];
}

async function recordFor(base, n) {
  return (await listRuns(base)).find((run) => run.issueUrl === issue(n)) ?? null;
}

/** The restarted server reads git before it answers, so the record arrives a moment late. */
async function settledRecord(base, n, wanted, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const record = await recordFor(base, n);
    if (record && (!wanted || record.state === wanted)) return record;
    await sleep(100);
  }
  return null;
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  console.log('1. a run is killed with its server, halfway through');
  // 301 leaves both shapes of work behind: a commit the base does not have, and a file that
  // was never committed at all. 302 is created by hand below and leaves neither.
  marker('commit-301');
  marker('dirty-301');

  const first = startCanvas(firstPort);
  await waitForHealth(FIRST, first.child, first.read);

  const accepted = await start(FIRST, 301);
  check('the run starts', accepted.status === 202, `got ${accepted.status} ${JSON.stringify(accepted.body)}`);
  await waitFor(() => started(301), 'the agent to report where it was started');
  const run301 = started(301) ? runReport(301) : { cwd: '', branch: '', prompt: '' };
  check('it was given a worktree of its own', run301.branch === 'issue-301', `on ${run301.branch}`);

  const beforeKill = await recordFor(FIRST, 301);
  check('the server that started it says it is running', beforeKill?.state === 'running',
        JSON.stringify(beforeKill));

  first.child.kill('SIGKILL');
  await waitFor(() => first.child.exitCode !== null || first.child.signalCode !== null,
                'the first server to die');

  // A checkout with nothing in it, so the restart has both kinds to tell apart.
  const clean = join(worktreeRoot, 'issue-302');
  git(projectDir, ['worktree', 'add', clean, '-b', 'issue-302', 'main']);
  check('the clean checkout exists', existsSync(clean), clean);

  console.log('\n2. the restarted server reports it as interrupted rather than as absent');
  const second = startCanvas(secondPort);
  await waitForHealth(SECOND, second.child, second.read);

  const recovered = await settledRecord(SECOND, 301, 'interrupted');
  check('the run the restart lost is reported at all', recovered !== null,
        `${JSON.stringify(await listRuns(SECOND))} — the restarted server knows of no runs`);
  check('and reported as interrupted', recovered?.state === 'interrupted', JSON.stringify(recovered));
  check('it names the checkout the work is in', samePath(recovered?.worktree, run301.cwd),
        `reported ${recovered?.worktree}, worktree at ${run301.cwd}`);
  check('the work itself was not touched',
        existsSync(join(run301.cwd, 'unfinished-301.txt')) && existsSync(join(run301.cwd, 'landed-301.txt')),
        run301.cwd);

  console.log('\n3. a checkout with no work in it is not a run to resume');
  const emptyOne = await recordFor(SECOND, 302);
  check('nothing is reported for it', emptyOne === null, JSON.stringify(emptyOne));

  console.log('\n4. Resume is offered for an interrupted run and refused for anything else');
  const strayResume = await start(SECOND, 303, { resume: true });
  check('409 for an issue with no interrupted run', strayResume.status === 409,
        `got ${strayResume.status} ${JSON.stringify(strayResume.body)}`);
  check('and nothing was started for it', !started(303), 'the refused resume spawned anyway');

  forget(301);
  const resumed = await start(SECOND, 301, { resume: true });
  check('the interrupted run resumes', resumed.status === 202,
        `got ${resumed.status} ${JSON.stringify(resumed.body)}`);
  await waitFor(() => started(301), 'the resumed agent to report');
  const again = started(301) ? runReport(301) : { cwd: '', branch: '', prompt: '' };
  check('it was put back in the same checkout', samePath(again.cwd, run301.cwd),
        `first ${run301.cwd}, resumed ${again.cwd}`);
  check('and told that it is resuming an interrupted run',
        /resuming an implementation that was interrupted/i.test(again.prompt),
        again.prompt.slice(-400) || '(no prompt captured)');
  check('and told to read what the previous attempt left before building on it',
        /git status/i.test(again.prompt) && /previous attempt/i.test(again.prompt),
        again.prompt.slice(-400));
  check('a run that was never interrupted is told none of that',
        !/previous attempt/i.test(run301.prompt), run301.prompt.slice(-200));

  console.log('\n5. resuming does not become a second run for the same issue');
  const live = await recordFor(SECOND, 301);
  check('the resumed run is running', live?.state === 'running', JSON.stringify(live));
  const twice = await start(SECOND, 301, { resume: true });
  check('409 for a second resume while it runs', twice.status === 409, `got ${twice.status}`);
  const plain = await start(SECOND, 301);
  check('409 for Implement / Fix while it runs', plain.status === 409, `got ${plain.status}`);

  release(301);
  const finished = await settledRecord(SECOND, 301, 'done');
  check('the resumed run finishes', finished?.state === 'done', JSON.stringify(finished));

  console.log('\n6. the panel offers Resume for an interrupted run, and only for one');
  const appearance = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-appearance.js')).href
  ).catch(() => null);
  if (appearance?.offersResume) {
    check('interrupted offers Resume',
          appearance.offersResume({ githubState: 'OPEN', implementState: 'interrupted' }));
    check('running does not',
          !appearance.offersResume({ githubState: 'OPEN', implementState: 'running' }));
    check('a run that never happened does not',
          !appearance.offersResume({ githubState: 'OPEN', implementState: null }));
    check('nor a failed one, which never lost its server',
          !appearance.offersResume({ githubState: 'OPEN', implementState: 'failed' }));
    check('nor a done one', !appearance.offersResume({ githubState: 'OPEN', implementState: 'done' }));
    check('a closed issue is offered neither',
          !appearance.offersResume({ githubState: 'CLOSED', implementState: 'interrupted' }));
    check('starting over stays possible alongside it',
          appearance.offersImplement({ githubState: 'OPEN', implementState: 'interrupted' }));
  } else {
    failures++;
    console.error('  FAIL  offersResume is exported from src/core/issue-appearance.ts');
  }
} finally {
  for (const n of [301, 302, 303]) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(500);
  stopAll();
  await sleep(300);
  if (existsSync(projectDir)) {
    for (const name of ['issue-301', 'issue-302']) {
      git(projectDir, ['worktree', 'remove', '--force', join(worktreeRoot, name)]);
    }
    git(projectDir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
