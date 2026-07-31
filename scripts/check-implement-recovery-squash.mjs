#!/usr/bin/env node
/**
 * Checks that a worktree whose pull request was squash-merged stops reporting as an
 * interrupted run.
 *
 * `worktreesHoldingWork` counted commits with `rev-list --count base..HEAD`, which asks whether
 * the branch's commits are reachable from the base. This repository squash-merges every pull
 * request, so the base gets one new commit with a new hash and the originals are never
 * reachable — a checkout left behind by a run that finished perfectly counted its commits
 * forever, and every restart announced it as interrupted. On this machine `issue-96` reported 6
 * commits two days after PR #106 landed its content as `75409d2`.
 *
 * That matters because the warning has one job: rescuing work that really was stranded — the
 * 377 uncommitted lines `implement-recovery.ts` was written for. A message that also fires for
 * every tidy merge is a message the operator learns to skip.
 *
 * So the question the counts have to answer is "is this work in the base", not "are these
 * commits in the base". Under squash merge those differ, and only the first one is the one
 * anybody acts on.
 *
 * Self-contained, in the shape of `check-implement-resume.mjs`: throwaway git repositories,
 * real worktrees, real merges. No server, no network, nothing that touches this repository.
 * Run `./node_modules/.bin/tsc` first — it reads the compiled module.
 *
 * Usage: node scripts/check-implement-recovery-squash.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

// ─── The throwaway world ──────────────────────────────────────

// Not named after this check: the paths end up inside the worktree names the module reads,
// and a directory called `…-squash-…` could satisfy an assertion without the feature existing.
const workDir = join(tmpdir(), `recovery-merged-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const REPO = 'vitorengers/vibemaxxing';

/** A real git repository — worktrees and merges are the thing detection reads. */
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

/** The workspace shape `worktreesHoldingWork` reads: where the project is, and how to run git. */
function workspaceFor(dir, id) {
  return {
    id,
    path: dir,
    innerPath: dir.replace(/\\/g, '/'),
    environment: { kind: 'native' },
    repo: REPO,
  };
}

/**
 * A checkout the way the server makes them: `<project>-worktrees/issue-<n>`, its own branch,
 * with `commitCount` commits of real work on it.
 */
function makeRun(projectDir, issueNumber, commitCount) {
  const name = `issue-${issueNumber}`;
  const root = `${projectDir}-worktrees`;
  const dir = join(root, name);
  mkdirSync(root, { recursive: true });
  git(projectDir, ['worktree', 'add', '-b', name, dir, 'main']);
  for (let n = 1; n <= commitCount; n++) {
    writeFileSync(join(dir, `feature-${issueNumber}-${n}.txt`), `work ${n}\n`, 'utf8');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-m', `${name} step ${n}`]);
  }
  return dir;
}

const held = async (workspace) => {
  const module = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'implement-worktree.js')).href
  );
  return module.worktreesHoldingWork(workspace);
};

// ─── The defect: squash-merged, clean, and still reported ─────

console.log('\nA squash-merged checkout, left behind');

{
  const project = makeProject('squashed');
  const run = makeRun(project, 96, 3);

  // How this repository merges: one new commit on main carrying the whole branch, originals
  // never reachable from it. `CLAUDE.md` — "Merge it yourself — squash, delete the branch."
  git(project, ['merge', '--squash', 'issue-96']);
  git(project, ['commit', '-m', 'Anchor the terminal to the left of the mirror (#106)']);

  const ahead = git(run, ['rev-list', '--count', 'main..HEAD']).out;
  check('the branch really is unreachable from main, so the case is the real one',
    ahead === '3', `rev-list counted ${ahead}`);

  const workspace = workspaceFor(project, 'squashed');
  const result = await held(workspace);
  check('a squash-merged checkout with a clean tree holds nothing',
    result.length === 0,
    `reported ${result.length}: ${result.map((w) => `${w.name} (${w.commits} commit(s))`).join(', ')}`);
}

// ─── What must keep reporting ─────────────────────────────────

console.log('\nWhat still holds work');

{
  const project = makeProject('squashed-dirty');
  const run = makeRun(project, 97, 2);
  git(project, ['merge', '--squash', 'issue-97']);
  git(project, ['commit', '-m', 'merged (#107)']);

  // Merged, but somebody left changes in the checkout afterwards. The work is there whatever
  // the history says.
  writeFileSync(join(run, 'unfinished.txt'), 'half a thought\n', 'utf8');

  const result = await held(workspaceFor(project, 'squashed-dirty'));
  check('a squash-merged checkout with a dirty tree still holds work',
    result.length === 1 && result[0].changes === 1,
    `reported ${result.length}` + (result[0] ? ` with ${result[0].changes} change(s)` : ''));
}

{
  const project = makeProject('unmerged');
  makeRun(project, 98, 4);

  const result = await held(workspaceFor(project, 'unmerged'));
  check('a checkout genuinely ahead of the base still holds work',
    result.length === 1 && result[0].commits === 4,
    `reported ${result.length}` + (result[0] ? ` with ${result[0].commits} commit(s)` : ''));
}

// ─── What already worked, and must not regress ────────────────

console.log('\nWhat already worked');

{
  const project = makeProject('merged-no-ff');
  makeRun(project, 99, 2);
  git(project, ['merge', '--no-ff', 'issue-99', '-m', 'merge issue-99']);

  const result = await held(workspaceFor(project, 'merged-no-ff'));
  check('a normally merged checkout holds nothing',
    result.length === 0,
    `reported ${result.length}`);
}

{
  const project = makeProject('untouched');
  makeRun(project, 100, 0);

  const result = await held(workspaceFor(project, 'untouched'));
  check('a checkout with nothing ahead and a clean tree holds nothing',
    result.length === 0,
    `reported ${result.length}`);
}

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
