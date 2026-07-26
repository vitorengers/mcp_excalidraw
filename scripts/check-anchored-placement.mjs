#!/usr/bin/env node
/**
 * Checks where the documentation card lands relative to the shape it belongs to.
 *
 * The card replaced a sidebar that CSS pinned to the window edge, which meant a selected
 * block and its documentation could sit thousands of pixels apart. Placement is the part
 * of that with edge cases — a block against the right edge, a block taller than the
 * screen, a card that fits nowhere — so it lives in a pure module and is checked here.
 *
 * Offline: no server, no browser. Run `./node_modules/.bin/tsc` first — this reads the
 * compiled module.
 *
 * Usage: node scripts/check-anchored-placement.mjs
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = join(repoRoot, 'dist', 'core', 'anchored-placement.js');

if (!existsSync(modulePath)) {
  console.error('  FAIL  the placement module exists — dist/core/anchored-placement.js not found');
  console.error('        (the card is not anchored to anything yet; run tsc if it is)');
  process.exit(1);
}

const { placeCard, cardHeightFor, DEFAULT_GAP, DEFAULT_MARGIN } = await import(pathToFileURL(modulePath).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const VIEWPORT = { width: 1200, height: 800 };
const CARD = { width: 360, height: 460 };

/** Is the card wholly inside the viewport, margin included? */
const inside = (p, card = CARD, viewport = VIEWPORT, margin = DEFAULT_MARGIN) =>
  p.left >= margin &&
  p.top >= margin &&
  p.left + card.width <= viewport.width - margin &&
  p.top + card.height <= viewport.height - margin;

/** Does the card overlap the shape it belongs to? */
const overlaps = (p, anchor, card = CARD) =>
  p.left < anchor.x + anchor.width &&
  p.left + card.width > anchor.x &&
  p.top < anchor.y + anchor.height &&
  p.top + card.height > anchor.y;

console.log('1. a block with room to its right gets the card there');
{
  const anchor = { x: 100, y: 200, width: 240, height: 120 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('placed to the right', p.side === 'right', p.side);
  check('one gap away from the block', p.left === anchor.x + anchor.width + DEFAULT_GAP,
        `left=${p.left} block right edge=${anchor.x + anchor.width}`);
  check('aligned with the top of the block', p.top === anchor.y, `top=${p.top}`);
  check('fully on screen', inside(p));
  check('not covering the block', !overlaps(p, anchor));
  check('not reported as clamped', p.clamped === false);
}

console.log('\n2. a block against the right edge gets the card on its left');
{
  const anchor = { x: 900, y: 200, width: 240, height: 120 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('placed to the left', p.side === 'left', p.side);
  check('one gap away', p.left + CARD.width + DEFAULT_GAP === anchor.x,
        `card right edge=${p.left + CARD.width} block left=${anchor.x}`);
  check('fully on screen', inside(p));
  check('not covering the block', !overlaps(p, anchor));
}

console.log('\n3. a block spanning the width falls below it');
{
  const anchor = { x: 20, y: 20, width: 1160, height: 100 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('placed below', p.side === 'below', p.side);
  check('one gap under the block', p.top === anchor.y + anchor.height + DEFAULT_GAP, `top=${p.top}`);
  check('fully on screen', inside(p));
  check('not covering the block', !overlaps(p, anchor));
}

console.log('\n4. a wide block low on the screen goes above it');
{
  const anchor = { x: 20, y: 520, width: 1160, height: 260 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('placed above', p.side === 'above', p.side);
  check('one gap over the block', p.top + CARD.height + DEFAULT_GAP === anchor.y,
        `card bottom=${p.top + CARD.height} block top=${anchor.y}`);
  check('fully on screen', inside(p));
  check('not covering the block', !overlaps(p, anchor));
}

console.log('\n5. a block low on the screen slides the card up, it does not hang off');
{
  const anchor = { x: 100, y: 700, width: 240, height: 80 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('still beside the block', p.side === 'right', p.side);
  check('slid up to stay on screen', p.top < anchor.y, `top=${p.top} block y=${anchor.y}`);
  check('fully on screen', inside(p));
  check('sliding is not reported as clamped', p.clamped === false);
}

console.log('\n6. a block filling the screen leaves nowhere, and that is said out loud');
{
  const anchor = { x: 0, y: 0, width: 1200, height: 800 };
  const p = placeCard(anchor, CARD, VIEWPORT);
  check('reported as clamped', p.clamped === true);
  check('still fully on screen', inside(p),
        `left=${p.left} top=${p.top}`);
}

console.log('\n7. a viewport shorter than the card still yields something on screen');
{
  const tiny = { width: 400, height: 300 };
  const anchor = { x: 10, y: 10, width: 80, height: 40 };
  const height = cardHeightFor(tiny, 460);
  check('the card is shortened to fit', height <= tiny.height - DEFAULT_MARGIN * 2,
        `height=${height} viewport=${tiny.height}`);
  const p = placeCard(anchor, { width: 360, height }, tiny);
  check('left edge on screen', p.left >= DEFAULT_MARGIN, `left=${p.left}`);
  check('top edge on screen', p.top >= DEFAULT_MARGIN, `top=${p.top}`);
  check('right edge on screen', p.left + 360 <= tiny.width - DEFAULT_MARGIN,
        `right=${p.left + 360}`);
}

console.log('\n8. panning the block moves the card by exactly the same amount');
{
  // The card is positioned from viewport coordinates, so a pan of N pixels has to move
  // it N pixels — that is what "the distance stays constant" means in practice.
  const before = placeCard({ x: 100, y: 200, width: 240, height: 120 }, CARD, VIEWPORT);
  const after = placeCard({ x: 160, y: 245, width: 240, height: 120 }, CARD, VIEWPORT);
  check('moved with the block horizontally', after.left - before.left === 60,
        `${before.left} -> ${after.left}`);
  check('moved with the block vertically', after.top - before.top === 45,
        `${before.top} -> ${after.top}`);
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
