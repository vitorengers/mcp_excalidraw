#!/usr/bin/env node
/**
 * Checks that the repository root cannot collect a stranger's debris, and that no tracked
 * document names somebody's home directory.
 *
 * Eighteen loose PNGs sat in the working tree root of the machine this tool was written on —
 * `image.png` through `image10.png`, `issuefarolwsl.png`, `recover issues.png` with a space in
 * the name — beside a `HANDOFF.md` written in Portuguese that called this a private fork and
 * hardcoded one person's `powershell -File C:/Users/…/start-board.ps1`. All of it untracked,
 * and `.gitignore` had no rule for an image, so a single `git add .` would have swept every
 * one of them into a commit. Nothing would have failed on the way in; the first thing to go
 * red would have been `check-english-only.mjs`, which scans every root-level file with a
 * scanned extension — and it has nothing to say about a PNG at all.
 *
 * Two rules, and they are the two a merge can actually enforce:
 *
 *  1. **the root ignores images.** A rule anchored to `/`, so a screenshot dropped where the
 *     browser puts it is invisible to `git add .`, while `docs/media/` and any image the
 *     frontend imports stay committable — a screenshot the documentation points at is a file
 *     somebody chose, and this is about the ones nobody did.
 *  2. **no tracked Markdown names a real home directory.** `C:/Users/you`, `/home/me` and
 *     `/Users/me` are worked examples and pass; a login name does not. The scan is for the
 *     shape rather than for one login, which is the rule that also catches the next person's.
 *     `check-publish-manifest.mjs` holds the same rule over the *published tarball* — a
 *     different set of files, since `CLAUDE.md` and `docs/board-sections.md` never ship and
 *     are read by every contributor — and this one also knows the macOS spelling.
 *
 * And the three artifacts by name: `HANDOFF.md`, `docs/sample.md` and a root-level image are
 * asserted absent from `git ls-files`. Deleting them from one operator's working tree is not
 * something a pull request can do; keeping them out of the *repository* is.
 *
 * Section 1 builds a throwaway git repository in a temporary directory and asks
 * `git check-ignore` there twice — once with no `.gitignore` at all, once with this
 * repository's — so the case that proves the rule works is a comparison against the state
 * that had no rule, rather than an assertion this file could satisfy by itself.
 *
 * Offline and self-contained apart from `git`. No server, no browser.
 *
 * Usage: node scripts/check-root-tidy.mjs
 *
 * Tier: fast
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The two rules, as functions ──────────────────────────────

/**
 * The names this repository's documentation uses when it needs a home directory in an example.
 *
 * `linuxbrew` is not a user at all — `/home/linuxbrew/.linuxbrew/bin` is where Homebrew
 * installs on Linux, and `docs/trap-gh-path.md` lists it because that is where `gh` is found.
 * `runner` is the hosted CI account, which appears in paths a workflow prints.
 */
const PLACEHOLDER_USERS = new Set(['you', 'your-name', 'user', 'username', 'me', 'x', 'someone',
                                   'alice', 'bob', 'linuxbrew', 'runner']);

/**
 * A home directory in any of the three spellings, with whoever it belongs to captured.
 *
 * The Windows branch is first so that `C:/Users/name` is consumed by it rather than read a
 * second time by the macOS branch; `/mnt/c/Users/name` has no drive letter, so it falls to
 * the macOS branch and is caught all the same.
 */
const HOME_PATH = /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)([A-Za-z0-9._-]+)/g;

/**
 * Every home directory in `text` that belongs to somebody rather than to an example.
 *
 * One entry per distinct spelling rather than per occurrence: the same path repeated down a
 * document is one thing to fix, while `C:/Users/name` and `C:\Users\name` are two places it
 * has to be fixed and both are worth printing.
 */
function homePathIssues(text) {
  const out = [];
  const seen = new Set();
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [match, user] of line.matchAll(HOME_PATH)) {
      if (PLACEHOLDER_USERS.has(user.toLowerCase())) continue;
      if (seen.has(match)) continue;
      seen.add(match);
      out.push(`${index + 1}: ${match}`);
    }
  });
  return out;
}

/** What a stray screenshot is called, in the shapes the three platforms actually produce. */
const STRAY_IMAGES = ['screenshot.png', 'image.png', 'image10.png', 'recover issues.png',
                      'Screenshot 2026-08-01 at 09.41.22.png', 'capture.jpg', 'capture.jpeg',
                      'capture.webp', 'screen recording.gif'];

/** Root-level files that are images somebody chose, and everything below the root. */
const KEPT_PATHS = ['demo.gif', 'docs/media/board-hero.png', 'frontend/src/assets/logo.png'];

/** `git check-ignore` in `cwd`, asked about the rules alone rather than about the index. */
function isIgnored(cwd, path) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path],
                           { cwd, encoding: 'utf8' });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git check-ignore ${path} in ${cwd}: ${result.status} ${result.stderr ?? ''}`);
  }
  return result.status === 0;
}

// ─── 0. The home-directory rule catches each shape ────────────

console.log('0. the home-directory rule catches a login name and clears a worked example');

check('a Windows home directory is caught, on either separator',
      homePathIssues('"path": "C:/Users/vtr_d/Documents"\nEXCALIDRAW_X=C:\\Users\\vtr_d\\.claude')
        .length === 2);
check('a macOS home directory is caught', homePathIssues('/Users/vtr_d/Projects/board').length === 1);
check('a POSIX home directory is caught too', homePathIssues('/home/vtr_d/proj').length === 1);
check('a WSL view of a Windows home is caught', homePathIssues('/mnt/c/Users/vtr_d/.claude').length === 1);
check('the placeholders the documentation already uses are not',
      homePathIssues('C:\\Users\\you\\.claude · C:/Users/x/.local/bin · /home/me/Board '
                     + '· /Users/me/Projects/thing · /home/linuxbrew/.linuxbrew/bin').length === 0,
      homePathIssues('C:\\Users\\you\\.claude · /home/me/Board · /Users/me/Projects/thing').join(', '));
check('a repository path that merely contains the word is not',
      homePathIssues('src/users/list.ts · frontend/src/components/UserTabs.tsx').length === 0);

// ─── 1. The root ignores images, and the comparison says so ───

console.log('\n1. the .gitignore rule ignores a stray root image, and only at the root');

const scratch = mkdtempSync(join(tmpdir(), 'root-tidy-'));
try {
  execFileSync('git', ['init', '-q', '--initial-branch=main', scratch], { encoding: 'utf8' });

  // With no rule at all — the state this check was written against. Every stray is a file
  // `git add .` would take, which is what makes the second half below mean anything.
  const unguarded = STRAY_IMAGES.filter((path) => isIgnored(scratch, path));
  check(`with no images rule, all ${STRAY_IMAGES.length} strays are files git add would take`,
        unguarded.length === 0, `${unguarded.join(', ')} ignored by something else`);

  copyFileSync(join(repoRoot, '.gitignore'), join(scratch, '.gitignore'));

  const missed = STRAY_IMAGES.filter((path) => !isIgnored(scratch, path));
  check(`this repository's .gitignore ignores every one of them`, missed.length === 0,
        missed.join(', '));

  const swept = KEPT_PATHS.filter((path) => isIgnored(scratch, path));
  check('and ignores nothing below the root, nor the demo this fork inherited',
        swept.length === 0, swept.join(', '));
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
}

check('the working tree itself ignores a newly created root PNG',
      isIgnored(repoRoot, 'screenshot.png'));

// ─── 2. No tracked Markdown names a real home directory ───────

console.log('\n2. no tracked Markdown names a home directory that belongs to somebody');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));

check(`the tracked list was read (${tracked.length} files)`, tracked.length > 0);

const markdown = tracked.filter((file) => file.endsWith('.md'));
check(`there is tracked Markdown to scan (${markdown.length} files)`, markdown.length > 0);

const offenders = [];
for (const file of markdown) {
  const issues = homePathIssues(readFileSync(join(repoRoot, file), 'utf8'));
  if (issues.length) offenders.push(`${file}:${issues.join(`\n        ${file}:`)}`);
}
check(`no operator home path in any of the ${markdown.length} tracked documents`,
      offenders.length === 0, offenders.join('\n        '));

// ─── 3. The three artifacts are out of the repository ─────────

console.log('\n3. the repository carries none of the three artifacts by name');

check('git ls-files lists no HANDOFF.md', !tracked.includes('HANDOFF.md'));
check('git ls-files lists no docs/sample.md', !tracked.includes('docs/sample.md'));

const trackedRootImages = tracked.filter((file) => !file.includes('/')
                                               && /\.(png|jpe?g|webp)$/i.test(file));
check('git ls-files lists no image at the repository root', trackedRootImages.length === 0,
      trackedRootImages.join(', '));

// Ignored files are not reported, so once the rule is in place this can only fail on an image
// that was forced in — or on the rule having been taken back out.
const status = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((entry) => entry.slice(3));
const pendingRootImages = status.filter((file) => !file.includes('/')
                                              && /\.(png|jpe?g|gif|webp)$/i.test(file)
                                              && file !== 'demo.gif');
check('and none is waiting in the working tree root to be committed',
      pendingRootImages.length === 0, pendingRootImages.join(', '));

console.log('');
if (failures) { console.error(`${failures} case(s) failed`); process.exit(1); }
console.log('All checks passed');
