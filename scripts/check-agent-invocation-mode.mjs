#!/usr/bin/env node
/**
 * Checks that whether a run prints and exits, and whether it speaks while it works, are facts
 * the backend declares rather than answers grepped out of somebody's command line.
 *
 * Three functions used to answer them for everybody. `runsHeadless` matched a whole-argument
 * `-p`/`--print`, and its own comment conceded that a command spelling non-interactive some
 * other way reads as interactive. `streamsUsage` matched `--output-format stream-json` and
 * gated three unrelated features off that one test — the token meter, the transcript renderer,
 * and with them the whole readable half of a watched run. `withoutPrintFlags` removed three
 * Claude Code options and was a no-op on any other CLI. All three are Claude Code's spelling,
 * asked by modules with no way to know whether the command was Claude Code.
 *
 * `codex exec --json` is the case that shows what that costs. It is non-interactive and it
 * streams, and it matches none of the three: it would be handed a pseudoterminal it cannot
 * use, be marked interactive so its exit code is thrown away, get no meter, get no renderer,
 * and come back byte for byte unchanged from the button that asks for a tab to answer. And
 * no flag-stripping function could ever have fixed it, because for Codex the headless
 * distinction is a *subcommand* — `exec` — which removing flags structurally cannot express.
 *
 * So the cases below are about where the answers live now:
 *
 *  1. **No `src/core` module hands out a predicate over a command line.** The three are the
 *     `raw` backend's own reading of the one string it is given, and nothing else may ask
 *     them. Asserted against the declarations the build emits, because what a caller can
 *     import is what the type says — and against the sources, because a second copy of a
 *     regular expression is how four readings of one string happened the first time.
 *  2. **Both modes exist, for every backend, and they are different runs.** An interactive
 *     invocation that came back identical to the headless one is the defect this replaces,
 *     and it is asserted per backend rather than for the one whose flags were hard-coded.
 *  3. **Streaming is read off the invocation the adapter built.** For a named backend that
 *     means its own `args`, which is proved by emptying them and by emptying the line
 *     instead: only one of those two can change the answer.
 *  4. **A headless run's exit code is not discarded.** `runHostedAgent` drops the `code === 0`
 *     half of the verdict for a session a reader closed, and that is right for an interface
 *     and wrong for `codex exec --json`. The two are run side by side through the real
 *     function, with a stub that exits non-zero, so the difference is the handle's answer
 *     rather than a regular expression's.
 *  5. **A codex-cli run gets a meter and a renderer.** The stream reaches `onUsage` through
 *     `runAgent`, and a `TerminalSession` handed the same invocation renders it into rows
 *     instead of putting JSON on the wire.
 *
 * Self-contained and offline: two stub agents in a throwaway directory, `runAgent` and one
 * `TerminalSession` in this process, no canvas server, no browser, no GitHub.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-invocation-mode.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
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

const readDist = (relative) => {
  const file = join(repoRoot, 'dist', relative);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
};

const agentModule = await loadDist(join('core', 'issue-agent.js'));
const adapterModule = await loadDist(join('core', 'agent-adapter.js'));
const usageModule = await loadDist(join('core', 'agent-usage.js'));
const registry = await loadDist(join('core', 'agents', 'index.js'));
const sessionModule = await loadDist(join('core', 'terminal-session.js'));

console.log('0. the build is here to be asked');
const ready = Boolean(agentModule?.runAgent && registry?.adapterFor && adapterModule
                      && sessionModule?.TerminalSession);
check('the agent runner, the adapter registry and the terminal session all loaded', ready,
      '(run ./node_modules/.bin/tsc first)');
if (!ready) {
  console.error(`\n${failures + 1} case(s) failed`);
  process.exit(1);
}

const { runAgent } = agentModule;
const { adapterFor } = registry;
const { invocationArgs } = adapterModule;
const { TerminalSession } = sessionModule;

const PULL_URL = 'https://github.com/vitorengers/vibemaxxing/pull/330';
const PROMPT = 'Implement the issue and print the pull request URL last.';

// ─── 1. no module hands out a predicate over a command line ───

console.log('\n1. the three command-line predicates are the raw backend\'s and nobody else\'s');
{
  const PREDICATES = ['runsHeadless', 'withoutPrintFlags', 'streamsUsage'];

  for (const [what, module] of [
    ['the agent runner', agentModule],
    ['the adapter module', adapterModule],
    ['the usage meter', usageModule],
  ]) {
    const exported = PREDICATES.filter((name) => module && name in module);
    check(`${what} exports none of them`, exported.length === 0, exported.join(', '));
  }

  // And what a caller may *write*, which is what the declarations say rather than what this
  // build happened to emit.
  const declared = PREDICATES.filter((name) => new RegExp(`declare function ${name}\\b`)
    .test(readDist(join('core', 'issue-agent.d.ts')) + readDist(join('core', 'agent-adapter.d.ts'))
          + readDist(join('core', 'agent-usage.d.ts'))));
  check('and none of them is declared on those three modules', declared.length === 0,
        declared.join(', '));

  // One reading of one string, in one file. Four independent copies kept in step by hand is
  // the shape this replaces, so a second definition anywhere under src/core is a failure.
  const defining = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      const source = readFileSync(full, 'utf8');
      if (PREDICATES.some((name) => new RegExp(`function ${name}\\b`).test(source))) {
        defining.push(full.slice(repoRoot.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(join(repoRoot, 'src', 'core'));
  check('exactly one module defines them, and it is the raw adapter',
        defining.length === 1 && defining[0] === 'src/core/agents/raw.ts',
        defining.join(', ') || 'nothing defines them');

  // The answers moved; they were not lost. This is the contract every board configured today
  // runs under, and it is asserted here so that "not exported" cannot be met by deleting it.
  const raw = adapterFor('raw');
  const OPERATOR = 'claude -p --output-format stream-json --verbose';
  check('the raw backend still takes the print flags off an interactive run',
        raw.invoke({ mode: 'interactive', role: 'implement', command: OPERATOR }).line
        === 'claude --verbose',
        JSON.stringify(raw.invoke({ mode: 'interactive', role: 'implement', command: OPERATOR }).line));
  check('and still streams if and only if the operator asked it to',
        raw.streams(raw.invoke({ mode: 'headless', role: 'implement', command: OPERATOR }))
        && !raw.streams(raw.invoke({ mode: 'headless', role: 'implement', command: 'claude -p' })),
        'the one flag that makes a command speak while it works');
}

// ─── 2. two modes, for every backend, and they differ ─────────

console.log('\n2. asking for an interactive run gets a different run, whichever backend it is');

/** The operator's command for each backend, and the token that says it is a headless run. */
const BACKENDS = [
  { id: 'claude-code', command: 'claude', headlessToken: '--print' },
  { id: 'codex-cli', command: 'codex', headlessToken: 'exec' },
  { id: 'raw', command: 'claude -p --output-format stream-json --verbose', headlessToken: '-p' },
];

const invocations = new Map();
for (const backend of BACKENDS) {
  const adapter = adapterFor(backend.id);
  const base = { role: 'implement', command: backend.command };
  const headless = adapter.invoke({ ...base, mode: 'headless' });
  const interactive = adapter.invoke({ ...base, mode: 'interactive' });
  invocations.set(backend.id, { adapter, headless, interactive });

  console.log(`\n   ${backend.id}`);
  check('a headless run reads its prompt from stdin, which a pseudoterminal cannot end',
        headless.prompt.via === 'stdin', JSON.stringify(headless.prompt));
  check('an interactive run takes it as an argument, leaving stdin for the reader',
        interactive.prompt.via === 'argv', JSON.stringify(interactive.prompt));
  check('and the two are not the same argv',
        JSON.stringify(headless.args) !== JSON.stringify(interactive.args),
        JSON.stringify(headless.args));
  check('nor the same line for a shell inside a distro',
        headless.line !== interactive.line, JSON.stringify(headless.line));
  check(`the headless one says ${JSON.stringify(backend.headlessToken)} and the other does not`,
        headless.args.includes(backend.headlessToken)
        && !interactive.args.includes(backend.headlessToken),
        `${JSON.stringify(headless.args)} vs ${JSON.stringify(interactive.args)}`);
}

{
  // The case a flag-stripping function structurally cannot express: what makes a Codex run
  // headless is a subcommand and a positional, not an option anything could remove.
  const { headless, interactive } = invocations.get('codex-cli');
  check('\n   and for codex-cli the difference is a subcommand, not a flag that came off',
        headless.args[0] === 'exec' && headless.args[headless.args.length - 1] === '-'
        && headless.prompt.marker === '-'
        && !interactive.args.includes('exec') && !interactive.args.includes('-'),
        `${JSON.stringify(headless.args)} vs ${JSON.stringify(interactive.args)}`);
}

// ─── 3. streaming is read off the invocation the adapter built ─

console.log('\n3. whether a run streams is the backend\'s answer about its own invocation');
for (const backend of BACKENDS) {
  const { adapter, headless, interactive } = invocations.get(backend.id);
  check(`${backend.id}: a headless run streams`, adapter.streams(headless) === true);
  check(`${backend.id}: and an interactive one does not, so no meter runs for it`,
        adapter.streams(interactive) === false);
}
{
  // A named backend wrote the flag itself, so its answer has to come from `args`. Emptying the
  // line cannot change it; emptying the args must. `raw` is deliberately the other way round —
  // the line is the operator's own string and is what it was given to read — so it is not
  // asked this, and the case above is what holds it.
  for (const id of ['claude-code', 'codex-cli']) {
    const { adapter, headless } = invocations.get(id);
    check(`${id}: the answer survives the command line being taken away`,
          adapter.streams({ ...headless, command: '', line: '' }) === true);
    check(`${id}: and it is the arguments it wrote that carry it`,
          adapter.streams({ ...headless, args: [] }) === false,
          JSON.stringify(headless.args));
  }
}

// ─── the throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `agent-invocation-mode-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const slash = (value) => value.replace(/\\/g, '/');

const workspace = {
  id: 'invocation-mode-check',
  environment: { kind: 'native' },
  path: workDir,
  innerPath: slash(workDir),
};

/** Codex's JSONL, as its own non-interactive documentation describes it. */
const CODEX_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1', type: 'command_execution', command: 'npm test',
      aggregated_output: 'all cases passed\n', exit_code: 0, status: 'completed',
    },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_2', type: 'agent_message', text: `Merged and landed: ${PULL_URL}` },
  }),
  JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 1500, cached_input_tokens: 1500, output_tokens: 222 },
  }),
];

/** A stub that reads a prompt off stdin, speaks Codex's grammar and exits as it is told. */
function writeStub(name, lines, code) {
  const file = join(workDir, `${name}.mjs`);
  writeFileSync(file, `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(${JSON.stringify(lines.join('\n'))} + '\\n');
  process.exit(${code});
});
`, 'utf8');
  return file;
}

const codexStub = writeStub('codex-stub', CODEX_STREAM, 0);
const failStub = writeStub('codex-fail-stub', [
  JSON.stringify({ type: 'thread.started', thread_id: 'th_2' }),
  JSON.stringify({ type: 'turn.failed', error: { message: 'the build would not compile' } }),
], 7);

const codexAdapter = adapterFor('codex-cli');
// The subcommand is written out here because the stub is reached through `node`, and `exec`
// prepended to *that* would be a script by that name. An operator naming a real `codex` binary
// writes the bare command and the adapter puts the subcommand in front of it — which is case 2's
// subject, asserted there against the spelling a board would actually use.
const codexInvocation = (stub) => codexAdapter.invoke({
  mode: 'headless', role: 'implement', command: `node "${slash(stub)}" exec`,
});

/**
 * A host that spawns the invocation and reports an ending, the way a terminal tab does.
 *
 * `interactive` is the one thing that varies, and it is what a real session answers from its
 * own mode: a run whose prompt went to stdin is on pipes and says false, and a run the reader
 * can type into says true. What is being checked is what `runHostedAgent` does with each.
 */
function hostReporting(interactive) {
  return async ({ invocation, prompt, onOutput }) => {
    const child = spawn(invocation.command, invocationArgs(invocation, prompt), {
      cwd: workDir, windowsHide: true,
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => onOutput(chunk));
    child.stderr?.on('data', (chunk) => onOutput(chunk));
    child.stdin?.on('error', () => { /* the stub may exit before reading stdin */ });
    if (invocation.prompt.via === 'stdin') child.stdin?.end(prompt);
    return {
      id: 'session-1',
      exited: new Promise((resolve) => child.on('close', (code) => resolve(code))),
      close: () => child.kill(),
      interactive,
      pid: child.pid ?? null,
    };
  };
}

try {
  // ─── 4. a headless run's exit code is not discarded ─────────

  console.log('\n4. a headless run is settled by its exit code, and an interface is not');
  {
    const settled = await runAgent(workspace, PROMPT, {
      adapter: codexAdapter,
      invocation: codexInvocation(failStub),
      expects: 'pull',
      what: 'the codex headless outcome case',
      timeoutMs: 60_000,
      host: hostReporting(false),
    });
    check('the exit code reaches the verdict', settled.code === 7, JSON.stringify(settled.code));
    check('and the run is a failure that says so', settled.ok === false
          && /exited with code 7/.test(settled.error ?? ''), JSON.stringify(settled.error));

    const closed = await runAgent(workspace, PROMPT, {
      adapter: codexAdapter,
      invocation: codexInvocation(failStub),
      expects: 'pull',
      what: 'the interactive outcome case',
      timeoutMs: 60_000,
      host: hostReporting(true),
    });
    check('while a session the reader closed keeps having no exit code to report',
          closed.code === null && closed.ok === false, JSON.stringify(closed.code));
    check('and is explained as an ended session rather than as an exit code',
          /interactive session ended/i.test(closed.error ?? ''), JSON.stringify(closed.error));
  }

  // The spawn site itself: what decides the pseudoterminal is where the prompt goes, which is
  // the invocation's own answer. Read off the built server rather than the source, because
  // what runs is what was built.
  {
    const server = readDist('server.js');
    check('the implement host loads a pseudoterminal from the invocation, not from a flag',
          /invocation\.prompt\.via === 'stdin' \? null : await loadPty\(\)/.test(server),
          'dist/server.js does not decide the binding from prompt.via');
    // Neither called nor still explained that way. The second half is the risk this change
    // carries: the spawn site used to carry a long argument that reading the operator's command
    // shape was deliberate, and leaving it beside the code that no longer does would be two
    // contradictory explanations of one decision.
    const naming = server.split('\n')
      .filter((line) => /\b(runsHeadless|streamsUsage|withoutPrintFlags)\b/.test(line));
    check('and nothing in the built server asks a command line whether it prints and exits',
          naming.length === 0, naming.map((line) => line.trim()).join(' | '));
    check('so a codex-cli headless run is spawned on pipes',
          invocations.get('codex-cli').headless.prompt.via === 'stdin');
  }

  // ─── 5. a codex-cli run gets a meter and a renderer ─────────

  console.log('\n5. a codex-cli run is counted and rendered like any other streaming run');
  {
    const usage = [];
    const run = await runAgent(workspace, PROMPT, {
      adapter: codexAdapter,
      invocation: codexInvocation(codexStub),
      expects: 'pull',
      what: 'the codex meter case',
      timeoutMs: 60_000,
      onUsage: (one) => usage.push(one),
    });
    check('the run reaches the pull request URL', run.ok === true && run.url === PULL_URL,
          `${JSON.stringify(run.url)} ${JSON.stringify(run.error)}`);
    const last = usage[usage.length - 1] ?? null;
    check('and a UsageMeter read its figures out of its own stream',
          Boolean(last) && last.inputTokens === 3000 && last.outputTokens === 222,
          JSON.stringify(last));
  }

  {
    const invocation = codexInvocation(codexStub);
    const shown = [];
    let raw = '';
    const session = new TerminalSession(
      's1', workspace, invocation.line,
      {
        onOutput: (data) => shown.push(data),
        onRaw: (data) => { raw += data; },
        onExit: () => { /* the ending is awaited below */ },
      },
      null,
      { input: PROMPT, agent: { adapter: codexAdapter, invocation } }
    );
    await new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (!session.alive || Date.now() - started > 30_000) { clearInterval(timer); resolve(); }
      }, 100);
    });
    session.close();

    const transcript = shown.join('');
    check('a tab watching it was given an AgentStreamRenderer',
          transcript.length > 0 && !transcript.includes('"item.completed"'),
          JSON.stringify(transcript.slice(0, 120)));
    check('so the reader sees the step it took rather than the envelope it arrived in',
          transcript.includes('npm test') && transcript.includes('command_execution'),
          JSON.stringify(transcript.slice(0, 200)));
    check('and the raw tap still has every byte, which is where the URL comes from',
          raw.includes('"item.completed"') && raw.includes(PULL_URL),
          JSON.stringify(raw.slice(0, 120)));
  }
} finally {
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
