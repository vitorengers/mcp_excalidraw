/**
 * Where this machine keeps Chrome, and what a check does when it is not there.
 *
 * Sixty-nine checks drive a browser over CDP, and until #273 each of them carried its own
 * copy of the candidate list and its own `process.exit(0)` when the list came up empty. Two
 * things were wrong with that, and only the second is about duplication:
 *
 *   - the copies had drifted — `check-alt-arrow-accelerator.mjs` had no macOS or Linux entry
 *     at all, so on a Mac it skipped with a Chrome sitting in `/Applications`;
 *   - **a skip and a pass are the same exit code.** Put the suite in CI as it stood and the
 *     whole browser tier reports green having launched nothing. That is the category
 *     `CLAUDE.md` exists to defend: three defects compiled perfectly and did none of what
 *     they claimed, and only a browser caught them.
 *
 * So there is a strict mode, `CHECK_STRICT=1` or `--strict`, in which a check that cannot
 * find a browser exits **3** and names every path it tried. The decision is the exit code
 * rather than a marker on stdout: a runner has to be able to classify a check that died
 * before it printed anything, and exit codes survive that where stdout does not. 3 is
 * otherwise unused here — 0 is a pass, 1 is a failure, and anything else is a crash.
 *
 * `CHROME_PATH` is **authoritative**, the same way `--chrome` already was: naming a browser
 * that is not there is an error, not a reason to fall back to a browser somewhere else. The
 * fallback chain is for a machine that has said nothing about which browser it wants; a
 * machine that named one and got a different one has been lied to, and on the maintainer's
 * Windows box — where a real Chrome sits at the first hard-coded candidate — a
 * fall-through would make `CHROME_PATH=/nonexistent` unable to exercise the skip path at all.
 */

import { existsSync } from 'node:fs';

/**
 * The hard-coded candidates, in the order they are tried. This list is the only one in
 * `scripts/`; `check-browser-strict.mjs` asserts that no other file names such a path.
 *
 * `/snap/bin/chromium` is deliberately **last**, after every ordinary install path. A
 * snap-confined Chromium launches under a different sandbox posture and CDP may not attach
 * the same way, which would turn a clean skip into a browser that starts and then fails for
 * an unrelated reason — a worse signal than skipping. Ordered last, it is only ever reached
 * on a machine that has no explicitly installed Chrome for it to be measured against.
 */
export const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

const argOf = (name, argv) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};

/** `CHECK_STRICT=1` in the environment, or `--strict` on the command line. */
export function strictChecks(argv = process.argv, env = process.env) {
  if (argv.includes('--strict')) return true;
  const value = env.CHECK_STRICT;
  return typeof value === 'string' && value !== '' && value !== '0' && value !== 'false';
}

/**
 * What the probe would look at, in order, and where each entry came from — so that a strict
 * skip can say what it tried rather than only that it failed.
 *
 * When `--chrome` or `CHROME_PATH` names a browser the list is *just* that one: both are
 * authoritative, and reporting the fallbacks alongside them would suggest they were consulted.
 */
export function chromeSearchPaths(argv = process.argv, env = process.env) {
  const named = argOf('--chrome', argv);
  if (named) return [{ path: named, source: '--chrome' }];
  if (env.CHROME_PATH) return [{ path: env.CHROME_PATH, source: 'CHROME_PATH' }];
  return CHROME_CANDIDATES.map((path) => ({ path, source: 'built-in candidate' }));
}

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
export function findChrome(argv = process.argv, env = process.env) {
  return chromeSearchPaths(argv, env).find(({ path }) => existsSync(path))?.path ?? null;
}

/**
 * The end of a check that found no browser: print why, then exit 0, 3 or 1.
 *
 * Never returns. `failures` is what the check had already counted before it got here — a
 * check with real failures behind it exits 1 whatever the browser situation, because a skip
 * must not launder a failure into a pass or into a skip.
 *
 * @param {object}   [options]
 * @param {string}   [options.what]     completes "no Chrome or Edge found, so ..."
 * @param {string}   [options.lead]     printed before `SKIPPED`, for checks that want a blank line
 * @param {Function} [options.before]   cleanup, run before anything is printed
 * @param {Function} [options.after]    printed last, when there is nothing to fail on
 * @param {number}   [options.failures] cases this check has already failed
 * @param {boolean}  [options.quiet]    the caller printed its own SKIPPED line
 */
export function skipWithoutChrome({
  what = 'the browser half was not run.',
  lead = '',
  before,
  after,
  failures = 0,
  quiet = false,
  argv = process.argv,
  env = process.env,
} = {}) {
  before?.();

  const strict = strictChecks(argv, env);
  if (!quiet) {
    console.log(`${lead}SKIPPED — no Chrome or Edge found, so ${what}`);
    console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  }
  if (strict) {
    console.log('        CHECK_STRICT is set, so this is exit 3 rather than a silent pass.');
    console.log('        Tried, in order:');
    for (const { path, source } of chromeSearchPaths(argv, env)) {
      console.log(`          ${path}  (${source})`);
    }
  }

  if (failures) {
    console.error(`\n${failures} case(s) failed`);
    process.exit(1);
  }
  after?.();
  process.exit(strict ? 3 : 0);
}
