#!/usr/bin/env node
/**
 * Checks that the board finds out whether its agents can actually run, and says so.
 *
 * `/health` reported `agents: { issue, implement }` as two booleans, and both of them meant
 * only that a string was non-empty. Nothing ever ran the configured binary, so a typo in a
 * path, a CLI that was never installed, and a command that resolves on the host but not
 * inside a distro all presented identically: a board that answers `status: healthy`, draws
 * every block, offers every button, and does nothing when one is pressed. `docs/running.md`
 * says outright that the agents fail the most quietly of the three, and until now the only
 * thing that could tell the reader was a run that had already failed with exit 127.
 *
 * So there is a preflight: `src/core/agent-preflight.ts` runs argv[0] of each configured
 * command with `--version`, once per role and per environment, and the answer becomes a line
 * at startup, the widened `agents` in `/health`, and the `doctor` subcommand.
 *
 * The three states are what this asserts, **in both environments**:
 *
 *   - **configured and runnable** — the binary answered, and a version came back;
 *   - **configured and missing** — the binary is not there, and the startup line names the
 *     role, the environment and the binary rather than leaving the reader to press a button;
 *   - **unconfigured** — reported plainly, on `info`, and never as a failure. Most boards are
 *     this one and it is not a fault.
 *
 * The native environment is asserted end to end, against real servers started here with a
 * real binary and a real missing one. The WSL environment is asserted at the module, with a
 * runner injected in place of the spawn: a distro is a machine this check cannot require, and
 * the alternative — a `wsl` tier — would put the whole preflight behind a tool that two of the
 * three platforms do not have. What the injected runner proves is the part that is ours: which
 * argv is built for a distro, and how its answer is read. `scripts/check-wsl-agent-command.mjs`
 * is where a real distro runs one.
 *
 * And the last of it, which is why the widening is careful rather than obvious: **nothing in
 * `/health` or in `doctor` may carry the command line**. That route is unauthenticated on
 * loopback, and a command line here is somebody's absolute path with their `--allowedTools`
 * and their `--dangerously-skip-permissions` written into it. So the responses are scanned for
 * a flag, a path separator, an executable suffix and the fixture's own distinctive tokens.
 *
 * Self-contained: it starts its own canvas servers on free ports of their own and kills them.
 * No browser, no distro, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-agent-preflight.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { repoRoot, startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const workDir = join(tmpdir(), `agent-preflight-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const started = [];

/**
 * The fixture commands, written so that anything echoed back is unmistakable.
 *
 * The runnable one is this very Node: `argv[0]` is a binary that certainly exists and
 * certainly answers `--version`, which is the whole of what a preflight can ask of a command
 * string today. The flag after it is never run and is here to be looked for.
 */
const DECOY_FLAG = '--preflight-decoy-flag';
const MISSING_BINARY = 'vibemaxxing-agent-that-is-not-installed';
const RUNNABLE = `"${process.execPath}" ${DECOY_FLAG}`;
const MISSING = `${MISSING_BINARY} ${DECOY_FLAG}`;

/** Everything a response may never contain, whatever the operator configured. */
function leaks(text) {
  const found = [];
  if (text.includes(DECOY_FLAG)) found.push('the decoy flag');
  if (text.includes(MISSING_BINARY)) found.push('the missing binary name');
  if (text.includes(process.execPath.replace(/\\/g, '\\\\'))) found.push('the node path');
  if (text.includes('--')) found.push('a flag');
  if (/[\\/]/.test(text.replace(/\\\\/g, ''))) found.push('a path separator');
  if (/\.exe|\.cmd|\.bat/i.test(text)) found.push('an executable suffix');
  return found;
}

async function healthOf(port, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

/** The probe is deliberately not awaited at startup, so `/health` answers `probing` until it lands. */
async function settledHealth(port, attempts = 200) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await healthOf(port, 1);
    const states = Object.values(last?.agents ?? {})
      .flatMap((role) => Object.values(role?.environments ?? {}))
      .map((environment) => environment?.resolved);
    if (states.length && !states.includes('probing')) return last;
    await sleep(100);
  }
  return last;
}

let logCounter = 0;

async function canvasWith(extraEnv) {
  const port = await freePort();
  const logFile = join(workDir, `board-${logCounter++}.log`);
  const server = startCanvas({ port, env: { ...extraEnv, LOG_FILE_PATH: logFile } });
  started.push(server.child);
  const health = await settledHealth(port);
  return { port, health, logFile, read: server.read };
}

/** Everything the server said, on the console and in its own log file. */
function said(board) {
  let file = '';
  try { file = readFileSync(board.logFile, 'utf8'); } catch { /* never written */ }
  return `${board.read()}\n${file}`;
}

/** Wait for a line to reach the log, which is written after the probe rather than with it. */
async function waitForLine(board, needle, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (said(board).includes(needle)) return true;
    await sleep(100);
  }
  return false;
}

// ─── 1. The module's own answers, in both environments ────────

console.log('\n1. the preflight distinguishes runnable, missing and unconfigured');

let preflight = null;
try {
  preflight = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'agent-preflight.js')).href);
} catch (error) {
  check('src/core/agent-preflight.ts exists and builds', false, String(error?.message ?? error));
}

const wslWorkspace = {
  id: 'in-a-distro',
  name: 'in-a-distro',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj',
  innerPath: '/home/me/proj',
  environment: { kind: 'wsl', distro: 'Ubuntu' },
  language: null, docsDir: null, boardFile: null, libraryFile: null, repo: null,
  githubProject: null, projectField: null, projectCardLimit: null,
  projectInProgressColumn: null, projectTodoColumn: null, agents: {}, error: null,
};

/** A spawn that never happens: each case says what the command would have answered. */
function runnerFor(answers) {
  const seen = [];
  const run = async (spec) => {
    seen.push(spec);
    const answer = answers.shift();
    if (!answer) throw new Error('the preflight ran more probes than this case answers for');
    return { code: 0, stdout: '', stderr: '', spawnError: null, timedOut: false, ...answer };
  };
  return { run, seen };
}

/**
 * A pair of command lines as the board holds them: a backend beside each command.
 *
 * `raw` throughout, because that is what every board configured today is and what the
 * preflight probes — argv[0] of an operator's own command line. The cases below are written
 * as bare strings and wrapped here, so what they say stays about the *preflight*.
 */
const commandsOf = (pair) => ({
  native: pair.native ? { backend: 'raw', command: pair.native } : null,
  wsl: pair.wsl && pair.wsl.trim() ? { backend: 'raw', command: pair.wsl } : null,
});

function rolesFor(issue, implement) {
  return [
    { role: 'issue', variable: 'EXCALIDRAW_ISSUE_AGENT', commands: commandsOf(issue) },
    { role: 'implement', variable: 'EXCALIDRAW_IMPLEMENT_AGENT', commands: commandsOf(implement) },
  ];
}

if (preflight) {
  const { preflightAgents, initialAgents, preflightLines, probeSpec, knownBackend, versionNumber } = preflight;

  check('it exports what the server and the CLI need',
    [preflightAgents, initialAgents, preflightLines, probeSpec].every((f) => typeof f === 'function'),
    'one of preflightAgents / initialAgents / preflightLines / probeSpec is missing');

  if (typeof preflightAgents === 'function') {
    // ── native: runnable, missing, unconfigured ──
    const runnable = runnerFor([{ code: 0, stdout: '2.14.3 (Claude Code)\n' }]);
    const nativeFound = await preflightAgents({
      roles: rolesFor({ native: 'claude -p', wsl: null }, { native: null, wsl: null }),
      wslWorkspace: null,
      run: runnable.run,
      platform: 'win32',
    });
    check('a native command that answers reads as found',
      nativeFound.issue.environments.native.resolved === 'found',
      JSON.stringify(nativeFound.issue.environments.native));
    check('and the version it printed comes back as a version and nothing else',
      nativeFound.issue.environments.native.version === '2.14.3',
      JSON.stringify(nativeFound.issue.environments.native.version));
    check('an unconfigured role in the same board reads as unconfigured, not as missing',
      nativeFound.implement.environments.native.resolved === 'unconfigured'
      && nativeFound.implement.configured === false,
      JSON.stringify(nativeFound.implement));

    const gone = runnerFor([{ code: null, spawnError: 'ENOENT' }]);
    const nativeMissing = await preflightAgents({
      roles: rolesFor({ native: 'not-installed -p', wsl: null }, { native: null, wsl: null }),
      wslWorkspace: null,
      run: gone.run,
      platform: 'win32',
    });
    check('a native command that cannot be spawned reads as not found',
      nativeMissing.issue.environments.native.resolved === 'not found',
      JSON.stringify(nativeMissing.issue.environments.native));
    check('and it is still reported as configured, which is the difference that matters',
      nativeMissing.issue.configured === true, JSON.stringify(nativeMissing.issue));

    // ── wsl: runnable, missing, unconfigured ──
    const inside = runnerFor([{ code: 0, stdout: '' }, { code: 0, stdout: '1.9.0\n' }]);
    const wslFound = await preflightAgents({
      roles: rolesFor({ native: 'claude -p', wsl: '/home/me/.local/bin/claude -p' }, { native: null, wsl: null }),
      wslWorkspace,
      run: inside.run,
      platform: 'win32',
    });
    check('a distro command that answers reads as found',
      wslFound.issue.environments.wsl.resolved === 'found',
      JSON.stringify(wslFound.issue.environments.wsl));
    check('and the two environments are answered separately',
      wslFound.issue.environments.native.resolved === 'found'
      && wslFound.issue.environments.wsl.version === '1.9.0',
      JSON.stringify(wslFound.issue.environments));

    const notInDistro = runnerFor([
      { code: 0, stdout: '2.14.3\n' },
      { code: 127, stderr: 'bash: line 1: claude.exe: command not found\n' },
    ]);
    const wslMissing = await preflightAgents({
      roles: rolesFor({ native: 'claude.exe -p', wsl: null }, { native: null, wsl: null }),
      wslWorkspace,
      run: notInDistro.run,
      platform: 'win32',
    });
    check('the host command falling back into a distro, and missing there, reads as not found',
      wslMissing.issue.environments.wsl.resolved === 'not found',
      JSON.stringify(wslMissing.issue.environments.wsl));
    check('while the same command on the host reads as found — the asymmetry the two booleans lost',
      wslMissing.issue.environments.native.resolved === 'found',
      JSON.stringify(wslMissing.issue.environments));

    const nothing = runnerFor([]);
    const wslUnconfigured = await preflightAgents({
      roles: rolesFor({ native: null, wsl: null }, { native: null, wsl: null }),
      wslWorkspace,
      run: nothing.run,
      platform: 'win32',
    });
    check('with no command at all, both environments read as unconfigured',
      wslUnconfigured.issue.environments.native.resolved === 'unconfigured'
      && wslUnconfigured.issue.environments.wsl.resolved === 'unconfigured',
      JSON.stringify(wslUnconfigured.issue.environments));
    check('and nothing was spawned to find that out', nothing.seen.length === 0,
      `${nothing.seen.length} probe(s) ran`);

    // ── the argv a distro probe runs ──
    const spec = probeSpec('wsl', '/home/me/.local/bin/claude -p --dangerously-skip-permissions', wslWorkspace);
    const { buildAgentCommand } = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href);
    const reference = buildAgentCommand(wslWorkspace, "'/home/me/.local/bin/claude' --version");
    check('a distro probe is built by the same builder every distro run goes through',
      JSON.stringify(spec) === JSON.stringify(reference),
      `${JSON.stringify(spec)} vs ${JSON.stringify(reference)}`);
    check('and it runs argv[0] alone, so the operator\'s own flags are never re-run',
      !JSON.stringify(spec).includes('dangerously'), JSON.stringify(spec));

    // ── off Windows there is no such environment ──
    const elsewhere = await preflightAgents({
      roles: rolesFor({ native: 'claude -p', wsl: null }, { native: null, wsl: null }),
      wslWorkspace: null,
      run: runnerFor([{ code: 0, stdout: '2.0.0\n' }]).run,
      platform: 'linux',
    });
    check('on a platform with no WSL the distro environment says so rather than pretending',
      elsewhere.issue.environments.wsl.resolved === 'unsupported',
      JSON.stringify(elsewhere.issue.environments.wsl));

    // ── what gets said about it ──
    const lines = preflightLines(nativeMissing, rolesFor({ native: 'not-installed -p', wsl: null }, { native: null, wsl: null }));
    const warned = lines.filter((line) => line.level === 'warn');
    check('a missing binary is warned about, so it reaches a console that only shows warnings',
      warned.length === 1, JSON.stringify(lines));
    check('and the line names the role, the environment and the binary',
      warned.length === 1 && /issue/.test(warned[0].message)
      && /native/.test(warned[0].message) && /not-installed/.test(warned[0].message),
      JSON.stringify(warned));

    const quiet = preflightLines(wslUnconfigured, rolesFor({ native: null, wsl: null }, { native: null, wsl: null }));
    check('an unconfigured board is told plainly, and never on warn',
      quiet.length > 0 && quiet.every((line) => line.level === 'info'),
      JSON.stringify(quiet));

    check('a recognised backend is named from the binary, an unrecognised one is not guessed at',
      knownBackend('C:/Users/me/.local/bin/claude.exe -p') === 'claude'
      && knownBackend('/opt/private/inhouse-tool --go') === null,
      `${knownBackend('C:/Users/me/.local/bin/claude.exe -p')} / ${knownBackend('/opt/private/inhouse-tool --go')}`);
    check('a version is a version, and a line of prose is not',
      versionNumber('v24.4.1\n') === '24.4.1'
      && versionNumber('installed at C:/tools/agent') === null,
      `${versionNumber('v24.4.1\n')} / ${versionNumber('installed at C:/tools/agent')}`);
  }
}

// ─── 2. A board whose agent is really there ───────────────────

console.log('\n2. a board with an agent that runs');

const runs = await canvasWith({
  EXCALIDRAW_ISSUE_AGENT: RUNNABLE,
  EXCALIDRAW_IMPLEMENT_AGENT: RUNNABLE,
});

check('it answers /health at all', runs.health !== null);

if (runs.health) {
  check('/health reports the issue agent as found in the native environment',
    runs.health.agents?.issue?.environments?.native?.resolved === 'found',
    JSON.stringify(runs.health.agents));
  check('and the implement agent separately, which is why there are two variables',
    runs.health.agents?.implement?.environments?.native?.resolved === 'found',
    JSON.stringify(runs.health.agents));
  check('a version came back, so something really ran',
    typeof runs.health.agents?.issue?.environments?.native?.version === 'string',
    JSON.stringify(runs.health.agents?.issue?.environments?.native));
  check('both roles are reported as configured',
    runs.health.agents?.issue?.configured === true
    && runs.health.agents?.implement?.configured === true,
    JSON.stringify(runs.health.agents));
  check('and both environments are reported, not only the one this machine is',
    Object.keys(runs.health.agents?.issue?.environments ?? {}).sort().join(',') === 'native,wsl',
    JSON.stringify(Object.keys(runs.health.agents?.issue?.environments ?? {})));
  check('nothing of the command line reaches the wire',
    leaks(JSON.stringify(runs.health.agents)).length === 0,
    leaks(JSON.stringify(runs.health.agents)).join(', '));
}

// ─── 3. A board whose agent is not there ──────────────────────

console.log('\n3. a board with an agent that is not installed');

const broken = await canvasWith({
  EXCALIDRAW_ISSUE_AGENT: RUNNABLE,
  EXCALIDRAW_IMPLEMENT_AGENT: MISSING,
});

if (broken.health) {
  check('/health says the implement agent was not found',
    broken.health.agents?.implement?.environments?.native?.resolved === 'not found',
    JSON.stringify(broken.health.agents?.implement));
  check('while the issue agent beside it is still found',
    broken.health.agents?.issue?.environments?.native?.resolved === 'found',
    JSON.stringify(broken.health.agents?.issue));
  check('a configured-but-missing agent still reads as configured',
    broken.health.agents?.implement?.configured === true,
    JSON.stringify(broken.health.agents?.implement));
  check('and nothing of the command line reaches the wire here either',
    leaks(JSON.stringify(broken.health.agents)).length === 0,
    leaks(JSON.stringify(broken.health.agents)).join(', '));
}

const named = await waitForLine(broken, MISSING_BINARY);
check('starting the board printed a line naming the binary that was not found', named,
  said(broken).slice(-800));
if (named) {
  const line = said(broken).split(/\r?\n/).find((entry) => entry.includes(MISSING_BINARY)) ?? '';
  check('the line names the role', /implement/i.test(line), line);
  check('the line names the environment', /native/i.test(line), line);
  check('and it is a warning, so a console that only shows warnings shows it',
    /\[warn\]/i.test(line) || broken.read().includes(MISSING_BINARY), line);
}

// ─── 4. A board with no agent at all ──────────────────────────

console.log('\n4. a board with no agent configured');

const none = await canvasWith({});

if (none.health) {
  check('/health reports both roles as unconfigured rather than as broken',
    none.health.agents?.issue?.environments?.native?.resolved === 'unconfigured'
    && none.health.agents?.implement?.environments?.native?.resolved === 'unconfigured',
    JSON.stringify(none.health.agents));
  check('and says so as `configured: false`, which is what the restart supervisor compares',
    none.health.agents?.issue?.configured === false
    && none.health.agents?.implement?.configured === false,
    JSON.stringify(none.health.agents));
}

check('it is reported plainly', await waitForLine(none, 'no issue agent is configured'),
  said(none).slice(-800));
check('and never as a failure — nothing was warned about on the console',
  !/\[warn\]|\[error\]/i.test(none.read()), none.read().slice(-800));

// ─── 5. `doctor` asks, and answers without echoing anything ───

console.log('\n5. the doctor subcommand');

function doctor(port) {
  return spawnSync(process.execPath, [
    join(repoRoot, 'dist', 'bin.js'), 'doctor', '--url', `http://127.0.0.1:${port}`,
  ], { encoding: 'utf8', env: { ...process.env, EXCALIDRAW_NO_AUTOSTART: '1' } });
}

const report = doctor(broken.port);
check('there is a doctor command and it exits 0 on a board it could ask',
  report.status === 0, `exit ${report.status}: ${report.stderr}`);

let parsed = null;
try { parsed = JSON.parse(report.stdout); } catch { /* reported below */ }
check('it prints JSON on stdout, like every other command', parsed !== null, report.stdout.slice(0, 400));

if (parsed) {
  check('it reports the missing implement agent per role and per environment',
    parsed.agents?.implement?.environments?.native?.resolved === 'not found',
    JSON.stringify(parsed.agents));
  check('and the issue agent beside it as found',
    parsed.agents?.issue?.environments?.native?.resolved === 'found',
    JSON.stringify(parsed.agents));
  check('nothing of the command line is in what it printed',
    leaks(JSON.stringify(parsed.agents)).length === 0,
    leaks(JSON.stringify(parsed.agents)).join(', '));
}

check('its prose carries no command line, path or flag either',
  leaks(report.stderr).length === 0, `${leaks(report.stderr).join(', ')}: ${report.stderr.slice(0, 400)}`);
check('and it names the variable the reader has to set, which is the actionable part',
  report.stderr.includes('VIBEMAXXING_IMPLEMENT_AGENT'), report.stderr.slice(0, 400));

const quietReport = doctor(none.port);
check('a board with no agent gets a report rather than an error',
  quietReport.status === 0, `exit ${quietReport.status}: ${quietReport.stderr}`);

// ─── Done ─────────────────────────────────────────────────────

for (const child of started) child.kill();
await sleep(300);
// Forgiven: on Windows a killed server's handles on its state directory are
// released asynchronously, and a run that reported failure because it could not
// delete a temporary directory would be wrong about the thing it measured (#472).
try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
