#!/usr/bin/env node
/**
 * Checks that a built tree starts a board on this machine, whatever machine it is.
 *
 * Every workflow in this repository ran on Linux and only on Linux. The build-and-type-check job
 * pinned `runs-on: ubuntu-latest`, the publish job packed on Ubuntu, and the Docker jobs are
 * Linux by nature — so nothing here had ever found out whether `npm ci`, `vite build`, `tsc` and
 * a server start succeed on the two operating systems the release promises. #280 grew the matrix
 * to three images; this is the check that makes the two new ones mean something, because a
 * matrix that only compiles proves the TypeScript compiles, which `CLAUDE.md` says is not
 * working.
 *
 * The platform-forked code underneath is not small, and none of it had non-Linux coverage: the
 * state directory branches per platform in `src/core/settings.ts`, the log path in
 * `src/utils/logger.ts`, the PTY binary in `src/core/terminal-session.ts`, and the browser opener
 * #306 added in `src/core/open-browser.ts`. This exercises the first of those by *running* it —
 * it starts a real `dist/server.js` and then goes looking for the files it should have written,
 * where this platform says they go.
 *
 * Four things, in the order a start happens:
 *
 *   - **the build left its artifacts.** `test -f dist/index.js` was a step in `ci.yml` until
 *     #280, dropped there because it could never have run on `windows-latest`. The assertion
 *     was worth keeping and the shell was not, so it lives here, in a script every runner can
 *     execute.
 *   - **the board answers `/health` with the service marker.** Not merely a 200: `service` is
 *     the identity contract `stop` and the auto-start gate read, and a start that binds the port
 *     without carrying it is a start nothing downstream can attach to. `pid` and `platform` are
 *     asserted with it, because a health payload describing some other process on the port is
 *     the failure this is most likely to meet on a shared machine.
 *   - **the pidfile and the state file landed in the platform state directory.** These are what
 *     `stop`, the port resolver and a second launch read; on a platform whose branch is wrong
 *     the board still comes up and every later command loses it. The expected directory is
 *     written out here per platform rather than imported, which is the whole point — a check
 *     that asked the product where it put things would agree with it by construction.
 *   - **and it stops.** The process exits and the port is free again, so a run leaves nothing
 *     listening behind it.
 *
 * **The state directory is redirected by moving the home, never by `STATE_HOME`.** That setting
 * exists and would be simpler, and it would also skip the branch under test: what is being
 * asserted is that `stateHome()` picks `LOCALAPPDATA` on Windows, `~/Library/Application Support`
 * on macOS and `XDG_STATE_HOME` elsewhere. Nothing is written to the operator's real state
 * directory, which on this machine holds the board they are looking at.
 *
 * **Three throwaway roots rather than one**, and that is what makes the assertion mean anything.
 * The first draft pointed all of `HOME`, `USERPROFILE`, `LOCALAPPDATA` and `XDG_STATE_HOME` at
 * a single directory, which is tidy and proves nothing: run against a build with the Windows
 * branch deleted, it stayed green, because every branch led to the same place. A root each, and
 * the two this platform is not supposed to read asserted empty, is the version that goes red.
 *
 * Either directory leaf is accepted — `Excalidraw-Canvas` today, `VibeMaxxing-Canvas` after the
 * rename `src/core/identity.ts` describes. The leaf is that file's subject and has its own
 * checks; this one is about which *parent* the platform chose, and a rule that pinned both would
 * go red on a rename it has no opinion about.
 *
 * Self-contained: a throwaway home and working directory under the system temporary directory, a
 * port the kernel just handed out, and one server that is killed at the end. No fixed port, no
 * browser, no network, no GitHub. Run `npm run build` first — this reads `dist/`.
 *
 * Usage: node scripts/check-smoke-start.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 1. The build left something to start ────────────────────

console.log('1. the build left the artifacts a start needs');

/**
 * The four files a working install is made of: the MCP server, the canvas server, the bin the
 * published commands point at, and the frontend the canvas serves. `run-checks.mjs` already
 * refuses a missing `dist/`, but it refuses on one file — these name what a partial build looks
 * like, which is the shape a build failing halfway through on a new platform would take.
 */
const ARTIFACTS = [
  join('dist', 'index.js'),
  join('dist', 'server.js'),
  join('dist', 'bin.js'),
  join('dist', 'frontend', 'index.html'),
];

for (const artifact of ARTIFACTS) {
  check(`${artifact.replace(/\\/g, '/')} exists`, existsSync(join(repoRoot, artifact)),
        'run `npm run build` — this check reads the build rather than making one');
}

if (failures) {
  console.error('\nnothing to start; stopping here rather than reporting a start failure');
  process.exit(1);
}

// ─── The throwaway world ─────────────────────────────────────

const workDir = join(tmpdir(), `smoke-start-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });

/**
 * Three throwaway roots, not one, and that is the whole discrimination.
 *
 * `stateHome()` reads `LOCALAPPDATA` on Windows, the home directory on macOS and
 * `XDG_STATE_HOME` elsewhere. Pointed at a single directory they are indistinguishable — a
 * build with the Windows branch deleted lands in exactly the same place and the check goes
 * green on code that is not there. Given a root each, only the platform's own answer is inside
 * the directory this asserts, and the other two are asserted empty.
 */
const roots = {
  home: join(workDir, 'home'),
  localAppData: join(workDir, 'localappdata'),
  xdgState: join(workDir, 'xdg-state'),
};
for (const root of Object.values(roots)) mkdirSync(root, { recursive: true });

/** Where this platform puts a state directory, written out here rather than asked for. */
const STATE_PARENT = {
  win32: roots.localAppData,
  darwin: join(roots.home, 'Library', 'Application Support'),
}[process.platform] ?? roots.xdgState;

/** The two this platform must *not* have used. A file in either is the branch going wrong. */
const WRONG_ROOTS = Object.entries(roots)
  .filter(([, root]) => !STATE_PARENT.startsWith(root))
  .map(([name, root]) => ({ name, root }));

/** The directory leaf, before and after the rename `core/identity.ts` stages. Either will do. */
const STATE_LEAVES = process.platform === 'win32'
  ? ['VibeMaxxing-Canvas', 'Excalidraw-Canvas']
  : ['vibemaxxing-canvas', 'excalidraw-canvas'];

/** Both markers, for the same reason: the rename ships acceptance a release before it lands. */
const SERVICE_NAMES = ['vibemaxxing-canvas', 'mcp-excalidraw-canvas'];

const port = await freePort();
const server = startCanvas({
  port,
  // Not `repoRoot`: an installed board runs wherever the user was standing, and a check that
  // started it inside the repository would be reading this tree's own files by accident.
  cwd: workDir,
  env: {
    HOME: roots.home,
    USERPROFILE: roots.home,
    LOCALAPPDATA: roots.localAppData,
    XDG_STATE_HOME: roots.xdgState,
    // The log is the one path deliberately *not* left to the platform here: it has nothing to
    // do with a start succeeding, and a file this check does not read is a file it should not
    // be creating in somebody's home.
    LOG_FILE_PATH: join(workDir, 'board.log'),
    LOG_LEVEL: 'error',
  },
});

/**
 * Whether the child is gone, watched rather than polled.
 *
 * `exitCode` is not the question: a process killed by a signal leaves it null and sets
 * `signalCode` instead, so a wait written on `exitCode` alone times out on a board that stopped
 * exactly as it was asked to — and Windows, where every kill arrives as a signal, is where it
 * would be permanently red.
 */
let exit = null;
server.child.on('exit', (code, signal) => { exit = { code, signal }; });

async function health(attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (exit) return { died: true };
    try {
      const response = await fetch(`${server.base}/health`);
      if (response.ok) {
        const body = await response.json();
        // The marker is what is being waited for, not the 200: a board still wiring itself up
        // is not a board `stop` or a second launch can attach to.
        if (SERVICE_NAMES.includes(body?.service)) return { body };
      }
    } catch { /* not listening yet */ }
    await sleep(100);
  }
  return { timedOut: true };
}

/** A port nobody is listening on any more. Resolves false while the board still holds it. */
function bindable(target) {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once('error', () => resolve(false));
    socket.listen(target, '127.0.0.1', () => socket.close(() => resolve(true)));
  });
}

try {
  // ─── 2. It comes up, and says what it is ───────────────────

  console.log('\n2. the board comes up on a port the kernel handed out');

  const { body, died, timedOut } = await health();

  check('the server is still running', !died,
        died ? `it exited ${JSON.stringify(exit)}:\n${server.read()}` : '');
  check('/health carries the service marker within the timeout', Boolean(body),
        timedOut ? `no marker in 30s on ${server.base}:\n${server.read()}` : '');

  if (!body) throw new Error('the board never came up');

  check('/health reports healthy', body.status === 'healthy', JSON.stringify(body.status));
  check('/health reports the pid of the process this check started',
        body.pid === server.child.pid, `${body.pid} answered; ${server.child.pid} was started`);
  check('/health reports the platform it is running on',
        body.platform === process.platform, `${body.platform} on a ${process.platform} host`);

  // ─── 3. The files landed where this platform puts them ─────

  console.log('\n3. the pidfile and the state file are in the platform state directory');

  const leaf = STATE_LEAVES.find((name) => existsSync(join(STATE_PARENT, name)));
  check(`a state directory was made under the ${process.platform} root`
        + ` (${STATE_PARENT.slice(workDir.length + 1).replace(/\\/g, '/')})`,
        Boolean(leaf),
        `neither ${STATE_LEAVES.join(' nor ')} is there — the platform branch in `
        + 'core/settings.ts chose somewhere else, and stop() will look here');

  const stateDir = leaf ? join(STATE_PARENT, leaf) : null;

  const pidFile = stateDir ? join(stateDir, `server-${port}.pid`) : null;
  const pidWritten = pidFile && existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : null;
  check(`server-${port}.pid is there and holds the running pid`,
        pidWritten === String(server.child.pid),
        `${pidFile ?? 'no state directory'} → ${pidWritten ?? 'missing'}`);

  const stateFile = stateDir ? join(stateDir, 'canvas.json') : null;
  let state = null;
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* missing or unreadable */ }
  check('canvas.json is there and describes this board',
        state?.port === port && state?.pid === server.child.pid
        && typeof state?.url === 'string' && state.url.includes(String(port)),
        `${stateFile ?? 'no state directory'} → ${JSON.stringify(state)}`);

  for (const { name, root } of WRONG_ROOTS) {
    check(`nothing landed under the ${name} root, which this platform does not read`,
          readdirSync(root).length === 0,
          `${readdirSync(root).join(', ')} — the branch that chose it is the wrong one, and `
          + 'every later command will look somewhere else');
  }

  // ─── 4. And it stops ───────────────────────────────────────

  console.log('\n4. and it stops, leaving nothing on the port');

  server.stop();
  for (let attempt = 0; attempt < 100 && !exit; attempt++) await sleep(100);
  check('the process exits when it is killed', Boolean(exit),
        'still running 10s after SIGTERM');

  let released = false;
  for (let attempt = 0; attempt < 50 && !released; attempt++) {
    released = await bindable(port);
    if (!released) await sleep(100);
  }
  check(`port ${port} is free again`, released, 'something is still listening on it');
} finally {
  server.stop();
  // Retried and then forgiven, because Windows holds a directory open for a moment after the
  // process whose working directory it was has gone: the first attempt is EPERM on the
  // directory itself. A temporary directory that outlives the run is untidy; a run that reports
  // failure because it could not delete one would be wrong about the thing it was measuring.
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    console.warn(`  note  ${workDir} is still there — ${error.code ?? error.message}`);
  }
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
