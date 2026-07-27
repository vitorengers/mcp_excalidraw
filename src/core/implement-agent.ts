/**
 * Runs a coding agent inside a workspace to implement an issue the board already opened.
 *
 * This is the issue block's opposite number and its opposite in permissions. The issue
 * agent is deliberately powerless — `gh`, `git` and reading, nothing that writes — and
 * that narrowness is the guard. An agent that implements has to write code, so it cannot
 * share that command, and it must not inherit the issue block's opt-in either: enabling
 * issue blocks would otherwise enable repository writes, which is not a decision anyone
 * made. Hence its own variable, off unless explicitly set.
 *
 * The rest of the guards carry over — loopback only, one run per element — plus one more:
 * only a block that already has an issue has anything to implement.
 */
import { ImplementWorktree } from './implement-worktree.js';
import { AgentRun, runAgent } from './issue-agent.js';
import { Workspace } from './workspaces.js';

/**
 * What the agent is told.
 *
 * The workflow is deliberately **not** written here. Every project records how work is
 * done in it — branch naming, whether a change ships with a check, whether the agent
 * opens a pull request or merges it itself — and the agent runs inside that project, so
 * it is told to read that memory and treat it as the authority. Writing this repository's
 * conventions into the prompt would make the feature wrong for every other board.
 *
 * The rest is what an unattended run needs and an attended one gets for free: verify
 * instead of assuming, do not widen the scope, and — since nobody can answer a question
 * mid-run — decide the issue's open questions rather than stall on them.
 */
export const IMPLEMENT_AGENT_PROMPT = `You will implement a GitHub issue in this repository, end to end.

Before anything else, read your own project memory for this repository and follow the
workflow it records: how a branch is named, what a change has to ship with, whether you
open a pull request and whether you merge it yourself. That memory is the authority on how
work is done here — where it disagrees with your defaults, it wins. If there is no such
memory, say so plainly in your final message, and work on a branch off the default branch
in small, reviewable commits.

Then:

1. Read the issue with \`gh issue view\`, all of it, and its comments with
   \`gh issue view --comments\` — piped, that flag prints the comments instead of the body,
   so both calls are needed. The definition of done is the contract; the assumptions and
   open questions are part of what you are agreeing to. A comment is where whoever opened
   the issue answers those questions or adds what they left out, so where a comment and the
   body disagree, the comment is the later word and wins.
2. Investigate before you change anything. Check the issue's claims against the code. An
   issue can be wrong, out of date, or already fixed — if it is, say so and stop rather
   than implementing something nobody needs. That is a good outcome, not a failed run.
3. Implement the smallest change that satisfies the definition of done. Do not widen the
   scope. If you find adjacent problems, write them down for a separate issue instead of
   folding them in.
4. Verify. Run what the project uses to check itself — its build, its type check, its own
   check scripts — and read the output. Compiling is not working. If the project's workflow
   asks for a check written against the old code first, do that: a check written after the
   fix tends to describe the fix rather than the defect.
5. Report faithfully. If part of the issue is not done, say which part and why. A partial
   implementation described accurately is worth more than a complete one claimed falsely.

You are running unattended. Nobody can answer a question while you work, so where the issue
leaves something open, make the defensible call, state it in the pull request, and keep
going — asking would simply stop the work. Do not touch anything the issue does not cover.

Return only the pull request URL on a line of its own as the last thing you print.`;

/**
 * How long an implementation may take: by default, as long as it takes.
 *
 * Researching an issue is bounded work and keeps its twenty minutes. Implementing one is
 * not, and a clock that kills a working agent halfway through a change leaves a branch
 * nobody asked for and no pull request. Set EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT (seconds)
 * to put a ceiling back.
 *
 * The trade is real and is handled elsewhere: with no ceiling a wedged run holds the block
 * in `running`, so the block offers a reset.
 */
export const IMPLEMENT_TIMEOUT_MS: number | null = (() => {
  const configured = Number(process.env.EXCALIDRAW_IMPLEMENT_AGENT_TIMEOUT);
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : null;
})();

/**
 * Where the run is happening, or nothing at all.
 *
 * Nothing at all is the important half: a workspace that is not a git repository gets no
 * worktree, and must send the prompt it sent before this existed, byte for byte.
 *
 * This is not the project's workflow — that stays out of the prompt on purpose — it is a
 * fact about the process the agent has been started in, and one it cannot discover on its
 * own without going looking. Without it an agent reads its memory, finds "branch off the
 * default branch", and cuts a second branch inside a checkout that already is one. That
 * still isolates, but it leaves the branch the pull request is expected on unused.
 */
export function worktreeSection(worktree: ImplementWorktree | null | undefined): string {
  if (!worktree) return '';

  return `\n\n---\n\nYou are already in a git worktree made for this issue: a checkout of this
repository of its own, at ${worktree.innerPath}, on the fresh branch ${worktree.branch} cut
from the default branch. Work here and commit here. Other implementations may be running in
their own worktrees at the same time, so do not switch this checkout to another branch and do
not reach into theirs. Anything you leave uncommitted keeps the worktree alive after the run;
a worktree with nothing outstanding is removed when the run ends.`;
}

export async function runImplementAgent(
  workspace: Workspace,
  issueUrl: string,
  options: { agentCommand: string; timeoutMs?: number | null; worktree?: ImplementWorktree | null }
): Promise<AgentRun> {
  const worktree = options.worktree ?? null;
  const prompt = `${IMPLEMENT_AGENT_PROMPT}\n\n---\n\nThe issue to implement:\n\n${issueUrl}`
    + worktreeSection(worktree);
  return runAgent(workspace, prompt, {
    agentCommand: options.agentCommand,
    timeoutMs: options.timeoutMs === undefined ? IMPLEMENT_TIMEOUT_MS : options.timeoutMs,
    expects: 'pull',
    what: 'implement agent',
    directory: worktree,
  });
}
