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
 * It is also the default. A board that names no backend gets this, which is what makes the whole
 * adapter layer invisible to every setup that exists.
 */
import {
  commandLineInvocation, commandLineValue, withCommandLineFlags, withoutPrintFlags,
  type AgentAdapter, type AgentInvocation, type AgentInvokeSpec,
} from '../agent-adapter.js';
import { readClaudeUsage, streamsUsage } from '../agent-usage.js';
import { CLAUDE_CLAIMED_TYPES, renderClaudeEvent } from '../agent-stream-render.js';
import { agentAction } from '../terminal-palette.js';

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
   * Read off the line rather than required, because an operator who already streams gets the
   * token counts and the readable transcript without changing anything, and the server never
   * appends it: silently rewriting somebody's command line is a decision, not a lookup.
   */
  streams: (invocation) => streamsUsage(invocation.line),

  // A command line that streams is a command line streaming Claude Code's shapes — that is what
  // `--output-format stream-json` names. Anything else it prints is prose, and both of these
  // treat prose as nothing to report rather than as an error.
  readUsage: readClaudeUsage,
  renderEvent: renderClaudeEvent,
  claimedTypes: CLAUDE_CLAIMED_TYPES,
  actionOf: agentAction,
};
