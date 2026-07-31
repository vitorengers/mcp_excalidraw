/**
 * What is left of an implementation whose server did not survive it.
 *
 * The canvas server was killed while five runs were live. Two of them died with it, and what
 * they left behind was worse than a failure: the board said nothing had gone wrong — both
 * cards sat in **In Progress**, exactly where a healthy run puts them — and the restarted
 * process answered `0 runs recorded`, because implementation state is a `Map` and a restart
 * empties it. Meanwhile one worktree held eleven modified files and no commits at all: 377
 * lines that existed only as a dirty working tree, held by nothing. The only control the panel
 * offered was **Implement / Fix**, which would have started an agent from the beginning in a
 * directory full of changes it did not write, with nothing telling it they were there.
 *
 * So the fact that has to survive a restart is not kept — it is **derived**, from the one
 * thing that did survive. `docs/project-board.md` said the state "lives on the server, against
 * the issue URL", and that was right about where and wrong about how long: on the server means
 * in that map, and the map does not outlive the process. The worktree does, it is the work
 * rather than bookkeeping about it, and it is true even for a run the server never got round
 * to writing anything about.
 *
 * Two things this deliberately does not do.
 *
 * **It does not commit on the agent's behalf.** A commit nobody wrote, with a message claiming
 * nothing, is a commit somebody has to interpret later. The work is left exactly as it was
 * found, and a resumed agent is told to read it before deciding what it is worth.
 *
 * **It does not move the card.** A stranded `In Progress` card is wrong, but a card that walks
 * backwards on its own while somebody is looking at the board is worse, and the reason
 * `moveIssueToColumn` is the server's to write in the first place — that the agent is the one
 * participant that cannot report its own crash — says nothing about who should undo a move
 * when the *server* is what crashed. The panel says the run was interrupted; the column stays
 * where a person put it.
 */
import logger from '../utils/logger.js';
import { GITHUB_HOST } from './github-host.js';
import { HeldWorktree, originRemote, worktreesHoldingWork } from './implement-worktree.js';
import { Workspace } from './workspaces.js';

/** A checkout holding work, and the issue it was cut for. */
export interface InterruptedRun {
  issueUrl: string;
  worktree: HeldWorktree;
}

/**
 * The issue URL a checkout named `issue-49` stands for, given the repository it belongs to.
 *
 * The inverse of `worktreeName`, and only of its numeric half. That function falls back to a
 * slug for a URL with no issue number in it, and a slug is lossy on purpose — there is nothing
 * to invert, so this answers null rather than guessing at a URL nobody can act on.
 *
 * The host it rebuilds on is the one this board requires, from `github-host.ts` — which is why
 * the repository handed to it has to have been read on that host too. A repository parsed off a
 * remote somewhere else and rebuilt here is a link to a stranger's issue.
 */
export function issueUrlFor(repo: string | null | undefined, worktreeName: string): string | null {
  const owner = (repo ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(owner)) return null;

  const number = worktreeName.match(/^issue-(\d+)$/)?.[1];
  return number ? `https://${GITHUB_HOST}/${owner}/issues/${number}` : null;
}

/**
 * Why checkouts holding work could not be named, in the words the operator reads at startup.
 *
 * Two different facts, and they were one message. A board with no `origin` at all is missing a
 * setting, and saying which two settings would supply it is the useful thing to say. A board
 * whose `origin` is GitLab, or a GitHub Enterprise Server, is not missing a setting: it is on a
 * host this board does not read, and offering it `repo` in `board.config.json` would be
 * offering to rebuild its issue URLs on github.com — pointing the panel at whatever happens to
 * live at that path on a host the operator never named. So that case names the host instead.
 */
export function unnamedWorktreesWarning(
  workspaceId: string,
  held: number,
  remote: string | null
): string {
  const opening = `Workspace "${workspaceId}" has ${held} checkout(s) holding work, but no `
    + 'repository to name their issues by';
  return remote
    ? `${opening} — its "origin" is ${remote}, which is not a ${GITHUB_HOST} remote. `
      + `This board only reads issues on ${GITHUB_HOST}.`
    : `${opening} — set "repo" in board.config.json, or add a ${GITHUB_HOST} "origin" remote.`;
}

/**
 * What the panel and the API say about a run nobody is doing.
 *
 * One sentence for how it ended and one for what is there, because "interrupted" on its own
 * does not tell anyone whether there is anything worth resuming — and the counts are the
 * difference between a run that got nowhere and one that was nearly finished.
 */
export function describeInterrupted(worktree: HeldWorktree): string {
  const parts = [
    worktree.commits ? `${worktree.commits} commit(s) not on the base branch` : null,
    worktree.changes ? `${worktree.changes} uncommitted path(s)` : null,
  ].filter(Boolean);
  return `The server that started this run did not survive it. Its checkout is still at `
    + `${worktree.path}, holding ${parts.join(' and ') || 'work'}.`;
}

/**
 * Every run in this workspace that a restart lost, as far as git can tell.
 *
 * The repository comes from the board's own `repo` before it comes from `origin`: a board
 * declares which repository its issues belong to, and a fork whose `origin` is the fork rather
 * than the upstream would otherwise reconstruct URLs against the wrong one.
 */
export async function interruptedRuns(workspace: Workspace): Promise<InterruptedRun[]> {
  const held = await worktreesHoldingWork(workspace);
  if (!held.length) return [];

  const origin = await originRemote(workspace);
  const repo = workspace.repo || origin.repo;
  if (!repo) {
    logger.warn(unnamedWorktreesWarning(workspace.id, held.length, origin.url));
    return [];
  }

  const runs: InterruptedRun[] = [];
  for (const worktree of held) {
    const issueUrl = issueUrlFor(repo, worktree.name);
    if (!issueUrl) continue;
    runs.push({ issueUrl, worktree });
  }
  return runs;
}
