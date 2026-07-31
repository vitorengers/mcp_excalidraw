#!/usr/bin/env node
/**
 * Checks the three tracked double-click launchers, and the document that says why they are
 * the whole plan.
 *
 * The release promises a double-click on three platforms and there was nothing to
 * double-click: `git ls-files` matched no `.cmd`, `.bat`, `.ps1`, `.sh`, `.command` or
 * `.desktop` anywhere in the tree. The expensive part of that gap was never the missing
 * files — it was that no document said what the answer should be, so the next person to ask
 * would price a bundled runtime or a signed app without knowing either had been considered.
 *
 * So the rules are the two halves of that answer:
 *
 *  1. **the launchers themselves.** Three of them, tracked, all naming the same package at
 *     the same tag, with the two properties a Windows checkout gets wrong in silence — the
 *     executable bit on the macOS one, and CRLF on the Windows one;
 *  2. **the rejection is written down**, in a document a reader reaches from
 *     `docs/index.md`, naming Node SEA, Electron/Tauri and a signed app with a reason each.
 *
 * **The line-ending rule is about the working tree, not the index.** Git normalises text
 * blobs to LF on the way in whatever `eol=` says — `eol` decides checkout — so a `.cmd`
 * whose *index* blob were CRLF would be a `.cmd` marked binary, and
 * `check-tracked-file-modes.mjs` would fail it for exactly that. What has to be CRLF is the
 * file that lands on the user's disk, and what makes that true on every clone rather than on
 * the machine whose `core.autocrlf` happens to agree is `.gitattributes`. Both are asserted:
 * the pin, and the bytes it produces here.
 *
 * **The executable bit is asserted in the index, not on disk.** `core.filemode` is `false` on
 * a normal Windows checkout, so the working-tree stat says nothing about what a Linux or
 * macOS clone will get; `git ls-files -s` is the only place the answer lives.
 *
 * Section 1 runs the scanner against two throwaway repositories — one carrying every defect,
 * one carrying none — because a scanner that finds nothing and a scanner that cannot find
 * anything read identically against a clean tree. Section 2 is this repository, and section 3
 * is the document.
 *
 * Offline and self-contained: `git` against the index and the working tree, no server, no
 * browser, no network.
 *
 * Usage: node scripts/check-launchers.mjs [--repo <path>]
 *
 *   --repo  scan this checkout instead of the repository the script lives in, and skip both
 *           the fixtures and the document rules. This is how section 1 drives the scanner;
 *           it is a test seam, not a way to check somebody else's clone.
 *
 * Tier: fast
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The three files, and what each platform needs of it. */
const LAUNCHERS = [
  { path: 'launchers/vibemaxxing.cmd', eol: 'crlf', mode: '100644' },
  { path: 'launchers/VibeMaxxing.command', eol: 'lf', mode: '100755' },
  { path: 'launchers/vibemaxxing.desktop', eol: 'lf', mode: '100644' },
];

/**
 * The case names section 1 matches on. A rename here has to be a rename there: a fixture
 * that stops matching stops proving anything, and a name it cannot find goes red rather
 * than quietly passing.
 */
const CASE = {
  tracked: 'all three launchers are tracked',
  spec: 'all three invoke the same package at the same tag',
  latest: 'that tag is @latest',
  mode: 'the macOS launcher is mode 100755 in the index',
  eol: 'the .cmd is CRLF on disk and the other two are LF',
  pin: '.gitattributes pins those line endings for every clone',
};

/** What `.gitattributes` has to say for the working-tree endings to be a rule, not a habit. */
const PINS = [
  /^\*\.cmd\s+text\s+eol=crlf\s*$/m,
  /^\*\.desktop\s+text\s+eol=lf\s*$/m,
  /^\*\.command\s+text\s+eol=lf\s*$/m,
];

/** The three alternatives the document has to name, and a word that reads as a reason. */
const REJECTED = [
  { name: 'Node SEA', pattern: /\bSEA\b/ },
  { name: 'Electron or Tauri', pattern: /\bElectron\b/ },
  { name: 'Tauri', pattern: /\bTauri\b/ },
  { name: 'a signed app', pattern: /\bnotaris|\bnotariz|\bsign(ed|ing)\b/i },
];

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });

/** `git ls-files -s -z`: `<mode> <sha> <stage>\t<path>\0`. */
function trackedModes(cwd) {
  return git(cwd, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    return { mode: record.slice(0, 6), path: record.slice(tab + 1).split('\\').join('/') };
  });
}

/** What the bytes on disk actually are: `crlf`, `lf`, `mixed`, or `none` for a file with no break. */
function workingEol(cwd, path) {
  let text;
  try { text = readFileSync(join(cwd, path), 'latin1'); } catch { return 'absent'; }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  if (lf === 0) return 'none';
  if (crlf === lf) return 'crlf';
  if (crlf === 0) return 'lf';
  return 'mixed';
}

/**
 * Every `<package>@<tag>` an npm command in this text asks for.
 *
 * A scoped name starts with `@`, so the leading one is optional and the *last* `@` is the
 * separator. Nothing else in these files carries an `@`.
 */
function npmSpecs(text) {
  return [...text.matchAll(/(@?[A-Za-z0-9][A-Za-z0-9._~/-]*)@([A-Za-z0-9][A-Za-z0-9._-]*)/g)]
    .map(([, name, tag]) => `${name}@${tag}`);
}

/** The whole scanner. Everything above it is plumbing; everything below it is fixtures. */
function scan(cwd) {
  const tracked = trackedModes(cwd);
  const byPath = new Map(tracked.map((entry) => [entry.path, entry]));

  const missing = LAUNCHERS.filter((launcher) => !byPath.has(launcher.path));
  check(CASE.tracked, missing.length === 0,
        `${missing.length} not in git ls-files: ${missing.map((l) => l.path).join(', ')}`);

  const packageName = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name;
  const specs = new Map();
  for (const launcher of LAUNCHERS) {
    if (!byPath.has(launcher.path)) continue;
    specs.set(launcher.path, [...new Set(npmSpecs(git(cwd, ['cat-file', 'blob', `:${launcher.path}`])))]);
  }
  const flat = [...new Set([...specs.values()].flat())];
  check(CASE.spec,
        specs.size === LAUNCHERS.length
          && [...specs.values()].every((found) => found.length === 1)
          && flat.length === 1,
        [...specs].map(([path, found]) => `${path}: ${found.join(' + ') || 'none'}`).join(', '));
  check(CASE.latest, flat.length === 1 && flat[0] === `${packageName}@latest`,
        `${flat.join(', ') || 'nothing'} — expected ${packageName}@latest`);

  const wrongMode = LAUNCHERS
    .filter((launcher) => byPath.has(launcher.path))
    .filter((launcher) => byPath.get(launcher.path).mode !== launcher.mode);
  check(CASE.mode, wrongMode.length === 0,
        wrongMode.map((l) => `${l.path} is ${byPath.get(l.path).mode}, not ${l.mode}`).join(', '));

  const wrongEol = LAUNCHERS
    .map((launcher) => ({ ...launcher, found: workingEol(cwd, launcher.path) }))
    .filter((launcher) => launcher.found !== launcher.eol);
  check(CASE.eol, wrongEol.length === 0,
        wrongEol.map((l) => `${l.path} is ${l.found}, not ${l.eol}`).join(', '));

  let attributes = '';
  try { attributes = git(cwd, ['cat-file', 'blob', ':.gitattributes']); } catch { /* absent */ }
  const unpinned = PINS.filter((pattern) => !pattern.test(attributes)).map(String);
  check(CASE.pin, unpinned.length === 0,
        unpinned.join(', ') || 'without it a clone gets whatever its core.autocrlf decides');
}

if (target) {
  scan(target);
  if (failures) process.exit(1);
  process.exit(0);
}

// ─── 1. The scanner catches what it exists for ────────────────

console.log('1. the scanner catches a launcher that would not run');

/**
 * A throwaway repository, built with `core.autocrlf=false` so what this script writes is what
 * the index gets. With `autocrlf=true` — the development machine's setting — the fixtures
 * would be normalised on the way in and the defective one would be clean.
 */
function fixtureRepo(build) {
  const dir = mkdtempSync(join(tmpdir(), 'check-launchers-'));
  git(dir, ['-c', 'init.defaultBranch=main', 'init', '-q']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  mkdirSync(join(dir, 'launchers'));
  writeFileSync(join(dir, 'package.json'), '{ "name": "@acme/widget", "version": "0.0.0" }\n');
  build(dir);
  git(dir, ['add', '-A', '--']);
  return dir;
}

/** Run this script against a fixture and report which of its six cases went red. */
function scanFixture(dir) {
  const run = spawnSync(process.execPath, [selfPath, '--repo', dir], { encoding: 'utf8' });
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failed = new Set();
  for (const [key, name] of Object.entries(CASE)) {
    if (output.includes(`FAIL  ${name}`)) failed.add(key);
  }
  return { status: run.status, output, failed };
}

const ATTRIBUTES = '* text=auto eol=lf\n*.cmd text eol=crlf\n*.command text eol=lf\n'
  + '*.desktop text eol=lf\n';

/** Every defect at once: no pin, LF in the .cmd, no executable bit, and a drifted tag. */
const dirty = fixtureRepo((dir) => {
  writeFileSync(join(dir, 'launchers', 'vibemaxxing.cmd'),
                '@echo off\ncall npx -y @acme/widget@latest\n');
  writeFileSync(join(dir, 'launchers', 'VibeMaxxing.command'),
                '#!/bin/sh\nnpx -y @acme/widget@0.1.0\n');
});

/** Nothing wrong with it, including the third launcher the defective one never wrote. */
const clean = fixtureRepo((dir) => {
  writeFileSync(join(dir, '.gitattributes'), ATTRIBUTES);
  writeFileSync(join(dir, 'launchers', 'vibemaxxing.cmd'),
                '@echo off\r\ncall npx -y @acme/widget@latest\r\n');
  writeFileSync(join(dir, 'launchers', 'VibeMaxxing.command'),
                '#!/bin/sh\nnpx -y @acme/widget@latest\n');
  writeFileSync(join(dir, 'launchers', 'vibemaxxing.desktop'),
                '[Desktop Entry]\nExec=sh -c "npx -y @acme/widget@latest"\nTerminal=false\n');
});
git(clean, ['update-index', '--chmod=+x', 'launchers/VibeMaxxing.command']);

try {
  const bad = scanFixture(dirty);
  check('a missing launcher is caught', bad.failed.has('tracked'), bad.output.trim());
  check('two launchers asking for different versions is caught', bad.failed.has('spec'));
  check('a tag that is not @latest is caught', bad.failed.has('latest'));
  check('a .command tracked at 100644 is caught', bad.failed.has('mode'));
  check('an LF .cmd is caught', bad.failed.has('eol'));
  check('an unpinned .gitattributes is caught', bad.failed.has('pin'));
  check('the defective fixture exits non-zero', bad.status === 1, `exit ${bad.status}`);

  const good = scanFixture(clean);
  check('a checkout with none of them is passed', good.failed.size === 0, good.output.trim());
  check('the clean fixture exits zero', good.status === 0, `exit ${good.status}`);
} finally {
  rmSync(dirty, { recursive: true, force: true });
  rmSync(clean, { recursive: true, force: true });
}

// ─── 2. This repository ───────────────────────────────────────

console.log('\n2. this checkout ships three launchers that would run');

scan(repoRoot);

// ─── 3. And the rejection is written down ─────────────────────

console.log('\n3. the document says what was chosen and what was not');

const DOC = 'docs/launchers.md';
const trackedHere = git(repoRoot, ['ls-files', '-z']).split('\0').filter(Boolean)
  .map((path) => path.split('\\').join('/'));

check(`${DOC} is tracked`, trackedHere.includes(DOC),
      'a plan of record that is not in the tree is a conversation somebody remembers');

if (trackedHere.includes(DOC)) {
  const doc = readFileSync(join(repoRoot, DOC), 'utf8');
  for (const { name, pattern } of REJECTED) {
    check(`it names ${name}`, pattern.test(doc),
          'the point of the document is the alternatives, not the files');
  }
  // A name with no reason beside it is a list, and the next person prices it again.
  check('it gives reasons rather than a list', /\bbecause\b|\bcannot\b|\bwould\b/i.test(doc));
  check('it names all three launchers',
        LAUNCHERS.every((launcher) => doc.includes(launcher.path)));

  const index = readFileSync(join(repoRoot, 'docs', 'index.md'), 'utf8');
  check('docs/index.md links to it', /\]\(launchers\.md\)/.test(index),
        'a document nobody links to is a document nobody opens');
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
