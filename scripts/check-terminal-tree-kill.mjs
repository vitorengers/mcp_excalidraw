#!/usr/bin/env node
/**
 * Checks that closing a piped session takes down what the shell was running, not just the shell.
 *
 * `close()` killed the tree on Windows — `taskkill /PID … /T /F` — and everywhere else called
 * `child.kill()`, which signals the direct child and nothing it started. The piped child was
 * spawned without `detached`, so it sat in the server's own process group and there was no
 * group to signal instead. Pipes are not the exotic case: a session opened with `options.input`
 * drops the PTY binding deliberately, which is every non-interactive agent run, and a machine
 * with no prebuilt `@lydell/node-pty` binary gets pipes for everything. `docs/terminal.md`
 * promises that closing a session takes the tree with it; on macOS and Linux, closing a tab
 * running `npm run build`, a dev server or a `claude` run left the command orphaned and still
 * holding its port.
 *
 * ## What each platform can honestly answer
 *
 * The interesting half of this is POSIX-only, and the machine this repository is maintained on
 * reports `win32`. So the cases are split by what a kernel can actually be asked:
 *
 * - **Section 1 runs everywhere** and is the case the issue is about — on Windows it is the
 *   `taskkill /T` path it always was, and on macOS and Linux it is the new group kill. Run it
 *   under WSL to see the POSIX half: it is red there against the old code.
 * - **Section 4 needs a `taskkill` that can be stood in for**, which means a POSIX box: Node
 *   refuses to run a `.cmd` without a shell, so a fake cannot be put on `PATH` on Windows. It
 *   stubs `process.platform` to `win32` and asserts the order — `taskkill` first, with the
 *   arguments it always had, and an early return that leaves everything else untried.
 * - **Section 5 needs a machine with no process groups**, which means Windows: `process.kill`
 *   with a negative pid throws `ESRCH` there and kills nothing, so it is the one place the
 *   fallback the issue asks for can be made to happen.
 *
 * Each case that stubs the platform runs in a child process which redefines `process.platform`
 * **before** importing the compiled module, and reports the platform it ended up with, so a stub
 * that failed to take shows up as a failure rather than as a green run of the wrong branch.
 *
 * The grandchild is found by the port it listens on rather than by its pid: a pid probe asks the
 * kernel about a process nobody holds a handle to any more, and the two platforms disagree about
 * what that means. A listening socket is released when its process dies, on both.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas server on a free port
 * and kills it. No browser, no network, nothing that talks to GitHub.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal-tree-kill.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-session.js')).href;
const isWindows = process.platform === 'win32';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A path a command line can carry on either platform. */
const posix = (value) => value.replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `terminal-tree-kill-check-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Tree Kill Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'tree-kill-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: posix(projectDir) }],
}), 'utf8');

/**
 * What the session is running: a command that starts something and stays up while it runs.
 *
 * The grandchild is spawned plainly — not `detached` — because that is what a shell running
 * `npm run build` does, and it is the whole question: it inherits the shell's process group,
 * so a signal aimed at the group reaches it and a signal aimed at the shell alone does not.
 */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [pidFile, port] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
spawn(process.execPath, [join(here, 'stub-grandchild.mjs'), pidFile, port], { stdio: 'ignore' });
process.stdout.write('SHELL-UP ' + process.pid + '\\n');
// Nothing to read and nothing more to say: the session is closed from the outside.
setInterval(() => {}, 1000);
`, 'utf8');

/**
 * The command inside the shell: it announces itself by listening, and it never exits on its own.
 *
 * The pid file says *who* it was, for a failure message; the socket is what says whether it is
 * still there. The hour-long safety net is so that a check which fails cannot leave a process
 * behind for the rest of the machine's day.
 */
writeFileSync(join(workDir, 'stub-grandchild.mjs'), `#!/usr/bin/env node
import { createServer } from 'node:net';
import { writeFileSync } from 'node:fs';

const [pidFile, port] = process.argv.slice(2);
const server = createServer(() => {});
server.listen(Number(port), '127.0.0.1', () => {
  writeFileSync(pidFile, String(process.pid), 'utf8');
});
setTimeout(() => process.exit(0), 120_000);
`, 'utf8');

/**
 * A shell for the prompt cases: it says what it was handed and when the handing stopped.
 *
 * `detached: true` gives the child a session of its own on POSIX, and detaching is exactly the
 * kind of change that can quietly cost a process its stdin. So this reads the prompt back out
 * and reports the end of file separately from the prompt itself — the two are what
 * `options.input` and `stdin.end()` are for, and either could break without the other.
 */
const promptShell = join(workDir, 'stub-prompt-shell.mjs');
writeFileSync(promptShell, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => process.stdout.write('SAW[' + chunk.trim() + ']\\n'));
process.stdin.on('end', () => {
  process.stdout.write('EOF-SEEN\\n');
  process.exit(0);
});
`, 'utf8');

const shellCommandFor = (script, ...args) =>
  [`node "${posix(script)}"`, ...args.map((one) => `"${posix(String(one))}"`)].join(' ');

// ─── Asking the compiled module, on a platform of our choosing ─

/**
 * Run `source` in a child that has already decided what platform it is on.
 *
 * `canvasEnvironment` rather than `process.env`: the module pulls in `config.js`, which reads
 * the `.env` beside the working directory, and this machine's session carries `EXCALIDRAW_*`
 * of its own — either would decide answers this check thinks it is asserting.
 */
function ask({ platform, source, env = {}, timeout = 30_000 }) {
  const stub = platform
    ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)}, configurable: true });`
    : '';
  const program = `
    ${stub}
    const report = (extra) => process.stdout.write('<<' + JSON.stringify({ platform: process.platform, ...extra }) + '>>');
    const { TerminalSession } = await import(${JSON.stringify(moduleUrl)});
    const workspace = {
      id: ${JSON.stringify(WORKSPACE)},
      path: ${JSON.stringify(posix(projectDir))},
      innerPath: ${JSON.stringify(posix(projectDir))},
      environment: { kind: 'native' },
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    ${source}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
    encoding: 'utf8',
    timeout,
    env: canvasEnvironment({ LOG_LEVEL: 'error', ...env }),
  });
  const printed = /<<(\{.*\})>>/s.exec(result.stdout ?? '');
  if (!printed) {
    throw new Error(`the child reported nothing: status ${result.status}, ${result.stderr || result.error}`);
  }
  const answer = JSON.parse(printed[1]);
  if (platform && answer.platform !== platform) {
    throw new Error(`the platform stub did not take: asked for ${platform}, the child reported ${answer.platform}`);
  }
  return answer;
}

// ─── Is it still there? ───────────────────────────────────────

/** Whether something is listening on the port the grandchild took. */
function listening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port, timeout: 1000 });
    const settle = (answer) => { socket.destroy(); resolve(answer); };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    socket.once('timeout', () => settle(false));
  });
}

async function waitFor(predicate, what, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  console.error(`  ...  gave up waiting for ${what}`);
  return false;
}

// ─── The canvas ───────────────────────────────────────────────

const PORT = await freePort();
const GRANDCHILD_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const pidFile = join(workDir, 'grandchild.pid');

const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: shellCommandFor(stubShell, pidFile, GRANDCHILD_PORT),
    // The pipe is the subject, and a machine that has a binding would otherwise hand this
    // session a pseudoterminal and answer a different question.
    EXCALIDRAW_TERMINAL_PTY: '0',
  },
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`the canvas server exited early:\n${server.read()}`);
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${server.read()}`);
}

/** One request, with two more goes at the socket, which this machine sometimes refuses. */
async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}${glue}workspace=${WORKSPACE}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

try {
  await waitForHealth();

  // ─── 1. Closing a piped session takes the tree ──────────────
  console.log('1. a piped session takes what it was running with it');

  const opened = await call('/api/terminal', { method: 'POST', body: JSON.stringify({}) });
  check('the session opens', opened.status === 202, `${opened.status} ${JSON.stringify(opened.body)}`);
  const session = opened.body?.session;
  check('and it is a piped one, which is what this is about', session?.mode === 'pipe', session?.mode);

  const started = await waitFor(() => listening(GRANDCHILD_PORT), 'the grandchild to start listening');
  check('the shell started a grandchild of its own', started,
        existsSync(pidFile) ? `pid ${readFileSync(pidFile, 'utf8')}` : 'no pid file was written');

  const closed = await call('/api/terminal', {
    method: 'DELETE',
    body: JSON.stringify({ sessionId: session?.id }),
  });
  check('the session closes', closed.status === 200, `${closed.status} ${JSON.stringify(closed.body)}`);

  // The one the issue exists for. Six seconds is well past the grace the group kill waits
  // through, so a grandchild still holding its port here is one nobody is going to stop.
  const gone = await waitFor(async () => !(await listening(GRANDCHILD_PORT)),
                             'the grandchild to go', 60);
  check('and the grandchild is gone with it', gone,
        `something is still listening on ${GRANDCHILD_PORT}`
        + (existsSync(pidFile) ? `, and the grandchild reported pid ${readFileSync(pidFile, 'utf8')}` : ''));
  console.log(`  (that ran on ${process.platform}: `
    + `${isWindows ? 'the taskkill /T path' : 'the POSIX process-group path'})`);

  // ─── 2. The prompt still reaches a detached child ───────────
  //
  // A group of its own is a new session on POSIX, and detaching is the kind of change that
  // quietly costs a child its stdin. `options.input` is written to that stdin and then ended,
  // and every non-interactive agent run is exactly this shape.
  console.log('\n2. and a piped session still gets its prompt, and still sees the end of it');
  const prompted = ask({
    platform: null,
    source: `
      let transcript = '';
      let code = 'never exited';
      const done = new Promise((resolve) => {
        const session = new TerminalSession('prompt', workspace, ${JSON.stringify(shellCommandFor(promptShell))}, {
          onOutput: (data) => { transcript += data; },
          onExit: (exitCode) => { code = exitCode; resolve(session); },
        }, null, { input: 'THE-PROMPT' });
        globalThis.session = session;
      });
      const settled = await Promise.race([done, sleep(15_000)]);
      const session = globalThis.session;
      // Idempotence, on a session whose child is already gone: a second close after the shell
      // has exited on its own must be silent rather than throwing out of the route.
      let threw = null;
      try { session.close(); session.close(); } catch (error) { threw = String(error && error.message); }
      report({ transcript, code, mode: session.mode, readOnly: session.readOnly, threw, settled: Boolean(settled) });
    `,
  });
  check('the session is a piped, read-only one, as a prompted session always was',
        prompted.mode === 'pipe' && prompted.readOnly === true,
        `${prompted.mode}, readOnly ${prompted.readOnly}`);
  check('the prompt written to stdin reached the shell',
        prompted.transcript.includes('SAW[THE-PROMPT]'), JSON.stringify(prompted.transcript));
  check('and so did the end of file that follows it',
        prompted.transcript.includes('EOF-SEEN'), JSON.stringify(prompted.transcript));
  check('so the shell exited of its own accord', prompted.code === 0, String(prompted.code));

  // ─── 3. Closing twice is not an error ───────────────────────
  console.log('\n3. close() is idempotent, on a live session and on a dead one');
  check('a close after the child has already gone throws nothing',
        prompted.threw === null, String(prompted.threw));

  const twice = ask({
    platform: null,
    source: `
      let code = 'never exited';
      const exited = new Promise((resolve) => {
        globalThis.session = new TerminalSession('twice', workspace,
          ${JSON.stringify(shellCommandFor(stubShell, join(workDir, 'twice.pid'), await freePort()))}, {
          onOutput: () => {},
          onExit: (exitCode) => { code = exitCode; resolve(); },
        }, null, {});
      });
      const session = globalThis.session;
      await session.started;
      await sleep(300);
      let threw = null;
      try { session.close(); session.close(); } catch (error) { threw = String(error && error.message); }
      await Promise.race([exited, sleep(8_000)]);
      report({ threw, alive: session.alive, code });
    `,
  });
  check('two closes on a running session throw nothing', twice.threw === null, String(twice.threw));
  check('and the shell is gone after them', twice.alive === false, `alive ${twice.alive}`);

  // ─── 4. Windows still reaches for taskkill first ────────────
  console.log('\n4. on win32, taskkill /T is still the first thing tried and it still returns early');
  if (isWindows) {
    console.log('  (this machine reports win32, and Node will not run a `.cmd` without a shell, so');
    console.log('   a stand-in for taskkill cannot be put on PATH here — section 1 above *is* the');
    console.log('   taskkill path on this machine, and the ordering is asserted on a POSIX box)');
  } else {
    const binDir = join(workDir, 'fake-bin');
    mkdirSync(binDir, { recursive: true });
    const record = join(workDir, 'taskkill-argv.txt');
    writeFileSync(join(binDir, 'taskkill'), `#!/bin/sh\nprintf '%s ' "$@" > ${posix(record)}\nexit 0\n`,
                  { encoding: 'utf8', mode: 0o755 });

    const win = ask({
      platform: 'win32',
      env: { PATH: `${binDir}:${process.env.PATH ?? ''}` },
      source: `
        globalThis.session = new TerminalSession('win', workspace,
          ${JSON.stringify(shellCommandFor(stubShell, join(workDir, 'win.pid'), await freePort()))}, {
          onOutput: () => {}, onExit: () => {},
        }, null, {});
        const session = globalThis.session;
        await session.started;
        await sleep(300);
        const pid = session.pid;
        session.close();
        // Long enough for a group kill's follow-up to have fired, had the branch fallen through.
        await sleep(1500);
        let alive = false;
        try { process.kill(pid, 0); alive = true; } catch {}
        try { process.kill(pid, 'SIGKILL'); } catch {}
        report({ pid, alive });
      `,
    });
    const argv = existsSync(record) ? readFileSync(record, 'utf8').trim() : '';
    check('taskkill was the first thing close() reached for', argv !== '', '(it was never called)');
    check('with the arguments it always had',
          argv === `/PID ${win.pid} /T /F`, `${JSON.stringify(argv)} for pid ${win.pid}`);
    check('and a taskkill that succeeded ended close(): nothing else was tried',
          win.alive === true, 'the shell was killed by something after taskkill returned 0');
  }

  // ─── 5. And a machine with no groups falls back ─────────────
  console.log('\n5. where a process group cannot be signalled, close() falls back to the single pid');
  if (!isWindows) {
    console.log('  (this machine has process groups, so the ESRCH fallback cannot be provoked here —');
    console.log('   it is asserted on Windows, where a negative pid always throws)');
  } else {
    const fallback = ask({
      platform: 'linux',
      source: `
        let code = 'never exited';
        const exited = new Promise((resolve) => {
          globalThis.session = new TerminalSession('fallback', workspace,
            ${JSON.stringify(shellCommandFor(stubShell, join(workDir, 'fallback.pid'), await freePort()))}, {
            onOutput: () => {},
            onExit: (exitCode) => { code = exitCode; resolve(); },
          }, null, {});
        });
        const session = globalThis.session;
        await session.started;
        await sleep(300);
        session.close();
        await Promise.race([exited, sleep(8_000)]);
        report({ alive: session.alive, code });
      `,
    });
    check('the shell still dies when the group signal throws', fallback.alive === false,
          `alive ${fallback.alive}`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  the check ran to the end — ${error.message}`);
} finally {
  server.stop();
  // Whatever survived a failed case, rather than leaving it on the machine.
  for (const name of ['grandchild.pid', 'twice.pid', 'win.pid', 'fallback.pid']) {
    const file = join(workDir, name);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, which is the point */ }
    }
  }
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
