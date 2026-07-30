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
 *
 * ## Colour, and why it is spelled as slot numbers
 *
 * Until #242 this file wrote no SGR sequence at all, so a `Write`, a `Bash`, a thinking marker,
 * a failed tool result and a successful one were the one grey xterm falls back to. The only
 * colour that ever reached the block came in *through* a tool's own output, which `renderResult`
 * passes through verbatim — an accident, and the tell that none was being written.
 *
 * What it writes now is `terminal-palette.ts`'s semantic map, and nothing but the sixteen named
 * slots. The reason is the two themes: this board's terminal has a palette per theme and xterm
 * is re-themed on a toggle, so `[36m` is cyan-on-paper for one reader and cyan-on-night for
 * the other, both of them checked to clear 3:1 on their own surface. A `38;2;r;g;b` would be one
 * of those two hexes printed into both cards, and wrong in one. See the note at the bottom of
 * `terminal-palette.ts` for why bold and dim are not used either.
 */

import {
  AGENT_INK, agentToolSlot, ANSI_RESET, inSlot,
  type TerminalDocumentInk, type TerminalInk, type TerminalSlot,
} from './terminal-palette.js';

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
 *
 * `i` is the fourth, and it carries a colour rather than an identity. #258 asked for an ink
 * that is not one of the sixteen, and there is no SGR number for such a thing — see
 * `TerminalDocumentInk` in `terminal-palette.ts` for why that restriction holds for every byte
 * an emulator may see, and why a document is the one reader that can be handed a *name*
 * instead. So the name rides here: `i=<ink>` opens a run in it and `i=` closes the run, which
 * is the pair an SGR sequence writes, and an emulator draws both as nothing.
 */
const FOLD_OSC = '\u001b]1338;';
const FOLD_END = '\u0007';
const FOLD_MARK = /\u001b\]1338;([fcdi])=([^\u0007\u001b]*)\u0007/g;
/** The three that say which tool call a row belongs to. `i` is a colour, read further down. */
const ROW_MARK = /\u001b\]1338;([fcd])=([^\u0007\u001b]*)\u0007/g;
/** The one that says what ink a run is in, read where the SGR sequences are read. */
const INK_MARK = /^\u001b\]1338;i=([^\u0007\u001b]*)\u0007$/;

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

/** One run of a line in one slot, which is as much as a `<span>` needs to be told. */
export interface FoldSegment {
  text: string;
  /** One of the sixteen, the seventeenth, or null for the reader's default ink. */
  slot: TerminalInk | null;
}

/** One drawn line of a transcript, and the tool call it belongs to. */
export interface FoldRow {
  /** The tool call this row is part of, or null for prose, thinking and everything else. */
  id: string | null;
  /** Whether this row is the one that stands for the call when it is folded shut. */
  head: boolean;
  /** The line as it is drawn, marks and escape sequences gone. */
  text: string;
  /**
   * The same line, cut where its colour changes.
   *
   * #242 gave this transcript a colour vocabulary — a tool's name in its category's slot, the
   * argument and the gutter in the dim ink, a failed result in red — written as SGR sequences
   * so that the reader's own palette resolves them and both themes fall out of one map. A view
   * that is a document rather than an emulator has to resolve them itself, and dropping them
   * would be #246 quietly undoing #242. So the escapes are read here rather than deleted, and
   * the slot *name* is what comes out: the hex is the frontend's business, because only the
   * frontend knows which theme the board is in.
   */
  segments: FoldSegment[];
}

export interface FoldedTranscript {
  rows: FoldRow[];
  details: Record<string, FoldDetail>;
}

/** Which of the sixteen a foreground code names. The other direction of `SLOT_SGR`. */
const SGR_SLOT: Record<number, TerminalSlot> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'brightBlack', 91: 'brightRed', 92: 'brightGreen', 93: 'brightYellow',
  94: 'brightBlue', 95: 'brightMagenta', 96: 'brightCyan', 97: 'brightWhite',
};

/**
 * The slot in force after one SGR sequence.
 *
 * Only the foreground is read. Background, bold and dim are not written by this renderer —
 * `terminal-palette.ts` says why bold and dim are not — and a tool's own output that uses them
 * is being asked one question here: what colour is this text. An extended colour (`38;5;N`,
 * `38;2;r;g;b`) cannot be answered as one of the sixteen, so it falls back to the default ink
 * rather than being guessed at, which is the same trade the renderer makes by refusing to
 * write one.
 */
function slotAfter(current: TerminalInk | null, params: string): TerminalInk | null {
  let slot = current;
  for (const part of (params || '0').split(';')) {
    const code = Number(part || '0');
    if (code === 0 || code === 39) slot = null;
    else if (code === 38) return null;
    else if (SGR_SLOT[code]) slot = SGR_SLOT[code];
  }
  return slot;
}

/** Every escape sequence, so a `<div>` prints none of them and the SGR ones can be read. */
const ANSI = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[\]P^_X][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])/g;

/** One line, cut into runs of one colour, with every other escape sequence dropped. */
function segmentsOf(line: string): FoldSegment[] {
  const segments: FoldSegment[] = [];
  let slot: TerminalInk | null = null;
  let index = 0;
  ANSI.lastIndex = 0;
  for (let match = ANSI.exec(line); match; match = ANSI.exec(line)) {
    if (match.index > index) segments.push({ text: line.slice(index, match.index), slot });
    index = ANSI.lastIndex;
    const sgr = /^\u001b\[([0-9;]*)m$/.exec(match[0]);
    if (sgr) { slot = slotAfter(slot, sgr[1] ?? ''); continue; }
    // The other way a run says what colour it is, and it is read here rather than stripped
    // with the identity marks, because where it sits on the line is the whole of what it says.
    const ink = INK_MARK.exec(match[0]);
    if (ink) slot = ink[1] ? (ink[1] as TerminalInk) : null;
  }
  if (index < line.length) segments.push({ text: line.slice(index), slot });
  return segments;
}

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
    ROW_MARK.lastIndex = 0;
    for (let match = ROW_MARK.exec(line); match; match = ROW_MARK.exec(line)) {
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
    // The marks come off first and the colour is read second, which is the order they were
    // written in: a mark sits in front of whatever sequence the line starts in.
    const drawn = line.replace(ROW_MARK, '');
    const segments = segmentsOf(drawn);
    rows.push({ id, head, text: segments.map((segment) => segment.text).join(''), segments });
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
  /**
   * Whether the tool answered with a failure.
   *
   * Declared here since #242. It was always on the wire — the API puts it on a `tool_result`
   * and Claude Code streams the block through unchanged — and dropping it meant a tool that
   * failed was drawn exactly like one that worked, which is the single most useful thing colour
   * can say in a block somebody is watching to see whether a run is going wrong.
   */
  is_error?: boolean;
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

/**
 * A tool's answer, trimmed to what a watcher can take in, and marked as an answer.
 *
 * The gutter and the indent are always the renderer's own ink; the *text* is the tool's, and
 * whether it is repainted depends on `failed`. On the way through, a tool that colours its own
 * output keeps that colour — the green `built in 12.93s` in #242's screenshot is a real thing a
 * real tool said about itself, and swallowing it to impose a house style would be a loss. On a
 * failure the text is repainted anyway: `<tool_use_error>…` carries no colour of its own, and
 * red across the whole block is the point.
 *
 * The block is closed with a reset because the tool's own colour may not be: a sequence left
 * open would paint the prose after it, which is meant to be plain ink.
 */
function renderResult(content: unknown, failed: boolean): string {
  const gutter: TerminalSlot = failed ? AGENT_INK.failure : AGENT_INK.aside;
  const body = (line: string): string => (failed ? inSlot(AGENT_INK.failure, line) : line);

  const text = resultText(content).trim();
  if (!text) return `${inSlot(gutter, '  ⎿  (no output)')}\n`;

  const clipped = text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}…` : text;
  const lines = clipped.split('\n');
  const shown = lines.slice(0, RESULT_LINES);
  const rest = lines.length - shown.length;

  return shown.map((line, index) => inSlot(gutter, index === 0 ? '  ⎿  ' : '     ') + body(line)).join('\n')
    + (rest > 0 ? `\n${inSlot(AGENT_INK.aside, `     … ${rest} more line${rest === 1 ? '' : 's'}`)}` : '')
    + ANSI_RESET
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
/**
 * One run in an ink that is not one of the sixteen, opened and closed.
 *
 * The counterpart of `inSlot`, and the same shape: closed rather than left open, because a
 * transcript is appended to for the life of a run and an ink left on would paint every line
 * after it. What it writes is a name rather than a number — `terminal-palette.ts` says why the
 * numbers stop at sixteen and why a document can be told a name instead.
 */
const inInk = (ink: TerminalDocumentInk, text: string): string =>
  text ? `${FOLD_OSC}i=${ink}${FOLD_END}${text}${FOLD_OSC}i=${FOLD_END}` : text;

/**
 * What the transcript already ends with, so a blank line is written once rather than per block.
 *
 * #258 asked for room either side of the agent's prose, and "either side" is two decisions that
 * meet: the block after a sentence wants a blank line above it and the sentence wants one below.
 * Written twice they accumulate — three sentences in a row would open a growing gap — so the
 * one below is written and the one above is asked for, and it is only supplied when the
 * transcript does not already end in one.
 *
 * Two characters is the whole of the state a question like that needs, and it is deliberately
 * *not* the transcript: this class sees only what this renderer wrote, so a run of blank lines
 * inside a tool's own output is none of its business and is passed through untouched.
 */
class Spacing {
  /** The last two characters written. A transcript that has not started counts as blank. */
  private tail = '\n\n';

  /** Nothing, or the newline that opens a blank line above whatever comes next. */
  gap(): string {
    return this.tail.endsWith('\n\n') ? '' : '\n';
  }

  wrote(piece: string): void {
    if (piece) this.tail = (this.tail + piece).slice(-2);
  }
}

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

function renderEvent(event: StreamEvent, ids: FoldIds, spacing: Spacing): string {
  let out = '';
  // Everything this function appends goes through here, so the spacing above knows what the
  // transcript ends with even part-way through an event carrying several blocks.
  const write = (piece: string): void => { out += piece; spacing.wrote(piece); };
  switch (event.type) {
    case 'assistant': {
      const content = event.message?.content;
      if (typeof content === 'string') { write(`${content}\n`); return out; }
      if (!Array.isArray(content)) return '';
      for (const block of content) {
        if (block?.type === 'text' && block.text?.trim()) {
          // The one thing in the transcript addressed to whoever is watching, rather than a
          // record of what the agent did — so it is given the room a paragraph has and not the
          // no room a log row has. #258: it used to land hard against the tool call above it.
          write(`${spacing.gap()}${block.text.trim()}\n\n`);
        } else if (block?.type === 'thinking') {
          // Marked, never printed. It is the agent's private reasoning, it is long, and a
          // block somebody is watching to see what the run is *doing* is the wrong place
          // for it — but silence would read as a stall.
          //
          // It was dim until #258, on the argument that it says the run is alive rather than
          // what it is doing. What the ask answers is that this line is the *agent itself* —
          // the `✻` is the starburst its own interface draws — where every other line is the
          // agent's work, and that is worth a colour of its own rather than the ink of a file
          // path. The seventeenth ink, which exists only in the fold view: see
          // `TerminalDocumentInk`.
          write(`${inInk(AGENT_INK.presence, '✻ thinking…')}\n`);
        } else if (block?.type === 'tool_use') {
          const name = block.name ?? 'tool';
          const summary = summariseInput(block.input);
          const id = ids.open(block);
          // Two runs, not one: the name says what kind of thing is happening and carries the
          // category's colour, the argument says which file or command and steps back into the
          // dim ink so a column of tool calls reads as a column of verbs.
          //
          // The fold marks go in **front of the colour**, and the order is not arbitrary: the
          // mark is the row's identity and has to be the first thing on the line whichever
          // sequences follow it. The detail goes out with the *call* rather than being held
          // until the result, so a tool that is still running can already be opened, and it
          // carries the input as plain text — colour is for the row, and the record is what a
          // reader opens to read.
          write(foldData({ id, name, input: capped(fullInput(block.input)) })
            + foldLine(id, 'f')
            + `${inSlot(agentToolSlot(name), `⏺ ${name}`)}${inSlot(AGENT_INK.argument, `(${summary})`)}\n`);
        }
      }
      return out;
    }
    case 'user': {
      const content = event.message?.content;
      if (!Array.isArray(content)) return '';
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const rendered = renderResult(block.content, block.is_error === true);
        const id = ids.close(block);
        if (!id) { write(rendered); continue; }
        // Every line of the clipped preview is marked, because folding shut has to take the
        // whole answer with it and not only its first row. Marked in front of whatever colour
        // the line starts in — including the tool's own, which `renderResult` passes through.
        const marked = rendered.replace(/\n$/, '').split('\n')
          .map((line) => foldLine(id, 'c') + line)
          .join('\n');
        write(foldData({ id, result: capped(resultText(block.content).trim()) }) + marked + '\n');
      }
      return out;
    }
    case 'result': {
      const turns = typeof event.num_turns === 'number' ? `, ${event.num_turns} turn${event.num_turns === 1 ? '' : 's'}` : '';
      // Until #242 these two differed only in their wording, at the end of a transcript
      // somebody is scrolled away from.
      const slot = event.is_error ? AGENT_INK.failure : AGENT_INK.success;
      const said = event.is_error ? 'the run reported an error' : 'the run finished';
      // The blank line above it is asked for rather than written, for the same reason prose's
      // is: a run whose last word was a sentence already has one, and two would be a gap.
      write(`${spacing.gap()}${inSlot(slot, `⏺ ${said}${turns}`)}\n`);
      return out;
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
  private readonly spacing = new Spacing();

  /** What this chunk adds to the transcript. Empty means "nothing complete yet". */
  feed(chunk: string): string {
    this.pending += chunk;

    const lines = this.pending.split('\n');
    // Whatever follows the last newline is an unfinished line, and is kept for the next chunk.
    this.pending = lines.pop() ?? '';

    let out = '';
    const write = (piece: string): void => { out += piece; this.spacing.wrote(piece); };
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (!trimmed.startsWith('{')) {
        // Not an envelope, so it is somebody talking. Verbatim.
        write(`${line}\n`);
        continue;
      }
      try {
        out += renderEvent(JSON.parse(trimmed) as StreamEvent, this.ids, this.spacing);
      } catch {
        // A line that opens like JSON and is not JSON is still a line somebody wrote.
        write(`${line}\n`);
      }
    }
    return out;
  }
}
