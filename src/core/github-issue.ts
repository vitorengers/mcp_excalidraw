/**
 * Reads a GitHub issue back through `gh`, so a finished block can show what it produced.
 *
 * Deliberately a read at selection time rather than a copy taken at creation time. An
 * issue body is kilobytes; stored on the element it would ride in every autosync payload
 * and every export, and would still be a snapshot — stale the moment anyone edits the
 * issue on GitHub. Only the title is kept on the element, because a card has to read
 * correctly with nothing selected and with no network.
 */
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { runGh as runGhCommand } from './gh.js';
import { issueUrlRefusal } from './github-host.js';

/** How long a read may take. Far shorter than an agent run — this is one API call. */
const TIMEOUT_MS = 30_000;

/**
 * Issue URLs come from our own extraction, but this is what gets handed to a shell-less spawn.
 *
 * `github.com` is spelled here rather than assembled, and it is a requirement rather than a
 * default — `github-host.ts` is where that decision is written down, and where the refusal
 * below comes from.
 */
const ISSUE_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/;

/**
 * One comment on the issue.
 *
 * Only the four fields the panel renders. `gh` returns a good deal more per comment —
 * reaction groups, minimisation, viewer flags — and none of it is worth carrying through
 * to a card that is showing an issue at a glance.
 */
export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface IssueDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  /**
   * The conversation under the body.
   *
   * Read with the issue rather than on demand: it is one `--json` field on a call that is
   * already being made, and an observation added from the panel is only worth adding if
   * it can be seen afterwards.
   */
  comments: IssueComment[];
  /** `COMPLETED`, `NOT_PLANNED`, or null — why it is closed, when it is. */
  stateReason: string | null;
  /**
   * The pull requests GitHub says closed it, usually one and occasionally none.
   *
   * Asked for rather than inferred. "Closed" and "closed by a pull request" are different
   * facts, and `gh` has answered the second since 2.62 — so the panel says which it is
   * instead of drawing a gap where a link should have been.
   */
  closedBy: ClosingPullRequest[];
}

export interface ClosingPullRequest {
  number: number;
  url: string;
}

/** What the panel needs, and what a `gh` old enough to refuse the last two can still give. */
const FIELDS = 'number,title,body,state,comments,stateReason,closedByPullRequestsReferences';
const FIELDS_WITHOUT_CLOSURE = 'number,title,body,state,comments';

export function isIssueUrl(url: string): boolean {
  return ISSUE_URL.test(url);
}

/**
 * Fetch one issue.
 *
 * How often a failing `gh` is asked again is not decided here. This file kept its own
 * `ATTEMPTS` and `BACKOFF_MS`, and its own policy — retry everything, because matching a
 * localised OS message is not something to depend on — which meant a `gh` that is not
 * installed, or a login without the `project` scope, was asked three times over 1.6 seconds
 * to give the same answer, once per panel opened. `runGh` owns that now, and
 * `classifyGhFailure` is the one place that reads a failure and says whether repeating it
 * could help (#319).
 */
export async function fetchIssue(workspace: Workspace, issueUrl: string): Promise<IssueDetail> {
  try {
    return await readIssue(workspace, issueUrl, FIELDS);
  } catch (error) {
    // Dropped to the older field list once a `gh` says it does not know the newer one.
    // Without this, adding a field to the query would turn every issue read on an older CLI
    // into a hard error in the panel — a regression paid by everyone, for a link.
    //
    // It costs one refused call rather than three, because an unknown field is deterministic
    // and `classifyGhFailure` says so: the second query is a different question, not a
    // repeat of the first.
    if (!/unknown json field/i.test((error as Error).message)) throw error;
    logger.warn(`gh does not know what closed an issue; reading ${issueUrl} without it`);
    return readIssue(workspace, issueUrl, FIELDS_WITHOUT_CLOSURE);
  }
}

/** A response `gh` returned but we could not read — never worth retrying. */
class MalformedResponse extends Error {}

/**
 * The comment list out of a `gh` payload, narrowed to what the panel shows.
 *
 * Tolerant on purpose: an issue with no comments, a `gh` too old to know the field, and a
 * comment whose author has since been deleted all mean "nothing to render here", not "the
 * issue could not be read".
 */
function readComments(raw: unknown): IssueComment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const comment = (entry ?? {}) as Record<string, unknown>;
    const author = (comment.author ?? {}) as Record<string, unknown>;
    return {
      author: String(author.login ?? ''),
      body: String(comment.body ?? ''),
      createdAt: String(comment.createdAt ?? ''),
      url: String(comment.url ?? ''),
    };
  });
}

/**
 * Add a comment to an issue.
 *
 * The board's way of answering a question the issue agent left open, or of adding what was
 * forgotten when the observation was written. A GitHub comment rather than an edit to the
 * body: it is the one place both a human reviewer and the implement agent can read it, and
 * it cannot damage a body an agent spent twenty minutes on.
 *
 * `--body-file -` and `options.stdin`, never the command line. The body is free text and a
 * WSL workspace runs the command line through `bash -lc`, so a comment containing
 * `$(echo hi)` would be executed rather than posted. The URL is the only thing interpolated
 * and it is pattern-matched first.
 *
 * Retried like every other `gh` call here, which for a write is a deliberate trade: the
 * failure this machine actually produces is socket buffer exhaustion at connect time, where
 * a retry is the difference between a lost comment and none. A duplicate is the price if a
 * call ever fails after GitHub accepted it.
 */
export async function commentOnIssue(
  workspace: Workspace,
  issueUrl: string,
  body: string
): Promise<void> {
  if (!isIssueUrl(issueUrl)) {
    throw new MalformedResponse(issueUrlRefusal(issueUrl));
  }

  await runGhCommand(workspace, `issue comment ${issueUrl} --body-file -`, {
    what: 'the issue comment',
    timeoutMs: TIMEOUT_MS,
    stdin: body,
  });
}

/**
 * The closing pull requests out of whatever `gh` put in that field.
 *
 * Defensive rather than trusting, because this field is the one that can be absent: a `gh`
 * too old to know it answers without it, and the panel showing no link is a far better
 * outcome than an issue that will not open at all.
 */
function closingPullRequests(value: unknown): ClosingPullRequest[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof (entry as Record<string, unknown>).url === 'string'
      && ((entry as Record<string, unknown>).url as string).length > 0)
    .map((entry) => ({ number: Number(entry.number ?? 0), url: String(entry.url) }));
}

/**
 * One `gh` run, through the shared runner.
 *
 * It used to spawn `gh` here, which is how this file came to own a second copy of the retry
 * policy, a second `ghCommandFor` call site — the one door #252 had to be fixed at twice — and
 * a second answer to what a failure means.
 * Everything that made this call different is now an option on `runGh`, and what is left is
 * the query and the shape of the answer.
 *
 * A rejection carries a message fit to show in the panel: `runGh` reports what `gh` said —
 * the caller has no better context to add — with a remedy on the end when the failure has one.
 */
async function readIssue(
  workspace: Workspace,
  issueUrl: string,
  fields: string
): Promise<IssueDetail> {
  if (!isIssueUrl(issueUrl)) {
    throw new MalformedResponse(issueUrlRefusal(issueUrl));
  }

  const stdout = await runGhCommand(workspace, `issue view ${issueUrl} --json ${fields}`, {
    what: `the read of ${issueUrl}`,
    timeoutMs: TIMEOUT_MS,
  });

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    throw new MalformedResponse(`Could not parse the gh response: ${(error as Error).message}`);
  }

  return {
    number: Number(parsed.number ?? 0),
    title: String(parsed.title ?? ''),
    body: String(parsed.body ?? ''),
    state: String(parsed.state ?? ''),
    url: issueUrl,
    comments: readComments(parsed.comments),
    stateReason: typeof parsed.stateReason === 'string' && parsed.stateReason
      ? parsed.stateReason
      : null,
    closedBy: closingPullRequests(parsed.closedByPullRequestsReferences),
  };
}
