/**
 * OpenAI's Codex CLI, named — the second backend, and the one that proves the seam is real.
 *
 * Nothing about it is a variation on Claude Code. It takes its prompt as an argument rather than
 * by closing stdin on an argument-less run, it spells "speak while you work" `--json` rather than
 * `--output-format stream-json --verbose`, its reasoning effort is a config override rather than
 * a flag, and its stream is a different grammar entirely: items with a type, rather than content
 * blocks inside an assistant message. Every one of those was a thing `issue-agent.ts` used to
 * answer with a regular expression over a Claude Code command line, and could only ever have
 * answered wrongly here.
 *
 * The facts below were confirmed against the CLI's own non-interactive documentation rather than
 * remembered:
 *
 *  - the prompt is an argument — *"Pass a task prompt as a single argument"* — and `-` is what
 *    says "read it from stdin instead"; *"If stdin is piped and you also provide a prompt
 *    argument, Codex treats the prompt as the instruction and the piped content as additional
 *    context"*, so a prompt sent down stdin with no `-` is an agent with no orders;
 *  - `--json` turns stdout into a JSON Lines stream of every event;
 *  - `-m` / `--model` selects the model, and `-c key=value` overrides one config key, which is
 *    where `model_reasoning_effort` lives;
 *  - the events are `thread.started`, `turn.started`, `turn.completed` (carrying
 *    `usage: { input_tokens, cached_input_tokens, output_tokens }`), `turn.failed`, a top-level
 *    `error`, and `item.started` / `item.updated` / `item.completed` whose `item.type` is one of
 *    `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
 *    `web_search`, `todo_list` or `error`.
 *
 * **The argument is the default, and the dash is never written for the operator.** Both forms
 * work, and the difference is what happens when the reading is wrong: a prompt handed to `codex
 * exec` on stdin with no `-` in front of it is read as context beside an instruction that does
 * not exist, and the run does something nobody asked for rather than failing. Writing `-` for
 * the operator would also spend stdin, and `codex exec -` in a tab the reader was meant to
 * answer waits on a pipe nobody is going to close. So the dash is honoured where they wrote it,
 * in the position they wrote it in, and added nowhere.
 *
 * **Everything is drawn on `item.completed`.** `item.started` exists for some kinds and would
 * make a long command appear the moment it began, which is worth something to a reader — but the
 * adapter is a value with no per-run state to remember which rows it has already opened, and a
 * build that omitted `item.started` for a kind would leave that kind's answer with no row above
 * it. Drawing once, on the event every kind emits, is right whatever the build does; a run still
 * fills in as it goes, item by item.
 */
import {
  hasArgument, quotedLine, tokenizeCommand,
  type AgentAdapter, type AgentInvocation, type AgentInvokeSpec, type UsagePatch,
} from '../agent-adapter.js';
import type { TranscriptState } from '../agent-stream-render.js';
import type { AgentAction } from '../terminal-palette.js';

/** The subcommand that makes Codex non-interactive. Interactive runs are the bare binary. */
const EXEC = 'exec';

/** The argument that says the prompt is arriving on stdin rather than beside it. */
const STDIN_MARKER = '-';

export const codexCliAdapter: AgentAdapter = {
  id: 'codex-cli',

  invoke(spec: AgentInvokeSpec): AgentInvocation {
    const [binary, ...rest] = tokenizeCommand(spec.command);
    const command = binary ?? spec.command;
    const headless = spec.mode === 'headless';
    const args = [...rest];
    // Read off the operator's own tokens, not off `args`, so that nothing this adapter appends
    // below could ever be mistaken for something they asked for.
    const pinned = rest.includes(STDIN_MARKER);

    // First, because it is a subcommand and not a flag. An operator who already wrote it — as
    // they would to reach `--full-auto` — keeps their own spelling and their own position.
    if (headless && !args.includes(EXEC)) args.unshift(EXEC);
    if (headless && !hasArgument(args, '--json')) args.push('--json');
    if (spec.model && !hasArgument(args, '-m', '--model')) args.push('--model', spec.model);
    // A config override rather than a flag of its own: `-c` is repeatable and takes the last
    // word, so a project's effort placed after the operator's own overrides wins.
    if (spec.effort) args.push('-c', `model_reasoning_effort=${spec.effort}`);
    args.push(...(spec.extraArgs ?? []));

    return {
      command,
      args,
      // The prompt is a positional argument, and stdin beside one is *context*. The dash is
      // honoured where the operator wrote it and never written for them — see `pinnedStdin`.
      prompt: headless && pinned
        ? { via: 'stdin', stdin: 'prompt', marker: STDIN_MARKER }
        // Closed rather than left alone, both ways round. `codex exec <prompt>` handed an
        // inherited pipe with no writer blocks in `read()` for ever (openai/codex#20919), and
        // an interactive run reaching this has already been given pipes instead of the
        // terminal it wanted, so there is no reader to keep stdin for either.
        : { via: 'argv', stdin: headless ? 'closed' : 'reader' },
      line: quotedLine(command, args),
    };
  },

  streams: (invocation) => invocation.args.includes('--json'),

  /**
   * The turn's own accounting, which is the only place Codex reports figures.
   *
   * `settled` rather than an accumulating report, and that is deliberate: `codex exec` is one
   * turn, so the two are the same total, and `settled` is the safe reading of the case they are
   * not — a `usage` that turned out to be cumulative across turns would be added to itself by
   * an accumulating meter and merely restated by this one.
   *
   * `cached_input_tokens` is counted into the input for the reason `AgentUsage.inputTokens`
   * gives: what is worth watching is what the model processed, and a run with caching on would
   * otherwise read as having consumed almost nothing.
   *
   * Reasoning is not on the wire yet — it is an open request against the CLI — so it is read
   * where it would arrive and reported as silence when it is not there, which is not the same
   * answer as zero.
   */
  readUsage(event: Record<string, unknown>): UsagePatch | null {
    if (event.type !== 'turn.completed') return null;
    const usage = event.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const source = usage as Record<string, unknown>;
    if (!('input_tokens' in source) && !('output_tokens' in source)) return null;
    return {
      kind: 'settled',
      counts: {
        input: countAt(source, 'input_tokens') + countAt(source, 'cached_input_tokens'),
        output: countAt(source, 'output_tokens'),
        thinking: optionalCountAt(source, 'reasoning_output_tokens'),
      },
    };
  },

  renderEvent(event: Record<string, unknown>, ids: TranscriptState): string {
    switch (event.type) {
      case 'item.completed':
        return renderItem(itemOf(event), ids);
      case 'turn.completed':
        return ids.ending({ failed: false });
      case 'turn.failed':
      case 'error':
        return ids.ending({ failed: true });
      // `thread.started`, `turn.started`, `item.started` and `item.updated` say nothing about
      // the work, and the last two are covered by the completion that follows them.
      default:
        return '';
    }
  },

  /**
   * Codex's own vocabulary, silent members included — see `AgentAdapter.claimedTypes`.
   *
   * The four silent ones are named rather than left out, because #325's rule is that an
   * envelope this backend has never heard of is printed rather than dropped, and a
   * `thread.started` printed verbatim would open every Codex transcript with a line of JSON.
   */
  claimedTypes: new Set([
    'thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error',
    'item.started', 'item.updated', 'item.completed',
  ]),

  actionOf: codexAction,
};

/** What kind of thing each of Codex's item types is. Anything unknown is `other`, honestly. */
function codexAction(stepName: string): AgentAction {
  switch (stepName.trim().toLowerCase()) {
    case 'command_execution': return 'execution';
    case 'file_change': return 'mutation';
    case 'todo_list': return 'mutation';
    case 'web_search': return 'network';
    case 'mcp_tool_call': return 'delegation';
    default: return 'other';
  }
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  query?: string;
  items?: unknown;
  message?: string;
}

function itemOf(event: Record<string, unknown>): CodexItem {
  const item = event.item;
  return item && typeof item === 'object' && !Array.isArray(item) ? (item as CodexItem) : {};
}

function countAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalCountAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A value as a line of a detail record, whatever shape it arrived in. */
function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Every field of an item that is worth putting behind the fold. */
function detailOf(item: CodexItem, hidden: readonly string[]): string {
  return Object.entries(item)
    .filter(([key, value]) => !hidden.includes(key) && value !== undefined)
    .map(([key, value]) => `${key}: ${asText(value)}`)
    .join('\n');
}

/** The paths a `file_change` touched, as the reader would name them. */
function changedPaths(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => (change && typeof change === 'object'
      ? asText((change as { path?: unknown }).path)
      : ''))
    .filter(Boolean);
}

/** One completed item, drawn as a step, an answer, prose or a thinking mark. */
function renderItem(item: CodexItem, state: TranscriptState): string {
  const kind = (item.type ?? '').trim().toLowerCase();
  const step = (summary: string, detail: string): string => state.step({
    name: kind || 'item',
    summary,
    id: item.id ?? null,
    detail,
    action: codexAction(kind),
  });

  switch (kind) {
    case 'agent_message':
      return state.prose(item.text ?? '');
    case 'reasoning':
      // Marked, never printed — the same decision `renderClaudeEvent` makes about `thinking`,
      // and for the same reason: it is long, and it is not what the run is *doing*.
      return state.thinking();
    case 'command_execution': {
      const failed = typeof item.exit_code === 'number'
        ? item.exit_code !== 0
        : item.status === 'failed';
      return step(item.command ?? '', detailOf(item, ['aggregated_output']))
        + state.answer({ id: item.id ?? null, content: item.aggregated_output ?? '', failed });
    }
    case 'mcp_tool_call': {
      const failed = Boolean(item.error) || item.status === 'failed';
      return step(`${item.server ?? ''}.${item.tool ?? ''}`, detailOf(item, ['result', 'error']))
        + state.answer({
          id: item.id ?? null,
          content: asText(item.error ?? item.result ?? ''),
          failed,
        });
    }
    case 'file_change': {
      const paths = changedPaths(item.changes);
      const summary = paths.length > 1
        ? `${paths[0]} and ${paths.length - 1} more`
        : (paths[0] ?? '');
      return step(summary, detailOf(item, []));
    }
    case 'web_search':
      return step(item.query ?? '', detailOf(item, []));
    case 'todo_list': {
      const count = Array.isArray(item.items) ? item.items.length : 0;
      return step(`${count} item${count === 1 ? '' : 's'}`, detailOf(item, []));
    }
    case 'error':
      // A step with a failed answer rather than a bare line, so that it folds and is painted
      // like every other failure in the transcript.
      return step(item.message ?? '', detailOf(item, ['message']))
        + state.answer({ id: item.id ?? null, content: item.message ?? '', failed: true });
    default:
      // A kind this board has never heard of is still a step the run took, and saying so beats
      // dropping it: the transcript is what a reader has when a run goes wrong.
      return step(asText(item.text ?? item.status ?? ''), detailOf(item, []));
  }
}
