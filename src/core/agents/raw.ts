/**
 * The backend that is an arbitrary command line.
 *
 * **Not a bypass, and that is the whole point of it being here.** Every board configured today
 * names its agent as free text in `EXCALIDRAW_ISSUE_AGENT` or `EXCALIDRAW_IMPLEMENT_AGENT`, and
 * twenty check scripts do the same with a stub — `node "<stub>" -p`. All of them must go on
 * spawning exactly what they spawned before an adapter existed, which is a *contract*, so it is
 * written down as one backend among the others rather than threaded past them as a special case:
 *
 *   an arbitrary command line, tokenised and spawned byte for byte, which streams if and only
 *   if it says `--output-format stream-json`.
 *
 * Everything it does was already being done, by four regular expressions scattered across
 * `issue-agent.ts`, `agent-usage.ts` and `server.ts`. What changes is that they are now one
 * backend's reading of one string, in one file, rather than four independent readings that had
 * to be kept in step with each other by hand.
 *
 * **Three of those regular expressions are below, and they are private to this file.** That is
 * the point rather than a tidying: `runsHeadless`, `withoutPrintFlags` and `streamsUsage` were
 * exported, and every module that wanted an answer about a run asked one of them about a string
 * — which is how `codex exec --json`, a command that is non-interactive and streams and says
 * none of their flags, came to be handed a pseudoterminal, marked interactive so its exit code
 * was thrown away, and given neither a token meter nor a transcript. There is nowhere left to
 * ask them from. A caller with an invocation asks it: `prompt.via` for the first,
 * `AgentAdapter.streams` for the second, and `invoke({ mode })` for the third — and for Codex
 * the third is a *subcommand*, which is a thing no flag-stripping function could ever express.
 *
 * It is also the default. A board that names no backend gets this, which is what makes the whole
 * adapter layer invisible to every setup that exists.
 */
import {
  commandLineValue, tokenizeCommand, withCommandLineFlags,
  type AgentAdapter, type AgentInvocation, type AgentInvokeSpec,
} from '../agent-adapter.js';
import { CLAUDE_CODE_EFFORTS } from './claude-code.js';
// `streamsUsage` used to come from here beside `readClaudeUsage`. It is defined below now, and
// the split is the point: what an *event* means is a grammar this backend shares with Claude
// Code, and whether a *command line* streams is a reading of somebody's text that belongs to
// the one backend given somebody's text.
import { readClaudeUsage } from '../agent-usage.js';
import { CLAUDE_CLAIMED_TYPES, renderClaudeEvent } from '../agent-stream-render.js';
import { agentAction } from '../terminal-palette.js';

/**
 * Whether a command line asks its agent to print an answer and exit.
 *
 * The flag is Claude Code's, and it is read rather than required because an operator who
 * already asks for a non-interactive run gets the run they have always had without changing
 * anything. A command that says neither `-p` nor `--print` is one that would start an interface
 * if it were given a terminal, and that is the whole of the signal. This is this backend's
 * reading of somebody else's string, and its own comment used to concede the limit: a command
 * that spells non-interactive some other way reads as interactive. That concession is why it is
 * private now — a named backend knows the answer without looking, and nothing outside this file
 * is entitled to the guess.
 *
 * Matched as a whole argument. `--print-mode` is not `--print`, and a path with `-p` inside
 * it is not a flag.
 */
function runsHeadless(agentCommand: string): boolean {
  return /(?:^|\s)(?:-p|--print)(?:\s|$)/.test(agentCommand);
}

/**
 * Whether a command line asks its agent for a machine-readable stream.
 *
 * The flag is Claude Code's, and it is named here because a command line handed to this backend
 * is, in practice, Claude Code's. Detecting it rather than requiring a second variable means an
 * operator who already streams gets the token counts and the readable transcript without
 * changing anything, and the server never appends it — silently rewriting somebody's command
 * line is a decision, not a lookup.
 *
 * Read off the *line* rather than off the argv, and for this backend those are the same text:
 * the line is what the operator wrote and the argv is what tokenising it produced. A named
 * backend answers from the argv it wrote itself, which is the difference the seam exists for.
 */
function streamsUsage(agentCommand: string): boolean {
  return /--output-format[\s=]+["']?stream-json/i.test(agentCommand);
}

/**
 * The same command line with the flags that make it headless taken off it.
 *
 * This is how the board offers an interactive tab for one run without the operator editing
 * `EXCALIDRAW_IMPLEMENT_AGENT` and restarting the server. The shape of the command still
 * decides the *default*; what changes is that the reader can say "not this one" at the moment
 * they start it.
 *
 * **It only ever removes**, and that asymmetry is deliberate — for *this* backend. Adding `-p`
 * to a command that does not have it would leave the run with no `--output-format stream-json`
 * to read token counts from and no way to invent one: writing flags into a command line this
 * board does not own is a decision, not a lookup. So a command that is already interactive comes
 * back unchanged. A named backend has no such asymmetry, because it wrote the flags.
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
function withoutPrintFlags(agentCommand: string): string {
  // Each pattern eats the whitespace in front of the flag it removes, so what is left needs
  // no tidying up — which matters, because tidying up a command line means touching the parts
  // that were not the point. A quoted path with two spaces in it comes back with two spaces.
  return agentCommand
    .replace(/(?:^|\s)(?:--output-format|--input-format)(?:=\S+|\s+\S+)(?=\s|$)/g, '')
    .replace(/(?:^|\s)(?:-p|--print|--include-partial-messages)(?=\s|$)/g, '')
    .trim();
}

/**
 * A command line as an invocation, spawned exactly as it reads.
 *
 * This backend is built on it, and so is every caller that holds a command line rather than an
 * agent — the preflight's `--version` probe, and a shell somebody typed into a terminal block.
 * It is exported from here rather than from `agent-adapter.ts` because reading a command line
 * for what it *means* is this backend's job and no longer anybody else's: those two callers are
 * asking for `raw`'s reading, and now they have to say so to get it.
 */
export function commandLineInvocation(line: string): AgentInvocation {
  const [command, ...args] = tokenizeCommand(line);
  return {
    command: command ?? line,
    args,
    // A command line that says neither `-p` nor `--print` is one that would draw an interface
    // given a terminal, so its prompt goes beside it and stdin stays the reader's — which is the
    // reading this backend has always made of somebody else's string, now acted on rather than
    // only recorded. Where the prompt does go to stdin it is closed behind it, which is the end
    // of file such a run is waiting for.
    prompt: runsHeadless(line)
      ? { via: 'stdin', stdin: 'prompt' }
      : { via: 'argv', stdin: 'reader' },
    line,
  };
}

/**
 * The project's own model and effort on the end of the operator's command — or nothing.
 *
 * Nothing is the important half: a project that configures neither must spawn the command line
 * it spawned before any of this existed, byte for byte.
 *
 * Appended rather than substituted, and appended rather than prepended, because the last flag is
 * the one the CLI keeps. That is not assumed: `claude --model sonnet --model definitely-not-a-model
 * -p hi` complains about the second one, so a project's setting placed after the operator's wins.
 * Nothing else in the operator's command is touched — the alternative, a whole per-workspace
 * command string, would be a project granting itself an agent rather than retuning the one the
 * board already allows.
 *
 * The spellings are Claude Code's because the command lines this backend is given are, in
 * practice, Claude Code's. That is the honest limit of a passthrough: it cannot know what flag a
 * different CLI would want, which is exactly the gap a *named* backend closes.
 */
function tunedCommandLine(line: string, spec: AgentInvokeSpec): string {
  return withCommandLineFlags(line, [
    ...(spec.model ? [`--model ${commandLineValue(spec.model)}`] : []),
    ...(spec.effort ? [`--effort ${commandLineValue(spec.effort)}`] : []),
    ...(spec.extraArgs ?? []).map(commandLineValue),
  ]);
}

export const rawAdapter: AgentAdapter = {
  id: 'raw',

  /**
   * The operator's line, tuned, tokenised.
   *
   * The order matters and is the order it already had: the print flags come off *first* — so an
   * interactive run is the operator's command with `-p` removed — and the project's model and
   * effort go on *after*, which is where the CLI reads them from. Reversing the two would put a
   * `--model` in front of a `--print` this backend had just taken out, and a run for a project
   * that configures nothing would no longer be byte for byte what it was.
   */
  invoke(spec: AgentInvokeSpec): AgentInvocation {
    const base = spec.mode === 'interactive' ? withoutPrintFlags(spec.command) : spec.command;
    return commandLineInvocation(tunedCommandLine(base, spec));
  },

  /**
   * The one flag that makes a command speak while it works.
   *
   * `invocation.line` rather than somebody else's string, and the distinction is the whole of
   * what changed: this is the line *this backend put there*, which for `raw` is the operator's
   * own text because that is what `raw` is. Every other reader of that flag is gone.
   */
  streams: (invocation) => streamsUsage(invocation.line),

  // Claude Code's levels, for the same reason `tunedCommandLine` writes Claude Code's flag: a
  // passthrough cannot know what a different CLI would want, and accepting a level this backend
  // would then spell `--effort ultra` at a binary that has never heard of it would be refusing
  // nothing. The honest limit of a passthrough, on the way in as well as on the way out.
  efforts: CLAUDE_CODE_EFFORTS,

  // A command line that streams is a command line streaming Claude Code's shapes — that is what
  // `--output-format stream-json` names. Anything else it prints is prose, and both of these
  // treat prose as nothing to report rather than as an error.
  readUsage: readClaudeUsage,
  renderEvent: renderClaudeEvent,
  claimedTypes: CLAUDE_CLAIMED_TYPES,
  actionOf: agentAction,
};
