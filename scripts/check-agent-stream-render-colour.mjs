#!/usr/bin/env node
/**
 * Checks that the agent transcript is written in colour, and in the board's own colour.
 *
 * An **Implement / Fix** tab is not Claude Code's own interface. It is this repository
 * rendering `--output-format stream-json` — `RESULT_LINES = 6` and the `… N more lines` tail in
 * the screenshot on #242 are `agent-stream-render.ts`, not the CLI — so every glyph in that
 * block is authored here, and before #242 every one of them was authored *without an SGR
 * sequence*. A `Write(...)`, a `Bash(...)`, a thinking marker, a failed tool result and a
 * successful one all landed on the one xterm default foreground. The only colour anywhere in
 * the frame was a green `built in 12.93s` that a tool had put inside its own output, which
 * survived because a result is passed through verbatim. Colour reached the block by accident;
 * none was written.
 *
 * ## What is asserted, and why it is shaped like this
 *
 * Tool names arrive from the stream and are open ended — an MCP tool spells itself
 * `mcp__server__tool` — so a list of names is not a design and this check does not assert one.
 * It asserts the *structure* a semantic map has to have:
 *
 * - **Only the sixteen named slots.** SGR 30-37 and 90-97, never `38;5;N` and never
 *   `38;2;r;g;b`. That is the whole reason both themes fall out for free: a slot is resolved by
 *   whichever palette the reader is in, and a literal colour bypasses the palette and is wrong
 *   in one of the two. `terminal-palette.ts` moved all sixteen until each cleared 3:1 on its own
 *   surface; a `38;2` throws that away. #258 added a seventeenth ink and did **not** weaken
 *   this: it has no SGR number, so it travels as a mark on the fold view's private OSC and no
 *   byte an emulator can see has changed. The rule asserted here is the same rule.
 * - **Distinct categories, distinct slots.** Two tools that do the same *kind* of thing are
 *   drawn the same, two that do different kinds are drawn differently. Asserted through real
 *   tool names rather than by importing the map, because a check that imported it would agree
 *   with whatever the map happened to say.
 * - **`is_error` is read.** It is a field on a `tool_result` and the renderer declared no such
 *   field, so a tool that failed was drawn exactly like one that succeeded. Which line is a
 *   failure is the most load-bearing thing colour can say in a transcript somebody is watching.
 * - **The closing line differs by more than its wording**, which is all it differed by.
 * - **Prose stays plain ink**, and nothing leaks: a transcript that ended mid-sequence would
 *   paint whatever the next line wrote.
 *
 * ## And the raw stream is still the raw stream
 *
 * `runHostedAgent` reads the pull request URL out of the bytes the process wrote, through
 * `extractGithubUrl`, and `UsageMeter` reads the token counts out of the same bytes. Only the
 * *rendered* string is coloured, so neither can be hurt — but a URL is exactly the kind of thing
 * an SGR reset lands in the middle of, so the last case here renders one and looks for it
 * afterwards. Losing a run's pull request to make a block prettier is the one bad trade this
 * change could make.
 *
 * Self-contained: the renderer, in this process, with no server, no agent and no board. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-stream-render-colour.mjs
 *
 * Tier: fast
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const rendererModule = join(repoRoot, 'dist', 'core', 'agent-stream-render.js');
const issueModule = join(repoRoot, 'dist', 'core', 'issue-agent.js');
for (const built of [rendererModule, issueModule]) {
  if (!existsSync(built)) {
    console.error(`  FAIL  the built server exists — ${built} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
}

const { AgentStreamRenderer, stripFoldMarks } = await import(pathToFileURL(rendererModule).href);
const { extractGithubUrl } = await import(pathToFileURL(issueModule).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The sixteen, by the number a program spells them with ────
//
// Literals on purpose, exactly as `check-terminal-pairs-browser.mjs` keeps its hexes literal:
// `terminal-palette.ts` is where the colours are decided, and a check that imported the
// spelling would pass on whatever spelling that file happened to use.

const SLOT_OF_CODE = new Map([
  [30, 'black'], [31, 'red'], [32, 'green'], [33, 'yellow'],
  [34, 'blue'], [35, 'magenta'], [36, 'cyan'], [37, 'white'],
  [90, 'brightBlack'], [91, 'brightRed'], [92, 'brightGreen'], [93, 'brightYellow'],
  [94, 'brightBlue'], [95, 'brightMagenta'], [96, 'brightCyan'], [97, 'brightWhite'],
]);

/** Every CSI sequence in a string, as it was written. */
const SEQUENCES = (text) => text.match(/\u001b\[[0-?]*[ -\/]*[@-~]/g) ?? [];
/** The same text with the escapes taken out — what a reader sees. */
// The fold marks come off first. Since #246 a tool line carries an OSC sequence with a
// private identifier in front of it, and a detail record after it holding the tool's whole
// input as JSON — which an emulator draws as nothing, and which contains the tool's own
// name in text. Both matter here: a marker searched for with `indexOf` would otherwise be
// found inside that record, ahead of the sequence that paints the row, and the answer
// would be "plain" for every tool on the list.
const plain = (text) => stripFoldMarks(text).replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');

/**
 * The slot a run of text was painted in, or null if nothing painted it.
 *
 * Read the way an emulator reads it: walk the line, keep whatever foreground was last set, and
 * report the one in force where the marker begins. `0` and `39` put it back to the default,
 * which is the answer "this is plain ink" rather than "no sequence was found"; `undefined` is
 * the marker never having been drawn at all.
 */
function slotAt(markedLine, marker) {
  const line = stripFoldMarks(markedLine);
  const at = line.indexOf(marker);
  if (at < 0) return undefined;
  let slot = null;
  const pattern = /\u001b\[([0-?]*)m/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    if (match.index >= at) break;
    for (const part of match[1].split(';')) {
      const code = Number(part === '' ? 0 : part);
      if (code === 0 || code === 39) slot = null;
      else if (SLOT_OF_CODE.has(code)) slot = SLOT_OF_CODE.get(code);
    }
  }
  return slot;
}

/** Some events through a fresh renderer, so nothing carries over between cases. */
const render = (...events) =>
  new AgentStreamRenderer().feed(events.map((event) => JSON.stringify(event)).join('\n') + '\n');

const toolUse = (name, input) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const toolResult = (content, isError) =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', content, is_error: isError }] } });

/** The line of a transcript carrying a marker, escapes and all. */
const lineWith = (transcript, marker) =>
  transcript.split('\n').find((line) => plain(line).includes(marker)) ?? '';

// ─── 1. Only the sixteen ──────────────────────────────────────

console.log('\n1. only the sixteen named slots, so both themes fall out of the palette');

const EVERYTHING = render(
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the file now.' }] } },
  toolUse('Read', { file_path: 'src/server.ts' }),
  toolResult('alpha\nbravo', false),
  toolUse('Write', { file_path: 'src/new.ts' }),
  toolResult('<tool_use_error>File has not been read yet.</tool_use_error>', true),
  toolUse('Bash', { command: 'ls -la' }),
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  toolUse('WebFetch', { url: 'https://example.com' }),
  toolUse('Agent', { prompt: 'go and look' }),
  toolUse('mcp__excalidraw__create_element', { type: 'rectangle' }),
  toolUse('ExitPlanMode', { plan: 'the plan' }),
  { type: 'result', is_error: false, num_turns: 4 },
);

const written = SEQUENCES(EVERYTHING);
check('the renderer writes SGR sequences at all', written.length > 0,
      'not one escape in the whole transcript — every line is on the xterm default foreground');
check('no 256-colour escape is written', !/\u001b\[[^m]*38;5/.test(EVERYTHING),
      (EVERYTHING.match(/\u001b\[[^m]*38;5[^m]*m/g) ?? []).join(' '));
check('no true-colour escape is written', !/\u001b\[[^m]*38;2/.test(EVERYTHING),
      (EVERYTHING.match(/\u001b\[[^m]*38;2[^m]*m/g) ?? []).join(' '));

// Every parameter of every sequence is a slot, a reset or the default — nothing else is a
// colour this palette can answer for.
const strayCodes = [...new Set(written.flatMap((sequence) => {
  const body = /^\u001b\[([0-?]*)m$/.exec(sequence);
  if (!body) return [sequence];
  return body[1].split(';')
    .map((part) => Number(part === '' ? 0 : part))
    .filter((code) => !(code === 0 || code === 39 || SLOT_OF_CODE.has(code)));
}))];
check('and every sequence it writes is one of the sixteen, a reset or the default',
      strayCodes.length === 0, JSON.stringify(strayCodes));

check('the escapes never reach the reader as text', !plain(EVERYTHING).includes('\u001b'),
      JSON.stringify(plain(EVERYTHING).slice(0, 120)));
check('and the transcript does not end inside a sequence, which would paint what came after it',
      slotAt(`${EVERYTHING}END`, 'END') === null,
      JSON.stringify(EVERYTHING.slice(-24)));

// ─── 2. A category, not a list of names ───────────────────────

console.log('\n2. a semantic map: two tools of a kind are drawn alike, two kinds apart');

/** One group per category the pull request argues for, plus what falls to the default. */
const CATEGORIES = {
  inspection: ['Read', 'Grep', 'Glob'],
  mutation: ['Write', 'Edit', 'NotebookEdit'],
  execution: ['Bash', 'PowerShell'],
  network: ['WebFetch', 'WebSearch'],
  delegation: ['Agent', 'Skill'],
};

const slotOfTool = (name) => {
  const line = lineWith(render(toolUse(name, { file_path: 'x.ts' })), name);
  return { line, slot: slotAt(line, name) };
};

const drawn = {};
for (const [category, names] of Object.entries(CATEGORIES)) {
  const measured = names.map((name) => ({ name, ...slotOfTool(name) }));
  console.log(`     ${category.padEnd(11)} ${measured.map((tool) => `${tool.name}:${tool.slot ?? 'plain'}`).join(' ')}`);
  check(`every ${category} tool is drawn, and drawn in a slot`,
        measured.every((tool) => tool.slot),
        measured.filter((tool) => !tool.slot).map((tool) => `${tool.name} is on the default foreground`).join(', '));
  const slots = new Set(measured.map((tool) => tool.slot));
  check(`and all ${measured.length} of them in the same one, so it is a category rather than a list`,
        slots.size === 1, [...slots].join(', '));
  drawn[category] = measured[0].slot;
}

const categorySlots = Object.entries(drawn);
const clashes = categorySlots.filter(([category, slot]) =>
  categorySlots.some(([other, otherSlot]) => other !== category && otherSlot === slot));
check('the categories are told apart from each other', clashes.length === 0,
      clashes.map(([category, slot]) => `${category} is ${slot}`).join(', '));

// The open end: a tool nobody listed still has to be drawn deliberately rather than left over.
const unknown = slotOfTool('ExitPlanMode');
const mcp = slotOfTool('mcp__excalidraw__create_element');
console.log(`     default     ExitPlanMode:${unknown.slot ?? 'plain'} `
  + `mcp__excalidraw__create_element:${mcp.slot ?? 'plain'}`);
check('a tool in no category is still drawn, rather than left out of the map',
      unknown.slot !== undefined && mcp.slot !== undefined,
      'the renderer never drew the line');

// ─── 3. The argument is not the tool ──────────────────────────

console.log('\n3. the argument inside the parens is told apart from the name it follows');

const bashLine = lineWith(render(toolUse('Bash', { command: 'ls -la' })), 'ls -la');
const nameSlot = slotAt(bashLine, 'Bash');
const argumentSlot = slotAt(bashLine, 'ls -la');
console.log(`     ${JSON.stringify(bashLine)}`);
console.log(`     name ${nameSlot ?? 'plain'}, argument ${argumentSlot ?? 'plain'}`);
check('the two are drawn in different slots', nameSlot !== argumentSlot,
      `both are ${nameSlot ?? 'plain'}`);

// ─── 4. is_error, which was dropped ───────────────────────────

console.log('\n4. a tool that failed does not look like one that worked');

const good = render(toolResult('alpha\nbravo', false));
const bad = render(toolResult('<tool_use_error>File has not been read yet.</tool_use_error>', true));
const goodSlot = slotAt(good, '⎿');
const badSlot = slotAt(bad, '⎿');
console.log(`     success ${goodSlot ?? 'plain'}, failure ${badSlot ?? 'plain'}`);
check('the failed result is drawn in a slot of its own', Boolean(badSlot) && badSlot !== goodSlot,
      `both are ${goodSlot ?? 'plain'} — is_error is being dropped on the way through`);
check('and it is the one a reader already reads as a failure, red',
      badSlot === 'red' || badSlot === 'brightRed', String(badSlot));
check("the words are still the tool's own words",
      plain(bad).includes('File has not been read yet'), JSON.stringify(plain(bad)));

// A result carrying its own colour still carries it: that is where the one green span in the
// screenshot came from, and it is a tool saying something about its own output.
const carried = render(toolResult('built \u001b[32min 12.93s\u001b[0m', false));
check('a colour the tool put in its own output survives the gutter',
      carried.includes('\u001b[32min 12.93s'), JSON.stringify(carried));

// ─── 5. The closing line ──────────────────────────────────────

console.log('\n5. the closing line differs by more than its wording');

const finished = render({ type: 'result', is_error: false, num_turns: 3 });
const errored = render({ type: 'result', is_error: true, num_turns: 3 });
const finishedSlot = slotAt(finished, 'the run finished');
const erroredSlot = slotAt(errored, 'the run reported an error');
console.log(`     finished ${finishedSlot ?? 'plain'}, errored ${erroredSlot ?? 'plain'}`);
check('a run that finished closes in green',
      finishedSlot === 'green' || finishedSlot === 'brightGreen', String(finishedSlot));
check('a run that failed closes in red',
      erroredSlot === 'red' || erroredSlot === 'brightRed', String(erroredSlot));

// ─── 6. What stays plain ──────────────────────────────────────

console.log('\n6. prose is plain ink, and a line nobody authored is untouched');

const prose = render({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done, and here is the answer.' }] } });
check("the assistant's own prose carries no sequence at all",
      SEQUENCES(prose).length === 0, JSON.stringify(prose));
// The bytes gained a blank line under them in #258 — prose is given the room a paragraph has
// rather than the none a log row has — and gained nothing else. What is asserted here is still
// that no sequence and no mark reaches a sentence: the spacing is
// `scripts/check-agent-transcript-prose-and-ink.mjs`'s case, and it owns the shape.
check('and it is the same bytes it always was, with the room #258 asked for around it',
      prose === 'Done, and here is the answer.\n\n', JSON.stringify(prose));

const passthrough = new AgentStreamRenderer().feed('warning: something the command said\n');
check('a line that is not an envelope passes through verbatim, uncoloured',
      passthrough === 'warning: something the command said\n', JSON.stringify(passthrough));

// The thinking marker left this vocabulary in #258. It is the one line that is the agent
// itself rather than the agent's work, and what it is painted with is an ink that has no SGR
// number — so what this file has to say about it is that it writes *no sequence*, which is the
// rule this whole check is about. That the marker is nonetheless painted, and painted an orange
// that clears the floor in both themes, is
// `scripts/check-agent-transcript-prose-and-ink.mjs` and the browser check beside it.
const thinkingSlot = slotAt(lineWith(EVERYTHING, 'thinking'), 'thinking');
console.log(`     the thinking marker is ${thinkingSlot ?? 'plain'}`);
check('the thinking marker writes no SGR sequence, because its ink is not one of the sixteen',
      thinkingSlot === null, String(thinkingSlot));
check('and it is not left carrying a category colour',
      !Object.values(drawn).includes(thinkingSlot), String(thinkingSlot));

// ─── 7. What the pull request URL is read from ────────────────

console.log('\n7. a coloured transcript still gives up its pull request URL');

const URL = 'https://github.com/vitorengers/mcp_excalidraw/pull/242';
const announced = render(
  { type: 'assistant', message: { content: [{ type: 'text', text: `Opened ${URL}` }] } },
  toolResult(`${URL}\n`, false),
  { type: 'result', is_error: false, num_turns: 2 },
);
check('the URL is in the transcript unbroken', announced.includes(URL),
      JSON.stringify(announced));
check('and extractGithubUrl still finds it', extractGithubUrl(announced, 'pull') === URL,
      String(extractGithubUrl(announced, 'pull')));

// ─── Done ─────────────────────────────────────────────────────

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
