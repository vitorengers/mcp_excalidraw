#!/usr/bin/env node
/**
 * Checks that a run the account cannot push is refused before anything is created.
 *
 * Nothing on the way into an implementation ever asked whether the account behind `gh` can
 * push. `addWorktree` deliberately writes no upstream, the prompt makes `git push -u origin
 * issue-N` and the pull request the agent's own, and `releaseWorktree` removes the branch with
 * `git branch -d`, which only succeeds on a merged one. So a reader who *cloned* this
 * repository rather than forking it got a run that investigated, built and verified for as long
 * as it took, failed at the push, and reported `Agent finished without returning a pull request
 * URL` with 600 characters of tail. The worktree kept the commits, `releaseWorktree` was never
 * reached, and every subsequent server start reported the run as interrupted — a state only a
 * person can settle, by finishing or discarding the checkout by hand.
 *
 * The guard is one `gh repo view --json viewerPermission` against the repository `origin`
 * names, asked before `ensureWorktree`, so a refusal leaves nothing behind to clean up.
 *
 * The cases here are therefore about the two directions and the ditch between them:
 *
 *  - `READ` refuses, gives the slot back, names forking, and creates no directory;
 *  - `WRITE` starts the run exactly as it did before this existed;
 *  - and a `gh` that *cannot say* — one that fails, and one too old to know the field — must
 *    let the run through. A probe that blocks on its own failure would take implementing away
 *    from every board whose GitHub is merely having a bad minute, which is a far larger defect
 *    than the one it guards.
 *
 * The last two cases are what stops the probe becoming per run: two starts on one workspace
 * spawn one `gh`, because the answer sits behind the same memo the GitHub status uses.
 *
 * Self-contained: it builds throwaway git projects with `origin` remotes it invents, writes a
 * stub `gh` and a stub implement agent, starts its own canvas server on a free port and kills
 * it. Nothing here talks to GitHub and nothing runs a real coding agent. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-no-push.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

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

const workDir = join(tmpdir(), `implement-no-push-${process.pid}`);
const stubGhPath = join(workDir, 'stub-gh.mjs');
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');
const ghLogPath = join(workDir, 'gh-calls.log');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/**
 * One board per answer `gh` can give about a repository.
 *
 * Each is a real git repository with an `origin` of its own, because the probe reads the
 * remote rather than the configured `repo`: what a run pushes to is `origin`, and a fork's
 * `board.config.json` names the repository the *issues* live in.
 */
const BOARDS = [
  { id: 'readonly', origin: 'https://github.com/someone/read-only.git' },
  { id: 'writable', origin: 'git@github.com:someone/writable.git' },
  { id: 'no-answer', origin: 'https://github.com/someone/no-answer.git' },
  { id: 'old-gh', origin: 'https://github.com/someone/old-gh.git' },
  { id: 'elsewhere', origin: 'https://gitlab.com/someone/elsewhere.git' },
];

function makeProject({ id, origin }) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  // No `githubProject`, so nothing here moves a card and the only `gh` the run makes is the
  // probe this check is about.
  writeFileSync(join(dir, 'board.config.json'),
                JSON.stringify({ name: id, repo: 'someone/read-only' }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${id}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  git(dir, ['remote', 'add', 'origin', origin]);
  return dir;
}

const projectDir = Object.fromEntries(BOARDS.map((board) => [board.id, makeProject(board)]));

/**
 * A `gh` that answers about a repository by name, and logs every call.
 *
 * `no-answer` is a `gh` that failed — the shape a network blip or a repository the account
 * cannot see arrives in. `old-gh` is the risk the issue names: a CLI that does not know the
 * field, which prints exactly this and exits non-zero.
 */
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');

if (args[0] === 'repo' && args[1] === 'view') {
  const repo = args[2] ?? '';
  if (repo === 'someone/read-only') {
    process.stdout.write(JSON.stringify({ viewerPermission: 'READ' }) + '\\n');
    process.exit(0);
  }
  if (repo === 'someone/writable') {
    process.stdout.write(JSON.stringify({ viewerPermission: 'WRITE' }) + '\\n');
    process.exit(0);
  }
  if (repo === 'someone/old-gh') {
    process.stderr.write('unknown JSON field: "viewerPermission"\\n');
    process.exit(1);
  }
  process.stderr.write('dial tcp: lookup api.github.com: no such host\\n');
  process.exit(1);
}

if (args[0] === 'pr' && args[1] === 'view') {
  // What lib/gh-unstubbed.mjs answers: well-formed, and saying nothing about the pull request
  // the stub agent invented. Nothing here is about what became of it.
  process.stdout.write('{}\\n');
  process.exit(0);
}

process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
process.exit(1);
`, 'utf8');

/**
 * Stands in for the implement agent. It records that it was started and parks, so a run that
 * was allowed is still in flight while its worktree is looked at.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({ cwd: process.cwd() }), 'utf8');

  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/someone/writable/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(ghLogPath, '', 'utf8');
writeFileSync(registryPath, JSON.stringify({
  workspaces: BOARDS.map((board) => ({
    id: board.id,
    path: projectDir[board.id].replace(/\\/g, '/'),
  })),
}), 'utf8');

// ─── The server ───────────────────────────────────────────────

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

const server = spawnCanvas({
  port,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
    // Above the number of runs this check has in flight at once, so nothing here is ever
    // refused by the cap and mistaken for the guard.
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '8',
    STUB_GH_LOG: ghLogPath,
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

const issue = (n) => `https://github.com/someone/read-only/issues/${n}`;
const start = (workspace, n) =>
  call(workspace, '/api/implement', { method: 'POST', body: JSON.stringify({ url: issue(n) }) });
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const agentStarted = (n) => existsSync(join(workDir, `run-${n}.json`));

/** Where `ensureWorktree` would put a checkout for this issue: a sibling of the project. */
const worktreeRootOf = (id) => join(workDir, `${id}-worktrees`);
const worktreeOf = (id, n) => join(worktreeRootOf(id), `issue-${n}`);

/** Every `gh repo view` the server has made so far, in order. */
function repoViews() {
  return readFileSync(ghLogPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((args) => args[0] === 'repo' && args[1] === 'view');
}

async function inFlight(workspace) {
  const listed = await call(workspace, '/api/implement');
  return (listed.body?.runs ?? []).filter((run) => run.state === 'running');
}

/**
 * Every issue this check starts a run for, refused or not.
 *
 * The refused ones are in the list on purpose: a run that was *meant* to be refused and was
 * not has an agent parked on it for a minute, and a check that only released the runs it
 * expected would leave those behind for its own cleanup to trip over.
 */
const STARTED = [101, 102, 201, 301, 401, 501];

try {
  await waitForHealth();

  console.log('1. an account with READ is refused, and nothing is created');
  const refused = await start('readonly', 101);
  check('the request is refused rather than accepted', refused.status !== 202,
        `got ${refused.status} ${JSON.stringify(refused.body)}`);
  check('with 403, which is what a permission this board cannot change is',
        refused.status === 403, `got ${refused.status}`);
  const said = String(refused.body?.error ?? '');
  check('the refusal names forking as the remedy', /\bfork/i.test(said), said || '(no error)');
  check('and names the repository it asked about', said.includes('someone/read-only'), said);
  check('and the permission it was told', /\bREAD\b/.test(said), said);
  // Long enough that a run which was in fact accepted would have cut its checkout by now: the
  // allowed run in case 3 reaches the agent in well under this, and the worktree is there
  // before the agent is. Without the wait, "nothing was created" is only true because nothing
  // has happened yet — which it is on the code this check was written against.
  await sleep(1500);
  check('no worktree directory was created',
        !existsSync(worktreeOf('readonly', 101)) && !existsSync(worktreeRootOf('readonly')),
        `${worktreeRootOf('readonly')} exists`);
  check('no agent was spawned', !agentStarted(101));
  check('and nothing is left running on that board', (await inFlight('readonly')).length === 0,
        JSON.stringify(await inFlight('readonly')));

  console.log('\n2. the refusal gives its slot back, and asks gh once');
  const again = await start('readonly', 102);
  check('a second attempt is refused the same way, not by the cap', again.status === 403,
        `got ${again.status} ${JSON.stringify(again.body)}`);
  check('and the probe sits behind the memo: one gh for two starts',
        repoViews().filter((args) => args[2] === 'someone/read-only').length === 1,
        JSON.stringify(repoViews()));

  console.log('\n3. an account with WRITE starts the run exactly as before');
  const allowed = await start('writable', 201);
  check('the request is accepted', allowed.status === 202,
        `got ${allowed.status} ${JSON.stringify(allowed.body)}`);
  await waitFor(() => agentStarted(201), 'the allowed run to reach the agent');
  check('the worktree was created', existsSync(worktreeOf('writable', 201)),
        `${worktreeOf('writable', 201)} is missing`);
  check('and the server reports it running', (await inFlight('writable')).length === 1,
        JSON.stringify(await inFlight('writable')));

  console.log('\n4. a gh that cannot say lets the run through');
  const blip = await start('no-answer', 301);
  check('a failing probe does not block a run', blip.status === 202,
        `got ${blip.status} ${JSON.stringify(blip.body)}`);
  const old = await start('old-gh', 401);
  check('nor does a gh too old to know the field', old.status === 202,
        `got ${old.status} ${JSON.stringify(old.body)}`);
  await waitFor(() => agentStarted(301) && agentStarted(401), 'both degraded runs to start');
  check('and the failing probe was asked once, not retried three times',
        repoViews().filter((args) => args[2] === 'someone/no-answer').length === 1,
        JSON.stringify(repoViews().filter((args) => args[2] === 'someone/no-answer')));

  console.log('\n5. a project whose origin is not on github.com is never asked about');
  const elsewhere = await start('elsewhere', 501);
  check('the run starts', elsewhere.status === 202,
        `got ${elsewhere.status} ${JSON.stringify(elsewhere.body)}`);
  await waitFor(() => agentStarted(501), 'the run on a non-GitHub origin to start');
  check('and no repo view was made for it',
        repoViews().every((args) => !String(args[2] ?? '').includes('elsewhere')),
        JSON.stringify(repoViews()));
} finally {
  for (const n of STARTED) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(600);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
  await sleep(200);
  for (const dir of Object.values(projectDir)) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
