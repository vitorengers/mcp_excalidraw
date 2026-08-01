/**
 * Whether the account behind `gh` can push to the repository a run would push to.
 *
 * Everything after an implementation's first commit assumes the answer is yes, and nothing
 * anywhere asked. `addWorktree` deliberately writes no upstream, because "the upstream an agent
 * actually wants is written by its own first `git push -u origin issue-N`"; the prompt makes
 * opening and merging the pull request the agent's own and demands its URL as the last line it
 * prints; and `releaseWorktree` removes the branch with `git branch -d`, which only succeeds on
 * a merged branch. A reader who *cloned* this repository rather than forking it therefore got a
 * run that investigated, built and verified for as long as it took, failed at the push, and was
 * reported as `Agent finished without returning a pull request URL` with 600 characters of tail.
 * The worktree kept the commits, `releaseWorktree` was never reached, and every subsequent
 * server start called the run interrupted — a state only a person can settle, by finishing or
 * discarding the checkout by hand (#355).
 *
 * **`origin`, not the configured `repo`.** What a run pushes to is the remote the checkout has,
 * and a board's `repo` names where its *issues* live: on a fork those are two different
 * repositories, and asking about the wrong one would refuse exactly the reader who did the right
 * thing. `originRemote` already answers this, and answers `null` for a remote that is not on
 * github.com — which is not a refusal either, because a checkout pushing to a GitLab or a bare
 * directory is a repository this probe has nothing to say about.
 *
 * **A probe that cannot say allows the run.** This is the rule the whole module is built to
 * keep. `viewerPermission` is a field an older `gh` does not have; the call reaches the network
 * and the network here really does drop connections; the account may be logged out. Every one of
 * those has to end in the run starting, because taking implementing away from a board whose
 * GitHub is having a bad minute is a far larger defect than the one this guards. Only a
 * permission GitHub *stated*, and stated as one that cannot push, refuses anything.
 */
import { runGh } from './gh.js';
import { originRemote } from './implement-worktree.js';
import { Workspace } from './workspaces.js';

/**
 * The permissions GitHub answers `viewerPermission` with that carry a push.
 *
 * The five it can return are `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE` and `READ`. Triage is the
 * one worth naming: it can label and close issues and cannot push a branch, so it belongs with
 * `READ` however administrative it sounds.
 */
const CAN_PUSH = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/**
 * `owner/name` that is safe to put on a command line.
 *
 * `runGh` interpolates into a string a WSL workspace runs through `bash -lc`, so anything
 * reaching it has to be validated rather than escaped — the rule `runGh`'s own comment states.
 * A remote is read off disk, and a repository whose name is not this shape is one this probe
 * declines to ask about rather than one it quotes.
 */
const SAFE_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** What `gh` was able to say about pushing to this checkout's `origin`. */
export interface PushAccess {
  /** `unknown` is "nobody could say", and it is not a refusal. */
  verdict: 'yes' | 'no' | 'unknown';
  /** The repository asked about, or null when there was none to ask about. */
  repo: string | null;
  /** Exactly what GitHub answered, for the sentence the reader gets. Null unless it answered. */
  permission: string | null;
  /** Why nobody could say, for the log. Empty for a settled answer. */
  why: string;
}

const cannotSay = (why: string, repo: string | null = null): PushAccess =>
  ({ verdict: 'unknown', repo, permission: null, why });

/**
 * Ask GitHub, once, whether this account can push to what `origin` names.
 *
 * `attempts: 1` for the reason `RunGhOptions` reserves it: this is a probe whose failure is
 * already an answer it can use. Three tries 1.6 seconds apart would turn a `gh` that is simply
 * absent into a second and a half of a canvas waiting to be told the run started anyway.
 *
 * Never throws. Every path out is a `PushAccess`, so a caller cannot accidentally turn a broken
 * probe into a refused run by forgetting a `catch`.
 */
export async function readPushAccess(workspace: Workspace): Promise<PushAccess> {
  let repo: string | null = null;
  try {
    repo = (await originRemote(workspace)).repo;
  } catch (error) {
    return cannotSay(`the origin remote could not be read: ${(error as Error).message}`);
  }
  if (!repo) return cannotSay('this project has no origin on github.com');
  if (!SAFE_REPO.test(repo)) return cannotSay(`"${repo}" is not a repository name gh can be asked about`);

  let said: string;
  try {
    said = await runGh(workspace, `repo view ${repo} --json viewerPermission`, {
      what: `the push permission on ${repo}`,
      timeoutMs: 15_000,
      attempts: 1,
    });
  } catch (error) {
    return cannotSay(`gh could not answer: ${(error as Error).message}`, repo);
  }

  let permission: unknown;
  try {
    permission = (JSON.parse(said) as { viewerPermission?: unknown }).viewerPermission;
  } catch {
    return cannotSay(`gh answered something that is not JSON: ${said.trim().slice(0, 200)}`, repo);
  }
  // Null is what GitHub returns for a viewer it does not recognise, which is a question about
  // the login rather than about the repository — and `github-status.ts` is where a board is told
  // it is logged out.
  if (typeof permission !== 'string' || !permission.trim()) {
    return cannotSay('gh reported no viewerPermission for it', repo);
  }

  return {
    verdict: CAN_PUSH.has(permission.trim().toUpperCase()) ? 'yes' : 'no',
    repo,
    permission: permission.trim(),
    why: '',
  };
}

/**
 * The sentence a reader whose account cannot push gets, on the canvas.
 *
 * It names the fork because forking is the remedy: this tool spawns an agent that commits,
 * pushes a branch and opens a pull request, and none of that is possible against a repository
 * somebody else owns. The literal `git remote set-url` is there for the same reason every
 * remedy in `gh.ts` is a command rather than a description — the reader is looking at a canvas,
 * and a line they can copy is the difference between that and a search.
 */
export function pushRefusal(access: PushAccess): string {
  const repo = access.repo ?? 'this project\'s origin';
  return `This board's gh is logged in as an account with ${access.permission ?? 'no'} access to `
    + `${repo}, which cannot push a branch. A run would investigate, build and verify, then fail `
    + `at "git push" with its commits stranded in a worktree — so it is refused before anything `
    + `is created. Fork ${repo}, point this project at the fork with `
    + `"git remote set-url origin <your fork>", and start the run again. "gh auth status" says `
    + `which account this is.`;
}
