#!/usr/bin/env node
/**
 * Checks that the canvas draws a column of its own for the work only a person can do.
 *
 * The first founder action this product will ever produce is "sign the GitHub CLI in". At
 * that moment there is no project to file it into and no working `gh` to file it with, so a
 * column that waited for GitHub to declare one would be missing exactly when it is needed.
 * The notes column already proved the arrangement: a section under an id GitHub cannot issue,
 * drawn by the layout rather than mirrored from anything.
 *
 * What this holds:
 *
 *   - the reserved id is `canvas:founder`, and `buildMoveArgs` refuses it by the same
 *     `NODE_ID` pattern that refuses `canvas:notes` — so a card dropped in it could not be
 *     written back even by a caller that tried;
 *   - **with nothing waiting the mirror is byte-identical to today**: no extra section, no
 *     extra width, no extra line on the strip. A column for a case that has not happened is
 *     a column in everybody's way;
 *   - with something waiting it is drawn on a `notesOnlyBoard()` and beside a real project,
 *     the width grows by exactly one column and one gap — 324 — and no column already there
 *     changes its index, its hue, its role or its geometry, because it is **appended** and
 *     a hue is `COLUMN_STROKES[index % 5]`;
 *   - a project that declares a column of that name gets exactly one, its own: once these
 *     are published as draft items the canvas has to stand down rather than draw them twice;
 *   - the cards are `role: 'card'` under `MIRROR_KIND` carrying `customData.founderKey` and
 *     **no** `customData.itemId`, which is what makes `settleMirrorDrag` snap a dropped one
 *     back with no request, and they are not `locked`, so they can still be selected;
 *   - the `+` stays on the notes column alone and a draft stamped with the founder id still
 *     rehomes to the notes column: a founder action is never authored by hand;
 *   - `mirrorWidth(board)` still answers with one argument, because `App.tsx` and
 *     `check-board-notes-column.mjs` both call it that way.
 *
 * **Run against the code before the change, this fails on behaviour rather than on a missing
 * export.** Every entry point it uses — `layoutMirror`, `mirrorSections`, `mirrorWidth` —
 * already exists; the old build simply ignores the option, so the mirror comes back with one
 * canvas-owned column, the founder cards placed nowhere and counted in nothing, and a width
 * that did not move. The reserved id is declared locally here and the module's constant is
 * asserted to match it, the way `check-founder-not-startable.mjs` does, so that the
 * behavioural cases do not all collapse into one missing symbol.
 *
 * Offline and self-contained; it reads the compiled modules, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-founder-column-canvas.mjs
 *
 * Tier: fast
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

async function importDist(relative, what) {
  const path = join(repoRoot, 'dist', relative);
  if (!existsSync(path)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
  return import(pathToFileURL(path).href);
}

const layout = await importDist(join('core', 'project-board-layout.js'), 'the project board layout');
const types = await importDist(join('core', 'project-board-types.js'), 'the project board types');
const reader = await importDist(join('core', 'project-board.js'), 'the project board reader');

const {
  layoutMirror, mirrorSections, mirrorWidth, boardWidth, notesOnlyBoard,
  MIRROR_KIND, COLUMN_WIDTH, COLUMN_GAP,
} = layout;
const { buildMoveArgs } = reader;

/**
 * The reserved id and the default name, spelled here rather than imported.
 *
 * So that a build without them fails the one case that is about them and goes on to fail the
 * rest on what it draws. `check-founder-not-startable.mjs` declares the same string for the
 * mirror-image reason — it fences a column that had not landed yet — and this is the check
 * its comment points at for the two to be held together.
 */
const FOUNDER = 'canvas:founder';
const FOUNDER_COLUMN = 'Founder Actions';

/** One column plus the gap in front of it: what the mirror grows by, and slides left by. */
const ONE_COLUMN = (COLUMN_WIDTH ?? 300) + (COLUMN_GAP ?? 24);

// ─── Fixtures ─────────────────────────────────────────────────

/** Not the names or ids of any real project, so nothing here can pass by recognising one. */
const FIRST = 'a1a1a1a1';
const SECOND = 'b2b2b2b2';
const THIRD = 'c3c3c3c3';
const NAMES = ['Icebox', 'Underway', 'Shipped'];

const card = (number) => ({
  itemId: `PVTI_${number}`,
  contentType: 'Issue',
  number,
  title: `Issue ${number}`,
  url: `https://example.invalid/issues/${number}`,
  state: 'OPEN',
  createdAt: '2026-07-01T10:00:00Z',
  repository: 'someone/something',
  draggable: true,
});

function board(names = NAMES) {
  return {
    projectId: 'PVT_kwHOBVSHIs4BefUS',
    projectTitle: 'something',
    projectUrl: 'https://github.com/users/someone/projects/1',
    fieldId: 'PVTSSF_status',
    fieldName: 'Status',
    morePages: false,
    sections: [FIRST, SECOND, THIRD].map((optionId, index) => ({
      optionId,
      name: names[index],
      cards: index === 0 ? [card(1)] : (index === 1 ? [card(9)] : []),
      hidden: 0,
    })),
  };
}

const ORIGIN = { x: -1600, y: 0 };

const WAITING = [
  { key: 'a-board:gh-login', title: 'Sign the GitHub CLI in to your account' },
  { key: 'a-board:gh-billing', title: 'GitHub is refusing work until billing is settled' },
];

const withFounder = (cards = WAITING, columnName = FOUNDER_COLUMN) =>
  ({ founder: { columnName, cards } });

const columnOf = (laid, optionId) =>
  laid.columns.find((column) => column.optionId === optionId) ?? null;
const headerOf = (laid, optionId) => laid.elements.find((element) =>
  element.customData?.role === 'section' && element.customData?.sectionOptionId === optionId) ?? null;
const labelIn = (laid, container) => (container
  ? laid.elements.find((element) => element.containerId === container.id)
  : null) ?? null;
const headerLabel = (laid, optionId) =>
  (labelIn(laid, headerOf(laid, optionId))?.text ?? '').replace(/\s*\n\s*/g, ' ') || null;
const cardsOf = (laid, optionId) => laid.elements.filter((element) =>
  element.customData?.role === 'card' && element.customData?.sectionOptionId === optionId);
const titleOf = (laid) => laid.elements.find((element) => element.customData?.role === 'title') ?? null;
const titleText = (laid) => labelIn(laid, titleOf(laid))?.text ?? '';
const addButtons = (laid) => laid.elements.filter((element) => element.customData?.role === 'add');
const founderCards = (laid) => laid.elements.filter((element) =>
  element.customData?.role === 'card' && typeof element.customData?.founderKey === 'string');

// ─── 1. The reserved id, and that nothing can be written to it ────

console.log('1. the column has an id of its own, and it is not one GitHub could issue');

check('the module spells it canvas:founder', types.FOUNDER_OPTION_ID === FOUNDER,
      JSON.stringify(types.FOUNDER_OPTION_ID));
check('and it is a different column from the notes one',
      types.FOUNDER_OPTION_ID !== types.NOTES_OPTION_ID,
      `${types.FOUNDER_OPTION_ID} vs ${types.NOTES_OPTION_ID}`);
check('the default name is a constant this repository owns',
      types.FOUNDER_NAME === FOUNDER_COLUMN, JSON.stringify(types.FOUNDER_NAME));

const refusalFor = (optionId) => {
  try {
    buildMoveArgs({
      projectId: 'PVT_kwHOBVSHIs4BefUS',
      fieldId: 'PVTSSF_status',
      itemId: 'PVTI_1',
      optionId,
    });
    return null;
  } catch (error) { return error; }
};

const refusedFounder = refusalFor(FOUNDER);
check('a move naming it is refused before a command line is built', refusedFounder !== null,
      'buildMoveArgs accepted the founder column as a single-select option');
check('and it is refused for what it is, not for being unknown to some project',
      /optionId/i.test(String(refusedFounder?.message ?? '')), String(refusedFounder?.message));
check('by the same pattern that refuses the notes column',
      refusalFor(types.NOTES_OPTION_ID ?? 'canvas:notes') !== null);
// Without this the two above would pass on a `buildMoveArgs` that refused everything.
check('an ordinary hex option id is still accepted', refusalFor(FIRST) === null,
      String(refusalFor(FIRST)?.message));

// ─── 2. Nothing waiting: the mirror is what it was ────────────

console.log('\n2. with nothing waiting the mirror is exactly what it draws today');

const plain = layoutMirror(board(), ORIGIN);
const noCards = layoutMirror(board(), ORIGIN, withFounder([]));

check('no column is drawn for an empty list',
      !noCards.columns.some((column) => column.optionId === FOUNDER),
      noCards.columns.map((column) => column.optionId).join(', '));
check('the whole layout is byte-identical to the one drawn without the option at all',
      JSON.stringify(noCards) === JSON.stringify(plain));
check('the width is the notes column plus the project\'s own, and no more',
      mirrorWidth(board(), withFounder([])) === boardWidth(board().sections.length + 1),
      `${mirrorWidth(board(), withFounder([]))} vs ${boardWidth(board().sections.length + 1)}`);
check('the strip says nothing about founder actions', !/founder/i.test(titleText(plain)),
      JSON.stringify(titleText(plain)));
check('and it is still a single line', !titleText(plain).includes('\n'),
      JSON.stringify(titleText(plain)));

// The other half of "byte-identical": no column already there moves, changes hue or changes
// role. Asserted against the layout with no option, which is the shape shipped today.
check('every column keeps its index, its position and its width',
      JSON.stringify(noCards.columns) === JSON.stringify(plain.columns),
      JSON.stringify(noCards.columns.map((column) => [column.optionId, column.x])));
check('every header keeps its hue', [FIRST, SECOND, THIRD].every((optionId) =>
  headerOf(noCards, optionId)?.strokeColor === headerOf(plain, optionId)?.strokeColor),
      [FIRST, SECOND, THIRD].map((optionId) => headerOf(noCards, optionId)?.strokeColor).join(', '));

// ─── 3. Something waiting, beside a real project ──────────────

console.log('\n3. with something waiting the column is drawn, appended, and counted');

const waiting = layoutMirror(board(), ORIGIN, withFounder());

check('a column exists under the reserved id', Boolean(columnOf(waiting, FOUNDER)),
      waiting.columns.map((column) => column.optionId).join(', '));
check('it is the last one, right of every column the project declared',
      waiting.columns[waiting.columns.length - 1]?.optionId === FOUNDER
      && waiting.columns.slice().sort((a, b) => b.x - a.x)[0]?.optionId === FOUNDER,
      waiting.columns.map((column) => `${column.name}@${column.x}`).join(' | '));
check('it is as wide as the rest, so it reads as one of the columns',
      columnOf(waiting, FOUNDER)?.width === columnOf(waiting, FIRST)?.width);
check('its header is locked like every other header',
      headerOf(waiting, FOUNDER)?.locked === true,
      JSON.stringify(headerOf(waiting, FOUNDER)?.locked));
check('and it is named by what the caller called it',
      columnOf(waiting, FOUNDER)?.name === FOUNDER_COLUMN,
      JSON.stringify(columnOf(waiting, FOUNDER)?.name));
check('the header counts what is in it, the way every other header does',
      headerLabel(waiting, FOUNDER) === `${FOUNDER_COLUMN} (${WAITING.length})`,
      JSON.stringify(headerLabel(waiting, FOUNDER)));
check('a name the caller chose is what is drawn, so this column is not a constant either',
      headerLabel(layoutMirror(board(), ORIGIN, withFounder(WAITING, 'Needs you')), FOUNDER)
        === `Needs you (${WAITING.length})`,
      JSON.stringify(headerLabel(layoutMirror(board(), ORIGIN, withFounder(WAITING, 'Needs you')), FOUNDER)));

console.log('\n3b. and the mirror grows by exactly one column');

check(`the width grows by ${ONE_COLUMN} and not by anything else`,
      mirrorWidth(board(), withFounder()) - mirrorWidth(board()) === ONE_COLUMN,
      `${mirrorWidth(board())} → ${mirrorWidth(board(), withFounder())}`);
check('which is one column and one gap',
      mirrorWidth(board(), withFounder()) === boardWidth(board().sections.length + 2),
      `${mirrorWidth(board(), withFounder())} vs ${boardWidth(board().sections.length + 2)}`);
check('and the width still covers everything the layout drew',
      waiting.elements.every((element) => element.x >= ORIGIN.x - 1
        && element.x + (element.width ?? 0) <= ORIGIN.x + mirrorWidth(board(), withFounder()) + 1),
      `width=${mirrorWidth(board(), withFounder())}`);
check('mirrorWidth still answers with one argument, the way App.tsx calls it',
      mirrorWidth(board()) === boardWidth(board().sections.length + 1),
      `${mirrorWidth(board())} vs ${boardWidth(board().sections.length + 1)}`);

console.log('\n3c. and nothing already drawn moved, changed hue or changed role');

check('every column the project declared keeps its index',
      waiting.columns.slice(0, plain.columns.length).map((column) => column.optionId).join(',')
        === plain.columns.map((column) => column.optionId).join(','),
      waiting.columns.map((column) => column.optionId).join(','));
check('and its horizontal position',
      plain.columns.every((column) =>
        columnOf(waiting, column.optionId)?.x === column.x),
      plain.columns.map((column) => `${column.optionId}@${column.x}`).join(' | '));
check('every header keeps the hue its index gave it',
      [FIRST, SECOND, THIRD].every((optionId) =>
        headerOf(waiting, optionId)?.strokeColor === headerOf(plain, optionId)?.strokeColor),
      [FIRST, SECOND, THIRD]
        .map((optionId) => `${headerOf(plain, optionId)?.strokeColor} → ${headerOf(waiting, optionId)?.strokeColor}`)
        .join(' | '));
check('and every card keeps the fill its column gave it',
      [FIRST, SECOND].every((optionId) =>
        cardsOf(waiting, optionId).map((element) => element.backgroundColor).join(',')
          === cardsOf(plain, optionId).map((element) => element.backgroundColor).join(',')),
      [FIRST, SECOND].map((optionId) => cardsOf(waiting, optionId)
        .map((element) => element.backgroundColor).join(',')).join(' | '));
check('the founder column takes the hue of its own index, which is a fifth one here',
      headerOf(waiting, FOUNDER)?.strokeColor
      && ![FIRST, SECOND, THIRD].some((optionId) =>
        headerOf(waiting, optionId)?.strokeColor === headerOf(waiting, FOUNDER)?.strokeColor),
      String(headerOf(waiting, FOUNDER)?.strokeColor));

// ─── 4. On a board with no project at all ─────────────────────

console.log('\n4. and on the board the canvas invents when there is no project');

const bare = notesOnlyBoard();
const alone = layoutMirror(bare, ORIGIN, withFounder());

check('the column is drawn there too — the case it exists for',
      Boolean(columnOf(alone, FOUNDER)),
      alone.columns.map((column) => column.optionId).join(', '));
check('beside the notes column and nothing else',
      alone.columns.map((column) => column.optionId).join(',')
        === `${types.NOTES_OPTION_ID ?? 'canvas:notes'},${FOUNDER}`,
      alone.columns.map((column) => column.optionId).join(','));
check('and the mirror is exactly two columns wide',
      mirrorWidth(bare, withFounder()) === boardWidth(2),
      `${mirrorWidth(bare, withFounder())} vs ${boardWidth(2)}`);
check('with nothing waiting it is one, exactly as it is today',
      mirrorWidth(bare) === boardWidth(1) && mirrorWidth(bare, withFounder([])) === boardWidth(1),
      `${mirrorWidth(bare)} / ${mirrorWidth(bare, withFounder([]))}`);
check('the cards are there to be read', founderCards(alone).length === WAITING.length,
      `${founderCards(alone).length} card(s)`);

// ─── 5. A project that declares the column itself ─────────────

console.log('\n5. a project with a column of that name gets one column, and it is its own');

const declared = board(['Icebox', FOUNDER_COLUMN, 'Shipped']);
const both = layoutMirror(declared, ORIGIN, withFounder());

check('no canvas-owned column is drawn beside it',
      !both.columns.some((column) => column.optionId === FOUNDER),
      both.columns.map((column) => `${column.name}(${column.optionId})`).join(' | '));
check('exactly one column carries that name',
      both.columns.filter((column) => column.name === FOUNDER_COLUMN).length === 1,
      both.columns.map((column) => column.name).join(' | '));
check('and it is the project\'s own, at the index the project put it',
      both.columns.find((column) => column.name === FOUNDER_COLUMN)?.optionId === SECOND,
      JSON.stringify(both.columns.find((column) => column.name === FOUNDER_COLUMN)?.optionId));
check('the mirror did not grow for a column it did not draw',
      mirrorWidth(declared, withFounder()) === mirrorWidth(declared),
      `${mirrorWidth(declared)} → ${mirrorWidth(declared, withFounder())}`);
check('and the strip does not count cards that were drawn nowhere',
      !/founder/i.test(titleText(both)), JSON.stringify(titleText(both)));
// Trimmed and case-insensitively, the way every other column lookup in this project is.
const spelled = layoutMirror(board(['Icebox', '  founder ACTIONS  ', 'Shipped']), ORIGIN, withFounder());
check('the match ignores case and surrounding space',
      !spelled.columns.some((column) => column.optionId === FOUNDER),
      spelled.columns.map((column) => column.name).join(' | '));
// The control: a project that declares no such column still gets one, so the four above are
// not passing on a layout that never draws this column at all.
check('a project that declares nothing of the sort still gets the canvas\'s own',
      Boolean(columnOf(layoutMirror(board(), ORIGIN, withFounder()), FOUNDER)));

// ─── 6. What a founder card is ────────────────────────────────

console.log('\n6. a founder card is a mirror card, and carries a key instead of an item id');

const drawn = founderCards(waiting);
check('both of them are drawn', drawn.length === WAITING.length, `${drawn.length} card(s)`);
check('under the mirror\'s own kind, so nothing saves, exports or syncs one',
      drawn.every((element) => element.customData?.kind === MIRROR_KIND),
      drawn.map((element) => String(element.customData?.kind)).join(', '));
check('with role "card" and not a role of its own',
      drawn.every((element) => element.customData?.role === 'card'),
      drawn.map((element) => String(element.customData?.role)).join(', '));
check('in the founder column',
      drawn.every((element) => element.customData?.sectionOptionId === FOUNDER),
      drawn.map((element) => String(element.customData?.sectionOptionId)).join(', '));
check('each carrying the key its record is held under',
      drawn.map((element) => element.customData?.founderKey).join(',')
        === WAITING.map((entry) => entry.key).join(','),
      drawn.map((element) => String(element.customData?.founderKey)).join(','));
check('and carrying no itemId at all — which is what stops a drag being written back',
      drawn.every((element) => typeof element.customData?.itemId !== 'string'),
      drawn.map((element) => JSON.stringify(element.customData?.itemId)).join(', '));
check('not locked, so it can still be selected',
      drawn.every((element) => element.locked === false),
      drawn.map((element) => String(element.locked)).join(', '));
check('and its label says what the person has to do',
      drawn.every((element, index) =>
        (labelIn(waiting, element)?.text ?? '').includes(WAITING[index].title.slice(0, 20))),
      drawn.map((element) => JSON.stringify(labelIn(waiting, element)?.text)).join(' | '));
check('every element the layout produced is still marked as mirror',
      waiting.elements.every((element) => element.customData?.kind === MIRROR_KIND),
      `${waiting.elements.filter((element) => element.customData?.kind !== MIRROR_KIND).length} unmarked`);
// The mirrored cards are still what they were: an itemId, and no founder key on any of them.
check('no card read from GitHub grew a founder key',
      cardsOf(waiting, FIRST).every((element) =>
        element.customData?.founderKey === undefined
        && typeof element.customData?.itemId === 'string'),
      cardsOf(waiting, FIRST).map((element) => JSON.stringify(element.customData)).join(' | '));

// ─── 7. The strip says how many are waiting ───────────────────

console.log('\n7. the strip carries the count, because a condition that lasts belongs there');

const stripLines = titleText(waiting).split('\n');
check('the strip gained a second line', stripLines.length === 2, JSON.stringify(titleText(waiting)));
check('the first line is still the project and its field',
      stripLines[0] === 'something — Status', JSON.stringify(stripLines[0]));
check('and the second names how many are waiting',
      stripLines[1] === `${WAITING.length} founder actions waiting`, JSON.stringify(stripLines[1]));
check('one of them is said in the singular',
      titleText(layoutMirror(board(), ORIGIN, withFounder([WAITING[0]]))).split('\n')[1]
        === '1 founder action waiting',
      JSON.stringify(titleText(layoutMirror(board(), ORIGIN, withFounder([WAITING[0]])))));
check('the strip is still as wide as the mirror it stands on',
      titleOf(waiting)?.width === mirrorWidth(board(), withFounder()),
      `${titleOf(waiting)?.width} vs ${mirrorWidth(board(), withFounder())}`);
check('and its label still fits inside it', (() => {
  const strip = titleOf(waiting);
  const text = labelIn(waiting, strip);
  return Boolean(strip && text)
    && text.x >= strip.x - 1 && text.x + text.width <= strip.x + strip.width + 1;
})());

// ─── 8. Nothing about the notes column changed ────────────────

console.log('\n8. observations are still the notes column\'s, and a founder action is never authored');

const NOTES = types.NOTES_OPTION_ID ?? 'canvas:notes';
const drafted = layoutMirror(board(), ORIGIN, {
  ...withFounder(),
  drafts: [
    { id: 'pbdraft-founder', sectionOptionId: FOUNDER, height: 120, createdAt: 3000 },
    { id: 'pbdraft-own', sectionOptionId: NOTES, height: 120, createdAt: 1000 },
  ],
});
const placementOf = (laid, id) => (laid.drafts ?? []).find((placement) => placement.id === id) ?? null;

check('a draft stamped with the founder id is rehomed to the notes column',
      placementOf(drafted, 'pbdraft-founder')?.x === columnOf(drafted, NOTES)?.x,
      `${placementOf(drafted, 'pbdraft-founder')?.x} vs ${columnOf(drafted, NOTES)?.x}`);
check('and not left in the founder column, which holds no hand-written block',
      placementOf(drafted, 'pbdraft-founder')?.x !== columnOf(drafted, FOUNDER)?.x,
      `founder column at ${columnOf(drafted, FOUNDER)?.x}`);
check('the notes header counts both drafts', headerLabel(drafted, NOTES)?.endsWith('(2)'),
      JSON.stringify(headerLabel(drafted, NOTES)));
check('the founder header counts only what is waiting, not the block dropped on it',
      headerLabel(drafted, FOUNDER) === `${FOUNDER_COLUMN} (${WAITING.length})`,
      JSON.stringify(headerLabel(drafted, FOUNDER)));
check('there is exactly one + on the whole mirror', addButtons(waiting).length === 1,
      `${addButtons(waiting).length} button(s)`);
check('and it is on the notes column, never on the founder one',
      addButtons(waiting)[0]?.customData?.sectionOptionId === NOTES,
      JSON.stringify(addButtons(waiting)[0]?.customData));
check('the notes column is still the first one, where the observations already are',
      waiting.columns[0]?.optionId === NOTES,
      waiting.columns.map((column) => column.optionId).join(','));

// ─── 9. mirrorSections is where the decision is ───────────────

console.log('\n9. and the decision is one function, so the width and the drawing cannot disagree');

check('mirrorSections appends the founder section when there is something in it',
      mirrorSections(board(), withFounder()).map((section) => section.optionId).join(',')
        === `${NOTES},${FIRST},${SECOND},${THIRD},${FOUNDER}`,
      mirrorSections(board(), withFounder()).map((section) => section.optionId).join(','));
check('and returns exactly today\'s sections when there is not',
      mirrorSections(board(), withFounder([])).map((section) => section.optionId).join(',')
        === mirrorSections(board()).map((section) => section.optionId).join(','),
      mirrorSections(board(), withFounder([])).map((section) => section.optionId).join(','));
check('mirrorWidth is that same answer counted, so the two cannot drift',
      mirrorWidth(board(), withFounder()) === boardWidth(mirrorSections(board(), withFounder()).length),
      `${mirrorWidth(board(), withFounder())} vs ${boardWidth(mirrorSections(board(), withFounder()).length)}`);
check('and it takes its second argument as optional',
      mirrorSections(board()).length === board().sections.length + 1,
      `${mirrorSections(board()).length} section(s)`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
