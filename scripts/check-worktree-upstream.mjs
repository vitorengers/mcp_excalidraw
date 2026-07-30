#!/usr/bin/env node
/**
 * Checks that the branch a worktree is cut on is not left tracking the default branch.
 *
 * `ensureWorktree` cuts from `origin/HEAD`, and `git worktree add -b issue-N <path> origin/main`
 * takes that remote-tracking start point as an upstream to configure. It writes
 * `branch.issue-N.remote = origin` and `branch.issue-N.merge = refs/heads/main`, so the upstream
 * of the feature branch is **`main`** — a branch nobody intends to push to from a worktree and
 * nobody intends to pull from into one.
 *
 * The visible harm is `git pull`. Run in such a worktree before the agent's first push, it
 * fast-forwards the feature branch onto whatever the default branch has gained since — silently,
 * because that is exactly what a correct upstream would mean. Four agents implementing four
 * issues at once, each pulling in the others' merges, is not a hypothetical here.
 *
 * The upstream an agent actually wants is written by its own first `git push -u origin issue-N`,
 * which is why the fix is to write none at all rather than to write a different one: a branch
 * with no upstream is a branch whose first push decides it, and `git worktree add --no-track`
 * writes no branch config whatsoever. That it also stops the server taking `.git/config.lock`
 * is measured by `scripts/check-worktree-config-lock.mjs`, not here.
 *
 * So this checks both halves the issue names: the state the worktree is handed over in, and
 * what the agent's first push then does with it.
 *
 * Usage: node scripts/check-worktree-upstream.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const distPath = join(repoRoot, 'dist', 'core', 'implement-worktree.js');
if (!existsSync(distPath)) {
  console.error('  FAIL  the worktree module exists — run tsc first');
  process.exit(1);
}
const { ensureWorktree, worktreeRoot } = await import(pathToFileURL(distPath).href);

const workDir = join(tmpdir(), 'worktree-upstream-check');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const originDir = join(workDir, 'origin.git');
const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });

/** Run git and let a failure through, because several cases here are about one failing. */
function run(args, cwd = projectDir) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

function git(args, cwd = projectDir) {
  const result = run(args, cwd);
  if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

// A repository that pushes to a remote, so its default branch has a remote-tracking ref —
// which is the whole reason `worktree add` configures an upstream at all.
git(['init', '-q', '--bare', 'origin.git'], workDir);
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'check@example.com']);
git(['config', 'user.name', 'Check']);
// Pinned rather than inherited: the bare-push case below is about what `simple` does, and the
// machine running this check may well have chosen something else.
git(['config', 'push.default', 'simple']);
writeFileSync(join(projectDir, 'package.json'), '{"name":"upstream-check"}', 'utf8');
git(['add', '.']);
git(['commit', '-qm', 'first']);
git(['remote', 'add', 'origin', originDir.replace(/\\/g, '/')]);
git(['push', '-q', '-u', 'origin', 'main']);
git(['remote', 'set-head', 'origin', 'main']);

const workspace = {
  id: 'upstream-check',
  name: 'Upstream Check',
  path: projectDir,
  innerPath: projectDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

const issue = (number) => `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`;
const worktreePath = (number) => join(worktreeRoot(workspace).path, `issue-${number}`);

const configOf = (branch, key) => run(['config', '--get', `branch.${branch}.${key}`]).stdout;
const upstreamOf = (branch) => run(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]).stdout;

/** Move the default branch on, the way another implementation merging would. */
function advanceMain(marker) {
  writeFileSync(join(projectDir, `${marker}.txt`), marker, 'utf8');
  git(['add', '.']);
  git(['commit', '-qm', marker]);
  git(['push', '-q', 'origin', 'main']);
  return git(['rev-parse', 'HEAD']);
}

const contains = (commit, cwd) => run(['merge-base', '--is-ancestor', commit, 'HEAD'], cwd).ok;

try {
  console.log('0. the fixture is one where the old form configured an upstream');
  check('the base is a remote-tracking ref',
        git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) === 'origin/main',
        'cut from a local branch, worktree add tracks nothing and this check proves nothing');

  console.log('\n1. a fresh worktree branch is not left tracking the default branch');
  const worktree = await ensureWorktree(workspace, issue(201));
  check('the worktree was created', Boolean(worktree) && existsSync(worktreePath(201)));
  check('on its own branch', worktree?.branch === 'issue-201', `branch was ${worktree?.branch}`);
  const merge = configOf('issue-201', 'merge');
  check('and its upstream is not main', merge !== 'refs/heads/main',
        `branch.issue-201.merge is ${merge || 'unset'}`);
  check('it is either unset or the branch itself',
        merge === '' || merge === 'refs/heads/issue-201',
        `branch.issue-201.merge is ${merge}`);
  check('and remote is consistent with it',
        merge === '' ? configOf('issue-201', 'remote') === '' : configOf('issue-201', 'remote') === 'origin',
        `branch.issue-201.remote is ${configOf('issue-201', 'remote') || 'unset'}`);
  check('git agrees the branch has no upstream pointing elsewhere',
        upstreamOf('issue-201') !== 'origin/main', `upstream is ${upstreamOf('issue-201')}`);

  console.log('\n2. before the first push, a pull does not drag main into the feature branch');
  const mainCommit = advanceMain('while-the-agent-worked');
  const pulled = run(['pull'], worktreePath(201));
  check('the feature branch did not gain main\'s commit', !contains(mainCommit, worktreePath(201)),
        pulled.ok ? 'git pull fast-forwarded it onto main' : 'it arrived some other way');
  check('and the worktree is still on its own branch',
        run(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath(201)).stdout === 'issue-201');

  console.log('\n3. the agent\'s first push sets the upstream, and it is the right one');
  writeFileSync(join(worktreePath(201), 'work.txt'), 'the change', 'utf8');
  git(['add', '.'], worktreePath(201));
  git(['commit', '-qm', 'the change'], worktreePath(201));
  const firstPush = run(['push', '-u', 'origin', 'issue-201'], worktreePath(201));
  check('git push -u succeeded', firstPush.ok, firstPush.stderr);
  check('the upstream now names the branch itself',
        configOf('issue-201', 'merge') === 'refs/heads/issue-201',
        `branch.issue-201.merge is ${configOf('issue-201', 'merge') || 'unset'}`);
  check('on origin', configOf('issue-201', 'remote') === 'origin',
        `branch.issue-201.remote is ${configOf('issue-201', 'remote') || 'unset'}`);
  check('and the remote has the branch',
        run(['rev-parse', '--verify', 'refs/heads/issue-201'], originDir).ok);

  console.log('\n4. after it, a bare push and pull are about the feature branch');
  writeFileSync(join(worktreePath(201), 'work.txt'), 'more of the change', 'utf8');
  git(['add', '.'], worktreePath(201));
  git(['commit', '-qm', 'more'], worktreePath(201));
  const barePush = run(['push'], worktreePath(201));
  // `push.default=simple` refuses a branch whose upstream is named differently from it, which
  // is precisely what the old configuration left behind.
  check('a bare git push is accepted', barePush.ok, barePush.stderr);
  const pushedTip = git(['rev-parse', 'HEAD'], worktreePath(201));
  check('and the remote branch has the new commit',
        git(['rev-parse', 'refs/heads/issue-201'], originDir) === pushedTip);
  const laterMain = advanceMain('after-the-first-push');
  run(['pull'], worktreePath(201));
  check('a pull still does not bring main in', !contains(laterMain, worktreePath(201)));

  console.log('\n5. reusing a branch that already exists adds no upstream either');
  // `git branch <name> <remote-ref>` would set tracking itself, which is not what is under
  // test here; the branch is made the way a run that was interrupted would have left one.
  git(['branch', '--no-track', 'issue-202', 'origin/main']);
  const reused = await ensureWorktree(workspace, issue(202));
  check('the worktree was created on it', reused?.branch === 'issue-202'
        && existsSync(worktreePath(202)), `branch was ${reused?.branch}`);
  check('and checking it out configured no upstream',
        configOf('issue-202', 'merge') === '' && configOf('issue-202', 'remote') === '',
        `branch.issue-202.merge is ${configOf('issue-202', 'merge') || 'unset'}`);
} finally {
  // Every worktree lives under workDir, so the repository goes with them.
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
