#!/usr/bin/env node
/**
 * Checks that a streaming agent reads like a CLI session, and that the raw stream still
 * reaches the one consumer that needs it byte for byte.
 *
 * A plain `claude -p` writes nothing until it exits, so a hosted run sat behind a blank block
 * for its whole life — observed on a live Farol run: seven minutes in, `sequence: 0`, scrollback
 * empty, the agent healthy and committing inside the distro the whole time. The only flag that
 * makes an agent speak while it works is `--output-format stream-json`, and that turns the
 * block into a wall of JSON, which is worse to read than nothing.
 *
 * The reason it could not simply be rendered is that `TerminalSession.emit` fed two consumers
 * from one string. One of them is `watch.onOutput`, where `runHostedAgent` accumulates the
 * output `extractGithubUrl` reads the pull request URL out of and `UsageMeter` reads the token
 * counts out of. Rendering in front of that would have traded a readable block for a run that
 * silently loses its URL — so the split is the feature, and the two cases at the end are what
 * this check exists for.
 *
 * The event shapes here are copied from a real `claude -p --output-format stream-json` capture,
 * not invented: `system`, `assistant` carrying `text` / `thinking` / `tool_use`, `user` carrying
 * `tool_result`, `rate_limit_event`, and the final `result`.
 *
 * ## And the same standard for the second backend
 *
 * That vocabulary is one CLI's. Codex speaks another — items with a type, rather than content
 * blocks inside an assistant message — and a renderer for it written from documentation would
 * render the documentation rather than the program. So the Codex half below runs against a real
 * `codex exec --json` capture too, held in `scripts/lib/codex-capture.mjs` with the version it
 * was taken from and the account-free way it was taken; that file's header is the provenance and
 * this one is what the bytes have to produce.
 *
 * What the two halves assert is deliberately *the same grammar*, not two: prose on a line of its
 * own, a `⏺ name(argument)` row per step, that step's answer folded under it, a closing line, and
 * no envelope anywhere. A backend is a reader of somebody else's stream and nothing more — if
 * either backend needed its own idea of what a transcript looks like, the seam would be in the
 * wrong place. The Claude Code fixtures are held to their exact bytes for the same reason, since
 * "the second backend works" must not be bought with a change to what the first one draws.
 *
 * Self-contained: a stub that prints known lines, a real `TerminalSession`, no agent, no
 * network, no board. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-stream-render.mjs
 *
 * Tier: fast
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CODEX_CAPTURE_STREAM, CODEX_CAPTURE_URL, CODEX_CLI_VERSION,
} from './lib/codex-capture.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workDir = join(tmpdir(), `agent-stream-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const { TerminalSession } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-session.js')).href
);
// Since #246 a rendered tool line carries an invisible mark in front of it, which is how the
// block knows which rows belong to which call and where the full detail behind them is. It is
// an OSC sequence with a private identifier, so an emulator handed one draws nothing — every
// assertion below is therefore about what is *drawn*, and this is what takes the marks off.
// `check-agent-transcript-fold.mjs` is where the marks themselves are asserted.
const { AgentStreamRenderer, hasFoldMarks, parseFoldedTranscript, stripFoldMarks } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'agent-stream-render.js')).href
);
const { extractGithubUrl } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href
);
const { adapterFor } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'agents', 'index.js')).href
);

/** The lines a real run emits, in the order it emits them. */
const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Bash'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'll run that command." }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } }] } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'hi' }] } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1, total_cost_usd: 0.07 },
];

/**
 * A stub agent: prints the lines and exits. `splitAt` cuts one line across two writes, which is
 * what a real socket does and what a renderer that forgets to buffer gets wrong.
 */
function writeStub(name, lines, splitAt = null) {
  const file = join(workDir, name);
  const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  const body = splitAt === null
    ? `process.stdout.write(${JSON.stringify(payload)});\n`
    : `process.stdout.write(${JSON.stringify(payload.slice(0, splitAt))});\n`
      + `setTimeout(() => process.stdout.write(${JSON.stringify(payload.slice(splitAt))}), 120);\n`;
  writeFileSync(file, body, 'utf8');
  return file;
}

const workspace = { id: 'check', path: workDir, innerPath: workDir, environment: { kind: 'native' } };

/**
 * Run one session to completion, collecting what the transcript showed and what the tap saw.
 *
 * `agent` is how a session is told which grammar it is reading. Absent, the command line is read
 * the way the `raw` backend reads one, which is what every case here did before backends existed
 * and is still what the Claude Code cases want.
 */
async function runSession(command, agent = null) {
  const shown = [];
  const raw = [];
  let exited = false;
  const session = new TerminalSession('s1', workspace, command, {
    onOutput: (data) => { shown.push(data); },
    onRaw: (data) => { raw.push(data); },
    onExit: () => { exited = true; },
  }, false, agent ? { agent } : {});
  await session.started;
  for (let attempt = 0; attempt < 200 && !exited; attempt++) await sleep(50);
  return { shown: shown.join(''), raw: raw.join(''), buffer: session.scrollback ?? '', exited };
}

const node = JSON.stringify(process.execPath);

// ─── A streaming agent reads like a CLI session ───────────────

console.log('\nA streaming agent, rendered');

const streaming = await runSession(
  `${node} ${JSON.stringify(writeStub('stream.mjs', EVENTS))} --output-format stream-json`
);

// Asserted line by line, never as a substring: every one of these strings is also inside the
// raw JSON, so `includes` on the whole transcript would pass today and prove nothing.
//
// The escapes come off first, and only here. Since #242 the renderer writes SGR sequences —
// `⏺ Bash` in the execution slot, the gutter in the dim one — so a line is `ESC[32m⏺ BashESC[0m…`
// rather than `⏺ Bash…`; and since #246 it writes fold marks in front of them, which is how the
// block groups a tool call's rows and finds the detail behind them. Every assertion below is
// about *shape*: which words are on which line, at what indent.
// `check-agent-stream-render-colour.mjs` is where the sequences themselves are the subject, and
// `check-agent-transcript-fold.mjs` is where the marks are. Taking both off in one helper keeps
// the three checks from having to agree about a spelling only one of them is asking about.
const stripEscapes = (text) => text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
const linesOf = (text) => stripEscapes(stripFoldMarks(text)).split('\n').map((line) => line.trim());

check('the session ran to the end', streaming.exited);
check("the assistant's prose is shown as prose, on a line of its own",
  linesOf(streaming.shown).includes("I'll run that command.")
  && linesOf(streaming.shown).includes('done'),
  JSON.stringify(streaming.shown.slice(0, 160)));
check('a tool use is one readable line naming the tool and its input',
  linesOf(streaming.shown).some((line) => /^.{0,4}Bash\b/.test(line) && line.includes('echo hi')),
  JSON.stringify(streaming.shown.slice(0, 200)));
check('the tool result is shown as its own text',
  linesOf(streaming.shown).some((line) => line === 'hi' || line.endsWith(' hi')),
  JSON.stringify(streaming.shown.slice(0, 200)));
check('no raw JSON envelope is left in the transcript',
  !streaming.shown.includes('"type":"assistant"') && !streaming.shown.includes('rate_limit_event'),
  'a JSON envelope reached the block');
check('private thinking is not printed verbatim',
  !streaming.shown.includes('a private thought'));
check('the tool line is marked for folding, and the mark is not part of what is drawn',
  hasFoldMarks(streaming.shown)
  && linesOf(streaming.shown).includes('⏺ Bash(echo hi)')
  && !stripFoldMarks(streaming.shown).includes('1338'),
  JSON.stringify(streaming.shown.slice(0, 200)));

// ─── What the tap must still receive ──────────────────────────

console.log('\nWhat the pull request URL is read from');

check('the raw tap got every byte the process wrote',
  EVENTS.every((event) => streaming.raw.includes(JSON.stringify(event))),
  'the tap saw rendered text instead of the stream');
check('and the tap is not what the block shows',
  streaming.raw !== streaming.shown);

// Said again about the thing itself, since #242. The URL is read out of the *raw* stream, so
// colour cannot reach it — but a URL is precisely the shape an SGR reset lands in the middle of,
// and a renderer that ever came to paint one word of it would break the run's only report of
// what it did. Asserted on the rendered transcript too, which is the harder of the two.
const PULL = 'https://github.com/vitorengers/vibemaxxing/pull/242';
const announced = await runSession(`${node} ${JSON.stringify(writeStub('url.mjs', [
  { type: 'assistant', message: { content: [{ type: 'text', text: `Opened ${PULL}` }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: `${PULL}\n` }] } },
  { type: 'result', subtype: 'success', is_error: false, num_turns: 2 },
]))} --output-format stream-json`);

check('a pull request URL survives the raw tap', extractGithubUrl(announced.raw, 'pull') === PULL,
  String(extractGithubUrl(announced.raw, 'pull')));
check('and it is still found in the transcript after the transcript is coloured',
  extractGithubUrl(announced.shown, 'pull') === PULL,
  JSON.stringify(announced.shown));

// ─── A line split across two writes ───────────────────────────

console.log('\nA line cut in half by the socket');

const split = await runSession(
  `${node} ${JSON.stringify(writeStub('split.mjs', EVENTS, 90))} --output-format stream-json`
);
check('the session ran to the end', split.exited);
check('a half-line is not shown as garbage',
  !split.shown.includes('{"type') && !split.shown.includes('"message"'),
  JSON.stringify(split.shown.slice(0, 160)));
check('and the whole line is shown once it completes',
  split.shown.includes("I'll run that command.") && split.shown.includes('done'),
  JSON.stringify(split.shown.slice(0, 160)));

// ─── What must not change ─────────────────────────────────────

console.log('\nWhat a command that does not stream still does');

const plainFile = join(workDir, 'plain.mjs');
writeFileSync(plainFile, `process.stdout.write('just some prose\\nand a second line\\n');\n`, 'utf8');
const plain = await runSession(`${node} ${JSON.stringify(plainFile)}`);

check('the session ran to the end', plain.exited);
check('its output is byte for byte what it wrote',
  plain.shown === 'just some prose\nand a second line\n',
  JSON.stringify(plain.shown));
check('and the tap saw exactly the same',
  plain.raw === plain.shown);

console.log('\nA non-JSON line from a streaming command');

const mixedFile = join(workDir, 'mixed.mjs');
writeFileSync(mixedFile,
  `process.stdout.write('warning: something on stderr-ish\\n');\n`
  + `process.stdout.write(${JSON.stringify(JSON.stringify(EVENTS[1]) + '\n')});\n`, 'utf8');
const mixed = await runSession(`${node} ${JSON.stringify(mixedFile)} --output-format stream-json`);

check('a line that is not JSON passes through verbatim',
  mixed.shown.includes('warning: something on stderr-ish'),
  JSON.stringify(mixed.shown.slice(0, 160)));

// ─── The Claude Code fixtures, to the byte ────────────────────

console.log('\nWhat the first backend draws, unchanged');

// A golden rather than a set of `includes`, and the strictness is the point: everything above
// asserts which words are on which line, which a change to the colours, the spacing or the fold
// marks would sail straight through. This is the whole string — escapes, marks, blank lines —
// so "the second backend renders" cannot be bought with a quiet change to what the first one
// draws. Rendered without a backend named, which is also the `raw` backend's answer and the
// fallback's, so the one assertion covers all three ways a Claude Code stream is reached.
const CLAUDE_GOLDEN = "I'll run that command.\n\n"
  + '\u001b]1338;d={"id":"t1","name":"Bash","input":"command: echo hi"}\u0007'
  + '\u001b]1338;f=t1\u0007\u001b[32m⏺ Bash\u001b[0m\u001b[90m(echo hi)\u001b[0m\n'
  + '\u001b]1338;d={"id":"t1","result":"hi"}\u0007'
  + '\u001b]1338;c=t1\u0007\u001b[90m  ⎿  \u001b[0mhi\u001b[0m\n'
  + '\u001b]1338;i=agent\u0007✻ thinking…\u001b]1338;i=\u0007\n'
  + '\ndone\n\n'
  + '\u001b[32m⏺ the run finished, 1 turn\u001b[0m\n';

const claudeRendered = new AgentStreamRenderer()
  .feed(`${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`);
check('the Claude Code fixtures render byte for byte as they do today',
  claudeRendered === CLAUDE_GOLDEN,
  `${JSON.stringify(claudeRendered)}\n              expected ${JSON.stringify(CLAUDE_GOLDEN)}`);

// ─── A real Codex capture, through the same renderer ──────────

console.log(`\nA captured codex exec --json stream (codex-cli ${CODEX_CLI_VERSION})`);

const codexAdapter = adapterFor('codex-cli');
const codexStubFile = join(workDir, 'codex.mjs');
writeFileSync(codexStubFile,
  `process.stdout.write(${JSON.stringify(CODEX_CAPTURE_STREAM)});\n`, 'utf8');
// Through the backend's own invocation rather than through a hand-written command line: what a
// session renders in is decided by the adapter it was given, and building the invocation here is
// what proves a board naming `codex-cli` gets this transcript rather than a wall of JSON.
// The stub's own path carries the `exec` subcommand, the way `check-agent-adapter.mjs` spells it:
// the backend puts `exec` first when a command line has not already got one, which for a stub
// binary would be a subcommand `node` reads as the script to run.
const codexCommand = `${node} ${JSON.stringify(codexStubFile)} exec`;
const codex = await runSession(codexCommand, {
  adapter: codexAdapter,
  invocation: codexAdapter.invoke({
    mode: 'headless', role: 'implement', command: codexCommand,
  }),
});
const codexLines = linesOf(codex.shown);

check('the session ran to the end', codex.exited);
check("the agent's prose is shown as prose, on a line of its own",
  codexLines.includes(`The suite passes and the note is updated: ${CODEX_CAPTURE_URL}`),
  JSON.stringify(codex.shown.slice(0, 200)));
check('a command it ran is one readable line naming the command',
  codexLines.some((line) => /^.{0,4}command_execution\b/.test(line)
    && line.includes('all cases passed') === false && line.includes('powershell')),
  JSON.stringify(codexLines.filter((line) => line.includes('command_execution'))));
check("that command's output is shown under it",
  codexLines.some((line) => line === 'all cases passed' || line.endsWith(' all cases passed')),
  JSON.stringify(codexLines));
check('the file it changed is a row of its own',
  codexLines.some((line) => /^.{0,4}file_change\b/.test(line) && line.includes('notes.txt')),
  JSON.stringify(codexLines.filter((line) => line.includes('file_change'))));
check('so are the MCP tool it called and the search it ran',
  codexLines.some((line) => /^.{0,4}mcp_tool_call\b/.test(line) && line.includes('notes.lookup'))
  && codexLines.some((line) => /^.{0,4}web_search\b/.test(line)
    && line.includes('codex exec json schema')),
  JSON.stringify(codexLines.filter((line) => /mcp_tool_call|web_search/.test(line))));
check('private reasoning is marked, not printed',
  codexLines.some((line) => line.includes('✻ thinking…'))
  && !codex.shown.includes('Looking at the repository'),
  JSON.stringify(codexLines));
check('and it closes by saying the run finished',
  codexLines.some((line) => line.includes('the run finished')),
  JSON.stringify(codexLines[codexLines.length - 2] ?? null));

// The headline of the item this came from: on the second backend the block rendered nothing at
// all, and a block showing JSON is the other half of the same failure.
check('no raw JSON envelope is left in the transcript',
  !codex.shown.includes('"type":"item.completed"')
  && !codex.shown.includes('turn.completed')
  && !codex.shown.includes('thread.started'),
  'a JSON envelope reached the block');

// A step announced twice is the trap the capture settles — `item.started` carries no output and
// `item.completed` carries all of it — so a renderer drawing both draws every command twice.
const commandRows = codexLines.filter((line) => /^.{0,4}command_execution\b/.test(line));
check('a step announced by item.started and item.completed is drawn once',
  commandRows.length === 2, JSON.stringify(commandRows));

// ─── A Codex tool row folds, like every other tool row ────────

console.log('\nWhat a Codex step hides behind its row');

check('the transcript is one the board composed, so it can fold at all',
  hasFoldMarks(codex.shown) && !stripFoldMarks(codex.shown).includes('1338'));

const folded = parseFoldedTranscript(codex.shown);
const heads = folded.rows.filter((row) => row.head);
check('every step is a head row with an id of its own',
  heads.length >= 5 && heads.every((row) => row.id),
  JSON.stringify(heads.map((row) => `${row.id}: ${row.text}`)));

const commandHead = heads.find((row) => row.text.includes('command_execution'));
check('a Codex tool row carries the item id the stream gave it',
  Boolean(commandHead) && commandHead.id === 'item_2', String(commandHead?.id));
check('and an openable detail record is behind it',
  Boolean(folded.details[commandHead?.id])
  && folded.details[commandHead.id].name === 'command_execution'
  && folded.details[commandHead.id].input.includes('exit_code: 0')
  && folded.details[commandHead.id].result.includes('all cases passed'),
  JSON.stringify(folded.details[commandHead?.id] ?? null));
check("that step's output rows are folded under it rather than left loose",
  folded.rows.some((row) => !row.head && row.id === commandHead?.id
    && row.text.includes('all cases passed')),
  JSON.stringify(folded.rows.filter((row) => row.id === commandHead?.id).map((row) => row.text)));

// The ids are the stream's own, and `FoldIds` pairs by them rather than by position — which is
// what the capture's out-of-order completions would break if it did not.
check('the plan that completed last is still paired with its own row',
  folded.rows.some((row) => row.head && row.id === 'item_5'),
  JSON.stringify(heads.map((row) => row.id)));

// ─── A failed Codex command is painted as a failure ───────────

console.log('\nA command that failed, drawn as one');

// The same `renderResult(…, true)` path a failed `tool_result` takes, asserted as the same
// *slot* rather than as the same words: the two backends spell failure differently on the wire —
// `exit_code` and `status` against `is_error` — and if that difference reached the picture, one
// of them would be a failure a reader cannot see.
// Which colour is in force where a piece of text begins, read the way an emulator reads it:
// the last foreground set before it wins, and a reset puts it back to the reader's own ink.
// `check-agent-stream-render-colour.mjs` is where the palette itself is the subject; here the
// question is only whether the two backends land on the same answer.
const slotOf = (text, marker) => {
  const line = stripFoldMarks(text).split('\n').find(
    (candidate) => candidate.includes(marker)
  ) ?? '';
  const sequences = line.slice(0, line.indexOf(marker)).match(/\u001b\[[0-9;]*m/g) ?? [];
  const last = sequences[sequences.length - 1] ?? null;
  return { line, slot: last === '\u001b[0m' ? null : last };
};

const failedSlot = slotOf(codex.shown, 'lint failed: 2 problems');
const goodSlot = slotOf(codex.shown, 'all cases passed');
check('the failed command\'s output is drawn in a slot of its own',
  Boolean(failedSlot.slot) && failedSlot.slot !== goodSlot.slot,
  `${failedSlot.slot} vs ${goodSlot.slot}`);
check('and it is the red a reader already reads as a failure',
  failedSlot.slot === '\u001b[31m' || failedSlot.slot === '\u001b[91m',
  String(failedSlot.slot));

// The other backend's failure, through the same renderer, so the two are held to one answer.
const claudeFailure = new AgentStreamRenderer().feed(`${JSON.stringify({
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'lint failed: 2 problems', is_error: true }] },
})}\n`);
check('a failed tool_result from the first backend is painted the same way',
  slotOf(claudeFailure, 'lint failed: 2 problems').slot === failedSlot.slot,
  `${slotOf(claudeFailure, 'lint failed: 2 problems').slot} vs ${failedSlot.slot}`);

// ─── And the tap is still the tap ─────────────────────────────

console.log('\nWhat a Codex run still gives the URL reader');

check('the raw tap got the stream byte for byte',
  codex.raw === CODEX_CAPTURE_STREAM,
  `${codex.raw.length} bytes against ${CODEX_CAPTURE_STREAM.length}`);
check('and the pull request URL survives both readings',
  extractGithubUrl(codex.raw, 'pull') === CODEX_CAPTURE_URL
  && extractGithubUrl(codex.shown, 'pull') === CODEX_CAPTURE_URL,
  `${extractGithubUrl(codex.raw, 'pull')} / ${extractGithubUrl(codex.shown, 'pull')}`);

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
