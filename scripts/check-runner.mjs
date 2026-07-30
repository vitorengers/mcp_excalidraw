#!/usr/bin/env node
/**
 * Does `scripts/run-checks.mjs` run the whole suite, and survive a check that will not end?
 *
 * There was no command that ran the suite: `package.json` had no `test`, `test:bind` ran
 * exactly one check, and both `CLAUDE.md` and `docs/running.md` documented the singular
 * `node scripts/check-<name>.mjs`. #272 and #273 gave the runner a tier gate and a browser
 * census; #275 gives it the three things a suite runner has to have before anybody can be
 * asked to run it unattended:
 *
 *  1. **selection** — `--only` and `--skip`, and a count of what it selected, so a
 *     contributor can run the four documentation checks without the sixty-seven browser ones;
 *  2. **a hard timeout, and a process *tree* kill** — a check that hangs is the failure mode
 *     with no other backstop. On Windows a `spawn` child that itself started a canvas server
 *     and a Chrome is not reaped by `child.kill()`, so a runner that kills only the child
 *     turns one hung check into a machine that quietly fills up with orphans. TIMEOUT is
 *     therefore its own classification, not a FAIL with a confusing exit code;
 *  3. **cleanup** — 199 `check-*` working directories were sitting in `%LOCALAPPDATA%\Temp`
 *     on the maintainer's machine when this was written, the oldest predating that session,
 *     because cleanup was per-script and every crash leaked one.
 *
 * Everything here runs against a fixture directory of stubs, never against `scripts/`: five
 * real checks would be minutes of wall clock and the arithmetic is the same, and one of the
 * stubs is *designed* never to exit, which is not a thing to point at the real suite. The
 * stubs get their own `TMPDIR`/`TEMP`/`TMP` too, so the reaping cases cannot touch whatever
 * the machine running this happens to have in its real temp directory.
 *
 * The tree kill is asserted on a **grandchild**: the hanging stub spawns a second process and
 * writes its pid down, and the case is that the pid is gone afterwards. Asserting only that the
 * runner returned would pass on a `child.kill()` that leaves the grandchild running forever,
 * which is precisely the defect the issue names as the risk.
 *
 * Offline and self-contained. No browser, no server, no port.
 *
 * Usage: node scripts/check-runner.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');
const runner = join(scriptsDir, 'run-checks.mjs');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

// ─── The fixture ──────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), 'check-runner-'));
const checksDir = join(root, 'checks');
const fakeTemp = join(root, 'temp');
const pidFile = join(root, 'hanging.pid');
const logFile = join(root, 'run.log');
mkdirSync(checksDir, { recursive: true });
mkdirSync(fakeTemp, { recursive: true });

const stub = (name, body) => writeFileSync(join(checksDir, name),
  `/**\n * A stub.\n *\n * Tier: fast\n */\n${body}\n`);

const literal = (value) => JSON.stringify(value);

/**
 * The runner, with its temp directory redirected and its own strictness left alone.
 *
 * `timeout` is this check's own backstop: every case below is about a runner that is supposed
 * to end, and a runner that hangs should fail a case rather than hang the suite. It only works
 * because the output goes to a **file** rather than to a pipe — `spawnSync` reads a pipe to
 * end-of-file, and the hanging stub's grandchild inherits that pipe, so a piped capture goes on
 * waiting long after the runner it was capturing has been killed. That is the same defect one
 * level up as the one section 2 is about.
 */
const run = (args) => {
  writeFileSync(logFile, '');
  const fd = openSync(logFile, 'a');
  const started = process.hrtime.bigint();
  let result;
  try {
    result = spawnSync(process.execPath, [runner, ...args], {
      cwd: repoRoot,
      timeout: 45_000,
      killSignal: 'SIGKILL',
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        TMPDIR: fakeTemp, TEMP: fakeTemp, TMP: fakeTemp,
        CHECK_STRICT: '',
      },
    });
  } finally {
    closeSync(fd);
  }
  return {
    code: result.status,
    output: readFileSync(logFile, 'utf8'),
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    killed: result.signal !== null && result.signal !== undefined,
  };
};

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** What the hanging stub left running, whether the runner reaped it or this check had to. */
const hangingPids = () => (existsSync(pidFile)
  ? readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number).filter(Boolean)
  : []);

/**
 * A directory in the fake temp with the prefix the checks use.
 *
 * `hoursAgo` is what makes it abandoned rather than in use. Zero is the case the first version
 * of the reaper got wrong: `check-tiers.mjs` builds `check-tiers-XXXXXX` and *then* spawns the
 * runner, so its fixture is older than the run and still very much in use.
 */
const workspace = (name, hoursAgo) => {
  const path = join(fakeTemp, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'workspace.txt'), 'the working directory of some check\n');
  if (hoursAgo > 0) {
    const then = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    utimesSync(join(path, 'workspace.txt'), then, then);
    utimesSync(path, then, then);
  }
  return path;
};

/** Left behind by a check that crashed, hours ago. */
const stale = (name) => workspace(name, 3);

const tail = (output, lines = 4) => output.trim().split(/\r?\n/).slice(-lines).join(' | ');

try {
  stub('check-pass-one.mjs', [
    "import { mkdtempSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "console.log('PASSING-STUB-CHATTER');",
    // A workspace created *during* the run: the reaper must leave it alone, because a run
    // that deletes directories younger than itself deletes a parallel run's workspace.
    "mkdtempSync(join(tmpdir(), 'check-during-run-'));",
    'process.exit(0);',
  ].join('\n'));

  stub('check-pass-two.mjs', "console.log('PASSING-STUB-CHATTER');\nprocess.exit(0);");
  stub('check-fails.mjs', "console.error('FAILING-STUB-EVIDENCE');\nprocess.exit(1);");
  stub('check-skips.mjs', 'process.exit(3);');

  // Two processes, neither of which will ever end. The grandchild inherits this stub's stdio
  // on purpose: a runner that waits for the pipes to close rather than for the process to end
  // would hang on it even after killing the child.
  stub('check-hangs.mjs', [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    // Through a variable rather than `process.execPath` inline: that literal is what
    // check-port-allocation.mjs reads as "this check starts a server", and this one starts none.
    'const node = process.execPath;',
    "const grandchild = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
    `writeFileSync(${literal(pidFile)}, \`\${process.pid} \${grandchild.pid}\`);`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  for (const name of ['check-slow-a.mjs', 'check-slow-b.mjs', 'check-slow-c.mjs']) {
    stub(name, 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);\nprocess.exit(0);');
  }

  const STUBS = 8;

  // ─── 1. A whole run: the four outcomes, counted ──────────────

  console.log('1. one passing, one failing, one skipping and one hanging stub');

  const staleBeforeFull = stale('check-left-over-by-a-crash');
  const survivor = join(fakeTemp, 'notcheck-someone-elses');
  mkdirSync(survivor, { recursive: true });
  // A `check-*` directory made moments before the run, which is what a check that spawns this
  // runner looks like from inside it.
  const inUse = workspace('check-tiers-Abc123', 0);

  const full = run(['--dir', checksDir, '--skip', 'check-slow-*', '--timeout', '5']);

  check('the run ends rather than hanging on the stub that never exits', !full.killed,
        'this check had to kill the runner itself');
  check('it exits non-zero', full.code !== 0, `exit ${full.code}`);

  const counts = (label, output) => {
    const found = output.match(new RegExp(`^\\s*${label}\\s+(\\d+)\\s*$`, 'm'));
    return found ? Number(found[1]) : null;
  };

  check('the summary counts 2 passed', counts('passed', full.output) === 2,
        `${counts('passed', full.output)} — ${tail(full.output)}`);
  check('the summary counts 1 failed', counts('failed', full.output) === 1,
        `${counts('failed', full.output)} — ${tail(full.output)}`);
  check('the summary counts 1 skipped', counts('skipped', full.output) === 1,
        `${counts('skipped', full.output)} — ${tail(full.output)}`);
  check('the summary counts 1 timed out', counts('timed out', full.output) === 1,
        `${counts('timed out', full.output)} — ${tail(full.output)}`);
  check('and says how many it selected of what it discovered',
        /^\s*selected\s+5\b/m.test(full.output) && new RegExp(`\\b${STUBS}\\b`).test(full.output),
        tail(full.output, 6));

  check('the hanging stub is classified TIMEOUT, not FAIL',
        /TIMEOUT\s+check-hangs\.mjs/.test(full.output),
        'a runner that reports it as a plain failure hides the one outcome an operator has to act on');

  check("a passing check's output is buffered away", !full.output.includes('PASSING-STUB-CHATTER'),
        'the point of buffering is that a green run is readable');
  check("a failing check's output is printed", full.output.includes('FAILING-STUB-EVIDENCE'),
        'buffered output that is never shown is output that was thrown away');

  // ─── 2. The process tree, not just the child ─────────────────

  console.log('\n2. the timeout kills the tree the check started');

  const [hungPid, grandchildPid] = hangingPids();
  check('the hanging stub got far enough to spawn a grandchild', Boolean(grandchildPid));

  check('the check that was killed is gone', !alive(hungPid), `pid ${hungPid} is still running`);
  check('and so is the grandchild it started', !alive(grandchildPid),
        `pid ${grandchildPid} is still running — child.kill() does not reap a tree`);

  // Whatever the answer was, this check does not get to leave them behind either.
  for (const pid of hangingPids().filter(alive)) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }

  // ─── 3. Selecting a subset ───────────────────────────────────

  console.log('\n3. --only and --skip select, and the runner says how many');

  const only = run(['--dir', checksDir, '--only', 'check-pass-*']);
  check('--only runs just the matching checks', only.code === 0
        && /check-pass-one\.mjs/.test(only.output) && /check-pass-two\.mjs/.test(only.output)
        && !/check-fails\.mjs/.test(only.output) && !/check-hangs\.mjs/.test(only.output),
        `exit ${only.code} — ${tail(only.output, 8)}`);
  check('--only reports the count it selected', /^\s*selected\s+2\b/m.test(only.output),
        tail(only.output, 6));

  const skip = run(['--dir', checksDir, '--only', 'check-pass-*,check-fails*',
                    '--skip', 'check-fails*']);
  check('--skip removes them again', skip.code === 0 && !/check-fails\.mjs/.test(skip.output)
        && /^\s*selected\s+2\b/m.test(skip.output),
        `exit ${skip.code} — ${tail(skip.output, 6)}`);

  const noMatch = run(['--dir', checksDir, '--only', 'check-nothing-by-this-name-*']);
  check('a pattern that matches nothing selects nothing and says so',
        /^\s*selected\s+0\b/m.test(noMatch.output), tail(noMatch.output, 6));

  // ─── 4. --jobs runs them at the same time ────────────────────

  console.log('\n4. --jobs runs more than one at a time');

  const serial = run(['--dir', checksDir, '--only', 'check-slow-*']);
  const parallel = run(['--dir', checksDir, '--only', 'check-slow-*', '--jobs', '3']);
  check('the default is one at a time', serial.code === 0 && /^\s*selected\s+3\b/m.test(serial.output),
        `exit ${serial.code} — ${tail(serial.output, 6)}`);
  check('--jobs 3 finishes three 1.2s checks well inside the serial time',
        parallel.code === 0 && parallel.ms < serial.ms * 0.75,
        `${Math.round(parallel.ms)}ms with --jobs 3 against ${Math.round(serial.ms)}ms serial`);

  const badJobs = run(['--dir', checksDir, '--jobs', 'nonsense']);
  check('--jobs with something that is not a number is refused', badJobs.code === 2,
        `exit ${badJobs.code}`);

  // ─── 5. The temp directories a crashed check left behind ─────

  console.log('\n5. os.tmpdir() is reaped of the check-* directories older than the run');

  check('a check-* directory older than the run is gone', !existsSync(staleBeforeFull),
        `${staleBeforeFull} survived — this is the 199-directory leak`);
  check('something that is not a check-* directory is left alone', existsSync(survivor),
        'the reaper matches on the prefix the checks use, not on everything in temp');
  check('a check-* directory older than the run but still in use is left alone', existsSync(inUse),
        'a check that spawns this runner made its fixture before the run started — reaping on '
        + 'age alone deletes it out from under the check that is the subject of the run');

  // A run of its own, because the assertion below is about what *this* run left behind: every
  // run since the first one has reaped the workspaces the run before it created.
  const staleAgain = stale('check-left-over-again');
  const reaping = run(['--dir', checksDir, '--only', 'check-pass-one*']);
  check('and it happens on every run, not only the first', reaping.code === 0 && !existsSync(staleAgain),
        `exit ${reaping.code}`);

  const during = readdirSync(fakeTemp).filter((name) => name.startsWith('check-during-run-'));
  check('a workspace created during the run is left alone', during.length > 0,
        'a run that deletes directories younger than itself deletes a parallel run\'s workspace');

  const keptStale = stale('check-left-over-and-kept');
  const kept = run(['--dir', checksDir, '--only', 'check-pass-two*', '--keep-temp']);
  check('--keep-temp leaves them where they are', kept.code === 0 && existsSync(keptStale),
        `exit ${kept.code}`);
  rmSync(keptStale, { recursive: true, force: true });

  // ─── 6. A missing build is loud, not a rebuild ───────────────

  console.log('\n6. an unbuilt dist/ stops the run instead of being built quietly');

  // Pointed at the real `scripts/`, because the guard is about *this* repository's build. The
  // tier is the four cheap discipline checks: a runner that ignores the guard runs those and
  // nothing worse, rather than starting sixty-seven browsers to prove a point.
  const unbuilt = run(['--tier', 'repo', '--assume', 'dist=0']);
  check('it refuses to start', unbuilt.code === 2, `exit ${unbuilt.code}`);
  check('it names the artifact that is missing', /dist[\\/]server\.js/.test(unbuilt.output),
        tail(unbuilt.output));
  check('and it runs nothing', !/\bPASS\b/.test(unbuilt.output), tail(unbuilt.output));

  const built = run(['--assume', 'dist=1', '--list', '--tier', 'repo']);
  check('a built dist/ gets past it', built.code === 0 && /WOULD RUN/.test(built.output),
        `exit ${built.code} — ${tail(built.output)}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ─── 7. The command a contributor is told to run ──────────────

console.log('\n7. npm test is the command, and the documentation says so');

const packageJson = JSON.parse(read('package.json'));
check('package.json has a test script', typeof packageJson.scripts?.test === 'string',
      'there was no command that ran the suite');
check('and it is the runner', (packageJson.scripts?.test ?? '').includes('scripts/run-checks.mjs'),
      packageJson.scripts?.test ?? 'missing');

const readme = read('README.md');
const running = read('docs/running.md');
check('README.md names npm test', readme.includes('npm test'));
check('docs/running.md names npm test', running.includes('npm test'));

const testingSection = readme.split(/^##\s+/m).find((section) => section.startsWith('Testing')) ?? '';
check('README.md has a Testing section', testingSection !== '');
check('it is no longer the upstream smoke tests', !/Smoke Test/i.test(testingSection),
      'the front page presented four upstream smoke tests as this fork\'s testing story');
check('it points at the runner', testingSection.includes('npm test'), tail(testingSection));

console.log(failures === 0 ? '\nall cases passed' : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
