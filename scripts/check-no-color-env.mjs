#!/usr/bin/env node
/**
 * Checks that a Claude Code session's `NO_COLOR` does not ride out of the board into its
 * children — and that an operator's own `NO_COLOR` still does.
 *
 * Claude Code sets `NO_COLOR=1` in the subprocesses its Bash, PowerShell and Monitor tools
 * spawn, because their output is captured as text and read back rather than drawn on a
 * screen. That is a statement about one captured subprocess, not about the machine. The
 * board server is the class of process that outlives the session which started it — the same
 * argument `check-child-session-env.mjs` makes about `CLAUDE_CODE_CHILD_SESSION` — so a
 * board started once from a tool call inherits the variable and then hands it to every shell
 * and every agent it opens for the rest of its life. Measured on a real board: a terminal
 * block running Claude Code emitted **zero** colour sequences on the native workspace and
 * 614 on the WSL one, which escapes only because `wsl.exe` does not carry the Windows
 * environment into the distro.
 *
 * The rule under test is therefore two-sided, and the second side is the point:
 *
 * - `NO_COLOR` **with** `CLAUDECODE` beside it is the leak, and is stripped;
 * - `NO_COLOR` **without** it is a preference the machine holds — `no-color.org` is a
 *   standard, and a board that discarded it unconditionally would be overriding the
 *   operator rather than correcting an inheritance. It survives untouched.
 *
 * Both the terminal and the agents are asserted, on the pseudoterminal path and the pipe
 * path, because a rule kept in one of the two places and not the other is how they drift
 * apart. Each case also asserts a **sentinel** arriving intact: the board is not being put
 * behind an allowlist, it strips keys it has a reason to strip.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas servers on free
 * ports and kills them. Nothing here talks to GitHub. The shell and the agent are Node stubs
 * that report the environment they were handed.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-no-color-env.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const MARKER = 'NO_COLOR';
/** What tells the board the `NO_COLOR` beside it belongs to a session rather than a machine. */
const WITNESS = 'CLAUDECODE';
const SENTINEL = 'EXCALIDRAW_CHECK_SENTINEL';
const SENTINEL_VALUE = 'kept';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A variable as the child saw it, whatever case the key arrived in.
 *
 * Windows environment blocks are case-insensitive and `process.env` there is a plain object
 * once it has been spread, so a `No_Color` that survived a case-sensitive delete would still
 * be the defect this file is about.
 */
function lookup(env, name) {
  const found = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === name);
  return found ? found[1] : undefined;
}

/** What every spawn path owes when the variable arrived as a session's, written once. */
function assertStripped(label, env) {
  console.log(`\n${label}`);
  const marker = lookup(env, MARKER);
  check('the session\'s NO_COLOR did not reach the child', marker === undefined,
        `${MARKER}=${JSON.stringify(marker)} — everything the block runs would draw in black and white`);
  check('an ordinary variable still did', lookup(env, SENTINEL) === SENTINEL_VALUE,
        `${SENTINEL}=${JSON.stringify(lookup(env, SENTINEL))} — the board strips keys, it does not filter the environment`);
  check('PATH is still set', Boolean(env?.PATH ?? env?.Path),
        'the child needs the PATH the board already adjusts for it');
}

/** And what it owes when the variable is the machine's own. */
function assertKept(label, env) {
  console.log(`\n${label}`);
  const marker = lookup(env, MARKER);
  check('the operator\'s own NO_COLOR reached the child', marker === '1',
        `${MARKER}=${JSON.stringify(marker)} — with no CLAUDECODE beside it this is a preference, not an inheritance`);
  check('an ordinary variable did too', lookup(env, SENTINEL) === SENTINEL_VALUE,
        `${SENTINEL}=${JSON.stringify(lookup(env, SENTINEL))}`);
}

async function waitFor(predicate, what, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  failures++;
  console.error(`  FAIL  timed out waiting for ${what}`);
  return false;
}

/**
 * A module from `dist`, or nothing.
 *
 * Nothing rather than an exit: the cases that do not need it still run, and a check that
 * dies on its first import shows one line about its own harness instead of the defect.
 */
async function importDist(relative, what) {
  const full = join(repoRoot, 'dist', relative);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `no-color-env-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'No Colour Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'no-color-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

const posix = (value) => value.replace(/\\/g, '/');
const dumpPath = (name) => join(workDir, `${name}.json`);
const readDump = (name) => JSON.parse(readFileSync(dumpPath(name), 'utf8'));

/**
 * A stub that reports the environment it was given and then stays out of the way.
 *
 * The destination is written into the source rather than passed through the environment,
 * because the environment is the thing under test.
 */
function writeEnvStub(file, name, tail) {
  writeFileSync(file, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(posix(dumpPath(name)))}, JSON.stringify(process.env), 'utf8');
${tail}
`, 'utf8');
  return `node "${posix(file)}"`;
}

// A shell that is not a shell: it reports, then reads stdin so the session stays open.
const shellStub = writeEnvStub(join(workDir, 'stub-shell.mjs'), 'shell-pty',
  `process.stdin.resume();`);
const pipeShellStub = writeEnvStub(join(workDir, 'stub-shell-pipe.mjs'), 'shell-pipe',
  `process.stdin.resume();`);
const keptShellStub = writeEnvStub(join(workDir, 'stub-shell-kept.mjs'), 'shell-kept',
  `process.stdin.resume();`);

/**
 * A shell that decides on colour the way a real program does, and prints the answer.
 *
 * `util.styleText` is Node's own: it consults `NO_COLOR`, `FORCE_COLOR` and the stream's
 * colour depth, and none of that logic is this repository's. Asserting the variable is gone
 * proves what `agentEnv` did; asserting a colour sequence reaches the transcript the browser
 * replays proves the thing that was actually reported.
 */
const colourShellStub = join(workDir, 'stub-shell-colour.mjs');
writeFileSync(colourShellStub, `#!/usr/bin/env node
import { styleText } from 'node:util';
process.stdout.write(styleText('red', 'COLOURED', { stream: process.stdout }) + '\\n');
process.stdin.resume();
`, 'utf8');
const colourShellCommand = `node "${posix(colourShellStub)}"`;

// An agent that is not an agent: it reports, drains the prompt and prints a URL, because
// `runAgent` reads the last GitHub URL on stdout and would otherwise call the run failed.
const agentStub = writeEnvStub(join(workDir, 'stub-agent.mjs'), 'agent',
  `let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/issues/1\\n');
});`);

// ─── Servers ──────────────────────────────────────────────────

const running = [];

/**
 * Every spelling of `name` this process holds, marked for removal from a child's environment.
 * Case-insensitively, because Windows reports whatever case the variable was set with.
 */
const unset = (name) => Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => key.toUpperCase() === name)
    .map((key) => [key, undefined]),
);

/**
 * A board that inherited the variable, which is the situation being fixed.
 *
 * Set here rather than found: whether any particular machine's board holds it depends on how
 * that board was started, and a check that only ran where it does would pass everywhere else
 * for no reason. `witness` says whether Claude Code's own marker comes with it — the whole of
 * what separates a leak from a preference — and it is **deleted** rather than merely left
 * unset, because this check is itself likely to be run from a tool call that sets it.
 */
function startCanvas(port, env = {}, witness = true) {
  const child = spawnCanvas({
    port,
    env: {
      ...unset(WITNESS),
      ...unset(MARKER),
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      [MARKER]: '1',
      ...(witness ? { [WITNESS]: '1' } : {}),
      [SENTINEL]: SENTINEL_VALUE,
      ...env,
    },
  }).child;
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  running.push(child);
  return { child, read: () => log };
}

async function waitForHealth(base, server) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`the canvas server exited early:\n${server.read()}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${server.read()}`);
}

/** One request, with two more goes at the connection, which occasionally refuses here. */
async function call(base, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}${glue}workspace=${WORKSPACE}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const PORT = await freePort();
const PIPE_PORT = await freePort();
const KEPT_PORT = await freePort();
const COLOUR_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const PIPE_BASE = `http://127.0.0.1:${PIPE_PORT}`;
const KEPT_BASE = `http://127.0.0.1:${KEPT_PORT}`;
const COLOUR_BASE = `http://127.0.0.1:${COLOUR_PORT}`;

/** Any SGR sequence that sets a colour rather than merely a weight. */
const COLOUR_SGR = /\x1b\[[0-9;]*?(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38|48)[0-9;]*m/;

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  console.log('1. the terminal, on a pseudoterminal where the machine has one');
  const server = startCanvas(PORT, { EXCALIDRAW_TERMINAL: shellStub });
  await waitForHealth(BASE, server);

  const opened = await call(BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', opened.status === 202, `got ${opened.status} ${JSON.stringify(opened.body)}`);
  const mode = opened.body?.session?.mode ?? 'unknown';
  console.log(`  (the session came up in "${mode}" mode)`);
  if (await waitFor(() => existsSync(dumpPath('shell-pty')), 'the shell to report its environment')) {
    assertStripped('   the environment the shell was handed', readDump('shell-pty'));
  }
  await call(BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n2. and on pipes, which is the other half of the same constructor');
  const pipeServer = startCanvas(PIPE_PORT, {
    EXCALIDRAW_TERMINAL: pipeShellStub,
    EXCALIDRAW_TERMINAL_PTY: '0',
  });
  await waitForHealth(PIPE_BASE, pipeServer);

  const pipeOpened = await call(PIPE_BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', pipeOpened.status === 202,
        `got ${pipeOpened.status} ${JSON.stringify(pipeOpened.body)}`);
  check('and it is the pipe one', pipeOpened.body?.session?.mode === 'pipe',
        `mode ${pipeOpened.body?.session?.mode} — EXCALIDRAW_TERMINAL_PTY=0 must force the fallback`);
  if (await waitFor(() => existsSync(dumpPath('shell-pipe')), 'the shell to report its environment')) {
    assertStripped('   the environment the shell was handed', readDump('shell-pipe'));
  }
  await call(PIPE_BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n3. a board whose NO_COLOR is the machine\'s own, which must be left alone');
  //
  // The half that keeps this a correction rather than an override. Without CLAUDECODE the
  // variable was not put there by a session that captured somebody's stdout, and the board
  // has no standing to discard it.
  const keptServer = startCanvas(KEPT_PORT, { EXCALIDRAW_TERMINAL: keptShellStub }, false);
  await waitForHealth(KEPT_BASE, keptServer);

  const keptOpened = await call(KEPT_BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', keptOpened.status === 202,
        `got ${keptOpened.status} ${JSON.stringify(keptOpened.body)}`);
  if (await waitFor(() => existsSync(dumpPath('shell-kept')), 'the shell to report its environment')) {
    assertKept('   the environment the shell was handed', readDump('shell-kept'));
  }
  await call(KEPT_BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n4. and the colour arrives in the transcript, which is what was reported');
  //
  // The end of the chain rather than the start of it. Everything above asserts what the
  // board did to an environment; this asserts what a program *decided* because of it, in
  // bytes the board holds and replays to a browser. Skipped without a pseudoterminal,
  // because there `stdin.isTTY` is false and a colour-aware program is right to say no —
  // which is the fallback this repository documents, not a failure.
  const colourServer = startCanvas(COLOUR_PORT, { EXCALIDRAW_TERMINAL: colourShellCommand });
  await waitForHealth(COLOUR_BASE, colourServer);

  const colourOpened = await call(COLOUR_BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', colourOpened.status === 202,
        `got ${colourOpened.status} ${JSON.stringify(colourOpened.body)}`);
  if (colourOpened.body?.session?.mode !== 'pty') {
    console.log('  (no pseudoterminal on this machine, so there is no colour to expect — skipped)');
  } else {
    let scrollback = '';
    await waitFor(async () => {
      const listed = await call(COLOUR_BASE, '/api/terminal');
      scrollback = listed.body?.sessions?.[0]?.scrollback ?? '';
      return scrollback.includes('COLOURED');
    }, 'the shell to print');
    check('the shell chose colour, and the board is holding it', COLOUR_SGR.test(scrollback),
          'the transcript carries the word and no colour sequence — which is the reported block exactly');
  }
  await call(COLOUR_BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n5. and the agents, which are spawned from the other place PATH is adjusted');
  //
  // In this process rather than through a server: `runAgent` builds the child's environment
  // from `process.env`, so standing in for the board here is the whole of what it reads.
  const agentModule = await importDist(join('core', 'issue-agent.js'), 'the issue agent');
  if (agentModule) {
    process.env[MARKER] = '1';
    process.env[WITNESS] = '1';
    process.env[SENTINEL] = SENTINEL_VALUE;

    const workspace = {
      id: WORKSPACE,
      name: 'No Colour Check',
      path: projectDir,
      innerPath: posix(projectDir),
      environment: { kind: 'native' },
      error: null,
    };
    const run = await agentModule.runIssueAgent(workspace, 'An observation.',
                                                { agentCommand: agentStub, timeoutMs: 60_000 });
    check('the agent ran', run?.ok === true, JSON.stringify(run?.error ?? run));
    if (existsSync(dumpPath('agent'))) {
      assertStripped('   the environment the agent was handed', readDump('agent'));
    } else {
      failures++;
      console.error('  FAIL  the agent never reported its environment');
    }
  }
} finally {
  stopAll();
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
