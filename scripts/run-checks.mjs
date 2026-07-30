#!/usr/bin/env node
/**
 * Runs this repository's checks, selected by the tier each one declares.
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
 * Usage: node scripts/run-checks.mjs [--tier <name>[,<name>…]] [--list] [--strict]
 *                                    [--dir <path>] [--assume <cap>=0|1]
 *
 *   --tier    one or more tiers to run; every tier when it is left out
 *   --list    print what would run, and run nothing
 *   --strict  a check that gave up for want of a browser fails the run instead of skipping
 *   --dir     look for the checks somewhere other than `scripts/` (used by check-tiers.mjs)
 *   --assume  answer a capability probe — chrome, win32, wsl or history — instead of
 *             asking this machine. A test seam, so a check of the tier gate does not
 *             depend on whether the machine running it happens to have a distro.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome } from './lib/find-chrome.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

// ─── Arguments ────────────────────────────────────────────────

const argv = process.argv.slice(2);
const values = (name) => argv.reduce((found, arg, index) => (
  arg === name && argv[index + 1] !== undefined ? [...found, argv[index + 1]] : found
), []);
const flag = (name) => argv.includes(name);

if (flag('--help') || flag('-h')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter((line) => line.startsWith(' *')).map((line) => line.slice(2).trimEnd())
    .join('\n'));
  process.exit(0);
}

const known = Object.keys(TIERS);
const asked = values('--tier').flatMap((value) => value.split(',')).map((tier) => tier.trim()).filter(Boolean);
const unknown = asked.filter((tier) => !known.includes(tier));
if (unknown.length) {
  console.error(`Unknown tier: ${unknown.join(', ')}. Known tiers: ${known.join(', ')}.`);
  process.exit(2);
}
const wanted = asked.length ? [...new Set(asked)] : known;

const dir = values('--dir').at(-1) ?? join(repoRoot, 'scripts');
const listOnly = flag('--list');
const strict = flag('--strict');

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
};

const capabilities = new Map();
const can = (capability) => {
  if (assumed.has(capability)) return assumed.get(capability);
  if (!capabilities.has(capability)) capabilities.set(capability, probes[capability]());
  return capabilities.get(capability);
};

// ─── The checks, and the tier each one declares ───────────────

const files = readdirSync(dir).filter((file) => /^check-.*\.mjs$/.test(file)).sort();

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
  for (const file of selected) {
    if (listOnly) { console.log(`  WOULD RUN  ${file}`); continue; }
    const started = process.hrtime.bigint();
    // CHECK_STRICT is set for every child, whatever this runner was given: it is what turns a
    // check's silent exit 0 into the exit 3 the next few lines can tell apart from a pass.
    const result = spawnSync(process.execPath, [join(dir, file)], {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, CHECK_STRICT: '1' },
    });
    const seconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
    if (result.status === 0) {
      passed++;
      console.log(`  PASS  ${file} (${seconds}s)`);
    } else if (result.status === NO_BROWSER) {
      noBrowser++;
      if (strict) {
        failed++;
        console.error(`  FAIL  ${file} (${seconds}s) — gave up for want of a browser, and --strict`);
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
        if (output) console.error(output.split('\n').map((line) => `        ${line}`).join('\n'));
      } else {
        skipped++;
        console.log(`  SKIP  ${file} (${seconds}s) — no browser`);
      }
    } else {
      failed++;
      console.error(`  FAIL  ${file} (${seconds}s, exit ${result.status})`);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd();
      if (output) console.error(output.split('\n').map((line) => `        ${line}`).join('\n'));
    }
  }
}

if (listOnly) {
  console.log(`\n${[...tierOf].filter(([, tier]) => wanted.includes(tier)).length} check(s) selected`);
  process.exit(failed ? 1 : 0);
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} EXPECTED-SKIP`
            + ` — ${noBrowser} skipped for want of a browser`);
if (noBrowser && !strict) {
  console.log('Those were not verified. Re-run with --strict to treat them as failures.');
}
if (failed) process.exit(1);
