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
import os from 'os';
import path from 'path';
import logger from '../utils/logger.js';
import {
  commandLineInvocation, invocationArgs, singleQuoted,
  type AgentAdapter, type AgentCommandSpec, type AgentInvocation, type AgentRole,
} from './agent-adapter.js';
import { adapterFor } from './agents/index.js';
import { AgentUsage, UsageMeter } from './agent-usage.js';
import { GITHUB_HOST } from './github-host.js';
import { AgentSettings, loadAgentWorkflow, Workspace } from './workspaces.js';
import { env as settingValue } from './settings.js';

/**
 * The command-line helpers, still reachable from here.
 *
 * They moved to `agent-adapter.ts` when the `raw` backend became the thing that reads a command
 * line: an adapter that imported them from this module would close a cycle, since this module
 * imports the adapters. Re-exported rather than relocated silently, because every caller — the
 * preflight, the terminal, three check scripts — had them from here.
 */
export {
  runsHeadless, singleQuoted, tokenizeCommand, withoutPrintFlags,
} from './agent-adapter.js';

/**
 * The language paragraph — the one thing in these prompts a project gets to set.
 *
 * **The rule it states is not the thing being made configurable.** Issue #20 came out
 * entirely in Portuguese from an observation written in English: step 3 of the investigation
 * sends the agent to read the project's own documentation, that project documents in
 * Portuguese, and nothing in the prompt said otherwise. What fixed it was saying the language
 * outright, and that stays said — an agent still may not take the language from the
 * observation it was given or from the repository it just read.
 *
 * What was wrong was fixing it to *one* language. This board opens issues in several
 * repositories, and a project whose own conventions require Portuguese got every card this
 * tool opened for it written against its own rule — not a preference, a collision. So the
 * project names the language and the prompt is as fixed as it ever was.
 *
 * Whitespace is collapsed and the name is cut short deliberately. A `board.config.json` may
 * be written by hand, so this field reaches the prompt without passing
 * `validateWorkspaceConfigPatch`; what belongs here is the name of a language, and a
 * paragraph arriving in its place would be instructions in a slot meant for two words.
 */
function languageNamed(language: string | null | undefined): string {
  const named = (language ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return named || 'English';
}

/** Which language, and why not whichever one the agent happens to be looking at. */
function issueLanguageParagraph(language: string | null | undefined): string {
  const named = languageNamed(language);
  const because = named === 'English'
    ? 'Every development artifact in this project is English.'
    : `This project has said that every development artifact it carries is written in ${named}.`;
  return `Write the issue in ${named} — title and body. That is fixed: not the language of the
observation, and not the language of the repository you just read, whose documentation may
well be in something else. ${because} Quote the
observation verbatim when its exact wording is the evidence; translate everything else.`;
}

/** The same, for a rewrite: the observations are plural and there is no repository to blame. */
function reviseLanguageParagraph(language: string | null | undefined): string {
  const named = languageNamed(language);
  const because = named === 'English'
    ? ''
    : ` This project has said that every development artifact it carries is written in ${named}.`;
  return `Write it in ${named} — title and body. That is fixed: not the language of the observations,
and not the language of the repository you just read.${because} Quote an observation verbatim when its
exact wording is the evidence; translate everything else.`;
}

/** Default instruction. Investigation first, evidence over guesswork, URL last. */
const ISSUE_AGENT_PROMPT_OPENING = `You will receive an observation about this project and turn it into a GitHub issue.

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

`;

const ISSUE_AGENT_PROMPT_CLOSING = `

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
 * The research prompt as one project reads it.
 *
 * Composed rather than interpolated so that a project which names no language gets the text
 * byte for byte as it was — that is what `ISSUE_AGENT_PROMPT` below still is, and what
 * `check-workspace-language.mjs` holds it to.
 */
export function issueAgentPrompt(language: string | null | undefined): string {
  return ISSUE_AGENT_PROMPT_OPENING + issueLanguageParagraph(language) + ISSUE_AGENT_PROMPT_CLOSING;
}

/** The default, still English, still exported: `check-english-only.mjs` reads this one. */
export const ISSUE_AGENT_PROMPT = issueAgentPrompt(null);

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
const ISSUE_REVISE_PROMPT_OPENING = `You will receive new observations about a GitHub issue this project already opened, and rewrite that issue so that it is right.

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

`;

const ISSUE_REVISE_PROMPT_CLOSING = `

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

/** The revise prompt as one project reads it. See `issueAgentPrompt`. */
export function issueRevisePrompt(language: string | null | undefined): string {
  return ISSUE_REVISE_PROMPT_OPENING + reviseLanguageParagraph(language) + ISSUE_REVISE_PROMPT_CLOSING;
}

/** The default, still English: `check-issue-recreate.mjs` reads this one. */
export const ISSUE_REVISE_PROMPT = issueRevisePrompt(null);

/**
 * The command as an absolute path, or as it was given.
 *
 * `child_process.spawn` searches `PATH` for a bare command name; the PTY binding does not,
 * and on Windows it reports the failure as `File not found:` with nothing after the colon,
 * which says neither what was missing nor that a lookup was expected. So the lookup happens
 * here, against the same `PATH` the shell is about to be handed rather than this process's
 * own — `EXCALIDRAW_TERMINAL=node ...` has to find the same `node` in both modes.
 *
 * Falling back to the original spelling is deliberate: a command that cannot be resolved
 * should fail in the spawn, with the spawn's own message, rather than here.
 *
 * It lives here rather than in `terminal-session.ts`, which is where it was written and
 * which still calls it, because `agentPath()` below now asks it the same question — "does
 * this PATH resolve a runnable `gh`" — and a second copy of a PATH lookup is how the guard
 * and the terminal come to disagree about what "on PATH" means. This module already owns
 * what a child of the board is given, and `terminal-session.ts` already imports it, so the
 * dependency runs one way.
 *
 * `platform` is a seam, not a setting: nothing in `src/` passes it. It decides how an
 * executable is named — `PATHEXT` on Windows, nothing on POSIX — so that a check can assert
 * the answer for all three platforms from whichever one it happens to be running on. The
 * `PATH` separator is not part of it: that is the host's in production either way, and a
 * check that stubbed it would be spelling paths no host would.
 */
export function resolveExecutable(command: string, search: string, platform: NodeJS.Platform = process.platform): string {
  const runnable = (candidate: string): boolean => {
    try { return fs.existsSync(candidate) && fs.statSync(candidate).isFile(); } catch { return false; }
  };
  // Already a path of some kind, so there is nothing to look up.
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) return command;

  const extensions = platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [];
  for (const directory of search.split(path.delimiter).filter(Boolean)) {
    const base = path.join(directory, command);
    if (runnable(base)) return base;
    for (const extension of extensions) {
      if (runnable(base + extension)) return base + extension;
    }
  }
  return command;
}

/**
 * The GitHub CLI directories a Windows install puts it in.
 *
 * Forward slashes: Windows accepts them, and they cannot be silently eaten as escape
 * sequences the way a lone backslash before a letter would be.
 */
const WINDOWS_CANDIDATES = [
  'C:/Program Files/GitHub CLI',
  'C:/Program Files (x86)/GitHub CLI',
];

/**
 * Where a POSIX machine keeps the tools this server's children need.
 *
 * A fixed list, and the alternative was considered and turned down: harvesting the real PATH
 * at startup by running `$SHELL -lc 'printf %s "$PATH"'` is what GUI-launched developer tools
 * on macOS do and is the only thing that can cover an asdf, nvm or mise install — but it puts
 * a login shell on the server's startup path, and a shell that prompts, a shell that is slow
 * and a `$SHELL` that is not POSIX are three new ways for the board to fail to come up. The
 * list below costs four `existsSync` calls and cannot hang. What it misses is a version
 * manager, which is written down as a known gap rather than pretended away.
 */
function posixCandidates(home: string): string[] {
  return [
    '/opt/homebrew/bin',              // Homebrew on Apple silicon
    '/usr/local/bin',                 // Homebrew on Intel macOS, and the usual local install
    '/home/linuxbrew/.linuxbrew/bin', // Homebrew on Linux
    `${home}/.local/bin`,             // pipx, uv, and Claude Code's own installer
    '/usr/bin',                       // the distro's own, which a stripped PATH can lack
  ];
}

/**
 * The seams `agentPath()` takes so that one platform can assert the answer for all three.
 *
 * Nothing in `src/` passes any of them; every caller calls `agentPath()` with no arguments
 * and gets this machine. They exist because the failure this function fixes is only reachable
 * from a GUI-launched process on a platform this is not developed on, so the alternative to a
 * seam is a check that cannot be written.
 */
export interface AgentPathProbe {
  /** The platform to answer for. Defaults to this process's. */
  platform?: NodeJS.Platform;
  /** The PATH to repair. Defaults to `process.env.PATH`. */
  path?: string;
  /** Where `~` expands to. Defaults to `os.homedir()`. */
  home?: string;
  /** A directory the candidates are looked for under, so a check can plant them. */
  root?: string;
}

/** A candidate as it will be looked for: under `root` when a check planted one there. */
function under(root: string | undefined, candidate: string): string {
  // The drive letter goes, because it cannot be joined onto anything: the root stands in
  // for the machine's own root, which is the whole of what a planted candidate needs.
  return root ? path.join(root, candidate.replace(/^[A-Za-z]:/, '')) : candidate;
}

/** Two spellings of one directory, compared the way the platform compares them. */
function sameAs(platform: NodeJS.Platform, entry: string): string {
  const trimmed = entry.trim().replace(/[\\/]+$/, '');
  return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
}

function isDirectory(candidate: string): boolean {
  try { return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(); } catch { return false; }
}

/**
 * PATH for every child of the board, with the directories a tool lives in added when missing.
 *
 * The agent is told to use `gh`, but a server started before the CLI was installed inherits a
 * PATH without it — and a child process inherits that stale PATH in turn. The failure reads as
 * the agent being unable to create the issue, which points at the wrong thing entirely.
 * `docs/trap-gh-path.md` is that trap.
 *
 * It was fixed on one platform only, and in a way that could not have worked on another: the
 * guard was `/github cli/i` against the incoming PATH, which can only ever match a Windows
 * Program Files directory name, and the candidates were two `C:/Program Files…` paths probed
 * for `gh.exe`. On macOS and Linux the guard never matched, the probe found nothing, and the
 * inherited PATH came back untouched — invisible from a shell, where `gh` is already on PATH,
 * and the whole failure from a launcher: a process started from Finder, from a `.desktop`
 * entry or from a LaunchAgent inherits launchd's minimal PATH, which holds neither Homebrew
 * prefix nor `~/.local/bin`, so `gh` *and* the agent binary are both missing.
 *
 * So the guard is now a real lookup — a runnable `gh` on the PATH as given — which means the
 * same thing on all three platforms, and the candidate list is the one the platform uses. The
 * POSIX half appends every candidate that *exists*, rather than only those holding a `gh`:
 * the agent binary has the identical GUI-launch problem and lives in the same directories, and
 * a repair that fixed `gh` while leaving `claude` unfound would fix half of one launch.
 *
 * Directories are appended, never prepended, so nothing this adds can shadow a tool the
 * machine's own PATH already chose.
 */
export function agentPath(probe: AgentPathProbe = {}): string {
  const platform = probe.platform ?? process.platform;
  const current = probe.path ?? process.env.PATH ?? '';
  if (resolveExecutable('gh', current, platform) !== 'gh') return current;

  const present = new Set(
    current.split(path.delimiter).filter(Boolean).map((entry) => sameAs(platform, entry)),
  );

  let additions: string[];
  if (platform === 'win32') {
    // One, and by the presence of `gh.exe` rather than of the directory: unchanged from what
    // this did before, because on Windows it already worked.
    const found = WINDOWS_CANDIDATES
      .map((candidate) => under(probe.root, candidate))
      .find((candidate) => {
        try { return fs.existsSync(path.join(candidate, 'gh.exe')); } catch { return false; }
      });
    additions = found ? [found] : [];
  } else {
    additions = posixCandidates(probe.home ?? os.homedir())
      .map((candidate) => under(probe.root, candidate))
      .filter(isDirectory);
  }

  additions = additions.filter((candidate) => !present.has(sameAs(platform, candidate)));
  if (additions.length === 0) return current;
  return [...(current ? [current] : []), ...additions].join(path.delimiter);
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
 * The variable that says a session captured somebody's stdout, and the one that proves it.
 *
 * Claude Code sets `NO_COLOR=1` in the subprocesses its Bash, PowerShell and Monitor tools
 * spawn, and that is right for what those are: their output is read back as text rather than
 * drawn on a screen. It is a statement about one captured subprocess, and the board inherits
 * it by the same route it inherits the marker above — started once from a tool call, it then
 * hands the variable to every shell and every agent it opens for the rest of its life. A
 * terminal block is the opposite of a captured subprocess, so what the reader gets is Claude
 * Code, `gh`, `git` and `npm` all in black and white, hours after the session that asked for
 * that has ended.
 *
 * **Only when `CLAUDECODE` is beside it**, which is the difference between correcting an
 * inheritance and overriding the machine. `NO_COLOR` is a standard an operator may hold
 * deliberately (`no-color.org`), and a board that discarded it on sight would be deciding
 * something that is not its to decide. With Claude Code's own marker in the same environment
 * the variable is demonstrably one session's rather than the machine's, and nothing else in
 * reach can say so: it carries no value that distinguishes the two, and the User and Machine
 * environment blocks a persistent preference would live in are not readable from here.
 *
 * Not added to `STRIPPED_FROM_CHILDREN`, because that list is unconditional and this is not.
 * `CLAUDECODE` itself stays: it is Claude Code telling a child what spawned it, which is true
 * of a shell the board opens and is what a status line or a hook would read.
 */
const SESSION_ONLY = { key: 'NO_COLOR', witness: 'CLAUDECODE' } as const;

/** Whether a key is present in an environment, whatever case it was spelled in. */
function has(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.keys(env).some((key) => key.toUpperCase() === name);
}

/**
 * The environment every child of the board is given: this process's, corrected three times.
 *
 * Shared by the agents and by the terminal, because a rule kept in one of the two places
 * and not the other is how they drift apart. Every correction is one key and none of them
 * rewrites a command line, so what `agent-usage.ts` and `workspaces.ts` rule out — a
 * configurable command — is untouched.
 *
 * `probe` is `agentPath`'s seam and nothing more: no caller in `src/` passes it, and it is
 * here so that a check can assert the environment a child is handed on a platform other than
 * the one it is running on. See `AgentPathProbe`.
 */
export function agentEnv(probe: AgentPathProbe = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: agentPath(probe) };
  const inherited = has(env, SESSION_ONLY.witness);
  // By comparison rather than by `delete env.X`: a Windows environment block is
  // case-insensitive, and once spread into a plain object a `Claude_Code_Child_Session`
  // would survive a delete spelled in capitals and reach the child anyway.
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (STRIPPED_FROM_CHILDREN.includes(upper)) delete env[key];
    if (inherited && upper === SESSION_ONLY.key) delete env[key];
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
  const configured = Number(settingValue('ISSUE_AGENT_TIMEOUT'));
  return Number.isFinite(configured) && configured > 0 ? configured * 1000 : null;
})();

export interface IssueAgentResult {
  ok: boolean;
  issueUrl: string | null;
  output: string;
  error: string | null;
}

/**
 * The last github.com URL of a given kind in the output.
 *
 * The last, not the first: an agent may well have listed existing issues or pull
 * requests on its way to creating the one it is reporting.
 *
 * The host is the requirement `github-host.ts` states, which is why an agent that opened a
 * perfectly good issue somewhere else comes back with nothing: the `noun` in `runAgent` names
 * the host, so what it reports is a URL on the wrong host rather than an agent that failed.
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
  /** `EXCALIDRAW_ISSUE_AGENT` / `EXCALIDRAW_IMPLEMENT_AGENT`, with the backend it names. */
  native: AgentCommandSpec | null;
  /** The `_WSL` half, or null where the operator granted none. */
  wsl: AgentCommandSpec | null;
}

/** A command line and the backend it is run under. Null for an empty or absent command. */
export function agentCommandSpec(
  command: string | null | undefined,
  backend: AgentCommandSpec['backend']
): AgentCommandSpec | null {
  const trimmed = command?.trim() || null;
  return trimmed ? { backend, command: trimmed } : null;
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
 *
 * **The backend travels with the command**, which is why this returns a spec rather than a
 * string. The two are one grant: an operator with Claude Code on the host and something else
 * inside a distro has named two agents, not one agent spelled twice — and the fallback above
 * carries the native backend with the native command, because a distro falling back to the
 * host's command is running the host's agent.
 */
export function agentCommandFor(
  workspace: Workspace,
  commands: AgentCommands
): AgentCommandSpec | null {
  if (workspace.environment.kind !== 'wsl') return commands.native;
  return commands.wsl ?? commands.native;
}

/**
 * The backend and the argv one run is spawned with, from what the board was granted.
 *
 * The one place a `{ backend, command }` becomes something that can be spawned, so that the
 * three run functions below — research, rewrite, implement — cannot drift apart on how a
 * project's model or effort reaches an agent, or on what "interactive" means.
 *
 * The project's settings arrive as *values* rather than as flags. That is the whole trade this
 * replaced: `--model x --effort y` appended to somebody's command line is Claude Code's
 * spelling written by a module that had no way of knowing whether the command was Claude Code.
 * Now the backend spells it, and the `raw` backend still spells it exactly that way — because
 * for a passthrough that is the honest answer, and because a board configured today has to
 * spawn what it spawned yesterday.
 */
export function agentRunFor(
  agent: AgentCommandSpec,
  role: AgentRole,
  settings: AgentSettings | null | undefined,
  mode: 'headless' | 'interactive' = 'headless'
): { adapter: AgentAdapter; invocation: AgentInvocation } {
  const adapter = adapterFor(agent.backend);
  return {
    adapter,
    invocation: adapter.invoke({
      mode,
      role,
      command: agent.command,
      model: settings?.model ?? null,
      effort: settings?.effort ?? null,
    }),
  };
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
  invocation: AgentInvocation,
  variable: string
): string | null {
  if (workspace.environment.kind !== 'wsl') return null;
  // The invocation's own argv[0], rather than the command line read a second time: the backend
  // has already decided what the binary is, and a second reading is a second answer.
  const binary = invocation.command;
  return `The command was run inside the WSL distro "${workspace.environment.distro}", `
    + `where "${binary}" is not on PATH. Set ${variable} to the command as that distro `
    + `names it — a path from the host cannot resolve there.`;
}

/**
 * The same text with the terminal's own instructions taken out of it.
 *
 * A run on pipes prints what it means. A run on a pseudoterminal prints a *screen*: colours,
 * cursor moves and the sequences that paint them, all of them in the transcript beside the
 * words. `extractGithubUrl` reads that transcript, and a URL with an SGR reset dropped in the
 * middle of it is not a URL any more — so the escapes come out before anything is looked for.
 *
 * Only the two grammars a program actually uses to paint: CSI (`ESC [ … final`) and the
 * string escapes (OSC and friends, ending at `BEL` or `ST`), plus the two-byte escapes.
 * Nothing here is trying to be an emulator; it is trying to leave the letters behind.
 */
export function stripAnsi(text: string): string {
  return text
    // The string escapes first: what they carry is arbitrary text, and a `[` inside one
    // would otherwise be read as the start of a control sequence that is not there.
    .replace(/\u001b[\]P^_X][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\_]/g, '');
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
 *
 * **`prompt` is the other way to hand an agent its instructions**, and it exists because the
 * usual way spends stdin. `claude [options] [prompt]` takes one as its last argument and
 * starts an interface; a prompt written to stdin has to be ended, and a pseudoterminal has no
 * end of file to end it with. So an interactive run puts it here instead — never tokenized,
 * because it is several hundred words with quotes and backticks in it and `tokenizeCommand`
 * would tear it apart. On the host it is one more element of argv, which no shell ever sees.
 * Inside a distro there *is* a shell, so it is single-quoted into the string `bash -lc`
 * parses: the one quoting that expands nothing, which is the same `$name` trap as above.
 * Whether it goes there at all is the invocation's to say — see `AgentInvocation.prompt`.
 *
 * **An invocation rather than a command line, and a command line is still accepted.** What the
 * distro is handed is `invocation.line`, which for the `raw` backend *is* the operator's own
 * string, untouched — a shell parses it, and one that says `source ~/.nvm/nvm.sh && claude -p`
 * means it, so tokenising and re-quoting would be silently narrowing what a board may run. A
 * plain string is taken as such a command line, for the callers that hold one rather than an
 * agent: the preflight's `--version` probe, and a shell somebody typed into a terminal block.
 */
export function buildAgentCommand(
  workspace: Workspace,
  agent: AgentInvocation | string,
  directory?: AgentDirectory | null,
  prompt?: string | null
): { command: string; args: string[]; cwd: string | undefined } {
  const invocation = typeof agent === 'string' ? commandLineInvocation(agent) : agent;
  // Only where the invocation says the prompt belongs on argv. A backend that reads it from
  // stdin has already placed whatever stands for it — `codex exec -` — and a prompt appended
  // after that would be a second positional rather than the instruction.
  const onArgv = prompt && invocation.prompt.via === 'argv' ? prompt : null;
  if (workspace.environment.kind === 'wsl') {
    return {
      command: 'wsl.exe',
      args: [
        '-d', workspace.environment.distro,
        '--cd', directory?.innerPath ?? workspace.innerPath,
        '--exec', 'bash', '-lc',
        onArgv ? `${invocation.line} ${singleQuoted(onArgv)}` : invocation.line,
      ],
      // wsl.exe itself runs from wherever; --cd places the agent inside the project.
      cwd: undefined,
    };
  }

  return {
    command: invocation.command,
    args: invocationArgs(invocation, prompt),
    cwd: directory?.path ?? workspace.path,
  };
}

export interface AgentRun {
  ok: boolean;
  /** The GitHub URL the run was asked to produce, or null when it produced none. */
  url: string | null;
  output: string;
  error: string | null;
  /**
   * What the process exited with, or null when it never got as far as exiting.
   *
   * `ok` folds two questions into one — the process exited zero *and* it printed a URL — and a
   * caller that has to tell "ended early" from "crashed" cannot get that back out of it. That
   * is exactly the distinction an automatic recovery turns on: a turn that ended while a
   * background command was still pending exits **zero** and is worth finishing, while a command
   * that could not be found or blew up is a broken machine and retrying it burns a run for
   * nothing. Null for a timeout and for a refusal made before anything was spawned, both of
   * which are also not worth a second attempt.
   */
  code: number | null;
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
  /**
   * Whether what is in there is an interface rather than a command that prints and exits.
   *
   * It changes what the ending *means*, which is why the host has to say. A headless agent
   * exits when its work is done and its exit code is that verdict. An interface has no such
   * moment: it goes back to its own prompt, and it ends when the reader ends it — `/exit`,
   * or the tab's `×`, which is a kill and reports whatever a kill reports. Reading an exit
   * code there would fail every run a reader closed after watching it succeed, so the
   * transcript is the verdict instead, and the prompt already ends by ordering the agent to
   * print the URL last.
   */
  interactive?: boolean;
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
  /** Which backend is running, so the host can render its stream the way its CLI reads. */
  adapter: AgentAdapter;
  /** The argv to run, and where the prompt goes — see `AgentInvocation.prompt`. */
  invocation: AgentInvocation;
  directory: AgentDirectory | null;
  /**
   * The prompt.
   *
   * Where it goes is `invocation.prompt.via`'s answer and not the host's: on stdin, followed by
   * the end of file the agent is waiting for, or as the last element of argv for a run that is
   * going to draw an interface and needs stdin left for the reader.
   */
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
/**
 * The last thing the agent actually *said*, for a message a person has to read.
 *
 * The tail of stdout used to be it, and for a streaming agent the tail of stdout is machinery.
 * Issue #306's block reported its failure as this, verbatim:
 *
 *     "end_time":1785491933119},"uuid":"ee83a80f-…"}
 *     {"type":"system","subtype":"task_notification",…,"summary":"Wait for the suite output…"}
 *
 * — which is true, and is not an explanation. What the agent said, one event earlier, was
 * *"Waiting on npm test; both background waiters will report."*, which is the whole diagnosis.
 *
 * Falls back to the tail whenever no assistant text is found, because that is exactly right for
 * the other kind of command: a plain `claude -p` with no `--output-format` prints prose, and its
 * last 600 characters were always the correct answer. So this narrows a message when it can and
 * changes nothing when it cannot.
 *
 * Deliberately tolerant of every shape but the one it wants. A line that is not JSON, an event
 * with no message, a content block that is not text — all of them are simply not assistant text,
 * and none of them is worth failing a run's error message over.
 */
export function lastThingSaid(stdout: string, limit = 600): string {
  let said: string | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event: unknown;
    try { event = JSON.parse(trimmed); } catch { continue; }
    const message = (event as { type?: unknown; message?: unknown });
    if (message.type !== 'assistant') continue;
    const content = (message.message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const part = block as { type?: unknown; text?: unknown };
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        said = part.text.trim();
      }
    }
  }

  return (said ?? stdout.trim()).slice(-limit);
}

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
    code,
    error: code === 0
      ? (url
          ? null
          : `Agent finished without returning ${noun}. It said: ${lastThingSaid(stdout) || '(nothing)'}`)
      : `Agent exited with code ${code}: ${(stderr || stdout).slice(-500)}${hint}`,
  };
}

/** What a shell exits with when it could not find the command it was given. */
const COMMAND_NOT_FOUND = 127;

export interface RunAgentOptions {
  /**
   * Which agent this is.
   *
   * There is no command line here any more, and that is the change: everything this module
   * used to work out by reading one — does the run print and exit, does it stream, what does an
   * event of its output mean — is now the backend's to answer, once, rather than four regular
   * expressions that had to agree with each other.
   */
  adapter: AgentAdapter;
  /** The argv to spawn and where its prompt goes, as the adapter built it. */
  invocation: AgentInvocation;
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
  // A private child always gets the prompt on stdin: it has no interface to draw and no reader
  // to type into it, so the end of file that closes the prompt is free. What the invocation's
  // `prompt.via` decides is whether a *hosted* run gets a pseudoterminal — and the marker a
  // backend needs for stdin is already in its argv.
  const { command, args, cwd } = buildAgentCommand(workspace, options.invocation, options.directory);
  // The article travels with the noun. A fixed one reads as "a issue URL".
  //
  // The host travels with it too, and that is the whole of #322 at this end: a run that
  // created its issue on a GitHub Enterprise Server ended with "Agent finished without
  // returning an issue URL" under a transcript that plainly contained one. It names the
  // requirement now — see `github-host.ts`.
  const noun = options.expects === 'pull'
    ? `a ${GITHUB_HOST} pull request URL`
    : `a ${GITHUB_HOST} issue URL`;

  logger.info(`Running ${options.what} for workspace "${workspace.id}"`, { command, cwd });

  // Worked out once, here, because both paths below end in the same `agentOutcome` and a
  // second copy of this would be a second answer to the same question.
  const notFoundHint = options.notFoundVariable
    ? commandNotFoundHint(workspace, options.invocation, options.notFoundVariable)
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
    // caller asked *and* this invocation streams, which is what keeps this off by default.
    const meter = options.onUsage && options.adapter.streams(options.invocation)
      ? new UsageMeter(options.onUsage, undefined, options.adapter)
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
        // Killed rather than exited: there is no code, and a run this process had to
        // stop is not one to start again.
        code: null,
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
      // Never spawned, so there is no exit code and nothing a second attempt would fix.
      resolve({ ok: false, url: null, output: stdout, code: null, error: error.message });
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
  const meter = options.onUsage && options.adapter.streams(options.invocation)
    ? new UsageMeter(options.onUsage, undefined, options.adapter)
    : null;

  let handle: AgentHostHandle | null = null;
  try {
    handle = await host({
      adapter: options.adapter,
      invocation: options.invocation,
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

  // A screen is not prose. Everything below reads the transcript for a URL, and on a
  // pseudoterminal that transcript carries the sequences that painted it — so they come out
  // first, and only for the run that has them. A headless run's output is untouched.
  const transcript = handle.interactive ? stripAnsi(stdout) : stdout;

  if (timedOut) {
    // The same salvage a private child gets, and for the same reason: an agent may well
    // have finished the visible work and kept going, and reporting a failure for work that
    // succeeded invites a second run for it. It is worth more here — a hosted run's
    // transcript is everything the process wrote, streamed, rather than a buffer that a
    // non-streaming `claude -p` leaves empty until it exits.
    const salvaged = extractGithubUrl(transcript, options.expects);
    return {
      ok: Boolean(salvaged),
      url: salvaged,
      output: stdout,
      code: null,
      error: salvaged
        ? null
        : `Agent timed out after ${(timeoutMs as number) / 1000}s without returning ${noun}`,
    };
  }

  // An interface's exit code is not an answer — see `AgentHostHandle.interactive`. The URL
  // is, and it is the same URL `agentOutcome` would have looked for; what is dropped is the
  // `code === 0` half of the verdict, which for a session the reader closed says only that
  // it was closed.
  if (handle.interactive) {
    const url = extractGithubUrl(transcript, options.expects);
    return {
      ok: Boolean(url),
      url,
      output: stdout,
      code: null,
      error: url
        ? null
        : `The interactive session ended without ${noun}. It said: `
          + `${lastThingSaid(transcript) || '(nothing)'}`,
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

/**
 * The section carrying the project's own workflow — or nothing at all.
 *
 * Nothing at all is the important half a third time: a project that selects no workflow must
 * send the prompt it sent before this existed, byte for byte.
 *
 * **The text, not a pointer to it.** Both base prompts already point at a project's own
 * conventions — "read your own project memory […] and follow the workflow it records" — and a
 * pointer is exactly what this exists because of: an agent may or may not follow it, a fresh
 * worktree may hold no memory to follow, and a typo in the name degrades to silence. What the
 * board writes into the turn is the authorization, so what has to be in the turn is the
 * workflow itself.
 *
 * **Last, and it says so.** The base prompt above has already told the agent how to decide,
 * and a literal reader takes the first instruction it was given. So this is appended after the
 * worktree and resume sections and states plainly that it wins — otherwise a project asking for
 * a planning pass before any code is written is read as advice competing with an order.
 *
 * **And it grants nothing.** A workflow is text in a prompt: nothing from it reaches argv, the
 * environment, `--allowedTools` or `--dangerously-skip-permissions`. That is the same boundary
 * `applyAgentSettings` keeps — a project retunes the agent the operator allowed, it never
 * grants itself one — so the section says it out loud rather than leaving an agent to infer
 * that a workflow asking for something it cannot do is a licence to go and get it.
 */
export function workflowSection(text: string | null | undefined): string {
  if (!text || !text.trim()) return '';

  return `\n\n---\n\nThis project has written down how work like this is done in it, and that
text is authoritative for this run: follow it. It is reproduced in full below, and it is the
last word — where it asks for something the instructions above leave to your judgement, or
asks for more than they do, do what it says.

It cannot widen what you are allowed to do. It grants no tool, no permission and no command
you were not already given; it says how to use the ones you have. If something in it would
need a capability you do not have, do as much of it as you can and say in your report what you
could not do and why — never treat it as a reason to go and obtain one.

${text.trim()}`;
}

export async function runIssueAgent(
  workspace: Workspace,
  observation: string,
  options: {
    /** Which agent, and the command that reaches it. See `agentCommandFor`. */
    agent: AgentCommandSpec;
    timeoutMs?: number;
    imagePaths?: readonly string[];
    /** Named when the command turns out not to exist where it was run. See RunAgentOptions. */
    notFoundVariable?: string | null;
    /**
     * The run's token totals so far, whenever they change. See `RunAgentOptions.onUsage`.
     *
     * Passed straight through, and it is the whole of the research side's opt-in: the meter
     * is built only when the configured command already asks for a machine-readable stream,
     * so a board running a plain `claude -p` reaches none of it and the spawn path below is
     * byte for byte what it was.
     */
    onUsage?: (usage: AgentUsage) => void;
  }
): Promise<IssueAgentResult> {
  // Per run, not per process: one board runs several projects, and the model, the effort,
  // the ceiling and the workflow are each the project's to set. A caller that names a ceiling
  // still wins — that is the route asking for one, not a default being applied.
  const settings = workspace.agents?.issue ?? null;
  // Before the prompt is built, so a workflow that cannot be read stops the run here rather
  // than spawning an agent that would silently work the wrong way.
  const workflow = await loadAgentWorkflow(workspace, 'issue', settings);
  if (!workflow.ok) return { ok: false, issueUrl: null, output: '', error: workflow.error };

  // The project's language, per run, for the reason the model and the effort are per run:
  // one board runs several projects, and what language a project's issues are written in is
  // that project's to say.
  const prompt = `${issueAgentPrompt(workspace.language)}\n\n---\n\nObservation:\n\n${observation}`
    + imageReferenceSection(options.imagePaths ?? [])
    + workflowSection(workflow.text);
  const timeoutMs = options.timeoutMs !== undefined
    ? options.timeoutMs
    : settings?.timeoutMs ?? undefined;
  const run = await runAgent(workspace, prompt, {
    ...agentRunFor(options.agent, 'issue', settings),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    expects: 'issues',
    what: 'issue agent',
    notFoundVariable: options.notFoundVariable ?? null,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
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
    /** The issue agent, which is the same agent researching one. See `agentCommandFor`. */
    agent: AgentCommandSpec;
    timeoutMs?: number;
    /** Named when the command turns out not to exist where it was run. See RunAgentOptions. */
    notFoundVariable?: string | null;
    /** The run's token totals so far. The same opt-in as `runIssueAgent`, one seam not two. */
    onUsage?: (usage: AgentUsage) => void;
  }
): Promise<IssueAgentResult> {
  // The issue agent's settings, workflow included: rewriting an issue is the same agent doing
  // the same work with an issue already in front of it, so a project that said how its issue
  // agent works said it about both of its runs.
  const settings = workspace.agents?.issue ?? null;
  const workflow = await loadAgentWorkflow(workspace, 'issue', settings);
  if (!workflow.ok) return { ok: false, issueUrl: null, output: '', error: workflow.error };

  const prompt = `${issueRevisePrompt(workspace.language)}\n\n---\n\nThe issue to rewrite: ${issueUrl}`
    + `\n\n---\n\nNew observations:\n\n${observations}`
    + workflowSection(workflow.text);
  const timeoutMs = options.timeoutMs !== undefined
    ? options.timeoutMs
    : settings?.timeoutMs ?? undefined;
  const run = await runAgent(workspace, prompt, {
    ...agentRunFor(options.agent, 'issue', settings),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    expects: 'issues',
    what: 'issue revise agent',
    notFoundVariable: options.notFoundVariable ?? null,
    ...(options.onUsage ? { onUsage: options.onUsage } : {}),
  });
  return { ok: run.ok, issueUrl: run.url, output: run.output, error: run.error };
}
