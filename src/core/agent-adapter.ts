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
 * ## Nothing here reads a command line for a *decision*
 *
 * The helpers below tokenise one, quote one and take named arguments off one, and every one of
 * them is a transformation any backend may want. What is deliberately not here is the three
 * predicates that used to be — "does this string say `-p`", "does it say
 * `--output-format stream-json`", "take the print flags off it" — because those are not
 * transformations, they are *answers*, and answering them from somebody else's text is the thing
 * an adapter exists to stop. They are `agents/raw.ts`'s now, private to the one backend whose
 * contract is a string it did not write. Every other caller asks the invocation:
 * `prompt.via` for the first, `AgentAdapter.streams` for the second, `invoke({ mode })` for the
 * third.
 *
 * They live below rather than in `issue-agent.ts` because `agents/` is what reads a command line
 * now, and a helper an adapter imported from there would close a cycle. `issue-agent.ts`
 * re-exports the two that had other callers, so the preflight and the terminal still have them.
 */
import type { AgentAction } from './terminal-palette.js';
import type { TranscriptState } from './agent-stream-render.js';
import type { WorkspaceEnvironment } from './workspace-environment.js';

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
 */
export interface AgentInvocation {
  /** argv[0], as this backend spells it. */
  command: string;
  args: string[];
  prompt: {
    via: 'stdin' | 'argv';
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
 * One rate-limit window, as a backend reports it.
 *
 * Here rather than in `agent-limits.ts` for the reason `UsageCounts` is here rather than in
 * `agent-usage.ts`: it is part of what an adapter hands back, so the contract owns the shape and
 * the module that does the work imports it. That it also keeps this file free of Node — see
 * `workspace-environment.ts` — is what makes the rule cheap to keep.
 */
export interface RateWindow {
  /** 0 to 100. */
  usedPercent: number;
  /** Unix epoch seconds when the window resets, or null when the backend did not say. */
  resetsAt: number | null;
}

/**
 * One environment's reading. Every field is independently nullable, and `null` is
 * "not said" rather than `0` — the distinction `agent-usage.ts` already draws.
 *
 * A window may be absent for reasons that are entirely ordinary: Claude Code reports one "only
 * for Claude.ai subscribers (Pro/Max) after the first API response in the session", each of the
 * two independently. Reporting an absent one as `0%` would be a claim that nothing has been
 * spent.
 */
export interface AgentLimitsReading {
  /** What a reader calls this machine: `Windows`, `Host`, or the distro's own name. */
  label: string;
  environment: WorkspaceEnvironment;
  account: string | null;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  /** Unix epoch seconds the reading was taken, or null when there is no reading. */
  observedAt: number | null;
  /** How long ago that was, or null when there is no reading. Never negative. */
  ageSeconds: number | null;
  /** True only when there is a reading and it is older than `STALE_AFTER_SECONDS`. */
  stale: boolean;
}

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

  /**
   * What this backend has spent on each environment of this machine, or absent when it cannot say.
   *
   * **Optional, and absence is the answer.** A backend that has no way to report its own rate
   * limits does not carry this method at all, and the board draws nothing rather than a row of
   * dashes — `?.()` at the call site is the whole of the branch. A stub returning an empty list
   * would be a backend claiming to have looked, which is the one answer worse than silence.
   *
   * The reading is not a *pull* for the one backend that has it — see `agent-limits.ts` — so the
   * argument is a directory an operator's own script writes into rather than a session to
   * interrogate. A future backend that can be asked directly is free to ignore it; what a
   * backend may not do is make the board learn a second question (#334).
   */
  readLimits?(
    directory: string,
    registryDistros: readonly string[],
    now?: () => number
  ): Promise<AgentLimitsReading[]>;
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
 * The print flags, removed from an argv a backend built.
 *
 * `-p` does not travel alone: `--output-format`, `--input-format` and
 * `--include-partial-messages` are documented by `claude --help` as *"only works with --print"*,
 * so an argv left carrying one of them after the print flag went would be refused by the CLI
 * rather than started. Nothing else is touched — a `--model`, an `--add-dir` or anything else
 * the operator wrote survives.
 *
 * Matched as whole arguments. An option's value goes with it in either spelling,
 * `--output-format json` and `--output-format=json`, because a value left behind would become
 * the prompt.
 */
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
