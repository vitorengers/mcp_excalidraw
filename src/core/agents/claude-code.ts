/**
 * Claude Code, named.
 *
 * The difference from `raw` is not what it spawns — for a board already running
 * `claude -p --output-format stream-json --verbose` the argv comes out the same — it is that
 * this one *knows*. It does not read the operator's string to find out whether the run prints
 * and exits; it decides, from the mode it was asked for, and writes the flags that make it so.
 * Which means a board can say `claude` and get a run that streams, and an interactive run is a
 * mode rather than a regular expression removing flags from somebody else's text.
 *
 * **It adds, it does not replace.** The operator's command line is still where the binary comes
 * from and still where their own arguments come from — `--dangerously-skip-permissions`,
 * `--allowedTools`, `--add-dir`, an absolute path to a build nobody here knows about. What this
 * adds is only what is missing, which is why every flag below is written under a `hasArgument`
 * guard: a board that already spells `--print` must not be handed a second one.
 *
 * The flags are the CLI's own, confirmed against `claude --help` rather than remembered:
 * `--output-format`, `--input-format` and `--include-partial-messages` are documented there as
 * *"only works with --print"*, which is why the interactive mode below takes them off with the
 * print flag rather than leaving a run the CLI would refuse to start; and `--verbose` is what
 * `-p --output-format stream-json` requires to emit the stream this board reads.
 */
import {
  hasArgument, quotedLine, tokenizeCommand, withoutPrintArguments,
  type AgentAdapter, type AgentInvocation, type AgentInvokeSpec,
} from '../agent-adapter.js';
import { readClaudeUsage } from '../agent-usage.js';
import { CLAUDE_CLAIMED_TYPES, renderClaudeEvent } from '../agent-stream-render.js';
import { agentAction } from '../terminal-palette.js';

/**
 * The levels `--effort` takes, read off `claude --help` rather than remembered:
 *
 *     --effort <level>   Effort level for the current session (low, medium, high, xhigh, max)
 *
 * Exported because the `raw` backend spells effort Claude Code's way — see `agents/raw.ts` — and
 * two copies of a list read from one `--help` is how they come to disagree.
 */
export const CLAUDE_CODE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** What a headless run has to say to print an answer, exit, and speak while it works. */
function headlessArguments(args: string[]): void {
  if (!hasArgument(args, '-p', '--print')) args.push('--print');
  if (!hasArgument(args, '--output-format')) args.push('--output-format', 'stream-json');
  // Required by the CLI alongside `--output-format stream-json`, and only meaningful with it,
  // so it is added under the same condition rather than unconditionally.
  if (!hasArgument(args, '--verbose')) args.push('--verbose');
}

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',

  invoke(spec: AgentInvokeSpec): AgentInvocation {
    const [binary, ...rest] = tokenizeCommand(spec.command);
    const command = binary ?? spec.command;
    const headless = spec.mode === 'headless';
    // Interactive is the mode with no print flags in it at all, whoever wrote them — an
    // interface that was handed `--print` would print an answer and exit instead of drawing one.
    const args = headless ? [...rest] : withoutPrintArguments(rest);

    if (headless) headlessArguments(args);
    if (spec.model && !hasArgument(args, '--model')) args.push('--model', spec.model);
    if (spec.effort && !hasArgument(args, '--effort')) args.push('--effort', spec.effort);
    args.push(...(spec.extraArgs ?? []));

    return {
      command,
      args,
      // A headless run reads its prompt from stdin and needs the end of file that closes it,
      // which a pseudoterminal cannot give. An interface takes the prompt as its last argument
      // — `claude [options] [prompt]` — and keeps stdin for the reader.
      prompt: headless
        ? { via: 'stdin', stdin: 'prompt' }
        : { via: 'argv', stdin: 'reader' },
      line: quotedLine(command, args),
    };
  },

  /**
   * Whether this invocation asked for the machine-readable stream.
   *
   * Asked of the argv rather than assumed from the mode: an operator who wrote
   * `--output-format json` on the command line has a headless run that does *not* stream, and
   * reporting token counts for it would be reporting figures nothing is sending.
   */
  streams: (invocation) => invocation.args.some(
    (argument) => argument === 'stream-json' || argument === '--output-format=stream-json'
  ),

  efforts: CLAUDE_CODE_EFFORTS,
  readUsage: readClaudeUsage,
  renderEvent: renderClaudeEvent,
  claimedTypes: CLAUDE_CLAIMED_TYPES,
  actionOf: agentAction,
};
