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
 * Self-contained: a stub that prints known lines, a real `TerminalSession`, no agent, no
 * network, no board. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-stream-render.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const { hasFoldMarks, stripFoldMarks } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'agent-stream-render.js')).href
);
const { extractGithubUrl } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href
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

/** Run one session to completion, collecting what the transcript showed and what the tap saw. */
async function runSession(command) {
  const shown = [];
  const raw = [];
  let exited = false;
  const session = new TerminalSession('s1', workspace, command, {
    onOutput: (data) => { shown.push(data); },
    onRaw: (data) => { raw.push(data); },
    onExit: () => { exited = true; },
  }, false, {});
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
const PULL = 'https://github.com/vitorengers/mcp_excalidraw/pull/242';
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

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
