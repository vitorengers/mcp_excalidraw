/**
 * Token counts, read out of an agent's own output while it is still running.
 *
 * This is the half of "show the progress" that reaches something this repository does not
 * own. `EXCALIDRAW_IMPLEMENT_AGENT` is a full command line set by whoever starts the
 * board, tokenized and run as given — nothing requires it to be Claude Code, and nothing
 * requires it to say anything about what it is spending. A plain `claude -p` prints prose
 * at exit and no figures at all.
 *
 * So this is opt-in and stays out of the way otherwise: unless the configured command
 * already asks for a machine-readable stream, nothing here runs, nothing is recorded and
 * the spawn path is byte for byte what it was. The server never appends the flag itself —
 * silently rewriting somebody's command line is a decision, not a lookup.
 */

import type { AgentAdapter, UsageCounts, UsagePatch } from './agent-adapter.js';

/** What a run has spent, as the agent reports it. */
export interface AgentUsage {
  /**
   * Everything the model was given: fresh input, cache writes and cache reads together.
   *
   * Not `input_tokens` alone, which is the narrower and more literal reading. With prompt
   * caching on — which is the normal case for a long coding run — that field is a handful
   * of tokens per message while the cache accounts for tens of thousands, so a panel
   * showing it would read as "this agent has consumed nothing" for an hour. The number
   * worth watching is what the model actually processed.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * How much of `outputTokens` went on internal reasoning, when the agent breaks it down.
   *
   * A decomposition, not a fifth bucket: reasoning is billed as output and is already
   * inside the figure beside it, so this says which part of `out` was thinking rather than
   * adding anything to it. `28.4k out` alone cannot distinguish an agent that wrote a long
   * answer from one that thought for a long time and said little.
   *
   * Null rather than 0 when nothing was said, and the distinction is the point: an agent
   * that reports no breakdown has not claimed its reasoning was zero. Only one of the two
   * shapes below ever appears in a given run, so there is nothing to reconcile.
   */
  thinkingTokens: number | null;
}

/**
 * Whether the configured command asks its agent for a machine-readable stream.
 *
 * The flag is Claude Code's, and it is named here because the repository already names it:
 * it is what makes the timeout salvage work, and its absence is why a killed run has
 * nothing to salvage. Detecting it rather than requiring a second variable means an
 * operator who already streams gets the figures without changing anything.
 */
export function streamsUsage(agentCommand: string): boolean {
  return /--output-format[\s=]+["']?stream-json/i.test(agentCommand);
}

/** The same three figures the adapters report in. */
type Counts = UsageCounts;

const ZERO: Counts = { input: 0, output: 0, thinking: null };

/** Two figures that may each be silence: silence plus a number is that number. */
function addThinking(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left + right;
}

function add(left: Counts, right: Counts): Counts {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    thinking: addThinking(left.thinking, right.thinking),
  };
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The same read, but able to say "absent" — which `numberAt`'s 0 cannot. */
function optionalNumberAt(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The reasoning share of one `usage` object, as the Messages API documents it.
 *
 * `output_tokens_details.thinking_tokens` is "the number of output tokens the model
 * generated as internal reasoning", always ≤ `output_tokens`. Claude Code does not send it
 * — see the meter below — but the configured command need not be Claude Code, and anything
 * relaying the API's own accounting puts it here.
 */
function thinkingFrom(source: Record<string, unknown>): number | null {
  const details = source.output_tokens_details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  return optionalNumberAt(details as Record<string, unknown>, 'thinking_tokens');
}

/** One `usage` object, or null when the thing handed over is not one. */
function countsFrom(usage: unknown): Counts | null {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const source = usage as Record<string, unknown>;
  if (!('input_tokens' in source) && !('output_tokens' in source)) return null;
  return {
    input: numberAt(source, 'input_tokens')
      + numberAt(source, 'cache_creation_input_tokens')
      + numberAt(source, 'cache_read_input_tokens'),
    output: numberAt(source, 'output_tokens'),
    thinking: thinkingFrom(source),
  };
}

/**
 * What one event of Claude Code's stream says about the totals.
 *
 * The three shapes, and each is a real thing that stream does rather than a guess. It is also
 * the `raw` backend's reading, because an arbitrary command line that streams is one streaming
 * *this*, and it is what `UsageMeter` falls back to when nobody named a backend — see the class
 * below for why each shape is counted the way it is.
 */
export function readClaudeUsage(event: Record<string, unknown>): UsagePatch | null {
  if (event.type === 'system' && event.subtype === 'thinking_tokens') {
    // The delta, never `estimated_tokens`: that one is the current turn's total and goes back
    // down when the next turn starts. An event with no usable delta is left alone rather than
    // counted as nothing, so silence stays silence.
    const delta = optionalNumberAt(event, 'estimated_tokens_delta');
    return delta === null ? null : { kind: 'thinking', delta };
  }

  if (event.type === 'result') {
    const usage = event.usage as Record<string, unknown> | undefined;
    const iterations = usage?.iterations;
    if (Array.isArray(iterations) && iterations.length) {
      return {
        kind: 'settled',
        counts: iterations
          .map(countsFrom)
          .filter((counts): counts is Counts => counts !== null)
          .reduce(add, ZERO),
      };
    }
    const counts = countsFrom(usage);
    return counts ? { kind: 'settled', counts } : null;
  }

  const message = event.message as Record<string, unknown> | undefined;
  const counts = countsFrom(message?.usage);
  if (!counts) return null;
  const id = typeof message?.id === 'string' && message.id ? message.id : null;
  return { kind: 'message', id, counts };
}

/** How often the totals may be reported onward, however fast the lines arrive. */
const REPORT_INTERVAL_MS = 1000;

/** A line long enough that it is not a line: NDJSON gone wrong, or prose. */
const MAX_LINE = 1_000_000;

/**
 * Adds up what an agent says it is spending, from whatever it has printed so far.
 *
 * Two things stop the naive version being right, and both were confirmed against
 * `claude -p --output-format stream-json --verbose` rather than inferred:
 *
 *  - **The same message arrives more than once.** An assistant message is emitted as it
 *    streams and again when it finishes, carrying the same id and a usage block that has
 *    grown. Adding up every event double-counts it, so the totals are kept per message id
 *    and the last one seen wins.
 *  - **The streamed figures are not final.** Output in particular lags: a message can
 *    stream with four output tokens and be settled at thirty-nine. The `result` event at
 *    the end carries the run's own accounting, so when it arrives it replaces the sum
 *    rather than adding to it — a running figure while the run is live, the agent's figure
 *    once there is one.
 *
 * Reasoning is counted a third way, because Claude Code does not put it where the Messages
 * API does. Confirmed against `claude -p --output-format stream-json --verbose` (2.1.220):
 * no `output_tokens_details` appears anywhere in that stream — not on an assistant message
 * and not on `result` — and reasoning arrives instead as its own event,
 * `{"type":"system","subtype":"thinking_tokens","estimated_tokens":…,
 * "estimated_tokens_delta":…}`. Two things follow:
 *
 *  - **`estimated_tokens` restarts at every assistant turn** (observed 50 → 150 → 173, then
 *    50 → 129 for the next one), so it is the turn's total and never the run's. The deltas
 *    are what accumulate, and they are what is added up here.
 *  - **`result` says nothing about reasoning**, so unlike input and output the figure has no
 *    settled counterpart to be replaced by. It is kept beside the settled totals rather than
 *    inside them — otherwise the split would show for the length of the run and disappear at
 *    the moment the run became worth reading. It is the agent's own estimate, and the only
 *    number there is.
 *
 * Anything that is not JSON is skipped rather than treated as an error. An agent that
 * prints a warning line in the middle of its stream is not a failure of this.
 */
export class UsageMeter {
  private readonly byMessage = new Map<string, Counts>();
  private settled: Counts | null = null;
  /**
   * Reasoning added up from the agent's own events, kept apart from the totals above.
   *
   * Apart because it outlives them: the settled `result` replaces `settled` wholesale and
   * carries no reasoning, so a figure folded in there would be thrown away with the sum it
   * was folded into. Null until an event actually arrives.
   */
  private estimatedThinking: number | null = null;
  private buffer = '';
  /**
   * Starts at zero rather than at "nothing reported yet", so a run that has printed a
   * preamble and no figures reports nothing at all. Otherwise the first line of any stream
   * would announce a total of zero, and a panel would show `0 in · 0 out` for a run that
   * has simply not said yet — which reads as an answer rather than as silence.
   */
  private reported: Counts = ZERO;
  private lastReportAt = 0;
  private pending: NodeJS.Timeout | null = null;
  private anonymous = 0;

  /**
   * `adapter` is what knows which of the three shapes an event is.
   *
   * Optional, and the fallback is `readClaudeUsage` — which is also what the `raw` backend
   * answers — so a caller with a stream and no backend to name counts exactly what this class
   * counted before backends existed. A type-only import, so this module stays a leaf.
   */
  constructor(
    private readonly onChange: (usage: AgentUsage) => void,
    private readonly intervalMs: number = REPORT_INTERVAL_MS,
    private readonly adapter: AgentAdapter | null = null
  ) {}

  /** A chunk of stdout, which may hold any number of lines and part of another. */
  take(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline === -1) break;
      this.read(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
    }
    // A command that streams nothing line-shaped must not grow this without limit.
    if (this.buffer.length > MAX_LINE) this.buffer = '';
    this.report(false);
  }

  /** Everything left, once the agent has closed its output. */
  flush(): void {
    if (this.buffer.trim()) this.read(this.buffer);
    this.buffer = '';
    this.report(true);
  }

  private read(text: string): void {
    const line = text.trim();
    if (!line || line[0] !== '{') return;

    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    const record = event as Record<string, unknown>;

    // What the event *is* is the backend's question; what it does to the totals is this
    // class's. An adapter that cannot place an event says so with null, which is not an
    // error — a warning line in the middle of a stream is not a failure of this.
    let patch: UsagePatch | null;
    try {
      patch = this.adapter ? this.adapter.readUsage(record) : readClaudeUsage(record);
    } catch {
      return;
    }
    if (!patch) return;

    if (patch.kind === 'thinking') {
      this.estimatedThinking = (this.estimatedThinking ?? 0) + patch.delta;
      return;
    }
    if (patch.kind === 'settled') {
      this.settled = patch.counts;
      return;
    }
    // A report that names nothing is counted as its own rather than overwriting the last
    // anonymous one — two of them are two messages, not one message said twice.
    this.byMessage.set(patch.id ?? `anonymous-${this.anonymous++}`, patch.counts);
  }

  private total(): Counts {
    const counts = this.settled ?? [...this.byMessage.values()].reduce(add, ZERO);
    // What the agent broke down itself wins; the estimate is what fills the silence. Only
    // one of the two is ever present in a run, so this is a choice rather than a merge —
    // and making it a choice is what stops an agent that somehow spoke twice being
    // counted twice.
    return { ...counts, thinking: counts.thinking ?? this.estimatedThinking };
  }

  /**
   * Hand the totals on, at most once an interval.
   *
   * Throttled rather than reported per line because a busy agent streams many lines a
   * second and every one of them would otherwise be a write. The pending timer is
   * `unref`'d: a report that is still owed must not be the reason the process stays up.
   */
  private report(force: boolean): void {
    const total = this.total();
    // Reasoning is compared too, and not as a formality: it moves on events of its own, so
    // a run can think for a while without either of the other two figures changing. Watching
    // only those two would hold the new figure back until the next message settled.
    if (this.reported.input === total.input
      && this.reported.output === total.output
      && this.reported.thinking === total.thinking) return;

    const now = Date.now();
    if (!force && now - this.lastReportAt < this.intervalMs) {
      if (!this.pending) {
        this.pending = setTimeout(() => {
          this.pending = null;
          this.report(true);
        }, this.intervalMs - (now - this.lastReportAt));
        this.pending.unref?.();
      }
      return;
    }

    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    this.reported = total;
    this.lastReportAt = now;
    this.onChange({
      inputTokens: total.input,
      outputTokens: total.output,
      thinkingTokens: total.thinking,
    });
  }
}
