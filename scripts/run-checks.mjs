#!/usr/bin/env node
/**
 * Runs the check suite and says how much of it actually ran.
 *
 * A green run that launched no browser is the failure mode #273 is about: every browser
 * check used to print `SKIPPED` and exit 0, which is the same exit code as a pass, so a CI
 * job with no Chrome on it reported the whole tier green having measured nothing. Since #273
 * a check that cannot find a browser exits **3** under `CHECK_STRICT`, and this runner is the
 * thing that reads that code — as SKIP normally, as FAIL under `--strict`, and either way as
 * a number printed at the end of every run. A run that says "62 skipped for want of a
 * browser" cannot be mistaken for a run that verified anything.
 *
 * Children are always spawned with `CHECK_STRICT=1`, whatever this runner was given. That is
 * not the runner passing its own strictness down: it is how a skip becomes visible at all.
 * Without it a skipping check exits 0 and there is nothing to count. `--strict` is this
 * runner's own decision about what to do with the count it gets back.
 *
 * **This is the small runner #273 needed, not the whole one.** #275 owns `--skip`, `--jobs`,
 * per-child timeouts, the `os.tmpdir()` reaping and the `npm test` wiring; #272 owns the
 * `Tier:` banner line that `--tier` should be reading. Until #272 lands, a check with no
 * `Tier:` line is classified by what it imports — a check that imports the shared Chrome
 * probe is in the browser tier, which is exactly the cross-assertion #272 specifies. Where a
 * `Tier:` line is present it wins, so this keeps working as those land.
 *
 * Usage: node scripts/run-checks.mjs [--tier <name>] [--only <glob>] [--strict]
 */

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const wantedTier = argOf('--tier');
const only = argOf('--only');
const strict = process.argv.includes('--strict');

/** `check-docs-*` → a regular expression over the file name. */
const globToRegExp = (glob) =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/**
 * The tier a check declares, or the one its imports give it away as.
 *
 * `Tier:` is #272's banner line and is authoritative where it exists. The fallback is
 * deliberately narrow: `browser` for anything importing the shared probe, `unclassified` for
 * everything else. Guessing `fast` for an unmarked check is the mistake #272 names — it would
 * put a Windows-only or WSL-only check into a Linux run and call the skip a pass.
 */
function tierOf(file) {
  const source = readFileSync(join(scriptsDir, file), 'utf8');
  const declared = source.match(/^\s*\*\s*Tier:\s*(\S+)/m);
  if (declared) return declared[1];
  if (/from '\.\/lib\/find-chrome\.mjs'/.test(source)) return 'browser';
  return 'unclassified';
}

let files = readdirSync(scriptsDir)
  .filter((name) => name.startsWith('check-') && name.endsWith('.mjs'))
  .sort();

if (only) {
  const pattern = globToRegExp(only.endsWith('.mjs') ? only : `${only}.mjs`);
  files = files.filter((name) => pattern.test(name));
}
if (wantedTier) files = files.filter((name) => tierOf(name) === wantedTier);

if (files.length === 0) {
  console.error('no checks matched — nothing was run, which is not the same as everything passing');
  process.exit(1);
}

console.log(`run-checks — ${files.length} check(s)${wantedTier ? ` in tier "${wantedTier}"` : ''}${only ? ` matching "${only}"` : ''}`);
if (strict) console.log('--strict: a check that cannot find its browser is a failure, not a skip.\n');
else console.log('');

/** Exit 3 is the shared Chrome probe saying it found no browser. See scripts/lib/find-chrome.mjs. */
const NO_BROWSER = 3;

const runOne = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(scriptsDir, file)], {
    env: { ...process.env, CHECK_STRICT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => resolve({ code: 1, output: `${output}\n${error.message}` }));
  child.on('close', (code) => resolve({ code: code ?? 1, output }));
});

const results = [];
for (const file of files) {
  const { code, output } = await runOne(file);
  results.push({ file, code });
  if (code === 0) {
    console.log(`  PASS  ${file}`);
  } else if (code === NO_BROWSER) {
    console.log(`  ${strict ? 'FAIL' : 'SKIP'}  ${file} — no browser`);
    if (strict) console.log(output.split(/\r?\n/).map((line) => `        ${line}`).join('\n'));
  } else {
    console.log(`  FAIL  ${file} (exit ${code})`);
    console.log(output.split(/\r?\n/).map((line) => `        ${line}`).join('\n'));
  }
}

const noBrowser = results.filter((result) => result.code === NO_BROWSER).length;
const passed = results.filter((result) => result.code === 0).length;
const failed = results.length - passed - (strict ? 0 : noBrowser);

// The census. Printed on every run, passing or not: the point of it is that a green run has
// to say out loud how much of itself it did not execute.
console.log(`\n${results.length} check(s): ${passed} passed, ${failed} failed, ` +
            `${noBrowser} skipped for want of a browser`);
if (noBrowser && !strict) {
  console.log('Those were not verified. Re-run with --strict to treat them as failures.');
}

process.exit(failed > 0 || (strict && noBrowser > 0) ? 1 : 0);
