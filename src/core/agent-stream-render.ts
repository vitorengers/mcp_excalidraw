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

import { AGENT_INK, agentToolSlot, ANSI_RESET, inSlot, type TerminalSlot } from './terminal-palette.js';

/** How much of a tool's output is worth putting in a block somebody is watching. */
const RESULT_LINES = 6;
const RESULT_CHARS = 400;

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
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

function renderEvent(event: StreamEvent): string {
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
          // for it — but silence would read as a stall. Dim for the same reason: it says the
          // run is alive, not what it is doing.
          out += `${inSlot(AGENT_INK.aside, '✻ thinking…')}\n`;
        } else if (block?.type === 'tool_use') {
          const name = block.name ?? 'tool';
          const summary = summariseInput(block.input);
          // Two runs, not one: the name says what kind of thing is happening and carries the
          // category's colour, the argument says which file or command and steps back into the
          // dim ink so a column of tool calls reads as a column of verbs.
          out += `${inSlot(agentToolSlot(name), `⏺ ${name}`)}${inSlot(AGENT_INK.argument, `(${summary})`)}\n`;
        }
      }
      return out;
    }
    case 'user': {
      const content = event.message?.content;
      if (!Array.isArray(content)) return '';
      let out = '';
      for (const block of content) {
        if (block?.type === 'tool_result') out += renderResult(block.content, block.is_error === true);
      }
      return out;
    }
    case 'result': {
      const turns = typeof event.num_turns === 'number' ? `, ${event.num_turns} turn${event.num_turns === 1 ? '' : 's'}` : '';
      // Until #242 these two differed only in their wording, at the end of a transcript
      // somebody is scrolled away from.
      const slot = event.is_error ? AGENT_INK.failure : AGENT_INK.success;
      const said = event.is_error ? 'the run reported an error' : 'the run finished';
      return `\n${inSlot(slot, `⏺ ${said}${turns}`)}\n`;
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
 * One instance per session: it holds the half line the last chunk ended in.
 */
export class AgentStreamRenderer {
  private pending = '';

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
        out += renderEvent(JSON.parse(trimmed) as StreamEvent);
      } catch {
        // A line that opens like JSON and is not JSON is still a line somebody wrote.
        out += `${line}\n`;
      }
    }
    return out;
  }
}
