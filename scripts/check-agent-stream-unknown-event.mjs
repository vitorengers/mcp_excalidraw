#!/usr/bin/env node
/**
 * Checks that a stream event nobody taught the renderer about degrades to a readable block
 * rather than to a blank one.
 *
 * `renderEvent` switches on the event vocabulary read off a real Claude Code capture, and its
 * `default` arm returned the empty string. The verbatim fallback in `feed` only fired when
 * `JSON.parse` *threw*, so a line that is perfectly good JSON of a type the switch has never
 * heard of was dropped on the floor. Downstream that is worse than it sounds:
 * `TerminalSession.emit` returns early on an empty render, so the sequence number does not
 * advance, nothing enters the scrollback and nothing is broadcast — a stream whose events are
 * all unrecognised produces a block that is blank for the whole run, which from outside is
 * indistinguishable from a hung agent.
 *
 * That is reachable today by any new Claude Code event type, and it is what a second backend
 * would hit on its first line. The file's own header already makes this judgement one case
 * narrower — a line that is not an envelope is passed through verbatim, because swallowing the
 * one line that explains why a run went wrong is the worse trade — and this is that rule
 * applied to a line that *is* an envelope of an unclaimed type.
 *
 * The distinction the fix has to keep is between "I know this type and I have nothing to show"
 * and "I have never heard of this type". `system` is the startup banner and `rate_limit_event`
 * is bookkeeping; both are deliberately silent and both must stay silent, or a transcript that
 * reads cleanly today starts printing envelopes beside the prose. So the claimed types are
 * named, and section 2 is what holds them.
 *
 * Self-contained: a stub that prints known lines, a real `TerminalSession`, no agent, no
 * network, no board, no browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-stream-unknown-event.mjs
 *
 * Tier: fast
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

const workDir = join(tmpdir(), `agent-stream-unknown-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const { TerminalSession } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-session.js')).href
);
// A rendered line carries invisible fold marks in front of it, so every assertion here is
// about what is *drawn*. `check-agent-transcript-fold.mjs` is where the marks themselves are.
const { stripFoldMarks } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'agent-stream-render.js')).href
);

/** A stub agent: prints the lines it was given, then exits. */
function writeStub(name, lines) {
  const file = join(workDir, name);
  const payload = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  writeFileSync(file, `process.stdout.write(${JSON.stringify(payload)});\n`, 'utf8');
  return file;
}

const workspace = { id: 'check', path: workDir, innerPath: workDir, environment: { kind: 'native' } };

/** Run one session to completion, collecting the transcript and the sequence it reached. */
async function runSession(command) {
  const shown = [];
  let lastSequence = 0;
  let exited = false;
  const session = new TerminalSession('s1', workspace, command, {
    onOutput: (data, sequence) => { shown.push(data); lastSequence = sequence; },
    onRaw: () => {},
    onExit: () => { exited = true; },
  }, false, {});
  await session.started;
  for (let attempt = 0; attempt < 200 && !exited; attempt++) await sleep(50);
  return {
    shown: shown.join(''),
    buffer: session.scrollback ?? '',
    sequence: session.sequence ?? 0,
    lastSequence,
    exited,
  };
}

const node = JSON.stringify(process.execPath);
const streaming = (stub) => `${node} ${JSON.stringify(stub)} --output-format stream-json`;

// Every line asserted below is one the renderer writes plain — an unrendered envelope,
// prose, or nothing at all — so there is no SGR sequence to take off. The fold marks
// still come off, because a rendered line carries one in front of whatever it starts with.
const linesOf = (text) => stripFoldMarks(text).split('\n').map((line) => line.trim());

// ─── An event of a type nobody claimed ────────────────────────

console.log('\nA JSON line of an unknown type');

/** What a second backend's first line looks like: valid JSON, and none of this vocabulary. */
const UNKNOWN = {
  type: 'codex.item.completed',
  item: { kind: 'agent_message', text: 'the other backend said this' },
};
/** An envelope with no `type` at all, which the switch answers exactly as it answers a wrong one. */
const UNTYPED = { role: 'assistant', text: 'no type field anywhere' };

const mixed = await runSession(streaming(writeStub('mixed.mjs', [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Bash'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'll run that command." }] } },
  UNKNOWN,
  UNTYPED,
  { type: 'result', subtype: 'success', is_error: false, num_turns: 1 },
])));

check('the session ran to the end', mixed.exited);
check('an unknown event appears in the transcript verbatim, on a line of its own',
  linesOf(mixed.shown).includes(JSON.stringify(UNKNOWN)),
  JSON.stringify(mixed.shown.slice(0, 400)));
check('an envelope with no type at all is passed through too',
  linesOf(mixed.shown).includes(JSON.stringify(UNTYPED)),
  JSON.stringify(mixed.shown.slice(0, 400)));
check('and the events the renderer does know are still rendered, not printed',
  linesOf(mixed.shown).includes("I'll run that command.")
  && !mixed.shown.includes('"type":"assistant"'),
  JSON.stringify(mixed.shown.slice(0, 400)));

// ─── What stays silent ────────────────────────────────────────

console.log('\nThe two that are deliberately swallowed');

const boring = await runSession(streaming(writeStub('boring.mjs', [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Bash'] },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
])));

check('the session ran to the end', boring.exited);
check('a system banner and a rate limit event still draw nothing at all',
  boring.shown === '' && boring.buffer === '',
  JSON.stringify(boring.shown));
check('and they spend no sequence number', boring.sequence === 0, String(boring.sequence));

// ─── A stream that is nothing but unknown events ──────────────

console.log('\nA whole run the renderer has never heard of');

const ALIEN = [
  { type: 'codex.thread.started', thread_id: 'abc' },
  { type: 'codex.item.started', item: { kind: 'command_execution', command: 'echo hi' } },
  { type: 'codex.item.completed', item: { kind: 'command_execution', exit_code: 0 } },
  { type: 'codex.turn.completed', usage: { input_tokens: 12, output_tokens: 34 } },
];
const alien = await runSession(streaming(writeStub('alien.mjs', ALIEN)));

check('the session ran to the end', alien.exited);
check('the block is not blank for the whole run',
  alien.buffer.trim() !== '', JSON.stringify(alien.buffer));
check('every line of it reached the scrollback',
  ALIEN.every((event) => linesOf(alien.buffer).includes(JSON.stringify(event))),
  JSON.stringify(alien.buffer.slice(0, 400)));
check('the session advanced its sequence number, so a watcher is told there is something to see',
  alien.sequence > 0 && alien.lastSequence === alien.sequence,
  `sequence ${alien.sequence}, last broadcast ${alien.lastSequence}`);

// ─── Done ─────────────────────────────────────────────────────

rmSync(workDir, { recursive: true, force: true });

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
