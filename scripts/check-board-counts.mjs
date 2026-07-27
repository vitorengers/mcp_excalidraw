#!/usr/bin/env node
/**
 * Checks what a section header counts.
 *
 * One number, and it counts **everything the column holds**: the blocks the `+` dropped,
 * the mirrored cards, and the cards the cap left out. Not the same thing as the single
 * number this header carried before #79 — that one counted the mirrored items alone, which
 * is why a first column holding three drafts and no cards read `Todo (0)`.
 *
 * #79 answered that with two numbers, `drafts / cards`, because two populations shared one
 * column and the header had to say which was which. #86 splits them into columns of their
 * own — hand-written observations land in the first column and a researched issue is moved
 * out of it — so the reason for the split is gone, and the request is one number again.
 *
 * **This is not a revert.** Reverting restores `cards.length + hidden`, and a column full of
 * drafts with no cards behind them would read `(0)` all over again — the defect #79
 * recorded, moved one column left. The drafts stay in the sum; only the slash goes.
 *
 * - **Drafts count.** A column holding three drafts and no cards reads `(3)`.
 * - **Hidden cards count.** The cap decides what is *drawn*, never what is *held*, so
 *   `, N hidden` still qualifies the card side and the total still includes them.
 * - **No slash, anywhere.** A column with both populations draws their sum and nothing else.
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

// ─── 1. One number, covering both populations ─────────────────

console.log('1. a column holding drafts and cards draws one number for all of them');

const both = layoutBoard(board(NAMES, [[card(1), card(2), card(3)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)],
});

check('2 drafts and 3 cards read as 5',
      flat(headerLabel(both, FIRST)) === 'Icebox (5)',
      JSON.stringify(headerLabel(both, FIRST)));
check('and the two populations are not split by a slash any more',
      !flat(headerLabel(both, FIRST)).includes('/'),
      JSON.stringify(headerLabel(both, FIRST)));
check('a column with cards and no drafts is unchanged',
      flat(headerLabel(both, SECOND)) === 'Underway (1)',
      JSON.stringify(headerLabel(both, SECOND)));
check('an empty column still reads zero, because it holds nothing',
      flat(headerLabel(both, THIRD)) === 'Shipped (0)',
      JSON.stringify(headerLabel(both, THIRD)));
check('no header anywhere on the board carries a slash',
      both.elements.filter((element) => element.customData?.role === 'label')
        .every((element) => !(element.text ?? '').includes('/')),
      both.elements.filter((element) => element.customData?.role === 'label')
        .map((element) => element.text).join(' | '));

// ─── 2. Drafts with nothing behind them ───────────────────────

console.log('\n2. drafts with no cards behind them are still not invisible — the defect #79 recorded');

const draftsOnly = layoutBoard(board(NAMES, [[], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 3000), draft('pbdraft-b', FIRST, 2000), draft('pbdraft-c', FIRST, 1000)],
});
check('three drafts and no cards read as 3',
      flat(headerLabel(draftsOnly, FIRST)) === 'Icebox (3)',
      JSON.stringify(headerLabel(draftsOnly, FIRST)));
check('and emphatically not as 0, which is what a plain revert would draw',
      !/\(0[,)]/.test(flat(headerLabel(draftsOnly, FIRST))),
      JSON.stringify(headerLabel(draftsOnly, FIRST)));

// ─── 3. A capped section still adds up ────────────────────────

console.log('\n3. a capped section counts what it left out, and still says so');

const capped = layoutBoard(board(NAMES, [[card(1)], [card(9)], [card(20), card(21), card(22)]], [0, 0, 9]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 1000)],
});
check('the hidden cards count towards the total, and the suffix stays',
      flat(headerLabel(capped, THIRD)) === 'Shipped (12, 9 hidden)',
      JSON.stringify(headerLabel(capped, THIRD)));

const cappedWithDrafts = layoutBoard(
  board(NAMES, [[card(20), card(21), card(22)], [card(9)], []], [9, 0, 0]),
  ORIGIN,
  { drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)] }
);
check('a capped column that also holds drafts adds all three up: 2 + 3 + 9',
      flat(headerLabel(cappedWithDrafts, FIRST)) === 'Icebox (14, 9 hidden)',
      JSON.stringify(headerLabel(cappedWithDrafts, FIRST)));
check('the drafts do not go into the hidden count',
      /, 9 hidden\)/.test(flat(headerLabel(cappedWithDrafts, FIRST))),
      JSON.stringify(headerLabel(cappedWithDrafts, FIRST)));

// ─── 4. Nothing keys on a column name ─────────────────────────

console.log('\n4. the counts follow the data, never a column name');

const renamed = layoutBoard(board(['Backlog', 'Cooking', 'Landed'], [[card(1), card(2), card(3)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-a', FIRST, 2000), draft('pbdraft-b', FIRST, 1000)],
});
check('renaming every column changes only the name',
      flat(headerLabel(renamed, FIRST)) === 'Backlog (5)'
      && flat(headerLabel(renamed, SECOND)) === 'Cooking (1)',
      `${JSON.stringify(headerLabel(renamed, FIRST))} | ${JSON.stringify(headerLabel(renamed, SECOND))}`);
check('no header mentions Todo, In Progress, Done or My Notes',
      renamed.elements.filter((element) => element.customData?.role === 'label')
        .every((element) => !/Todo|In Progress|Done|My Notes/.test(element.text ?? '')));

console.log('\n4b. a draft in a column that is not the first one is counted there too');
const second = layoutBoard(board(NAMES, [[card(1)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-elsewhere', SECOND, 1000)],
});
check('the second column counts its own draft alongside its card',
      flat(headerLabel(second, SECOND)) === 'Underway (2)',
      JSON.stringify(headerLabel(second, SECOND)));
check('and the first column, which has none, counts only its card',
      flat(headerLabel(second, FIRST)) === 'Icebox (1)',
      JSON.stringify(headerLabel(second, FIRST)));

console.log('\n4c. a draft naming a column the board no longer has counts nowhere');
const orphan = layoutBoard(board(NAMES, [[card(1)], [card(9)], []]), ORIGIN, {
  drafts: [draft('pbdraft-orphan', 'a-column-that-was-renamed', 1000)],
});
check('no header grew for it',
      flat(headerLabel(orphan, FIRST)) === 'Icebox (1)'
      && flat(headerLabel(orphan, SECOND)) === 'Underway (1)'
      && flat(headerLabel(orphan, THIRD)) === 'Shipped (0)',
      [FIRST, SECOND, THIRD].map((optionId) => headerLabel(orphan, optionId)).join(' | '));

// ─── 5. Nothing else about the header moved ───────────────────

console.log('\n5. the header is still a mirror element and nothing new reaches the board file');

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
