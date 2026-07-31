/**
 * What a finished implementation actually amounted to.
 *
 * `done` used to mean "a pull request URL appeared somewhere in the agent's stdout". That is a
 * fact about stdout rather than about the repository, and on 2026-07-31 it was wrong for two of
 * eight runs: issues #314 and #315 each opened a pull request, never merged it, printed the URL
 * and exited zero. Both were recorded as successes while their pull requests stayed open, their
 * issues stayed open, and their cards stayed in In Progress — the board reporting a finished run
 * and work in flight for the same issue at the same time.
 *
 * Pure, and separate from the reading that feeds it. The `gh` call lives in `github-pull.ts`;
 * what is here is only the decision, so the four outcomes can be read in one place and argued
 * about without a network anywhere near them.
 */

import { PullLanding } from './github-pull.js';

/**
 * What an agent prints instead of a bare URL when it is stopping on purpose.
 *
 * The implement prompt has always sanctioned one way of ending without a merge: *"If you
 * genuinely cannot reconcile them, leave the pull request open, say which files and what the
 * disagreement is, and stop."* From outside, that agent and one that walked away mid-sentence
 * are identical — both exited zero having printed a URL for an open pull request. Nothing can
 * tell them apart except the participant that knows which one it is, so the prompt asks for
 * this and this is what it asks for.
 *
 * Searched for anywhere in the output rather than only on the last line, for the same reason
 * `extractGithubUrl` is: a streaming agent's stdout is `stream-json`, so everything it says
 * arrives wrapped in a JSON string and nothing it says is ever the last line.
 *
 * Case-sensitive. The prompt gives the exact words, and prose about needing a person is
 * otherwise easy to write by accident — a false positive here costs a run its automatic
 * recovery, which is the direction that asks a human rather than the direction that acts.
 */
export const ESCALATION_MARKER = 'NEEDS A PERSON';

export function saidItNeedsAPerson(output: string): boolean {
  return output.includes(ESCALATION_MARKER);
}

/**
 * `blocked` is the state for a run that ended correctly without landing anything.
 *
 * Not `failed`, because nothing failed — the agent hit the case its prompt describes and did
 * what it was told. Not `done`, because nothing shipped. It exists so that whatever reads this
 * signal next cannot send a second agent to force a merge the first one refused on purpose.
 */
export interface Landing {
  state: 'done' | 'failed' | 'blocked';
  url: string | null;
  error: string | null;
}

export interface LandingInput {
  /** `agentOutcome`'s verdict: the process exited zero *and* printed a URL. */
  ok: boolean;
  url: string | null;
  error: string | null;
  /** Everything the agent wrote, which is where the marker is looked for. */
  output: string;
  /** What GitHub says became of `url`, or null for "nobody could say". */
  pull: PullLanding;
}

/**
 * Decide the record from the run and from what GitHub says about its pull request.
 *
 * Four rules, and the third is the one that keeps this from being worse than no verification
 * at all.
 *
 * 1. **No pull request** — unchanged in every particular. This path never asks GitHub anything
 *    and never did; a run that produced nothing is exactly as failed as it was before.
 * 2. **A non-zero exit** — failed, as before, but the URL now survives. The old branch wrote
 *    `url: null`, so a board that had just been told where the pull request was threw it away.
 * 3. **`pull` is null** — the outcome stands. A `gh` blip, an expired login and a machine with
 *    no CLI all arrive here, and a verification that turned any of them into a failure would
 *    invent defeats for runs that won. Believing the run is the conservative answer because it
 *    is the answer this code gave before it could ask.
 * 4. **Merged, or not** — the fact the whole change exists for.
 */
export function landingFor(input: LandingInput): Landing {
  if (!input.url) {
    return { state: 'failed', url: null, error: input.error };
  }
  if (!input.ok) {
    return { state: 'failed', url: input.url, error: input.error };
  }
  if (input.pull === null || input.pull === 'merged') {
    return { state: 'done', url: input.url, error: null };
  }

  const what = input.pull === 'open'
    ? `${input.url} is still open`
    : `${input.url} was closed without merging`;

  if (saidItNeedsAPerson(input.output)) {
    return {
      state: 'blocked',
      url: input.url,
      error: `The run stopped and asked for a person: ${what}. `
        + 'Nothing here failed — read the pull request and decide.',
    };
  }

  return {
    state: 'failed',
    url: input.url,
    error: `The run ended without landing anything: ${what}. `
      + 'The agent printed the pull request and exited without merging it, so the issue is '
      + 'still open and its card has not moved.',
  };
}
