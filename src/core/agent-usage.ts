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

interface Counts {
  input: number;
  output: number;
}

const ZERO: Counts = { input: 0, output: 0 };

function add(left: Counts, right: Counts): Counts {
  return { input: left.input + right.input, output: left.output + right.output };
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  };
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
 * Anything that is not JSON is skipped rather than treated as an error. An agent that
 * prints a warning line in the middle of its stream is not a failure of this.
 */
export class UsageMeter {
  private readonly byMessage = new Map<string, Counts>();
  private settled: Counts | null = null;
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

  constructor(
    private readonly onChange: (usage: AgentUsage) => void,
    private readonly intervalMs: number = REPORT_INTERVAL_MS
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
    if (!event || typeof event !== 'object') return;
    const record = event as Record<string, unknown>;

    if (record.type === 'result') {
      const usage = record.usage as Record<string, unknown> | undefined;
      const iterations = usage?.iterations;
      if (Array.isArray(iterations) && iterations.length) {
        this.settled = iterations
          .map(countsFrom)
          .filter((counts): counts is Counts => counts !== null)
          .reduce(add, ZERO);
      } else {
        const counts = countsFrom(usage);
        if (counts) this.settled = counts;
      }
      return;
    }

    const message = record.message as Record<string, unknown> | undefined;
    const counts = countsFrom(message?.usage);
    if (!counts) return;

    const id = typeof message?.id === 'string' && message.id
      ? message.id
      : `anonymous-${this.anonymous++}`;
    this.byMessage.set(id, counts);
  }

  private total(): Counts {
    if (this.settled) return this.settled;
    return [...this.byMessage.values()].reduce(add, ZERO);
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
    if (this.reported.input === total.input && this.reported.output === total.output) return;

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
    this.onChange({ inputTokens: total.input, outputTokens: total.output });
  }
}
