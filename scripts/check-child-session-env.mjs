#!/usr/bin/env node
/**
 * Checks that `CLAUDE_CODE_CHILD_SESSION` does not ride out of the board into its children.
 *
 * Claude Code sets that marker in every subprocess it spawns from the Bash, PowerShell and
 * Monitor tools, from hook commands and from status line commands, and an interactive
 * `claude` that sees it is deliberately excluded from `--resume`, `--continue`, up-arrow
 * history and `claude agents`. The documentation is explicit that the marker is *not* set
 * for stdio MCP server subprocesses, "which are long-lived and outlive the session that
 * spawned them" — and the board server is exactly that class of process. Started once from
 * a Claude Code tool call it inherits the marker anyway, and then stamps it onto every
 * shell and every agent it spawns for the rest of its life, hours after the session that
 * set it has gone. A `claude` typed into a terminal block is told it is nested when it is
 * not, and the session it holds is thrown away when the block is closed.
 *
 * So the cases here are about one key and the two places a child of the board is given an
 * environment: `terminal-session.ts`, which spawns the shell through a PTY where there is
 * one and through pipes where there is not, and `issue-agent.ts`'s `runAgent`, shared by
 * the issue agent and the implement agent. Both are asserted, because a rule kept in one
 * place and not the other is how the two drift apart.
 *
 * Each case also asserts a **sentinel** variable arriving intact. The board is not being
 * put behind an allowlist here — it strips one key it has a reason to strip, and everything
 * else a project's environment carries has to reach the shell exactly as before.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas servers on free
 * ports and kills them. Nothing here talks to GitHub. The shell and the agent are Node
 * stubs that report the environment they were handed.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-child-session-env.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const MARKER = 'CLAUDE_CODE_CHILD_SESSION';
const SENTINEL = 'EXCALIDRAW_CHECK_SENTINEL';
const SENTINEL_VALUE = 'kept';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The marker as the child saw it, whatever case the key arrived in.
 *
 * Windows environment blocks are case-insensitive and `process.env` there is a plain
 * object once it has been spread, so a `Claude_Code_Child_Session` that survived a
 * case-sensitive delete would still be the defect this file is about.
 */
function markerIn(env) {
  const found = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === MARKER);
  return found ? found[1] : undefined;
}

function sentinelIn(env) {
  const found = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === SENTINEL);
  return found ? found[1] : undefined;
}

/** The three assertions every spawn path owes, written once so they cannot drift apart. */
function assertEnvironment(label, env) {
  console.log(`\n${label}`);
  const marker = markerIn(env);
  check('the nested-session marker did not reach the child', marker === undefined,
        `${MARKER}=${JSON.stringify(marker)} — an interactive claude started here drops out of --resume`);
  check('an ordinary variable still did', sentinelIn(env) === SENTINEL_VALUE,
        `${SENTINEL}=${JSON.stringify(sentinelIn(env))} — the board strips one key, it does not filter the environment`);
  check('PATH is still set', Boolean(env?.PATH ?? env?.Path),
        'the child needs the PATH the board already adjusts for it');
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

const workDir = join(tmpdir(), `child-session-env-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Child Session Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'child-session-check';
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
 * because the environment is the thing under test: a stub that needed a variable to know
 * where to write would go quiet exactly when this check has something to say.
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
 * A board that inherited the marker, which is the situation being fixed.
 *
 * Set here rather than found: whether any particular machine's board holds it depends on
 * how that board was started, and a check that only ran on the machines where it does
 * would pass everywhere else for no reason.
 */
function startCanvas(port, env = {}) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      [MARKER]: '1',
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
const BASE = `http://127.0.0.1:${PORT}`;
const PIPE_BASE = `http://127.0.0.1:${PIPE_PORT}`;

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
    assertEnvironment('   the environment the shell was handed', readDump('shell-pty'));
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
    assertEnvironment('   the environment the shell was handed', readDump('shell-pipe'));
  }
  await call(PIPE_BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n3. and the agents, which are spawned from the other place PATH is adjusted');
  //
  // In this process rather than through a server: `runAgent` builds the child's environment
  // from `process.env`, so standing in for the board here is the whole of what it reads.
  // The agents run `claude -p`, which persists regardless of the marker — but one rule is
  // easier to keep than two, and this is the file that says so.
  const agentModule = await importDist(join('core', 'issue-agent.js'), 'the issue agent');
  if (agentModule) {
    process.env[MARKER] = '1';
    process.env[SENTINEL] = SENTINEL_VALUE;

    const workspace = {
      id: WORKSPACE,
      name: 'Child Session Check',
      path: projectDir,
      innerPath: posix(projectDir),
      environment: { kind: 'native' },
      error: null,
    };
    const run = await agentModule.runIssueAgent(workspace, 'An observation.',
                                                { agentCommand: agentStub, timeoutMs: 60_000 });
    check('the agent ran', run?.ok === true, JSON.stringify(run?.error ?? run));
    if (existsSync(dumpPath('agent'))) {
      assertEnvironment('   the environment the agent was handed', readDump('agent'));
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
