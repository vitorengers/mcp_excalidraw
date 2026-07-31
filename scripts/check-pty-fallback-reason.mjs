#!/usr/bin/env node
/**
 * Checks that a session on pipes says *why* it is on pipes, and not only that it is.
 *
 * `mode: 'pipe'` has been in the summary since the terminal existed, and the block's header
 * has said "No PTY on this machine, so the shell is on pipes" for as long. Neither says
 * which of the three possible causes it was, and the one line that did — `logger.info` in
 * `loadPty()` — went to the log file alone, because the console transport is `warn` and up.
 * On Alpine, on musl, on an older glibc, on linux-armv7 or on any platform
 * `@lydell/node-pty` ships no prebuilt binary for, every session quietly becomes a pipe and
 * the reason sits in `~/.local/state/excalidraw-mcp/excalidraw.log`, a file the reader has
 * no reason to open.
 *
 * So `pipeReason` is the reason, on the summary, beside the mode. The four cases are the
 * four things it can be:
 *
 *  1. **`EXCALIDRAW_TERMINAL_PTY=0`** — the fallback was asked for, and the reason names the
 *     variable that asked.
 *  2. **The import failed** — the reason is the import error's own message, which is the
 *     actionable text (`Cannot find module '@lydell/node-pty-linux-x64'` names the package
 *     to install), and the same message reaches stderr at `warn` so that a board started in
 *     a terminal says it once without anybody opening a file.
 *  3. **A prompt was written to stdin** — `null`. A pseudoterminal has no end of file, so an
 *     agent run whose prompt goes to stdin is on pipes by construction. That is a decision
 *     rather than a fallback, and labelling it with a machine's missing binary would put a
 *     cause on a tab that would be a pipe on every machine there is.
 *  4. **A working PTY** — `null`, because there is nothing to explain.
 *
 * **How a missing binding is simulated.** This repository is maintained on a `win32-x64`
 * box, where the prebuilt binary is present and the import cannot fail on its own. Case 2
 * therefore starts a real `dist/server.js` from a launcher that registers a module
 * resolution hook throwing for the one specifier `@lydell/node-pty`, which is what npm
 * skipping the optional dependency produces at exactly the point the product handles it.
 * Everything else resolves normally. Case 3 uses the same hook in a smaller child that
 * imports `dist/core/terminal-session.js` and builds two sessions by hand, because a
 * prompt-on-stdin session is opened by a run rather than by the terminal route, and the
 * decision under test lives in the constructor: on a machine with *no* binding at all, a
 * session that was going to be a pipe regardless still reports no cause.
 *
 * Self-contained: it builds a throwaway workspace, a registry and its stubs, starts its own
 * canvas servers on ports the kernel just handed out, and kills them. No browser, no
 * GitHub. The tooltip that renders this is `check-pty-fallback-reason-browser.mjs`.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-pty-fallback-reason.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = join(repoRoot, 'dist', 'server.js');
const sessionModulePath = join(repoRoot, 'dist', 'core', 'terminal-session.js');

let failures = 0;
let skipped = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} — ${why}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');
const url = (value) => JSON.stringify(pathToFileURL(value).href);

/**
 * What the hook throws, standing in for what npm leaves behind on a platform with no
 * prebuilt binary. It names a package, which is the whole argument for showing the import
 * error verbatim rather than a sentence of the product's own.
 */
const IMPORT_ERROR = "Cannot find module '@lydell/node-pty-linux-x64'";

/** The variable, spelled once: it is both what the check sets and what it looks for. */
const PTY_SETTING = 'EXCALIDRAW_TERMINAL_PTY';

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `pty-fallback-reason-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Pipe Reason Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'pipe-reason-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: slash(projectDir) }],
}), 'utf8');

/** A shell that is not a shell: it says it started and then reads until it is closed. */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdout.write('READY\\n');
process.stdin.resume();
process.stdin.on('data', () => { /* nothing types here */ });
`, 'utf8');

const stubCommand = `node "${slash(stubShell)}"`;

/**
 * The resolution hook: one specifier fails, everything else resolves as it would.
 *
 * A `resolve` hook rather than a deleted directory, because the binding lives in this
 * repository's own `node_modules` and a check that renamed it would break the machine it
 * runs on for every other check running beside it.
 */
const hooksPath = join(workDir, 'no-pty-hooks.mjs');
writeFileSync(hooksPath, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@lydell/node-pty') throw new Error(${JSON.stringify(IMPORT_ERROR)});
  return nextResolve(specifier, context);
}
`, 'utf8');

/**
 * A canvas whose PTY import throws.
 *
 * `dist/server.js` only listens when it is the entry point, and imported from here it is
 * not, so the launcher hands it its own `argv[1]` first — see `check-wsl-windows-only.mjs`,
 * which starts a board the same way for a different reason.
 */
const launcherPath = join(workDir, 'canvas-without-pty.mjs');
writeFileSync(launcherPath, `import { register } from 'node:module';
register(${url(hooksPath)});
process.argv[1] = ${JSON.stringify(serverPath)};
await import(${url(serverPath)});
`, 'utf8');

/**
 * A child that builds sessions by hand, with the same import failure in force.
 *
 * It prints one JSON line: the summary of a session that was handed a prompt, and the
 * summary of one that was not, both on a machine where there is no binding to be had. The
 * pair is the case — the same absent PTY, reported for one of them and not for the other.
 */
const probePath = join(workDir, 'prompt-session-probe.mjs');
writeFileSync(probePath, `import { register } from 'node:module';
register(${url(hooksPath)});

const { TerminalSession, loadPty } = await import(${url(sessionModulePath)});
const pty = await loadPty();

const workspace = {
  id: ${JSON.stringify(WORKSPACE)},
  name: 'Pipe Reason Check',
  path: ${JSON.stringify(slash(projectDir))},
  innerPath: ${JSON.stringify(slash(projectDir))},
  environment: { kind: 'native' },
  language: null, docsDir: null, boardFile: null, libraryFile: null,
  repo: null, githubProject: null, projectField: null, projectCardLimit: null,
  projectInProgressColumn: null, projectTodoColumn: null,
  agents: { issue: {}, implement: {} }, error: null,
};
const hooks = { onOutput: () => {}, onExit: () => {} };

const command = ${JSON.stringify(stubCommand)};
const prompted = new TerminalSession('p1', workspace, command, hooks, pty, { input: 'do the thing\\n' });
const plain = new TerminalSession('p2', workspace, command, hooks, pty);

console.log(JSON.stringify({
  loaded: Boolean(pty),
  prompted: prompted.summary(),
  plain: plain.summary(),
}));
prompted.close();
plain.close();
`, 'utf8');

function runProbe() {
  const env = { ...process.env, LOG_LEVEL: 'error', LOG_FILE_PATH: join(workDir, 'probe.log') };
  // The machine's own setting decides nothing here: the absent binding is the hook's doing,
  // and a shell that exported the variable would make case 3 assert the wrong cause.
  delete env[PTY_SETTING];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.on('close', () => {
      const line = out.split(/\r?\n/).find((one) => one.trim().startsWith('{'));
      try { resolve(JSON.parse(line)); } catch { resolve({ error: `${out}${err}` }); }
    });
    child.on('error', (error) => resolve({ error: error.message }));
  });
}

// ─── Servers ──────────────────────────────────────────────────

const running = [];

/**
 * A board, its merged log, and its stderr on its own.
 *
 * Separately, because "the reason reaches stderr" is half of what is being asserted and a
 * merged stream cannot tell the two apart. `LOG_LEVEL` is left at `info`: the console
 * transport is already `warn` and up, and lowering the logger's own level below it would
 * filter the line before any transport saw it.
 */
async function startBoard(name, { script = serverPath, env = {} } = {}) {
  const port = await freePort();
  const server = startCanvas({
    port,
    script,
    env: {
      LOG_FILE_PATH: join(workDir, `${name}.log`),
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_TERMINAL: stubCommand,
      ...env,
    },
  });
  let stderr = '';
  server.child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  running.push(server.child);

  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the ${name} canvas exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return { ...server, stderr: () => stderr };
    } catch { /* not up yet */ }
    await sleep(100);
  }
  server.stop();
  throw new Error(`the ${name} canvas never answered on ${server.base}:\n${server.read()}`);
}

/** One request, with two more goes at the socket, which this machine sometimes refuses. */
async function call(base, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}${glue}workspace=${WORKSPACE}`, {
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        ...options,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const openSession = (base) => call(base, '/api/terminal', { method: 'POST' });
const closeSession = (base) => call(base, '/api/terminal', { method: 'DELETE' });

/** Whether a warn-level line carrying `needle` reached the stream. */
const warnedWith = (text, needle) => String(text ?? '').split(/\r?\n/)
  .some((line) => line.includes('[warn]') && line.includes(needle));

try {
  // ─── 1 ──────────────────────────────────────────────────────
  console.log(`1. a board started with ${PTY_SETTING}=0 says the variable is the reason`);

  const asked = await startBoard('asked-for-pipes', { env: { [PTY_SETTING]: '0' } });
  const askedSession = await openSession(asked.base);
  check('the session opens', askedSession.status === 202,
        `got ${askedSession.status} ${JSON.stringify(askedSession.body)}`);
  check('and reports the pipe', askedSession.body?.session?.mode === 'pipe',
        JSON.stringify(askedSession.body?.session?.mode));
  check('the summary carries a reason at all',
        typeof askedSession.body?.session?.pipeReason === 'string',
        `pipeReason ${JSON.stringify(askedSession.body?.session?.pipeReason)} — a mode with no cause `
        + 'beside it is the whole of what this check is about');
  check(`and the reason names ${PTY_SETTING}`,
        String(askedSession.body?.session?.pipeReason ?? '').includes(`${PTY_SETTING}=0`),
        JSON.stringify(askedSession.body?.session?.pipeReason));
  check('nothing is warned about a fallback that was asked for',
        !warnedWith(asked.stderr(), PTY_SETTING),
        `stderr said ${JSON.stringify(asked.stderr().slice(-400))}`);
  await closeSession(asked.base);

  // ─── 2 ──────────────────────────────────────────────────────
  console.log('\n2. a board whose PTY import throws carries the import error, and says it once');

  const broken = await startBoard('import-throws', { script: launcherPath });
  const brokenSession = await openSession(broken.base);
  check('the session still opens', brokenSession.status === 202,
        `got ${brokenSession.status} ${JSON.stringify(brokenSession.body)}`);
  check('on pipes', brokenSession.body?.session?.mode === 'pipe',
        JSON.stringify(brokenSession.body?.session?.mode));
  check("the reason is the import error's own message",
        String(brokenSession.body?.session?.pipeReason ?? '').includes(IMPORT_ERROR),
        `pipeReason ${JSON.stringify(brokenSession.body?.session?.pipeReason)} — expected it to name `
        + JSON.stringify(IMPORT_ERROR));
  check('and the same message reached stderr at warn level',
        warnedWith(broken.stderr(), IMPORT_ERROR),
        `stderr said ${JSON.stringify(broken.stderr().slice(-600))} — logger.info reaches the log `
        + 'file only, which is the file the reader never opens');

  // The load is memoised, so a reason set outside the memoised promise would be right for
  // the first session of a board's life and null for every one after it.
  const secondSession = await openSession(broken.base);
  check('a second session on the same board carries it too',
        String(secondSession.body?.session?.pipeReason ?? '').includes(IMPORT_ERROR),
        `pipeReason ${JSON.stringify(secondSession.body?.session?.pipeReason)} — the load is memoised`);
  await closeSession(broken.base);

  // ─── 3 ──────────────────────────────────────────────────────
  console.log('\n3. a session on pipes because it was handed a prompt reports no cause');

  if (!existsSync(sessionModulePath)) {
    check('dist/core/terminal-session.js exists', false, 'run ./node_modules/.bin/tsc first');
  } else {
    const probe = await runProbe();
    if (probe.error) {
      check('the probe built its two sessions', false, probe.error.slice(0, 600));
    } else {
      check('the probe had no binding to hand either session', probe.loaded === false,
            'the resolution hook did not fire');
      check('the prompted session is on pipes', probe.prompted?.mode === 'pipe',
            JSON.stringify(probe.prompted?.mode));
      check('and names no cause, because a prompt on stdin is a decision rather than a fallback',
            probe.prompted?.pipeReason === null,
            JSON.stringify(probe.prompted?.pipeReason));
      check('while the session beside it, on the same machine, names one',
            String(probe.plain?.pipeReason ?? '').includes(IMPORT_ERROR),
            JSON.stringify(probe.plain?.pipeReason));
    }
  }

  // ─── 4 ──────────────────────────────────────────────────────
  console.log('\n4. a session with a working PTY has nothing to explain');

  const ordinary = await startBoard('with-pty');
  const ordinarySession = await openSession(ordinary.base);
  if (ordinarySession.body?.session?.mode !== 'pty') {
    skip('a pty session reports no reason',
         `this machine opened a ${JSON.stringify(ordinarySession.body?.session?.mode)} session — `
         + '@lydell/node-pty ships no prebuilt binary for it');
  } else {
    check('the mode is pty', ordinarySession.body.session.mode === 'pty');
    check('and there is no reason on it', ordinarySession.body.session.pipeReason === null,
          JSON.stringify(ordinarySession.body.session.pipeReason));
    check('nothing was warned', !warnedWith(ordinary.stderr(), 'No PTY binding'),
          `stderr said ${JSON.stringify(ordinary.stderr().slice(-400))}`);
  }
  await closeSession(ordinary.base);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  for (const child of running) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
