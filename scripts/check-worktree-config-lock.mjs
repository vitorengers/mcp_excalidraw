#!/usr/bin/env node
/**
 * Checks that a worktree is still created when someone else holds `.git/config.lock`.
 *
 * Every worktree shares the main repository's `.git/config` — git keeps a per-worktree one
 * only when `extensions.worktreeConfig` is set, and this repository does not set it. The
 * branch is cut from `origin/HEAD`, so `git worktree add` sets up upstream tracking, which
 * writes `branch.<name>.remote` and `branch.<name>.merge` and takes `.git/config.lock` to do
 * it. Git neither waits on that lock nor retries: it fails immediately with `File exists`.
 * Two implementations started in the same second, and one of them died before its agent was
 * ever spawned.
 *
 * A race is not worth hoping to catch, so the lock is held deliberately: create
 * `.git/config.lock`, call `ensureWorktree`, release the lock a moment later, and the
 * worktree has to be there. The old code gives up on the first attempt and throws.
 *
 * The fixture needs a *remote-tracking* base, because that is the whole reason `worktree add`
 * writes config at all — a bare `origin`, and a clone with `origin/HEAD` set. Cut from a local
 * branch it would take no lock and prove nothing, so that precondition is asserted first.
 *
 * The lock is held for longer than it takes git to fail, on purpose: `ensureWorktree` spends a
 * few hundred milliseconds on `worktree list`, `show-ref` and `symbolic-ref` before it ever
 * reaches the call that takes the lock, and a lock released inside that window is a lock the
 * old code never collides with.
 *
 * Usage: node scripts/check-worktree-config-lock.mjs
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longer than the git calls `ensureWorktree` makes before the one that takes the lock. */
const HOLD_MS = 800;

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
  console.log('0. the fixture takes the lock at all');
  check('the base is a remote-tracking ref',
        git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']) === 'origin/main',
        'without one, worktree add never writes config and this check proves nothing');

  console.log('\n1. a lock held by someone else is waited out, not given up on');
  writeFileSync(lockFile, '', 'utf8');
  const started = Date.now();
  const creating = ensureWorktree(workspace, issue(101));
  const releasing = delay(HOLD_MS).then(() => rmSync(lockFile, { force: true }));
  let worktree = null;
  let failure = null;
  try { worktree = await creating; } catch (error) { failure = error; }
  await releasing;
  const waited = Date.now() - started;

  check('the worktree was created', Boolean(worktree),
        failure ? failure.message : 'ensureWorktree returned nothing');
  check('git agrees it is checked out', Boolean(worktree) && worktreeIsCheckedOut(101));
  check('on its own branch', worktree?.branch === 'issue-101', `branch was ${worktree?.branch}`);
  check('and it waited for the lock rather than racing past it', waited >= HOLD_MS, `${waited}ms`);
  // The retry is a true re-run, not a fallback that quietly drops what the failure lost.
  const tracking = spawnSync('git', ['config', '--get', 'branch.issue-101.merge'],
                             { cwd: projectDir, encoding: 'utf8' }).stdout.trim();
  check('with the upstream the failed attempt could not write', tracking === 'refs/heads/main',
        `branch.issue-101.merge is ${tracking || 'unset'}`);

  console.log('\n2. a lock nobody releases fails, bounded, and names the lock');
  writeFileSync(lockFile, '', 'utf8');
  const stuckAt = Date.now();
  let stuck = null;
  try {
    await ensureWorktree(workspace, issue(102));
  } catch (error) {
    stuck = error;
  }
  const gaveUpAfter = Date.now() - stuckAt;
  check('it refused to create the worktree', Boolean(stuck), 'it somehow succeeded with the lock held');
  check('having actually retried first', gaveUpAfter >= 1000, `gave up after ${gaveUpAfter}ms`);
  check('but bounded, not forever', gaveUpAfter < 15000, `${gaveUpAfter}ms`);
  check('and the reason names the lock file', /config\.lock/.test(stuck?.message ?? ''),
        `message was: ${stuck?.message}`);
  rmSync(lockFile, { force: true });

  console.log('\n3. several implementations starting at once all get their worktrees');
  writeFileSync(lockFile, '', 'utf8');
  const numbers = [103, 104, 105, 106];
  const together = numbers.map((number) => ensureWorktree(workspace, issue(number)));
  const releasingAgain = delay(HOLD_MS).then(() => rmSync(lockFile, { force: true }));
  const settled = await Promise.allSettled(together);
  await releasingAgain;
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
  const source = readFileSync(join(repoRoot, 'src', 'core', 'implement-worktree.ts'), 'utf8');
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
