/**
 * An agent's machine-readable stream, rendered the way its own CLI reads.
 *
 * `--output-format stream-json` is the only flag that makes a `-p` agent speak while it works:
 * without it the process writes nothing until it exits, and a hosted run sits behind a blank
 * block for its whole life. With it the block fills with JSON envelopes, which is worse to read
 * than nothing. Neither is what somebody watching a run wants, and the difference between them
 * is presentation, so it belongs here rather than in the operator's command line.
 *
 * ## What this is not allowed to touch
 *
 * The stream has a second reader. `runHostedAgent` accumulates the same bytes for
 * `extractGithubUrl` — which is how a finished run gets its pull request — and feeds
 * `UsageMeter` for the token counts. Both parse the envelopes this deletes. So rendering
 * happens on the way to the *transcript* only, and `TerminalSession` hands the raw chunk to the
 * tap before it renders anything. Losing a pull request URL to make a block prettier would be a
 * bad trade, and it is the one this file could most easily make by accident.
 *
 * ## Lines, not chunks
 *
 * A chunk is whatever the socket happened to deliver, so a JSON object is routinely cut in
 * half. Everything here is buffered until a newline, and a chunk that completes no line renders
 * to the empty string — which the caller treats as "nothing to show yet" rather than as output.
 *
 * ## A line that is not JSON is not an error
 *
 * Nothing requires the configured command to be Claude Code — `agent-usage.ts` makes the same
 * point about the counts. A command that streams and also prints a warning has that warning
 * passed through verbatim, because the alternative is swallowing the one line that explains
 * why a run went wrong.
 *
 * The event vocabulary below was read off a real capture rather than assumed: `system`,
 * `assistant` carrying `text`, `thinking` or `tool_use`, `user` carrying `tool_result`,
 * `rate_limit_event`, and a final `result`.
 */

/** How much of a tool's output is worth putting in a block somebody is watching. */
const RESULT_LINES = 6;
const RESULT_CHARS = 400;

/**
 * How much of a tool call is kept behind the fold.
 *
 * The clip above is what the *row* shows and it is deliberate — six lines is what a reader
 * scanning a run wants. This is the other number, the one the click reveals, and it is a
 * ceiling rather than a summary: twenty times `RESULT_CHARS`, sixty-six times the 120
 * characters `oneLine` leaves of a command, so a shell command and the output of nearly every
 * tool call arrive whole.
 *
 * It is not infinity, and the reason is where the detail travels. It rides in the transcript
 * (see the marks below), so it is spent out of `SCROLLBACK_LIMIT` — one `Read` of a large file
 * with no ceiling here would push every visible line of the run out of a 200,000-character
 * scrollback and leave the block holding one tool call. At this size a record is at most four
 * per cent of that budget, and when the ceiling does bite it says so on the line rather than
 * trimming in silence.
 */
const DETAIL_CHARS = 8_000;

/**
 * The marks that make a rendered transcript foldable, and why they are escape sequences.
 *
 * A transcript is one string: it is what the scrollback holds, what a reconnecting board is
 * replayed and what a reload is served. Anything that has to survive all three has to be *in*
 * it — a second channel would be a second thing to broadcast, to replay and to bound, and the
 * three would drift. So a tool call's identity and its full detail are written into the same
 * string as the line they belong to.
 *
 * They are written as OSC sequences with a private identifier, which is what makes that safe:
 * an emulator handed one looks for a handler, finds none and draws nothing, so a transcript
 * carrying these is byte for byte the same *picture* it was before. `trimScrollback` already
 * knows where an OSC ends, so the scrollback ceiling cannot cut one in half. And they carry no
 * C0 control character of their own — `JSON.stringify` escapes every byte below 0x20, the
 * terminator among them — so a payload can hold a whole file and still be one line.
 *
 * `f` opens a row that belongs to a tool call, `c` a row that continues one, and `d` carries
 * the detail record itself. Only the frontend reads them; `stripFoldMarks` is what everything
 * else uses.
 */
const FOLD_OSC = '\u001b]1338;';
const FOLD_END = '\u0007';
const FOLD_MARK = /\u001b\]1338;([fcd])=([^\u0007\u001b]*)\u0007/g;

/** Whether a transcript is one the board composed, and therefore one that can fold. */
export function hasFoldMarks(text: string): boolean {
  return text.includes(FOLD_OSC);
}

/** A transcript with its marks taken out, which is what everything but the fold view wants. */
export function stripFoldMarks(text: string): string {
  return text.replace(FOLD_MARK, '');
}

/** What one tool call did, in full, behind the row that stands for it. */
export interface FoldDetail {
  id: string;
  /** The tool's name, so an expanded row still says what it was. */
  name: string;
  /** Every field of the tool's input, whole. */
  input: string;
  /** What the tool answered, whole. Null until the answer arrives. */
  result: string | null;
}

/** One drawn line of a transcript, and the tool call it belongs to. */
export interface FoldRow {
  /** The tool call this row is part of, or null for prose, thinking and everything else. */
  id: string | null;
  /** Whether this row is the one that stands for the call when it is folded shut. */
  head: boolean;
  /** The line as it is drawn, marks and escape sequences gone. */
  text: string;
}

export interface FoldedTranscript {
  rows: FoldRow[];
  details: Record<string, FoldDetail>;
}

/** Anything else an emulator would have eaten, so a `<div>` does not print it. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[\]P^_X][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/**
 * A rendered transcript, read back as rows and the detail behind them.
 *
 * Written here rather than in the frontend because the frontend is not its only reader: the
 * check asserts against the same parse, and a second implementation of a format is a second
 * opinion about it. It is deliberately total — a row whose detail was trimmed out of the
 * scrollback still comes back as a row, so a fold with nothing behind it degrades to the
 * clipped preview the transcript already carried rather than to a blank.
 */
export function parseFoldedTranscript(text: string): FoldedTranscript {
  const details: Record<string, FoldDetail> = {};
  const rows: FoldRow[] = [];
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    let id: string | null = null;
    let head = false;
    FOLD_MARK.lastIndex = 0;
    for (let match = FOLD_MARK.exec(line); match; match = FOLD_MARK.exec(line)) {
      const kind = match[1];
      const payload = match[2] ?? '';
      if (kind === 'd') {
        try {
          const record = JSON.parse(payload) as Partial<FoldDetail> & { id?: string };
          if (!record.id) continue;
          const existing = details[record.id] ?? { id: record.id, name: '', input: '', result: null };
          details[record.id] = {
            id: record.id,
            name: record.name ?? existing.name,
            input: record.input ?? existing.input,
            result: record.result !== undefined ? record.result : existing.result,
          };
        } catch { /* a record cut in half by the scrollback ceiling is one row without detail */ }
        continue;
      }
      id = payload;
      if (kind === 'f') head = true;
    }
    rows.push({ id, head, text: line.replace(FOLD_MARK, '').replace(ANSI, '') });
  }

  return { rows, details };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  /** The call's own id, which is what a result names when it answers. */
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: unknown;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  message?: { content?: ContentBlock[] | string };
  num_turns?: number;
  is_error?: boolean;
}

/** The first field of a tool's input that is worth showing beside its name. */
function summariseInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  // In the order a reader cares about them: what was run, then what was touched.
  for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value.trim());
  }
  const first = Object.values(input).find((value) => typeof value === 'string' && value.trim());
  return typeof first === 'string' ? oneLine(first.trim()) : '';
}

/** A value on one line, so a multi-line command cannot break the shape of the transcript. */
function oneLine(text: string): string {
  const flat = text.replace(/\s*\n\s*/g, ' ').trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

/** Whatever a tool answered, as text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === 'object' && 'text' in block
        ? String((block as { text?: unknown }).text ?? '')
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** A tool's answer, trimmed to what a watcher can take in, and marked as an answer. */
function renderResult(content: unknown): string {
  const text = resultText(content).trim();
  if (!text) return '  ⎿  (no output)\n';

  const clipped = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
  const lines = clipped.split('\n');
  const shown = lines.slice(0, RESULT_LINES);
  const rest = lines.length - shown.length;

  return shown.map((line, index) => (index === 0 ? `  ⎿  ${line}` : `     ${line}`)).join('\n')
    + (rest > 0 ? `\n     … ${rest} more line${rest === 1 ? '' : 's'}` : '')
    + '\n';
}

/** Every field of a tool's input, whole, which is what the row was hiding. */
function fullInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

/** A field of a detail record, at the ceiling, saying so when it is at it. */
function capped(text: string): string {
  if (text.length <= DETAIL_CHARS) return text;
  return `${text.slice(0, DETAIL_CHARS)}\n… ${text.length - DETAIL_CHARS} more characters`;
}

/** An id an OSC payload can carry, whatever the agent called its tool call. */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

const foldLine = (id: string, kind: 'f' | 'c'): string => `${FOLD_OSC}${kind}=${id}${FOLD_END}`;
const foldData = (record: Partial<FoldDetail> & { id: string }): string =>
  `${FOLD_OSC}d=${JSON.stringify(record)}${FOLD_END}`;

/**
 * Which tool call each row belongs to, across one stream.
 *
 * A `tool_use` block carries its own `id` and the `tool_result` that answers it names that id
 * in `tool_use_id`, so pairing is the agent's own and not a guess. Neither field is *required*
 * to be there — nothing here assumes the command is Claude Code, and the captures this file was
 * written against predate them — so an unnamed call gets a number and an unnamed result is
 * paired with the oldest call still waiting for one. Tool calls are answered in order in every
 * capture seen, and a wrong pairing costs the reader a fold rather than a line of transcript.
 */
class FoldIds {
  private next = 0;
  private waiting: string[] = [];

  open(block: ContentBlock): string {
    const id = block.id ? safeId(block.id) : `t${(this.next += 1)}`;
    this.waiting.push(id);
    return id;
  }

  close(block: ContentBlock): string | null {
    if (block.tool_use_id) {
      const id = safeId(block.tool_use_id);
      this.waiting = this.waiting.filter((candidate) => candidate !== id);
      return id;
    }
    return this.waiting.shift() ?? null;
  }
}

function renderEvent(event: StreamEvent, ids: FoldIds): string {
  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content;
      if (typeof content === 'string') return `${content}\n`;
      if (!Array.isArray(content)) return '';
      let out = '';
      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) {
          out += `${block.text.trim()}\n`;
        } else if (block?.type === 'thinking') {
          // Marked, never printed. It is the agent's private reasoning, it is long, and a
          // block somebody is watching to see what the run is *doing* is the wrong place
          // for it — but silence would read as a stall.
          out += '✻ thinking…\n';
        } else if (block?.type === 'tool_use') {
          const summary = summariseInput(block.input);
          const id = ids.open(block);
          const name = block.name ?? 'tool';
          // The row is what it always was; what is new is in front of it, and draws as
          // nothing. The detail goes out with the *call* rather than being held until the
          // result, so a tool that is still running can already be opened.
          out += foldData({ id, name, input: capped(fullInput(block.input)) })
            + foldLine(id, 'f')
            + `⏺ ${name}(${summary})\n`;
        }
      }
      return out;
    }
    case 'user': {
      const content = event.message?.content;
      if (!Array.isArray(content)) return '';
      let out = '';
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const rendered = renderResult(block.content);
        const id = ids.close(block);
        if (!id) { out += rendered; continue; }
        // Every line of the clipped preview is marked, because folding shut has to take the
        // whole answer with it and not only its first row.
        const marked = rendered.replace(/\n$/, '').split('\n')
          .map((line) => foldLine(id, 'c') + line)
          .join('\n');
        out += foldData({ id, result: capped(resultText(block.content).trim()) }) + marked + '\n';
      }
      return out;
    }
    case 'result': {
      const turns = typeof event.num_turns === 'number' ? `, ${event.num_turns} turn${event.num_turns === 1 ? '' : 's'}` : '';
      return `\n⏺ ${event.is_error ? 'the run reported an error' : 'the run finished'}${turns}\n`;
    }
    // `system` is the startup banner and `rate_limit_event` is bookkeeping. Neither says
    // anything about the work, and both would arrive before the first line of it.
    default:
      return '';
  }
}

/**
 * One agent stream, turned into a transcript.
 *
 * One instance per session: it holds the half line the last chunk ended in, and the ids that
 * pair a tool call with the answer that arrives several chunks later.
 */
export class AgentStreamRenderer {
  private pending = '';
  private readonly ids = new FoldIds();

  /** What this chunk adds to the transcript. Empty means "nothing complete yet". */
  feed(chunk: string): string {
    this.pending += chunk;

    const lines = this.pending.split('\n');
    // Whatever follows the last newline is an unfinished line, and is kept for the next chunk.
    this.pending = lines.pop() ?? '';

    let out = '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        // Not an envelope, so it is somebody talking. Verbatim.
        out += `${line}\n`;
        continue;
      }
      try {
        out += renderEvent(JSON.parse(trimmed) as StreamEvent, this.ids);
      } catch {
        // A line that opens like JSON and is not JSON is still a line somebody wrote.
        out += `${line}\n`;
      }
    }
    return out;
  }
}
