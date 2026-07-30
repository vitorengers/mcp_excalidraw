#!/usr/bin/env node
/**
 * Checks that the index pins LF, and that a shipped launcher is tracked executable.
 *
 * Both facts are currently true of this tree by accident rather than by rule, and both are
 * invisible until somebody on another platform pays for them.
 *
 *  1. **Line endings.** There was no `.gitattributes`, so every contributor's own
 *     `core.autocrlf` decided what went into the index. It happens to be `true` on the
 *     development machine, which is why all 299 tracked text blobs are `i/lf` today; the
 *     Windows default when git is installed without the recommended option is `false`, and
 *     that commits CRLF. A shell launcher committed that way fails on Linux with
 *     `bad interpreter: /bin/sh^M`, a message that points nowhere near the cause.
 *  2. **The executable bit.** `core.filemode` is `false` on the development machine, so a
 *     `run.sh` or `run.command` added there lands as `100644` whatever its permissions look
 *     like locally: `Permission denied` on Linux, and a macOS double-click opens it in a text
 *     editor. `git update-index --chmod=+x` is the only way to set the mode from such a
 *     checkout, and it is easy to forget on a later edit — which is why this exists rather
 *     than the convention.
 *
 * There is no `*.sh` or `*.command` in `git ls-files` yet. This lands before the per-OS
 * launchers precisely so that the first one to arrive cannot arrive broken, which means the
 * mode rule has nothing real to bite on and the LF rule bites on a tree that is already
 * clean. A scanner that finds nothing and a scanner that cannot find anything read
 * identically against a clean tree, so section 1 builds two throwaway git repositories — one
 * carrying both defects, one carrying neither — and runs *this script* against each through
 * `--repo`. Section 2 is then the real tree, and the fixtures are what says its silence means
 * something.
 *
 * The `.gitattributes` rule is here too because nothing else would notice its removal, and
 * removing it puts rule 1 straight back to luck: the index would stay LF for exactly as long
 * as no one with a different `core.autocrlf` touched it.
 *
 * Offline and self-contained: `git` against the index, no server, no browser, no network.
 *
 * Usage: node scripts/check-tracked-file-modes.mjs [--repo <path>]
 *
 *   --repo  scan this checkout instead of the repository the script lives in, and skip the
 *           fixtures. This is how section 1 drives the scanner; it is a test seam, not a way
 *           to check somebody else's clone.
 *
 * Tier: fast
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const selfPath = fileURLToPath(import.meta.url);

const repoFlag = process.argv.indexOf('--repo');
const target = repoFlag !== -1 && process.argv[repoFlag + 1] ? process.argv[repoFlag + 1] : null;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * The four names section 1 matches on. They are the scanner's whole vocabulary, so a rename
 * here has to be a rename there — which is the point: a fixture that stops matching stops
 * proving anything, and a name it cannot find is a red case rather than a quiet pass.
 */
const CASE = {
  attributes: '.gitattributes is tracked',
  pins: '.gitattributes pins LF for the index and for the launchers',
  lf: 'every tracked text blob is LF in the index',
  mode: 'every tracked *.sh and *.command is mode 100755',
};

/** What `.gitattributes` has to say. `demo.gif binary` is checked as a pattern, not a path. */
const PINS = [
  /^\*\s+text=auto\s+eol=lf\s*$/m,
  /^\*\.sh\s+text\s+eol=lf\s*$/m,
  /^\*\.command\s+text\s+eol=lf\s*$/m,
  /^\*\.mjs\s+text\s+eol=lf\s*$/m,
  /^\*\.excalidraw\s+text\s+eol=lf\s*$/m,
  /^demo\.gif\s+binary\s*$/m,
];

/** Index end-of-line states that are not a defect: LF, a binary blob, and a file with none. */
const ALLOWED_EOL = new Set(['lf', '-text', 'none']);

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });

/** `git ls-files -s -z`: `<mode> <sha> <stage>\t<path>\0`. */
function trackedModes(cwd) {
  return git(cwd, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    return { mode: record.slice(0, 6), path: record.slice(tab + 1) };
  });
}

/** `git ls-files --eol -z`: `i/<state> w/<state> attr/<...>\t<path>\0`. */
function trackedEol(cwd) {
  return git(cwd, ['ls-files', '--eol', '-z']).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const index = /^i\/(\S+)/.exec(record);
    return { eol: index ? index[1] : '?', path: record.slice(tab + 1) };
  });
}

const isLauncher = (path) => /\.(sh|command)$/i.test(path);

/** The whole scanner. Everything above it is plumbing; everything below it is fixtures. */
function scan(cwd) {
  const tracked = trackedModes(cwd);
  const attributes = tracked.find((entry) => entry.path === '.gitattributes');
  check(CASE.attributes, Boolean(attributes),
        'without it the index is LF only for as long as everyone\'s core.autocrlf agrees');

  let text = '';
  if (attributes) text = git(cwd, ['cat-file', 'blob', `:${'.gitattributes'}`]);
  const missing = PINS.filter((pattern) => !pattern.test(text)).map((pattern) => String(pattern));
  check(CASE.pins, attributes && missing.length === 0, missing.join(', '));

  const wrongEol = trackedEol(cwd).filter((entry) => !ALLOWED_EOL.has(entry.eol));
  check(CASE.lf, wrongEol.length === 0,
        `${wrongEol.length}: ${wrongEol.slice(0, 6).map((e) => `${e.path} (i/${e.eol})`).join(', ')}`);

  const wrongMode = tracked.filter((entry) => isLauncher(entry.path) && entry.mode !== '100755');
  check(CASE.mode, wrongMode.length === 0,
        `${wrongMode.length}: ${wrongMode.slice(0, 6).map((e) => `${e.path} (${e.mode})`).join(', ')}`);
}

if (target) {
  scan(target);
  if (failures) process.exit(1);
  process.exit(0);
}

// ─── 1. The scanner finds the defects it exists for ───────────

console.log('1. the scanner catches a CRLF blob and a launcher that is not executable');

/**
 * A throwaway repository, built with `core.autocrlf=false` so what this script writes is what
 * the index gets. With `autocrlf=true` — the development machine's setting — the CRLF fixture
 * would be silently normalised on the way in and the defective repository would be clean.
 */
function fixtureRepo(build) {
  const dir = mkdtempSync(join(tmpdir(), 'tracked-modes-'));
  // The branch name is named so a runner with no `init.defaultBranch` does not print its hint.
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  build(dir);
  return dir;
}

/** Run this script against a fixture and report which of its four cases went red. */
function scanFixture(dir) {
  const run = spawnSync(process.execPath, [selfPath, '--repo', dir], { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failed = new Set();
  for (const [key, name] of Object.entries(CASE)) {
    if (output.includes(`FAIL  ${name}`)) failed.add(key);
  }
  return { status: run.status, output, failed };
}

const dirty = fixtureRepo((dir) => {
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\r\nexec node dist/server.js\r\n');
  writeFileSync(join(dir, 'notes.md'), 'A tracked document, committed from a Windows box.\r\n');
  git(dir, ['add', '--', 'run.sh', 'notes.md']);
});

const clean = fixtureRepo((dir) => {
  writeFileSync(join(dir, '.gitattributes'),
                '* text=auto eol=lf\n*.sh text eol=lf\n*.command text eol=lf\n'
                + '*.mjs text eol=lf\n*.excalidraw text eol=lf\ndemo.gif binary\n');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\nexec node dist/server.js\n');
  writeFileSync(join(dir, 'notes.md'), 'A tracked document, committed from a Linux box.\n');
  git(dir, ['add', '--', '.gitattributes', 'run.sh', 'notes.md']);
  git(dir, ['update-index', '--chmod=+x', 'run.sh']);
});

try {
  const bad = scanFixture(dirty);
  check('a CRLF blob in the index is caught', bad.failed.has('lf'), bad.output.trim());
  check('a *.sh tracked at 100644 is caught', bad.failed.has('mode'), bad.output.trim());
  check('a missing .gitattributes is caught', bad.failed.has('attributes'));
  check('the defective fixture exits non-zero', bad.status === 1, `exit ${bad.status}`);

  const good = scanFixture(clean);
  check('a checkout with none of the three is passed', good.failed.size === 0, good.output.trim());
  check('the clean fixture exits zero', good.status === 0, `exit ${good.status}`);
} finally {
  rmSync(dirty, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
}

// ─── 2. This repository ───────────────────────────────────────

console.log('\n2. this checkout is LF in the index, and its launchers are executable');

scan(repoRoot);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
