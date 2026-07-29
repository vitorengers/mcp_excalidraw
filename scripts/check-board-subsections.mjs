#!/usr/bin/env node
/**
 * Checks the subsection resolver — the level below a section — without a browser.
 *
 * `check-board-map.mjs` does this for sections, and this is the same shape one level down,
 * for the same reason `board-sections.ts` gives: a hotkey that does nothing compiles
 * perfectly. What a board gets to say about its own parts is a pure function's answer, so
 * that is what is checked here, against boards built in memory.
 *
 * The rules a subsection has to obey:
 *
 *   - a shape carrying `customData.kind = "board-subsection"` and a title belongs to the
 *     **smallest** section that encloses it, which is how a board declares nesting by
 *     drawing it rather than by keeping a parent id in sync;
 *   - within a section they come back in reading order — down the board, then across;
 *   - a declared `order` does not decide anything. Geometry does, and an `order` that
 *     disagrees with where the shape actually sits is reported rather than obeyed;
 *   - a shape inside no section at all, or one that never names itself, is reported and
 *     dropped instead of quietly joining somebody;
 *   - **a board that draws none resolves to nothing to step between**, which is every
 *     board that never draws one, and is what keeps `Alt+Left` and `Alt+Right` the
 *     browser's own Back and Forward everywhere else.
 *
 * And the movement itself, which is the part the frontend asks for rather than computing:
 * given where the viewport is, which subsection does one step land on.
 *
 * Offline. Run `./node_modules/.bin/tsc` first — the resolver is a compiled module.
 *
 * Usage: node scripts/check-board-subsections.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const modulePath = join(repoRoot, 'dist', 'core', 'board-subsections.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the subsection resolver exists — dist/core/board-subsections.js not found');
  console.error('        (a board can be cut into sections but not into their parts; run tsc if it can)');
  process.exit(1);
}

const {
  BOARD_SUBSECTION_KIND,
  resolveBoardSubsections,
  stepBetweenSubsections,
  describeIgnoredSubsectionClaims,
} = await import(pathToFileURL(modulePath).href);

const { BOARD_SECTION_KIND } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'board-sections.js')).href
);

const section = (id, box, title = id) => ({
  id, type: 'rectangle', ...box,
  customData: { kind: BOARD_SECTION_KIND, title, hotkeyCode: 'KeyP' },
});

const part = (id, box, extra = {}) => ({
  id, type: 'rectangle', ...box,
  customData: { kind: BOARD_SUBSECTION_KIND, title: id, ...extra },
});

/** One section, three parts down its length, plus a plain shape that is neither. */
const BOARD = [
  section('structure', { x: 0, y: 0, width: 1000, height: 900 }, 'Project structure'),
  part('third', { x: 20, y: 620, width: 400, height: 200 }),
  part('first', { x: 20, y: 20, width: 400, height: 200 }),
  part('second', { x: 20, y: 320, width: 400, height: 200 }),
  { id: 'a card', type: 'rectangle', x: 40, y: 40, width: 100, height: 60 },
];

console.log('1. a board declares its parts by drawing them inside a section');
const one = resolveBoardSubsections(BOARD);
check('the section comes back with its parts', one.groups.length === 1
      && one.groups[0].sectionId === 'structure', JSON.stringify(one.groups));
check('and it names itself as the board named it',
      one.groups[0]?.sectionTitle === 'Project structure', JSON.stringify(one.groups[0]));
check('in reading order, down the board rather than in scene order',
      one.groups[0]?.subsections.map((sub) => sub.elementId).join(',') === 'first,second,third',
      JSON.stringify(one.groups[0]?.subsections.map((sub) => sub.elementId)));
check('nothing was thrown away', one.ignored.length === 0, JSON.stringify(one.ignored));
check('and a shape that is neither is not one of them',
      one.groups[0]?.subsections.every((sub) => sub.elementId !== 'a card'));

console.log('\n2. a board that draws none has nothing to step between');
check('no subsections, no parts',
      resolveBoardSubsections([section('only', { x: 0, y: 0, width: 100, height: 100 })])
        .groups.every((group) => group.subsections.length === 0));
check('and no section either is simply empty',
      resolveBoardSubsections([{ id: 'plain', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }])
        .groups.length === 0);
check('so one step lands nowhere',
      stepBetweenSubsections([section('only', { x: 0, y: 0, width: 100, height: 100 })],
                             { x: 50, y: 50 }, 1) === null);

console.log('\n3. each part belongs to the section that encloses it, and to the smallest one');
const nested = [
  section('outer', { x: 0, y: 0, width: 2000, height: 2000 }, 'Everything'),
  section('inner', { x: 0, y: 0, width: 500, height: 500 }, 'A corner of it'),
  part('deep', { x: 10, y: 10, width: 100, height: 100 }),
  part('shallow', { x: 900, y: 900, width: 100, height: 100 }),
];
const byArea = resolveBoardSubsections(nested);
const home = (id) => byArea.groups.find((group) => group.subsections.some((sub) => sub.elementId === id))?.sectionId;
check('a part inside two sections belongs to the smaller', home('deep') === 'inner', String(home('deep')));
check('and one inside only the larger belongs to that', home('shallow') === 'outer', String(home('shallow')));
check('a part enclosed by nothing is reported, not adopted', (() => {
  const homeless = resolveBoardSubsections([
    section('somewhere', { x: 0, y: 0, width: 100, height: 100 }),
    part('adrift', { x: 5000, y: 5000, width: 50, height: 50 }),
  ]);
  return homeless.groups.every((group) => group.subsections.length === 0)
    && homeless.ignored.length === 1 && homeless.ignored[0].reason === 'homeless';
})());
check('a part that never names itself is reported, not stepped onto', (() => {
  const unnamed = resolveBoardSubsections([
    section('somewhere', { x: 0, y: 0, width: 1000, height: 1000 }),
    { id: 'blank', type: 'rectangle', x: 10, y: 10, width: 50, height: 50,
      customData: { kind: BOARD_SUBSECTION_KIND } },
  ]);
  return unnamed.groups[0].subsections.length === 0
    && unnamed.ignored.length === 1 && unnamed.ignored[0].reason === 'malformed';
})());
check('a deleted part is not one', (() => {
  const gone = resolveBoardSubsections([
    section('somewhere', { x: 0, y: 0, width: 1000, height: 1000 }),
    { ...part('rubbed out', { x: 10, y: 10, width: 50, height: 50 }), isDeleted: true },
  ]);
  return gone.groups[0].subsections.length === 0 && gone.ignored.length === 0;
})());

console.log('\n4. geometry decides the order, and an `order` that disagrees is said out loud');
// The field is redundant with where the shape sits, which is an invitation for the two to
// disagree — so one of them has to be the answer. Geometry is, for the reason the section
// resolver sorts by position: a board that moves a part has said something, and a board
// that edits a number in a file nobody can see has not.
const numbered = resolveBoardSubsections([
  section('structure', { x: 0, y: 0, width: 1000, height: 900 }),
  part('lower', { x: 20, y: 500, width: 200, height: 100 }, { order: 1 }),
  part('upper', { x: 20, y: 20, width: 200, height: 100 }, { order: 2 }),
]);
check('the part higher on the board comes first, whatever it declared',
      numbered.groups[0].subsections.map((sub) => sub.elementId).join(',') === 'upper,lower',
      JSON.stringify(numbered.groups[0].subsections.map((sub) => sub.elementId)));
check('and both disagreements are reported',
      numbered.ignored.length === 2 && numbered.ignored.every((claim) => claim.reason === 'order'),
      JSON.stringify(numbered.ignored));
check('an `order` that agrees with the drawing is not a complaint', (() => {
  const agreeing = resolveBoardSubsections([
    section('structure', { x: 0, y: 0, width: 1000, height: 900 }),
    part('upper', { x: 20, y: 20, width: 200, height: 100 }, { order: 1 }),
    part('lower', { x: 20, y: 500, width: 200, height: 100 }, { order: 2 }),
  ]);
  return agreeing.ignored.length === 0;
})());
check('and a part that declares no order never complains', one.ignored.length === 0);
check('every rejected claim can be printed as one line',
      /adrift/.test(describeIgnoredSubsectionClaims(resolveBoardSubsections([
        section('somewhere', { x: 0, y: 0, width: 100, height: 100 }),
        part('adrift', { x: 5000, y: 5000, width: 50, height: 50 }),
      ]).ignored)));

console.log('\n5. one step, from wherever the viewport is');
const centreOf = (id) => {
  const element = BOARD.find((candidate) => candidate.id === id);
  return { x: element.x + element.width / 2, y: element.y + element.height / 2 };
};
const stepFrom = (id, direction) => stepBetweenSubsections(BOARD, centreOf(id), direction)?.elementId ?? null;

check('forward from the first lands on the second', stepFrom('first', 1) === 'second', String(stepFrom('first', 1)));
check('back from the second lands on the first', stepFrom('second', -1) === 'first', String(stepFrom('second', -1)));
check('forward from the second lands on the third', stepFrom('second', 1) === 'third', String(stepFrom('second', 1)));

// Open question 1, answered: it stops. Two sections with a handful of parts each is a short
// walk, and wrapping means the end of a section is the one place the reader cannot feel.
check('forward from the last stays on the last rather than wrapping',
      stepFrom('third', 1) === 'third', String(stepFrom('third', 1)));
check('and back from the first stays on the first',
      stepFrom('first', -1) === 'first', String(stepFrom('first', -1)));

// Open question 2, answered: the nearest. A key that does nothing because the reader is
// between two things is a key they stop trusting, and the first press is what puts them on
// the walk rather than one step along it.
check('from inside the section but on no part, the first press lands on the nearest',
      stepBetweenSubsections(BOARD, { x: 500, y: 40 }, 1)?.elementId === 'first',
      JSON.stringify(stepBetweenSubsections(BOARD, { x: 500, y: 40 }, 1)));
check('which is the last one when that is what is nearest',
      stepBetweenSubsections(BOARD, { x: 500, y: 880 }, -1)?.elementId === 'third',
      JSON.stringify(stepBetweenSubsections(BOARD, { x: 500, y: 880 }, -1)));
check('and from off the board entirely, the nearest section still answers',
      stepBetweenSubsections(BOARD, { x: -9000, y: -9000 }, 1)?.elementId === 'first',
      JSON.stringify(stepBetweenSubsections(BOARD, { x: -9000, y: -9000 }, 1)));

console.log('\n6. a step never leaves the section the reader is in');
const twoSections = [
  section('structure', { x: 0, y: 0, width: 1000, height: 900 }, 'Project structure'),
  part('s1', { x: 20, y: 20, width: 200, height: 100 }),
  part('s2', { x: 20, y: 500, width: 200, height: 100 }),
  section('development', { x: 0, y: 1000, width: 1000, height: 900 }, 'Development'),
  part('d1', { x: 20, y: 1020, width: 200, height: 100 }),
  part('d2', { x: 20, y: 1500, width: 200, height: 100 }),
];
const at = (x, y, direction) => stepBetweenSubsections(twoSections, { x, y }, direction)?.elementId ?? null;
check('two sections keep two walks', resolveBoardSubsections(twoSections).groups.length === 2);
check('the end of the first does not step into the second', at(120, 550, 1) === 's2', String(at(120, 550, 1)));
check('and the start of the second does not step back into the first',
      at(120, 1070, -1) === 'd1', String(at(120, 1070, -1)));
check('while inside the second, the walk is the second section\'s',
      at(120, 1070, 1) === 'd2', String(at(120, 1070, 1)));

console.log('\n7. this repository\'s own board');
// It draws no subsections yet, and that has to be the resolver's answer rather than a
// crash: the feature is for boards that want it, and this one is two sections and no parts.
const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
const scene = JSON.parse(readFileSync(resolve(repoRoot, config.board), 'utf8'));
const own = resolveBoardSubsections((scene.elements ?? []).filter((element) => !element.isDeleted));
check('resolves without complaint', own.ignored.length === 0, JSON.stringify(own.ignored));
check('and every section it finds is one this board drew',
      own.groups.length >= 2, `${own.groups.length} section(s)`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
