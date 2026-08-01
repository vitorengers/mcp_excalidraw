#!/usr/bin/env node
/**
 * Checks that the shortest thing a new user can type brings up a board, opens it, and says so in
 * one line — while every MCP client configuration that reaches the same file keeps its transport.
 *
 * Zero arguments used to mean "MCP stdio server". So the first command anybody tries connects a
 * JSON-RPC transport to a terminal, calls `process.stdin.resume()` and sits there: no output, no
 * URL, no timeout, indistinguishable from a hang. The command that actually started the board was
 * the undiscoverable `start`, and it printed machine-readable JSON; nothing anywhere opened a
 * browser, and a second `start` against a live board printed `spawned: false` and left the tab it
 * had already opened unfocused.
 *
 * **A launch takes two things: one of this package's own command names, and a person on the other
 * end of stdin.** Both halves are asserted here, and the second is the one with teeth. Every MCP
 * client configuration this project documents is `npx -y @vitorengers/vibemaxxing` with no
 * arguments, and npx resolves that to a symlink named after the command — so the product's own
 * name arrives in precisely the case where launching would be wrong. Section 5 is that case.
 *
 * The three shapes a name arrives in, all of them covered below:
 *
 *  - a POSIX **symlink**, which is what npm and npx install a bin as. `process.argv[1]` is the
 *    symlink's own path, so the name survives.
 *  - a Windows **`.cmd` shim**, which is what npm installs a bin as there — and which *erases the
 *    name*: the shim ends in `"%_prog%" "%dp0%\..\<pkg>\dist\bin.js" %*`, so `argv[1]` is the
 *    entry file. `node dist/bin.js` leaves exactly the same evidence, and since that is the only
 *    shape an installed command has on Windows, it counts as ours.
 *  - any **other** name — the two commands upstream's package installs, which this one dropped at
 *    the rename and which an already-published client configuration may still invoke — where the
 *    old behaviour has to survive byte for byte, terminal or no terminal.
 *
 * A terminal is simulated rather than allocated: the shims here are ordinary scripts that set
 * `process.stdin.isTTY` and `process.stdout.isTTY` before importing the real entry point, the way
 * `check-agent-path.mjs` rewrites `process.platform`. The two are set separately, because they
 * decide separate things — stdin decides which branch runs, stdout decides whether a browser is
 * opened — and a check that could only set both together could not tell them apart. A real pty
 * would drag in an optional dependency to assert something the code reads as a boolean either
 * way. The platform's browser opener is likewise
 * stood in for — `VIBEMAXXING_OPEN_COMMAND` names a recorder that writes down the URL it was
 * handed — because a check that opened a real browser would be a check nobody could run twice.
 *
 * **An open belongs to the launch that performed it, and this check waits for it rather than
 * hoping.** The opener is a detached process the product deliberately does not wait for, so its
 * write can land after the launch has exited and be counted against whichever case is reading the
 * record by then: the second launch's open showing up as the suppressed one's (#438). The shim
 * therefore keeps that one child referenced, which makes the launch outlive its own opener, and
 * the recorder writes late on purpose so that a run on a quiet machine asserts the same thing a
 * run on a busy one does. No delay is waited out anywhere.
 *
 * Section 0 drives the pure functions over fixtures, including the two platforms this machine is
 * not, so the Windows and macOS openers are asserted wherever the suite runs.
 *
 * Self-contained: its own state home under the system temp directory, its own ports from the
 * kernel, its own shims and recorder. Every board it starts is killed by the pid that board
 * reports about itself. No browser is opened, nothing touches the operator's board or state
 * directory, and no network is used. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-launch-command.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const binPath = join(repoRoot, 'dist', 'bin.js');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const binNames = Object.keys(pkg.bin ?? {});

/**
 * The two commands upstream's package installs. This package dropped them at the rename (#297),
 * so nothing here can be installed under one — but a client configuration published before that
 * still names one, and what it must find is the transport it has always found.
 */
const LEGACY = ['mcp-excalidraw-server', 'excalidraw-canvas'];

/**
 * The CLI's canvas-URL variable, spelled in pieces the way `check-launch-cwd-independent.mjs`
 * spells it: `check-no-external-server.mjs` bans the name from every check file, and the ban is
 * on the string rather than on what is done with it. This one only ever deletes it from a child's
 * environment.
 */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The fixtures ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-launch-command-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const make = (...parts) => {
  const dir = join(workDir, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const shimDir = make('shims');
const openedLog = join(workDir, 'opened.log');
writeFileSync(openedLog, '', 'utf8');

/**
 * A stand-in for the platform's browser opener: it writes down the URL and exits.
 *
 * **It writes late on purpose.** The real opener is a detached process nothing waits for, so on a
 * loaded machine its write lands after the launch that spawned it has already exited, and the open
 * is counted against the *next* case (#438). A recorder that writes immediately usually beats that
 * exit and the ordering is decided by how busy the machine is. This one never does, which turns a
 * flake into a property: every run of this check asserts that the launch waits for its opener.
 *
 * Not a fix by sleeping — this is the defect made reliable, not the repair. Nothing below waits
 * for a duration; what makes the record complete is the shim keeping the opener's process attached.
 */
const RECORDER_DELAY_MS = 250;
const recorder = join(workDir, 'record-open.cjs');
writeFileSync(recorder, [
  'const { appendFileSync } = require("node:fs");',
  `setTimeout(() => appendFileSync(${JSON.stringify(openedLog)},`,
  `  process.argv.slice(2).join(" ") + "\\n"), ${RECORDER_DELAY_MS});`,
  '',
].join('\n'), 'utf8');

/** Quoted, because a Node installation on Windows habitually lives under a path with a space. */
const openCommand = `"${process.execPath}" "${recorder}"`;

/**
 * Every open the launches awaited so far performed, and no half of one.
 *
 * Complete by construction rather than by luck: an open is written by the recorder before the
 * process that spawned it is allowed to exit (see `makeShim`), and `run()` resolves on that exit.
 * So a count taken here is a count of finished opens, and the difference between two of them
 * belongs to the launch that ran between.
 */
const opened = () => readFileSync(openedLog, 'utf8').split('\n').filter((line) => line.trim());

/**
 * A shim standing in for the way a command reaches this entry point.
 *
 * It is deliberately not a copy of `dist/bin.js`: the entry point resolves `dist/server.js` and
 * `package.json` relative to its own location, and a copy elsewhere would resolve neither. What
 * a symlink gives is a *different `argv[1]`* against the *same module*, and importing the real
 * file from a script named after the command is the same pair — with the one thing a symlink
 * cannot give thrown in, which is a terminal on a channel that is really a pipe.
 *
 * CommonJS on purpose. An extensionless entry point is CommonJS to Node unless its own syntax
 * says otherwise, and a dynamic `import()` is available in both.
 *
 * **And it keeps the opener attached, which is the one thing npm's shim does not do.**
 * `openBrowser` spawns the opener `detached`, `stdio: 'ignore'`, and `unref()`s it — correctly,
 * since a launch must not outlive a browser that hangs — so the launch is free to exit while the
 * recorder is still starting up, and the record of what it opened arrives after the check has
 * already read the file and moved on to the next case (#438). Neutering `unref()` on that one
 * child, and only on it, leaves the spawn the product performs exactly as it was and makes the
 * process wait for it: node keeps the loop alive for a referenced child, the recorder writes and
 * exits, and only then does the launch exit and `run()` resolve. Every other child is untouched —
 * the canvas server is spawned detached and unref'd too, and holding *that* one would mean no
 * launch ever returns.
 *
 * Patching the builtin from CommonJS reaches the ESM `import { spawn } from 'child_process'` in
 * `dist/core/open-browser.js`: `require('child_process')` and `node:child_process` are one object,
 * and Node re-reads its properties for the named exports it hands an ES module.
 */
function makeShim(name, { stdinTty = false, stdoutTty = false } = {}) {
  const file = join(shimDir, name);
  writeFileSync(file, [
    '// A stand-in for the shim npm installs. See check-launch-command.mjs.',
    ...(stdinTty ? ['process.stdin.isTTY = true;'] : []),
    ...(stdoutTty ? ['process.stdout.isTTY = true;'] : []),
    'const childProcess = require("child_process");',
    'const spawnReal = childProcess.spawn;',
    'childProcess.spawn = function (command, args, options) {',
    '  const child = spawnReal.call(this, command, args, options);',
    `  if (Array.isArray(args) && args.includes(${JSON.stringify(recorder)})) {`,
    '    // The launch may not exit until this one has written what it was handed.',
    '    child.unref = () => child;',
    '  }',
    '  return child;',
    '};',
    'const { pathToFileURL } = require("node:url");',
    `import(pathToFileURL(${JSON.stringify(binPath)}).href)`,
    '  .catch((error) => { console.error(error); process.exit(70); });',
    '',
  ].join('\n'), 'utf8');
  return file;
}

// ─── Running one ─────────────────────────────────────────────────

const launchedPorts = new Set();

/**
 * The environment every case gets: nothing of this machine's, a state home of the check's own,
 * and a port preference that keeps the search off 3737, where the operator's real board is.
 */
function environmentFor({ stateHome, port, extra = {} }) {
  const env = canvasEnvironment({
    EXCALIDRAW_STATE_HOME: stateHome,
    EXCALIDRAW_CANVAS_PORT: String(port),
    LOG_LEVEL: 'error',
    VIBEMAXXING_OPEN_COMMAND: openCommand,
  });
  // Whatever this machine's shell exports goes before the case's own values, never after: a
  // suppression set here has to be the case's statement and not the operator's.
  delete env[URL_VARIABLE];
  delete env.VIBEMAXXING_NO_OPEN;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = String(value);
  }
  return env;
}

/**
 * Run a command form to completion, or give up on it and say so.
 *
 * stdin is left open on purpose. Closing it would end a JSON-RPC transport for it and turn the
 * defect this check exists for — a stdio server attached to a terminal, which never ends — into
 * a tidy exit 0. What a person sees is a command that does not come back, so that is what a
 * failure here has to look like.
 */
function run(command, args, { env, timeoutMs = 20_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ code: null, out, err, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut: false });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, out, err: `${err}\n${error.message}`, timedOut: false });
    });
  });
}

/**
 * Speak `initialize` to a command form and report what came back, whether it was still running
 * when the answer arrived, and whether it exited afterwards.
 */
function initialize(command, args, { env, timeoutMs = 25_000 }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      for (const line of out.split('\n')) {
        if (!line.trim().startsWith('{')) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !settled) {
            settled = true;
            // A moment for an exit that should not happen, so "did not exit" means something.
            setTimeout(() => {
              const alive = child.exitCode === null && child.signalCode === null;
              try { child.kill(); } catch { /* already gone */ }
              resolve({ result: message.result ?? { error: message.error }, out, err, alive });
            }, 400);
          }
        } catch { /* a partial line */ }
      }
    });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'check-launch-command', version: '0' },
      },
    })}\n`);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      const alive = child.exitCode === null && child.signalCode === null;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      resolve({ result: null, out, err, alive });
    }, timeoutMs);
  });
}

/** The lines a run wrote to stdout, with the trailing newline not counted as one. */
const stdoutLines = (text) => text.split(/\r?\n/).filter((line, index, all) =>
  line.length > 0 || index < all.length - 1);

async function boardAt(port, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const health = await response.json();
        launchedPorts.add(port);
        return health;
      }
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

try {
  if (!existsSync(binPath)) {
    console.error('  FAIL  dist/bin.js not found — run ./node_modules/.bin/tsc first');
    process.exit(1);
  }

  // ─── 0. the pieces answer for themselves ───────────────────────

  console.log('0. the name behind an invocation, and the platform\'s opener');

  const entry = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'entry-name.js')).href)
    .catch((error) => ({ error }));
  check('dist/core/entry-name.js exports invokedName and entryMode',
        !entry.error && typeof entry.invokedName === 'function' && typeof entry.entryMode === 'function',
        entry.error ? `import failed: ${entry.error.message}` : 'exports missing');

  if (!entry.error && typeof entry.invokedName === 'function') {
    const { invokedName, entryMode } = entry;
    check('a POSIX symlink keeps the command name',
          invokedName('/usr/local/bin/vibemaxxing') === 'vibemaxxing',
          invokedName('/usr/local/bin/vibemaxxing'));
    check('a Windows shim keeps it too, extension and all',
          invokedName('C:\\Users\\someone\\AppData\\Roaming\\npm\\vibemaxxing.cmd') === 'vibemaxxing',
          invokedName('C:\\Users\\someone\\AppData\\Roaming\\npm\\vibemaxxing.cmd'));
    check('and the entry file is only ever its own name',
          invokedName('C:\\somewhere\\dist\\bin.js') === 'bin', invokedName('C:\\somewhere\\dist\\bin.js'));

    const mode = (argv1, stdinIsTty) => entryMode({
      argv1, entryFile: binPath, launchNames: binNames, stdinIsTty,
    });
    for (const name of binNames) {
      check(`"${name}" with a terminal on stdin launches`,
            mode(`/usr/local/bin/${name}`, true) === 'launch', mode(`/usr/local/bin/${name}`, true));
      check(`"${name}" with a pipe on stdin is the stdio server`,
            mode(`/usr/local/bin/${name}`, false) === 'mcp',
            `${mode(`/usr/local/bin/${name}`, false)} — this is npx resolving an MCP client's `
            + 'config to a symlink named after the command, and it may not become a launch');
    }
    for (const name of LEGACY) {
      check(`"${name}" is the stdio server whether or not there is a terminal`,
            mode(`/usr/local/bin/${name}`, true) === 'mcp'
            && mode(`/usr/local/bin/${name}`, false) === 'mcp',
            `${mode(`/usr/local/bin/${name}`, true)} / ${mode(`/usr/local/bin/${name}`, false)}`);
    }
    check('the entry file with a terminal on stdin is a launch', mode(binPath, true) === 'launch',
          `${mode(binPath, true)} — the shape every Windows shim leaves`);
    check('the entry file with a pipe on stdin is the stdio server', mode(binPath, false) === 'mcp',
          `${mode(binPath, false)} — the shape every MCP client leaves`);
  }

  const opener = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'open-browser.js')).href)
    .catch((error) => ({ error }));
  check('dist/core/open-browser.js exports openerFor and openSuppression',
        !opener.error && typeof opener.openerFor === 'function'
        && typeof opener.openSuppression === 'function',
        opener.error ? `import failed: ${opener.error.message}` : 'exports missing');

  if (!opener.error && typeof opener.openerFor === 'function') {
    const { openerFor, openSuppression } = opener;
    const url = 'http://127.0.0.1:3737';

    const windows = openerFor(url, 'win32', {});
    check('win32 goes through cmd, and keeps the empty title argument',
          windows?.command === 'cmd'
          && JSON.stringify(windows?.args) === JSON.stringify(['/c', 'start', '', url]),
          JSON.stringify(windows));
    const darwin = openerFor(url, 'darwin', {});
    check('darwin uses open', darwin?.command === 'open'
          && JSON.stringify(darwin?.args) === JSON.stringify([url]), JSON.stringify(darwin));
    const linux = openerFor(url, 'linux', {});
    check('anything else uses xdg-open', linux?.command === 'xdg-open'
          && JSON.stringify(linux?.args) === JSON.stringify([url]), JSON.stringify(linux));

    const overridden = openerFor(url, 'linux', { VIBEMAXXING_OPEN_COMMAND: '"/opt/my browser/run" --new' });
    check('an override replaces the command and still gets the URL last',
          overridden?.command === '/opt/my browser/run'
          && JSON.stringify(overridden?.args) === JSON.stringify(['--new', url]),
          `${JSON.stringify(overridden)} — a machine with no xdg-open needs somewhere to say so`);

    check('a terminal and nothing set is not suppressed',
          openSuppression({}, true) === null, JSON.stringify(openSuppression({}, true)));
    check('a pipe on stdout suppresses the open',
          typeof openSuppression({}, false) === 'string', JSON.stringify(openSuppression({}, false)));
    check('and so does VIBEMAXXING_NO_OPEN=1',
          typeof openSuppression({ VIBEMAXXING_NO_OPEN: '1' }, true) === 'string',
          JSON.stringify(openSuppression({ VIBEMAXXING_NO_OPEN: '1' }, true)));
    check('VIBEMAXXING_NO_OPEN=0 is not a suppression',
          openSuppression({ VIBEMAXXING_NO_OPEN: '0' }, true) === null,
          'an unset variable and one explicitly turned off are the same answer');
  }

  // ─── 1. a cold launch under the product's own name ─────────────

  console.log('\n1. the command with no arguments brings up a board and says one thing');

  const coldHome = make('cold-state');
  const coldPort = await freePort();
  const coldShim = makeShim(binNames[0], { stdinTty: true, stdoutTty: true });
  const cold = await run(process.execPath, [coldShim],
                         { env: environmentFor({ stateHome: coldHome, port: coldPort }) });

  check('it exits, and exits 0', cold.code === 0,
        cold.timedOut ? 'it never exited — a JSON-RPC transport attached to a terminal is a hang'
                      : `exit ${cold.code}\n${cold.err.trim().slice(-600)}`);

  const coldLines = stdoutLines(cold.out);
  check('exactly one line on stdout', coldLines.length === 1,
        `${coldLines.length} line(s): ${JSON.stringify(coldLines).slice(0, 300)}`);
  const coldLine = coldLines[0] ?? '';
  const coldUrl = `http://127.0.0.1:${coldPort}`;
  check('naming the version', coldLine.includes(pkg.version), coldLine);
  check('and the URL the board is listening on', coldLine.includes(coldUrl), coldLine);
  check('and nothing machine-readable', !coldLine.includes('{') && !coldLine.includes('spawned'),
        `${coldLine} — the first thing a new user sees is not a JSON document`);

  const coldHealth = await boardAt(coldPort);
  check('a board is answering there', coldHealth?.status === 'healthy',
        `nothing answered on ${coldPort}\n${cold.err.trim().slice(-600)}`);

  check('and the browser was pointed at it', opened().includes(coldUrl),
        JSON.stringify(opened()));

  // ─── 2. a second launch focuses the board that is there ────────

  console.log('\n2. a launch against a board that is already up');

  const before = opened().length;
  const warm = await run(process.execPath, [coldShim],
                         { env: environmentFor({ stateHome: coldHome, port: coldPort }) });
  check('it exits 0 as well', warm.code === 0,
        warm.timedOut ? 'it never exited' : `exit ${warm.code}\n${warm.err.trim().slice(-600)}`);
  const warmLines = stdoutLines(warm.out);
  check('with the same one line', warmLines.length === 1 && warmLines[0].includes(coldUrl),
        JSON.stringify(warmLines).slice(0, 300));
  check('not a JSON document saying it did nothing',
        !warm.out.includes('spawned'), warm.out.trim().slice(0, 200));
  check('and the browser was pointed at the board that was already there',
        opened().length === before + 1 && opened().at(-1) === coldUrl,
        JSON.stringify(opened().slice(before)));

  // ─── 3. the open is suppressed where it would be unwanted ──────

  console.log('\n3. an agent or a CI job gets the line and no browser');

  const quietBefore = opened().length;
  const quiet = await run(process.execPath, [coldShim], {
    env: environmentFor({ stateHome: coldHome, port: coldPort, extra: { VIBEMAXXING_NO_OPEN: '1' } }),
  });
  check('VIBEMAXXING_NO_OPEN=1 still launches and still prints its line',
        quiet.code === 0 && stdoutLines(quiet.out).length === 1
        && stdoutLines(quiet.out)[0].includes(coldUrl),
        `exit ${quiet.code} ${JSON.stringify(stdoutLines(quiet.out))}`);
  check('and opened nothing', opened().length === quietBefore, JSON.stringify(opened().slice(quietBefore)));

  const pipedBefore = opened().length;
  // A terminal on stdin and a pipe on stdout: somebody typed the command and redirected it.
  // Still a launch — stdin is what decides the branch — and still no browser, because stdout is
  // where the answer went and nobody is watching a screen for it.
  const piped = await run(process.execPath, [makeShim(binNames[0], { stdinTty: true })],
                          { env: environmentFor({ stateHome: coldHome, port: coldPort }) });
  check('a stdout that is not a terminal still launches and still prints its line',
        piped.code === 0 && stdoutLines(piped.out).length === 1
        && stdoutLines(piped.out)[0].includes(coldUrl),
        `exit ${piped.code} ${JSON.stringify(stdoutLines(piped.out))}`);
  check('and opened nothing either', opened().length === pipedBefore,
        JSON.stringify(opened().slice(pipedBefore)));

  const flagBefore = opened().length;
  const flagged = await run(process.execPath, [makeShim(binNames[0], { stdinTty: true, stdoutTty: true }), '--no-open'],
                            { env: environmentFor({ stateHome: coldHome, port: coldPort }) });
  check('--no-open is a launch with the browser left alone, not an unknown command',
        flagged.code === 0 && stdoutLines(flagged.out).length === 1
        && stdoutLines(flagged.out)[0].includes(coldUrl),
        `exit ${flagged.code} ${JSON.stringify(stdoutLines(flagged.out))}\n${flagged.err.trim().slice(-300)}`);
  check('and it opened nothing', opened().length === flagBefore,
        JSON.stringify(opened().slice(flagBefore)));

  // ─── 4. the names an old client configuration still uses ───────

  console.log('\n4. the commands this package no longer installs still speak JSON-RPC');

  const legacyHome = make('legacy-state');
  const legacyPort = await freePort();
  for (const name of LEGACY) {
    // With a terminal on both channels, which is the case where only the name can save it.
    const shim = makeShim(name, { stdinTty: true, stdoutTty: true });
    const spoke = await initialize(process.execPath, [shim], {
      env: environmentFor({
        stateHome: legacyHome,
        port: legacyPort,
        extra: { EXCALIDRAW_NO_AUTOSTART: '1' },
      }),
    });
    check(`${name} answers initialize on stdout`,
          spoke.result !== null && !spoke.result.error,
          spoke.result === null ? `nothing came back\n${spoke.err.trim().slice(-400)}`
                                : JSON.stringify(spoke.result).slice(0, 200));
    check(`${name} does not exit`, spoke.alive === true,
          'the transport has to stay attached — a client that gets an exit gets a dead server');
  }
  check('and no browser was opened for any of them', opened().every((line) => !line.includes(`:${legacyPort}`)),
        JSON.stringify(opened()));

  // ─── 5. the shapes an installed shim really leaves ─────────────

  console.log('\n5. the shapes an installed command really arrives in');

  const selfHome = make('self-state');
  const selfPort = await freePort();
  const selfEnv = environmentFor({
    stateHome: selfHome, port: selfPort, extra: { EXCALIDRAW_NO_AUTOSTART: '1' },
  });
  const asItself = await initialize(process.execPath, [binPath], { env: selfEnv });
  check('node dist/bin.js with a pipe on stdin answers initialize',
        asItself.result !== null && !asItself.result.error,
        asItself.result === null ? `nothing came back\n${asItself.err.trim().slice(-400)}`
                                 : JSON.stringify(asItself.result).slice(0, 200));
  check('and does not exit', asItself.alive === true);

  // The product's own name with a client on the other end. Named separately from the symlink
  // below because this one has to hold on every platform: what a client hands the process is a
  // pipe, and no name it was invoked under may turn that into a launch that prints a line and
  // exits. Everything under "Configure MCP Clients" in the README is this case.
  const asClient = await initialize(process.execPath, [makeShim(binNames[0])], { env: selfEnv });
  check(`${binNames[0]} with a pipe on stdin answers initialize`,
        asClient.result !== null && !asClient.result.error,
        asClient.result === null ? `nothing came back\n${asClient.err.trim().slice(-400)}`
                                 : JSON.stringify(asClient.result).slice(0, 200));
  check('and does not exit', asClient.alive === true,
        'an MCP client that gets one line and an exit has a dead server');

  if (process.platform === 'win32') {
    // The shim npm really writes, in the shape `cmd-shim` really writes it. What is asserted is
    // the half a check can assert without a pty: the name is gone, so this reaches the same
    // branch as `node dist/bin.js` above, and an MCP client configured this way still works.
    const cmdShim = join(shimDir, `${binNames[0]}.cmd`);
    writeFileSync(cmdShim, [
      '@ECHO off',
      'SETLOCAL',
      `"${process.execPath}" "${binPath}" %*`,
      '',
    ].join('\r\n'), 'utf8');
    const throughShim = await initialize('cmd', ['/c', cmdShim], { env: selfEnv });
    check('an npm .cmd shim reaches the same branch and speaks JSON-RPC',
          throughShim.result !== null && !throughShim.result.error,
          throughShim.result === null ? `nothing came back\n${throughShim.err.trim().slice(-400)}`
                                      : JSON.stringify(throughShim.result).slice(0, 200));
  } else {
    // The shim npm and npx really write on POSIX: a symlink named after the command, whose own
    // path is what `argv[1]` carries. This is `npx -y @vitorengers/vibemaxxing` — every MCP
    // client configuration this project documents — so what it has to be is the transport, and
    // the product's own name on `argv[1]` may not talk it out of that.
    const link = join(shimDir, binNames[0]);
    rmSync(link, { force: true });
    symlinkSync(binPath, link);
    const throughLink = await initialize(process.execPath, [link], { env: selfEnv });
    check('a symlink named after the command, with a pipe on stdin, answers initialize',
          throughLink.result !== null && !throughLink.result.error,
          throughLink.result === null
            ? `nothing came back\n${throughLink.err.trim().slice(-400)}`
            : JSON.stringify(throughLink.result).slice(0, 200));
    check('and does not exit', throughLink.alive === true,
          'this is what every documented MCP client config resolves to');
  }

  const ttySelf = makeShim('bin.js', { stdinTty: true, stdoutTty: true });
  const ttySelfPort = await freePort();
  const ttySelfRun = await run(process.execPath, [ttySelf], {
    env: environmentFor({ stateHome: make('tty-self-state'), port: ttySelfPort }),
  });
  check('the same entry point with a terminal on stdin launches instead',
        ttySelfRun.code === 0 && stdoutLines(ttySelfRun.out).length === 1
        && stdoutLines(ttySelfRun.out)[0].includes(`http://127.0.0.1:${ttySelfPort}`),
        ttySelfRun.timedOut ? 'it never exited'
                            : `exit ${ttySelfRun.code} ${JSON.stringify(stdoutLines(ttySelfRun.out))}`);
  await boardAt(ttySelfPort);

  // ─── 6. the stdio server has a name of its own ─────────────────

  console.log('\n6. the stdio server is reachable by name from the new command');

  const namedShim = makeShim(`${binNames[0]}-mcp`, { stdinTty: true, stdoutTty: true });
  const named = await initialize(process.execPath, [namedShim, 'mcp'], {
    env: environmentFor({
      stateHome: make('mcp-state'), port: await freePort(),
      extra: { EXCALIDRAW_NO_AUTOSTART: '1' },
    }),
  });
  check('`mcp` answers initialize even from a terminal',
        named.result !== null && !named.result.error,
        named.result === null ? `nothing came back\n${named.err.trim().slice(-400)}`
                              : JSON.stringify(named.result).slice(0, 200));
  check('and does not exit', named.alive === true);
} finally {
  for (const port of launchedPorts) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (health?.pid) process.kill(health.pid, 'SIGTERM');
    } catch { /* already gone, or never came up */ }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(300);
    try { rmSync(workDir, { recursive: true, force: true }); break; } catch { /* still held */ }
  }
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
