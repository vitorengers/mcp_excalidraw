#!/usr/bin/env node
/**
 * Checks that the front page of the repository is about this repository.
 *
 * `README.md` is the one document a clone reads first, and it is the one document nothing
 * inspected. It still opened with the upstream project's CI and package badges, sent bug
 * reports to the upstream issue tracker, and of everything this fork is — the workspace
 * registry, the two-section board, the block kinds, the worktree per issue — it documented a
 * single troubleshooting bullet. The name in `board.config.json` appeared zero times.
 *
 * The rules are about identity and coverage, not about prose:
 *
 *  1. it says which project and which repository it is;
 *  2. no badge, and no unattributed link, points at the upstream project — a green CI badge
 *     for somebody else's pipeline is worse than no badge;
 *  3. it names each of the load-bearing pieces of this fork, including every block kind the
 *     code defines, so a new kind cannot ship without the front page learning about it;
 *  4. it says how to start the tool, by pointing at the document that says how.
 *
 * `check-docs-index.mjs` separately holds it to naming only files that exist.
 *
 * Offline and self-contained.
 *
 * Usage: node scripts/check-readme.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

const readme = read('README.md');
const config = JSON.parse(read('board.config.json'));

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const mentions = (needle) => readme.includes(needle);

// ─── 1. Whose front page this is ──────────────────────────────

console.log('1. the front page says which project it is');
check(`it uses the name in board.config.json ("${config.name}")`, mentions(config.name),
      'the tool has a name and the README never said it');
check(`it names this repository (${config.repo})`, mentions(config.repo),
      'a clone cannot tell which fork it is holding');

// ─── 2. Nothing points at the upstream project unmarked ───────

console.log('\n2. no badge or link claims the upstream project as this one');

const UPSTREAM = 'yctimlin';

// A badge is a linked image, and a linked image is a claim about live state: this pipeline
// is green, this package is at this version. Neither is true of a fork that publishes
// neither.
const badges = [...readme.matchAll(/\[!\[[^\]]*\]\(([^)]*)\)\]\(([^)]*)\)/g)]
  .flatMap(([, image, target]) => [image, target]);
const upstreamBadges = badges.filter((url) => url.includes(UPSTREAM));
check('no badge points at the upstream project', upstreamBadges.length === 0,
      upstreamBadges.join(', '));

// The npm badge is the same claim by another route: the published package is the upstream
// one, and a version badge on this page reads as this page's version.
check('no npm version badge stands in for a package this fork does not publish',
      !/img\.shields\.io\/npm\/v\//.test(readme),
      'the published package is upstream\'s; a version badge here misreports this fork');

// Prose only. A fenced block naming `ghcr.io/yctimlin/mcp_excalidraw` is the coordinate of a
// real published image, spelled correctly; it is the sentence around it that has to say whose.
let fenced = false;
const unattributed = readme.split(/\r?\n/)
  .map((line, index) => ({ line, at: index + 1 }))
  .filter(({ line }) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return false; }
    return !fenced && line.includes(UPSTREAM) && !/upstream/i.test(line);
  });
check('every remaining mention of the upstream project says that is what it is',
      unattributed.length === 0,
      unattributed.map(({ line, at }) => `${at}: ${line.trim().slice(0, 80)}`).join('\n        '));

// Bug reports have to arrive somewhere a maintainer of this fork will read them.
check('bug reports are pointed at this fork\'s issue tracker',
      mentions(`github.com/${config.repo}/issues`), `expected a link to ${config.repo}/issues`);

// ─── 3. What this fork is, named on its own front page ────────

console.log('\n3. it names what this fork actually is');

/**
 * The block kinds a shape can carry. Three are exported constants; `issue` predates the
 * convention and is written inline. The assertion below keeps the list honest: an exported
 * kind that is not in it fails here rather than quietly missing from the README.
 */
const BLOCK_KINDS = ['issue', 'project-board', 'terminal', 'board-section'];

const declared = [...read('src/core/board-sections.ts').matchAll(/_KIND = '([a-z-]+)'/g),
                  ...read('src/core/project-board-layout.ts').matchAll(/_KIND = '([a-z-]+)'/g),
                  ...read('src/core/terminal-block.ts').matchAll(/_KIND = '([a-z-]+)'/g)]
  .map(([, kind]) => kind);
const unknown = declared.filter((kind) => !BLOCK_KINDS.includes(kind));
check('the list of block kinds below still covers every kind the code exports',
      unknown.length === 0 && declared.length > 0,
      `${unknown.join(', ')} — add it here and to the README`);

for (const kind of BLOCK_KINDS) {
  check(`it names the "${kind}" block`, mentions(`\`${kind}\``) || mentions(`"${kind}"`),
        `customData.kind = "${kind}" is one of the four things a shape on this board can be`);
}

check('it names the workspace registry', mentions('EXCALIDRAW_WORKSPACES'),
      'one project per board is the whole shape of this fork');
check('it names board.config.json', mentions('board.config.json'));

// Both sections, with the keys the board itself declares — read from the board, so renaming
// a section on the canvas fails here rather than silently disagreeing with the front page.
const board = JSON.parse(read(config.board));
const sections = (board.elements ?? [])
  .filter((element) => !element.isDeleted && element.customData?.kind === 'board-section')
  .map((element) => element.customData);
check('the board declares its sections', sections.length >= 2, `${sections.length} found`);
for (const section of sections) {
  const key = `Alt+${(section.hotkeyCode ?? '').replace(/^Key/, '')}`;
  check(`it names the "${section.title}" section and ${key}`,
        mentions(section.title) && mentions(key));
}

check('it names the worktree per issue', /-worktrees\/issue-/.test(readme),
      'an implementation gets a checkout of its own, and nothing on the front page said so');

// ─── 4. How to start it ───────────────────────────────────────

console.log('\n4. it says how to start the tool');
check('it links the run procedure', mentions('docs/running.md'),
      'the only start instruction a clone had was a port that cannot work on this machine');

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
