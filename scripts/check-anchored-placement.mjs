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
 *
 * Tier: fast
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
/** The card the component actually renders — a wider one fits to the right less often. */
const CARD = { width: 720, height: 460 };

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

// ─── Obstacles ────────────────────────────────────────────────
//
// The viewport is not empty. Since #200 the board reads `mirror | terminals | documentation`,
// so a mirror card has the terminal region immediately to its right — the first side placement
// tries — and the terminal panel is a DOM overlay on the same layer, drawn later. Where both
// want the same pixels the terminal takes them and the card is silently covered (#241). The
// cases below are the ones the fix is for; every case above is the same call with no obstacles
// passed, which is what "a board with no terminal on screen places every card where it does
// today" means.

/** Do two rectangles share any pixel? Same test the module uses. */
const hits = (p, rect, card = CARD) =>
  p.left < rect.x + rect.width &&
  p.left + card.width > rect.x &&
  p.top < rect.y + rect.height &&
  p.top + card.height > rect.y;

/**
 * A screen wide enough for the card to change horizontal sides at all.
 *
 * In the 1200 above it cannot: the right side needs the shape to end by x=452 and the left
 * side needs it to start at x=748, so no shape has room on both. The board runs on a screen
 * around this wide, and "open on the other side" is only a question there.
 */
const WIDE = { width: 1920, height: 1000 };

console.log('\n9. room to the right, but a terminal is standing in it');
{
  const anchor = { x: 800, y: 200, width: 240, height: 120 };
  // Exactly where the card would have gone: right of the block, down the rest of the screen.
  const terminal = { x: 1040, y: 0, width: 880, height: 1000 };
  const bare = placeCard(anchor, CARD, WIDE);
  check('without it the card would land on the terminal', hits(bare, terminal),
        `right placement ${bare.left}..${bare.left + CARD.width}`);

  const p = placeCard(anchor, CARD, WIDE, { obstacles: [terminal] });
  check('placed on the other side', p.side === 'left', p.side);
  check('clear of the terminal', !hits(p, terminal),
        `card ${p.left}..${p.left + CARD.width} vs terminal ${terminal.x}..${terminal.x + terminal.width}`);
  check('fully on screen', inside(p, CARD, WIDE), `left=${p.left} top=${p.top}`);
  check('not covering the block', !overlaps(p, anchor));
  check('and not reported as clamped — it found a side', p.clamped === false);
}

console.log('\n10. the same block with the terminal panned away is unchanged');
{
  const anchor = { x: 800, y: 200, width: 240, height: 120 };
  const terminal = { x: 1800, y: 0, width: 880, height: 1000 };
  const bare = placeCard(anchor, CARD, WIDE);
  const p = placeCard(anchor, CARD, WIDE, { obstacles: [terminal] });
  check('still to the right', p.side === 'right', p.side);
  check('at exactly the position it had before', p.left === bare.left && p.top === bare.top,
        `${bare.left},${bare.top} -> ${p.left},${p.top}`);
}

console.log('\n11. the board\'s own arrangement: a mirror card at the left edge, the terminal filling the right');
{
  // The reported case. The mirror is the leftmost region, so there is no room for a 720px
  // card to its left on any screen — "the other side" here is below, and the terminal
  // reaches far enough left that below has to move over a little as well.
  const screen = { width: 1500, height: 900 };
  const anchor = { x: 60, y: 200, width: 300, height: 140 };
  const terminal = { x: 750, y: 0, width: 750, height: 900 };
  const bare = placeCard(anchor, CARD, screen);
  check('without it the card lands on the terminal', hits(bare, terminal),
        `${bare.side} ${bare.left}..${bare.left + CARD.width}`);

  const p = placeCard(anchor, CARD, screen, { obstacles: [terminal] });
  check('clear of the terminal', !hits(p, terminal),
        `${p.side} ${p.left}..${p.left + CARD.width} vs terminal from ${terminal.x}`);
  check('fully on screen', inside(p, CARD, screen), `left=${p.left} top=${p.top}`);
  check('not covering the block', !overlaps(p, anchor));
  check('still beside the block it belongs to', p.side === 'below', p.side);
  check('and moved no further than it had to', p.left === terminal.x - CARD.width,
        `left=${p.left}, flush with the terminal would be ${terminal.x - CARD.width}`);
}

console.log('\n12. a terminal on each side still yields something readable');
{
  const anchor = { x: 800, y: 300, width: 200, height: 100 };
  const obstacles = [
    { x: 0, y: 0, width: 700, height: 1000 },
    { x: 1100, y: 0, width: 820, height: 1000 },
  ];
  const p = placeCard(anchor, CARD, WIDE, { obstacles });
  check('a side is chosen', ['right', 'left', 'below', 'above'].includes(p.side), String(p.side));
  check('fully on screen', inside(p, CARD, WIDE), `left=${p.left} top=${p.top}`);
  // Nothing can be clear here — the card is 720 wide and the gap between the two panels is
  // 400 — so the rule is the documented fallback: today's first side with viewport room.
  const bare = placeCard(anchor, CARD, WIDE);
  check('and it is what today would have done', p.side === bare.side && p.left === bare.left && p.top === bare.top,
        `${bare.side} ${bare.left},${bare.top} -> ${p.side} ${p.left},${p.top}`);
}

console.log('\n13. an obstacle over the whole viewport falls back rather than fails');
{
  const anchor = { x: 100, y: 200, width: 240, height: 120 };
  const everything = { x: 0, y: 0, width: 1200, height: 800 };
  const bare = placeCard(anchor, CARD, VIEWPORT);
  const p = placeCard(anchor, CARD, VIEWPORT, { obstacles: [everything] });
  check('identical to the placement with no obstacles',
        p.side === bare.side && p.left === bare.left && p.top === bare.top && p.clamped === bare.clamped,
        `${bare.side} ${bare.left},${bare.top} -> ${p.side} ${p.left},${p.top}`);
  check('still fully on screen', inside(p));

  // And the clamp itself is untouched: a block filling the screen still says so.
  const filling = placeCard({ x: 0, y: 0, width: 1200, height: 800 }, CARD, VIEWPORT,
                            { obstacles: [everything] });
  check('a block filling the screen is still reported as clamped', filling.clamped === true);
  check('and the clamped card is still on screen', inside(filling),
        `left=${filling.left} top=${filling.top}`);
}

console.log('\n14. the obstacle that is the anchor does not push its own card around');
{
  // Selecting a terminal block: the panel covers the block's bounds exactly, so the block's
  // own overlay must not count against it.
  const anchor = { x: 100, y: 200, width: 240, height: 120 };
  const itself = { x: 100, y: 200, width: 240, height: 120 };
  const bare = placeCard(anchor, CARD, VIEWPORT);
  const p = placeCard(anchor, CARD, VIEWPORT, { obstacles: [itself] });
  check('unchanged', p.side === bare.side && p.left === bare.left && p.top === bare.top,
        `${bare.side} ${bare.left} -> ${p.side} ${p.left}`);
}

console.log('\n15. an empty obstacle list is the same call as no obstacle list');
{
  for (const anchor of [
    { x: 100, y: 200, width: 240, height: 120 },
    { x: 900, y: 200, width: 240, height: 120 },
    { x: 20, y: 20, width: 1160, height: 100 },
    { x: 20, y: 520, width: 1160, height: 260 },
  ]) {
    const bare = placeCard(anchor, CARD, VIEWPORT);
    const p = placeCard(anchor, CARD, VIEWPORT, { obstacles: [] });
    check(`unchanged for a block at ${anchor.x},${anchor.y}`,
          p.side === bare.side && p.left === bare.left && p.top === bare.top && p.clamped === bare.clamped,
          `${bare.side} ${bare.left},${bare.top} -> ${p.side} ${p.left},${p.top}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
