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
 * Usage: node scripts/run-checks.mjs [--tier <name>[,<name>…]] [--list]
 *                                    [--dir <path>] [--assume <cap>=0|1]
 *
 *   --tier    one or more tiers to run; every tier when it is left out
 *   --list    print what would run, and run nothing
 *   --dir     look for the checks somewhere other than `scripts/` (used by check-tiers.mjs)
 *   --assume  answer a capability probe — chrome, win32, wsl or history — instead of
 *             asking this machine. A test seam, so a check of the tier gate does not
 *             depend on whether the machine running it happens to have a distro.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const assumed = new Map(values('--assume').map((pair) => {
  const [capability, value] = pair.split('=');
  return [capability, value !== '0' && value !== 'false'];
}));

// ─── What this machine can do ─────────────────────────────────

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
function hasChrome() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].some((path) => path && existsSync(path));
}

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
    const result = spawnSync(process.execPath, [join(dir, file)], { encoding: 'utf8', cwd: repoRoot });
    const seconds = (Number(process.hrtime.bigint() - started) / 1e9).toFixed(1);
    if (result.status === 0) {
      passed++;
      console.log(`  PASS  ${file} (${seconds}s)`);
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

console.log(`\n${passed} passed, ${failed} failed, ${skipped} EXPECTED-SKIP`);
if (failed) process.exit(1);
