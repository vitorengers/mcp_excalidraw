#!/usr/bin/env node
/**
 * Checks that the documentation can be walked into, and that it names real files.
 *
 * Two absences, one cause. Fifteen of the twenty-two tracked documents were linked from no
 * other document and there was no index, so the only way into most of `docs/` was to open
 * the board and click the card — which works for whoever has the board open and for nobody
 * arriving through a clone. And four documents cited `start-board.ps1`, a file that has
 * never existed in `git ls-files`, so the one instruction a fresh clone got for starting the
 * tool pointed at nothing. Neither is a bug in any single change; both are what nothing
 * checking looks like after fifty merges.
 *
 * So:
 *
 *  1. `docs/index.md` exists, and every other tracked `docs/*.md` is reachable from it by a
 *     relative link — reachable by reading, not only by clicking a card;
 *  2. every relative path this repository's Markdown names — a link target, or a path in an
 *     inline code span — is a path that exists.
 *
 * Fenced code blocks are out of scope for the second rule: `export --out
 * docs/architecture.excalidraw` is an example of a file the reader will create, not a claim
 * that one is there. Prose is where a claim lives.
 *
 * Offline and self-contained.
 *
 * Usage: node scripts/check-docs-index.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const INDEX = 'docs/index.md';

/**
 * A path claim ends in one of these, or in a slash. Anything else is a name, not a file.
 *
 * `.json`, `.js`, `.html` and `.yml` are here only in their qualified form — see
 * `looksLikeAPath`. A bare `opencode.json` or `claude_desktop_config.json` in prose is a file
 * the *reader* is being told to create on their own machine, not a claim about this tree.
 */
const PATH_ENDINGS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.json', '.css', '.html', '.yml',
  '.yaml', '.excalidraw', '.excalidrawlib', '.ps1', '.sh', '.png', '.gif', '.svg', '/',
];

/** Extensions this repository owns, so a bare basename of one is a claim about this tree. */
const OURS_UNQUALIFIED = ['.ts', '.tsx', '.mjs', '.md', '.css', '.ps1', '.excalidraw', '.excalidrawlib', '/'];

/** Not this repository's to have: a dependency's build output, or somebody's home directory. */
const NOT_OURS = /^(node_modules|dist|~|\/|\.)/;

/**
 * The log is the dated record of what was decided, one entry per merged pull request. It
 * names files that were real when the entry was written — `delivered.md` and `open-work.md`
 * were folded into it and deleted, and the entry saying so is the reason they are gone.
 * Rewriting that to keep a check green is the wrong direction.
 */
const EXEMPT = new Set(['docs/development-log.md']);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean).map((file) => file.split('\\').join(posix.sep));

const markdown = tracked.filter((file) => file.endsWith('.md'));

// ─── 1. An index, and everything reachable from it ────────────

console.log('1. the documentation has a way in');

check(`${INDEX} is tracked`, tracked.includes(INDEX),
      'a document nobody links to is a document nobody opens');

if (tracked.includes(INDEX)) {
  const index = readFileSync(join(repoRoot, INDEX), 'utf8');
  // Relative link targets only: an index that reaches a document through github.com is an
  // index that stops working the moment the clone is read offline or the fork is renamed.
  const linked = new Set(
    [...index.matchAll(/\]\(([^)\s]+)\)/g)]
      .map(([, target]) => target.split('#')[0])
      .filter((target) => target && !/^[a-z][a-z0-9+.-]*:/i.test(target))
      .map((target) => posix.normalize(posix.join('docs', target)))
  );

  const shouldBeLinked = tracked
    .filter((file) => file.startsWith('docs/') && file.endsWith('.md') && file !== INDEX);
  const orphans = shouldBeLinked.filter((file) => !linked.has(file));
  check(`all ${shouldBeLinked.length} other tracked documents are linked from the index`,
        orphans.length === 0, `${orphans.length} missing: ${orphans.join(', ')}`);
}

// ─── 2. Every path the prose names is a path that exists ──────

console.log('\n2. every file the Markdown names exists');

/** The document with its fenced blocks blanked out, line numbering preserved. */
function prose(text) {
  let fenced = false;
  return text.split(/\r?\n/).map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return ''; }
    return fenced ? '' : line;
  });
}

const looksLikeAPath = (token) => {
  if (!/^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*\/?$/.test(token)) return false;
  if (NOT_OURS.test(token)) return false;
  const endings = token.includes('/') ? PATH_ENDINGS : OURS_UNQUALIFIED;
  return endings.some((ending) => token.endsWith(ending));
};

/**
 * Every name this repository answers to: each tracked path, each directory along it, and the
 * basename of both. Prose here names a file in full once and by its basename afterwards —
 * `TerminalPanel.tsx`, `check-board-map.mjs` — and both spellings are a real reference.
 */
const known = new Set();
for (const file of tracked) {
  known.add(file);
  known.add(posix.basename(file));
  const parts = file.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    known.add(parts.slice(0, depth).join('/'));
    known.add(parts[depth - 1]);
  }
}

/** Known by name, or resolvable from the repository root or from the document's own folder. */
function resolves(file, target) {
  const clean = target.replace(/\/$/, '');
  return known.has(clean)
    || existsSync(resolve(repoRoot, clean))
    || existsSync(resolve(repoRoot, posix.dirname(file), clean));
}

const broken = [];
for (const file of markdown.filter((path) => !EXEMPT.has(path))) {
  const lines = prose(readFileSync(join(repoRoot, file), 'utf8'));
  lines.forEach((line, index) => {
    const claims = new Set();

    // Link targets, minus anchors and anything with a scheme.
    for (const [, target] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const path = target.split('#')[0];
      if (path && !/^[a-z][a-z0-9+.-]*:/i.test(path) && !NOT_OURS.test(path)) claims.add(path);
    }
    // Inline code spans that read as a path.
    for (const [, token] of line.matchAll(/`([^`]+)`/g)) {
      if (looksLikeAPath(token)) claims.add(token);
    }

    for (const claim of claims) {
      if (!resolves(file, claim)) broken.push(`${file}:${index + 1}: ${claim}`);
    }
  });
}
check('no document names a file that is not there', broken.length === 0,
      `\n        ${broken.join('\n        ')}`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
