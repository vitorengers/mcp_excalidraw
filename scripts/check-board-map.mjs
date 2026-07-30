#!/usr/bin/env node
/**
 * Checks that the board is still two maps, and that both of them were kept up.
 *
 * `check-board-docs.mjs` asks whether the board and the documents agree about the keys.
 * This asks the question that came after it: is the map still *there*. Two failures had
 * been sitting on the board for dozens of merges without anything going red — shipped
 * features with no card on them (`project-board.md`, `terminal.md` were only ever a
 * printed note), and a record of what was decided that stopped at issue #11 while `main`
 * ran past #76. Neither is a bug in any single change, which is exactly why nothing caught
 * them: the cost of skipping the map is paid by whoever reads it next.
 *
 * So the rules here are the ones a single pull request can be held to:
 *
 *   - the board declares at least two sections, each an enclosing shape carrying
 *     `customData.kind = "board-section"` with a title and a key;
 *   - no two sections claim the same key, and none claims one the frontend already owns;
 *   - every card that documents something sits inside one of them;
 *   - every tracked `docs/*.md` has a card pointing at it;
 *   - every pull request this fork has merged has a dated entry in the development log.
 *
 * The last one is deliberately one-directional. A branch is checked before its own pull
 * request is merged, so the log always runs one entry ahead of `git log` — an entry with
 * no merge yet is the normal state, a merge with no entry is the defect.
 *
 * It is also the one rule a checkout can be too thin to answer: the fork base below is not
 * in a `--depth 1` clone, which is what `actions/checkout` makes by default. There it says
 * so and stands down, and the other four still decide. `scripts/check-shallow-clone.mjs`
 * holds it to that.
 *
 * Offline apart from `git log`. Run `./node_modules/.bin/tsc` first: the section resolver
 * is a compiled module, checked here against boards built in memory.
 *
 * Usage: node scripts/check-board-map.mjs
 *
 * Tier: repo
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The last commit this fork inherited.
 *
 * Everything below it is the upstream project's history, and its `(#N)` subjects are
 * upstream pull requests — a different repository's numbering, which collides with this
 * one's rather than extending it (both have a #76, and they are different changes).
 */
const FORK_BASE = '505f4c6e0ca1fe2489b4c18c9fedc24ac50a9002';

/** The keys the frontend binds itself: Alt+B for the mirror, Alt+T for the terminal. */
const RESERVED_CODES = ['KeyB', 'KeyT'];

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Whether a commit is in this checkout's object store at all. A shallow clone's is not. */
function reachable(commit) {
  const probe = spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`],
                          { cwd: repoRoot, encoding: 'utf8' });
  return probe.status === 0;
}

const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
const boardPath = resolve(repoRoot, config.board);
const docsDir = resolve(repoRoot, config.docsDir);
const scene = JSON.parse(readFileSync(boardPath, 'utf8'));
const elements = (scene.elements ?? []).filter((element) => !element.isDeleted);

const customOf = (element) => element?.customData ?? {};
const docKeyOf = (element) => {
  const value = customOf(element).docKey;
  return typeof value === 'string' && value ? value : null;
};

console.log('1. the board is cut into sections a key can reach');
const sections = elements.filter((element) => customOf(element).kind === 'board-section');
check('the board declares at least two sections', sections.length >= 2,
      `${sections.length} shape(s) carry customData.kind = "board-section"`);

for (const section of sections) {
  const title = customOf(section).title;
  const code = customOf(section).hotkeyCode;
  const where = `${title || section.id}`;
  check(`"${where}" names itself`, typeof title === 'string' && title.trim().length > 0,
        'customData.title is what the section is called in the log and in CLAUDE.md');
  check(`"${where}" claims a key`, typeof code === 'string' && /^[A-Za-z0-9]+$/.test(code),
        `customData.hotkeyCode = ${JSON.stringify(code)} is not a KeyboardEvent.code`);
  check(`"${where}" claims a key the frontend has not already taken`, !RESERVED_CODES.includes(code),
        `${code} is bound to ${code === 'KeyB' ? 'the mirror' : 'the terminal'}`);
  check(`"${where}" encloses something`,
        section.width > 0 && section.height > 0,
        `${section.width}×${section.height}`);
}

const claimed = sections.map((section) => customOf(section).hotkeyCode);
const duplicated = [...new Set(claimed.filter((code, at) => claimed.indexOf(code) !== at))];
check('no two sections claim the same key', duplicated.length === 0, duplicated.join(', '));

console.log('\n2. every documented card sits in a section');
// A card outside every section is a card no key reaches. It is not unreachable — the board
// scrolls — but it is outside the map, and the map is what this whole file is about.
const encloses = (section, element) =>
  section.x <= element.x
  && section.y <= element.y
  && section.x + section.width >= element.x + element.width
  && section.y + section.height >= element.y + element.height;

const homeless = elements
  .filter((element) => docKeyOf(element))
  .filter((element) => !sections.some((section) => encloses(section, element)));
check('no card with a document is outside every section', homeless.length === 0,
      `${homeless.length}: ${homeless.map((element) => docKeyOf(element)).join(', ')}`);

console.log('\n3. every tracked document has a card pointing at it');
// Tracked, so a scratch file someone left in docs/ — the sample the docs block ships with,
// anything half-written — is not a failure until it is committed.
const trackedDocs = execFileSync('git', ['ls-files', 'docs'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.endsWith('.md'))
  .map((line) => line.slice('docs/'.length, -'.md'.length));

const keys = new Set(elements.map((element) => docKeyOf(element)).filter(Boolean));
const unreferenced = trackedDocs.filter((key) => !keys.has(key));
check('no tracked document is left off the board', unreferenced.length === 0,
      `${unreferenced.length}: ${unreferenced.join(', ')}`);

console.log('\n4. the development log records every merge');
const LOG_KEY = 'development-log';
const logPath = join(docsDir, `${LOG_KEY}.md`);
check('the development log exists', existsSync(logPath), `expected ${config.docsDir}/${LOG_KEY}.md`);
check('and a card points at it', keys.has(LOG_KEY), 'nothing on the board opens it');

if (existsSync(logPath)) {
  const log = readFileSync(logPath, 'utf8');

  // One entry per merged pull request: a date, the issue, then the pull request. The date
  // is the day it landed, so an entry is a fact about the change rather than about when
  // somebody got round to writing it down. The issue may be an em dash — a handful of
  // early changes went straight to a pull request, and the log says so rather than
  // inventing a number.
  const entries = [...log.matchAll(/^\|\s*(\S+)\s*\|\s*(#\d+|—)\s*\|\s*#(\d+)\s*\|/gm)].map(
    ([, date, issue, pull]) => ({ date, issue, pull })
  );
  check('the log has entries', entries.length > 0,
        'expected rows of | date | issue | pull request | ...');

  const undated = entries.filter((entry) => !/^\d{4}-\d{2}-\d{2}$/.test(entry.date));
  check('every entry carries an ISO date', undated.length === 0,
        undated.map((entry) => `#${entry.pull} dated ${entry.date}`).join(', '));

  // The fork base is only in the object store of a clone deep enough to hold it, and
  // `actions/checkout@v4` clones at depth 1 unless a workflow says otherwise. Asked for a
  // range starting at a commit it does not have, `git` answers `fatal: Invalid revision
  // range` and an unguarded call turns that into a stack trace — which takes the four rules
  // already decided down with it and says nothing about any of them.
  //
  // So this one rule gives itself up. A missing commit is a fact about the checkout, not
  // about the branch, and the CI job that this rule exists for checks out with
  // `fetch-depth: 0`. What is not given up is a `git` that fails for any other reason:
  // reachable-and-broken is a failure, absent is a skip.
  if (!reachable(FORK_BASE)) {
    console.log(`  SKIPPED — shallow clone, the merge log cannot be verified here`);
    console.log(`          (${FORK_BASE.slice(0, 12)} is not in this checkout; clone with --depth 0)`);
  } else {
    const merged = execFileSync('git', ['log', '--format=%s', `${FORK_BASE}..HEAD`],
                                { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .map((subject) => subject.match(/\(#(\d+)\)\s*$/))
      .filter(Boolean)
      .map((match) => match[1]);

    const recorded = new Set(entries.map((entry) => entry.pull));
    const missing = [...new Set(merged)].filter((pull) => !recorded.has(pull));
    check('every merged pull request has an entry', missing.length === 0,
          `${missing.length} missing: ${missing.map((pull) => `#${pull}`).join(' ')}`);
  }
}

console.log('\n5. the resolver binds what the board declares, and nothing else');
// The frontend reads the marks rather than holding two more constants, so what a board
// gets to say is this function's answer. Checked here against boards built in memory:
// a real one, one that declares nothing, and two that declare something impossible.
const modulePath = join(repoRoot, 'dist', 'core', 'board-sections.js');
if (!existsSync(modulePath)) {
  failures++;
  console.error('  FAIL  the section resolver exists — dist/core/board-sections.js not found');
  console.error('        (the hotkeys are still two constants in App.tsx; run tsc if they are not)');
} else {
  const { resolveBoardSectionHotkeys, BOARD_SECTION_KIND } = await import(pathToFileURL(modulePath).href);

  const mark = (id, code, extra = {}) => ({
    id, type: 'rectangle', x: 0, y: 0, width: 100, height: 100,
    customData: { kind: BOARD_SECTION_KIND, title: id, hotkeyCode: code }, ...extra
  });

  check('a board with no marked sections binds nothing',
        resolveBoardSectionHotkeys([{ id: 'plain', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }])
          .bindings.length === 0);

  const two = resolveBoardSectionHotkeys([mark('one', 'KeyP'), mark('two', 'KeyD', { y: 500 })]);
  check('two sections bind two keys', two.bindings.length === 2 && two.ignored.length === 0,
        JSON.stringify(two));

  const clash = resolveBoardSectionHotkeys([mark('lower', 'KeyP', { y: 500 }), mark('upper', 'KeyP')]);
  check('a duplicate key binds the section higher on the board and ignores the other',
        clash.bindings.length === 1 && clash.bindings[0].elementId === 'upper'
        && clash.ignored.length === 1 && clash.ignored[0].reason === 'duplicate',
        JSON.stringify(clash));

  const reserved = resolveBoardSectionHotkeys([mark('mirror', 'KeyB'), mark('terminal', 'KeyT')]);
  check('a section cannot take a key the frontend already owns',
        reserved.bindings.length === 0
        && reserved.ignored.every((claim) => claim.reason === 'reserved'),
        JSON.stringify(reserved));

  const malformed = resolveBoardSectionHotkeys([mark('nonsense', 'Alt+P'), mark('empty', '')]);
  check('a key that is not a KeyboardEvent.code is ignored rather than bound',
        malformed.bindings.length === 0 && malformed.ignored.length === 2
        && malformed.ignored.every((claim) => claim.reason === 'malformed'),
        JSON.stringify(malformed));

  const real = resolveBoardSectionHotkeys(elements);
  check('this board binds one key per section', real.bindings.length === sections.length,
        JSON.stringify(real));
  check('and claims nothing it has to throw away', real.ignored.length === 0,
        JSON.stringify(real.ignored));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
