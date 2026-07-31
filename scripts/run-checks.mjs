#!/usr/bin/env node
/**
 * Runs this repository's checks: every one of them, or the subset you name.
 *
 * `npm test` is this. Until #275 there was no command that ran the suite at all — `test:bind`
 * ran exactly one check, and `CLAUDE.md` and `docs/running.md` both documented the singular
 * `node scripts/check-<name>.mjs`, which is a fine way to work on one defect and no way to
 * find out whether a hundred and fifty-nine of them still pass.
 *
 * ### Which checks, and where they can run (#272)
 *
 * Every `scripts/check-*.mjs` carries a `Tier:` line in its banner, and this reads it with
 * **no default**: a check with no tier is reported and fails the run rather than being
 * treated as portable, because the failure a default would produce is the quiet one — a
 * browser check on a box with no browser exits 0 and reads as a pass.
 *
 * The five tiers, and what each one needs beyond Node and a built `dist/`:
 *
 *   fast     nothing else, so it runs on Linux, macOS and Windows alike
 *   browser  a Chrome or an Edge to drive
 *   windows  win32 — the check gives up on any other platform
 *   wsl      a real distro behind `wsl.exe`
 *   repo     a clone with the full history, and this repository's own board
 *
 * A tier whose tool is not on this machine is given up as **EXPECTED-SKIP**, exit 0 —
 * except `browser`. A hosted runner with no Chrome is a runner that is set up wrong, not a
 * machine that was never going to run those checks, and the whole point of the tier is that
 * the browser half is on the contributor gate. Giving it up quietly would put sixty-nine
 * checks behind a green tick that never ran them.
 *
 * `scripts/check-tiers.mjs` is what holds the declarations honest; this only reads them.
 *
 * ### The tier gate is not the whole of it (#273)
 *
 * Asking this machine for a Chrome answers whether the tier *could* run. It does not answer
 * whether each check in it actually found one: a check given a `CHROME_PATH` that points at
 * nothing, or `--chrome` at a stale path, comes back exit 0 having measured nothing, and a
 * runner that reads exit 0 as PASS reports it as a check that ran. That is the same defect the
 * gate above closes, one level down.
 *
 * So every child is spawned with `CHECK_STRICT=1` — not as this runner passing its own
 * strictness down, but because that is what makes a skip *visible*. Under it a check that finds
 * no browser exits **3** instead of 0 (`scripts/lib/find-chrome.mjs`), and 3 is a code this
 * runner can classify: SKIP normally, FAIL under `--strict`. Either way the count is printed at
 * the end of every run, passing or not, because the point of the number is that a green run has
 * to say out loud how much of itself it did not execute.
 *
 * ### A check that never ends, and the mess it leaves (#275)
 *
 * Every child gets a hard timeout — 180 seconds unless `--timeout` says otherwise — and a
 * check that reaches it is **TIMEOUT**, a classification of its own rather than a FAIL with a
 * confusing exit code, because it is the one outcome an operator has to act on rather than
 * read a diff about.
 *
 * Killing it means killing the *tree*. A check here routinely starts a canvas server and a
 * headless Chrome, and on Windows `child.kill()` reaps none of them: the check dies and its
 * server keeps the port. So it is `taskkill /T /F` on win32, and elsewhere the child is spawned
 * detached — it leads its own process group — and the group is signalled. Getting this wrong
 * turns one hung check into a machine that fills up with orphans, which is the leak this was
 * written to close rather than a new one to open.
 *
 * The other half of that leak is on disk. Cleanup was per-script, so every crashed or killed
 * check left its working directory behind: 199 `check-*` directories were sitting in this
 * machine's temp when #275 was written, the oldest predating the session. At the end of a run
 * this removes the `check-*` directories in `os.tmpdir()` that are older than the run **and
 * untouched for an hour**. `--keep-temp` turns it off.
 *
 * Both halves of that are load-bearing, and the second one was paid for. "Older than the run"
 * alone deletes a directory that is still in use: `check-tiers.mjs` builds its fixture as
 * `check-tiers-XXXXXX` and *then* spawns this runner, so the fixture is older than the run it is
 * the subject of, and the first version of this reaped it out from under the check that made it.
 * The hour is the grace: a single check is killed at 180 seconds, so nothing a live run owns can
 * have gone untouched for twenty times that. What this run leaks itself is younger than it and
 * is collected by the next one.
 *
 * ### It does not build
 *
 * A missing `dist/server.js` or `dist/frontend/index.html` stops the run with exit 2 and says
 * which one. It deliberately does not build them: a runner that silently rebuilds hides which
 * artifact a check actually needs, and a check that passes only because the runner built the
 * frontend for it is a check nobody can reproduce by hand. `--dir` is the exception — pointed
 * at a directory of stubs it is not running this repository's checks, so this repository's
 * build output is not what they need.
 *
 * Usage: node scripts/run-checks.mjs [--tier <name>[,<name>…]] [--only <glob>] [--skip <glob>]
 *                                    [--jobs <n>|auto] [--timeout <seconds>] [--keep-temp]
 *                                    [--list] [--strict] [--dir <path>] [--assume <cap>=0|1]
 *
 *   --tier     one or more tiers to run; every tier when it is left out
 *   --only     run only the checks whose file name matches a glob, `*` and `?`, repeatable
 *              and comma-separated — `--only 'check-docs-*'`
 *   --skip     drop the checks matching a glob, applied after `--only`
 *   --jobs     how many checks to run at once; 1 by default, `auto` for min(4, cpus)
 *   --timeout  seconds a single check may take before it is killed as TIMEOUT (default 180)
 *   --keep-temp  do not reap the stale `check-*` directories in os.tmpdir()
 *   --list     print what would run, and run nothing
 *   --strict   a check that gave up for want of a browser fails the run instead of skipping
 *   --dir      look for the checks somewhere other than `scripts/` (used by check-tiers.mjs)
 *   --assume   answer a capability probe — chrome, win32, wsl, history or dist — instead of
 *              asking this machine. A test seam, so a check of the tier gate does not
 *              depend on whether the machine running it happens to have a distro.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/find-chrome.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything reaped at the end has to be older than this. */
const runStarted = Date.now();

/**
 * A tier's `needs` is a capability; `required` says what an absence means.
 *
 * `required: true` is "this machine was supposed to have it" and fails the run; the others
 * are "this machine was never it" and skip.
 */
const TIERS = {
  fast: { needs: null, what: 'Node and a built dist/' },
  browser: { needs: 'chrome', required: true, what: 'a Chrome or an Edge to drive' },
  windows: { needs: 'win32', what: 'win32' },
  wsl: { needs: 'wsl', what: 'a real distro behind wsl.exe' },
  repo: { needs: 'history', what: 'a clone with the full history' },
};

/** The build every check loads rather than makes. */
const ARTIFACTS = ['dist/server.js', 'dist/frontend/index.html'];

// ─── Arguments ────────────────────────────────────────────────

const argv = process.argv.slice(2);
const values = (name) => argv.reduce((found, arg, index) => (
  arg === name && argv[index + 1] !== undefined ? [...found, argv[index + 1]] : found
), []);
const flag = (name) => argv.includes(name);
/** A repeatable, comma-separated option, as one flat list. */
const list = (name) => values(name).flatMap((value) => value.split(','))
  .map((item) => item.trim()).filter(Boolean);

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter((line) => line.startsWith(' *')).map((line) => line.slice(2).trimEnd())
    .join('\n'));
  process.exit(0);
}

const known = Object.keys(TIERS);
const asked = list('--tier');
const unknown = asked.filter((tier) => !known.includes(tier));
if (unknown.length) {
  console.error(`Unknown tier: ${unknown.join(', ')}. Known tiers: ${known.join(', ')}.`);
  process.exit(2);
}
const wanted = asked.length ? [...new Set(asked)] : known;

const dirGiven = values('--dir').length > 0;
const dir = values('--dir').at(-1) ?? join(repoRoot, 'scripts');
const listOnly = flag('--list');
const strict = flag('--strict');
const keepTemp = flag('--keep-temp');
const only = list('--only');
const skip = list('--skip');

const parallelism = () => (typeof availableParallelism === 'function'
  ? availableParallelism() : (cpus().length || 1));

/**
 * One at a time by default.
 *
 * The checks are not yet independent of each other in the ways concurrency needs them to be —
 * that is release-audit item ci-checks-02 — and a runner that defaults to four while two checks
 * still contend for the same fixture reports flake as failure. `--jobs` is here now because the
 * seam has to exist before anything can be measured through it; the default moves to
 * `min(4, cpus)` once ci-checks-02 has landed, which is what `--jobs auto` already does.
 */
const jobsArgument = values('--jobs').at(-1) ?? '1';
const jobs = jobsArgument === 'auto' ? Math.min(4, parallelism()) : Number(jobsArgument);
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`--jobs takes a whole number of 1 or more, or "auto"; got "${jobsArgument}".`);
  process.exit(2);
}

const timeoutArgument = values('--timeout').at(-1) ?? '180';
const timeoutSeconds = Number(timeoutArgument);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error(`--timeout takes a number of seconds greater than 0; got "${timeoutArgument}".`);
  process.exit(2);
}

const assumed = new Map(values('--assume').map((pair) => {
  const [capability, value] = pair.split('=');
  return [capability, value !== '0' && value !== 'false'];
}));

// ─── What this machine can do ─────────────────────────────────

/**
 * Chrome, through the one probe the checks themselves use.
 *
 * The list used to be spelled out again here, which made this the seventieth copy of it and
 * the one that could disagree with the sixty-nine it is gating — a runner that says the tier
 * can run while every check in it skips is worse than either answer alone. Since #273 there is
 * one list, in `scripts/lib/find-chrome.mjs`, and this asks it.
 */
const hasChrome = () => findChrome() !== null;

/** `wsl.exe -l -q` answers in UTF-16LE, and a `wsl.exe` with no distro installed is not one. */
function hasWsl() {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true });
  if (result.status !== 0 || !result.stdout) return false;
  return result.stdout.toString('utf16le').split(/\r?\n/).map((line) => line.trim()).some(Boolean);
}

/** A shallow clone cannot answer what this fork has merged, which is what `repo` asserts. */
function hasHistory() {
  const result = spawnSync('git', ['rev-parse', '--is-shallow-repository'],
                           { cwd: repoRoot, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === 'false';
}

const probes = {
  chrome: hasChrome,
  win32: () => process.platform === 'win32',
  wsl: hasWsl,
  history: hasHistory,
  dist: () => ARTIFACTS.every((artifact) => existsSync(join(repoRoot, artifact))),
};

const capabilities = new Map();
const can = (capability) => {
  if (assumed.has(capability)) return assumed.get(capability);
  if (!capabilities.has(capability)) capabilities.set(capability, probes[capability]());
  return capabilities.get(capability);
};

// ─── The build the checks load rather than make ───────────────

if (!listOnly && !dirGiven && !can('dist')) {
  const missing = assumed.has('dist')
    ? ARTIFACTS
    : ARTIFACTS.filter((artifact) => !existsSync(join(repoRoot, artifact)));
  console.error('dist/ is not built, and this does not build it:');
  for (const artifact of missing) console.error(`  missing  ${artifact}`);
  console.error('\nRun `npm run build` first. Building here would hide which artifact a check '
                + 'needs — a\ncheck that only passes because the runner rebuilt the frontend '
                + 'for it cannot be\nreproduced by hand.');
  process.exit(2);
}

// ─── The checks, and the tier each one declares ───────────────

const discovered = readdirSync(dir).filter((file) => /^check-.*\.mjs$/.test(file)).sort();

/**
 * A glob over the file name, `*` and `?` only.
 *
 * Matched against the name with and without `.mjs`, so both `--only 'check-docs-*'` and
 * `--only check-tiers` do what they read as.
 */
const globToRegExp = (pattern) => new RegExp(`^${pattern
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*/g, '.*')
  .replace(/\?/g, '.')}$`);

const matches = (patterns, file) => patterns.some((pattern) => {
  const expression = globToRegExp(pattern);
  return expression.test(file) || expression.test(file.replace(/\.mjs$/, ''));
});

const chosen = (file) => (only.length === 0 || matches(only, file))
  && !(skip.length > 0 && matches(skip, file));

const files = discovered.filter(chosen);

const tierOf = new Map();
const untiered = [];
for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  const found = [...source.matchAll(/^\s*\*?\s*Tier:\s*(\S+)\s*$/gm)].map(([, tier]) => tier);
  if (found.length === 1 && known.includes(found[0])) tierOf.set(file, found[0]);
  else untiered.push(`${file} — ${found.length === 0 ? 'no Tier: line' : `Tier: ${found.join(', ')}`}`);
}

let failed = 0;
let passed = 0;
let skipped = 0;
let timedOut = 0;
/**
 * Checks that did not run because there was no browser — both ways it can happen: a whole
 * tier given up at the gate, and a check that got as far as its own probe and gave up there.
 * Overlaps `failed` and `skipped` deliberately: it is not a fourth bucket but the answer to
 * "how much of this run was not executed", which is the one number a green run has to state.
 */
let noBrowser = 0;

/** Exit 3 is a check saying it found no browser. See scripts/lib/find-chrome.mjs. */
const NO_BROWSER = 3;

if (untiered.length) {
  console.error(`\n${untiered.length} check(s) declare no usable tier — see scripts/check-tiers.mjs:`);
  for (const line of untiered) console.error(`  UNMARKED  ${line}`);
  failed += untiered.length;
}

// ─── Running one, and killing what it started ─────────────────

const indent = (output) => output.trimEnd().split('\n').map((line) => `        ${line}`).join('\n');

/**
 * Everything the check started, not only the check.
 *
 * A check here starts a canvas server, and often a headless Chrome under it. `child.kill()`
 * reaps neither on Windows — the check dies and the server keeps its port — so the tree is
 * addressed directly: `taskkill /T` walks the parent-pid chain, and on the others the child
 * leads its own process group and the group is signalled.
 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'],
              { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
  try { child.kill('SIGKILL'); } catch { /* and so is the child */ }
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = spawn(process.execPath, [join(dir, file)], {
      cwd: repoRoot,
      // CHECK_STRICT is set for every child, whatever this runner was given: it is what turns
      // a check's silent exit 0 into an exit 3 that can be told apart from a pass.
      env: { ...process.env, CHECK_STRICT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });

    let killed = false;
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutSeconds * 1000);

    let settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A grandchild that inherited the pipes keeps them open after its parent is gone, so the
      // streams are dropped rather than waited on: `close` may never come.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve({
        file,
        status,
        output,
        killed,
        seconds: (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1),
      });
    };

    child.on('error', (error) => { output += `${error.message}\n`; finish(null); });
    child.on('close', (status) => finish(status));
    // `exit` is the process ending; `close` is its pipes closing, and a leaked grandchild can
    // hold those open indefinitely. Whichever comes first wins, with a moment for the tail.
    child.on('exit', (status) => { setTimeout(() => finish(status), 200); });
  });
}

function report({ file, status, output, killed, seconds }) {
  if (killed) {
    timedOut++;
    console.error(`  TIMEOUT  ${file} (${seconds}s) — killed after ${timeoutSeconds}s, `
                  + 'with everything it started');
    if (output.trim()) console.error(indent(output));
    return;
  }
  if (status === 0) {
    passed++;
    console.log(`  PASS  ${file} (${seconds}s)`);
    return;
  }
  if (status === NO_BROWSER) {
    noBrowser++;
    if (!strict) {
      skipped++;
      console.log(`  SKIP  ${file} (${seconds}s) — no browser`);
      return;
    }
    failed++;
    console.error(`  FAIL  ${file} (${seconds}s) — gave up for want of a browser, and --strict`);
    if (output.trim()) console.error(indent(output));
    return;
  }
  failed++;
  console.error(`  FAIL  ${file} (${seconds}s, exit ${status})`);
  if (output.trim()) console.error(indent(output));
}

/** `jobs` at a time, in the order they finish. */
async function runAll(selected) {
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      report(await runOne(selected[next++]));
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, worker));
}

// ─── Run them, a tier at a time ───────────────────────────────

for (const tier of wanted) {
  const selected = files.filter((file) => tierOf.get(file) === tier);
  if (!selected.length) continue;

  // `--list` answers what the selection is, so it must answer it on any machine: gating it
  // on the tools would make the listing depend on the box being asked.
  const { needs, required, what } = TIERS[tier];
  if (!listOnly && needs && !can(needs)) {
    if (required) {
      console.error(`\n${tier} (${selected.length}) — MISSING: needs ${what}, which this machine does not have`);
      console.error(`  this tier is on the contributor gate, so ${selected.length} check(s) `
                    + 'did not run and the run fails rather than reporting a skip');
      failed += selected.length;
      if (needs === 'chrome') noBrowser += selected.length;
    } else {
      console.log(`\n${tier} (${selected.length}) — EXPECTED-SKIP: needs ${what}, `
                  + 'which this machine does not have');
      for (const file of selected) console.log(`  EXPECTED-SKIP  ${file}`);
      skipped += selected.length;
    }
    continue;
  }

  console.log(`\n${tier} (${selected.length})`);
  if (listOnly) {
    for (const file of selected) console.log(`  WOULD RUN  ${file}`);
    continue;
  }
  await runAll(selected);
}

if (listOnly) {
  console.log(`\n${[...tierOf].filter(([, tier]) => wanted.includes(tier)).length} check(s) selected`);
  process.exit(failed ? 1 : 0);
}

// ─── What the crashed ones left in os.tmpdir() ────────────────

/**
 * Long enough that nothing still in use can be this old.
 *
 * A check is killed at `--timeout` seconds — 180 by default — so a `check-*` directory nobody
 * has written to for an hour belongs to a process that is not running any more. Age is the only
 * cheap proxy for "abandoned", and this is the margin on it.
 */
const REAP_GRACE_MS = 60 * 60 * 1000;

/**
 * The `check-*` working directories that are older than this run and abandoned.
 *
 * Both conditions, and neither on its own. A check running right now — in a parallel
 * invocation, or as the parent that spawned *this* runner — owns a directory with the same
 * prefix, and deleting it turns a leak into a failure somebody has to debug.
 */
function reapTemp() {
  const root = tmpdir();
  const cutoff = Math.min(runStarted, Date.now() - REAP_GRACE_MS);
  let reaped = 0;
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    // `isDirectory()` is false for a symlink, which is the answer wanted: a link into
    // somebody's home directory is not a leaked workspace.
    if (!entry.isDirectory() || !entry.name.startsWith('check-')) continue;
    const path = join(root, entry.name);
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      rmSync(path, { recursive: true, force: true });
      reaped++;
    } catch { /* in use, or already gone — either way not this run's problem */ }
  }
  return reaped;
}

if (!keepTemp) {
  const reaped = reapTemp();
  if (reaped) {
    console.log(`\nreaped ${reaped} stale check-* ${reaped === 1 ? 'directory' : 'directories'}`
                + ` from ${tmpdir()}`);
  }
}

// ─── The tally ────────────────────────────────────────────────

const rows = [['passed', passed], ['failed', failed], ['skipped', skipped], ['timed out', timedOut]];
const selectedTotal = passed + failed + skipped + timedOut;
const column = Math.max(...rows.map(([, count]) => String(count).length), String(selectedTotal).length);

console.log('');
for (const [label, count] of rows) {
  console.log(`  ${label.padEnd(11)}${String(count).padStart(column)}`);
}
console.log(`  ${'─'.repeat(11 + column)}`);
console.log(`  ${'selected'.padEnd(11)}${String(selectedTotal).padStart(column)}`
            + `  of ${discovered.length} check(s) discovered`);

console.log(`\n${passed} passed, ${failed} failed, ${skipped} EXPECTED-SKIP, ${timedOut} timed out`
            + ` — ${noBrowser} skipped for want of a browser`);
if (noBrowser && !strict) {
  console.log('Those were not verified. Re-run with --strict to treat them as failures.');
}
if (failed || timedOut) process.exit(1);
