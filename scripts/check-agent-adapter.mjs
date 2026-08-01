#!/usr/bin/env node
/**
 * Checks that a coding agent is a named backend rather than a string somebody greps.
 *
 * There was no agent abstraction. `RunAgentOptions.agentCommand` was a `string`, and every
 * behaviour that depended on which agent was running was re-derived by a regular expression
 * over that same string — `runsHeadless` for whether it prints and exits, `withoutPrintFlags`
 * for how to make one run interactive, `streamsUsage` for whether there are token counts to
 * read, `applyAgentSettings` for how a project's model reaches it. Four readings of one string,
 * all of them Claude Code's spelling, written by modules with no way to know whether the
 * command was Claude Code. A second CLI could not be named, asked what it can do, or handed a
 * flag, and the next per-backend fix would have been a fifth regular expression.
 *
 * So the cases here are about the *seam*, and there are three things it has to be true of at
 * once:
 *
 *  1. **Two named backends reach a URL, a transcript and token counts through one `runAgent`.**
 *     Two stub binaries, one emitting Claude Code's `stream-json` and one emitting Codex's
 *     JSONL, run through the same function and are read by the same meter and the same
 *     renderer. Neither shares a line of parsing with the other, so a `runAgent` that still
 *     knew one grammar could not pass both.
 *  2. **The `raw` backend spawns what a board spawns today, byte for byte.** Every board that
 *     exists, and twenty check scripts, name their agent as free text — so "an arbitrary
 *     command line, spawned as given, which streams if and only if it says `--output-format
 *     stream-json`" is a contract, and it is asserted as one: the same argv, the same line
 *     inside a distro, and the same prompt bytes on stdin.
 *  3. **`RunAgentOptions` no longer carries a command line.** Asserted against the declarations
 *     the build emits rather than by reading the source, because what a caller can pass is what
 *     the type says.
 *
 * The three stubs are read back for their own argv, so what each backend *spelled* is asserted
 * rather than assumed: the `raw` one is handed the operator's flags untouched, and the named
 * ones write their own — `--print --output-format stream-json --verbose` for one, `exec --json
 * -` for the other, including the `-` that says the prompt is arriving on stdin.
 *
 * Self-contained and offline: three stub agents in a throwaway directory, `runAgent` in this
 * process, no canvas server, no browser, no GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-adapter.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

/** A compiled module, or null when this build has not got it. */
async function loadDist(relative) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) return null;
  try {
    return await import(pathToFileURL(modulePath).href);
  } catch (error) {
    console.error(`  note  dist/${relative.replace(/\\/g, '/')} would not load: ${error.message}`);
    return null;
  }
}

const agentModule = await importDist(join('core', 'issue-agent.js'), 'the agent runner');
const renderModule = await importDist(join('core', 'agent-stream-render.js'), 'the transcript renderer');
const adapterModule = await loadDist(join('core', 'agent-adapter.js'));
const registry = await loadDist(join('core', 'agents', 'index.js'));

const { buildAgentCommand, runAgent } = agentModule;
const { AgentStreamRenderer, parseFoldedTranscript, stripFoldMarks } = renderModule;

// ─── 0. is there a seam at all ────────────────────────────────
//
// Tolerant on purpose, and it is not an early exit for its own sake. Run against the code this
// was written for there is no adapter layer, and a check that stopped at the first missing file
// would report one absent module where the defect is everything below: four regular expressions
// over one string, a `runAgent` that can only read one CLI, and no way for a board to name a
// second one. So each of those is failed by name first, and the run stops there because there
// is nothing left to run them through.

console.log('0. the board can name what it is running');
const seam = Boolean(adapterModule && registry && typeof registry.adapterFor === 'function');
check('there is an adapter interface a backend can implement', Boolean(adapterModule),
      'dist/core/agent-adapter.js does not exist');
check('and a registry that resolves a named backend to one', Boolean(registry?.adapterFor),
      'dist/core/agents/index.js does not export adapterFor');

if (!seam) {
  for (const missing of [
    'a run is spawned from an invocation a backend built, not from a tokenised command line',
    'whether a run streams is the backend\'s answer, not a regex for --output-format stream-json',
    'whether a run prints and exits is the backend\'s answer, not a regex for -p',
    'a project\'s model and effort are values a backend spells, not flags appended to a string',
    'a second CLI\'s stream reaches a URL, a transcript and token counts through the same runAgent',
  ]) check(missing, false, 'there is no backend to ask');
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}

const { adapterFor } = registry;
const { commandLineInvocation, tokenizeCommand } = adapterModule;

const PULL_URL = 'https://github.com/vitorengers/vibemaxxing/pull/326';

// ─── the throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `agent-adapter-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const slash = (value) => value.replace(/\\/g, '/');

/**
 * A stub agent: it records what it was given and then speaks its backend's grammar.
 *
 * Both halves matter. The recording is how the argv a backend *spelled* and the prompt bytes it
 * delivered are asserted rather than assumed; the stream is what has to reach a URL, a
 * transcript and a set of token counts through code that knows neither CLI.
 */
function writeStub(name, lines) {
  const file = join(workDir, `${name}.mjs`);
  writeFileSync(file, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

const record = ${JSON.stringify(join(workDir, `${name}.json`).replace(/\\/g, '\\\\'))};
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  writeFileSync(record, JSON.stringify({ argv: process.argv.slice(2), prompt }), 'utf8');
  process.stdout.write(${JSON.stringify(lines.join('\n'))} + '\\n');
  process.exit(0);
});
`, 'utf8');
  return file;
}

const readRecord = (name) => JSON.parse(readFileSync(join(workDir, `${name}.json`), 'utf8'));

/** Claude Code's stream, as a real capture reads: thinking, a tool call, prose, a `result`. */
const CLAUDE_STREAM = [
  JSON.stringify({ type: 'system', subtype: 'init' }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'weighing it up' }], usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } },
  }),
  JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, estimated_tokens_delta: 50 }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test' } }], usage: { input_tokens: 20, output_tokens: 8 } },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'all cases passed' }] },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_3', content: [{ type: 'text', text: `Merged and landed: ${PULL_URL}` }], usage: { input_tokens: 30, output_tokens: 12 } },
  }),
  JSON.stringify({
    type: 'result',
    num_turns: 3,
    usage: { input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 300 },
  }),
];

/** Codex's JSONL, as its own non-interactive documentation describes it. */
const CODEX_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: '**Scanning the repository**' } }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_1', type: 'command_execution', command: 'npm test', aggregated_output: 'all cases passed\n', exit_code: 0, status: 'completed' },
  }),
  JSON.stringify({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: `Merged and landed: ${PULL_URL}` } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1500, cached_input_tokens: 1500, output_tokens: 222 } }),
];

const claudeStub = writeStub('claude-stub', CLAUDE_STREAM);
const codexStub = writeStub('codex-stub', CODEX_STREAM);
const rawStub = writeStub('raw-stub', CLAUDE_STREAM);

const workspace = {
  id: 'adapter-check',
  environment: { kind: 'native' },
  path: workDir,
  innerPath: slash(workDir),
};
const distroWorkspace = {
  id: 'adapter-check-wsl',
  environment: { kind: 'wsl', distro: 'Some-Distro' },
  path: workDir,
  innerPath: '/home/me/project',
};

const PROMPT = 'Implement the issue.\nIt has a $variable and a `backtick` in it, deliberately.';

// ─── 1. three backends, and they are three ────────────────────

console.log('1. a board can name a backend and get a distinct one');
{
  const ids = ['claude-code', 'codex-cli', 'raw'];
  const adapters = ids.map((id) => adapterFor(id));
  check('adapterFor answers for claude-code, codex-cli and raw',
        adapters.every((adapter) => adapter && typeof adapter.invoke === 'function'),
        JSON.stringify(adapters.map((adapter) => adapter?.id ?? null)));
  check('each one is a different adapter, and says which it is',
        new Set(adapters.map((adapter) => adapter.id)).size === 3
        && adapters.every((adapter, at) => adapter.id === ids[at]),
        JSON.stringify(adapters.map((adapter) => adapter.id)));

  // The four questions the string used to be grepped for, asked of the backend instead.
  const surface = ['invoke', 'streams', 'readUsage', 'renderEvent', 'actionOf'];
  check('and every one of them answers the whole interface',
        adapters.every((adapter) => surface.every((name) => typeof adapter[name] === 'function')),
        surface.join(', '));

  // Two grammars, and the proof is that neither can read the other's events.
  const claude = adapterFor('claude-code');
  const codex = adapterFor('codex-cli');
  const codexTurn = { type: 'turn.completed', usage: { input_tokens: 7, cached_input_tokens: 0, output_tokens: 3 } };
  const claudeResult = { type: 'result', usage: { input_tokens: 7, output_tokens: 3 } };
  check('a Codex event is read by the Codex backend and not by Claude Code\'s',
        codex.readUsage(codexTurn)?.counts?.output === 3 && claude.readUsage(codexTurn) === null,
        JSON.stringify([codex.readUsage(codexTurn), claude.readUsage(codexTurn)]));
  check('and the other way round',
        claude.readUsage(claudeResult)?.counts?.output === 3 && codex.readUsage(claudeResult) === null,
        JSON.stringify([claude.readUsage(claudeResult), codex.readUsage(claudeResult)]));
  check('each names a step in its own vocabulary',
        claude.actionOf('Bash') === 'execution' && codex.actionOf('command_execution') === 'execution'
        && codex.actionOf('file_change') === 'mutation',
        `${claude.actionOf('Bash')} / ${codex.actionOf('command_execution')} / ${codex.actionOf('file_change')}`);
}

// ─── 2. what each backend spells ──────────────────────────────

console.log('\n2. a named backend writes its own flags; the passthrough writes none');
{
  const claude = adapterFor('claude-code').invoke({ mode: 'headless', role: 'implement', command: 'claude' });
  check('claude-code asks for the stream a board can read, from a bare binary',
        claude.command === 'claude'
        && claude.args.join(' ') === '--print --output-format stream-json --verbose',
        JSON.stringify(claude));
  check('and its prompt goes on stdin, which is what a pseudoterminal cannot end',
        claude.prompt.via === 'stdin', JSON.stringify(claude.prompt));

  const claudeTuned = adapterFor('claude-code')
    .invoke({ mode: 'headless', role: 'implement', command: 'claude --print --model opus', model: 'sonnet' });
  check('it does not repeat a flag the operator already wrote',
        claudeTuned.args.filter((argument) => argument === '--print').length === 1,
        JSON.stringify(claudeTuned.args));
  check('and it keeps the operator\'s own arguments',
        claudeTuned.args.includes('--model') && claudeTuned.args.includes('opus'),
        JSON.stringify(claudeTuned.args));

  const claudeInteractive = adapterFor('claude-code')
    .invoke({ mode: 'interactive', role: 'implement', command: 'claude -p --output-format stream-json --verbose' });
  check('an interactive claude-code run carries no print flag at all',
        !claudeInteractive.args.some((argument) => ['-p', '--print', '--output-format', 'stream-json'].includes(argument)),
        JSON.stringify(claudeInteractive.args));
  check('and takes its prompt as an argument, leaving stdin for the reader',
        claudeInteractive.prompt.via === 'argv', JSON.stringify(claudeInteractive.prompt));

  const codex = adapterFor('codex-cli')
    .invoke({ mode: 'headless', role: 'implement', command: 'codex', model: 'gpt-5.4', effort: 'high' });
  check('codex-cli runs its own subcommand first',
        codex.args[0] === 'exec', JSON.stringify(codex.args));
  check('it asks for JSON Lines and spells reasoning effort as a config override',
        codex.args.includes('--json')
        && codex.args.join(' ').includes('-c model_reasoning_effort=high'),
        JSON.stringify(codex.args));
  check('and it ends with the argument that says the prompt is on stdin',
        codex.args[codex.args.length - 1] === '-' && codex.prompt.marker === '-'
        && codex.prompt.via === 'stdin',
        JSON.stringify(codex));
}

// ─── 3. the raw backend is byte for byte what a board runs today ──

console.log('\n3. the raw backend spawns what every board configured today spawns');
{
  const OPERATOR = 'claude -p --output-format stream-json --verbose --allowedTools "Bash(gh:*) Read"';
  const raw = adapterFor('raw').invoke({ mode: 'headless', role: 'implement', command: OPERATOR });

  check('the command line reaches a distro untouched, character for character',
        raw.line === OPERATOR, JSON.stringify(raw.line));

  // What the old code did: `tokenizeCommand` on the operator's string, argv[0] and the rest.
  const expected = tokenizeCommand(OPERATOR);
  const built = buildAgentCommand(workspace, raw);
  check('and on this machine the argv is the tokenised command and nothing else',
        built.command === expected[0]
        && JSON.stringify(built.args) === JSON.stringify(expected.slice(1)),
        `${JSON.stringify(built.command)} ${JSON.stringify(built.args)}`);
  check('a quoted value with spaces in it survives as one argument',
        built.args.includes('Bash(gh:*) Read'), JSON.stringify(built.args));

  // The launcher's own name is deliberately not spelled out. `check-tiers.mjs` reads that name
  // in a check's code as evidence the check spawns a distro, and this one spawns nothing but
  // `node`; what it has to assert is the shape anyway — a wrapper that is not the operator's own
  // binary, the distro named to it, and the operator's line arriving as one argument, whole.
  const inDistro = buildAgentCommand(distroWorkspace, raw);
  check('inside a distro the shell is handed the operator\'s own line',
        inDistro.command !== built.command
        && inDistro.args.includes(distroWorkspace.environment.distro)
        && inDistro.args[inDistro.args.length - 1] === OPERATOR,
        `${JSON.stringify(inDistro.command)} ${JSON.stringify(inDistro.args)}`);

  check('it streams because the operator asked it to, and not otherwise',
        adapterFor('raw').streams(raw)
        && !adapterFor('raw').streams(commandLineInvocation('claude -p')),
        'the one flag that makes a command speak while it works');

  // The project's model and effort still arrive the way they always did: appended, so the CLI
  // keeps the last one, and after the print flags have come off rather than before.
  const tuned = adapterFor('raw')
    .invoke({ mode: 'headless', role: 'issue', command: 'claude -p', model: 'sonnet', effort: 'high' });
  check('a project\'s model and effort are appended to the operator\'s line',
        tuned.line === 'claude -p --model sonnet --effort high', JSON.stringify(tuned.line));
  const untuned = adapterFor('raw').invoke({ mode: 'headless', role: 'issue', command: 'claude -p' });
  check('and a project that configures neither changes nothing at all',
        untuned.line === 'claude -p', JSON.stringify(untuned.line));

  const interactive = adapterFor('raw')
    .invoke({ mode: 'interactive', role: 'implement', command: OPERATOR, model: 'sonnet' });
  // `--verbose` stays, and that is the passthrough being a passthrough: it is not one of the
  // three flags documented as only working with `--print`, so removing it would be this board
  // editing a command line it does not own.
  check('an interactive raw run has its print flags removed and its model appended after',
        interactive.line === 'claude --verbose --allowedTools "Bash(gh:*) Read" --model sonnet',
        JSON.stringify(interactive.line));
}

// ─── 4. no command line survives on RunAgentOptions ───────────

console.log('\n4. nothing downstream is handed a command line to grep');
{
  const declarations = readFileSync(join(repoRoot, 'dist', 'core', 'issue-agent.d.ts'), 'utf8');
  const block = /export interface RunAgentOptions \{[\s\S]*?\n\}/.exec(declarations)?.[0] ?? '';
  check('RunAgentOptions is declared', block.length > 0);
  check('and it has no agentCommand field',
        block.length > 0 && !/\bagentCommand\b/.test(block),
        block.split('\n').filter((line) => /agentCommand/.test(line)).join(' | '));
  check('it takes an adapter and an invocation instead',
        /\badapter: AgentAdapter\b/.test(block) && /\binvocation: AgentInvocation\b/.test(block),
        block.split('\n').slice(0, 6).join(' | '));
}

// ─── 5. all three reach a URL, a transcript and token counts ──

console.log('\n5. three backends, one runAgent, and all of them arrive');

async function runThrough(name, backend, command) {
  const adapter = adapterFor(backend);
  const invocation = adapter.invoke({ mode: 'headless', role: 'implement', command });
  const usage = [];
  const run = await runAgent(workspace, PROMPT, {
    adapter,
    invocation,
    expects: 'pull',
    what: `the ${backend} adapter check`,
    timeoutMs: 60_000,
    onUsage: (one) => usage.push(one),
  });
  const rendered = new AgentStreamRenderer(adapter).feed(run.output);
  return { adapter, invocation, run, usage, rendered, record: readRecord(name) };
}

for (const [name, backend, command, spelled, step] of [
  ['claude-stub', 'claude-code', `node "${slash(claudeStub)}"`,
   ['--print', '--output-format', 'stream-json', '--verbose'], 'Bash'],
  ['codex-stub', 'codex-cli', `node "${slash(codexStub)}" exec`,
   ['exec', '--json', '-'], 'command_execution'],
  ['raw-stub', 'raw', `node "${slash(rawStub)}" -p --output-format stream-json --verbose`,
   ['-p', '--output-format', 'stream-json', '--verbose'], 'Bash'],
]) {
  console.log(`\n   ${backend}`);
  const { run, usage, rendered, record } = await runThrough(name, backend, command);

  check('the run reaches the pull request URL', run.ok === true && run.url === PULL_URL,
        `${JSON.stringify(run.url)} ${JSON.stringify(run.error)}`);

  // The flags after the stub's own path, which is what this backend decided to write.
  check('the binary was given exactly the arguments this backend spells',
        JSON.stringify(record.argv.slice(record.argv.length - spelled.length)) === JSON.stringify(spelled),
        JSON.stringify(record.argv));

  check('and the prompt arrived on stdin, byte for byte',
        record.prompt === PROMPT,
        `${JSON.stringify(record.prompt.slice(0, 40))} vs ${JSON.stringify(PROMPT.slice(0, 40))}`);

  const last = usage[usage.length - 1] ?? null;
  check('the token counts were read out of its own stream',
        Boolean(last) && last.inputTokens === 3000 && last.outputTokens > 0,
        JSON.stringify(last));

  const { rows } = parseFoldedTranscript(rendered);
  const heads = rows.filter((row) => row.head);
  check('the transcript has a foldable row for the step it took',
        heads.some((row) => row.text.includes(step) && row.text.includes('npm test')),
        JSON.stringify(heads.map((row) => row.text)));
  check('the answer to that step is folded under it',
        rows.some((row) => !row.head && row.id && row.text.includes('all cases passed')),
        JSON.stringify(rows.map((row) => row.text)));
  check('the agent\'s own prose is in it, with the URL intact',
        stripFoldMarks(rendered).includes(PULL_URL), JSON.stringify(rendered.slice(-200)));
  check('and it closes by saying the run finished',
        rows.some((row) => /the run finished/.test(row.text)),
        JSON.stringify(rows[rows.length - 1]?.text ?? null));
}

// ─── 6. what only one of them says ────────────────────────────

console.log('\n6. and the two grammars really are two');
{
  // The same bytes through the other backend's renderer: a Codex stream rendered as Claude
  // Code's is nothing at all, which is what makes case 5 a property of the seam rather than of
  // one renderer that happens to be tolerant.
  const asClaude = new AgentStreamRenderer(adapterFor('claude-code')).feed(`${CODEX_STREAM.join('\n')}\n`);
  check('a Codex stream drawn by Claude Code\'s renderer draws no step at all',
        !parseFoldedTranscript(asClaude).rows.some((row) => row.head),
        JSON.stringify(asClaude.slice(0, 200)));

  const asCodex = new AgentStreamRenderer(adapterFor('codex-cli')).feed(`${CLAUDE_STREAM.join('\n')}\n`);
  check('and the other way round',
        !parseFoldedTranscript(asCodex).rows.some((row) => row.head),
        JSON.stringify(asCodex.slice(0, 200)));

  // The default is Claude Code's, which is also the raw backend's, so every caller that had a
  // stream and no backend to name renders exactly what it rendered before backends existed.
  const byDefault = new AgentStreamRenderer().feed(`${CLAUDE_STREAM.join('\n')}\n`);
  const byRaw = new AgentStreamRenderer(adapterFor('raw')).feed(`${CLAUDE_STREAM.join('\n')}\n`);
  check('a renderer with no backend named draws what the raw backend draws',
        byDefault === byRaw, `${byDefault.length} vs ${byRaw.length} characters`);
}

rmSync(workDir, { recursive: true, force: true });

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
