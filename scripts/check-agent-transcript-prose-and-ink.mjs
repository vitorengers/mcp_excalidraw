#!/usr/bin/env node
/**
 * Checks that the agent's own prose has room around it, and that the mark which says the agent
 * is thinking is drawn in the agent's own ink rather than in the dim grey of a path.
 *
 * #258, in two halves that share one file:
 *
 * - **A sentence was appended like a log row.** `renderEvent` wrote a `text` block as
 *   `${text}\n` with nothing in front of it, so a sentence addressed to whoever is watching
 *   landed hard against the `⏺ Tool(argument)` line above it and the next tool call below it.
 *   The renderer already knew the other shape — the closing line opens with a blank one — so
 *   this was an omission in one branch rather than a shape the transcript cannot take.
 * - **`✻ thinking…` was `brightBlack`**, the same ink as an argument, a gutter and the
 *   `… N more lines` tail. The ask is Claude's orange, and orange is not one of the sixteen.
 *
 * ## Why a seventeenth ink is possible now and was not before
 *
 * #242's restriction — SGR 30-37 and 90-97 only — is about what can survive a theme toggle: the
 * transcript is composed on the *server*, which cannot know which of the two palettes the reader
 * is in, so a `38;2;r;g;b` would be one theme's hex printed into both cards. That is still true
 * of every byte that reaches an emulator. What #251 changed is that a *rendered* transcript is no
 * longer read by an emulator at all: it is a document, and `parseFoldedTranscript` resolves the
 * line into slot **names** which the frontend turns into hexes at paint time — the first point
 * that knows the theme. A name is exactly what a theme toggle can resolve twice, so a
 * seventeenth ink can exist there, with a hex per theme, without touching #242's rule for the
 * bytes.
 *
 * It therefore cannot travel as SGR, and it does not: it rides #251's private OSC as a mark kind
 * beside `f`/`c`/`d`, which an emulator draws as nothing and `stripFoldMarks` already takes out.
 *
 * ## What is asserted
 *
 * 1. A blank line either side of prose, and consecutive prose blocks that do not accumulate one.
 * 2. The thinking marker resolves to the seventeenth ink, in both themes, and to no SGR slot.
 * 3. Both hexes clear 3:1 on their own surface, **read out of `terminal-palette.ts`** rather
 *    than retyped here — a check that spells the colour itself passes when the palette changes
 *    underneath it.
 * 4. The mark leaves nothing behind: `stripFoldMarks` gives back prose, and what a reader sees
 *    is unchanged apart from the blank lines this issue asked for.
 * 5. The stream's other two readers are untouched — `extractGithubUrl` still finds the pull
 *    request URL in a transcript carrying all of this.
 *
 * The *pixels* are `scripts/check-agent-transcript-ink-browser.mjs`, because a colour and a
 * blank line both compile perfectly while doing nothing.
 *
 * Self-contained: no server, no browser, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-transcript-prose-and-ink.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** A built module, or nothing — so a missing export is a red case rather than a dead check. */
async function load(relative) {
  const full = join(repoRoot, 'dist', relative);
  if (existsSync(full)) return import(pathToFileURL(full).href);
  console.error(`  FAIL  the server is built — dist/${relative.replace(/\\/g, '/')} not found`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const render = await load(join('core', 'agent-stream-render.js'));
const palette = await load(join('core', 'terminal-palette.js'));
const { extractGithubUrl } = await load(join('core', 'issue-agent.js'));

const feed = (...events) =>
  new render.AgentStreamRenderer().feed(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`);

const prose = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const thinking = { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } };
const tool = (name, input, id) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const answer = (content, id) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const finished = { type: 'result', is_error: false, num_turns: 3 };

/** Every escape sequence, so what is left is what a reader sees. */
const ESCAPES = /(?:\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[\]P^_X][\s\S]*?(?:\u0007|\u001b\\)|\u001b[@-Z\\-_])/g;
const drawn = (text) => text.replace(ESCAPES, '');
const linesOf = (text) => {
  const lines = drawn(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
};

const THINKING = '✻ thinking…';

// ─── 1. Prose has room either side of it ──────────────────────

console.log('1. a sentence to the reader is not appended like a log row');

const around = feed(
  tool('Read', { file_path: 'src/server.ts' }, 'toolu_read_1'),
  answer('the file', 'toolu_read_1'),
  prose('The issue has a comment adding two things.'),
  tool('Bash', { command: 'npm test' }, 'toolu_bash_1'),
);
const aroundLines = linesOf(around);
const at = aroundLines.indexOf('The issue has a comment adding two things.');

check('the prose is on a line of its own', at >= 0, JSON.stringify(aroundLines));
check('with a blank line above it, rather than hard against the tool call',
  at > 0 && aroundLines[at - 1] === '',
  JSON.stringify(aroundLines.slice(Math.max(0, at - 2), at + 2)));
check('and a blank line below it, rather than hard against the next one',
  at >= 0 && aroundLines[at + 1] === '',
  JSON.stringify(aroundLines.slice(at, at + 3)));
check('the tool call after it is still drawn',
  aroundLines.some((line) => line.startsWith('⏺ Bash(')), JSON.stringify(aroundLines));

// The first thing a run says is prose, and there is nothing above it to be separated from.
const opening = linesOf(feed(prose('I will start by reading the issue.'), tool('Read', { file_path: 'a' }, 'x')));
check('a run that opens with prose does not start on a blank line',
  opening[0] === 'I will start by reading the issue.', JSON.stringify(opening.slice(0, 3)));

console.log('\n2. and runs of prose do not open a growing gap');

const consecutive = linesOf(feed(
  tool('Read', { file_path: 'a' }, 'toolu_a'),
  prose('First sentence.'),
  prose('Second sentence.'),
  prose('Third sentence.'),
  finished,
));
const blankRuns = [];
let run = 0;
for (const line of consecutive) {
  if (line === '') run += 1;
  else { if (run > 1) blankRuns.push(run); run = 0; }
}
check('two blocks of prose are separated by exactly one blank line',
  blankRuns.length === 0, `${JSON.stringify(consecutive)} — runs of ${blankRuns.join(', ')} blank lines`);
check('and every sentence is still there',
  ['First sentence.', 'Second sentence.', 'Third sentence.'].every((line) => consecutive.includes(line)),
  JSON.stringify(consecutive));
check('the closing line still has its own blank line above it and no more',
  (() => {
    const closing = consecutive.findIndex((line) => line.includes('the run finished'));
    return closing > 1 && consecutive[closing - 1] === '' && consecutive[closing - 2] !== '';
  })(), JSON.stringify(consecutive));

// What a tool's own output does is the tool's business: a result with a blank line in it keeps
// it. The collapsing above is between blocks the renderer wrote, not inside somebody's text.
const kept = feed(tool('Bash', { command: 'x' }, 'toolu_gap'), answer('one\n\ntwo', 'toolu_gap'));
check("a blank line inside a tool's own output is left alone",
  drawn(kept).includes('one\n') && drawn(kept).includes('two'), JSON.stringify(drawn(kept)));

// ─── 3. The seventeenth ink ───────────────────────────────────

console.log('\n3. the thinking marker is the agent\'s own ink, not the ink of a file path');

const inks = palette.DOCUMENT_INKS;
check('the palette declares an ink that is not one of the sixteen',
  Boolean(inks) && typeof inks === 'object' && Object.keys(inks).length > 0,
  'terminal-palette.ts exports no DOCUMENT_INKS');

const parsed = render.parseFoldedTranscript(feed(prose('Looking now.'), thinking, finished));
const thinkingRow = parsed.rows.find((row) => row.text.includes(THINKING));
check('the marker is still drawn, and still says only that the run is alive',
  Boolean(thinkingRow) && thinkingRow.text.trim() === THINKING,
  JSON.stringify(parsed.rows.map((row) => row.text)));

const marked = thinkingRow?.segments ?? [];
check('it comes back named rather than left on the default ink',
  marked.length > 0 && marked.every((segment) => Boolean(segment.slot)),
  JSON.stringify(marked));
check('and the name is the seventeenth ink rather than the dim grey it was',
  marked.every((segment) => segment.slot && inks && segment.slot in inks),
  JSON.stringify(marked.map((segment) => segment.slot)));

// The name has to be one the frontend can resolve, which means it is not one of the sixteen
// wearing a new label: an SGR slot would have been resolved by `slotAfter`.
const rendered = feed(thinking);
check('the marker carries no SGR sequence of its own, because orange is not one of the sixteen',
  !/\u001b\[[0-9;]*m/.test(rendered.split('\n')[0] ?? ''),
  JSON.stringify(rendered));
check('it travels as a private OSC mark, which an emulator draws as nothing',
  rendered.includes('\u001b]1338;'), JSON.stringify(rendered));

// Everything else keeps the ink it had. #242's vocabulary is not being re-opened.
const others = render.parseFoldedTranscript(feed(
  tool('Bash', { command: 'npm test' }, 'toolu_b'),
  answer('done', 'toolu_b'),
  finished,
));
const head = others.rows.find((row) => row.head);
check('a tool call is still drawn in its category slot',
  head?.segments?.some((segment) => segment.slot === 'green'),
  JSON.stringify(head?.segments));
check('the argument is still the dim ink',
  head?.segments?.some((segment) => segment.slot === 'brightBlack'),
  JSON.stringify(head?.segments));
check('and the closing line is still green rather than the new ink',
  others.rows.find((row) => row.text.includes('the run finished'))
    ?.segments?.some((segment) => segment.slot === 'green'),
  JSON.stringify(others.rows.map((row) => row.segments)));

// ─── 4. Both hexes, on their own surface ──────────────────────

console.log('\n4. one hex per theme, each one legible on the card it is drawn on');

/** WCAG relative luminance, so "legible" is a number rather than an opinion. */
function luminance(hex) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  const parts = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const unit = channel / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
}
const contrast = (a, b) => {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
};

const LEGIBLE = 3;
for (const [name, perTheme] of Object.entries(inks ?? {})) {
  for (const theme of ['light', 'dark']) {
    const hex = perTheme?.[theme];
    const surface = palette.TERMINAL_PALETTES?.[theme]?.paper;
    const ratio = hex && surface ? contrast(hex, surface) : 0;
    check(`${name} on ${theme} (${hex} on ${surface}) clears ${LEGIBLE}:1`,
      /^#[0-9a-f]{6}$/i.test(String(hex)) && ratio >= LEGIBLE, `${ratio.toFixed(2)}:1`);
  }
  check(`${name} is a colour per theme rather than one printed into both cards`,
    perTheme?.light !== perTheme?.dark, `${perTheme?.light} in both`);
}

// The frontend paints out of one table, so the seventeenth has to be in it beside the sixteen.
for (const theme of ['light', 'dark']) {
  const table = palette.terminalDocumentInk?.(theme);
  check(`the ${theme} paint table carries the sixteen and the seventeenth together`,
    Boolean(table) && table.cyan === palette.TERMINAL_PALETTES[theme].ansi.cyan
    && Object.keys(inks ?? {}).every((name) => table[name] === inks[name][theme]),
    JSON.stringify(table));
}

// ─── 5. What the mark must not leave behind ───────────────────

console.log('\n5. the mark is for the fold view and for nobody else');

const whole = feed(
  prose('Starting.'),
  thinking,
  tool('Write', { file_path: 'docs/terminal.md', content: 'x' }, 'toolu_w'),
  answer('Wrote 1 line', 'toolu_w'),
  prose('Done: https://github.com/vitorengers/mcp_excalidraw/pull/258'),
  finished,
);
const stripped = render.stripFoldMarks(whole);
check('stripFoldMarks leaves no mark of any kind behind',
  !stripped.includes('1338') && !stripped.includes('\u001b]'), JSON.stringify(stripped.slice(0, 300)));
check('and what it leaves is the prose, thinking marker and all',
  drawn(stripped).includes(THINKING) && drawn(stripped).includes('Starting.'),
  JSON.stringify(drawn(stripped)));
check('the transcript is still one the block knows how to fold',
  render.hasFoldMarks(whole));
check('and it is still `\\n`-terminated with no carriage return in it',
  !whole.includes('\r'));

console.log('\n6. and the two readers that parse the same bytes are untouched');

const PULL = 'https://github.com/vitorengers/mcp_excalidraw/pull/258';
check('extractGithubUrl still finds the pull request in the transcript',
  extractGithubUrl(whole, 'pull') === PULL, String(extractGithubUrl(whole, 'pull')));
check('and finds it once the marks are off as well',
  extractGithubUrl(stripped, 'pull') === PULL, String(extractGithubUrl(stripped, 'pull')));

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
