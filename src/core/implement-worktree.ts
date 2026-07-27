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
import { AgentDirectory } from './issue-agent.js';
import { Workspace } from './workspaces.js';

export interface ImplementWorktree extends AgentDirectory {
  branch: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function exec(command: string, args: string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ ok: false, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

/** Run git the way the workspace's own environment runs it, in the directory given. */
function git(workspace: Workspace, at: AgentDirectory, args: string[]): Promise<CommandResult> {
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

function workspaceDirectory(workspace: Workspace): AgentDirectory {
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

function samePath(a: string, b: string): boolean {
  const clean = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
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

/**
 * Give the worktree the dependencies it needs to verify anything.
 *
 * `node_modules` is not tracked, so a fresh checkout has none, and an agent told to run the
 * build finds no compiler there. A link rather than an install: the two checkouts are the
 * same repository at nearly the same commit, and an install per run would cost minutes and
 * gigabytes to arrive at the same tree.
 */
async function linkDependencies(workspace: Workspace, worktree: AgentDirectory): Promise<void> {
  const name = 'node_modules';
  try {
    if (workspace.environment.kind === 'wsl') {
      const source = `${workspace.innerPath}/${name}`;
      const link = `${worktree.innerPath}/${name}`;
      await exec('wsl.exe', [
        '-d', workspace.environment.distro, '--',
        'bash', '-lc', `[ -e ${JSON.stringify(source)} ] && [ ! -e ${JSON.stringify(link)} ] && ln -s ${JSON.stringify(source)} ${JSON.stringify(link)} || true`,
      ]);
      return;
    }

    const source = path.join(workspace.path, name);
    const link = path.join(worktree.path, name);
    if (!fs.existsSync(source) || fs.existsSync(link)) return;
    // A junction, not a symlink: creating a symlink on Windows needs a privilege an
    // ordinary account does not have, and a junction needs none.
    fs.symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    logger.warn(`Could not link ${name} into ${worktree.path}: ${(error as Error).message}`);
  }
}

/**
 * The checkout this issue is implemented in, created if it is not there yet.
 *
 * Returns null when the workspace is not a git repository — a project can be a board
 * without being a repository, and the old behaviour of running in the project directory is
 * the right answer for it. Isolation is what a repository buys; nothing else changes.
 */
export async function ensureWorktree(
  workspace: Workspace,
  issueUrl: string
): Promise<ImplementWorktree | null> {
  const at = workspaceDirectory(workspace);
  const inside = await git(workspace, at, ['rev-parse', '--is-inside-work-tree']);
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

  const branchExists = await git(workspace, at, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = branchExists.ok
    ? ['worktree', 'add', argPath(workspace, target), branch]
    : ['worktree', 'add', argPath(workspace, target), '-b', branch, await baseRef(workspace)];

  const added = await git(workspace, at, args);
  if (!added.ok) {
    throw new Error(`Could not create a worktree at ${target.path}: ${added.stderr || added.stdout}`);
  }

  await linkDependencies(workspace, target);
  logger.info(`Implementing ${issueUrl} in ${target.path} on branch ${branch}`);
  return { ...target, branch };
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
