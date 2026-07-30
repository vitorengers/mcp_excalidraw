#!/usr/bin/env node
/**
 * Does a check that cannot find a browser say so loudly enough for a runner to hear it?
 *
 * Sixty-nine checks drive Chrome over CDP, and every one of them used to answer "no browser
 * here" with `console.log('SKIPPED')` and `process.exit(0)` — the same exit code as a pass.
 * Put the suite in CI as it stood and the entire browser tier, the one category `CLAUDE.md`
 * exists to defend, reports green having launched nothing. #273 makes that exit **3** under
 * `CHECK_STRICT`, and this asserts the three halves of that: the exit code, the single
 * candidate list behind it, and the runner census that makes the number visible.
 *
 * No browser of its own. Every case here is a check *not* finding one, which is the whole
 * point — it runs identically on a machine with Chrome and on one without, because it points
 * `CHROME_PATH` at a file that does not exist. That only works because `CHROME_PATH` is
 * authoritative rather than the first entry of a fallback chain: on the maintainer's Windows
 * box a real Chrome sits at the first hard-coded candidate, so a probe that fell through to
 * it would make the skip path unreachable and this check untestable where it was written.
 *
 * Section 3 reads the other checks as text rather than running them. That is the only way to
 * assert "the shared probe is the *only* copy" — a check that still carries its own list
 * behaves identically until the day the lists disagree, which is exactly how
 * `check-alt-arrow-accelerator.mjs` came to have no macOS or Linux entry.
 *
 * Usage: node scripts/check-browser-strict.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** A path that cannot exist on any of the three platforms this suite claims to run on. */
const NO_SUCH_CHROME = '/nonexistent-chrome-for-check-browser-strict';

const run = (args, env = {}) => {
  const result = spawnSync(process.execPath, args, {
    cwd: join(scriptsDir, '..'),
    encoding: 'utf8',
    env: { ...process.env, CHROME_PATH: NO_SUCH_CHROME, CHECK_STRICT: '', ...env },
  });
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const SUBJECT = join(scriptsDir, 'check-board-landing-browser.mjs');

// ─── 1. Without strict mode, a missing browser is still a quiet skip ──────────

console.log('1. no browser and no CHECK_STRICT — SKIPPED, exit 0');

const lenient = run([SUBJECT]);
check('exits 0', lenient.code === 0, `exit ${lenient.code}`);
check('says SKIPPED', lenient.output.includes('SKIPPED'),
      'the operator running one check by hand still gets a skip, not a failure');

const offSwitch = run([SUBJECT], { CHECK_STRICT: '0' });
check('CHECK_STRICT=0 is off, not "set"', offSwitch.code === 0, `exit ${offSwitch.code}`);

// ─── 2. Under strict mode, it is exit 3 and it names what it tried ────────────

console.log('\n2. no browser under CHECK_STRICT — exit 3, naming the paths');

const strictEnv = run([SUBJECT], { CHECK_STRICT: '1' });
check('exits 3', strictEnv.code === 3,
      `exit ${strictEnv.code} — 0 would be indistinguishable from a pass to a runner`);
check('names the path it tried', strictEnv.output.includes(NO_SUCH_CHROME),
      'a strict failure that does not say where it looked cannot be acted on');
check('says why it is exit 3', /CHECK_STRICT/.test(strictEnv.output));

const strictFlag = run([SUBJECT, '--strict'], { CHECK_STRICT: '' });
check('--strict does the same as CHECK_STRICT=1', strictFlag.code === 3, `exit ${strictFlag.code}`);

const namedMissing = run([SUBJECT, '--chrome', NO_SUCH_CHROME], { CHROME_PATH: '', CHECK_STRICT: '1' });
check('--chrome at a missing file is exit 3 too', namedMissing.code === 3, `exit ${namedMissing.code}`);
check('and names the path --chrome gave it', namedMissing.output.includes(NO_SUCH_CHROME));

// ─── 3. One candidate list, and every check reads it ──────────────────────────

console.log('\n3. scripts/lib/find-chrome.mjs is the only copy');

const libPath = join(scriptsDir, 'lib', 'find-chrome.mjs');
check('the shared probe exists', existsSync(libPath), 'scripts/lib/find-chrome.mjs');

const libSource = existsSync(libPath) ? readFileSync(libPath, 'utf8') : '';
for (const candidate of ['/usr/bin/chromium-browser', '/snap/bin/chromium']) {
  check(`the POSIX candidates include ${candidate}`, libSource.includes(candidate));
}

/**
 * The literals that make a file a second copy of the list. Matching on the vendor directory
 * rather than on `.exe` keeps this from firing on a check that merely mentions "chrome".
 */
const CANDIDATE_MARKERS = [
  'Google/Chrome/Application',
  'Microsoft/Edge/Application',
  'Google Chrome.app/Contents/MacOS',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sourceFiles = [];
const walk = (dir, prefix = '') => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (entry.name.endsWith('.mjs')) sourceFiles.push({ rel: `${prefix}${entry.name}`, abs: join(dir, entry.name) });
  }
};
walk(scriptsDir);

// This file is the other place those literals are allowed: it has to name them to look for
// them. Everything else naming one is a second copy of the list.
const ALLOWED_TO_NAME_THEM = ['lib/find-chrome.mjs', 'check-browser-strict.mjs'];

const duplicates = sourceFiles.filter(({ rel, abs }) =>
  !ALLOWED_TO_NAME_THEM.includes(rel) &&
  CANDIDATE_MARKERS.some((marker) => readFileSync(abs, 'utf8').includes(marker)));
check('no other file in scripts/ names a Chrome candidate path', duplicates.length === 0,
      duplicates.map(({ rel }) => rel).join(', '));

const importers = sourceFiles.filter(({ abs }) =>
  /from '\.\.?\/(?:lib\/)?find-chrome\.mjs'/.test(readFileSync(abs, 'utf8')));
check('the checks that need a browser import it', importers.length >= 60,
      `${importers.length} file(s) import the shared probe`);

const acceleratorSource = readFileSync(join(scriptsDir, 'check-alt-arrow-accelerator.mjs'), 'utf8');
check('check-alt-arrow-accelerator.mjs uses the shared probe too',
      /from '\.\/lib\/find-chrome\.mjs'/.test(acceleratorSource),
      'it was the one with no macOS or Linux candidate at all');

// ─── 4. The runner reads exit 3, and prints the census either way ─────────────

console.log('\n4. run-checks.mjs counts the skips and can be made to fail on them');

const runnerPath = join(scriptsDir, 'run-checks.mjs');
check('the runner exists', existsSync(runnerPath), 'scripts/run-checks.mjs');

// A narrow slice of the browser tier: the census arithmetic is the same for four checks as
// for sixty-nine, and sixty-nine subprocesses is minutes of wall clock for no extra assertion.
// These four probe for a browser before they do anything else, so the slice skips in
// milliseconds and — unlike the checks that run offline cases first — needs no built `dist/`.
const SLICE = 'check-terminal-f*-browser';

const census = run([runnerPath, '--tier', 'browser', '--only', SLICE], { CHECK_STRICT: '' });
const counted = census.output.match(/(\d+) skipped for want of a browser/);
check('the census says how many were skipped for want of a browser', Boolean(counted),
      census.output.trim().split(/\r?\n/).slice(-3).join(' | '));
check('and the number is not zero here', counted && Number(counted[1]) > 0,
      counted ? `counted ${counted[1]}` : 'no census line at all');
check('a run with nothing but skips still exits 0 without --strict', census.code === 0,
      `exit ${census.code}`);

const strictCensus = run([runnerPath, '--tier', 'browser', '--only', SLICE, '--strict'], { CHECK_STRICT: '' });
check('--strict turns those skips into a non-zero exit', strictCensus.code !== 0,
      `exit ${strictCensus.code}`);
check('--strict still prints the census', /skipped for want of a browser/.test(strictCensus.output));

// The runner must not report a check it never ran as anything at all.
const nothing = run([runnerPath, '--only', 'check-there-is-no-such-check'], { CHECK_STRICT: '' });
check('matching no checks is an error, not an empty green run', nothing.code !== 0,
      `exit ${nothing.code}`);

console.log(failures === 0
  ? '\nall cases passed'
  : `\n${failures} case(s) failed`);
process.exit(failures === 0 ? 0 : 1);
