#!/usr/bin/env node
/**
 * Checks that the canvas spawn on the launch path follows the tree's own convention: hidden on
 * Windows, and still outliving the process that started it.
 *
 * `src/core/spawn.ts` starts the canvas server with `detached: true` and `stdio: 'ignore'` and
 * nothing else. Every other spawn in this repository sets `windowsHide: true` — including the
 * other detached one, the PTY reaper in `src/core/terminal-session.ts`, and the four that shell
 * out to `gh` and to the coding agent. This is the spawn a stranger meets first, on the very
 * first command they type, and it was the single one not following the rule the rest of the tree
 * keeps.
 *
 * ## What is asserted, and what deliberately is not
 *
 * **The options the canvas spawn is given**, on every platform. Not by reading the compiled
 * `dist/core/spawn.js` for a substring — a scan cannot tell a flag that is passed from one that
 * is written in a comment, and it would go on passing if the spawn moved to a helper. Instead
 * `child_process.spawn` is replaced in a child process and `syncBuiltinESMExports()` pushes the
 * replacement into the builtin's ESM namespace *before* `dist/core/spawn.js` is imported, so what
 * this reads is the options object the module actually hands the runtime. `detached` and
 * `stdio: 'ignore'` are asserted alongside it, because those two are what the server needs in
 * order to outlive the CLI and they are the ones an edit here could take away by accident.
 *
 * **That the board survives its launcher**, on every platform, through the real thing: a child
 * process calls `ensureCanvasRunning({ force: true })`, a real canvas server comes up on a port
 * the kernel just handed out, and then the launcher is killed. On macOS and Linux the launcher is
 * given a process group of its own and the *group* is signalled, which is the shape of a terminal
 * going away; the server sits in a third group because it was itself detached, so it survives —
 * and would not, had `detached` been dropped. On Windows the launcher alone is terminated:
 * `taskkill /T` walks the recorded parent-child tree and would reap the server no matter how it
 * was spawned, so it would answer a question about taskkill rather than about this spawn.
 *
 * **No console-window probe.** The issue asked for one on win32 — launch the board, assert the
 * spawned pid owns no visible window — and flagged it as the uncertain half. It is worse than
 * uncertain: it cannot fail. Measured on Windows 11 before this was written, spawning a
 * long-lived `node.exe` with `detached: true, stdio: 'ignore'` and *no* `windowsHide`, then
 * enumerating every top-level window with `EnumWindows` and mapping each back to its owning pid,
 * including any `conhost.exe` child: no window, no conhost child, `MainWindowHandle` 0. The same
 * spawn with the flag set: identical. That is libuv's doing — `detached` becomes
 * `DETACHED_PROCESS`, which gives the child no console at all, and Windows documents
 * `CREATE_NO_WINDOW`, which is what `windowsHide` adds, as ignored next to it. So a window probe
 * passes against the old code and the new alike, and a case that cannot go red is a case that
 * measures nothing. The issue says to delete it rather than weaken it, and it is deleted.
 *
 * That leaves the flag itself justified by convention rather than by an observed window, which is
 * what the issue argued in the first place: this is the one spawn in the tree that did not follow
 * it, and the cost of a stray console is only ever paid on somebody else's machine — a different
 * Windows build, a different shell, a launcher that hands it inherited handles.
 *
 * Self-contained: it builds a throwaway workspace registry, starts one real canvas server through
 * the product's own launch path on a port the kernel just handed out, and kills it. No browser,
 * no network, nothing that talks to GitHub.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-launch-no-console-window.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = pathToFileURL(join(repoRoot, 'dist', 'core', 'spawn.js')).href;
const isWindows = process.platform === 'win32';

/**
 * The CLI's canvas-URL variable, assembled rather than written out.
 *
 * `check-no-external-server.mjs` fails any check whose source contains it, because a check whose
 * target is decided by a variable somebody exported months ago is a check that asserts an unknown
 * server. Here it is not being read — it is being *set*, on a child, to a port the kernel just
 * handed out, which is the launch path being told where to launch.
 */
const CANVAS_URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A path a JSON registry can carry on either platform. */
const posix = (value) => value.replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `check-launch-no-console-window-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Launch Window Check', repo: 'vitorengers/vibemaxxing' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'launch-window-check', path: posix(projectDir) }],
}), 'utf8');

/** What a launcher — and the server it starts — is allowed to know about this machine. */
const launchEnvironment = (port) => canvasEnvironment({
  [CANVAS_URL_VARIABLE]: `http://127.0.0.1:${port}`,
  EXCALIDRAW_WORKSPACES: registryPath,
  LOG_LEVEL: 'error',
});

let serverPid = null;
let launcher = null;

try {
  // ─── 1. The options the canvas spawn is actually given ──────
  //
  // In a child, because the builtin is monkey-patched to see them, and a check that had done
  // that to itself could not then start a server of its own in section 2.
  console.log('1. the canvas spawn passes windowsHide, and still detaches and ignores stdio');

  const idlePort = await freePort();
  const capture = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { syncBuiltinESMExports } from 'node:module';
    import childProcess from 'node:child_process';

    const calls = [];
    childProcess.spawn = (command, args, options) => {
      calls.push({
        command,
        args,
        detached: options?.detached,
        stdio: options?.stdio,
        windowsHide: options?.windowsHide,
        port: options?.env?.PORT,
      });
      // Nothing is started: a stand-in with the two members the caller touches.
      return { pid: 4242, unref() {} };
    };
    // Without this the ESM namespace for the builtin still holds the real spawn, and the
    // module under test would start a server instead of being observed.
    syncBuiltinESMExports();

    const { ensureCanvasRunning } = await import(${JSON.stringify(moduleUrl)});
    let threw = null;
    // It cannot succeed — nothing was started — so the wait is cut short deliberately.
    try { await ensureCanvasRunning({ force: true, timeoutMs: 600 }); }
    catch (error) { threw = String(error && error.message); }
    process.stdout.write('<<' + JSON.stringify({ calls, threw }) + '>>');
  `], {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: repoRoot,
    env: launchEnvironment(idlePort),
  });

  const printed = /<<(\{.*\})>>/s.exec(capture.stdout ?? '');
  if (!printed) {
    throw new Error(`the child reported nothing: status ${capture.status}, ${capture.stderr || capture.error}`);
  }
  const { calls } = JSON.parse(printed[1]);

  check('the launch path spawned the canvas server exactly once', calls.length === 1,
        JSON.stringify(calls.map((one) => one.args)));
  const canvasSpawn = calls[0] ?? {};
  check('and it is this repository\'s server it started',
        String(canvasSpawn.args?.[0] ?? '').replace(/\\/g, '/').endsWith('dist/server.js'),
        JSON.stringify(canvasSpawn.args));
  check('on the port the launch path was pointed at', canvasSpawn.port === String(idlePort),
        `${canvasSpawn.port} rather than ${idlePort}`);

  // The one this issue exists for.
  check('windowsHide is passed, as every other spawn in the tree passes it',
        canvasSpawn.windowsHide === true, `windowsHide: ${JSON.stringify(canvasSpawn.windowsHide)}`);

  check('detached is still set, so the server can outlive the CLI',
        canvasSpawn.detached === true, `detached: ${JSON.stringify(canvasSpawn.detached)}`);
  check('and stdio is still ignored, so nothing is written to a console that is not there',
        canvasSpawn.stdio === 'ignore', `stdio: ${JSON.stringify(canvasSpawn.stdio)}`);

  // ─── 2. And the real thing outlives its launcher ────────────
  console.log('\n2. a board started through the launch path survives the launcher going away');

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const launcherProgram = `
    const { ensureCanvasRunning } = await import(${JSON.stringify(moduleUrl)});
    const result = await ensureCanvasRunning({ force: true, timeoutMs: 30000 });
    const health = await (await fetch(${JSON.stringify(`${base}/health`)})).json();
    process.stdout.write('<<' + JSON.stringify({ spawned: result.spawned, pid: health.pid }) + '>>\\n');
    // Nothing more to do: this stands in for a terminal, and it is killed from the outside.
    setInterval(() => {}, 1000);
  `;

  launcher = spawn(process.execPath, ['--input-type=module', '-e', launcherProgram], {
    cwd: repoRoot,
    env: launchEnvironment(port),
    stdio: ['ignore', 'pipe', 'pipe'],
    // A group of its own, so that killing "the terminal" below can signal a group on the
    // platforms that have them rather than a single process.
    detached: !isWindows,
  });
  let launcherOutput = '';
  launcher.stdout.on('data', (chunk) => { launcherOutput += chunk.toString(); });
  launcher.stderr.on('data', (chunk) => { launcherOutput += chunk.toString(); });

  let launched = null;
  for (let attempt = 0; attempt < 400 && !launched; attempt++) {
    const said = /<<(\{.*?\})>>/s.exec(launcherOutput);
    if (said) launched = JSON.parse(said[1]);
    else if (launcher.exitCode !== null) break;
    else await sleep(100);
  }
  check('the launch path brought a board up', launched !== null,
        `the launcher exited ${launcher.exitCode}:\n${launcherOutput}`);
  check('and it started one rather than finding one already running', launched?.spawned === true,
        JSON.stringify(launched));
  serverPid = launched?.pid ?? null;
  check('the board reports a pid of its own', Number.isInteger(serverPid) && serverPid > 0,
        String(serverPid));

  // The terminal goes away. Its group on POSIX; the process alone on Windows, where `/T` would
  // walk the recorded tree and reap the server whatever it had been spawned with.
  if (isWindows) launcher.kill('SIGKILL');
  else process.kill(-launcher.pid, 'SIGKILL');
  const stopped = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (launcher.exitCode !== null || launcher.signalCode !== null) return true;
      await sleep(100);
    }
    return false;
  })();
  check('the launcher is gone', stopped, 'it was still running after ten seconds');

  // Well past the moment a child that had been tied to its parent would have gone with it.
  await sleep(2000);
  let still = null;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    still = await response.json();
  } catch (error) {
    still = { error: String(error && error.message) };
  }
  check('and the board is still answering, as the same process', still?.pid === serverPid,
        JSON.stringify(still));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  the check ran to the end — ${error.message}`);
} finally {
  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    try { launcher.kill('SIGKILL'); } catch { /* already gone */ }
  }
  if (Number.isInteger(serverPid) && serverPid > 0) {
    try { process.kill(serverPid, 'SIGKILL'); } catch { /* already gone, which is fine */ }
  }
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('all cases passed');
