#!/usr/bin/env node
/**
 * Checks where the mirror puts the blocks the `+` dropped.
 *
 * The two defects behind #55 are both arithmetic: a new draft landed *under* the drafts
 * already in its column instead of on top of them, and the cards below a draft did not
 * move while the block grew under a caret. Neither could be checked, because the slotting
 * lived in the component — so this checks the pure function it moved into, the same way
 * `check-anchored-placement.mjs` checks placement without a browser.
 *
 * What a browser still has to confirm is the trigger, not the arithmetic: that typing into
 * a freshly dropped block re-runs this with a taller draft, and that the editor survives it.
 *
 * Offline and self-contained; it reads the compiled modules, so run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-board-drafts.mjs
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

const modulePath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the project board layout exists — dist/core/project-board-layout.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { layoutBoard, CARD_GAP, MIRROR_KIND } = await import(pathToFileURL(modulePath).href);

// ─── Fixtures ─────────────────────────────────────────────────

const TODO = 'f75ad846';
const DOING = '47fc9ee4';

function card(itemId, title) {
  return {
    itemId,
    contentType: 'Issue',
    number: Number(itemId.replace(/\D/g, '')) || 1,
    title,
    url: `https://github.com/vitorengers/mcp_excalidraw/issues/${itemId}`,
    state: 'OPEN',
    createdAt: '2026-07-01T10:00:00Z',
    repository: 'vitorengers/mcp_excalidraw',
    draggable: true,
  };
}

function board({ todo = [card('1', 'First todo'), card('2', 'Second todo')], doing = [card('9', 'Being worked on')] } = {}) {
  return {
    projectId: 'PVT_kwHOBVSHIs4BefUS',
    projectTitle: 'mcp_excalidraw',
    projectUrl: 'https://github.com/users/vitorengers/projects/5',
    fieldId: 'PVTSSF_status',
    fieldName: 'Status',
    morePages: false,
    sections: [
      { optionId: TODO, name: 'Todo', cards: todo, hidden: 0 },
      { optionId: DOING, name: 'In Progress', cards: doing, hidden: 0 },
    ],
  };
}

const ORIGIN = { x: -1200, y: 0 };

/** Where cards start when nothing is reserved — the top of the column, before drafts. */
const bareTop = (optionId) => {
  const bare = layoutBoard(board(), ORIGIN);
  return bare.columns.find((column) => column.optionId === optionId)?.cardsTop;
};

const draftsOf = (laid) => (Array.isArray(laid.drafts) ? laid.drafts : []);
const placementOf = (laid, id) => draftsOf(laid).find((draft) => draft.id === id);
const cardsOf = (laid, optionId) => laid.elements
  .filter((element) => element.customData?.role === 'card'
    && element.customData?.sectionOptionId === optionId);

// ─── 1. One draft holds the top of its column ─────────────────

console.log('1. one draft sits at the top of its column, and the cards make room below it');

const one = layoutBoard(board(), ORIGIN, {
  drafts: [{ id: 'pbdraft-1', sectionOptionId: TODO, height: 120, createdAt: 1000 }],
});
const only = placementOf(one, 'pbdraft-1');
check('the draft is placed', Boolean(only), `got ${JSON.stringify(draftsOf(one))}`);
check('at the column card top, before any reservation',
      only?.y === bareTop(TODO), `draft y=${only?.y}, bare card top=${bareTop(TODO)}`);
check('in its own column', only?.x === one.columns[0].x && only?.width === one.columns[0].width,
      `x=${only?.x} width=${only?.width}`);
check('and the column names that spot, so the + has somewhere honest to drop into',
      one.columns[0].draftsTop === bareTop(TODO)
      && one.columns[0].cardsTop === one.columns[0].draftsTop + 120 + CARD_GAP,
      `draftsTop=${one.columns[0].draftsTop} cardsTop=${one.columns[0].cardsTop}`);
const firstCard = cardsOf(one, TODO)[0];
check('and the first mirrored card sits draft.height + CARD_GAP below it',
      firstCard?.y === (only?.y ?? 0) + 120 + CARD_GAP,
      `card y=${firstCard?.y}, expected ${(only?.y ?? 0) + 120 + CARD_GAP}`);
check('the other column is untouched',
      cardsOf(one, DOING)[0]?.y === bareTop(DOING),
      `${cardsOf(one, DOING)[0]?.y} vs ${bareTop(DOING)}`);
check('the draft placement is not a mirror element — the block is the reader\'s own',
      !one.elements.some((element) => element.id === 'pbdraft-1')
      && one.elements.every((element) => element.customData?.kind === MIRROR_KIND));

// ─── 2. Newest draft on top ───────────────────────────────────

console.log('\n2. three drafts stack newest-first, the way the cards do');

// Deliberately out of creation order, so slotting in scene order cannot pass.
const three = layoutBoard(board(), ORIGIN, {
  drafts: [
    { id: 'pbdraft-old', sectionOptionId: TODO, height: 100, createdAt: 1000 },
    { id: 'pbdraft-new', sectionOptionId: TODO, height: 140, createdAt: 3000 },
    { id: 'pbdraft-mid', sectionOptionId: TODO, height: 100, createdAt: 2000 },
  ],
});
const order = draftsOf(three).slice().sort((a, b) => a.y - b.y).map((draft) => draft.id).join(' | ');
check('newest has the smallest y', order === 'pbdraft-new | pbdraft-mid | pbdraft-old', order);
check('the newest one is at the top of the column',
      placementOf(three, 'pbdraft-new')?.y === bareTop(TODO),
      `${placementOf(three, 'pbdraft-new')?.y} vs ${bareTop(TODO)}`);
check('no two overlap', (() => {
  const stack = draftsOf(three).slice().sort((a, b) => a.y - b.y);
  return stack.length === 3 && stack.every((draft, index) =>
    index === 0 || draft.y >= stack[index - 1].y + stack[index - 1].height);
})(), JSON.stringify(draftsOf(three)));
check('and the cards start below all of them',
      cardsOf(three, TODO)[0]?.y >= (placementOf(three, 'pbdraft-old')?.y ?? 0) + 100,
      `card y=${cardsOf(three, TODO)[0]?.y}`);

console.log('\n2b. a draft with no createdAt keeps the order it was given, below the dated ones');
const mixed = layoutBoard(board(), ORIGIN, {
  drafts: [
    { id: 'pbdraft-legacy-a', sectionOptionId: TODO, height: 100 },
    { id: 'pbdraft-dated', sectionOptionId: TODO, height: 100, createdAt: 5000 },
    { id: 'pbdraft-legacy-b', sectionOptionId: TODO, height: 100 },
  ],
});
const mixedOrder = draftsOf(mixed).slice().sort((a, b) => a.y - b.y).map((d) => d.id).join(' | ');
check('dated first, then the undated ones in scene order',
      mixedOrder === 'pbdraft-dated | pbdraft-legacy-a | pbdraft-legacy-b', mixedOrder);

// ─── 3. Growing a draft pushes the column down ────────────────

console.log('\n3. growing a draft by N moves everything below it in that column down by exactly N');

const before = layoutBoard(board(), ORIGIN, {
  drafts: [
    { id: 'pbdraft-new', sectionOptionId: TODO, height: 140, createdAt: 3000 },
    { id: 'pbdraft-old', sectionOptionId: TODO, height: 100, createdAt: 1000 },
  ],
});
const GROWTH = 37;
const after = layoutBoard(board(), ORIGIN, {
  drafts: [
    { id: 'pbdraft-new', sectionOptionId: TODO, height: 140 + GROWTH, createdAt: 3000 },
    { id: 'pbdraft-old', sectionOptionId: TODO, height: 100, createdAt: 1000 },
  ],
});
check('the draft that grew stays where it was',
      Boolean(placementOf(after, 'pbdraft-new'))
      && placementOf(after, 'pbdraft-new')?.y === placementOf(before, 'pbdraft-new')?.y,
      `${placementOf(before, 'pbdraft-new')?.y} → ${placementOf(after, 'pbdraft-new')?.y}`);
check('the draft below it moves down by exactly N',
      placementOf(after, 'pbdraft-old')?.y === (placementOf(before, 'pbdraft-old')?.y ?? NaN) + GROWTH,
      `${placementOf(before, 'pbdraft-old')?.y} → ${placementOf(after, 'pbdraft-old')?.y}`);
check('every card in that column moves down by exactly N', (() => {
  const was = cardsOf(before, TODO);
  const now = cardsOf(after, TODO);
  return was.length > 0 && was.length === now.length
    && was.every((element, index) => now[index].y === element.y + GROWTH);
})(), `${cardsOf(before, TODO).map((c) => c.y).join(',')} → ${cardsOf(after, TODO).map((c) => c.y).join(',')}`);
check('and no other column moves at all', (() => {
  const was = cardsOf(before, DOING);
  const now = cardsOf(after, DOING);
  return was.length > 0 && was.every((element, index) => now[index].y === element.y);
})(), `${cardsOf(before, DOING).map((c) => c.y).join(',')} → ${cardsOf(after, DOING).map((c) => c.y).join(',')}`);

// ─── 4. A draft whose column is gone ──────────────────────────

console.log('\n4. a draft naming a column the board no longer has is ignored, not rehomed');

let stray;
let threw = null;
try {
  stray = layoutBoard(board(), ORIGIN, {
    drafts: [
      { id: 'pbdraft-orphan', sectionOptionId: 'a-column-that-was-renamed', height: 200, createdAt: 4000 },
      { id: 'pbdraft-here', sectionOptionId: TODO, height: 120, createdAt: 3000 },
    ],
  });
} catch (error) {
  threw = error;
}
check('it does not throw', threw === null, String(threw));
check('the orphan gets no placement', stray && !placementOf(stray, 'pbdraft-orphan'),
      JSON.stringify(stray ? draftsOf(stray) : []));
check('the draft that does have a column is still placed at its top',
      stray && placementOf(stray, 'pbdraft-here')?.y === bareTop(TODO),
      `${stray && placementOf(stray, 'pbdraft-here')?.y} vs ${bareTop(TODO)}`);
check('and it reserved no space in any column', (() => {
  if (!stray) return false;
  const expected = layoutBoard(board(), ORIGIN, {
    drafts: [{ id: 'pbdraft-here', sectionOptionId: TODO, height: 120, createdAt: 3000 }],
  });
  return [TODO, DOING].every((optionId) =>
    cardsOf(stray, optionId).every((element, index) => element.y === cardsOf(expected, optionId)[index].y));
})());

// ─── 5. The bounds still cover the drafts ─────────────────────

console.log('\n5. the reported bounds still cover the tallest column, drafts included');

const tall = layoutBoard(board({ doing: [] }), ORIGIN, {
  drafts: [{ id: 'pbdraft-tall', sectionOptionId: DOING, height: 900, createdAt: 1000 }],
});
const tallDraft = placementOf(tall, 'pbdraft-tall');
check('a draft taller than every card still fits inside the bounds',
      tallDraft && tall.bounds.y + tall.bounds.height >= tallDraft.y + tallDraft.height,
      `bounds bottom=${tall.bounds.y + tall.bounds.height}, draft bottom=${(tallDraft?.y ?? 0) + (tallDraft?.height ?? 0)}`);
check('the bounds grew because of it',
      tall.bounds.height > layoutBoard(board({ doing: [] }), ORIGIN).bounds.height,
      `${tall.bounds.height} vs ${layoutBoard(board({ doing: [] }), ORIGIN).bounds.height}`);
check('every mirrored element still fits inside the bounds',
      tall.elements.every((element) =>
        element.y >= tall.bounds.y - 1
        && element.y + (element.height ?? 0) <= tall.bounds.y + tall.bounds.height + 1));

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
