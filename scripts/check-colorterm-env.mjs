#!/usr/bin/env node
/**
 * Checks that the board says what kind of terminal it is really handing a child, and says it
 * only where it is true.
 *
 * `check-no-color-env.mjs` asserts the variable the board *strips*; this is the other side of
 * the same argument, the one it adds. `TERM=xterm-256color` is a name, and a name is where a
 * program's colour decision stops: `supports-color` — which nearly every Node CLI reaches for —
 * promotes to 24-bit only when `COLORTERM` says `truecolor` or `24bit`, and on the name alone it
 * settles for 256. Node's own `tty.WriteStream.getColorDepth` reads the same variable. The
 * emulator on the far side of the block is xterm.js, which renders 24-bit, so the board was
 * understating its own terminal and the child was downgrading for no reason.
 *
 * ## The line the promotion stops at, which is the case worth having
 *
 * A tab the board **renders itself** — `Implement / Fix`, whose command carries
 * `--output-format stream-json` — is not drawn by an emulator at all since #251. It is a
 * document, and a document resolves colour from slot *names*; `38;2;r;g;b` has no name and comes
 * out on the default ink. Promoting that child would turn a tool's coloured output from sixteen
 * resolvable slots into an unresolvable literal — colour lost rather than gained. So the tab that
 * repaints itself is told, and the tab the board composes is not, and both halves are asserted
 * here because a rule kept in one place and not the other is how the two drift apart.
 *
 * The pipe path is told nothing either: there is no terminal there, `stdin.isTTY` is false and a
 * colour-aware program is right to say no.
 *
 * ## What a real child does with it, measured rather than assumed
 *
 * Claude Code 2.1.220, launched with no arguments through this board's own pty binding on
 * 2026-07-30 with `NO_COLOR` deleted, emitted the **same 48 colour sequences either way** —
 * `[37m`, `[2m`, `[32m`, `[91m`, `[33m` and the rest of the sixteen, and **not one** `38;5` or
 * `38;2`. Its own interface draws in the sixteen, so on that tab the promotion changes nothing
 * today and the palette is what decides what its orange looks like. That is recorded in
 * `docs/terminal.md`; the variable is still set, because it is a true statement about the
 * terminal and the next program in a shell tab is not Claude Code.
 *
 * **And Windows answers 24-bit on its own**, which is why the before-and-after case below is
 * skipped there with a line saying so rather than asserted: Node and `supports-color` both
 * special-case a modern Windows console. Where the variable decides anything is where `TERM` is
 * all a program has — every POSIX board, and every WSL workspace on a Windows one, which
 * `buildAgentCommand` runs through `wsl.exe` into a Linux Node.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas servers on free ports
 * and kills them. The shells are Node stubs that report the environment they were handed, and
 * on the pseudoterminal path one of them reports what Node's own colour-depth decision came out
 * as — which is the mechanism, rather than an imitation of it.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-colorterm-env.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const MARKER = 'COLORTERM';
/** What a child is entitled to be told when the terminal really is one. */
const PROMOTED = ['truecolor', '24bit'];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A variable as the child saw it, whatever case the key arrived in. */
function lookup(env, name) {
  const found = Object.entries(env ?? {}).find(([key]) => key.toUpperCase() === name);
  return found ? found[1] : undefined;
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

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `colorterm-env-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Colourterm Check', repo: 'vitorengers/vibemaxxing' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'colorterm-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

const posix = (value) => value.replace(/\\/g, '/');
const dumpPath = (name) => join(workDir, `${name}.json`);
const readDump = (name) => JSON.parse(readFileSync(dumpPath(name), 'utf8'));

/**
 * A stub that reports the environment it was given, and what a colour-aware program would decide
 * because of it, and then stays out of the way.
 *
 * `getColorDepth` is Node's own and reads `COLORTERM` exactly as `supports-color` does, so the
 * second number is the mechanism rather than this repository's opinion of it. It is asked twice
 * — with the environment as it arrived, and with `COLORTERM` taken out of it — which is the
 * before and the after in one process, on one machine, in one run.
 */
function writeEnvStub(file, name) {
  writeFileSync(file, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
const env = { ...process.env };
const without = { ...env };
for (const key of Object.keys(without)) if (key.toUpperCase() === 'COLORTERM') delete without[key];
let depth = null;
let downgraded = null;
try {
  depth = process.stdout.getColorDepth(env);
  downgraded = process.stdout.getColorDepth(without);
} catch { /* no terminal on this stream, which the pipe case is about */ }
writeFileSync(${JSON.stringify(posix(dumpPath(name)))},
  JSON.stringify({ env, depth, downgraded }), 'utf8');
process.stdin.resume();
`, 'utf8');
  return `node "${posix(file)}"`;
}

const shellStub = writeEnvStub(join(workDir, 'stub-shell.mjs'), 'shell-pty');
const pipeShellStub = writeEnvStub(join(workDir, 'stub-shell-pipe.mjs'), 'shell-pipe');

/**
 * The same stub, run as a rendered agent tab.
 *
 * The renderer is chosen off the *command*, by `streamsUsage`, exactly as the token meter is —
 * so a stub whose command carries the flag is the real path rather than an imitation of it.
 */
const renderedStub = `${writeEnvStub(join(workDir, 'stub-agent.mjs'), 'shell-rendered')} --output-format stream-json`;

// ─── Servers ──────────────────────────────────────────────────

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  the server is built — dist/server.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
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
 * A board that was started without the variable, which is every board.
 *
 * Deleted rather than left alone: an operator's own `COLORTERM` would be inherited and the case
 * would pass without the board having done anything, which is the shape of a check that proves
 * nothing.
 */
function startCanvas(port, env = {}) {
  const child = spawnCanvas({
    port,
    env: {
      ...unset(MARKER),
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
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
const RENDERED_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const PIPE_BASE = `http://127.0.0.1:${PIPE_PORT}`;
const RENDERED_BASE = `http://127.0.0.1:${RENDERED_PORT}`;

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  console.log('1. a shell on a pseudoterminal is told what the emulator can really draw');
  const server = startCanvas(PORT, { EXCALIDRAW_TERMINAL: shellStub });
  await waitForHealth(BASE, server);

  const opened = await call(BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', opened.status === 202, `got ${opened.status} ${JSON.stringify(opened.body)}`);
  const mode = opened.body?.session?.mode ?? 'unknown';
  console.log(`  (the session came up in "${mode}" mode)`);

  if (mode !== 'pty') {
    console.log('  (no pseudoterminal on this machine, so there is no terminal to describe — skipped)');
  } else if (await waitFor(() => existsSync(dumpPath('shell-pty')), 'the shell to report its environment')) {
    const report = readDump('shell-pty');
    const marker = lookup(report.env, MARKER);
    console.log(`     COLORTERM=${JSON.stringify(marker)}, colour depth ${report.depth} `
      + `(${report.downgraded} without it)`);
    check('the child is told the terminal is a 24-bit one',
      PROMOTED.includes(String(marker).toLowerCase()),
      `${MARKER}=${JSON.stringify(marker)} — on TERM alone a program stops at 256`);
    check('TERM still names the terminal as well', lookup(report.env, 'TERM') === 'xterm-256color',
      String(lookup(report.env, 'TERM')));
    // The mechanism, not an imitation of it: this is Node's own reading of the same variable.
    check('and a program that asks Node comes out at 24-bit',
      report.depth === 24, `${report.depth}-bit`);
    // Where the variable is load-bearing is where `TERM` is all a program has, which is every
    // POSIX board and every WSL workspace on a Windows one. Windows itself answers 24-bit from
    // the platform — Node and `supports-color` both special-case a modern console — so on this
    // machine the promotion is invisible to the measurement and is still the true statement.
    if (report.downgraded === report.depth) {
      console.log(`  (this platform answers ${report.depth}-bit on its own, so nothing here turns `
        + 'on the variable — it is what a child with only TERM to go on reads, which is the WSL '
        + 'side of this board and every POSIX one)');
    } else {
      check('and taking it away drops the answer back, which is the promotion',
        report.downgraded !== null && report.downgraded < report.depth,
        `${report.downgraded}-bit without COLORTERM against ${report.depth}-bit with it`);
    }
  }
  await call(BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n2. and a tab the board renders itself is not, because it is not an emulator');
  //
  // The half that keeps this from costing colour. A rendered transcript is drawn as a document
  // and a document can resolve the sixteen by name; `38;2;r;g;b` has no name and lands on the
  // default ink. Telling that child it has 24 bits would trade sixteen resolvable slots for one
  // literal — see `docs/terminal.md`.
  const rendered = startCanvas(RENDERED_PORT, { EXCALIDRAW_TERMINAL: renderedStub });
  await waitForHealth(RENDERED_BASE, rendered);

  const renderedOpen = await call(RENDERED_BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', renderedOpen.status === 202,
    `got ${renderedOpen.status} ${JSON.stringify(renderedOpen.body)}`);
  if (renderedOpen.body?.session?.mode !== 'pty') {
    console.log('  (no pseudoterminal on this machine — skipped)');
  } else if (await waitFor(() => existsSync(dumpPath('shell-rendered')),
    'the rendered agent to report its environment')) {
    const report = readDump('shell-rendered');
    const marker = lookup(report.env, MARKER);
    console.log(`     COLORTERM=${JSON.stringify(marker)}, colour depth ${report.depth}`);
    check('the rendered agent is not promoted', marker === undefined,
      `${MARKER}=${JSON.stringify(marker)} — its transcript is a document, and a literal colour `
      + 'has no slot name for the document to resolve');
    check('and it is still given the rest of the terminal',
      lookup(report.env, 'TERM') === 'xterm-256color', String(lookup(report.env, 'TERM')));
  }
  await call(RENDERED_BASE, '/api/terminal', { method: 'DELETE' });

  console.log('\n3. and the pipe path says nothing, because there is no terminal there');
  const pipeServer = startCanvas(PIPE_PORT, {
    EXCALIDRAW_TERMINAL: pipeShellStub,
    EXCALIDRAW_TERMINAL_PTY: '0',
  });
  await waitForHealth(PIPE_BASE, pipeServer);

  const pipeOpened = await call(PIPE_BASE, '/api/terminal', { method: 'POST' });
  check('a session opened', pipeOpened.status === 202,
    `got ${pipeOpened.status} ${JSON.stringify(pipeOpened.body)}`);
  check('and it is the pipe one', pipeOpened.body?.session?.mode === 'pipe',
    `mode ${pipeOpened.body?.session?.mode}`);
  if (await waitFor(() => existsSync(dumpPath('shell-pipe')), 'the shell to report its environment')) {
    const report = readDump('shell-pipe');
    const marker = lookup(report.env, MARKER);
    check('a child on pipes is told nothing about a terminal it does not have',
      marker === undefined, `${MARKER}=${JSON.stringify(marker)}`);
  }
  await call(PIPE_BASE, '/api/terminal', { method: 'DELETE' });
} catch (error) {
  failures++;
  console.error(`\n  FAIL  the check ran to the end — ${error.message}`);
} finally {
  stopAll();
  await sleep(200);
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
