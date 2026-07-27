#!/usr/bin/env node
/**
 * Checks what the mirror is anchored to.
 *
 * The observation behind #99 was that the mirrored region kept drifting away from the
 * board's own content, up and to the left, with nobody touching either. Its origin was
 * recomputed on every twenty-second poll from two numbers and stored neither:
 *
 *   origin = { x: minX - MIRROR_GAP - boardWidth(sections), y: minY }
 *
 * `minX` / `minY` being the bounding box of *everything else on the canvas*. So the region
 * moved for two independent reasons. A column added on GitHub made the region wider and,
 * because it was pinned by its **right** edge, pushed every column that was already there
 * one column-width further left — including the first, the one carrying the `+`. And any
 * element added, moved or deleted anywhere that changed the scene's leftmost or topmost
 * coordinate dragged the whole region along by the same delta.
 *
 * Both are arithmetic, so both are checkable without a browser — the split
 * `project-board-layout.ts` already keeps, and the reason `boardWidth` is exported at all.
 * What a browser still has to confirm is that the arithmetic is wired to the poll:
 * `check-mirror-anchor-browser.mjs` drives a real Chrome across a column appearing.
 *
 * Written against the code as it was, per `CLAUDE.md`, which is why the two rules under
 * test are read out of the module **or reconstructed** when it does not export them yet.
 * A check that only asserted `typeof resolveMirrorOrigin === 'function'` would fail on the
 * old code for the wrong reason — a missing symbol rather than a region that walks — and
 * would say nothing about the defect it is supposed to describe.
 *
 * Offline and self-contained; it reads the compiled modules, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-mirror-anchor.mjs
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

const layoutPath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
const terminalPath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
for (const path of [layoutPath, terminalPath]) {
  if (!existsSync(path)) {
    console.error(`  FAIL  the compiled modules exist — ${path} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
}

const layout = await import(pathToFileURL(layoutPath).href);
const { layoutBoard, boardWidth, MIRROR_KIND } = layout;
const { TERMINAL_KIND } = await import(pathToFileURL(terminalPath).href);

/**
 * The gap between the mirror's right edge and the board's own left edge.
 *
 * It lived in the component before it lived beside the arithmetic that uses it, so the
 * literal is the fallback for a build that predates the move.
 */
const MIRROR_GAP = typeof layout.MIRROR_GAP === 'number' ? layout.MIRROR_GAP : 120;

/**
 * The origin rule under test — the module's, or the one the component held inline before it.
 *
 * The reconstruction is the old behaviour exactly: measure every time, remember nothing.
 */
const resolveOrigin = typeof layout.resolveMirrorOrigin === 'function'
  ? layout.resolveMirrorOrigin
  : (_remembered, bounds, width) => ({
    origin: bounds
      ? { x: bounds.minX - MIRROR_GAP - width, y: bounds.minY }
      : { x: -(width + MIRROR_GAP), y: 0 },
    settled: false,
  });

/**
 * Which elements the region is measured against — the module's rule, or the component's.
 *
 * The old one left out the mirror's own shapes, the terminal block, the draft blocks and
 * the labels bound to a draft. A label bound to the *terminal* was in it: that text carries
 * no `kind` of its own, so on its own terms it looked authored.
 */
const anchorsOf = typeof layout.mirrorAnchors === 'function'
  ? layout.mirrorAnchors
  : (elements) => {
    const alive = elements.filter((element) => !element.isDeleted
      && (element.customData ?? {}).kind !== MIRROR_KIND);
    const drafts = alive.filter((element) => (element.customData ?? {}).projectBoardDraft === true
      && !element.containerId);
    return alive.filter((element) => !drafts.includes(element)
      && (element.customData ?? {}).kind !== TERMINAL_KIND
      && !(element.containerId && drafts.some((draft) => draft.id === element.containerId)));
  };

// ─── A board, and a canvas to anchor it against ───────────────

const MY_NOTES = 'aa11bb22';
const TODO = 'f75ad846';
const DOING = '47fc9ee4';
const NO_STATUS = '';

const card = (itemId, title) => ({
  itemId,
  number: 1,
  title,
  url: `https://github.com/vitorengers/mcp_excalidraw/issues/${itemId}`,
  draggable: true,
});

/** Three columns, which is what the live board's own geometry said it had been drawn for. */
const board = (optionIds) => ({
  projectTitle: 'mcp_excalidraw',
  projectUrl: 'https://github.com/users/vitorengers/projects/5',
  fieldName: 'Status',
  sections: optionIds.map((optionId, index) => ({
    optionId,
    name: `Column ${index}`,
    cards: [card(`item-${optionId}`, 'A card')],
    hidden: 0,
  })),
});

const THREE = [MY_NOTES, TODO, DOING];
const FOUR = [MY_NOTES, TODO, DOING, NO_STATUS];

/** The board's own content: one shape, well to the right of where the mirror will land. */
const CONTENT = { minX: 0, minY: -150 };

const columnsOf = (result) => result.columns.map((column) => column.x);

// ─── 1. A column added on GitHub leaves the other columns alone ─

console.log('1. a section added to the board does not move the columns already there');

const first = resolveOrigin(null, CONTENT, boardWidth(THREE.length));
check('a first render measures the region against the board\'s own content',
      first.origin.x === CONTENT.minX - MIRROR_GAP - boardWidth(THREE.length)
      && first.origin.y === CONTENT.minY,
      JSON.stringify(first.origin));
check('and that measurement is one to keep, rather than one to take again next poll',
      first.settled === true,
      'nothing remembers where the region was put, so the next poll measures again');

const grown = resolveOrigin(first.origin, CONTENT, boardWidth(FOUR.length));
const before = columnsOf(layoutBoard(board(THREE), first.origin));
const after = columnsOf(layoutBoard(board(FOUR), grown.origin));

check('the columns that were already there are at the same x afterwards',
      JSON.stringify(after.slice(0, THREE.length)) === JSON.stringify(before),
      `${JSON.stringify(before)} became ${JSON.stringify(after.slice(0, THREE.length))}`);
check('the new column is the one that appears, at the right-hand end',
      after.length === FOUR.length && after[FOUR.length - 1] > (before[before.length - 1] ?? 0),
      JSON.stringify(after));
check('so the + keeps its place, being on the first column of all',
      after[0] === before[0],
      `the + moved ${Math.abs((after[0] ?? 0) - (before[0] ?? 0))} units`);

// A `No Status` section is appended only while something is in it, so it comes and goes on
// its own. Losing it must be as quiet as gaining it.
const shrunk = resolveOrigin(grown.origin, CONTENT, boardWidth(THREE.length));
check('and a section that goes away again moves nothing either',
      JSON.stringify(columnsOf(layoutBoard(board(THREE), shrunk.origin))) === JSON.stringify(before),
      JSON.stringify(columnsOf(layoutBoard(board(THREE), shrunk.origin))));

// ─── 2. The rest of the canvas is no longer an input ──────────

console.log('\n2. an element added or deleted elsewhere on the canvas does not move the region');

const width = boardWidth(THREE.length);
const moved = [
  ['a shape dropped further left', { minX: -900, minY: -150 }],
  ['a card added at the top of the development map', { minX: 0, minY: -1400 }],
  ['a screenshot pasted above and to the left', { minX: -640, minY: -980 }],
  ['the leftmost element erased', { minX: 320, minY: -150 }],
];
for (const [what, bounds] of moved) {
  const next = resolveOrigin(first.origin, bounds, width);
  check(`${what} leaves the region where it was`,
        next.origin.x === first.origin.x && next.origin.y === first.origin.y,
        `${JSON.stringify(first.origin)} became ${JSON.stringify(next.origin)}`);
}

// ─── 3. One predicate, stated the same way at all three doors ──

console.log('\n3. a label bound to the terminal is not something the region measures against');

const element = (id, x, y, extra = {}) => ({
  id, x, y, width: 200, height: 100, isDeleted: false, containerId: null, customData: null, ...extra,
});

const scene = [
  element('authored', 0, -150),
  element('terminal-block', 2400, -150, { customData: { kind: TERMINAL_KIND } }),
  // The block is the one shape the reader is expected to drag and resize, and Excalidraw
  // offers to bind text to whatever is selected. The label carries no `kind` of its own.
  element('terminal-title', 2400, -900, { containerId: 'terminal-block', customData: null }),
  element('pbdraft-1', -1092, -22, { customData: { projectBoardDraft: true } }),
  element('pbdraft-1-label', -1092, -22, { containerId: 'pbdraft-1', customData: null }),
  element('pb-c-item', -1116, -22, { customData: { kind: MIRROR_KIND, role: 'card' } }),
  element('erased', -5000, -5000, { isDeleted: true }),
];

const anchors = anchorsOf(scene);
const ids = anchors.map((entry) => entry.id).sort();
check('the board\'s own shapes are what it measures',
      JSON.stringify(ids) === JSON.stringify(['authored']),
      JSON.stringify(ids));
check('a title bound to the terminal is left out, the way the block itself is',
      !ids.includes('terminal-title'),
      'the terminal is excluded so the two regions do not walk apart; its label must be too');

// The measurement itself, so the exclusion is asserted where it has an effect rather than
// only on a list of ids.
const boundsOf = (elements) => (elements.length === 0 ? null : {
  minX: Math.min(...elements.map((entry) => entry.x)),
  minY: Math.min(...elements.map((entry) => entry.y)),
});
const withLabel = resolveOrigin(null, boundsOf(anchors), width);
check('so dragging that titled block up and to the left moves nothing',
      withLabel.origin.y === -150,
      `origin.y = ${withLabel.origin.y}, which is the label's own top rather than the board's`);

// ─── 4. A canvas with nothing on it to measure ────────────────

console.log('\n4. a board with nothing on it still gets an origin');

const empty = resolveOrigin(null, null, width);
check('the origin is finite, rather than the Infinity an empty bounding box returns',
      Number.isFinite(empty.origin.x) && Number.isFinite(empty.origin.y),
      JSON.stringify(empty.origin));
check('and it is not one to keep, so the first real content still anchors the region',
      empty.settled === false,
      'a fallback remembered forever would leave the mirror where an empty canvas put it');

const derivedOnly = anchorsOf(scene.filter((entry) => entry.id !== 'authored'));
check('a canvas holding nothing but derived shapes measures against none of them',
      derivedOnly.length === 0,
      JSON.stringify(derivedOnly.map((entry) => entry.id)));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
