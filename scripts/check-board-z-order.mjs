#!/usr/bin/env node
/**
 * Checks that the board file draws the way it reads.
 *
 * `docs/board.excalidraw` was written sorted by element id — deliberately, so an unrelated
 * edit could not reshuffle the whole file and turn a one-card change into a full-file diff
 * (`trap-export-noise.md`). The cost of that key was invisible in every check this repository
 * had, and visible the moment anyone opened the board: **five cards drew as empty boxes.**
 *
 * Excalidraw orders elements by their fractional `index`, and treats those indices as valid
 * only while they increase along the array. Hand it an array sorted by anything else and it
 * decides the indices are broken, regenerates them from the array order, and paints in *that*
 * order instead. So a card's title, whose id happened to sort before its rectangle's, was
 * painted first and then covered by the opaque rectangle it belongs to. The text is in the
 * file, `check-board-docs.mjs` finds it, and nobody can read it.
 *
 * That is the observation #151 was opened about: a screenshot of this board with a row of
 * empty boxes in it. The issue's own investigation cleared it — "all 26 rectangles at HEAD
 * carry a title and a body" — which is true of the file and false of the canvas.
 *
 * Two rules, the second being the reason for the first:
 *
 *  1. the `index` values never decrease along the array, so nothing regenerates them;
 *  2. no text is listed before a filled shape that covers it, so nothing a reader is meant to
 *     read is painted underneath something opaque.
 *
 * Offline: it reads the board file, not a running server.
 *
 * Usage: node scripts/check-board-z-order.mjs [--board docs/board.excalidraw]
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};

const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
const boardPath = resolve(repoRoot, argOf('--board') ?? config.board);
const scene = JSON.parse(readFileSync(boardPath, 'utf8'));
const elements = (scene.elements ?? []).filter((element) => !element.isDeleted);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log(`reading ${boardPath}\n`);

console.log('1. the fractional indices agree with the order they are written in');

const missing = elements.filter((element) => typeof element.index !== 'string' || !element.index);
check('every element carries an index', missing.length === 0,
      `${missing.length} without one`);

const backwards = [];
for (let at = 1; at < elements.length; at++) {
  if (String(elements[at].index) < String(elements[at - 1].index)) {
    backwards.push(`${elements[at - 1].id} (${elements[at - 1].index}) then ${elements[at].id} (${elements[at].index})`);
  }
}
check('no element is written before one with a higher index', backwards.length === 0,
      `${backwards.length} inversion(s), the first: ${backwards[0] ?? ''}\n`
      + '        Excalidraw regenerates indices it reads as broken and paints in array order '
      + 'instead');

console.log('\n2. nothing a reader is meant to read is painted under something opaque');

/** A shape with a fill hides whatever was painted before it. `transparent` does not. */
const isOpaque = (element) =>
  element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond'
    ? Boolean(element.backgroundColor) && element.backgroundColor !== 'transparent'
    : false;

const covers = (shape, text) =>
  shape.x <= text.x
  && shape.y <= text.y
  && shape.x + shape.width >= text.x + text.width
  && shape.y + shape.height >= text.y + text.height;

const buried = [];
elements.forEach((text, textAt) => {
  if (text.type !== 'text') return;
  elements.forEach((shape, shapeAt) => {
    // A label bound to its container is drawn with it, whatever the array says.
    if (!isOpaque(shape) || shapeAt <= textAt || text.containerId === shape.id) return;
    if (covers(shape, text)) {
      buried.push(`"${(text.text ?? '').split('\n')[0].slice(0, 40)}" under ${shape.id}`);
    }
  });
});
check('no text sits under a filled shape listed after it', buried.length === 0,
      `${buried.length} buried:\n        ${buried.join('\n        ')}`);

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
