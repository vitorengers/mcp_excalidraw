#!/usr/bin/env node
/**
 * Checks that two implementations running at once cannot collide.
 *
 * Before this, every implement agent ran in the same working tree: `buildAgentCommand`
 * handed each of them `workspace.path`. The server serialised per issue URL, so two
 * *different* issues passed every guard and spawned into one checkout — both running
 * `git checkout -b`, both committing onto whichever branch happened to be current, both
 * building into the same `dist/`. These runs are unattended, so nobody was watching.
 *
 * So the cases here are about the checkout, not about the agent: each run gets its own git
 * worktree on its own branch, the tree the board itself lives in is never touched, a run
 * that ends clean takes its worktree with it and a run that ends dirty keeps it, and the
 * number of runs allowed at once is a number somebody chose rather than "unlimited by
 * accident".
 *
 * Self-contained: it builds a throwaway git repository, writes a stub implement agent that
 * reports the directory and branch it was given, starts its own canvas servers and kills
 * them. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-parallel.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

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

/** Every checkout git knows about for this repository, the main tree included. */
function worktreePaths(projectDir) {
  return git(projectDir, ['worktree', 'list', '--porcelain']).out
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length).trim());
}

function hasWorktree(projectDir, candidate) {
  return worktreePaths(projectDir).some((known) => samePath(known, candidate));
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

const workDir = join(tmpdir(), `implement-parallel-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A real git repository, because worktrees are the thing under test. */
function makeProject(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name, repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

const projectDir = makeProject('project');
const cappedDir = makeProject('capped');

/**
 * Stands in for the implement agent, and reports the two facts these cases turn on: the
 * directory it was started in and the branch checked out there.
 *
 * It then waits to be released, so the check can look at two runs while both are live —
 * which is the whole point. `dirty-<n>` makes it leave an uncommitted file behind, the way
 * a run that failed partway through would.
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
  writeFileSync(join(workDir, 'run-' + number + '.json'),
    JSON.stringify({ cwd: process.cwd(), branch }), 'utf8');

  if (existsSync(join(workDir, 'dirty-' + number))) {
    writeFileSync(join(process.cwd(), 'unfinished-' + number + '.txt'), 'work in progress\\n', 'utf8');
  }

  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'parallel', path: projectDir.replace(/\\/g, '/') },
    { id: 'capped', path: cappedDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const running = [];

function startCanvas(port, extraEnv = {}) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      ...extraEnv,
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

const port = await freePort();
const cappedPort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const CAPPED_BASE = `http://127.0.0.1:${cappedPort}`;

async function call(base, workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const canvas = (path, options) => call(BASE, 'parallel', path, options);
const capped = (path, options) => call(CAPPED_BASE, 'capped', path, options);

const issue = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;
const start = (fn, n) => fn('/api/implement', { method: 'POST', body: JSON.stringify({ url: issue(n) }) });
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));
const started = (n) => existsSync(join(workDir, `run-${n}.json`));

async function readRecord(n) {
  return (await canvas(`/api/implement?url=${encodeURIComponent(issue(n))}`)).body?.implement ?? null;
}

async function settled(n, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const record = await readRecord(n);
    if (record?.state && record.state !== 'running') return record;
    await sleep(150);
  }
  return null;
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port);
  await waitForHealth(BASE, server.child, server.read);

  // A dirty ending for 101, a clean one for 102 — set before either starts.
  writeFileSync(join(workDir, 'dirty-101'), '', 'utf8');

  const mainBranchBefore = git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
  const mainHeadBefore = git(projectDir, ['rev-parse', 'HEAD']).out;

  console.log('1. two different issues do not share a checkout');
  const first = await start(canvas, 101);
  const second = await start(canvas, 102);
  check('the first run is accepted', first.status === 202, `got ${first.status} ${JSON.stringify(first.body)}`);
  check('the second run is accepted too', second.status === 202,
        `got ${second.status} ${JSON.stringify(second.body)} — different issues must both be able to run`);

  await waitFor(() => started(101) && started(102), 'both agents to report where they were started');
  const run101 = started(101) ? runReport(101) : { cwd: '', branch: '' };
  const run102 = started(102) ? runReport(102) : { cwd: '', branch: '' };

  check('the two runs were given different directories', !samePath(run101.cwd, run102.cwd),
        `both ran in ${run101.cwd}`);
  check('neither ran in the tree the board lives in',
        !samePath(run101.cwd, projectDir) && !samePath(run102.cwd, projectDir),
        `project=${projectDir} first=${run101.cwd} second=${run102.cwd}`);
  check('the first directory is a git worktree', hasWorktree(projectDir, run101.cwd), run101.cwd);
  check('the second directory is a git worktree', hasWorktree(projectDir, run102.cwd), run102.cwd);

  console.log('\n2. and they do not share a branch, nor disturb the original tree');
  check('the first run is on a branch of its own', Boolean(run101.branch), 'no branch reported');
  check('the two runs are on different branches', run101.branch !== run102.branch,
        `both on ${run101.branch}`);
  check('the original tree is still on the branch it started on',
        git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out === mainBranchBefore,
        `was ${mainBranchBefore}, now ${git(projectDir, ['rev-parse', '--abbrev-ref', 'HEAD']).out}`);
  check('and still at the commit it started on',
        git(projectDir, ['rev-parse', 'HEAD']).out === mainHeadBefore);
  check('and nothing was written into it',
        git(projectDir, ['status', '--porcelain']).out === '',
        git(projectDir, ['status', '--porcelain']).out);

  console.log('\n3. the same issue twice is still one run and one checkout');
  const worktreesBefore = worktreePaths(projectDir).length;
  const duplicate = await start(canvas, 101);
  check('409 for an issue already in flight', duplicate.status === 409, `got ${duplicate.status}`);
  check('no second checkout was made for it', worktreePaths(projectDir).length === worktreesBefore,
        `${worktreesBefore} before, ${worktreePaths(projectDir).length} after`);

  console.log('\n4. what is running can be listed');
  const listed = await canvas('/api/implement');
  check('200 with no url given', listed.status === 200, `got ${listed.status} ${JSON.stringify(listed.body)}`);
  const inFlight = (listed.body?.runs ?? []).filter((run) => run.state === 'running');
  check('both runs are listed while they run', inFlight.length === 2,
        JSON.stringify(listed.body?.runs));
  check('each one names its issue',
        [101, 102].every((n) => inFlight.some((run) => run.issueUrl === issue(n))),
        JSON.stringify(inFlight));

  console.log('\n5. a cap refuses the run it cannot fit, and names the one in flight');
  const cappedServer = startCanvas(cappedPort, { EXCALIDRAW_IMPLEMENT_CONCURRENCY: '1' });
  await waitForHealth(CAPPED_BASE, cappedServer.child, cappedServer.read);
  const firstCapped = await start(capped, 201);
  check('the first run fits', firstCapped.status === 202, `got ${firstCapped.status}`);
  await waitFor(() => started(201), 'the capped workspace to start its first run');
  const overflow = await start(capped, 202);
  check('409 once the cap is reached', overflow.status === 409, `got ${overflow.status}`);
  check('the refusal names the run already in flight',
        (overflow.body?.error ?? '').includes(issue(201)), overflow.body?.error);
  // Long enough that a run which was in fact accepted would have reported itself by now.
  await sleep(1500);
  check('and no checkout was made for the refused issue', !started(202), 'the refused run spawned anyway');
  release(201);

  console.log('\n6. a clean run takes its worktree with it');
  release(102);
  const clean = await settled(102);
  check('it finished', clean?.state === 'done', JSON.stringify(clean));
  check('the worktree is gone', !hasWorktree(projectDir, run102.cwd), run102.cwd);
  check('and it is not reported as kept', !clean?.worktree, clean?.worktree);
  check('the pull request survived the cleanup', /\/pull\/102$/.test(clean?.url ?? ''), clean?.url);

  console.log('\n7. a run with uncommitted work keeps its worktree, and says where');
  release(101);
  const dirty = await settled(101);
  check('it finished', dirty?.state === 'done', JSON.stringify(dirty));
  check('the worktree was kept', hasWorktree(projectDir, run101.cwd), run101.cwd);
  check('the uncommitted work is still there', existsSync(join(run101.cwd, 'unfinished-101.txt')));
  check('and the path is reported', samePath(dirty?.worktree, run101.cwd),
        `reported ${dirty?.worktree}, worktree at ${run101.cwd}`);

  console.log('\n8. nothing is left running');
  const after = await canvas('/api/implement');
  check('no run is in flight any more',
        (after.body?.runs ?? []).every((run) => run.state !== 'running'),
        JSON.stringify(after.body?.runs));
} finally {
  for (const n of [101, 102, 201, 202]) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
  stopAll();
  await sleep(200);
  for (const dir of [projectDir, cappedDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
