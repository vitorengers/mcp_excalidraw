/**
 * Runs a coding agent inside a workspace to turn an observation into a GitHub issue.
 *
 * This spawns a process with full access to a repository, which is the most dangerous
 * thing this server does. Three guards apply, and none of them is optional:
 *
 *  - it only runs when EXCALIDRAW_ISSUE_AGENT is set, so it cannot be reached by
 *    default on a server that has no authentication;
 *  - it refuses to run unless the server is bound to loopback;
 *  - one run at a time per element, tracked by the caller, so a double click cannot
 *    open two issues.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { AgentUsage, streamsUsage, UsageMeter } from './agent-usage.js';
import { AgentSettings, Workspace } from './workspaces.js';

/** Default instruction. Investigation first, evidence over guesswork, URL last. */
export const ISSUE_AGENT_PROMPT = `You will receive an observation about this project and turn it into a GitHub issue.

Do not write the issue immediately. Investigate this repository first:

1. Look for the root cause. The observation describes symptoms, not diagnoses — what is
   called a bug may be configuration, and what is called a feature may already exist.
   Cite evidence as file:line.
2. Check whether an open issue already covers it (\`gh issue list\`). If one does, comment
   there instead of duplicating, and say that is what you did.
3. Read the project's documentation before proposing a solution. If the answer depends on
   something the repository does not settle, research it — do not invent it.

Then write the issue with: context and the evidence you found, root cause (or the competing
hypotheses, when the investigation is not conclusive), proposed scope, a verifiable
definition of done, and the assumptions you had to make. If the observation is too ambiguous
for a good issue, write what you can and list the open questions — never fill a gap with a
guess presented as fact.

Write the issue in English — title and body. That is fixed: not the language of the
observation, and not the language of the repository you just read, whose documentation may
well be in something else. Every development artifact in this project is English. Quote the
observation verbatim when its exact wording is the evidence; translate everything else.

Create the issue with \`gh\` in this repository, add it to the configured project, and return
only the issue URL on a line of its own.

You may put helpers to work — sub-agents, background tasks, whatever the investigation
needs. Two things stay yours and do not transfer with the work:

- **Creating the issue.** A helper investigates and reports its findings back to you; it
  never runs \`gh issue create\` itself. Nothing downstream counts issues, so three helpers
  that each create one leave three issues for one observation and no error anywhere.
- **Finishing.** Only what *you* print is read. Whoever did the work, and whatever a helper
  already created, you print the issue URL yourself, last, on a line of its own — and you
  wait for every helper to come back before you do. A run that ends without that line leaves
  the board waiting forever on an issue that already exists.`;

/**
 * The instruction for researching an issue that already exists, and rewriting it.
 *
 * The other half of `ISSUE_AGENT_PROMPT`, and deliberately the same investigation: what
 * differs is that there is already an issue, so the run ends in an edit rather than in a
 * creation. A first investigation can go the wrong way — wrong root cause, wrong file cited,
 * a scope that misses the point — and until this existed the board could only *append* to
 * that: **Add observations** posts a comment, and a comment cannot correct a body. The next
 * reader of the issue is an unattended coding agent, which is then asked to reconcile two
 * texts that contradict each other.
 *
 * So the body is rewritten and the issue is not replaced. The number, the project card, the
 * column, the comments and anything the server keys on the URL all stay valid — nothing
 * downstream has to learn a new fact. That is only defensible while nothing has been built
 * against the issue, which is the Todo gate the route enforces, not this text.
 *
 * The current body is what the run starts from, and it has to be: the observation that
 * produced it is deleted with the block once the card appears (`reconcileDrafts`), so there
 * is nothing else left of the first investigation.
 */
export const ISSUE_REVISE_PROMPT = `You will receive new observations about a GitHub issue this project already opened, and rewrite that issue so that it is right.

Nothing has been built against it yet. The issue is still the deliverable, so what is wanted
is one issue that is correct — not a correction bolted onto one that is not.

Do not rewrite it immediately. Work out what it should say first:

1. Read the issue as it stands, and its comments: \`gh issue view <url>\` and
   \`gh issue view <url> --comments\`. Piped, that flag prints the comments instead of the
   body, so both calls are needed. The new observations are the later word — where they
   disagree with the body, they win.
2. Investigate this repository again, from the observations rather than from the existing
   body. The issue may have found the wrong root cause, cited the wrong file, or scoped
   something nobody needs; do not inherit any of it because it is already written down.
   Cite evidence as file:line.
3. Read the project's documentation before proposing a solution. If the answer depends on
   something the repository does not settle, research it — do not invent it.
4. The issue can turn out to have been right, or to describe something already fixed. Say
   so in the rewritten body rather than inventing a change to make.

Then rewrite the issue **in place**, with the same structure a new one would have: context
and the evidence you found, root cause (or the competing hypotheses, when the investigation
is not conclusive), proposed scope, a verifiable definition of done, and the assumptions you
had to make. Never fill a gap with a guess presented as fact.

Write it in English — title and body. That is fixed: not the language of the observations,
and not the language of the repository you just read. Quote an observation verbatim when its
exact wording is the evidence; translate everything else.

Edit the issue with \`gh issue edit <url> --body-file -\`, and pass the body on **stdin**. Not
as a command-line argument: a body is free text, and a shell will execute what it finds in
one. Rewrite the title too, with \`--title\`, when the re-investigation changed what the issue
is about — a card and a block are labelled with it. Then:

- **Do not run \`gh issue create\`.** The issue number does not change. A second issue for one
  observation is exactly what this exists to avoid, and everything the board keys on this
  issue — its project card, its column, its comments — is keyed on the number it already has.
- **Do not close it, and do not delete its comments.** They are the record of how it got here.

Return only the issue URL on a line of its own — the same URL you were given.

You may put helpers to work — sub-agents, background tasks, whatever the investigation
needs. Two things stay yours and do not transfer with the work:

- **Editing the issue.** A helper investigates and reports its findings back to you; it never
  runs \`gh issue edit\` itself. Two helpers that each rewrite the body leave whichever one
  finished last, and no error anywhere.
- **Finishing.** Only what *you* print is read. You print the issue URL yourself, last, on a
  line of its own — and you wait for every helper to come back before you do.`;

/**
 * PATH for the agent, with the GitHub CLI added when it is missing.
 *
 * The agent is told to use `gh`, but a server started before the CLI was installed
 * inherits a PATH without it — and a child process inherits that stale PATH in turn.
 * The failure reads as the agent being unable to create the issue, which points at
 * the wrong thing entirely.
 */
export function agentPath(): string {
  const current = process.env.PATH ?? '';
  if (/github cli/i.test(current)) return current;

  // Forward slashes: Windows accepts them, and they cannot be silently eaten as
  // escape sequences the way a lone backslash before a letter would be.
  const candidates = [
    'C:/Program Files/GitHub CLI',
    'C:/Program Files (x86)/GitHub CLI',
  ];
  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(path.join(candidate, 'gh.exe'));
    } catch {
      return false;
    }
  });

  return found ? `${current}${path.delimiter}${found}` : current;
}

/**
 * Variables removed on the way into a child, rather than passed on.
 *
 * `CLAUDE_CODE_CHILD_SESSION` is Claude Code's marker for "you are nested inside a
 * session": it is set in every subprocess spawned from the Bash, PowerShell and Monitor
 * tools, from hooks and from status line commands, and an interactive `claude` that sees it
 * is excluded from `--resume`, `--continue`, up-arrow history and `claude agents`.
 *
 * The marker is deliberately *not* set for stdio MCP server subprocesses, because those are
 * long-lived and outlive the session that spawned them. This server is that same class of
 * process and gets no such exemption: started once from a Claude Code tool call it inherits
 * the marker and then stamps it onto every shell and every agent it spawns, hours after the
 * session that set it has ended. A `claude` typed into a terminal block is told it is nested
 * when it is not, and its session is thrown away.
 *
 * So it is stripped rather than overridden. `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1` is the
 * other way to reach the same place and it is worse: it would also override the exclusion
 * for a session that really is nested.
 */
const STRIPPED_FROM_CHILDREN = ['CLAUDE_CODE_CHILD_SESSION'];

/**
 * The environment every child of the board is given: this process's, corrected twice.
 *
 * Shared by the agents and by the terminal, because a rule kept in one of the two places
 * and not the other is how they drift apart. Both corrections are one key each and neither
 * rewrites a command line, so what `agent-usage.ts` and `workspaces.ts` rule out — a
 * configurable command — is untouched.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: agentPath() };
  // By comparison rather than by `delete env.X`: a Windows environment block is
  // case-insensitive, and once spread into a plain object a `Claude_Code_Child_Session`
  // would survive a delete spelled in capitals and reach the child anyway.
  for (const key of Object.keys(env)) {
    if (STRIPPED_FROM_CHILDREN.includes(key.toUpperCase())) delete env[key];
  }
  return env;
}

/**
 * How long a run may take before it is killed: by default, as long as it takes.
 *
 * It was twenty minutes, on the premise that researching an issue is bounded work. That
 * premise went: the investigation now also reads reference images, existing issues and the
 * project's documentation, and a real run was killed at 1200s having already created its
 * issue. The salvage below could not rescue it either — see the note there. Set
 * EXCALIDRAW_ISSUE_AGENT_TIMEOUT (seconds) to put a ceiling back.
 *
 * The trade is the same one implementing already makes, and is handled the same way: with
 * no ceiling a wedged run holds the block in `running`, so the block offers a reset.
 */
export const DEFAULT_TIMEOUT_MS: number | null = (() => {
  const configured = Number(process.env.EXCALIDRAW_ISSUE_AGENT_TIMEOUT);
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : null;
})();

export interface IssueAgentResult {
  ok: boolean;
  issueUrl: string | null;
  output: string;
  error: string | null;
}

/**
 * The last GitHub URL of a given kind in the output.
 *
 * The last, not the first: an agent may well have listed existing issues or pull
 * requests on its way to creating the one it is reporting.
 */
export function extractGithubUrl(output: string, kind: 'issues' | 'pull'): string | null {
  const pattern = new RegExp(`https://github\\.com/[^\\s"'<>]+/${kind}/\\d+`, 'g');
  const matches = output.match(pattern);
  return matches?.length ? (matches[matches.length - 1] ?? null) : null;
}

/** Last non-empty line that looks like a GitHub issue URL. */
export function extractIssueUrl(output: string): string | null {
  return extractGithubUrl(output, 'issues');
}

/**
 * One agent's command, once per environment it might have to run in.
 *
 * Both halves come from the operator's environment and neither may come from anywhere
 * else. `workspaces.ts:30-34` argues that at length: a project file that could supply a
 * command would let anyone with write access to a registered repository start an unattended
 * agent on a board where nobody allowed one. A workspace says which environment it lives
 * in; only the environment says what runs there.
 */
export interface AgentCommands {
  /** `EXCALIDRAW_ISSUE_AGENT` / `EXCALIDRAW_IMPLEMENT_AGENT`. */
  native: string | null;
  /** The `_WSL` half, or null where the operator granted none. */
  wsl: string | null;
}

/**
 * The command this workspace's agent runs, or null when it has none.
 *
 * A command is not portable across environments: `C:/Users/x/.local/bin/claude.exe` cannot
 * resolve inside a distro, and `/home/x/.local/bin/claude` cannot resolve outside one. One
 * global command therefore could not serve both, and a WSL workspace answered exit 127 on
 * every run it was ever asked for.
 *
 * **The fallback is deliberate, and it only goes one way.** A global command written without
 * an absolute path — `claude -p …` — resolves in either environment, and a board set up that
 * way works today; refusing it to fix the absolute-path case would break a working setup to
 * repair a broken one. The reverse is not symmetric: a command granted for the distro says
 * nothing about what may run on the host, so a native workspace never reads the `_WSL` half.
 */
export function agentCommandFor(workspace: Workspace, commands: AgentCommands): string | null {
  const native = commands.native?.trim() || null;
  if (workspace.environment.kind !== 'wsl') return native;
  return (commands.wsl?.trim() || null) ?? native;
}

/**
 * What a command that was not found means, when it was looked for inside a distro.
 *
 * `bash: line 1: C:/Users/x/.local/bin/claude.exe: No such file or directory` names a file
 * the reader can open in Explorer, so it reads as a broken install on the machine in front
 * of them. The file is fine. It was looked for on the other side of a boundary that nothing
 * in the message mentions.
 *
 * Null for a native workspace: there is no distro to name, and the shell's own message is
 * already about the machine the reader is on.
 */
export function commandNotFoundHint(
  workspace: Workspace,
  agentCommand: string,
  variable: string
): string | null {
  if (workspace.environment.kind !== 'wsl') return null;
  const binary = tokenizeCommand(agentCommand)[0] ?? agentCommand;
  return `The command was run inside the WSL distro "${workspace.environment.distro}", `
    + `where "${binary}" is not on PATH. Set ${variable} to the command as that distro `
    + `names it — a path from the host cannot resolve there.`;
}

/**
 * A directory named twice: once for this process, once for the agent's own environment.
 *
 * They differ for a WSL-backed project, where this process reads through a UNC share and
 * the agent sees a POSIX path. Handing the wrong one to a tool inside the distro gives it
 * a working directory it cannot act on.
 */
export interface AgentDirectory {
  /** Path usable by this process. */
  path: string;
  /** The same directory as the workspace's own environment names it. */
  innerPath: string;
}

/**
 * Build the command for a workspace.
 *
 * A WSL-backed project runs through wsl.exe with the project's inner path, because the
 * agent has to see the repository the way git and gh inside that distro do — a Windows
 * UNC path would give it a working directory those tools cannot act on.
 *
 * `directory` overrides where the agent starts, and is how an implementation is put in a
 * worktree of its own rather than in the one directory every run used to share. Omitted,
 * the agent starts in the project itself, which is what reading a repository wants.
 *
 * **`--exec`, not `--`, and that is the whole of it.** `wsl.exe <command>` runs the command
 * through the distro's *default shell*, so `-- bash -lc "<command>"` had a shell in front of
 * the shell that was asked for and the string was parsed twice. Quoting survived that, which
 * is what made it invisible — the argument count was right and every argument looked whole —
 * but the outer shell expanded every `$name` inside the quotes first, single quotes included,
 * because by the time the inner shell saw the string the variable was already gone rather
 * than quoted.
 *
 * It took the project board mirror out entirely on any WSL workspace: `readProjectBoard`
 * sends a *parameterised* query, so `$login`, `$number` and `$field` reached GitHub as
 * nothing at all and every poll answered `Expected VAR_SIGN, actual: COLON (":") at [1, 7]`.
 * The query was written on one line, without a quote or a line break in it, precisely so no
 * shell could break it; `$` is the character that reasoning did not cover, and a second shell
 * is what made it matter. Every `gh` call and every agent run here shares this path, so all
 * of them were exposed — the query is only where it was certain to bite.
 *
 * `--exec` runs the binary directly, with nothing in front of it. `bash` is still what parses
 * the command, once, which is what the string was written for.
 * `scripts/check-wsl-command-quoting.mjs` spawns a real one and reads back what arrived.
 */
export function buildAgentCommand(
  workspace: Workspace,
  agentCommand: string,
  directory?: AgentDirectory | null
): { command: string; args: string[]; cwd: string | undefined } {
  if (workspace.environment.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '-d', workspace.environment.distro,
        '--cd', directory?.innerPath ?? workspace.innerPath,
        '--exec', 'bash', '-lc', agentCommand,
      ],
      // wsl.exe itself runs from wherever; --cd places the agent inside the project.
      cwd: undefined,
    };
  }

  const [command, ...args] = tokenizeCommand(agentCommand);
  return {
    command: command ?? agentCommand,
    args,
    cwd: directory?.path ?? workspace.path,
  };
}

/**
 * The project's own model and effort on the end of the operator's command — or nothing.
 *
 * Nothing is the important half again: a project that configures neither must spawn the
 * command line it spawned before any of this existed, byte for byte, which is the rule
 * `worktreeSection` and `imageReferenceSection` already keep about the prompt.
 *
 * Appended rather than substituted, and appended rather than prepended, because the last
 * flag is the one the CLI keeps. That is not assumed: `claude --model sonnet --model
 * definitely-not-a-model -p hi` complains about the second one, so a project's setting
 * placed after the operator's wins. Nothing else in the operator's command is touched —
 * the alternative, a whole per-workspace command string, would be a project granting
 * itself an agent rather than retuning the one the board already allows.
 */
export function applyAgentSettings(
  agentCommand: string,
  settings: AgentSettings | null | undefined
): string {
  if (!settings) return agentCommand;

  // Quoted only when it has to be: `tokenizeCommand` consumes quotes, and a bare value is
  // what somebody reading the log would have typed.
  const value = (raw: string) => (/\s/.test(raw) ? `"${raw}"` : raw);
  const flags = [
    settings.model ? `--model ${value(settings.model)}` : null,
    settings.effort ? `--effort ${value(settings.effort)}` : null,
  ].filter(Boolean);

  return flags.length ? `${agentCommand} ${flags.join(' ')}` : agentCommand;
}

/**
 * Split a command line into argv, keeping quoted runs together.
 *
 * Splitting on whitespace alone would tear apart a flag whose value contains spaces,
 * which is exactly the shape of a permission list: --allowedTools "Bash(gh:*) Read".
 * Quotes are consumed, not passed on — there is no shell here to strip them later.
 */
export function tokenizeCommand(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) { tokens.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) tokens.push(current);

  return tokens;
}

export interface AgentRun {
  ok: boolean;
  /** The GitHub URL the run was asked to produce, or null when it produced none. */
  url: string | null;
  output: string;
  error: string | null;
}

/**
 * A run the board is showing, once something has agreed to host it.
 *
 * The handle is deliberately narrow — an id, an ending, and a way to stop it. Everything
 * else a run needs is already here: the output arrives through the `onOutput` the host was
 * given, and what it *means* is settled below, once, for a hosted run and a private child
 * alike. A host that decided for itself whether a run had succeeded would be a second
 * `extractGithubUrl` to keep in step with this one.
 */
export interface AgentHostHandle {
  /** What the board calls what it opened, for a record that says where the run went. */
  id: string;
  /** Settles with the exit code once the process ends; null when it was killed. */
  exited: Promise<number | null>;
  /** Take it down, for a run that ran out of time. */
  close(): void;
}

/**
 * Somewhere to put the run that a reader can watch, or nothing at all.
 *
 * Nothing at all is the important half, and it is the *common* half: a board with no
 * terminal, a board whose session cap is full, a host that could not spawn. Every one of
 * them returns null, and null means the run happens the way it always did — in a private
 * child of this process. A tab is something a run is given, never something it needs, so
 * nothing here may turn a refusal into a failed implementation.
 */
export type AgentHost = (spec: {
  agentCommand: string;
  directory: AgentDirectory | null;
  /** The prompt, which the host has to deliver on the process's stdin and then close. */
  prompt: string;
  /** Every chunk the process writes, as it writes it. */
  onOutput: (chunk: string) => void;
}) => Promise<AgentHostHandle | null>;

/**
 * What a finished run means, from what it printed and how it ended.
 *
 * Shared by the hosted path and the private child rather than written twice: which URL
 * counts, what an exit code of zero with no URL is, and how much of the tail an error
 * carries are all the *contract*, and a second copy of it would be a second answer.
 *
 * `stderr` is empty for a hosted run — a terminal shows one stream, so the two are already
 * interleaved in `stdout` — which is why the message falls back to the output it does have.
 */
function agentOutcome(
  code: number | null,
  stdout: string,
  stderr: string,
  expects: 'issues' | 'pull',
  noun: string,
  notFoundHint: string | null = null
): AgentRun {
  const url = extractGithubUrl(stdout, expects);
  // 127 is the shell's own "command not found", and it is the one exit code whose cause
  // this process knows better than the message does: the command was looked for somewhere
  // the reader is not, and nothing in the shell's line says where.
  const hint = code === COMMAND_NOT_FOUND && notFoundHint ? ` ${notFoundHint}` : '';
  return {
    ok: code === 0 && Boolean(url),
    url,
    output: stdout,
    error: code === 0
      ? (url
          ? null
          : `Agent finished without returning ${noun}. It said: ${stdout.trim().slice(-600) || '(nothing)'}`)
      : `Agent exited with code ${code}: ${(stderr || stdout).slice(-500)}${hint}`,
  };
}

/** What a shell exits with when it could not find the command it was given. */
const COMMAND_NOT_FOUND = 127;

export interface RunAgentOptions {
  agentCommand: string;
  /**
   * Ceiling on the run, or `null` for none — which is now what both agents default to.
   *
   * Researching kept twenty minutes for a while, on the premise that it was bounded work.
   * It is not: killing an agent that has already created its issue reports a failure for
   * work that succeeded, and killing one partway through a change leaves a branch nobody
   * asked for. `null` accepts the trade that comes with it: a wedged run has to be
   * recovered by hand, so something must offer that.
   */
  timeoutMs?: number | null;
  /** Which kind of URL counts as the answer. */
  expects: 'issues' | 'pull';
  /** Named in log lines and in the error a caller shows. */
  what: string;
  /** Where to start the agent, when that is not the project directory itself. */
  directory?: AgentDirectory | null;
  /**
   * The run's token totals so far, whenever they change.
   *
   * Called only when the configured command already asks its agent for a machine-readable
   * stream. A command that does not — today's default — never reaches this, and the spawn
   * path below is byte for byte what it was: the same "nothing at all" half that
   * `worktreeSection` and `imageReferenceSection` are careful about.
   */
  onUsage?: (usage: AgentUsage) => void;
  /**
   * Somewhere to run the agent where the board can show it, or nothing.
   *
   * Asked first and fallen through when it declines, which is what makes the tab an
   * addition rather than a dependency: everything below this line is the path every run
   * took before a board had a terminal, and it is still the path a run takes when there is
   * no tab to be had.
   */
  host?: AgentHost | null;
  /**
   * The variable to name when the command turns out not to exist where it was run.
   *
   * Passed by the caller rather than derived, because only the caller knows which of the two
   * agents it is starting, and naming the wrong one would send the reader to set a variable
   * that changes nothing. Omitted, an exit 127 reports what the shell said and no more.
   */
  notFoundVariable?: string | null;
}

/**
 * Run an agent inside a workspace and take one GitHub URL from what it printed.
 *
 * Shared rather than copied per feature, because the salvage below was earned: an agent
 * created its issue and then kept working past the timeout, and reporting that as a
 * failure would have invited a second run for work that had already succeeded.
 */
export async function runAgent(
  workspace: Workspace,
  prompt: string,
  options: RunAgentOptions
): Promise<AgentRun> {
  const { command, args, cwd } = buildAgentCommand(workspace, options.agentCommand, options.directory);
  // The article travels with the noun. A fixed one reads as "a issue URL".
  const noun = options.expects === 'pull' ? 'a pull request URL' : 'an issue URL';

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`, { command, cwd });

  // Worked out once, here, because both paths below end in the same `agentOutcome` and a
  // second copy of this would be a second answer to the same question.
  const notFoundHint = options.notFoundVariable
    ? commandNotFoundHint(workspace, options.agentCommand, options.notFoundVariable)
    : null;

  // `undefined` means "use the default"; `null` and 0 mean "no ceiling at all".
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;

  if (options.host) {
    const hosted = await runHostedAgent(options.host, options, prompt, noun, timeoutMs, notFoundHint);
    if (hosted) return hosted;
    logger.info(`Nothing could host ${options.what}, so it runs in a private child`, { command });
  }

  return new Promise<AgentRun>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: agentEnv(),
      // No shell: the prompt arrives over stdin, so nothing has to survive quoting.
      // Passing multi-line text as an argument breaks on cmd.exe long before the
      // agent ever sees it.
      windowsHide: true,
    });

    child.stdin?.on('error', () => { /* the agent may exit before reading stdin */ });
    child.stdin?.end(prompt);

    let stdout = '';
    let stderr = '';
    let settled = false;

    // Reads the totals out of the stream the agent is already writing. Null unless the
    // caller asked *and* the command streams, which is what keeps this off by default.
    const meter = options.onUsage && streamsUsage(options.agentCommand)
      ? new UsageMeter(options.onUsage)
      : null;

    const timeout = timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();

      // The agent may well have finished the visible work and then kept going.
      // Reporting a failure for work that succeeded is worse than reporting a slow
      // success, so salvage the URL from whatever it printed before the kill.
      //
      // Kept, but it is not a guarantee, and it was once documented as one: a plain
      // `claude -p` writes nothing until it exits, so at the kill `stdout` is empty and
      // there is nothing here to find. It rescues a run only when the command streams —
      // `--output-format stream-json` — which is why this is no longer the answer to a
      // ceiling that fires. Not firing at all is.
      meter?.flush();
      const salvaged = extractGithubUrl(stdout, options.expects);
      resolve({
        ok: Boolean(salvaged),
        url: salvaged,
        output: stdout,
        error: salvaged ? null : `Agent timed out after ${timeoutMs / 1000}s without returning ${noun}`,
      });
    }, timeoutMs) : null;

    const clearIfSet = () => { if (timeout) clearTimeout(timeout); };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      meter?.take(text);
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      meter?.flush();
      resolve({ ok: false, url: null, output: stdout, error: error.message });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearIfSet();
      meter?.flush();
      resolve(agentOutcome(code, stdout, stderr, options.expects, noun, notFoundHint));
    });
  });
}

/**
 * The same run, in something a reader can watch — or null, when nothing would host it.
 *
 * Null rather than an error, and that distinction is the whole of the fallback: a board with
 * no terminal and a board whose tabs are all taken both arrive here, and both must end up
 * running the implementation. Only the *place* is in question.
 *
 * What is deliberately not different is everything after the process ends. The exit code and
 * the transcript go through `agentOutcome` exactly as a private child's do, so a run that is
 * being watched and a run that is not are settled by one piece of code — which is what makes
 * "the run still settles as it did" a property of the design rather than of a check.
 *
 * The timeout is the one place the two paths diverge in shape rather than in wording. There
 * is no child here to `kill()`; the host owns the process, so it is asked to close, and the
 * ending it reports is awaited either way rather than raced against.
 */
async function runHostedAgent(
  host: AgentHost,
  options: RunAgentOptions,
  prompt: string,
  noun: string,
  timeoutMs: number | null,
  notFoundHint: string | null
): Promise<AgentRun | null> {
  let stdout = '';

  // Reads the totals out of the stream the agent is already writing. Null unless the
  // caller asked *and* the command streams, which is what keeps this off by default.
  const meter = options.onUsage && streamsUsage(options.agentCommand)
    ? new UsageMeter(options.onUsage)
    : null;

  let handle: AgentHostHandle | null = null;
  try {
    handle = await host({
      agentCommand: options.agentCommand,
      directory: options.directory ?? null,
      prompt,
      onOutput: (chunk) => { stdout += chunk; meter?.take(chunk); },
    });
  } catch (error) {
    // A host that threw is a host that declined, loudly. The run is not the place to
    // report it: it still has an implementation to do.
    logger.warn(`Could not host ${options.what}, so it runs in a private child`, {
      error: (error as Error).message,
    });
    return null;
  }
  if (!handle) return null;

  let timedOut = false;
  const timeout = timeoutMs
    ? setTimeout(() => { timedOut = true; handle?.close(); }, timeoutMs)
    : null;

  const code = await handle.exited;
  if (timeout) clearTimeout(timeout);
  meter?.flush();

  if (timedOut) {
    // The same salvage a private child gets, and for the same reason: an agent may well
    // have finished the visible work and kept going, and reporting a failure for work that
    // succeeded invites a second run for it. It is worth more here — a hosted run's
    // transcript is everything the process wrote, streamed, rather than a buffer that a
    // non-streaming `claude -p` leaves empty until it exits.
    const salvaged = extractGithubUrl(stdout, options.expects);
    return {
      ok: Boolean(salvaged),
      url: salvaged,
      output: stdout,
      error: salvaged
        ? null
        : `Agent timed out after ${(timeoutMs as number) / 1000}s without returning ${noun}`,
    };
  }

  return agentOutcome(code, stdout, '', options.expects, noun, notFoundHint);
}

/**
 * The section that names the reference images, or nothing at all.
 *
 * Nothing at all is the important half: a block with no images attached must send the
 * prompt it sent before this existed, byte for byte, because a feature nobody used must
 * not change what every block already does.
 *
 * The instruction says what the images are *for*, because the obvious reading is wrong.
 * They cannot become part of the issue — `gh issue create` uploads nothing, and the
 * upload endpoint GitHub's own web client uses is not public API — so an agent that tries
 * to attach them wastes the run. They are material for the investigation, and anything
 * from them the issue depends on has to be written out in words.
 */
export function imageReferenceSection(paths: readonly string[]): string {
  if (!paths.length) return '';

  const list = paths.map((imagePath) => `- ${imagePath}`).join('\n');
  return `\n\n---\n\nReference images (${paths.length}), attached to this observation and already on disk:

${list}

Read each one before you write the issue. They are reference material for the
investigation, not content for the issue: they cannot be uploaded to GitHub, so describe
in words whatever the issue depends on. They are deleted when this run ends, so nothing
you write may point at these paths.`;
}

export async function runIssueAgent(
  workspace: Workspace,
  observation: string,
  options: {
    agentCommand: string;
    timeoutMs?: number;
    imagePaths?: readonly string[];
    /** Named when the command turns out not to exist where it was run. See RunAgentOptions. */
    notFoundVariable?: string | null;
  }
): Promise<IssueAgentResult> {
  const prompt = `${ISSUE_AGENT_PROMPT}\n\n---\n\nObservation:\n\n${observation}`
    + imageReferenceSection(options.imagePaths ?? []);
  // Per run, not per process: one board runs several projects, and the model, the effort
  // and the ceiling are each the project's to retune. A caller that names a ceiling still
  // wins — that is the route asking for one, not a default being applied.
  const settings = workspace.agents?.issue ?? null;
  const timeoutMs = options.timeoutMs !== undefined
    ? options.timeoutMs
    : settings?.timeoutMs ?? undefined;
  const run = await runAgent(workspace, prompt, {
    agentCommand: applyAgentSettings(options.agentCommand, settings),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    expects: 'issues',
    what: 'issue agent',
    notFoundVariable: options.notFoundVariable ?? null,
  });
  return { ok: run.ok, issueUrl: run.url, output: run.output, error: run.error };
}

/**
 * Re-research an issue that exists and rewrite it, rather than opening a second one.
 *
 * The same agent command and the same per-project settings as researching — it is the same
 * work with an issue already in front of it — and the same `expects: 'issues'`, because the
 * answer is still one issue URL. The difference is that the caller already knows which URL
 * that has to be: an answer naming a *different* issue is a run that opened one, and the
 * route refuses to record it as a rewrite.
 *
 * The observations go into the prompt and nowhere near a command line. Nothing here
 * interpolates them into a shell — `runAgent` writes the whole prompt to the child's stdin.
 *
 * No `host`, exactly as `runIssueAgent` passes none: researching an issue does not yet run in a
 * terminal the board can show, and this is the same run rather than a second decision about it.
 * `docs/whats-next.md` is where that seam is recorded, and it stays one seam.
 */
export async function runReviseAgent(
  workspace: Workspace,
  issueUrl: string,
  observations: string,
  options: {
    agentCommand: string;
    timeoutMs?: number;
    /** Named when the command turns out not to exist where it was run. See RunAgentOptions. */
    notFoundVariable?: string | null;
  }
): Promise<IssueAgentResult> {
  const prompt = `${ISSUE_REVISE_PROMPT}\n\n---\n\nThe issue to rewrite: ${issueUrl}`
    + `\n\n---\n\nNew observations:\n\n${observations}`;
  const settings = workspace.agents?.issue ?? null;
  const timeoutMs = options.timeoutMs !== undefined
    ? options.timeoutMs
    : settings?.timeoutMs ?? undefined;
  const run = await runAgent(workspace, prompt, {
    agentCommand: applyAgentSettings(options.agentCommand, settings),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    expects: 'issues',
    what: 'issue revise agent',
    notFoundVariable: options.notFoundVariable ?? null,
  });
  return { ok: run.ok, issueUrl: run.url, output: run.output, error: run.error };
}
