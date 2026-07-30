#!/usr/bin/env node
/**
 * Checks that a worktree is still created when someone else holds `.git/config.lock`.
 *
 * Every worktree shares the main repository's `.git/config` — git keeps a per-worktree one
 * only when `extensions.worktreeConfig` is set, and this repository does not set it. The
 * branch is cut from `origin/HEAD`, and while `git worktree add` set up upstream tracking from
 * that remote-tracking start point it wrote `branch.<name>.remote` and `branch.<name>.merge`
 * into the shared file, taking `.git/config.lock` to do it. Git neither waits on that lock nor
 * retries: it fails immediately with `File exists`. Two implementations started in the same
 * second, and one of them died before its agent was ever spawned.
 *
 * There are two answers to that, and they are not alternatives, so this covers both.
 * `--no-track` (#114) stops this call writing branch config at all, so it no longer contends
 * for the lock on its own account — which is why a held lock is now survived outright rather
 * than waited out. The wait (#113) stays for the contention that is *not* ours: every agent
 * working in a worktree eventually runs `git push -u`, which writes those same two keys into
 * that same shared file, and the server cannot serialise a process it does not own. That
 * writer cannot be provoked from here, so the wait is asserted on the source — the same way
 * section 4 asserts what the queue encloses, and for the same reason.
 *
 * A race is not worth hoping to catch, so the lock is held deliberately: create
 * `.git/config.lock`, call `ensureWorktree`, and the worktree has to be there — with the lock
 * still held when it comes back, not merely released in time.
 *
 * The fixture needs a *remote-tracking* base, because that is what made `worktree add` write
 * config in the first place — a bare `origin`, and a clone with `origin/HEAD` set. Cut from a
 * local branch there would have been nothing to configure and no lock taken either way, so
 * that precondition is asserted first.
 *
 * Usage: node scripts/check-worktree-config-lock.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const workDir = join(tmpdir(), 'worktree-config-lock-check');
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const originDir = join(workDir, 'origin.git');
const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });

function git(args, cwd = projectDir) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

// A repository that pushes to a remote, so its default branch has a remote-tracking ref.
git(['init', '-q', '--bare', 'origin.git'], workDir);
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'check@example.com']);
git(['config', 'user.name', 'Check']);
writeFileSync(join(projectDir, 'package.json'), '{"name":"config-lock-check"}', 'utf8');
git(['add', '.']);
git(['commit', '-qm', 'first']);
git(['remote', 'add', 'origin', originDir.replace(/\\/g, '/')]);
git(['push', '-q', '-u', 'origin', 'main']);
git(['remote', 'set-head', 'origin', 'main']);

const workspace = {
  id: 'config-lock-check',
  name: 'Config Lock Check',
  path: projectDir,
  innerPath: projectDir.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

const issue = (number) => `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`;
const worktreePath = (number) => join(worktreeRoot(workspace).path, `issue-${number}`);
const lockFile = join(projectDir, '.git', 'config.lock');

function worktreeIsCheckedOut(number) {
  const wanted = worktreePath(number).replace(/\\/g, '/').toLowerCase();
  return git(['worktree', 'list', '--porcelain']).split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => line.slice('worktree '.length).trim().replace(/\\/g, '/').toLowerCase() === wanted);
}

try {
  const source = readFileSync(join(repoRoot, 'src', 'core', 'implement-worktree.ts'), 'utf8');

  console.log('0. the fixture is one where worktree add wrote config at all');
  check('the base is a remote-tracking ref',
        git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) === 'origin/main',
        'without one there was never an upstream to configure, and this check proves nothing');

  console.log('\n1. a lock held by someone else does not stop a worktree being created');
  writeFileSync(lockFile, '', 'utf8');
  let worktree = null;
  let failure = null;
  try { worktree = await ensureWorktree(workspace, issue(101)); } catch (error) { failure = error; }
  const heldThroughout = existsSync(lockFile);
  rmSync(lockFile, { force: true });

  check('the worktree was created', Boolean(worktree),
        failure ? failure.message : 'ensureWorktree returned nothing');
  check('git agrees it is checked out', Boolean(worktree) && worktreeIsCheckedOut(101));
  check('on its own branch', worktree?.branch === 'issue-101', `branch was ${worktree?.branch}`);
  check('with the lock held throughout, not released into a retry', heldThroughout,
        'the lock went away by itself, so nothing here was under contention');
  // And the reason it could not collide: there was nothing for it to write. The upstream is
  // the agent's own first `git push -u` to set — scripts/check-worktree-upstream.mjs covers
  // that half.
  const tracking = spawnSync('git', ['config', '--get', 'branch.issue-101.merge'],
                             { cwd: projectDir, encoding: 'utf8' }).stdout.trim();
  check('because it wrote no branch config to contend over', tracking === '',
        `branch.issue-101.merge is ${tracking}`);

  console.log('\n2. a lock nobody releases is survived too, and the wait stays for other writers');
  writeFileSync(lockFile, '', 'utf8');
  let stuck = null;
  let survived = null;
  try { survived = await ensureWorktree(workspace, issue(102)); } catch (error) { stuck = error; }
  rmSync(lockFile, { force: true });
  check('the worktree was created anyway', Boolean(survived),
        stuck ? stuck.message : 'ensureWorktree returned nothing');
  check('and git agrees it is checked out', Boolean(survived) && worktreeIsCheckedOut(102));
  // The writers this cannot provoke are the ones the wait is for: an agent's `git push -u`
  // takes this same lock from a process the server does not own. Removing the wait because
  // our own call stopped needing it would drop that case silently, so it is pinned here.
  check('the wait for a lock that is not ours is still in the code',
        /CONFIG_LOCK_WAIT_MS/.test(source) && /lostTheConfigLock\(attempt\)/.test(source),
        'the retry loop in addWorktree is gone');
  check('and a lock it does give up on is still named in the failure',
        /config\.lock was still held/.test(source), 'the error no longer names the lock file');

  console.log('\n3. several implementations starting at once all get their worktrees');
  writeFileSync(lockFile, '', 'utf8');
  const numbers = [103, 104, 105, 106];
  const settled = await Promise.allSettled(numbers.map((number) => ensureWorktree(workspace, issue(number))));
  rmSync(lockFile, { force: true });
  for (const [index, result] of settled.entries()) {
    const number = numbers[index];
    check(`issue-${number} got its worktree and git agrees`,
          result.status === 'fulfilled' && Boolean(result.value) && worktreeIsCheckedOut(number),
          result.status === 'rejected' ? result.reason?.message : 'ensureWorktree returned nothing');
  }
  // Two processes rewriting one config file at once leave a file git can no longer parse.
  const readable = spawnSync('git', ['config', '--list'], { cwd: projectDir, encoding: 'utf8' });
  check('the shared config is still readable', readable.status === 0, readable.stderr);
  const half = numbers.filter((number) => {
    const get = (key) => spawnSync('git', ['config', '--get', `branch.issue-${number}.${key}`],
                                   { cwd: projectDir, encoding: 'utf8' }).stdout.trim();
    return Boolean(get('remote')) !== Boolean(get('merge'));
  });
  check('and no branch was left half-configured', half.length === 0,
        `issue-${half.join(', issue-')} has one tracking key and not the other`);

  console.log('\n4. linking the dependencies is not serialised with the git call');
  // Asserted on the source rather than by observation, and the reason is worth stating:
  // `linkDependencies` is synchronous on the native path — twenty thousand `fs.linkSync`
  // calls — so it blocks the event loop and two worktrees can never be *seen* linking at the
  // same instant however the lock is scoped. What is checkable is what the lock encloses,
  // and that is the decision being protected: the queue must not make one run wait out
  // another run's dependencies.
  const serialised = source.indexOf('serialiseWorktreeAdd(workspace.path');
  const linking = source.indexOf('await linkDependencies(');
  check('the git call is behind a queue', serialised !== -1,
        'no serialiseWorktreeAdd(workspace.path, ...) call found');
  check('and the dependencies are linked after it, outside the queue',
        serialised !== -1 && linking > serialised
          && !source.slice(serialised, source.indexOf('\n', serialised)).includes('linkDependencies'),
        'linkDependencies is inside the serialised call');
} finally {
  // Every worktree lives under workDir, so the repository goes with them.
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
