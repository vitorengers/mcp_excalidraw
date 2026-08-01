#!/usr/bin/env node
/**
 * Checks that the log file is bounded, that it can be found, and that a quiet board stays quiet.
 *
 * The File transport was created with a filename and a level and nothing else — no `maxsize`, no
 * `maxFiles`, no rotation — and it is the only transport that records `info`, because the console
 * is capped at warn. `info` is where the busy lines were: one per element sync, twice, on a board
 * whose browser autosyncs. On the maintainer's machine that log reached 70,583,873 bytes over
 * five days, roughly 14 MB a day, at `%LOCALAPPDATA%\VibeMaxxing-MCP\vibemaxxing.log` — a path
 * chosen deliberately so the file lands outside the user's project and therefore somewhere no
 * user will look, and which no command printed.
 *
 * Four things, and each of them is one of the three defects:
 *
 *   - **it rotates.** Driving the built logger past the ceiling leaves numbered siblings and a
 *     directory total under `MAX_SIZE * MAX_FILES`, with the newest lines still in the file the
 *     documentation names — which is what `tailable: true` is for, and without which "your log
 *     is at X" would point at the oldest content on disk.
 *   - **a log that is already over the ceiling does not survive it.** Every installation that
 *     has run this tool before today has one, and a bound that only applies to files this build
 *     created would leave all of them exactly as large as they are.
 *   - **a default-level run writes no info line per element sync.** Asserted against a real
 *     server with a real `POST /api/elements/sync`, and paired with a positive control — one
 *     `POST /api/elements`, which still says what it did — so that a logger writing nothing at
 *     all cannot pass this.
 *   - **`status` prints the resolved path.** Both ways: the path an operator set, echoed back
 *     exactly, and the per-OS default resolved under a throwaway home, so that a command
 *     printing `process.env.LOG_FILE_PATH` and calling it resolved would go red on the second.
 *
 * The size and the count are written out here rather than imported from the build. A check that
 * asked the product what its ceiling was would agree with it by construction; these numbers are
 * the promise `docs/running.md` makes, and the last case asserts that document still makes it.
 *
 * Self-contained: a scratch directory under the system temporary directory, one canvas server on
 * a port the kernel just handed out, and a CLI run against that server by `--url`. No fixed port,
 * no browser, no network, no GitHub. It writes about 30 MB into the temporary directory and
 * removes it. Run `npm run build` first — this drives `dist/`.
 *
 * Usage: node scripts/check-log-rotation.mjs
 *
 * Tier: fast
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canvasEnvironment, openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** What the File transport is configured with, and what `docs/running.md` promises. */
const MAX_SIZE = 1024 * 1024;
const MAX_FILES = 5;
const CEILING = MAX_SIZE * MAX_FILES;

/**
 * How far over the ceiling a run is still allowed to be.
 *
 * Winston starts a new file once a write has taken the current one past `maxsize`, so the last
 * line of each file straddles the boundary. One line's worth per file is the honest slack; this
 * is that with room to spare, and it is small enough that an unbounded log — 12 MB against a
 * 5 MB ceiling below — cannot hide inside it.
 */
const SLACK = 64 * 1024;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 1. The build left a logger to drive ─────────────────────

console.log('1. the build left the artifacts this drives');

const ARTIFACTS = [
  join('dist', 'utils', 'logger.js'),
  join('dist', 'server.js'),
  join('dist', 'bin.js'),
];

for (const artifact of ARTIFACTS) {
  check(`${artifact.replace(/\\/g, '/')} exists`, existsSync(join(repoRoot, artifact)),
        'run `npm run build` — this check reads the build rather than making one');
}

if (failures) {
  console.error('\nnothing to drive; stopping here rather than reporting a rotation failure');
  process.exit(1);
}

// ─── The throwaway world ─────────────────────────────────────

const workDir = join(tmpdir(), `log-rotation-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/**
 * A child that imports the built logger and writes `megabytes` of it, then lets it drain.
 *
 * A child rather than an import here for the reason the logger is a module singleton: it reads
 * `LOG_FILE_PATH` in its own body, once, so a check that imported it could exercise exactly one
 * log path and would exercise it in the process doing the asserting. Two scenarios need two.
 *
 * Every inherited `LOG_*` is dropped, so a maintainer with `LOG_LEVEL=error` exported in the
 * shell they ran this from does not silently turn the writes off and pass the ceiling case with
 * an empty directory.
 *
 * **The drain is by watching the directory, not by `logger.end()`.** Ending a winston logger that
 * still has a backlog queued throws `write after end` out of the pipe between the logger and its
 * transport, which kills the child — and the backlog is guaranteed here, because writing twelve
 * megabytes is the point. So the driver yields to the event loop as it goes, and then waits until
 * the total on disk has stopped moving: rotation renames are asynchronous too, and a size that
 * has settled is the only evidence that the last of them finished.
 */
function drive(logFile, megabytes) {
  const driver = join(workDir, `drive-${megabytes}.mjs`);
  const loggerUrl = pathToFileURL(join(repoRoot, 'dist', 'utils', 'logger.js')).href;
  writeFileSync(driver, [
    "import { readdirSync, statSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    `const { default: logger } = await import(${JSON.stringify(loggerUrl)});`,
    `const dir = dirname(${JSON.stringify(logFile)});`,
    'const total = () => readdirSync(dir)',
    '  .reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);',
    "const filler = 'x'.repeat(1000);",
    `const lines = ${megabytes} * 1024;`,
    'for (let i = 0; i < lines; i++) {',
    '  logger.info(`line ${i} ${filler}`);',
    '  if (i % 256 === 255) await new Promise((resolve) => setImmediate(resolve));',
    '}',
    "logger.info('LAST LINE');",
    'let last = -1;',
    'for (let settled = 0; settled < 8;) {',
    '  await new Promise((resolve) => setTimeout(resolve, 250));',
    '  const now = total();',
    '  if (now === last) settled++; else { settled = 0; last = now; }',
    '}',
    // The file stream holds the event loop open, so an ordinary return would hang. Safe here and
    // nowhere else: the loop above has just watched the bytes stop arriving.
    'process.exit(0);',
  ].join('\n'), 'utf8');

  const env = canvasEnvironment({ LOG_FILE_PATH: logFile, LOG_LEVEL: undefined, DEBUG: undefined });
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [driver], { cwd: workDir, env, maxBuffer: 1 << 20 },
             (error, stdout, stderr) => {
               if (error) reject(new Error(`${error.message}\n${stdout}${stderr}`));
               else resolve();
             });
  });
}

/** Every file beside the log, with its size — the numbered siblings rotation leaves included. */
function logFiles(dir) {
  return readdirSync(dir).map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

const describe = (files) =>
  files.map(({ name, size }) => `${name} ${size}`).join(', ') || '(empty)';

let canvas = null;

try {
  // ─── 2. It rotates, and stays under the ceiling ────────────

  console.log('\n2. driving the logger past the ceiling rotates it');

  const rotateDir = join(workDir, 'rotate');
  mkdirSync(rotateDir, { recursive: true });
  const rotateLog = join(rotateDir, 'vibemaxxing.log');

  // Well past `MAX_FILES` rotations, so that the oldest content has been through the whole cycle
  // and been dropped rather than merely renamed once.
  await drive(rotateLog, 12);

  const rotated = logFiles(rotateDir);
  const total = rotated.reduce((sum, { size }) => sum + size, 0);

  check('the log file is there', existsSync(rotateLog), describe(rotated));
  check('rotation left numbered siblings beside it',
        rotated.some(({ name }) => /^vibemaxxing\d+\.log$/.test(name)),
        `${describe(rotated)} — no maxsize means one file that grows for ever`);
  check(`no more than ${MAX_FILES} log files are kept`,
        rotated.filter(({ name }) => name.startsWith('vibemaxxing')).length <= MAX_FILES,
        describe(rotated));
  check(`the directory total stays under ${CEILING} bytes`, total <= CEILING + SLACK,
        `${total} bytes across ${rotated.length} file(s): ${describe(rotated)}`);
  check(`no single file is much larger than ${MAX_SIZE} bytes`,
        rotated.every(({ size }) => size <= MAX_SIZE + SLACK), describe(rotated));

  // `tailable: true` is what makes the documented path the useful one: the newest lines stay in
  // the file the documentation names, and the numbered siblings are the history. Without it the
  // path an operator is handed is the oldest content on disk.
  const tail = readFileSync(rotateLog, 'utf8');
  check('the newest line is in the file the documentation names', tail.includes('LAST LINE'),
        'the freshest content is in a numbered sibling — set tailable: true');

  // ─── 3. A log that is already too big does not survive ─────

  console.log('\n3. a log file that is already over the ceiling is rotated away');

  const legacyDir = join(workDir, 'legacy');
  mkdirSync(legacyDir, { recursive: true });
  const legacyLog = join(legacyDir, 'vibemaxxing.log');
  // Every installation that has run this tool before today has one of these. 8 MB stands in for
  // the 70 MB on the maintainer's machine; the assertion is that it is gone, not that it shrank.
  const GIANT = 8 * 1024 * 1024;
  writeFileSync(legacyLog, Buffer.alloc(GIANT, 'y'));

  await drive(legacyLog, 7);

  const afterLegacy = logFiles(legacyDir);
  const legacyTotal = afterLegacy.reduce((sum, { size }) => sum + size, 0);
  check(`the ${GIANT}-byte log left behind by an older build is gone`,
        legacyTotal <= CEILING + SLACK,
        `${legacyTotal} bytes across ${afterLegacy.length} file(s): ${describe(afterLegacy)}`);

  // ─── 4. A default-level run says nothing per sync ──────────

  console.log('\n4. a default-level run writes no info line per element sync');

  const serverLog = join(workDir, 'server.log');
  canvas = await openCanvas({
    // No `LOG_LEVEL`: the claim is about what a *default* run writes, so the level has to be the
    // one an operator who set nothing gets. Deleted rather than left alone, because this
    // machine's shell may export one.
    //
    // `STATE_HOME` is a throwaway, and it is not optional. The registry, and with it the
    // directory every board is saved into, defaults to the per-user state directory — so the
    // element this creates below would be written into the real `default.excalidraw` and
    // restored by the *next* check that starts a canvas. It is not a mess this run can see:
    // `check-sync-reconcile.mjs` refuses to run against a canvas that is not empty, and the
    // first version of this check left two rectangles behind that made it exit non-zero.
    env: {
      LOG_FILE_PATH: serverLog,
      LOG_LEVEL: undefined,
      DEBUG: undefined,
      EXCALIDRAW_STATE_HOME: join(workDir, 'state'),
    },
    cwd: workDir,
  });

  const api = (path, init = {}) => fetch(`${canvas.base}${path}`, {
    headers: { 'Content-Type': 'application/json' }, ...init,
  });

  // The positive control, first: one element created through the API still says so. Without it
  // every assertion below would pass against a logger that writes nothing whatsoever.
  const created = await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 10, y: 10, width: 100, height: 50 }),
  });
  const element = (await created.json()).element;

  // And then what a browser does every time somebody nudges a shape: its whole scene, back to
  // the server. Ten of them, because one line per sync is only visible against a count.
  for (let i = 0; i < 10; i++) {
    const response = await api('/api/elements/sync', {
      method: 'POST',
      body: JSON.stringify({
        elements: [{ ...element, x: 10 + i, version: (element.version ?? 1) + i + 1 }],
        timestamp: new Date().toISOString(),
      }),
    });
    if (!response.ok) throw new Error(`sync ${i} answered ${response.status}`);
  }

  // The transport writes asynchronously; give it the moment it needs before reading the file.
  await sleep(1500);
  const written = existsSync(serverLog) ? readFileSync(serverLog, 'utf8') : '';
  const infoLines = written.split(/\r?\n/).filter((line) => line.includes('[info]'));
  const syncLines = infoLines.filter((line) => /Sync (?:request received|reconciled)/.test(line));

  check('the server writes info lines at the default level',
        infoLines.some((line) => line.includes('Creating element via API')),
        `${infoLines.length} info line(s) — without this the case below means nothing:\n`
        + `        ${written.slice(0, 400)}`);
  check('ten syncs left no info line between them', syncLines.length === 0,
        `${syncLines.length} of them:\n        ${syncLines.slice(0, 3).join('\n        ')}`);

  // ─── 5. And `status` says where the file is ────────────────

  console.log('\n5. status prints the resolved log file path');

  /** `<command> status` against the canvas this check started, as JSON. */
  function status(env) {
    return new Promise((resolve, reject) => {
      execFile(process.execPath, [join(repoRoot, 'dist', 'bin.js'), 'status', '--url', canvas.base],
               { cwd: workDir, env: canvasEnvironment(env), maxBuffer: 1 << 20 },
               (error, stdout, stderr) => {
                 if (error && !stdout) reject(new Error(`${error.message}\n${stderr}`));
                 else try { resolve(JSON.parse(stdout)); }
                 catch { reject(new Error(`status printed no JSON:\n${stdout}${stderr}`)); }
               });
    });
  }

  const cliLog = join(workDir, 'cli.log');
  const named = await status({ LOG_FILE_PATH: cliLog, LOG_LEVEL: undefined });
  check('status reports the board it was pointed at', named.running === true,
        JSON.stringify(named));
  check('status prints the log file it was told to use', named.logFile === cliLog,
        `${JSON.stringify(named.logFile)} — nothing names the file every logger.info goes to`);

  // The same command with nothing set, under a home of its own: the answer has to be a path this
  // build *resolved*, not the variable echoed back. A `status` that printed
  // `process.env.LOG_FILE_PATH` passes the case above and fails this one.
  const fakeHome = join(workDir, 'home');
  mkdirSync(fakeHome, { recursive: true });
  const resolved = await status({
    LOG_FILE_PATH: undefined,
    LOG_LEVEL: undefined,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    LOCALAPPDATA: fakeHome,
    XDG_STATE_HOME: fakeHome,
  });
  check('with nothing set it prints the per-OS default it resolved',
        typeof resolved.logFile === 'string' && resolved.logFile.startsWith(fakeHome),
        `${JSON.stringify(resolved.logFile)} is not under ${fakeHome}`);
  check('and that file is one the process actually opened',
        typeof resolved.logFile === 'string' && existsSync(resolved.logFile),
        `${JSON.stringify(resolved.logFile)} does not exist — the path printed is not the one in use`);

  // ─── 6. The document states the numbers ────────────────────

  console.log('\n6. docs/running.md states the size and the count');

  const running = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');
  // The section the path is described in, and only that one: "5 MB" somewhere else in a long
  // document is not a promise about this file, and matching it there would be a case that
  // passes on a coincidence.
  const heading = '## The log file and the debug line';
  const from = running.indexOf(heading);
  const section = from === -1 ? '' : running.slice(from, running.indexOf('\n## ', from + 1));
  check(`docs/running.md still carries "${heading.slice(3)}"`, from !== -1,
        'the log settings are documented somewhere this no longer knows about');
  check(`the ${MAX_SIZE / 1024 / 1024} MB per file is stated there`, /\b1 ?MB\b/i.test(section),
        'the ceiling is a promise; a promise nobody wrote down is one nobody can hold');
  check(`and so is the ${CEILING / 1024 / 1024} MB ceiling across ${MAX_FILES} files`,
        /\b5 ?MB\b/i.test(section) && /\bfive\b|\b5 files\b/i.test(section),
        `${MAX_FILES} files of ${MAX_SIZE} bytes — say so where LOG_FILE_PATH is described`);
} finally {
  canvas?.stop();
  // Retried and then forgiven: Windows holds a directory open for a moment after the process
  // whose working directory it was has gone, and a run that reported failure because it could
  // not delete a temporary directory would be wrong about the thing it was measuring.
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
