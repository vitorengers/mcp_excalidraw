/**
 * What a coding agent *is*, to the rest of this board.
 *
 * Until now there was no such thing. `EXCALIDRAW_ISSUE_AGENT` and `EXCALIDRAW_IMPLEMENT_AGENT`
 * were free text, and every behaviour that depended on which agent was running was re-derived
 * by a regular expression over that same text: whether the run prints and exits, whether it
 * streams token counts, how to take the print flags off it for one run, how to put a model and
 * an effort onto it. Five readings of one string, each of which had to be kept in step with the
 * other four, and none of which could ever answer a question a *different* CLI spells
 * differently — a board could not name a backend, ask what it can do, or write a flag for it.
 *
 * An adapter is that name. It turns a role and a mode into an `AgentInvocation` — an argv, and
 * where the prompt goes — and it answers the four questions the rest of the board asks about a
 * running agent: does it stream, what do its usage events mean, how is one of its events drawn
 * in a transcript, and what kind of thing is the step it just took.
 *
 * ## `raw` is a backend, not a bypass
 *
 * Every board configured today, and twenty check scripts, name their agent as a command line
 * and expect it spawned byte for byte. That is a *backend* — "an arbitrary command line, run as
 * given, which streams if and only if it says `--output-format stream-json`" — and it is
 * implemented as one, in `agents/raw.ts`, rather than as a special case threaded past the
 * adapter. It is the default, so a board that names nothing keeps the run it has always had.
 *
 * ## Why the invocation carries a `line`
 *
 * A workspace inside a WSL distro is reached through `wsl.exe … --exec bash -lc <line>`, and
 * for the `raw` backend that line has to be the operator's own string, untouched: it is theirs,
 * a shell parses it, and one that says `source ~/.nvm/nvm.sh && claude -p` means it. Tokenising
 * it and quoting the pieces back together would produce the same argv for the common case and
 * silently break that one. So an invocation carries both — argv for a spawn on this machine,
 * and the line for the shell on the other side of the boundary — and each backend decides which
 * is derived from which. `raw` keeps the operator's line and derives argv; a named backend
 * builds argv and derives a quoted line from it.
 *
 * The pure command-line helpers below live here rather than in `issue-agent.ts` because
 * `agents/raw.ts` is the module that reads a command line now, and a helper it imported from
 * there would close a cycle. `issue-agent.ts` re-exports them, so every caller that had them
 * from there still does.
 */
import type { AgentAction } from './terminal-palette.js';
import type { TranscriptState } from './agent-stream-render.js';

/** The two agents, which are two because granting research must not grant repository writes. */
export type AgentRole = 'issue' | 'implement';

/**
 * The backends this board can name.
 *
 * A closed list rather than a plugin lookup, deliberately: an adapter decides what argv a
 * process is spawned with, so "whatever is on disk under this name" would be a way to run
 * something on a board where only a command line was ever granted.
 */
export type AgentBackendId = 'claude-code' | 'codex-cli' | 'raw';

export const AGENT_BACKEND_IDS: readonly AgentBackendId[] = ['claude-code', 'codex-cli', 'raw'];

/**
 * What a board falls back to, and it is `raw` for one reason: every board that exists was
 * configured before backends did, as a command line, and must go on spawning exactly that.
 */
export const DEFAULT_AGENT_BACKEND: AgentBackendId = 'raw';

/** A backend named as text, or null when the name is not one of them. */
export function agentBackendId(value: string | null | undefined): AgentBackendId | null {
  const named = (value ?? '').trim().toLowerCase();
  return (AGENT_BACKEND_IDS as readonly string[]).includes(named)
    ? (named as AgentBackendId)
    : null;
}

/**
 * One agent as the board holds it: which backend, and the command that reaches its binary.
 *
 * The two travel together because they have to. A command is not portable across the WSL
 * boundary — see `agentCommandFor` — so the board keeps one per environment, and the backend
 * belongs to the command rather than to the board: an operator with Claude Code on the host and
 * something else inside a distro is naming two different agents, not one agent twice.
 */
export interface AgentCommandSpec {
  backend: AgentBackendId;
  /** The command line the operator granted. For `raw` it is the whole invocation. */
  command: string;
}

/**
 * One run, as an argv and a decision about where the prompt goes.
 *
 * `prompt.via` is not a preference. A command that prints an answer and exits reads its prompt
 * from stdin and needs the end of file that closes it, which a pseudoterminal cannot give — so
 * that run goes on pipes. A command that would draw an interface takes its prompt as an
 * argument and keeps stdin for the reader. Everything downstream that used to ask "does this
 * command line say `-p`" asks this instead.
 *
 * **And `prompt.stdin` is the other half of the same answer**, because "where the prompt goes"
 * does not settle what becomes of the channel it did not go down. A pipe nobody ever writes to
 * and nobody ever closes is not an absence: `read()` on it blocks for ever, which is
 * openai/codex#20919 — *"the writer side is open but no bytes ever arrive and no EOF is
 * delivered"* — and the workaround that issue gives is `< /dev/null`, which is a closed empty
 * pipe. So an invocation says what to do with stdin as well as where the prompt goes, and the
 * two are not the same question: Codex's headless and interactive runs both take the prompt on
 * argv and want opposite things done with stdin.
 */
export interface AgentInvocation {
  /** argv[0], as this backend spells it. */
  command: string;
  args: string[];
  prompt: {
    via: 'stdin' | 'argv';
    /**
     * What is to become of stdin, which is not answered by `via` alone.
     *
     *  - `prompt` — the prompt goes there, and it is closed behind it. `via` is `stdin`.
     *  - `closed` — nothing goes there and it is closed at once, because this CLI would sit on
     *    an open pipe rather than start. `codex exec <prompt>` is the case.
     *  - `reader` — it belongs to whoever is watching, which is what makes a run like this
     *    worth a pseudoterminal. Where there is nobody watching — a private child, a session
     *    that got pipes — there is no reader to keep it for and it is closed like `closed`.
     */
    stdin: 'prompt' | 'closed' | 'reader';
    /**
     * The argv token that stands in for a prompt arriving on stdin, when the CLI wants one.
     *
     * `codex exec -` is the case: without the `-` the prompt on stdin is read as *context*
     * beside an instruction that is not there. It is already in `args` — a caller never has to
     * place it — and it is recorded so that a reader, and a check, can tell a run that asked
     * for stdin from one that merely left the prompt off.
     */
    marker?: string;
  };
  /**
   * The same invocation as one line, for the shell inside a distro.
   *
   * See the note at the top of this file: for `raw` this is the operator's own string and argv
   * is derived from it; for a named backend it is derived from argv, single-quoted.
   */
  line: string;
}

/** What the board asks a backend for: a run of this kind, for this role, tuned this way. */
export interface AgentInvokeSpec {
  /**
   * `headless` prints an answer and exits; `interactive` would draw an interface given one.
   *
   * The board asks for `interactive` when the reader asked for a tab to answer rather than to
   * watch. For `raw` that means taking the print flags off the operator's command line, which
   * is the same request they make by leaving them out of the variable — made once instead of
   * forever, and it only ever *removes*.
   */
  mode: 'headless' | 'interactive';
  role: AgentRole;
  /** The command line the operator granted for this role and environment. */
  command: string;
  /** The project's own model, when it set one. */
  model?: string | null;
  /** The project's own reasoning effort, when it set one. */
  effort?: string | null;
  /** Anything the caller needs on the end of argv. Nothing in `src/` passes any today. */
  extraArgs?: readonly string[];
  /**
   * Whether the operator has explicitly asked for the guard to come off this run.
   *
   * Never a default and never derived from the role: it is one setting, read once in
   * `agentRunFor`, and it reaches `implement` alone. See `PermissionPosture`.
   */
  fullAccess?: boolean;
}

// ─── The posture a run is given ───────────────────────────────

/**
 * How much of the machine a run is granted, as the three answers that exist.
 *
 * This was documentation prose until #327. The separation the whole board rests on — the issue
 * agent reads, the implement agent writes — was a sentence telling an operator to type
 * `--allowedTools "…"` into one variable and `--dangerously-skip-permissions` into the other,
 * and a grep of `src/` found those names only inside comments. Nothing supplied them, nothing
 * inspected them, and nothing could: they are Claude Code's spellings, and the CLI beside it
 * has no textual equivalent of either.
 *
 * So posture is a per-backend fact, which is what an adapter is for. `invoke` is asked for a
 * role and writes the flags that make that role true, and the operator's own `extraArgs` are
 * appended after so that pinning something extra still works.
 *
 * **Two rules hold for every backend.** An operator who has already stated a posture keeps it —
 * this repository's own board pins `--allowedTools` by hand, and for the `raw` backend, which is
 * every board today, their command line is the *only* place a posture can live. And the issue
 * role never carries a full-access marker, whoever wrote it: a `--yolo` typed to make a refused
 * run work hands the research agent the machine, from an API with no authentication in front of
 * it. That one is taken back off rather than merely not added.
 */
export type PermissionPosture = 'read-only' | 'write' | 'full-access';

/**
 * The issue agent's grant, and the list `docs/trap-allowed-tools.md` explains rule by rule.
 *
 * Every rule names a sub-command rather than a binary, which is where the narrowness lives:
 * whole `git` is `git push --force` and whole `gh` is `gh repo delete`. It is here rather than
 * only in that document because a document is not a boundary — but the document is still where
 * the argument for each row is, and `check-agent-permissions.mjs` holds the two to being the
 * same list.
 */
export const CLAUDE_ISSUE_ALLOWED_TOOLS = 'Bash(gh issue list:*) Bash(gh issue view:*) '
  + 'Bash(gh issue create:*) Bash(gh issue edit:*) Bash(gh issue comment:*) '
  + 'Bash(gh project item-add:*) Bash(git log:*) Bash(git show:*) Bash(git diff:*) '
  + 'Bash(git blame:*) Read Grep Glob WebFetch WebSearch';

/**
 * The implement agent's grant: wide, and bounded anyway.
 *
 * **Wide**, because an enumerated list is also a deny list and a run refused in print mode is
 * refused *silently* — the trap the other document is about. A minimal list would reinstate it
 * on the agent that has the most to do.
 *
 * **Bounded anyway**, because the alternative shipped by default was
 * `--dangerously-skip-permissions`, on an agent whose prompt is built from issue text anybody
 * can write. What the bound excludes is arbitrary shell: no `curl`, no `ssh`, no installer, no
 * command this list does not name.
 *
 * The `Bash` rules name binaries rather than verbs here, and that inversion is deliberate: an
 * agent that must commit, push and open a pull request needs `git` and `gh` whole, so scoping
 * them by verb would only be theatre. The cost lands where the trap document says it does — a
 * project whose build is not `npm` gets a silent refusal until its runner is added, which is
 * why the documented list is a starting point an operator widens **by name, never by removing
 * the list**.
 *
 * The tool names are the CLI's own, from `claude --help`, whose `--allowedTools` example is
 * `"Bash(git *) Edit"`. `MultiEdit` is deliberately absent: it is not in the current tool set,
 * and a name that does not exist grants nothing while reading as though it did.
 */
export const CLAUDE_IMPLEMENT_ALLOWED_TOOLS = 'Read Grep Glob Write Edit NotebookEdit '
  + 'Task TodoWrite WebFetch WebSearch Bash(git:*) Bash(gh:*) Bash(npm:*) Bash(npx:*) '
  + 'Bash(node:*)';

/** What one backend writes for each posture, and how it recognises one already written. */
export interface BackendPermissions {
  /** The arguments this backend appends for a posture. */
  flags: Record<PermissionPosture, readonly string[]>;
  /** Flags whose presence means the operator has already stated a posture. */
  decided: readonly string[];
  /** Whole arguments that grant everything on their own. */
  fullAccessFlags: readonly string[];
  /** A flag that grants everything through its *value*, in either spelling. */
  fullAccessValues: { flags: readonly string[]; values: readonly string[] } | null;
}

/**
 * The two named backends' spellings of the same three decisions.
 *
 * The Codex halves were read out of that CLI's own documentation rather than remembered, and
 * two of the facts decide the shape rather than decorate it:
 *
 *  - `codex exec` is **read-only by default** and in that mode "cannot edit files or run
 *    commands that require network access". So the read-only posture is one in which `gh`
 *    cannot reach github.com — a fail-closed default, and the Codex half of the trap
 *    `docs/trap-allowed-tools.md` is about. An operator whose Codex issue agent has to open
 *    issues writes `--sandbox workspace-write` with `network_access` themselves, and keeps it,
 *    because a posture the operator stated is not overwritten.
 *  - under `workspace-write` the network is off unless `sandbox_workspace_write.network_access`
 *    turns it on, and `.git` stays read-only whatever else is writable. So the write posture
 *    turns the network on — without it the implement agent cannot reach `gh` at all — and it is
 *    still a posture in which `git commit` is refused. That is deliberate: full access is the
 *    opt-in, and a default that fails closed is the one to ship.
 */
export const AGENT_PERMISSIONS: Record<'claude-code' | 'codex-cli', BackendPermissions> = {
  'claude-code': {
    flags: {
      'read-only': ['--allowedTools', CLAUDE_ISSUE_ALLOWED_TOOLS],
      write: ['--allowedTools', CLAUDE_IMPLEMENT_ALLOWED_TOOLS],
      'full-access': ['--dangerously-skip-permissions'],
    },
    decided: ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions',
              '--permission-mode'],
    fullAccessFlags: ['--dangerously-skip-permissions'],
    fullAccessValues: null,
  },
  'codex-cli': {
    flags: {
      'read-only': ['--sandbox', 'read-only'],
      write: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'],
      'full-access': ['--sandbox', 'danger-full-access'],
    },
    // `--full-auto` is `workspace-write` with approvals on failure, which is a posture an
    // operator stated; the two bypass flags are aliases of each other.
    decided: ['--sandbox', '-s', '--full-auto', '--yolo',
              '--dangerously-bypass-approvals-and-sandbox'],
    fullAccessFlags: ['--yolo', '--dangerously-bypass-approvals-and-sandbox'],
    fullAccessValues: { flags: ['--sandbox', '-s'], values: ['danger-full-access'] },
  },
};

/** The posture a role gets: reading, writing, or what somebody asked for on purpose. */
export function postureFor(role: AgentRole, fullAccess?: boolean): PermissionPosture {
  if (role === 'issue') return 'read-only';
  return fullAccess ? 'full-access' : 'write';
}

/**
 * The posture flags to append, or nothing at all when the operator has already said.
 *
 * Nothing at all is the half that keeps a board working: a command line that already carries
 * `--allowedTools` or a `--sandbox` is one whose author decided, and a second `--allowedTools`
 * beside theirs would be this board overruling a grant it was handed rather than filling one in.
 */
export function permissionArgs(
  permissions: BackendPermissions,
  posture: PermissionPosture,
  args: readonly string[]
): string[] {
  if (hasArgument(args, ...permissions.decided)) return [];
  return [...permissions.flags[posture]];
}

/**
 * The same argv with every full-access marker taken out of it.
 *
 * Only ever called for the issue role, and that asymmetry is the point: the implement agent's
 * own flag is a decision its operator is entitled to make, and is warned about at startup
 * instead. The research agent's is a decision nobody makes on purpose — it is what somebody
 * types to get past a silent refusal, on the variable next to the one they meant.
 */
export function withoutFullAccess(
  permissions: BackendPermissions,
  args: readonly string[]
): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (permissions.fullAccessFlags.includes(argument)) continue;
    const valued = permissions.fullAccessValues;
    if (valued) {
      if (valued.flags.includes(argument)) {
        // The value travels with the flag: a `danger-full-access` left behind would become the
        // prompt, and a `--sandbox` left behind would swallow whatever came next.
        if (valued.values.includes(args[index + 1] ?? '')) { index += 1; continue; }
      } else if (valued.flags.some((flag) => valued.values.some(
        (value) => argument === `${flag}=${value}`
      ))) continue;
    }
    kept.push(argument);
  }
  return kept;
}

/**
 * The full-access flag a command line carries, or null — whichever backend spells it.
 *
 * Read off the operator's own string rather than off an invocation, because the caller is the
 * preflight: what it holds at startup is a command line, and for the `raw` backend that string
 * is the whole grant. Every spelling of both named backends, because a board names a backend
 * for a command and the preflight has not resolved one.
 */
export function fullAccessFlag(command: string): string | null {
  const argv = tokenizeCommand(command);
  for (const permissions of Object.values(AGENT_PERMISSIONS)) {
    for (const flag of permissions.fullAccessFlags) if (argv.includes(flag)) return flag;
    const valued = permissions.fullAccessValues;
    if (!valued) continue;
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index] ?? '';
      for (const flag of valued.flags) {
        for (const value of valued.values) {
          if (argument === flag && argv[index + 1] === value) return `${flag} ${value}`;
          if (argument === `${flag}=${value}`) return argument;
        }
      }
    }
  }
  return null;
}

/** Input, output and the reasoning share of the output, as one report says them. */
export interface UsageCounts {
  input: number;
  output: number;
  /** Null is "not said", which is not the same answer as 0. */
  thinking: number | null;
}

/**
 * What one event of an agent's stream says about what the run has spent.
 *
 * Three shapes, because agents report in three ways and the meter has to tell them apart:
 *
 *  - `message` — a running figure for one message, which may be re-sent as it grows. Keyed by
 *    id so the last one wins rather than being added to the first; `id: null` for a report
 *    that names nothing, which is then counted as its own.
 *  - `settled` — the run's own final accounting, which *replaces* the sum rather than adding
 *    to it.
 *  - `thinking` — a delta of internal reasoning, which accumulates and is kept beside the
 *    totals rather than inside them. See `UsageMeter`.
 */
export type UsagePatch =
  | { kind: 'message'; id: string | null; counts: UsageCounts }
  | { kind: 'settled'; counts: UsageCounts }
  | { kind: 'thinking'; delta: number };

/**
 * One coding agent, named.
 *
 * Everything the board needs to know about a CLI it does not own. Deliberately narrow: an
 * adapter builds an invocation and reads a stream, and it never spawns anything, never touches
 * a workspace and never decides whether a run succeeded — those are `issue-agent.ts`'s, and
 * they are the same for every backend.
 */
export interface AgentAdapter {
  readonly id: AgentBackendId;

  /** The argv this run is spawned with, and where its prompt goes. */
  invoke(spec: AgentInvokeSpec): AgentInvocation;

  /**
   * The reasoning-effort levels this backend accepts, in its own spelling.
   *
   * Per backend rather than one list, because a level is not a portable word. It used to be one
   * — `AGENT_EFFORTS` in `workspaces.ts`, documented as *"as `claude --help` states them"* — and
   * that list is wrong for any backend that is not Claude Code in both directions at once: it
   * refuses `minimal`, `none` and `ultra`, which Codex takes, while a board pointed at Codex
   * that wrote one of them had it silently dropped on the way in and refused with a message
   * naming no backend on the way out. The operator could not tell a typo from a mismatch.
   *
   * Empty is a legitimate answer and means "this backend has no effort to set", which is not
   * the same as "any word will do": a value offered to a backend that names none is refused.
   */
  readonly efforts: readonly string[];

  /**
   * Whether this invocation speaks while it works, rather than printing prose at exit.
   *
   * Asked of the invocation rather than of the backend, because for `raw` it is the operator's
   * flag that decides and for a named backend it is the mode. It is what turns on the token
   * counts and the readable transcript together, and both are off without it.
   */
  streams(invocation: AgentInvocation): boolean;

  /** What one event says about the totals, or null when it says nothing about them. */
  readUsage(event: Record<string, unknown>): UsagePatch | null;

  /** One event, drawn into a transcript somebody is watching. Empty means "nothing to show". */
  renderEvent(event: Record<string, unknown>, ids: TranscriptState): string;

  /**
   * The event types this backend has an opinion about, including the ones it draws nothing for.
   *
   * `renderEvent` answers "claimed and deliberately silent" and "never heard of it" with the
   * same empty string, and #325 is what those two cost when they are read as one: a stream made
   * entirely of unknown envelopes rendered to nothing, and a block somebody was watching stayed
   * blank for a whole run. So the set is declared beside the renderer, and `AgentStreamRenderer`
   * prints anything outside it verbatim rather than dropping it.
   *
   * It is per backend rather than per renderer, which is the whole reason it moved here: Codex's
   * silent types are `thread.started` and `turn.started`, and drawing those decisions from
   * Claude Code's list would silence its first line and print Claude Code's banner.
   */
  readonly claimedTypes: ReadonlySet<string>;

  /**
   * What kind of thing a step is, by whatever this backend calls it.
   *
   * A tool name for Claude Code, an item type for Codex. It decides the colour a row is drawn
   * in — see `terminal-palette.ts` — and `other` is the honest answer for a name nobody here
   * has heard of.
   */
  actionOf(stepName: string): AgentAction;
}

// ─── Reading and writing a command line ───────────────────────

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

/**
 * A value a shell inside the distro will hand on exactly as it was given.
 *
 * Single quotes, because they are the one quoting in `sh` that means "no expansion at all" —
 * the `$name` trap `buildAgentCommand` records is precisely what double quotes would leave
 * open. A single quote inside the value is the only thing that has to be spelled out, and
 * `'\''` is how: close the run, an escaped quote, open it again.
 */
export function singleQuoted(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** An argv as one line a shell will parse back into the same argv. */
export function quotedLine(command: string, args: readonly string[]): string {
  return [command, ...args].map(singleQuoted).join(' ');
}

/**
 * Whether a command line asks its agent to print an answer and exit.
 *
 * The flag is Claude Code's, and it is read rather than required because an operator who
 * already asks for a non-interactive run gets the run they have always had without changing
 * anything. A command that says neither `-p` nor `--print` is one that would start an interface
 * if it were given a terminal, and that is the whole of the signal. This is the `raw` backend's
 * reading of somebody else's string; a named backend knows the answer without looking.
 *
 * Matched as a whole argument. `--print-mode` is not `--print`, and a path with `-p` inside
 * it is not a flag.
 */
export function runsHeadless(agentCommand: string): boolean {
  return /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(agentCommand);
}

/**
 * The same command line with the flags that make it headless taken off it.
 *
 * This is how the board offers an interactive tab for one run without the operator editing
 * `EXCALIDRAW_IMPLEMENT_AGENT` and restarting the server. The shape of the command still
 * decides the *default*; what changes is that the reader can say "not this one" at the moment
 * they start it.
 *
 * **It only ever removes**, and that asymmetry is deliberate. Adding `-p` to a command that
 * does not have it would leave the run with no `--output-format stream-json` to read token
 * counts from and no way to invent one — a board writing flags into a command line it does
 * not own is a decision, not a lookup. So a command that is already interactive comes back
 * unchanged.
 *
 * **More than `-p` comes off, because `-p` does not travel alone.** `--output-format`,
 * `--input-format` and `--include-partial-messages` are documented by `claude --help` as
 * *"only works with --print"*, so a command left carrying one of them after `--print` went
 * would be refused by the CLI rather than started. Nothing else is touched: a `--model`, an
 * `--add-dir` or anything else the operator wrote survives untouched, and a command that is
 * not Claude Code loses nothing it did not spell that way.
 *
 * Matched as whole arguments, like `runsHeadless`. An option's value goes with it in either
 * spelling, `--output-format json` and `--output-format=json`, because a value left behind
 * would become the prompt.
 */
export function withoutPrintFlags(agentCommand: string): string {
  // Each pattern eats the whitespace in front of the flag it removes, so what is left needs
  // no tidying up — which matters, because tidying up a command line means touching the parts
  // that were not the point. A quoted path with two spaces in it comes back with two spaces.
  return agentCommand
    .replace(/(?:^|\s)(?:--output-format|--input-format)(?:=\S+|\s+\S+)(?=\s|$)/g, '')
    .replace(/(?:^|\s)(?:-p|--print|--include-partial-messages)(?=\s|$)/g, '')
    .trim();
}

/** The same removal against an argv rather than a line, for a backend that builds one. */
export function withoutPrintArguments(args: readonly string[]): string[] {
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? '';
    if (argument === '--output-format' || argument === '--input-format') {
      // The value travels with the flag, or it would be left behind as the prompt.
      index += 1;
      continue;
    }
    if (/^(?:--output-format|--input-format)=/.test(argument)) continue;
    if (argument === '-p' || argument === '--print' || argument === '--include-partial-messages') continue;
    kept.push(argument);
  }
  return kept;
}

/** Whether an argv already carries one of these flags, in either spelling. */
export function hasArgument(args: readonly string[], ...names: readonly string[]): boolean {
  return args.some((argument) => names.some(
    (name) => argument === name || argument.startsWith(`${name}=`)
  ));
}

/**
 * A value on a command line: quoted only when it has to be.
 *
 * `tokenizeCommand` consumes quotes, and a bare value is what somebody reading the log would
 * have typed.
 */
export function commandLineValue(raw: string): string {
  return /\s/.test(raw) ? `"${raw}"` : raw;
}

/** A command line with flags appended, or the line unchanged when there are none. */
export function withCommandLineFlags(line: string, flags: readonly string[]): string {
  return flags.length ? `${line} ${flags.join(' ')}` : line;
}

/**
 * A command line as an invocation, spawned exactly as it reads.
 *
 * The `raw` backend is built on it, and so is every caller that holds a command line rather
 * than an agent — the preflight's `--version` probe, and a shell somebody typed into a terminal
 * block. It is deliberately not a backend of its own: what it does is what `raw` does.
 */
export function commandLineInvocation(line: string): AgentInvocation {
  const [command, ...args] = tokenizeCommand(line);
  const headless = runsHeadless(line);
  return {
    command: command ?? line,
    args,
    // A command line that says neither `-p` nor `--print` is one that would draw an interface
    // given a terminal, so its prompt goes beside it and stdin is the reader's — which is the
    // reading `raw` has always made of somebody else's string, now acted on rather than only
    // recorded.
    prompt: headless ? { via: 'stdin', stdin: 'prompt' } : { via: 'argv', stdin: 'reader' },
    line,
  };
}

/**
 * The argv a spawn actually uses: the invocation's, with the prompt on the end where it goes.
 *
 * One function rather than the same `if` at each of the three spawn sites — a private child, a
 * terminal session and the WSL wrapper all have to make the same decision, and three copies of
 * it is how one of them comes to send a prompt twice.
 */
export function invocationArgs(invocation: AgentInvocation, prompt?: string | null): string[] {
  const args = [...invocation.args];
  if (prompt && invocation.prompt.via === 'argv') args.push(prompt);
  return args;
}

/**
 * The other end of the same decision: what goes down the process's stdin, and then its close.
 *
 * Beside `invocationArgs` and for the same reason — a private child and a piped terminal
 * session both have to make this call, and two copies of it is how one of them comes to write
 * the prompt to a backend that is looking for it on argv.
 *
 * **It always ends the pipe.** For a stdin-delivering backend that is the end of file the run
 * has always needed; for the other two it is the `< /dev/null` openai/codex#20919 asks for,
 * because a pipe left open with no writer is a `read()` that never returns. `reader` is closed
 * here too, and that is not an oversight: this is the pipe case, so there is by construction no
 * reader — a session that has one gave the run a pseudoterminal and never reaches this.
 *
 * A `null` stream is a spawn that failed, which is settled by the error the caller is already
 * waiting on rather than by anything here.
 */
export function deliverStdin(
  stdin: { end(chunk: string): void; end(): void } | null | undefined,
  invocation: AgentInvocation,
  prompt?: string | null
): void {
  if (!stdin) return;
  if (invocation.prompt.stdin === 'prompt' && prompt) stdin.end(prompt);
  else stdin.end();
}
