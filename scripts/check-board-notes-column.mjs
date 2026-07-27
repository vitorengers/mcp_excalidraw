#!/usr/bin/env node
/**
 * Checks that the column observations are written in belongs to the canvas, not to GitHub.
 *
 * The mirror drew that column by taking whichever `Status` option the project happened to
 * declare first, and stamping that option's id onto every block the `+` dropped. So a
 * column whose entire population is authored here — no card of it is ever mirrored, and
 * nothing has ever put a project item in it — could only exist if GitHub was told to keep
 * an empty option for it. Project 5 declared `My Notes` (`85bb15e9`) and held 48 items,
 * none of them in it.
 *
 * The cost of that arrangement is only visible when the option goes: `Todo` becomes the
 * first option, so the `+` lands on it and observations share a column with real issues
 * again — and every block already carrying `85bb15e9` names a column the board no longer
 * has, which `layoutBoard` places nowhere and counts in no header. Authored elements,
 * silently unplaced.
 *
 * So the notes column gets a representation of its own: a section under a reserved id that
 * is not, and cannot be, an option id. The cases here are what that has to buy.
 *
 * - It renders **with no matching option on the project**, first, and holds the only `+`.
 * - A draft carrying the reserved id is placed and counted **whatever the first option is
 *   called** — rename all three and nothing moves.
 * - A draft carrying an option id the board no longer has is **placed** in it rather than
 *   dropped. This is the one rule that is reversed rather than added: a draft naming a
 *   column that is gone used to be left where it sat, and the blocks the deleted option
 *   left behind are exactly that population.
 * - The notes header's number is the draft count, with no cards behind it.
 * - The reserved id could not be written back to GitHub even by a caller that tried:
 *   `buildMoveArgs` refuses it, so a card dropped into the column can only ever snap back.
 *
 * The fixture's options are named `Icebox` / `Underway` / `Shipped`, the way
 * `check-board-counts.mjs` names its own, so nothing keying on `Todo` or on `My Notes`
 * could pass — and they are renamed mid-run to prove the notes column does not key on a
 * name either.
 *
 * **Run against the code before the fix, this fails on behaviour rather than on a missing
 * export.** The entry point is resolved as "whichever function this build lays the mirror
 * out with", so on the old build it is `layoutBoard` — which is what the canvas called
 * directly — and the failures are the real ones: three columns instead of four, the `+` on
 * `Icebox`, and the draft from the deleted column placed nowhere.
 *
 * Offline and self-contained; it reads the compiled modules, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-board-notes-column.mjs
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

const { layoutBoard, layoutMirror, mirrorWidth, boardWidth, MIRROR_KIND } = layout;
const { buildMoveArgs } = reader;

/**
 * How the canvas lays the mirror out.
 *
 * `layoutMirror` on a build that has it; `layoutBoard` on one that does not, which is what
 * the canvas called before this change — so this check can be pointed at the old code and
 * fail on what it draws rather than on a symbol that is missing.
 */
const layMirror = typeof layoutMirror === 'function' ? layoutMirror : layoutBoard;
const widthOf = typeof mirrorWidth === 'function'
  ? mirrorWidth
  : (board) => boardWidth(board.sections.length);

/** The reserved id, from the module that owns it — never spelled out here. */
const NOTES = types.NOTES_OPTION_ID;

// ─── Fixtures ─────────────────────────────────────────────────

/** Deliberately not the ids project 5 uses, and deliberately not its names either. */
const FIRST = 'a1a1a1a1';
const SECOND = 'b2b2b2b2';
const THIRD = 'c3c3c3c3';
const NAMES = ['Icebox', 'Underway', 'Shipped'];

/** An option id the board no longer has: what the deleted notes option left behind. */
const DELETED = '85bb15e9';

function card(number, optionId) {
  return {
    itemId: `PVTI_${number}`,
    contentType: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://example.invalid/issues/${number}`,
    state: 'OPEN',
    createdAt: '2026-07-01T10:00:00Z',
    repository: 'someone/something',
    draggable: true,
    optionId,
  };
}

/** A project with three options and no fourth one standing in for the canvas's column. */
function board(names = NAMES, cards = [[card(1)], [card(9)], []]) {
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
      cards: cards[index],
      hidden: 0,
    })),
  };
}

const ORIGIN = { x: -1600, y: 0 };

const draft = (id, sectionOptionId, createdAt, height = 120) =>
  ({ id, sectionOptionId, height, createdAt });

const columnOf = (laid, optionId) => laid.columns.find((column) => column.optionId === optionId) ?? null;
const headerOf = (laid, optionId) => laid.elements.find((element) =>
  element.customData?.role === 'section' && element.customData?.sectionOptionId === optionId) ?? null;
const headerLabel = (laid, optionId) => {
  const header = headerOf(laid, optionId);
  if (!header) return null;
  const label = laid.elements.find((element) => element.containerId === header.id);
  return (label?.text ?? '').replace(/\s*\n\s*/g, ' ');
};
const addButtons = (laid) => laid.elements.filter((element) => element.customData?.role === 'add');
const placementOf = (laid, id) => (laid.drafts ?? []).find((placement) => placement.id === id) ?? null;
const cardsOf = (laid, optionId) => laid.elements.filter((element) =>
  element.customData?.role === 'card' && element.customData?.sectionOptionId === optionId);

// ─── 1. A column with no option behind it ─────────────────────

console.log('1. the notes column is drawn from a project that declares no option for it');

const project = board();
const laid = layMirror(project, ORIGIN);

check('the reserved id is not something GitHub could have returned',
      typeof NOTES === 'string' && NOTES.length > 0
      && !project.sections.some((section) => section.optionId === NOTES),
      JSON.stringify(NOTES));
check('a column exists under it, though nothing on the project matches',
      Boolean(columnOf(laid, NOTES)), laid.columns.map((column) => column.optionId).join(', '));
check('and it is the first one, left of every column the project declared',
      laid.columns[0]?.optionId === NOTES
      && laid.columns.slice().sort((a, b) => a.x - b.x)[0]?.optionId === NOTES,
      laid.columns.map((column) => `${column.name}@${column.x}`).join(' | '));
check('the project\'s own columns follow it, in the order the project declares them',
      laid.columns.slice(1).map((column) => column.optionId).join(',') === [FIRST, SECOND, THIRD].join(','),
      laid.columns.map((column) => column.optionId).join(','));
check('it is as wide as the rest, so it reads as one of the columns',
      columnOf(laid, NOTES)?.width === columnOf(laid, FIRST)?.width);
check('it has a header of its own, locked like the others',
      headerOf(laid, NOTES)?.locked === true, JSON.stringify(headerOf(laid, NOTES)?.locked));
check('every element the layout produced is still marked as mirror',
      laid.elements.length > 0 && laid.elements.every((element) => element.customData?.kind === MIRROR_KIND),
      `${laid.elements.filter((element) => element.customData?.kind !== MIRROR_KIND).length} unmarked`);
check('and the width it reserves covers everything it drew',
      laid.elements.every((element) => element.x >= ORIGIN.x - 1
        && element.x + (element.width ?? 0) <= ORIGIN.x + widthOf(project) + 1),
      `width=${widthOf(project)}`);

console.log('\n1b. and it holds the only +');
check('exactly one + on the whole mirror', addButtons(laid).length === 1,
      `${addButtons(laid).length} button(s)`);
check('on the notes column, not on the first option the project happens to declare',
      addButtons(laid)[0]?.customData?.sectionOptionId === NOTES,
      JSON.stringify(addButtons(laid)[0]?.customData));
check('so a block dropped by it names a column no card can ever be moved into',
      addButtons(laid)[0]?.customData?.sectionOptionId !== FIRST);

// ─── 2. Nothing keys on what the options are called ───────────

console.log('\n2. a draft with the reserved id is placed and counted whatever the options are called');

const withDraft = layMirror(board(), ORIGIN, { drafts: [draft('pbdraft-a', NOTES, 2000)] });
const renamed = layMirror(board(['Backlog', 'Cooking', 'Landed']), ORIGIN, {
  drafts: [draft('pbdraft-a', NOTES, 2000)],
});

check('the draft is placed', Boolean(placementOf(withDraft, 'pbdraft-a')),
      JSON.stringify(withDraft.drafts));
check('in the notes column, at the top of it',
      Boolean(placementOf(withDraft, 'pbdraft-a')) && Boolean(columnOf(withDraft, NOTES))
      && placementOf(withDraft, 'pbdraft-a')?.x === columnOf(withDraft, NOTES)?.x
      && placementOf(withDraft, 'pbdraft-a')?.y === columnOf(withDraft, NOTES)?.draftsTop,
      JSON.stringify(placementOf(withDraft, 'pbdraft-a')));
check('renaming every option on the project moves it nowhere',
      Boolean(placementOf(renamed, 'pbdraft-a'))
      && JSON.stringify(placementOf(renamed, 'pbdraft-a')) === JSON.stringify(placementOf(withDraft, 'pbdraft-a')),
      `${JSON.stringify(placementOf(withDraft, 'pbdraft-a'))} → ${JSON.stringify(placementOf(renamed, 'pbdraft-a'))}`);
check('and the notes header still counts it',
      typeof headerLabel(renamed, NOTES) === 'string'
      && headerLabel(renamed, NOTES) === headerLabel(withDraft, NOTES),
      `${headerLabel(withDraft, NOTES)} → ${headerLabel(renamed, NOTES)}`);
check('no header on the board mentions a column name this repository could have written',
      laid.elements.filter((element) => element.customData?.role === 'label')
        .every((element) => !/Todo|In Progress|Done/.test(element.text ?? '')),
      laid.elements.filter((element) => element.customData?.role === 'label')
        .map((element) => element.text).join(' | '));

// ─── 3. The blocks the deleted option left behind ─────────────

console.log('\n3. a draft naming an option the board no longer has lands in the notes column');

const stale = layMirror(board(), ORIGIN, {
  drafts: [draft('pbdraft-stale', DELETED, 3000, 140), draft('pbdraft-own', NOTES, 1000)],
});

check('it is placed rather than dropped', Boolean(placementOf(stale, 'pbdraft-stale')),
      JSON.stringify(stale.drafts));
check('in the notes column',
      Boolean(placementOf(stale, 'pbdraft-stale')) && Boolean(columnOf(stale, NOTES))
      && placementOf(stale, 'pbdraft-stale')?.x === columnOf(stale, NOTES)?.x,
      `${placementOf(stale, 'pbdraft-stale')?.x} vs ${columnOf(stale, NOTES)?.x}`);
check('stacked with the blocks already there, newest on top',
      placementOf(stale, 'pbdraft-stale')?.y === columnOf(stale, NOTES)?.draftsTop
      && (placementOf(stale, 'pbdraft-own')?.y ?? 0) >= (placementOf(stale, 'pbdraft-stale')?.y ?? 0) + 140,
      JSON.stringify(stale.drafts));
check('and the notes header counts both of them',
      headerLabel(stale, NOTES)?.endsWith('(2)'), JSON.stringify(headerLabel(stale, NOTES)));
check('no column the project declared grew for it',
      [FIRST, SECOND, THIRD].every((optionId) =>
        headerLabel(stale, optionId) === headerLabel(laid, optionId)),
      [FIRST, SECOND, THIRD].map((optionId) => headerLabel(stale, optionId)).join(' | '));

// ─── 4. What the notes header says ────────────────────────────

console.log('\n4. the notes header is a draft count, because a draft is all it can hold');

check('empty, it reads zero', headerLabel(laid, NOTES)?.endsWith('(0)'),
      JSON.stringify(headerLabel(laid, NOTES)));
check('one draft reads one', headerLabel(withDraft, NOTES)?.endsWith('(1)'),
      JSON.stringify(headerLabel(withDraft, NOTES)));
check('and no card is ever drawn in it, on a board where every option holds some',
      cardsOf(layMirror(board(NAMES, [[card(1)], [card(9)], [card(20)]]), ORIGIN), NOTES).length === 0);
check('the label still fits inside the header it is bound to', (() => {
  const header = headerOf(withDraft, NOTES);
  const text = withDraft.elements.find((element) => element.containerId === header?.id);
  return Boolean(header && text)
    && text.x >= header.x - 1 && text.x + text.width <= header.x + header.width + 1;
})());

// ─── 5. It is not a column anything can be moved to ───────────

console.log('\n5. the reserved id could not reach GitHub even if a caller tried');

let refused = null;
try {
  buildMoveArgs({
    projectId: 'PVT_kwHOBVSHIs4BefUS',
    fieldId: 'PVTSSF_status',
    itemId: 'PVTI_1',
    optionId: NOTES,
  });
} catch (error) {
  refused = error;
}
check('a move naming it is refused before a command line is built', refused !== null,
      'buildMoveArgs accepted the notes column as a single-select option');
check('and it is refused for what it is, not for being unknown to some project',
      /optionId/i.test(String(refused?.message ?? '')), String(refused?.message));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
