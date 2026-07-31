#!/usr/bin/env node
/**
 * Checks that every check says where it can run, and that the runner believes it.
 *
 * Nothing mechanical distinguished a check that runs anywhere from one that cannot run on a
 * hosted Linux runner. Five of them spawn `wsl.exe` and answer a skip without a distro;
 * `check-alt-arrow-accelerator.mjs` exits 0 on any platform that is not win32; sixty-nine
 * need a Chrome to drive; five assert this repository's own discipline — the board, the
 * README, the documentation index, the language rule, and how the board check behaves when
 * the history is cut — rather than the product's behaviour, and cannot be satisfied from a
 * clone that has neither the board nor the full history. A
 * runner picking a subset for a CI matrix had no way to ask which was which, and a check
 * that skips itself is indistinguishable from one that passed.
 *
 * So each check declares one `Tier:` in the banner it already carries, and this asserts:
 *
 *  1. **exactly one, and a known one.** No default anywhere: an unmarked check is this
 *     check going red, not a silent `fast` that runs a browser check on a box with no
 *     browser and reads the skip as a pass.
 *  2. **the tier matches what the file actually does.** Only the two mechanical cases are
 *     knowable from the source — a check that spawns `wsl.exe`, and one that goes looking
 *     for a Chrome — plus the platform gate a `windows` check has to carry. A check that
 *     quietly grows a Windows dependency inside an `if` is beyond this and is stated as a
 *     risk rather than pretended away.
 *  3. **`run-checks.mjs` selects by that tier, with no default of its own**, gives up a
 *     tier whose tool is not on the machine as EXPECTED-SKIP and exits 0, and does *not*
 *     do that for `browser`: a hosted runner with no Chrome is a broken runner, not a
 *     machine that was never going to run those checks.
 *  4. **`docs/running.md` says the same thing to a reader**, in a table, for all five.
 *
 * Section 3 drives the real `run-checks.mjs` against a fixture directory of stubs, and uses
 * its `--assume` seam to answer the capability probes, so the machine this runs on decides
 * nothing. No check under `scripts/` is executed and no browser is started.
 *
 * Offline and self-contained.
 *
 * Tier: fast
 *
 * Usage: node scripts/check-tiers.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = join(repoRoot, 'scripts');
const runner = join(scriptsDir, 'run-checks.mjs');

/** The five, and nothing else. A sixth name is a typo until this list says otherwise. */
const TIERS = ['fast', 'browser', 'windows', 'wsl', 'repo'];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * The file with its comments blanked out.
 *
 * The banners here discuss `wsl.exe` at length in prose — `check-no-color-env.mjs` explains
 * why a distro escapes the host's `NO_COLOR` without ever spawning one — so a mention is not
 * a dependency. Only what is left after the comments go is evidence about what the check
 * needs. Strings are left alone: `spawnSync('wsl.exe', …)` is the thing being looked for.
 */
function code(source) {
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
    } else if (here === '\n') { mode = 'code'; out += here; }
  }
  return out;
}

const checkFiles = readdirSync(scriptsDir)
  .filter((file) => /^check-.*\.mjs$/.test(file))
  .sort();

const sources = new Map(
  checkFiles.map((file) => [file, readFileSync(join(scriptsDir, file), 'utf8')])
);

/** `Tier:` lines, in the banner or out of it — a second one anywhere is still a second one. */
const declared = (source) => [...source.matchAll(/^\s*\*?\s*Tier:\s*(\S+)\s*$/gm)].map(([, tier]) => tier);

// ─── 1. Every check declares exactly one known tier ───────────

console.log('1. every check says which tier it belongs to');

check(`there are checks to inspect (${checkFiles.length} found)`, checkFiles.length > 0);

const unmarked = [];
const multiple = [];
const unknown = [];
const tierOf = new Map();

for (const file of checkFiles) {
  const tiers = declared(sources.get(file));
  if (tiers.length === 0) { unmarked.push(file); continue; }
  if (tiers.length > 1) { multiple.push(`${file} (${tiers.join(', ')})`); continue; }
  if (!TIERS.includes(tiers[0])) { unknown.push(`${file} (${tiers[0]})`); continue; }
  tierOf.set(file, tiers[0]);
}

check('every check carries a Tier: line', unmarked.length === 0,
      `${unmarked.length} without one: ${unmarked.slice(0, 8).join(', ')}${unmarked.length > 8 ? ', …' : ''}`);
check('no check carries two', multiple.length === 0, multiple.join(', '));
check(`every tier is one of ${TIERS.join(' | ')}`, unknown.length === 0, unknown.join(', '));

// ─── 2. The tier matches what the file needs ──────────────────

console.log('\n2. the tier a check declares is the tier it belongs to');

const spawnsWsl = (file) => /wsl\.exe/.test(code(sources.get(file)));
const wantsChrome = (file) => /findChrome|CHROME_PATH/.test(code(sources.get(file)));
const gatesOnPlatform = (file) => /process\.platform/.test(code(sources.get(file)));

/** Chrome is available to `windows` and `wsl` too: both are strictly narrower machines. */
const CHROME_TIERS = ['browser', 'windows', 'wsl'];

const wrongWsl = [];
const wrongChrome = [];
const wrongPlatform = [];
const pretendPortable = [];

/**
 * The checks whose tier cannot be inferred from their source, because their source is *about*
 * the evidence rather than an instance of it. Every other check is inferred; these two are held
 * to section 1 and to reading their own banner.
 *
 *   - `check-tiers.mjs` is the one place the evidence patterns are spelled out, so it matches
 *     all three of them and needs none of what they stand for;
 *   - `check-browser-strict.mjs` (#273) names `findChrome` and `CHROME_PATH` in order to assert
 *     that a check which cannot find a browser exits 3 rather than 0. It runs *without* one —
 *     that is the whole subject — so calling it `browser` would put the one check that proves
 *     the browser gate works behind the browser gate.
 *   - `check-wsl-windows-only.mjs` (#286) names `wsl.exe` in order to assert that a board off
 *     Windows never builds one. It is the same shape as the case above: the check needs no
 *     distro, and `wsl` is the one tier on which its subject — a machine without `wsl.exe` —
 *     is guaranteed not to hold.
 *   - `check-ci-workflow.mjs` (#280) names `CHROME_PATH` in order to assert that the browser
 *     job in `.github/workflows/ci.yml` exports one. It reads YAML and starts nothing, so it
 *     is the third of the same shape: the string is the subject rather than a dependency.
 */
const SELF_DESCRIBING = ['check-tiers.mjs', 'check-browser-strict.mjs', 'check-wsl-windows-only.mjs',
                         'check-ci-workflow.mjs'];

for (const [file, tier] of tierOf) {
  if (SELF_DESCRIBING.includes(file)) continue;
  if (spawnsWsl(file) && tier !== 'wsl') wrongWsl.push(`${file} spawns wsl.exe but declares ${tier}`);
  if (!spawnsWsl(file) && tier === 'wsl') wrongWsl.push(`${file} declares wsl but never spawns wsl.exe`);
  if (wantsChrome(file) && !CHROME_TIERS.includes(tier)) {
    wrongChrome.push(`${file} looks for a Chrome but declares ${tier}`);
  }
  if (!wantsChrome(file) && tier === 'browser') {
    wrongChrome.push(`${file} declares browser but never looks for a Chrome`);
  }
  if (tier === 'windows' && !gatesOnPlatform(file)) {
    wrongPlatform.push(`${file} declares windows but never reads process.platform`);
  }
  if ((tier === 'fast' || tier === 'repo') && (wantsChrome(file) || spawnsWsl(file))) {
    pretendPortable.push(`${file} declares ${tier} but needs a tool`);
  }
}

check('a check that spawns wsl.exe declares wsl, and only those do', wrongWsl.length === 0,
      wrongWsl.join('; '));
check('a check that looks for a Chrome declares browser, windows or wsl', wrongChrome.length === 0,
      wrongChrome.join('; '));
check('a windows check gates on process.platform', wrongPlatform.length === 0,
      wrongPlatform.join('; '));
check('nothing in fast or repo needs a tool', pretendPortable.length === 0,
      pretendPortable.join('; '));

/**
 * The five that assert this repository rather than the product. Named, because there is
 * nothing in a source file that distinguishes them: `check-readme.mjs` reads a tracked file
 * and so does `check-docs-encoding.mjs`, and only one of the two is about discipline the
 * maintainer's board has to be present for. `check-shallow-clone.mjs` is here for the other
 * half of the same prerequisite — it clones this repository at two depths and compares them,
 * so it needs the history the shallow one is missing.
 */
const REPO_CHECKS = ['check-board-map.mjs', 'check-readme.mjs', 'check-docs-index.mjs',
                     'check-english-only.mjs', 'check-shallow-clone.mjs'];
const repoDeclared = [...tierOf].filter(([, tier]) => tier === 'repo').map(([file]) => file).sort();
check('repo is the five discipline checks', repoDeclared.join(', ') === REPO_CHECKS.slice().sort().join(', '),
      `declared: ${repoDeclared.join(', ') || 'none'}`);

// ─── 3. The runner selects by tier, and skips only what it must ──

console.log('\n3. run-checks.mjs reads the tier, with no default');

/** A throwaway directory of stubs: the runner is pointed at this, never at `scripts/`. */
const fixture = mkdtempSync(join(tmpdir(), 'check-tiers-'));
const stub = (name, tier, exit) => {
  const banner = tier === null ? '/** A check nobody tiered. */' : `/**\n * A stub.\n *\n * Tier: ${tier}\n */`;
  writeFileSync(join(fixture, name), `${banner}\nprocess.exit(${exit});\n`);
};

try {
  mkdirSync(fixture, { recursive: true });
  stub('check-one.mjs', 'fast', 0);
  stub('check-two.mjs', 'fast', 0);
  stub('check-three.mjs', 'browser', 0);
  stub('check-four.mjs', 'wsl', 0);
  stub('check-five.mjs', 'repo', 0);
  stub('check-six.mjs', 'windows', 0);

  const run = (args) => {
    const result = spawnSync(process.execPath, [runner, '--dir', fixture, ...args], {
      encoding: 'utf8', cwd: repoRoot,
    });
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };

  const fast = run(['--tier', 'fast']);
  check('--tier fast runs the fast stubs and nothing else',
        fast.status === 0 && /check-one\.mjs/.test(fast.out) && /check-two\.mjs/.test(fast.out)
          && !/check-three\.mjs/.test(fast.out) && !/check-four\.mjs/.test(fast.out),
        `exit ${fast.status}\n${fast.out}`);

  // Per check, not the tally line at the end: "0 EXPECTED-SKIP" contains the word too.
  const skipped = (out) => [...out.matchAll(/^\s*EXPECTED-SKIP\s+(check-\S+)/gm)].map(([, file]) => file);

  // The done-when, literally: a machine with no wsl.exe gives the tier up rather than
  // failing it, and says EXPECTED-SKIP rather than passing quietly.
  const wsl = run(['--tier', 'wsl', '--assume', 'wsl=0']);
  check('--tier wsl with no wsl.exe is EXPECTED-SKIP and exits 0',
        wsl.status === 0 && skipped(wsl.out).join() === 'check-four.mjs' && !/\bPASS\b/.test(wsl.out),
        `exit ${wsl.status}\n${wsl.out}`);

  // And the other half of it: a runner with no Chrome is a runner that is set up wrong.
  const browser = run(['--tier', 'browser', '--assume', 'chrome=0']);
  check('--tier browser with no Chrome does not exit 0',
        browser.status !== 0 && skipped(browser.out).length === 0,
        `exit ${browser.status}\n${browser.out}`);

  const withChrome = run(['--tier', 'browser', '--assume', 'chrome=1']);
  check('--tier browser with a Chrome runs them', withChrome.status === 0 && /check-three\.mjs/.test(withChrome.out),
        `exit ${withChrome.status}\n${withChrome.out}`);

  stub('check-seven.mjs', null, 0);
  const untiered = run(['--tier', 'fast']);
  check('an unmarked check is a failure of the runner, not a silent fast',
        untiered.status !== 0 && /check-seven\.mjs/.test(untiered.out),
        `exit ${untiered.status}\n${untiered.out}`);
  rmSync(join(fixture, 'check-seven.mjs'));

  stub('check-eight.mjs', 'fast', 1);
  const failing = run(['--tier', 'fast']);
  check('a failing check fails the run', failing.status !== 0 && /check-eight\.mjs/.test(failing.out),
        `exit ${failing.status}\n${failing.out}`);
  rmSync(join(fixture, 'check-eight.mjs'));

  const unknownTier = run(['--tier', 'quick']);
  check('an unknown --tier is refused rather than matching nothing', unknownTier.status !== 0,
        `exit ${unknownTier.status}\n${unknownTier.out}`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

// ─── 4. A reader can find out the same thing ──────────────────

console.log('\n4. docs/running.md maps each tier to what it needs');

const running = readFileSync(join(repoRoot, 'docs', 'running.md'), 'utf8');
check('docs/running.md has a "Which checks run where" section',
      /^##\s+Which checks run where\s*$/m.test(running));

const table = running.split(/^##\s+/m).find((section) => section.startsWith('Which checks run where')) ?? '';
const rows = table.split(/\r?\n/).filter((line) => /^\s*\|/.test(line));
check('it is a table', rows.length >= TIERS.length + 2, `${rows.length} table row(s)`);
for (const tier of TIERS) {
  check(`the table names ${tier}`, rows.some((row) => new RegExp(`\\|[^|]*\\b${tier}\\b`).test(row)));
}

// The runner is a tracked file that `docs/index.md` and the board have to survive, and a
// check that names it while it is untracked would pass on this machine and nowhere else.
const tracked = execFileSync('git', ['ls-files', '-z', 'scripts'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
check('scripts/run-checks.mjs is tracked', tracked.includes('scripts/run-checks.mjs'),
      'the runner is what a CI matrix invokes; untracked, it exists on one machine');

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
