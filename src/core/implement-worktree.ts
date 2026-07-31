/**
 * A separate checkout per implementation, so two runs cannot get in each other's way.
 *
 * The server serialises implementations by issue URL — one issue must not become two pull
 * requests — but the resource the agents contend for is not the issue, it is the working
 * tree. Two *different* issues passed every guard and were spawned into the same directory:
 * both cutting a branch, the second one from the first one's work in progress; commits
 * landing on whichever branch happened to be checked out; both builds writing the same
 * `dist/`, so each verified against the other's artifacts. Unattended, with nobody watching.
 *
 * A git worktree is the smallest thing that fixes that, and it is the mechanism Claude Code
 * itself uses for parallel agents. One repository, one object store, several checkouts —
 * each on its own branch, each its own directory.
 *
 * Two decisions worth stating. The worktrees live *beside* the project rather than inside
 * it: a checkout nested in the repository is a second copy of every file the project's own
 * tooling walks, and being outside is one `.gitignore` rule nobody can forget. And a
 * worktree with uncommitted work is never removed — it is the only copy of that work, and
 * an agent that died partway through a change leaves exactly that.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { repoFromRemoteUrl } from './github-host.js';
import { AgentDirectory, agentEnv } from './issue-agent.js';
import { foldPathCase } from './workspace-paths.js';
import { Workspace } from './workspaces.js';

export interface ImplementWorktree extends AgentDirectory {
  branch: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /**
   * The process never started, rather than having started and refused.
   *
   * `ok: false` covers both, and they are not the same thing at all: git exiting non-zero is
   * git's answer to the question, while a failed spawn means nothing looked at the repository.
   * Every caller that could not tell them apart guessed, and guessed the same way — that the
   * workspace must not be a repository.
   */
  spawnFailed?: true;
}

/**
 * Every git call this module makes, run with the environment the rest of the board's children get.
 *
 * `agentEnv()` is what the agents and the terminal are handed, and worktree git was the one
 * child of this server that was handed nothing — so on a machine whose git is somewhere the
 * server's own inherited PATH does not mention (Homebrew's prefix, under a launcher that gives
 * a process `/usr/bin:/bin:/usr/sbin:/sbin`) the agents could run git and this could not.
 * A repaired PATH in three of four places is a PATH nobody can reason about.
 */
function exec(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: agentEnv(), windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, stdout, stderr: error.message, spawnFailed: true }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/**
 * What a run is told when git never started, which is never "there is no repository here".
 *
 * Raised rather than logged, and raised by both callers below: this module exists because two
 * issues once cut branches in one working tree, and a run that cannot make a worktree and
 * continues anyway is that failure again, with nobody watching. Refusing costs one run; not
 * refusing costs whatever the agent does to the project checkout.
 *
 * The spawn's own message is carried through because it is the part that differs — `spawn git
 * ENOENT` from a missing git, something else entirely from a permission or a wsl.exe that is
 * not installed — and the sentence around it is the part a reader can act on.
 */
function gitCouldNotStart(result: CommandResult): Error {
  return new Error(`git could not be started (${result.stderr}) — install git or put it on PATH`);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a run waits for someone else's `.git/config.lock`, and how often it looks again.
 *
 * Git holds that lock for a couple of writes and releases it in milliseconds, so two seconds
 * is generous for real contention — on Windows an attempt costs a process spawn, so a window
 * measured in hundreds of milliseconds buys only one or two of them. It still fails fast on a
 * stale lock left behind by a crashed git, which is a real state and has to be reported
 * rather than waited on forever.
 */
const CONFIG_LOCK_WAIT_MS = 2000;
const CONFIG_LOCK_POLL_MS = 50;

/**
 * What running git somewhere needs to know: which machine the directory is on, and how it is
 * spelled on both sides of that.
 *
 * Narrower than `Workspace` because one caller has no workspace to hand. Registration reads a
 * project's `origin` to find out which repository it is in, and that happens *before* there is
 * a config for a workspace to be loaded from — a `Workspace` still satisfies it, so nothing
 * else changed.
 */
export type GitLocation = Pick<Workspace, 'environment' | 'path' | 'innerPath'>;

/** Run git the way the workspace's own environment runs it, in the directory given. */
function git(workspace: GitLocation, at: AgentDirectory, args: string[]): Promise<CommandResult> {
  if (workspace.environment.kind === 'wsl') {
    return exec('wsl.exe', [
      '-d', workspace.environment.distro,
      '--cd', at.innerPath,
      '--', 'git', ...args,
    ]);
  }
  return exec('git', args, at.path);
}

/** The spelling of a path that git itself should be given, on either side. */
function argPath(workspace: Workspace, directory: AgentDirectory): string {
  return workspace.environment.kind === 'wsl' ? directory.innerPath : directory.path;
}

function workspaceDirectory(workspace: GitLocation): AgentDirectory {
  return { path: workspace.path, innerPath: workspace.innerPath };
}

/**
 * Where the worktrees for a project go: a sibling directory, `<project>-worktrees`.
 *
 * Beside the project and not inside it, so nothing that walks the repository — the type
 * check, the build, the board export, the checks — has to learn to skip a second copy of
 * every file it reads.
 */
export function worktreeRoot(workspace: Workspace): AgentDirectory {
  const inner = workspace.innerPath.replace(/\/+$/, '');
  const base = inner.split('/').filter(Boolean).pop() || 'workspace';
  const name = `${base}-worktrees`;
  const innerParent = inner.slice(0, inner.length - base.length).replace(/\/+$/, '');
  return {
    path: path.join(path.dirname(workspace.path), name),
    innerPath: `${innerParent}/${name}`,
  };
}

/** `issue-49`, which is also the branch name. Stable, so the same issue reuses its checkout. */
export function worktreeName(issueUrl: string): string {
  const number = issueUrl.match(/\/issues\/(\d+)/)?.[1];
  return number ? `issue-${number}` : `issue-${issueUrl.replace(/[^a-zA-Z0-9]+/g, '-').slice(-40)}`;
}

function worktreeFor(workspace: Workspace, issueUrl: string): AgentDirectory {
  const root = worktreeRoot(workspace);
  const name = worktreeName(issueUrl);
  return { path: path.join(root.path, name), innerPath: `${root.innerPath}/${name}` };
}

/**
 * Whether two spellings name the same checkout — git's own, from `worktree list --porcelain`,
 * against the one this module built.
 *
 * Case folds where the filesystem does and nowhere else, the same rule the workspace canonical
 * form follows: on Linux `…/Issue-5` and `…/issue-5` are two directories, and calling them one
 * would have this read a checkout that exists where there is none.
 *
 * Exported for `scripts/check-workspace-path-case.mjs`, which has no other way in.
 */
export function samePath(a: string, b: string): boolean {
  const clean = (value: string) => foldPathCase(value.replace(/\\/g, '/').replace(/\/+$/, ''));
  return clean(a) === clean(b);
}

async function isCheckedOut(workspace: Workspace, directory: AgentDirectory): Promise<boolean> {
  const listed = await git(workspace, workspaceDirectory(workspace), ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return false;
  return listed.stdout.split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => samePath(line.slice('worktree '.length).trim(), argPath(workspace, directory)));
}

/**
 * Which checkout has this branch out, or null when none has.
 *
 * `show-ref` answers whether a branch *exists* and never where it is checked out, so the one
 * state that makes `git worktree add` impossible was the one state nothing looked at. The
 * porcelain listing carries both: a `worktree <path>` line, then a `branch refs/heads/<name>`
 * line for the branch that path holds.
 *
 * The project's own directory is in that listing too, and is listed exactly like a worktree —
 * which is why git's refusal calls it one, and why a reader looking at their own project
 * directory being described as a worktree cannot act on it.
 */
async function checkoutHolding(workspace: Workspace, branch: string): Promise<string | null> {
  const listed = await git(workspace, workspaceDirectory(workspace), ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return null;

  let current: string | null = null;
  for (const line of listed.stdout.split('\n')) {
    const text = line.trim();
    if (text.startsWith('worktree ')) current = text.slice('worktree '.length).trim();
    else if (text === `branch refs/heads/${branch}`) return current;
  }
  return null;
}

/**
 * The branch a new worktree is cut from.
 *
 * `origin/HEAD` first, because that is the default branch as the remote declares it. A
 * clone that never fetched it has no such ref, so fall back to whatever local branch looks
 * like the trunk, and to `HEAD` when even that is missing — a repository with one branch
 * under some other name still has to work.
 */
async function baseRef(workspace: Workspace): Promise<string> {
  const at = workspaceDirectory(workspace);

  const remote = await git(workspace, at, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (remote.ok && remote.stdout) return remote.stdout;

  for (const candidate of ['main', 'master']) {
    const exists = await git(workspace, at, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]);
    if (exists.ok) return candidate;
  }
  return 'HEAD';
}

/** Git's own words when another process holds the lock on the shared config file. */
function lostTheConfigLock(result: CommandResult): boolean {
  return /could not lock config file/i.test(`${result.stderr}\n${result.stdout}`);
}

/**
 * `git worktree add`, cut from the default branch and given no upstream of its own.
 *
 * **`--no-track` is two fixes in one.** Cut from `origin/HEAD`, `-b` takes that
 * remote-tracking start point as an upstream to configure, and leaves the branch with
 * `branch.<name>.merge = refs/heads/main`. That is an upstream nobody wants: `git pull` in the
 * worktree fast-forwards the feature branch onto whatever the default branch gained while the
 * agent was working, and a bare `git push` under `push.default=simple` is refused because the
 * upstream's name does not match the branch's. The upstream an agent actually wants is written
 * by its own first `git push -u origin issue-N`, so the right thing to hand it is none at all.
 *
 * Writing none is also what stops this call taking `.git/config.lock`. Every worktree shares
 * the main repository's `.git/config` — git keeps a per-worktree one only when
 * `extensions.worktreeConfig` is set, and this repository does not set it — and configuring an
 * upstream wrote `branch.<name>.remote` and `branch.<name>.merge` into it in two separate
 * transactions, each taking the lock. **Git neither waits on that lock nor retries**: it failed
 * on the spot with `File exists`, and the run died before its agent was ever spawned.
 *
 * The wait below stays, because the writers taking that lock are not all ours. Every agent
 * working in a worktree eventually runs `git push -u`, which writes those same two keys into
 * that same shared file, and the server cannot serialise a process it does not own.
 *
 * A failed attempt is not a no-op. Git rolls the checkout back but **keeps the branch it just
 * created**, so re-running the same command answers `a branch named 'issue-96' already
 * exists` — a second failure, for a different reason, that looks nothing like the first. The
 * branch is deleted between attempts, which makes each attempt a true re-run of the first.
 * Only a branch this call created is deleted: one that was already there is checked out rather
 * than created, and takes no config lock to begin with.
 */
async function addWorktree(
  workspace: Workspace,
  at: AgentDirectory,
  target: AgentDirectory,
  branch: string
): Promise<CommandResult> {
  const branchExisted = await git(workspace, at, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = branchExisted.ok
    ? ['worktree', 'add', argPath(workspace, target), branch]
    : ['worktree', 'add', '--no-track', argPath(workspace, target), '-b', branch, await baseRef(workspace)];

  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  for (;;) {
    const attempt = await git(workspace, at, args);
    if (attempt.ok || !lostTheConfigLock(attempt)) return attempt;
    if (Date.now() >= deadline) return attempt;
    if (!branchExisted.ok) await git(workspace, at, ['branch', '-D', branch]);
    await delay(CONFIG_LOCK_POLL_MS);
  }
}

/**
 * One `git worktree add` at a time per repository, so we never contend with ourselves.
 *
 * The retry above covers the writers the server does not own; this covers the ones it does.
 * Two implementations started in the same second both reached `git worktree add`, and one
 * lost — serialising them means that collision never reaches the retry at all.
 *
 * **Around the git call only.** `linkDependencies` is the slow half of creating a worktree,
 * twenty thousand hard links of it, and it writes nothing into `.git/config`. Holding a lock
 * across it would make every run wait out every earlier run's dependencies for no reason.
 */
const worktreeAdds = new Map<string, Promise<unknown>>();

function serialiseWorktreeAdd<T>(repository: string, add: () => Promise<T>): Promise<T> {
  const queued = (worktreeAdds.get(repository) ?? Promise.resolve()).catch(() => {}).then(add);
  worktreeAdds.set(repository, queued.catch(() => {}));
  return queued;
}

/**
 * Copy a tree as hard links: same file contents, separate directory entries.
 *
 * Cheap in both senses — no bytes are copied, and deleting a link deletes only that link.
 * That second property is the whole reason this exists.
 */
function mirrorAsHardLinks(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mirrorAsHardLinks(from, to);
    } else if (entry.isSymbolicLink()) {
      // Copied as a link of its own; following it could walk out of the tree entirely.
      try {
        fs.symlinkSync(fs.readlinkSync(from), to);
      } catch { /* a link that cannot be recreated is not worth failing the run over */ }
    } else {
      fs.linkSync(from, to);
    }
  }
}

/**
 * Give the worktree the dependencies it needs to verify anything.
 *
 * `node_modules` is not tracked, so a fresh checkout has none, and an agent told to run the
 * build finds no compiler there. Installing per run would cost minutes and gigabytes to
 * arrive at the same tree, so the project's own is shared.
 *
 * **Shared as hard links, not as one junction to the directory.** A junction is what this
 * did first, and it made `node_modules` a single mutable resource behind four supposedly
 * isolated checkouts: anything an agent ran that removed its own `node_modules` — an
 * `npm ci`, an `rm -rf` — reached through the junction and emptied the project's. It
 * happened twice in one afternoon, and the failure is silent until the next thing that
 * needs a compiler, which by then looks unrelated.
 *
 * Hard links make each checkout's `node_modules` its own directory entries over the same
 * bytes. Deleting one deletes links; the project's copy is untouched, and an agent that
 * really does install gets its own files. ~20k links here, a few seconds, once per worktree.
 *
 * The trade is that a file *edited in place* is edited for everyone — much rarer than
 * deletion, and much less destructive when it happens.
 */
async function linkDependencies(workspace: Workspace, worktree: AgentDirectory): Promise<void> {
  const name = 'node_modules';
  try {
    if (workspace.environment.kind === 'wsl') {
      const source = `${workspace.innerPath}/${name}`;
      const link = `${worktree.innerPath}/${name}`;
      // `cp -al` is the same idea, and is one process rather than twenty thousand calls
      // across the WSL boundary.
      await exec('wsl.exe', [
        '-d', workspace.environment.distro, '--',
        'bash', '-lc', `[ -d ${JSON.stringify(source)} ] && [ ! -e ${JSON.stringify(link)} ] && cp -al ${JSON.stringify(source)} ${JSON.stringify(link)} || true`,
      ]);
      return;
    }

    const source = path.join(workspace.path, name);
    const target = path.join(worktree.path, name);
    if (!fs.existsSync(source) || fs.existsSync(target)) return;

    const started = Date.now();
    try {
      mirrorAsHardLinks(source, target);
      logger.info(`Linked ${name} into ${worktree.path} in ${Date.now() - started}ms`);
    } catch (error) {
      // A hard link cannot cross volumes and needs no privilege; when it fails anyway,
      // a junction is still better than a checkout with no compiler in it. Partial work
      // is cleared first so resolution does not find half a tree.
      fs.rmSync(target, { recursive: true, force: true });
      logger.warn(`Could not hard-link ${name} (${(error as Error).message}); falling back to a junction, which is shared`);
      fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
    }
  } catch (error) {
    logger.warn(`Could not provide ${name} in ${worktree.path}: ${(error as Error).message}`);
  }
}

/**
 * The checkout this issue is implemented in, created if it is not there yet.
 *
 * Returns null when the workspace is not a git repository — a project can be a board
 * without being a repository, and the old behaviour of running in the project directory is
 * the right answer for it. Isolation is what a repository buys; nothing else changes.
 *
 * Throws when git could not be started, which is the same `ok: false` and a different fact.
 * Read as "not a repository" it turned a missing git into a run with no isolation at all, in
 * the project's own checkout — the one outcome this module was written to make impossible.
 */
export async function ensureWorktree(
  workspace: Workspace,
  issueUrl: string
): Promise<ImplementWorktree | null> {
  const at = workspaceDirectory(workspace);
  const inside = await git(workspace, at, ['rev-parse', '--is-inside-work-tree']);
  if (inside.spawnFailed) throw gitCouldNotStart(inside);
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    logger.warn(`Workspace "${workspace.id}" is not a git repository, so this run is not isolated`);
    return null;
  }

  const branch = worktreeName(issueUrl);
  const target = worktreeFor(workspace, issueUrl);

  if (await isCheckedOut(workspace, target)) {
    const current = await git(workspace, target, ['rev-parse', '--abbrev-ref', 'HEAD']);
    logger.info(`Reusing worktree ${target.path} for ${issueUrl}`);
    return { ...target, branch: current.ok ? current.stdout : branch };
  }

  // Before the attempt, because git's own refusal is unreadable here. It reports the project
  // directory as "worktree at <path>" — true of the porcelain listing, and unactionable for a
  // reader looking at the directory their project lives in. What they need is which checkout
  // holds the branch and how to free it, and only this process knows which of those two the
  // holder is.
  //
  // After the reuse check above, deliberately: the checkout holding this issue's branch is
  // usually this issue's own worktree, and reusing it is what makes a retry after an
  // interrupted run land in the work the previous attempt left.
  const holder = await checkoutHolding(workspace, branch);
  if (holder) {
    const project = argPath(workspace, at);
    if (samePath(holder, project)) {
      const base = (await baseRef(workspace)).replace(/^origin\//, '');
      throw new Error(
        `Could not create a worktree at ${target.path}: branch ${branch} is checked out in the `
        + `project itself, at ${holder}, and git cannot check one branch out in two places. `
        + `Free it there — git -C "${holder}" switch ${base} — and start the run again. `
        + `Nothing is lost: the branch and its commits stay where they are.`
      );
    }
    throw new Error(
      `Could not create a worktree at ${target.path}: branch ${branch} is checked out in another `
      + `worktree, at ${holder}. If that is this issue's run, the work is already set up there; `
      + `if it is stale, git worktree remove "${holder}" releases the branch.`
    );
  }

  const added = await serialiseWorktreeAdd(workspace.path, () => addWorktree(workspace, at, target, branch));
  if (!added.ok) {
    const detail = added.stderr || added.stdout;
    // A lock still held after the whole window is a state of its own — usually a
    // `.git/config.lock` a crashed git left behind — and saying so is the difference
    // between a one-line fix and an afternoon.
    throw new Error(lostTheConfigLock(added)
      ? `Could not create a worktree at ${target.path}: .git/config.lock was still held after `
        + `${CONFIG_LOCK_WAIT_MS}ms. Another git process is writing the shared config, or a crashed `
        + `one left the lock behind — delete .git/config.lock if nothing else is running. ${detail}`
      : `Could not create a worktree at ${target.path}: ${detail}`);
  }

  await linkDependencies(workspace, target);
  logger.info(`Implementing ${issueUrl} in ${target.path} on branch ${branch}`);
  return { ...target, branch };
}

/**
 * A checkout left behind by a run, and how much work is sitting in it.
 *
 * The two counts are the evidence, not decoration: they are what tells a resumed agent how
 * much of what it is about to read was written by somebody else, and they are what a panel
 * would have to say to justify offering to resume at all.
 */
export interface HeldWorktree extends ImplementWorktree {
  /** The directory name the checkout was created under — `issue-49`. */
  name: string;
  /** Commits on its branch that the base branch does not have. */
  commits: number;
  /** Paths `git status --porcelain` reports: uncommitted, staged or untracked. */
  changes: number;
}

/** One `worktree …` block of `git worktree list --porcelain`, as far as this cares. */
interface ListedWorktree {
  path: string;
  branch: string | null;
}

function parseWorktreeList(porcelain: string): ListedWorktree[] {
  const listed: ListedWorktree[] = [];
  let current: ListedWorktree | null = null;
  for (const raw of porcelain.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim(), branch: null };
      listed.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  return listed;
}

function countOf(result: CommandResult): number {
  const parsed = Number(result.stdout.trim());
  return result.ok && Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Whether everything on this checkout's branch is already in the base, however it got there.
 *
 * `rev-list base..HEAD` answers a narrower question — whether the branch's *commits* are
 * reachable from the base — and a squash merge makes that permanently no. The base gets one new
 * commit carrying the whole branch, and the originals are never ancestors of it. Every pull
 * request here is a squash (`CLAUDE.md`), so counting commits reported every finished run as
 * interrupted until somebody removed its checkout by hand, and buried the one message that
 * exists to rescue work nobody is doing.
 *
 * The test is the standard one for a squashed branch: rebuild the branch as a single commit on
 * top of the merge base — the same tree, so the same cumulative diff — and let `git cherry`
 * compare that against the base by patch id. `git cherry base HEAD` cannot answer this on its
 * own: it compares commit by commit, and the squash collapsed N patches into one, so none of
 * the originals match.
 *
 * Any git failure answers false and keeps the count. A recovery feature that goes quiet on an
 * unexpected error is worse than one that is occasionally noisy.
 */
async function workIsInBase(
  workspace: Workspace,
  directory: AgentDirectory,
  base: string,
): Promise<boolean> {
  const mergeBase = await git(workspace, directory, ['merge-base', base, 'HEAD']);
  if (!mergeBase.ok || !mergeBase.stdout.trim()) return false;

  const tree = await git(workspace, directory, ['rev-parse', 'HEAD^{tree}']);
  if (!tree.ok || !tree.stdout.trim()) return false;

  // One unreferenced object, collected like any other dangling commit. No ref moves.
  const synthetic = await git(workspace, directory, [
    'commit-tree', tree.stdout.trim(), '-p', mergeBase.stdout.trim(), '-m', 'merged-work probe',
  ]);
  if (!synthetic.ok || !synthetic.stdout.trim()) return false;

  const cherry = await git(workspace, directory, ['cherry', base, synthetic.stdout.trim()]);
  if (!cherry.ok) return false;

  // `-` is "an equivalent patch is already upstream", `+` is "not there". An empty answer is
  // not agreement, so it keeps the count too.
  const lines = cherry.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => line.startsWith('-'));
}

/**
 * Every `issue-<n>` checkout under this project's worktree root that still holds work.
 *
 * This is the whole of "detect an interrupted run", and it deliberately persists nothing.
 * A record written to disk can disagree with reality — it can be written and never cleaned,
 * or cleaned and never written — whereas the worktree **is** the work, so it cannot lie about
 * it. It also covers the case a record never could: an agent that died before the server got
 * round to writing anything about it still left its checkout behind.
 *
 * The price is that it says nothing about *when* a run started or how far it got, and that
 * it cannot tell a run that was killed from one that finished and left a dirty tree. Both are
 * "there is work here that nobody is doing", which is the question being asked.
 *
 * A clean checkout with nothing ahead of the base is not reported, and that is the right
 * answer rather than a gap: there is nothing in it to resume.
 *
 * Git that could not be started throws, for the same reason and to a different reader. The
 * empty list means "nothing was left behind", and answering it when nothing was *looked at*
 * is the one lie this feature cannot afford: the whole of it is a promise that work an
 * interrupted run left will be offered back, and it is offered exactly once, at startup.
 * The caller there logs what it is told and carries on with the rest of the boards.
 */
export async function worktreesHoldingWork(workspace: Workspace): Promise<HeldWorktree[]> {
  const at = workspaceDirectory(workspace);
  const inside = await git(workspace, at, ['rev-parse', '--is-inside-work-tree']);
  if (inside.spawnFailed) throw gitCouldNotStart(inside);
  if (!inside.ok || inside.stdout.trim() !== 'true') return [];

  const listed = await git(workspace, at, ['worktree', 'list', '--porcelain']);
  if (!listed.ok) return [];

  const root = worktreeRoot(workspace);
  const rootPath = argPath(workspace, root);
  const base = await baseRef(workspace);
  const held: HeldWorktree[] = [];

  for (const entry of parseWorktreeList(listed.stdout)) {
    // Only checkouts this module made: under the project's own worktree root, and named the
    // way `worktreeName` names them. The main working tree is excluded by both.
    const name = entry.path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';
    if (!/^issue-.+/.test(name)) continue;
    if (!samePath(`${rootPath}/${name}`, entry.path)) continue;

    const directory: ImplementWorktree = {
      path: path.join(root.path, name),
      innerPath: `${root.innerPath}/${name}`,
      branch: entry.branch ?? name,
    };
    // Git lists a checkout until somebody prunes it, so the directory may well be gone.
    if (!fs.existsSync(directory.path)) continue;

    const status = await git(workspace, directory, ['status', '--porcelain']);
    const changes = status.ok
      ? status.stdout.split('\n').filter((line) => line.trim()).length
      : 0;
    const commits = countOf(await git(workspace, directory, ['rev-list', '--count', `${base}..HEAD`]));
    if (!changes && !commits) continue;
    // Commits the base cannot reach are not the same thing as work the base does not have —
    // a squash merge is exactly that shape. Only worth asking with a clean tree: a dirty
    // checkout holds work whatever its history says.
    if (!changes && (await workIsInBase(workspace, directory, base))) continue;

    held.push({ ...directory, name, commits, changes });
  }

  return held;
}

/** What `origin` says a checkout is: the remote as configured, and the repository if it is ours. */
export interface OriginRemote {
  /** Whatever `git remote get-url origin` printed, or null when there is no `origin` at all. */
  url: string | null;
  /** `owner/name`, only when that remote is on github.com. */
  repo: string | null;
}

/**
 * `owner/name` as the repository's own `origin` declares it, and the remote it read it from.
 *
 * The fallback for a board whose `board.config.json` names no `repo`, and — since a tracked
 * config no longer ships one — the answer registration writes into a new project's. Read rather
 * than guessed: reconstructing an issue URL from a branch name needs a repository, and inventing
 * one would point the panel at somebody else's issue. A `repo` shipped in a tracked config is an
 * answer about whoever wrote the file; `origin` is an answer about the checkout in front of the
 * board.
 *
 * Both halves are returned because "there is no `origin`" and "`origin` is not on github.com"
 * are different facts and the caller says different things about them — a warning that offers
 * `repo` in `board.config.json` to somebody whose remote is GitLab is answering a question
 * they did not ask. The parse itself is `github-host.ts`'s: the host is one decision.
 *
 * `GitLocation` rather than `Workspace`, because `ensureWorkspaceConfig` calls this while it is
 * still deciding what the workspace is: it holds a resolved path and an environment and has no
 * `Workspace` to hand over yet. Every other caller passes one, which satisfies the narrower type.
 */
export async function originRemote(workspace: GitLocation): Promise<OriginRemote> {
  const remote = await git(workspace, workspaceDirectory(workspace), ['remote', 'get-url', 'origin']);
  if (!remote.ok) return { url: null, repo: null };
  const url = remote.stdout.trim() || null;
  return { url, repo: repoFromRemoteUrl(url) };
}

export interface WorktreeRelease {
  /** False when the worktree was kept, which is what `path` is then for. */
  removed: boolean;
  path: string;
}

/**
 * Take the worktree away, unless doing so would throw work away with it.
 *
 * Uncommitted changes are the only copy of themselves — an agent killed partway through a
 * change leaves exactly that — so a dirty worktree is kept and its path reported instead.
 * A clean one goes, and its branch with it when git agrees the branch is merged: `-d`
 * refuses an unmerged branch, which is precisely the branch a pull request was opened from.
 */
export async function releaseWorktree(
  workspace: Workspace,
  worktree: ImplementWorktree
): Promise<WorktreeRelease> {
  const status = await git(workspace, worktree, ['status', '--porcelain']);
  if (!status.ok) return { removed: false, path: worktree.path };
  if (status.stdout.trim()) return { removed: false, path: worktree.path };

  const at = workspaceDirectory(workspace);
  const removed = await git(workspace, at, ['worktree', 'remove', argPath(workspace, worktree)]);
  if (!removed.ok) {
    logger.warn(`Could not remove worktree ${worktree.path}: ${removed.stderr || removed.stdout}`);
    return { removed: false, path: worktree.path };
  }

  await git(workspace, at, ['branch', '-d', worktree.branch]);
  await git(workspace, at, ['worktree', 'prune']);
  return { removed: true, path: worktree.path };
}
