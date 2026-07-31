#!/usr/bin/env node
/**
 * Checks that the canvas no longer defaults to a port it cannot have, and that a conflict is
 * something the caller is told about rather than something it waits out.
 *
 * The old shape was three separate defaults agreeing on the wrong number — `PORT || '3000'` in
 * the server, `http://127.0.0.1:<that>` in the configuration, and the same again as
 * `canvasPort()`'s fallback — and no free-port search anywhere. So the first-time case, a
 * machine where a tutorial server already holds that port, went: auto-start spawns a server
 * with `stdio: 'ignore'`, the server logs `EADDRINUSE` into a platform log file nobody knows
 * exists, exits, and eight seconds later the caller is told the server "did not become healthy
 * within 8000ms" — a sentence naming neither the port nor the thing holding it. On the machine
 * this fork is developed on that port cannot work at all (`docs/trap-port-3000.md`).
 *
 * The four rules, which are the issue's four:
 *
 *   1. with the preferred port occupied, the launch path brings the board up somewhere else and
 *      prints that URL;
 *   2. the state file beside the pidfile names the port, pid and URL, and `status` finds the
 *      board through it with nothing in the environment;
 *   3. an explicit `PORT` is a hard override that never scans — Docker and scripted starts stay
 *      deterministic — and the caller is told which port it is and that something else holds it;
 *   4. no source file outside a documented default still carries the old number as a port.
 *
 * And the fifth thing, which is what made the failure unreadable: a server that dies during
 * startup is relayed with what it said, instead of being waited out for the full timeout.
 *
 * The preferred port is taken from `EXCALIDRAW_CANVAS_PORT` rather than being the compiled-in
 * default, so this check occupies a port the kernel just handed out instead of whatever number
 * the project ships — occupying the real default would fight the board on the development
 * machine, and the rule under test is "the preferred port", not one integer.
 *
 * Self-contained: it holds a few loopback sockets, drives `dist/bin.js` with an environment it
 * builds itself, and points the state directory at a throwaway one, so nothing here can find or
 * disturb a board somebody is looking at. No browser, no network. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-port-autoselect.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, repoRoot } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The number this whole change is about, assembled so that this file is not itself a hit of the
 * scan it runs, and so the scan needs no exemption for the file that holds it.
 */
const OLD_DEFAULT = Number(['30', '00'].join(''));
/** The CLI's canvas-URL variable. Named in pieces for the same reason. */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

const workDir = join(tmpdir(), `port-autoselect-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const stateHome = join(workDir, 'state');

// Before any compiled module is imported: this process reads `canvasPort()` back, and a
// variable exported months ago (or an `.env` beside the repository root) would answer for it.
delete process.env[URL_VARIABLE];
delete process.env.PORT;
process.env.EXCALIDRAW_NO_DOTENV = '1';
process.env.EXCALIDRAW_STATE_HOME = stateHome;

const held = [];

/**
 * A listener that accepts and then says nothing: an unrelated service, not a canvas.
 *
 * Unref'd, and its connections are dropped rather than waited for at the end — the launch path
 * probes what is on the port by asking it for `/health`, and a socket this never answers is a
 * socket `server.close()` would wait on until the heat death of the run.
 */
function occupy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sockets = [];
    const server = createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); });
    server.unref();
    server.on('error', () => resolve(null));
    server.listen(port, host, () => { held.push({ server, sockets }); resolve(server); });
  });
}

function cli(args, extraEnv = {}) {
  const env = canvasEnvironment({ EXCALIDRAW_STATE_HOME: stateHome, ...extraEnv });
  delete env[URL_VARIABLE];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'bin.js'), ...args], {
      // The repository root, the way `startCanvas` does it. The `.env` that lives there is off
      // through `EXCALIDRAW_NO_DOTENV`, which the spawned server inherits — and a throwaway
      // working directory would be held open by that server on Windows, so the cleanup below
      // could not remove it.
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function healthOf(url) {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** The compiled module the whole resolution lives in. Absent on the old tree, which is the point. */
let port = null;
let portError = '';
try {
  port = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'port.js')).href);
} catch (error) {
  portError = String(error?.message ?? error);
}

let spawnModule = null;
try {
  spawnModule = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'spawn.js')).href);
} catch (error) {
  portError ||= String(error?.message ?? error);
}

const startedBoards = [];

try {
  // ─── 1. The default is a port somebody could actually have ────

  console.log('\n1. the compiled-in default is not the one that cannot work');

  check('src/core/port.ts exists and exports a default canvas port',
        typeof port?.DEFAULT_CANVAS_PORT === 'number',
        portError || `exports were ${port ? Object.keys(port).join(', ') : 'nothing'}`);
  check(`the default canvas port is not ${OLD_DEFAULT}`,
        port?.DEFAULT_CANVAS_PORT !== OLD_DEFAULT && port?.DEFAULT_CANVAS_PORT !== undefined,
        `it is ${port?.DEFAULT_CANVAS_PORT}`);
  check('canvasPort() falls back to that same default, with nothing in the environment',
        typeof spawnModule?.canvasPort === 'function'
        && spawnModule.canvasPort() === port?.DEFAULT_CANVAS_PORT,
        `canvasPort() said ${spawnModule?.canvasPort?.()}, the default is ${port?.DEFAULT_CANVAS_PORT}`);

  // The source scan the fourth done-when asks for. Comments are stripped first: an account of
  // the trap is history and has to be allowed to name the number it is about — what may not
  // survive is a line of code that still uses it as a port.
  const strip = (source) => {
    let out = '';
    let mode = 'code';
    for (let i = 0; i < source.length; i++) {
      const here = source[i];
      const next = source[i + 1];
      if (mode === 'code') {
        if (here === '/' && next === '*') { mode = 'block'; i++; continue; }
        if (here === '/' && next === '/') { mode = 'line'; i++; continue; }
        out += here;
      } else if (mode === 'block') {
        if (here === '*' && next === '/') { mode = 'code'; i++; }
        else if (here === '\n') out += here;
      } else if (here === '\n') { mode = 'code'; out += here; }
    }
    return out;
  };

  const sourceFiles = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) sourceFiles.push(full);
    }
  })(join(repoRoot, 'src'));

  // `3000` on a line that also talks about a port or a loopback address. A millisecond literal
  // does neither, which is what keeps `setTimeout(..., 3000)` and an identity TTL out of this.
  const asPort = new RegExp(`(?:(?:127\\.0\\.0\\.1|localhost)\\s*:\\s*${OLD_DEFAULT}\\b)`
                            + `|(?:\\bport\\b[^\\n]*\\b${OLD_DEFAULT}\\b)`
                            + `|(?:\\b${OLD_DEFAULT}\\b[^\\n]*\\bport\\b)`, 'i');
  const stillDefaulting = [];
  for (const file of sourceFiles) {
    strip(readFileSync(file, 'utf8')).split(/\r?\n/).forEach((line, index) => {
      if (asPort.test(line)) {
        stillDefaulting.push(`${relative(repoRoot, file).replace(/\\/g, '/')}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  check(`no source file uses ${OLD_DEFAULT} as a canvas port`, stillDefaulting.length === 0,
        stillDefaulting.join('\n      '));

  // ─── 2. A preferred port somebody else is already on ──────────

  console.log('\n2. the preferred port is taken, so the board comes up elsewhere');

  const preferred = await freePort();
  const blocker = await occupy(preferred);
  check('the check is holding the preferred port itself', blocker !== null,
        `could not bind ${preferred}`);

  const started = await cli(['start'], { EXCALIDRAW_CANVAS_PORT: String(preferred) });
  const startJson = parseJson(started.out);
  if (typeof startJson?.pid === 'number') startedBoards.push(startJson.pid);
  check('`start` succeeds with the preferred port occupied', started.code === 0,
        `exit ${started.code}\n      ${started.err.trim().split('\n').slice(-6).join('\n      ')}`);
  check('and prints a URL', typeof startJson?.url === 'string', started.out.trim());

  const boardUrl = typeof startJson?.url === 'string' ? startJson.url : null;
  const boardPort = boardUrl ? Number(new URL(boardUrl).port) : null;
  check('the URL it printed is not the occupied one', boardPort !== null && boardPort !== preferred,
        `it said ${boardUrl}`);
  // Not merely "somewhere else": somewhere else *reached by walking up from the preference*.
  // A build that ignored the preference outright and used its own default would satisfy the
  // line above without having scanned anything, which is the way this case could pass for the
  // wrong reason — and did, on the tree it was written against.
  check('and it got there by walking up from the preferred port',
        boardPort !== null && boardPort > preferred && boardPort - preferred < 64,
        `preferred ${preferred}, came up on ${boardPort}`);

  const health = boardUrl ? await healthOf(boardUrl) : null;
  if (health?.pid) startedBoards.push(health.pid);
  check('and a canvas of ours is answering there', health !== null && typeof health.service === 'string',
        `no /health at ${boardUrl}`);

  // ─── 3. The state file, and a status with nothing to go on ────

  console.log('\n3. the state file is what a later command finds it by');

  const statePath = typeof port?.canvasStatePath === 'function' ? port.canvasStatePath() : null;
  check('the state file sits in the pidfile directory', statePath !== null && existsSync(statePath),
        statePath ? `${statePath} is not there` : 'src/core/port.ts exports no canvasStatePath()');

  const state = statePath && existsSync(statePath) ? parseJson(readFileSync(statePath, 'utf8')) : null;
  check('it names the port', state?.port === boardPort, JSON.stringify(state));
  check('it names the URL', state?.url === boardUrl, JSON.stringify(state));
  check('it names the pid the board reports about itself',
        state?.pid === health?.pid, `${state?.pid} vs ${health?.pid}`);

  // Nothing in this environment says where the board is: no preferred port, no URL, no PORT.
  // The state file is the only thing left that could answer, which is the point of the case.
  const status = await cli(['status']);
  const statusJson = parseJson(status.out);
  check('`status` finds the board with nothing in the environment', status.code === 0,
        `exit ${status.code}\n      ${status.err.trim().split('\n').slice(-6).join('\n      ')}`);
  check('and reports the scanned URL rather than the default',
        statusJson?.running === true && statusJson?.url === boardUrl,
        JSON.stringify(statusJson));

  // Only ever aimed at the board this run started. If the resolution above found something
  // else, `stop` with the same empty environment would find that same something else — and on
  // the development machine the something else is the board the maintainer is looking at.
  if (boardUrl === null || statusJson?.url !== boardUrl) {
    check('`stop` finds the same board and stops it', false,
          'status did not name the board this run started, so stop was not run at all');
  } else {
    const stopped = await cli(['stop']);
    const stoppedJson = parseJson(stopped.out);
    check('`stop` finds the same board and stops it',
          stopped.code === 0 && stoppedJson?.stopped === true, `exit ${stopped.code} ${stopped.out.trim()}`);
    if (stoppedJson?.stopped === true) startedBoards.length = 0;
    await sleep(300);
    check('and the state file does not outlive the board it described',
          statePath === null || !existsSync(statePath), `${statePath} is still there`);
  }

  // ─── 4. An explicit PORT is a hard override ───────────────────

  console.log('\n4. an explicit PORT never scans, and says what is on it');

  const pinned = await freePort();
  const pinnedBlocker = await occupy(pinned);
  check('the check is holding the pinned port itself', pinnedBlocker !== null, `could not bind ${pinned}`);

  const clash = await cli(['start'], { PORT: String(pinned) });
  const clashJson = parseJson(clash.out);
  if (typeof clashJson?.pid === 'number') startedBoards.push(clashJson.pid);
  check('`start` fails rather than moving to another port', clash.code !== 0,
        `exit ${clash.code} ${clash.out.trim()}`);
  check('and the message names the port', clash.err.includes(String(pinned)),
        clash.err.trim().split('\n').slice(-6).join('\n      '));
  check('and says something else is holding it',
        /already|in use|listening|occupied|holds/i.test(clash.err),
        clash.err.trim().split('\n').slice(-6).join('\n      '));
  check('nothing was started anywhere, so nothing scanned',
        statePath === null || !existsSync(statePath),
        'a state file appeared, so the pinned port was not treated as final');

  // ─── 5. A server that dies is relayed, not waited out ─────────

  console.log('\n5. a server that fails to start is relayed with what it said');

  // Free on IPv4, taken on IPv6. The launch path probes the address it is about to use and
  // finds nothing; the server's own loopback guard looks at both and refuses. So this is the
  // shape the relay exists for: a startup failure the caller cannot see coming.
  const guarded = await freePort();
  const sixListener = await occupy(guarded, '::1');
  if (sixListener === null) {
    console.log('  skip  no IPv6 loopback on this machine, so the guard cannot be provoked');
  } else {
    const began = Date.now();
    const died = await cli(['start'], { PORT: String(guarded) });
    const elapsed = Date.now() - began;
    const diedJson = parseJson(died.out);
    if (typeof diedJson?.pid === 'number') startedBoards.push(diedJson.pid);
    check('`start` fails', died.code !== 0, `exit ${died.code} ${died.out.trim()}`);
    check('promptly, rather than waiting out the health timeout', elapsed < 7000, `${elapsed}ms`);
    check('and the caller is told what the server itself said',
          /refusing to start/i.test(died.err),
          died.err.trim().split('\n').slice(-8).join('\n      '));
  }
} finally {
  for (const pid of startedBoards) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  for (const { server, sockets } of held) {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  await sleep(200);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows still holds it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
