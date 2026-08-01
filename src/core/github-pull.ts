/**
 * Reading back the pull request a run says it produced.
 *
 * The one question this answers is whether the thing landed, and it exists because nothing was
 * asking it. A run was recorded `done` on the strength of a URL appearing in the agent's stdout
 * — a fact about stdout, not about the repository — and on 2026-07-31 two runs out of eight
 * opened a pull request, never merged it, printed the URL and exited zero. Both were recorded as
 * successes while their pull requests stayed open and their issues stayed open.
 *
 * Deliberately one field's worth of reading rather than a `PullRequestDetail` beside
 * `IssueDetail`. Nothing here renders a pull request; the only consumer is a decision about a
 * record, and a type carrying a body and a comment list would be four more fields for an older
 * `gh` to reject on a call whose failure has to be harmless.
 */
import { Workspace } from './workspaces.js';
import { runGh } from './gh.js';

/**
 * Pull request URLs come from our own extraction, but this is what gets interpolated into a
 * command line — and a WSL workspace runs that line through `bash -lc`. Nothing reaches `gh`
 * without matching this first.
 */
const PULL_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;

export function isPullUrl(url: string): boolean {
  return PULL_URL.test(url);
}

/**
 * Whether a pull request landed, or `null` for "nobody could say".
 *
 * `null` is the important value and it is not an error state: it is what a `gh` blip, an
 * expired login and a machine with no CLI on its PATH all produce, and every caller has to
 * treat it as "learned nothing" rather than as bad news. A verification that turned a failed
 * read into a failed run would be worse than no verification at all — it would invent defeats
 * for runs that won.
 *
 * `absent` is the one failed read that is not `null`, and it is here because reading them the
 * same way cost a day. A run for issue #326 printed a pull request it had never opened; GitHub
 * answered `Could not resolve to a PullRequest`, which arrived as `null`, which rule 3 of
 * `landingFor` reads as "believe the run" — so the record said `done`, the automatic recovery
 * from #415 was never considered, and the seven cards waiting on that issue waited for good.
 * A repository denying that a pull request exists is not a failure to learn something; it is
 * the strongest evidence available that nothing landed.
 */
export type PullLanding = 'merged' | 'open' | 'closed' | 'absent' | null;

/**
 * GitHub's own words for "there is no such pull request", which is the only thing separating
 * this from a blip — both are a `gh` that exited non-zero.
 *
 * Matched against `runGh`'s error, which carries the tail of `gh`'s stderr verbatim
 * (`gh.ts`). Deliberately narrow: anything this pattern does not recognise stays `null` and
 * keeps the old, conservative reading, so a wording GitHub changes tomorrow costs a retry of
 * the defect rather than a wave of invented failures.
 */
const NO_SUCH_PULL = /could not resolve to a pullrequest/i;

/** What a run's own pull request is asked for. Two signals for one fact, see below. */
const FIELDS = 'state,mergedAt';

/**
 * Ask GitHub what became of one pull request.
 *
 * Never throws. Every failure — a URL that is not a pull request, a `gh` that cannot run, a
 * body that will not parse — is `null`, because the caller's answer to all of them is the same
 * and a caller that had to catch would be one `try` away from the failure this is guarding.
 * The single exception is a `gh` that failed *because GitHub said there is no such pull
 * request*, which is an answer rather than a silence and is reported as `absent`.
 *
 * `state` and `mergedAt` are both read for one fact. `state` is the plain answer; `mergedAt`
 * corroborates it, so a `gh` old enough or odd enough to spell the state differently still
 * cannot make a merged pull request look open. They disagree in only one direction that
 * matters, and it is the direction where believing "open" would be the expensive mistake.
 */
export async function fetchPullLanding(
  workspace: Workspace,
  pullUrl: string
): Promise<PullLanding> {
  if (!isPullUrl(pullUrl)) return null;

  let stdout: string;
  try {
    stdout = await runGh(workspace, `pr view ${pullUrl} --json ${FIELDS}`, {
      what: 'the pull request',
      timeoutMs: 30_000,
    });
  } catch (error) {
    // Logged by `runGh` already, once per attempt, with the reason. A second line here would
    // say the same thing in a place that cannot add to it.
    return NO_SUCH_PULL.test((error as Error)?.message ?? '') ? 'absent' : null;
  }

  try {
    const payload = JSON.parse(stdout) as { state?: unknown; mergedAt?: unknown };
    const state = typeof payload.state === 'string' ? payload.state.toUpperCase() : null;
    const mergedAt = typeof payload.mergedAt === 'string' && payload.mergedAt.length > 0;
    if (state === 'MERGED' || mergedAt) return 'merged';
    if (state === 'OPEN') return 'open';
    if (state === 'CLOSED') return 'closed';
    return null;
  } catch {
    return null;
  }
}
