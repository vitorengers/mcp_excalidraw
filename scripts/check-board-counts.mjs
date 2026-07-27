#!/usr/bin/env node
/**
 * Checks what a section header counts.
 *
 * A header carried exactly one number and it counted mirrored GitHub items only, so the
 * blocks the `+` dropped were invisible to it: a first column holding three drafts and no
 * cards read `Todo (0)`. #79 asked for two numbers — the drafts written by hand, and the
 * issues that already exist — and the drafts are already an input to `layoutBoard`, which
 * is why this is arithmetic in the layout layer rather than anything new read from GitHub.
 *
 * The four questions the issue left open are answered here, and this file is where the
 * answers are pinned down:
 *
 * - **Drafts first**, cards second: `Icebox (2 / 3)`. That is the order the observation
 *   itself used — "issues written by me" and then "issues the agent created".
 * - **A column with no drafts keeps one number**, `Underway (1)`, rather than drawing a
 *   `/ 0` that is zero by construction: the `+` is on the first column only, so every other
 *   column would carry a permanent zero. The invariant is that the *last* number is always
 *   the mirrored items, which is what the single number has always meant.
 * - **No total.** Two numbers were asked for; a third in a 300px header that also carries
 *   `, N hidden` buys nothing.
 * - The hidden suffix still qualifies the card side: `Shipped (2 / 12, 9 hidden)`.
 *
 * The fixture's sections are named `Icebox` / `Underway` / `Shipped`, the way
 * `check-block-appearance.mjs` names its own, so nothing keying on `Todo` could pass — and
 * they are renamed again mid-run to prove the counts do not key on a string either.
 *
 * Offline and self-contained; it reads the compiled modules, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-board-counts.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const modulePath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the project board layout exists — dist/core/project-board-layout.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { layoutBoard, MIRROR_KIND } = await import(pathToFileURL(modulePath).href);

// ─── Fixtures ─────────────────────────────────────────────────

const FIRST = 'f75ad846';
const SECOND = '47fc9ee4';
const THIRD = '98236657';

/** Deliberately not `Todo` / `In Progress` / `Done`; nothing here may know those. */
const NAMES = ['Icebox', 'Underway', 'Shipped'];

function card(number) {
  return {
    itemId: `PVTI_${number}`,
    contentType: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/vitorengers/mcp_excalidraw/issues/${number}`,
    state: 'OPEN',
    createdAt: '2026-07-01T10:00:00Z',
    repository: 'vitorengers/mcp_excalidraw',
    draggable: true,
  };
}

function board(names, cards, hidden = [0, 0, 0]) {
  return {
    projectId: 'PVT_kwHOBVSHIs4BefUS',
    projectTitle: 'mcp_excalidraw',
    projectUrl: 'https://github.com/users/vitorengers/projects/5',
    fieldId: 'PVTSSF_status',
    fieldName: 'Status',
    morePages: false,
    sections: [FIRST, SECOND, THIRD].map((optionId, index) => ({
      optionId,
      name: names[index],
      cards: cards[index],
      hidden: hidden[index],
    })),
  };
}

const ORIGIN = { x: -1200, y: 0 };

const draft = (id, sectionOptionId, createdAt) => ({ id, sectionOptionId, height: 120, createdAt });

/** The text drawn on a section's header — the label bound to it, which is what a reader sees. */
function headerLabel(laid, optionId) {
  const header = laid.elements.find((element) => element.customData?.role === 'section'
    && element.customData?.sectionOptionId === optionId);
  if (!header) return null;
  return laid.elements.find((element) => element.containerId === header.id)?.text ?? null;
}

/** The whole label with the line breaks `layoutLabel` may have put in taken back out. */
const flat = (text) => (text ?? '').replace(/\s*\n\s*/g, ' ');

// ─── 1. Both populations, both numbers ────────────────────────

console.log('1. a column holding drafts and cards draws both counts');

const both = layoutBoard(board(NAMES, [[card(1), card(2), card(3)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)],
});

check('2 drafts and 3 cards read as both numbers, drafts first',
      flat(headerLabel(both, FIRST)) === 'Icebox (2 / 3)',
      JSON.stringify(headerLabel(both, FIRST)));
check('the draft side is the drafts, not the cards',
      /\(2 \/ /.test(flat(headerLabel(both, FIRST))),
      JSON.stringify(headerLabel(both, FIRST)));
check('and no total is drawn alongside them',
      !/\d+\s*:/.test(flat(headerLabel(both, FIRST))),
      JSON.stringify(headerLabel(both, FIRST)));

// ─── 2. The degenerate form ───────────────────────────────────

console.log('\n2. a column with no drafts keeps the one number it always had');

check('a column with cards and no drafts is unchanged',
      flat(headerLabel(both, SECOND)) === 'Underway (1)',
      JSON.stringify(headerLabel(both, SECOND)));
check('an empty column too',
      flat(headerLabel(both, THIRD)) === 'Shipped (0)',
      JSON.stringify(headerLabel(both, THIRD)));
check('a board laid out with no drafts at all draws no second number anywhere', (() => {
  const bare = layoutBoard(board(NAMES, [[card(1), card(2), card(3)], [card(9)], []]), ORIGIN);
  return [FIRST, SECOND, THIRD].every((optionId) => !flat(headerLabel(bare, optionId)).includes('/'));
})());

// ─── 3. Drafts only ───────────────────────────────────────────

console.log('\n3. drafts with no cards behind them are not invisible — the defect #79 reported');

const draftsOnly = layoutBoard(board(NAMES, [[], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 3000), draft('pbdraft-b', FIRST, 2000), draft('pbdraft-c', FIRST, 1000)],
});
check('three drafts and no cards read as 3 / 0, not as 0',
      flat(headerLabel(draftsOnly, FIRST)) === 'Icebox (3 / 0)',
      JSON.stringify(headerLabel(draftsOnly, FIRST)));

// ─── 4. A capped section still adds up ────────────────────────

console.log('\n4. a capped section counts what it left out, and still says so');

const capped = layoutBoard(board(NAMES, [[card(1)], [card(9)], [card(20), card(21), card(22)]], [0, 0, 9]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 1000)],
});
check('the hidden cards still count towards the card side',
      flat(headerLabel(capped, THIRD)) === 'Shipped (12, 9 hidden)',
      JSON.stringify(headerLabel(capped, THIRD)));

const cappedWithDrafts = layoutBoard(
  board(NAMES, [[card(20), card(21), card(22)], [card(9)], []], [9, 0, 0]),
  ORIGIN,
  { drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)] }
);
check('and a capped column that also holds drafts carries all three facts',
      flat(headerLabel(cappedWithDrafts, FIRST)) === 'Icebox (2 / 12, 9 hidden)',
      JSON.stringify(headerLabel(cappedWithDrafts, FIRST)));
check('the drafts do not go into the hidden count',
      !/11 hidden|2 hidden/.test(flat(headerLabel(cappedWithDrafts, FIRST))),
      JSON.stringify(headerLabel(cappedWithDrafts, FIRST)));

// ─── 5. Nothing keys on a column name ─────────────────────────

console.log('\n5. the counts follow the data, never a column name');

const renamed = layoutBoard(board(['Backlog', 'Cooking', 'Landed'], [[card(1), card(2), card(3)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)],
});
check('renaming every column changes only the name',
      flat(headerLabel(renamed, FIRST)) === 'Backlog (2 / 3)'
      && flat(headerLabel(renamed, SECOND)) === 'Cooking (1)',
      `${JSON.stringify(headerLabel(renamed, FIRST))} | ${JSON.stringify(headerLabel(renamed, SECOND))}`);
check('no header mentions Todo, In Progress or Done',
      renamed.elements.filter((element) => element.customData?.role === 'label')
        .every((element) => !/Todo|In Progress|Done/.test(element.text ?? '')));

console.log('\n5b. a draft in a column that is not the first one is counted there too');
const second = layoutBoard(board(NAMES, [[card(1)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-elsewhere', SECOND, 1000)],
});
check('the second column counts its own draft',
      flat(headerLabel(second, SECOND)) === 'Underway (1 / 1)',
      JSON.stringify(headerLabel(second, SECOND)));
check('and the first column, which has none, keeps one number',
      flat(headerLabel(second, FIRST)) === 'Icebox (1)',
      JSON.stringify(headerLabel(second, FIRST)));

console.log('\n5c. a draft naming a column the board no longer has counts nowhere');
const orphan = layoutBoard(board(NAMES, [[card(1)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-orphan', 'a-column-that-was-renamed', 1000)],
});
check('no header grew a draft count for it',
      [FIRST, SECOND, THIRD].every((optionId) => !flat(headerLabel(orphan, optionId)).includes('/')),
      [FIRST, SECOND, THIRD].map((optionId) => headerLabel(orphan, optionId)).join(' | '));

// ─── 6. Nothing else about the header moved ───────────────────

console.log('\n6. the header is still a mirror element and nothing new reaches the board file');

check('every element the layout produced is still marked as mirror',
      both.elements.length > 0
      && both.elements.every((element) => element.customData?.kind === MIRROR_KIND),
      `${both.elements.filter((element) => element.customData?.kind !== MIRROR_KIND).length} unmarked`);
check('the headers are still locked, one per section',
      both.elements.filter((element) => element.customData?.role === 'section').length === 3
      && both.elements.filter((element) => element.customData?.role === 'section')
        .every((element) => element.locked === true));
check('the label still fits inside the header it is bound to', (() => {
  const header = both.elements.find((element) => element.customData?.role === 'section'
    && element.customData?.sectionOptionId === FIRST);
  const text = both.elements.find((element) => element.containerId === header?.id);
  return Boolean(header && text)
    && text.x >= header.x - 1 && text.x + text.width <= header.x + header.width + 1;
})());
check('a draft still reserves room at the top of its column, as before',
      both.drafts.length === 2 && both.drafts.every((placement) => placement.width === both.columns[0].width),
      JSON.stringify(both.drafts));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
