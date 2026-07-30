#!/usr/bin/env node
/**
 * Checks what a run is told when its branch is already checked out somewhere else.
 *
 * Git refuses to check one branch out in two places, and is right to — two checkouts of one
 * branch diverge with nothing to reconcile them. But the state it refuses on is reachable
 * here: the board's terminal opens a shell at the *workspace root*, which is the project's
 * own checkout, so a session started there works on the repository directly. One that
 * switches to `issue-155` and does not switch back leaves the project sitting on it, and
 * every later click answers:
 *
 *     Could not create a worktree at …-worktrees\issue-155: Preparing worktree
 *     (checking out 'issue-155') fatal: 'issue-155' is already used by worktree at
 *     'C:/Users/vtr_d/Documents/Projects/mcp_excalidraw'
 *
 * The path in that sentence is the project itself, labelled "worktree". Nothing says which
 * `git switch` would free it, and nothing on the board says a repository needs one.
 *
 * `ensureWorktree` could not see it coming: `show-ref` answers whether a branch exists, never
 * where it is checked out, so the one state that makes creation impossible was the one state
 * not tested for.
 *
 * Four sections:
 *
 * 1. **The project's own checkout holding the branch.** The reported case. The refusal has to
 *    name the directory, say it is the project rather than a worktree, and give the command.
 * 2. **Another worktree holding it.** Reachable through the same code path and a different
 *    situation — a run for that issue is already set up — so it gets a different sentence.
 * 3. **Nothing holding it.** Both the fresh-branch and the existing-branch paths still work;
 *    this is the case a detector that refuses too eagerly would break.
 * 4. **This issue's own worktree.** Reuse comes first and must keep coming first, since that
 *    is what makes a retry after an interrupted run land in the work already done.
 *
 * Self-contained: builds a throwaway repository, runs no server and reaches no network.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-worktree-branch-held.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const { ensureWorktree } = await importDist(join('core', 'implement-worktree.js'), 'the worktree maker');

const root = join(tmpdir(), 'worktree-branch-held-check');
rmSync(root, { recursive: true, force: true, maxRetries: 3 });
mkdirSync(root, { recursive: true });

const project = join(root, 'project');
mkdirSync(project, { recursive: true });

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

git(project, ['init', '--quiet', '--initial-branch', 'main']);
git(project, ['config', 'user.email', 'check@example.invalid']);
git(project, ['config', 'user.name', 'Branch Held Check']);
git(project, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(project, 'README.md'), '# throwaway\n', 'utf8');
git(project, ['add', '-A']);
git(project, ['commit', '--quiet', '-m', 'first']);

const workspace = {
  id: 'branch-held-check',
  name: 'Branch Held Check',
  path: project,
  innerPath: project.replace(/\\/g, '/'),
  environment: { kind: 'native' },
  error: null,
};

const ISSUE = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;

/** Whatever `ensureWorktree` answered — the worktree, or the message it threw. */
async function attempt(issueUrl) {
  try {
    return { worktree: await ensureWorktree(workspace, issueUrl), error: null };
  } catch (error) {
    return { worktree: null, error: String(error?.message ?? error) };
  }
}

try {
  console.log('1. the project\'s own checkout is holding the branch');
  {
    // Exactly what a session in the board's terminal leaves behind.
    git(project, ['checkout', '--quiet', '-b', 'issue-901']);

    const { worktree, error } = await attempt(ISSUE(901));

    check('no worktree is made', worktree === null,
          'git cannot check one branch out twice, so this must not claim to have succeeded');
    check('the refusal names the branch',
          typeof error === 'string' && error.includes('issue-901'),
          `error was ${JSON.stringify(error)}`);
    check('it names the directory holding it',
          typeof error === 'string' && error.replace(/\\/g, '/').includes(project.replace(/\\/g, '/')),
          `error was ${JSON.stringify(error)}`);
    check('it says that directory is the project itself, not a worktree',
          typeof error === 'string' && /project|main checkout/i.test(error)
          && !/is already used by worktree at/i.test(error),
          'git\'s own wording calls the project a worktree, which is what made this unreadable');
    // A runnable command, not the word "switch" in a sentence: it has to name git, the move,
    // and the directory to make it in, since the reader is being sent to a checkout that is
    // not the one the board is about.
    check('it gives the command that frees the branch',
          typeof error === 'string'
          && /git\b[^.]{0,200}\b(switch|checkout)\b/is.test(error)
          && new RegExp(`git\\b[^.]{0,200}${project.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'is')
               .test(error.replace(/\\/g, '/')),
          `error was ${JSON.stringify(error)}`);

    git(project, ['checkout', '--quiet', 'main']);
  }

  console.log('\n2. another worktree is holding the branch');
  {
    const held = join(root, 'held-elsewhere');
    git(project, ['worktree', 'add', '--quiet', held, '-b', 'issue-902']);

    const { worktree, error } = await attempt(ISSUE(902));

    check('no second worktree is made', worktree === null);
    check('the refusal names the worktree holding it',
          typeof error === 'string' && error.replace(/\\/g, '/').includes(held.replace(/\\/g, '/')),
          `error was ${JSON.stringify(error)}`);
    check('and does not call it the project',
          typeof error === 'string' && !/is the project/i.test(error),
          'a worktree holding the branch is a different situation with a different answer');
  }

  console.log('\n3. a branch nothing is holding is unaffected');
  {
    const fresh = await attempt(ISSUE(903));
    check('a fresh branch still gets its worktree', fresh.worktree !== null,
          `error was ${JSON.stringify(fresh.error)}`);
    check('on the branch named after the issue', fresh.worktree?.branch === 'issue-903',
          `branch was ${JSON.stringify(fresh.worktree?.branch)}`);

    // An existing branch that is checked out nowhere: `worktree add` takes it, and always could.
    git(project, ['branch', 'issue-904']);
    const existing = await attempt(ISSUE(904));
    check('an existing branch checked out nowhere still gets one', existing.worktree !== null,
          `error was ${JSON.stringify(existing.error)}`);
  }

  console.log('\n4. this issue\'s own worktree is still reused');
  {
    // 903 already has one from the section above. Reuse is what makes a retry after an
    // interrupted run land in the work the previous attempt left, so it must win over any
    // "the branch is held" reading — the checkout holding it is the one being asked for.
    const again = await attempt(ISSUE(903));
    check('a second call returns the same worktree', again.worktree !== null,
          `error was ${JSON.stringify(again.error)}`);
    check('and it is the same directory',
          again.worktree?.path?.replace(/\\/g, '/').endsWith('issue-903'),
          `path was ${JSON.stringify(again.worktree?.path)}`);
  }
} finally {
  // Worktrees first: removing the parent out from under a registered one leaves git
  // holding a reference to a directory that is gone.
  spawnSync('git', ['worktree', 'prune'], { cwd: project, encoding: 'utf8' });
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
