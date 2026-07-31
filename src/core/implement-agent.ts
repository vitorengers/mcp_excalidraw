/**
 * Runs a coding agent inside a workspace to implement an issue the board already opened.
 *
 * This is the issue block's opposite number and its opposite in permissions. The issue
 * agent's documented allowlist is scoped by sub-command — five `gh issue` verbs, one
 * `gh project` verb, four read-only `git` verbs and reading — so it writes issues and
 * project items and nothing else: no commit, no push, no branch, no `gh api`
 * (`docs/trap-allowed-tools.md` has both halves as tables). That narrowness is the guard.
 * An agent that implements has to write code, so it cannot share that command, and it must
 * not inherit the issue block's opt-in either: enabling issue blocks would otherwise enable
 * repository writes, which is not a decision anyone made. Hence its own variable, off
 * unless explicitly set.
 *
 * The rest of the guards carry over — loopback only, one run per element — plus one more:
 * only a block that already has an issue has anything to implement.
 */
import { AgentUsage } from './agent-usage.js';
import { ESCALATION_MARKER } from './implement-landing.js';
import { HeldWorktree, ImplementWorktree } from './implement-worktree.js';
import { applyAgentSettings, AgentHost, AgentRun, runAgent, workflowSection } from './issue-agent.js';
import { loadAgentWorkflow, Workspace } from './workspaces.js';
import { env } from './settings.js';

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
 *
 * Step 5 exists because worktrees changed what a run is. When implementations were
 * serialised, the branch a run cut from was still there when it finished; now four can be
 * live at once and three can merge while the fourth works. The agent has the permissions
 * and the tools to reconcile that itself, and was already doing so unprompted — but the
 * instruction not to widen the scope reads, to a literal agent, as a reason not to touch
 * the change that just landed. So the carve-out is explicit: reconciling is finishing.
 *
 * The research half of step 2 is the same kind of carve-out, arrived at from the opposite
 * direction. The issue agent has been ordered to research since its prompt was written;
 * this one never was, and "check the issue's claims against the code" reads as though the
 * code is where every claim is settled. It is not — a library's API, a tool's flag, an
 * external service's behaviour are all off-repository facts a change can rest on, and a
 * remembered one compiles exactly as well as a correct one. Step 4's "compiling is not
 * working" is about the same failure a step earlier, so this is where it belongs.
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
   Not every fact the change rests on is settled by the repository. A library's API, a
   tool's flag, an external service's behaviour — those live outside it, and the web is
   available to you: search for the documentation and read the page, or run the
   \`--help\`. Confirm such a fact against its source rather than inventing it or trusting
   what you remember. A remembered API compiles exactly as well as a correct one.
3. Implement the smallest change that satisfies the definition of done. Do not widen the
   scope. If you find adjacent problems, write them down for a separate issue instead of
   folding them in.
4. Verify. Run what the project uses to check itself — its build, its type check, its own
   check scripts — and read the output. Compiling is not working. If the project's workflow
   asks for a check written against the old code first, do that: a check written after the
   fix tends to describe the fix rather than the defect.
5. Land it against the branch as it is now, not as it was when you started. Other
   implementations run at the same time as yours, so the default branch may have moved while
   you were working. Bring your branch up to date with it before you open the pull request,
   and again before you merge — a branch that was current at open time is often not current
   by merge time.
   If that raises conflicts, resolve them; that is part of the job, not a reason to stop.
   Find out what the other change was for before you touch it — \`gh pr view\`, \`git log\`,
   the diff itself — and reconcile the two intents. Keeping one side wholesale and dropping
   the other is not resolution in either direction, and a conflict resolved without reading
   the other side is a guess that compiles.
   If you genuinely cannot reconcile them, leave the pull request open, say which files and
   what the disagreement is, and stop. A merge that quietly discards someone else's work is
   worse than one that waits for a person. Say so in the words below when you do, because
   from outside, stopping on purpose and stopping mid-sentence look identical.
6. Report faithfully. If part of the issue is not done, say which part and why. A partial
   implementation described accurately is worth more than a complete one claimed falsely.

You are running unattended. Nobody can answer a question while you work, so where the issue
leaves something open, make the defensible call, state it in the pull request, and keep
going — asking would simply stop the work. Do not touch anything the issue does not cover,
except where landing your own change requires it: reconciling with a change that merged
while you were working is not widening the scope, it is finishing.

You may put helpers to work — sub-agents, background tasks, whatever the change needs. Two
things stay yours and do not transfer with the work:

- **Opening the pull request, and merging it.** A helper investigates, writes code, runs
  checks and reports back to you; it never runs \`gh pr create\` or merges. Nothing
  downstream counts pull requests, so two helpers that each open one leave two for one
  issue and no error anywhere.
- **Finishing.** Only what *you* print is read. Whoever did the work, and whatever a helper
  already opened, you print the pull request URL yourself, last, on a line of its own — and
  you wait for every helper to come back before you do. A run that ends without that line
  leaves the board waiting forever on a pull request that already exists.

**A pull request you did not merge is not a finished run**, and the board now checks: it asks
GitHub what became of the URL you printed, and a pull request still open is recorded as a run
that ended without landing anything. There is one exception, and it is the case above — you
could not reconcile a conflict and stopped for a person. Print that as

    ${ESCALATION_MARKER}: <pull request URL>

and it is recorded as its own thing rather than as a failure. Print it only when it is true. A
run that merged prints the bare URL.

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
  const configured = Number(env('IMPLEMENT_AGENT_TIMEOUT'));
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

/**
 * The section that says the previous attempt is still in the room — or nothing at all.
 *
 * Nothing at all is the important half once more: a run started fresh must send the prompt it
 * sent before this existed, byte for byte.
 *
 * **This is the agent reading a diff, not the agent remembering.** Resuming the previous
 * agent's own session would be better — its transcript holds what it had decided and what it
 * had already ruled out, which no diff can reconstruct — and Claude Code does offer
 * `--resume <session-id>` alongside `-p`. It is not what this does, for a reason that is about
 * where the id could live rather than about the flag. Detection here is derived from the
 * worktree and persists nothing; a session id is not in the worktree, so carrying one across a
 * restart means a file on disk, which is the persistence this deliberately does without. It
 * would also mean the server appending flags to a command line somebody else wrote, and
 * assuming that command is Claude Code — the same rewrite `agent-usage.ts` refuses to make for
 * `--output-format`. So the agent is told, plainly, that the work is not its own and that it
 * has to read it before it can trust it.
 *
 * The counts are given rather than left to be discovered because they set the expectation: an
 * agent told there are eleven modified files and no commits knows before it looks that nothing
 * there has been reviewed by anyone, including the process that wrote it.
 */
export function resumeSection(worktree: HeldWorktree | null | undefined): string {
  if (!worktree) return '';

  const left = [
    worktree.commits
      ? `${worktree.commits} commit(s) on this branch that the default branch does not have`
      : null,
    worktree.changes ? `${worktree.changes} path(s) with uncommitted changes` : null,
  ].filter(Boolean).join(', and ') || 'no visible change';

  return `\n\n---\n\nYou are resuming an implementation that was interrupted. A previous attempt at
this issue ran in this same checkout and its process died before it finished — it was not
cancelled, and it did not report anything. What it left behind is here: ${left}.

None of that was reviewed, verified or explained, and nothing recorded why any of it was
written. So read it before you write anything: \`git status\`, \`git diff\`, and \`git log\`
against the default branch. Then decide whether to build on it or to discard it and start the
change again, and say which you chose and why in the pull request. Do not assume it is correct
because it is there, and do not begin writing on top of it without having looked.`;
}

/** What a run that ended without landing anything left for the attempt that follows it. */
export interface UnfinishedRun {
  /** The pull request the previous attempt opened, or null when it opened none. */
  pullRequest: string | null;
  /** What it left in this checkout, when it left anything. */
  worktree: HeldWorktree | null;
}

/**
 * The section that says the previous attempt was *this run*, and what it failed to do.
 *
 * Distinct from `resumeSection`, and the distinction is the whole reason this exists.
 * That one is addressed to an agent picking up a stranger's checkout after a *server* died —
 * so it says "none of this was reviewed, read it before you trust it". Here the previous
 * attempt was this same board, minutes ago, working from this same prompt: the work is not
 * suspect, it is unfinished, and telling an agent to consider discarding it would invite it to
 * redo a change that is already correct.
 *
 * **What is missing differs, so the text does.** With no pull request there is a change to
 * finish and open one for; with a pull request already open the only thing missing is the merge,
 * and an agent not told that opens a second one — nothing downstream counts pull requests, so
 * two for one issue is an error nowhere.
 *
 * **It names the defect**, because the recovery runs in the same headless mode with the same
 * tendency. Both runs this was written for ended their turn while a background `npm test` was
 * still going, believing something would call them back; in `claude -p` nothing does.
 *
 * **And it refuses to force a merge.** The marker is how a deliberate stop is recorded, but an
 * agent that stopped for a person and forgot to print it would be recovered as though it had
 * simply walked away. So the second attempt is told to check for that before merging anything —
 * a guard that does not depend on the first agent having remembered its own signal.
 */
export function unfinishedSection(previous: UnfinishedRun | null | undefined): string {
  if (!previous) return '';

  const left = previous.worktree
    ? [
        previous.worktree.commits
          ? `${previous.worktree.commits} commit(s) on this branch that the default branch does not have`
          : null,
        previous.worktree.changes ? `${previous.worktree.changes} path(s) with uncommitted changes` : null,
      ].filter(Boolean).join(', and ') || 'no visible change'
    : 'no visible change';

  const missing = previous.pullRequest
    ? `A pull request is already open for this work: ${previous.pullRequest}. **Do not open another
one.** What is missing is the merge. Bring the branch up to date with the default branch, make
sure the checks pass, and merge that pull request.`
    : `No pull request was ever opened. What is in this checkout is ${left}. Finish the change,
push the branch, and open the pull request.`;

  return `\n\n---\n\nYou are finishing a run that stopped short. The previous attempt was this same
board working from this same prompt, minutes ago — the work in this checkout is yours, not a
stranger's, and it did not finish rather than going wrong. Read it before you add to it, but do
not start the change again on the assumption that it is suspect.

${missing}

**How the previous attempt failed, so that you do not repeat it.** It ended its turn while it was
still waiting for something in the background — a test suite, usually — believing it would be
called back when that finished. It is not: this is a non-interactive run, and the turn ending is
the process ending. So wait in the foreground. Do not put the wait itself in the background, and
do not end a turn while anything you started is still pending. Whatever the last thing you do is,
the pull request URL is what you print after it.

**One thing to check before you merge anything.** The previous attempt may have left the pull
request open deliberately, because it hit a conflict it could not honestly reconcile and stopped
for a person. Look at the pull request and the branch first. If that is what happened, do not
merge over it — print \`${ESCALATION_MARKER}: <pull request URL>\` and stop, exactly as it should
have.

This is the **last** attempt. Nothing will try again after you.`;
}

export async function runImplementAgent(
  workspace: Workspace,
  issueUrl: string,
  options: {
    agentCommand: string;
    timeoutMs?: number | null;
    /** Named when the command turns out not to exist where it was run. See RunAgentOptions. */
    notFoundVariable?: string | null;
    worktree?: ImplementWorktree | null;
    /**
     * What a previous attempt left in that worktree, when this run is resuming one.
     *
     * Null for every ordinary run, which is what keeps the prompt unchanged for one.
     */
    resuming?: HeldWorktree | null;
    /**
     * What this same run left behind when it ended without landing anything.
     *
     * Null for a first attempt, which is what keeps the prompt unchanged for one. Distinct from
     * `resuming`: that is a stranger's checkout after a server died, this is our own run being
     * finished. Both can never be set at once — a resumed run that stops short reaches this on
     * its second pass and the resume paragraph has already been said.
     */
    unfinished?: UnfinishedRun | null;
    /**
     * Where the run's token totals go while it runs, for a command that streams them.
     *
     * Passed through rather than handled here: what the totals mean is the agent's
     * business, and where they are shown is the server's. Note what it does **not**
     * change — the prompt. Whether the agent reports usage is a property of the command
     * line the operator wrote, so nothing about it is worth telling the agent.
     */
    onUsage?: (usage: AgentUsage) => void;
    /**
     * Where the board would like to show the run, when it has somewhere to show it.
     *
     * Passed through untouched, and note what it does **not** change: the prompt. Whether a
     * reader can watch a run is a fact about the board it was started from, and telling the
     * agent about it would make the same run send two different prompts on two boards.
     */
    host?: AgentHost | null;
  }
): Promise<AgentRun> {
  const worktree = options.worktree ?? null;
  // Workspace first, environment second. `IMPLEMENT_TIMEOUT_MS` stays what it always was:
  // the board's own default, now the value a project falls back to rather than the only
  // value there is.
  const settings = workspace.agents?.implement ?? null;
  // Before the worktree is used and before anything is spawned: a project that configured a
  // workflow the board cannot read gets a refusal naming the file, not a run that quietly
  // works the way it always did.
  const workflow = await loadAgentWorkflow(workspace, 'implement', settings);
  // No code, because nothing was spawned: a project whose workflow file cannot be read is a
  // refusal to fix rather than a run to try again.
  if (!workflow.ok) return { ok: false, url: null, output: '', code: null, error: workflow.error };

  const prompt = `${IMPLEMENT_AGENT_PROMPT}\n\n---\n\nThe issue to implement:\n\n${issueUrl}`
    + worktreeSection(worktree)
    // After the worktree paragraph, because it is about what is *in* the checkout that one
    // has just introduced — and because that paragraph ends by saying a worktree is kept when
    // work is left in it, which is precisely how this one came to exist.
    + resumeSection(options.resuming ?? null)
    // After both, because it is about what *this* run just failed to do rather than about the
    // checkout — and it ends by naming the one thing the agent must not repeat, which is worth
    // being the last board-written words before the project's own.
    + unfinishedSection(options.unfinished ?? null)
    // Last of all, and deliberately: everything above is what this board tells every agent,
    // and the project's own workflow has to be the last thing a literal reader is told.
    + workflowSection(workflow.text);
  return runAgent(workspace, prompt, {
    agentCommand: applyAgentSettings(options.agentCommand, settings),
    timeoutMs: options.timeoutMs === undefined
      ? settings?.timeoutMs ?? IMPLEMENT_TIMEOUT_MS
      : options.timeoutMs,
    expects: 'pull',
    notFoundVariable: options.notFoundVariable ?? null,
    what: 'implement agent',
    directory: worktree,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
    ...(options.host ? { host: options.host } : {}),
  });
}
