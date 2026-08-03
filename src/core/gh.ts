/**
 * Running `gh` inside a workspace.
 *
 * The GitHub CLI is this server's only client for GitHub, and that is a decision rather
 * than an omission: it is already required by the issue agent, and the two traps around it —
 * a PATH without the CLI on it, and a WSL project whose paths only make sense inside the
 * distro — are already solved in `issue-agent.ts`. A second HTTP client would have to pay for
 * both again, plus a token to store.
 *
 * **What the login does not come with is the `project` scope.** `gh auth login` asks for
 * `repo`, `read:org`, `gist` and `workflow`; both halves of the mirror — the `gh api graphql`
 * read and the `gh project item-edit` write — need `read:project` on top of those, so on a
 * fresh clone they fail until `gh auth refresh -s project` has been run once. That command is
 * what `classifyGhFailure` puts in front of the reader, because GitHub's own answer is four
 * lines of token inventory that never names it (#319).
 */
import { spawn } from 'child_process';
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { agentPath, buildAgentCommand, singleQuoted, tokenizeCommand } from './issue-agent.js';
import type { AgentInvocation } from './agent-adapter.js';
import { env } from './settings.js';

/**
 * The `gh` invocation for one workspace. Overridable so a check script can answer without
 * a real GitHub account behind it.
 *
 * **Per workspace, because a command is a path and a path does not cross into a distro.**
 * `EXCALIDRAW_GH_COMMAND` is read on a machine where the CLI is not on `PATH`, so its value
 * is an absolute host path — and a WSL workspace runs its command line through `bash -lc`,
 * where `C:\Program Files\GitHub CLI\gh.exe` is not a file that can exist. Read once for the
 * whole server, that variable took the mirror off every distro-backed board the moment it
 * was set, and took the issue panel, a dragged card and both of a run's moves with it (#252).
 * `agentCommandFor` settles the same question for the agents; this is the half that was
 * missed.
 *
 * **The WSL half does not fall back to the host override**, which is where this parts company
 * with `agentCommandFor`. There the fallback is what keeps a bare `claude -p …` working in
 * both environments, and an unset command means the feature is off entirely — so falling back
 * is the difference between working and disabled. Here an unset override means "the CLI is on
 * `PATH`", which each environment answers for itself, and `gh` is the answer that is right in
 * both. Falling back to the host's path is not a weaker guess than `gh`; it is the defect, and
 * it can only ever produce `command not found`.
 *
 * Read at call time rather than at import, so a workspace resolves against the environment
 * the server is actually holding. Every check that stubs `gh` sets the variable before the
 * server starts, which is earlier either way.
 */
export function ghCommandFor(workspace: Workspace): string {
  if (workspace.environment.kind === 'wsl') {
    return env('GH_COMMAND_WSL')?.trim() || 'gh';
  }
  return env('GH_COMMAND')?.trim() || 'gh';
}

/**
 * How many times to run `gh` before giving up, and how long to wait between tries.
 *
 * `gh` intermittently fails here with socket buffer exhaustion and succeeds on the next
 * attempt seconds later. Without a retry that fault reaches the canvas as a hard error,
 * which reads as a broken feature rather than as the blip it is.
 *
 * This is the policy for a failure that *might* be a blip. A failure that cannot ever succeed
 * is spared it by `classifyGhFailure` below.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [400, 1200];

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The one thing to go and do about each failure that will not fix itself.
 *
 * Literal commands rather than descriptions. The reader is looking at a canvas that has just
 * said the mirror could not be read; a sentence they can copy is the difference between that
 * and a search.
 *
 * **Exported because a producer composes founder-facing steps out of these strings**, and the
 * alternative to naming them is restating them. Two copies of one sentence is how two authors
 * of one remedy start to drift, and the drift is invisible until a reader is following the
 * older half (#534).
 */
export const REMEDY = {
  install: 'Install the GitHub CLI, or set EXCALIDRAW_GH_COMMAND (EXCALIDRAW_GH_COMMAND_WSL for '
    + 'a project inside a distro) to where it lives.',
  login: 'Run "gh auth login".',
  scope: 'Run "gh auth refresh -s project" — a default "gh auth login" does not ask for that '
    + 'scope, and the project board needs it.',
  credential: 'Run "gh auth status" and log in again: GitHub refused the credential this gh '
    + 'holds.',
  target: 'Check the owner, repository or project number in the URL, and that the account this '
    + 'gh is logged in as can see it.',
  /**
   * Nothing is misconfigured and there is no command to run — the only move is to stop asking
   * for a while. Said out loud because the failure this answers arrives as an HTTP 403, which
   * for years read as "you cannot see that": a founder who has hit a rate limit was being sent
   * to re-check a URL that was perfectly correct.
   */
  wait: 'Wait for GitHub to let this account through again — a minute or two for a secondary '
    + 'limit, up to an hour for the hourly one — and then try the same thing again. Nothing '
    + 'here is misconfigured.',
  /**
   * Payment, not permission, which is why it names a page rather than the URL: no wait clears
   * an unpaid account and no re-check of the owner or the number is going to find anything
   * wrong with them.
   */
  billing: 'Check this account\'s billing at https://github.com/settings/billing and top up or '
    + 're-enable it: GitHub refused this over payment rather than over permission, so the URL '
    + 'and the login are both fine.',
  /** Nothing for a person to do: the caller handles it and there is no second attempt to make. */
  none: '',
} as const;

/**
 * How many seconds GitHub asked to be left alone for, when it said.
 *
 * "If the `retry-after` response header is present, you should not retry your request until
 * after that many seconds has elapsed" — the REST rate-limit documentation. It is a header
 * rather than part of the message, so it is there for some rate limits and absent for others,
 * and a remedy that invented a number for the second kind would be worse than one that stays
 * quiet. Nothing is appended when there is nothing to append.
 *
 * @see https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
function retryAfter(said: string): string {
  const match = /retry[-\s]?after:?\s*(\d+)/i.exec(said);
  if (!match) return '';
  const seconds = Number(match[1]);
  return ` GitHub asked for ${seconds} second${seconds === 1 ? '' : 's'}.`;
}

/**
 * What a failing `gh` said, and whether asking again could change the answer.
 *
 * Matched against the whole of `gh`'s output rather than against the message a caller ends up
 * with: that one is the last 300 characters of stderr, and GitHub's scope refusal is longer
 * than that — the half naming the scope is the half that gets cut.
 *
 * **Order matters, most specific first.** A missing scope is also an authentication failure
 * and may also arrive as an HTTP 403, and only the first of those three names the command
 * that fixes it. A rate limit and a billing refusal wear that same 403, which is why they sit
 * above the row that reads one as a URL nobody can resolve (#534).
 *
 * **A class is not the same question as a retry.** Most of these can never succeed, but the
 * rate limit is a founder-blocking condition that a wait really does clear, so it is named
 * *and* retried: `terminal` is per row rather than a property of being in this table at all.
 *
 * The last rule is the one that keeps this honest: text nothing here recognises is *not*
 * terminal. Matching another tool's prose is matching something that changes between
 * releases and between locales, so the fallback has to be the old behaviour — retry — rather
 * than a refusal invented from a pattern that stopped matching.
 */
const CLASSES: ReadonlyArray<{
  pattern: RegExp;
  remedy: string;
  /** Whether asking again could ever change the answer. */
  terminal: boolean;
  /** Anything the failure itself can add to the remedy, appended with its own leading space. */
  detail?: (said: string) => string;
}> = [
  // The spawn never happened: no such binary, or one that cannot be executed. `command not
  // found` is the same fact through a WSL workspace, where the spawn that succeeds is
  // `wsl.exe` and the CLI is missing one layer further in — the shape #252 was, and the one
  // shape of "gh is absent" that can never arrive as an errno.
  { pattern: /\b(ENOENT|EACCES|ENOTDIR)\b|command not found/i, remedy: REMEDY.install, terminal: true },
  // gh's own pre-flight ("missing required scopes"), and GitHub's answer to a query the token
  // may not make. Both are one `gh auth refresh` away.
  {
    pattern: /missing required scope|not been granted the required scope|requires one of the following scopes|auth refresh -s/i,
    remedy: REMEDY.scope,
    terminal: true,
  },
  { pattern: /bad credentials|\bHTTP 401\b/i, remedy: REMEDY.credential, terminal: true },
  { pattern: /gh auth login|not logged in|no default host configured/i, remedy: REMEDY.login, terminal: true },
  // Money, above the row that would read the same 403 as a wrong URL. `quota[ _]exceeded`
  // rather than a space alone because the API answers with the error code, underscore and all,
  // where the prose says "quota exceeded".
  { pattern: /\bHTTP 402\b|payment required|billing|quota[ _]exceeded/i, remedy: REMEDY.billing, terminal: true },
  // Rate limiting, above that row for the same reason and *not* terminal. GitHub sends both
  // primary and secondary limits as a 403 or a 429, so the status alone cannot tell this from
  // the row below; the prose can. `\bHTTP 429\b` is in the pattern because the status is the
  // only thing some of them say — "Too Many Requests" and nothing else.
  {
    pattern: /rate limit|secondary rate|abuse detection|retry-after|\bHTTP 429\b/i,
    remedy: REMEDY.wait,
    terminal: false,
    detail: retryAfter,
  },
  { pattern: /could not resolve to an?\b|\bHTTP 40[34]\b/i, remedy: REMEDY.target, terminal: true },
  // A field this `gh` does not know. Deterministic, and `fetchIssue` answers it by asking for
  // less rather than by asking again.
  { pattern: /unknown json field/i, remedy: REMEDY.none, terminal: true },
];

/**
 * Whether a failure can ever succeed on another attempt, and what to go and do about it.
 *
 * The two are independent. A rate limit names something to do — wait — and is still worth
 * asking again; only a failure nothing here recognises has neither.
 */
export interface GhFailure {
  terminal: boolean;
  remedy: string;
}

/**
 * Read one `gh` failure and say whether it is worth repeating.
 *
 * Exported because it is the policy rather than an implementation detail: `github-issue.ts`
 * used to hold a second copy of the retry constants and its own opinion, and one classifier
 * with one caller is how that stays impossible.
 */
export function classifyGhFailure(said: string): GhFailure {
  for (const { pattern, remedy, terminal, detail } of CLASSES) {
    if (pattern.test(said)) return { terminal, remedy: `${remedy}${detail?.(said) ?? ''}` };
  }
  return { terminal: false, remedy: '' };
}

/**
 * A failure no retry can fix, carrying the sentence that fixes it.
 *
 * The remedy goes in `message` as well as in its own field, because the message is what
 * travels: the route turns it into a 502 body, and the canvas says that out loud (#317). A
 * remedy only a typed field carried would stop at the first `catch` that reads `.message`.
 */
export class TerminalGhFailure extends Error {
  /** What `gh` said, without our sentence on the end. */
  readonly said: string;
  /** The literal command or step that fixes it, or `''` when there is nothing to name. */
  readonly remedy: string;

  constructor(said: string, remedy: string) {
    super(remedy ? `${said} ${remedy}` : said);
    this.name = 'TerminalGhFailure';
    this.said = said;
    this.remedy = remedy;
  }
}

/**
 * The error a failed `gh` becomes.
 *
 * `said` is what the caller will read; `full` is everything `gh` printed, which is what the
 * classifier is given. They differ for a non-zero exit, where the message is truncated.
 */
function ghFailure(said: string, full: string = said): Error {
  const failure = classifyGhFailure(full);
  return failure.terminal ? new TerminalGhFailure(said, failure.remedy) : new Error(said);
}

export interface RunGhOptions {
  /** Ceiling on one attempt. These are single API calls, not agent runs. */
  timeoutMs?: number;
  /** Named in log lines and in the error a caller shows. */
  what: string;
  /**
   * Set to 1 for a call whose failure is deterministic and not worth repeating.
   *
   * Rarely needed now: `classifyGhFailure` answers this per failure rather than per call
   * site, which is the half no caller was ever going to get right in advance. What is left
   * for this is a caller that knows something the text cannot say — a probe whose failure is
   * the answer it wanted.
   */
  attempts?: number;
  /**
   * Text written to `gh`'s stdin, for a flag that reads one — `--body-file -`.
   *
   * This is the only way free text can reach `gh` from here. The command line is a string
   * that a WSL workspace runs through `bash -lc`, so a comment containing `$(echo hi)`
   * interpolated into it would be executed rather than posted; stdin is a byte stream with
   * no shell anywhere near it. Every attempt writes it again, which is what makes a retry
   * a repeat rather than an empty call.
   */
  stdin?: string;
}

/**
 * Run one `gh` command line and return its stdout.
 *
 * `commandLine` is appended to the workspace's `gh` and must already be shell-safe: a WSL
 * workspace runs it through `bash -lc`, so anything interpolated into it has to be
 * validated by the caller rather than escaped here. Every caller in this project
 * interpolates only ids matched against a pattern first.
 *
 * Text that cannot be validated that way — anything a person typed — goes in
 * `options.stdin` instead, paired with the flag that reads it, or on an **argv** rather than
 * on a line: see the array form just below.
 */
export async function runGh(
  workspace: Workspace,
  commandLine: string | readonly string[],
  options: RunGhOptions
): Promise<string> {
  const attempts = options.attempts ?? ATTEMPTS;
  let lastError: Error = new Error('gh was never run');

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await runOnce(workspace, commandLine, options);
    } catch (error) {
      // A failure that cannot succeed does not get a second chance. Three tries and 1.6
      // seconds of waiting turn a missing scope into a slow missing scope, and the wait is
      // paid by the canvas, which is showing nothing while it happens.
      if (error instanceof TerminalGhFailure) throw error;
      // Report the last failure, not the first: it describes what kept happening.
      lastError = error as Error;
      if (attempt < attempts - 1) {
        logger.warn(`gh failed running ${options.what} (attempt ${attempt + 1}/${attempts}): ${lastError.message}`);
        await wait(BACKOFF_MS[attempt] ?? 1200);
      }
    }
  }

  throw lastError;
}

/**
 * The same call as an argv, for text no command line can carry.
 *
 * The third way in, and the narrowest. `options.stdin` is the answer wherever `gh` has a
 * `--body-file -` to read, and it is the answer for everything a person typed — but
 * `gh project item-create` has `--title` and `--body` and no file flag of any kind, so a
 * founder action's rendered body has to arrive as an *argument*. A line cannot carry it: a
 * native workspace parses one with `tokenizeCommand`, where a value holding a single quote
 * cannot be spelled at all, and a WSL workspace parses it with `bash`, where a backtick or a
 * `$(…)` in somebody's stderr would be executed rather than posted.
 *
 * So the elements are kept apart to the end. Natively `spawn` hands them to the process as they
 * are, quotes, newlines and dollars included; inside a distro each one is `singleQuoted`, which
 * is the one quoting in `sh` that means no expansion at all. The workspace's own `gh` command is
 * left exactly as the operator wrote it — it may itself be several tokens, `node "<stub>"` in
 * every check that stubs one — and only what this caller adds is quoted.
 */
function ghInvocation(gh: string, argv: readonly string[]): AgentInvocation {
  const [command, ...rest] = tokenizeCommand(gh);
  return {
    command: command ?? gh,
    args: [...rest, ...argv],
    // Nothing here delivers a prompt: `buildAgentCommand` is asked for none, so this says only
    // what is to become of stdin, and `options.stdin` above is what writes to it.
    prompt: { via: 'argv', stdin: 'closed' },
    line: `${gh} ${argv.map(singleQuoted).join(' ')}`,
  };
}

function runOnce(
  workspace: Workspace,
  commandLine: string | readonly string[],
  options: RunGhOptions
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const gh = ghCommandFor(workspace);
  const { command, args, cwd } = buildAgentCommand(
    workspace,
    typeof commandLine === 'string' ? `${gh} ${commandLine}` : ghInvocation(gh, commandLine)
  );

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: agentPath() },
      windowsHide: true,
    });

    if (options.stdin !== undefined) {
      // `gh` may exit before it reads any of this — a refused command, say — and an
      // EPIPE from that must not become the error the caller reports.
      child.stdin?.on('error', () => { /* nothing left to write to */ });
      child.stdin?.end(options.stdin);
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Timed out running ${options.what} after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // `spawn … ENOENT` is a CLI that is not there, which no wait can change.
      reject(ghFailure(error.message));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // A raw `gh` stderr is more useful in the canvas than "request failed"; the caller
      // has no better context to add. The whole of it goes to the classifier and only the
      // tail to the reader, because the truncation is what hid the scope refusal.
      const said = stderr.trim();
      if (code !== 0) reject(ghFailure(said.slice(-300) || `gh exited with code ${code}`, said));
      else resolve(stdout);
    });
  });
}
