#!/usr/bin/env node
/**
 * Checks that the terminal's font size is an input to the grid, not a display tweak.
 *
 * The block reports `cols` × `rows` to the shell and xterm draws exactly that many cells,
 * sized by the font. So the two cannot be set independently: a `+` that only assigned
 * `terminal.options.fontSize` would leave the grid derived from the old cell, and the
 * emulator would draw wider and taller than the frame that holds it. `TerminalPanel.css`
 * says what happens then — *"anything the frame cannot hold is clipped rather than
 * scrolled"* — so the reader would get bigger text and silently fewer columns, with no
 * scrollbar to reach the rest.
 *
 * The arithmetic that stops that is here: one font size feeds the cell, the frame and the
 * grid, and a larger font in the same block is therefore fewer columns and fewer rows.
 * `check-terminal-font-browser.mjs` is the other half — that a real xterm at a real font
 * really does draw the rightmost column the header claims.
 *
 * Offline and self-contained; nothing is spawned. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal-font.mjs
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

const modulePath = join(repoRoot, 'dist', 'core', 'terminal-block.js');
if (!existsSync(modulePath)) {
  console.error('  FAIL  the terminal block module is built — dist/core/terminal-block.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const block = await import(pathToFileURL(modulePath).href);
const {
  TERMINAL_FONT_SIZE,
  TERMINAL_METRICS_FONT_SIZE,
  TERMINAL_FONT_RANGE,
  TERMINAL_GRID,
  TERMINAL_SIZE,
  TERMINAL_LINE_BOX,
  TERMINAL_LINE_HEIGHT,
  terminalCell,
  terminalChrome,
  terminalGrid,
  terminalSizeFor,
  clampTerminalFont,
} = block;

/** Missing exports are a failure, once, rather than a TypeError that hides the rest. */
const has = (name, value, kind = 'function') => {
  const ok = kind === 'function' ? typeof value === 'function' : value != null && typeof value === kind;
  if (!ok) { failures++; console.error(`  FAIL  the module exports ${name} — got ${typeof value}`); }
  return ok;
};

console.log('1. the font size is a number the reader can move, and a base that stands still');
// 18 since #199, which asked for it together with the 125 × 30 default grid. The two numbers
// below are deliberately separate: this one is a preference about eyes and moves when somebody
// asks, and the one under it is the size a render was measured at, which moves only when
// somebody measures a render.
check('the default the reader starts at is 18', TERMINAL_FONT_SIZE === 18, String(TERMINAL_FONT_SIZE));
check('the size the constants in this module were measured at is still 13',
      TERMINAL_METRICS_FONT_SIZE === 13, String(TERMINAL_METRICS_FONT_SIZE));
if (has('TERMINAL_FONT_RANGE', TERMINAL_FONT_RANGE, 'object')) {
  const { min, max, step } = TERMINAL_FONT_RANGE;
  check('the range brackets the default', min < TERMINAL_FONT_SIZE && max > TERMINAL_FONT_SIZE,
        `${min}–${max} around ${TERMINAL_FONT_SIZE}`);
  check('and moves in whole points', Number.isInteger(step) && step >= 1, String(step));
  check('the default sits on the step grid', (TERMINAL_FONT_SIZE - min) % step === 0,
        `${TERMINAL_FONT_SIZE} from ${min} by ${step}`);
}

if (has('clampTerminalFont', clampTerminalFont) && TERMINAL_FONT_RANGE) {
  const { min, max, step } = TERMINAL_FONT_RANGE;
  check('a size below the range is held at the bottom', clampTerminalFont(min - 100) === min,
        String(clampTerminalFont(min - 100)));
  check('and above it at the top', clampTerminalFont(max + 100) === max,
        String(clampTerminalFont(max + 100)));
  check('nonsense falls back to the default',
        clampTerminalFont(Number.NaN) === TERMINAL_FONT_SIZE
        && clampTerminalFont(null) === TERMINAL_FONT_SIZE
        && clampTerminalFont('big') === TERMINAL_FONT_SIZE,
        `${clampTerminalFont(Number.NaN)}, ${clampTerminalFont(null)}, ${clampTerminalFont('big')}`);
  const offGrid = clampTerminalFont(min + step / 3);
  check('a size between two steps lands on one', (offGrid - min) % step === 0, String(offGrid));
  check('a size already in range is left alone', clampTerminalFont(min + step) === min + step,
        String(clampTerminalFont(min + step)));
}

console.log('\n2. the cell and the frame are that font size, measured');
if (has('terminalCell', terminalCell)) {
  // At the size the constants were measured at rather than at the reader's default, which
  // since #199 are two different numbers: 7.6 and 64 are what a render came back at 13, and
  // `scaleOf` carries them to any other size from there.
  const cell = terminalCell(TERMINAL_METRICS_FONT_SIZE);
  // Width: a little under 0.6em, and linear — this stack advances 0.5859px per font pixel at
  // every size in the range, so 7.6 at 13 is a shade conservative and the columns fit.
  //
  // Height: the fallback, and 21.06 rather than the 17.5 this was written with. #104 is what
  // moved it. 17.5 was `1.35 × the font`, which is the `lineHeight` xterm is *given* — but
  // xterm multiplies that by the font's own measured line box rather than by the font size,
  // so a real row was nearer 1.55 × the font and the block claimed rows it had no room to
  // draw. There is no honest constant for it, so this one is only the floor-of-last-resort
  // and it is rounded up: too tall costs a row, too short costs rows nobody can reach.
  check('the cell at the measured size is the width it was measured at, and the fallback height',
        Math.abs(cell.width - 7.6) < 0.001
        && Math.abs(cell.height - TERMINAL_METRICS_FONT_SIZE * TERMINAL_LINE_BOX * TERMINAL_LINE_HEIGHT) < 0.001,
        JSON.stringify(cell));
  check('and that fallback is taller than the 1.35 × font it used to be',
        cell.height > TERMINAL_METRICS_FONT_SIZE * TERMINAL_LINE_HEIGHT,
        `${cell.height} vs ${TERMINAL_METRICS_FONT_SIZE * TERMINAL_LINE_HEIGHT}`);
  const doubled = terminalCell(TERMINAL_METRICS_FONT_SIZE * 2);
  check('twice the font is twice the cell',
        Math.abs(doubled.width - cell.width * 2) < 0.001
        && Math.abs(doubled.height - cell.height * 2) < 0.001,
        JSON.stringify(doubled));
  // The reader's default, not the measured base: a caller with no opinion is asking about the
  // size the page is really drawing at, which since #199 is the larger of the two.
  check('and no argument means the reader\'s default',
        JSON.stringify(terminalCell()) === JSON.stringify(terminalCell(TERMINAL_FONT_SIZE)),
        `${JSON.stringify(terminalCell())} vs ${JSON.stringify(terminalCell(TERMINAL_FONT_SIZE))}`);

  // The measured line box, which is what the browser passes and what a row really is. The
  // arithmetic is xterm's own — `floor(ceil(lineBox) × lineHeight)` in
  // `DomRenderer._updateDimensions` — so the block divides by the cell the emulator drew.
  const measured = terminalCell(TERMINAL_METRICS_FONT_SIZE, 15);
  check('a measured line box is xterm\'s own arithmetic, not this module\'s guess',
        measured.height === Math.floor(15 * TERMINAL_LINE_HEIGHT),
        `${measured.height} from a 15px line box`);
  check('and it leaves the width alone, which was never the problem',
        Math.abs(measured.width - cell.width) < 0.001, JSON.stringify(measured));
  check('a measurement the browser could not make falls back rather than dividing by nothing',
        terminalCell(TERMINAL_METRICS_FONT_SIZE, null).height === cell.height
        && terminalCell(TERMINAL_METRICS_FONT_SIZE, 0).height === cell.height
        && terminalCell(TERMINAL_METRICS_FONT_SIZE, Number.NaN).height === cell.height,
        `${terminalCell(TERMINAL_METRICS_FONT_SIZE, null).height}, ${terminalCell(TERMINAL_METRICS_FONT_SIZE, 0).height}`);
  // The staircase the constant could not follow: whole-pixel metrics, so the ratio is 1.5 at
  // 8px and 1.6 at 20px on one machine and something else on the next.
  check('two line boxes a pixel apart are two different cells',
        terminalCell(TERMINAL_METRICS_FONT_SIZE, 15).height < terminalCell(TERMINAL_METRICS_FONT_SIZE, 16).height,
        `${terminalCell(TERMINAL_METRICS_FONT_SIZE, 15).height} → ${terminalCell(TERMINAL_METRICS_FONT_SIZE, 16).height}`);

  // The measured advance, which is #115's half of the same argument. A cell width measured
  // against one typeface says nothing about another, and this block changed typeface — so
  // the width stopped being a constant the same way the height did. xterm does no arithmetic
  // on it at all: `device.cell.width` is the measured advance and `css.cell.width` divides
  // it straight back out, so what is passed is the number rather than an input to a formula.
  const narrow = terminalCell(TERMINAL_METRICS_FONT_SIZE, null, 7.15);
  check('a measured advance is the cell width, untouched',
        Math.abs(narrow.width - 7.15) < 0.001, JSON.stringify(narrow));
  check('and it leaves the row alone, which is the other measurement\'s business',
        narrow.height === cell.height, JSON.stringify(narrow));
  check('an advance the browser could not measure falls back to the widest the stack can be',
        terminalCell(TERMINAL_METRICS_FONT_SIZE, null, null).width === cell.width
        && terminalCell(TERMINAL_METRICS_FONT_SIZE, null, 0).width === cell.width
        && terminalCell(TERMINAL_METRICS_FONT_SIZE, null, Number.NaN).width === cell.width,
        `${terminalCell(TERMINAL_METRICS_FONT_SIZE, null, 0).width}`);
  // The fallback is deliberately the *wider* of the two faces the stack can resolve, so an
  // unmeasured block reports fewer columns than it can draw rather than more than it can.
  check('and that fallback is no narrower than the primary face really is',
        cell.width > 7.15, `${cell.width} against the 7.15 the face measures at 13`);
}
if (has('terminalChrome', terminalChrome)) {
  // 64 now: it was 62, then 84 when #94 added the tab strip, and #144 moved it twice at once
  // — the strip became half again as tall and the status bar along the bottom went, which
  // between them take less room than the bar did on its own. The number is the measurement,
  // not the point — what the two cases hold to is that it is a real one and that it scales.
  const chrome = terminalChrome(TERMINAL_METRICS_FONT_SIZE);
  check('the frame at the measured size is the measured 20 × 64',
        Math.abs(chrome.width - 20) < 0.001 && Math.abs(chrome.height - 64) < 0.001,
        JSON.stringify(chrome));
  // The header, the tab strip and the padding are all `em`, so they grow with the text they
  // hold. A frame that stood still would hand the emulator rows the block cannot show.
  const doubled = terminalChrome(TERMINAL_METRICS_FONT_SIZE * 2);
  check('and it grows with the text, because every part of it is sized in em',
        Math.abs(doubled.height - chrome.height * 2) < 0.001,
        `${chrome.height} → ${doubled.height}`);
}

console.log('\n3. a larger font in the same block is fewer columns and fewer rows');
if (has('terminalGrid', terminalGrid)) {
  const at = (fontSize) => terminalGrid(TERMINAL_SIZE, fontSize);
  const base = at(TERMINAL_FONT_SIZE);

  check('the grid with no font size is the grid at the default',
        JSON.stringify(terminalGrid(TERMINAL_SIZE)) === JSON.stringify(base),
        `${JSON.stringify(terminalGrid(TERMINAL_SIZE))} vs ${JSON.stringify(base)}`);

  const bigger = at(TERMINAL_FONT_SIZE + 4);
  check('a bigger font is fewer columns', bigger.cols < base.cols, `${base.cols} → ${bigger.cols}`);
  check('and fewer rows', bigger.rows < base.rows, `${base.rows} → ${bigger.rows}`);

  const smaller = at(TERMINAL_FONT_SIZE - 4);
  check('a smaller font is more columns', smaller.cols > base.cols, `${base.cols} → ${smaller.cols}`);
  check('and more rows', smaller.rows > base.rows, `${base.rows} → ${smaller.rows}`);

  // Not just the two ends: nothing in the range may hand back a bigger grid than the size
  // below it did, or the `+` would read as a `-` somewhere in the middle.
  if (TERMINAL_FONT_RANGE) {
    const { min, max, step } = TERMINAL_FONT_RANGE;
    let monotonic = true;
    let previous = at(min);
    const seen = [`${min}:${previous.cols}×${previous.rows}`];
    for (let size = min + step; size <= max; size += step) {
      const grid = at(size);
      seen.push(`${size}:${grid.cols}×${grid.rows}`);
      if (grid.cols > previous.cols || grid.rows > previous.rows) monotonic = false;
      previous = grid;
    }
    check('and the grid never grows on the way up the range', monotonic, seen.join(' '));

    const top = at(max);
    const bottom = at(min);
    check('the two ends of the range are really different grids',
          top.cols < bottom.cols && top.rows < bottom.rows,
          `${bottom.cols}×${bottom.rows} → ${top.cols}×${top.rows}`);
    // The floors exist so a block dragged to nothing still reports something a shell can
    // repaint into. If the largest font hits them, the range is what is broken, not them.
    check('the largest font is stopped by the block, not by the floors',
          top.cols > 20 && top.rows > 4, `${top.cols}×${top.rows} at ${max}px`);

    // The grid the shell is told has to fit in the frame at that font, or the emulator
    // draws past the block and the overshoot is clipped rather than scrolled.
    if (typeof terminalCell === 'function' && typeof terminalChrome === 'function') {
      const overflowing = [];
      for (let size = min; size <= max; size += step) {
        const grid = at(size);
        const cell = terminalCell(size);
        const chrome = terminalChrome(size);
        const wide = grid.cols * cell.width + chrome.width;
        const tall = grid.rows * cell.height + chrome.height;
        if (wide > TERMINAL_SIZE.width + 0.001 || tall > TERMINAL_SIZE.height + 0.001) {
          overflowing.push(`${size}px: ${wide.toFixed(1)}×${tall.toFixed(1)} in ${TERMINAL_SIZE.width}×${TERMINAL_SIZE.height}`);
        }
      }
      check('every size in the range asks for a screen the block can hold',
            overflowing.length === 0, overflowing.join('; '));
    }
  }

  // Halving the columns would be the answer if only the cell had moved. The frame moved
  // too, and it is subtracted before the division, so the grid is strictly smaller than
  // that — which is what tells the two apart from arithmetic alone.
  const doubled = at(TERMINAL_FONT_SIZE * 2);
  check('the frame is taken out at the new font as well, not at the old one',
        doubled.cols < Math.floor(base.cols / 2) && doubled.rows < Math.floor(base.rows / 2),
        `${base.cols}×${base.rows} at ${TERMINAL_FONT_SIZE} → ${doubled.cols}×${doubled.rows} at ${TERMINAL_FONT_SIZE * 2}`);

  // And the line box reaches the grid, which is the whole of #104: a taller row measured off
  // the real font is fewer rows told to the shell, and the columns are untouched.
  const tall = terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, 15);
  const short = terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, 11);
  check('a measured line box moves the rows', tall.rows < short.rows,
        `${short.rows} at an 11px line box → ${tall.rows} at 15px`);
  check('and only the rows', tall.cols === short.cols && tall.cols === base.cols,
        `${base.cols}, ${short.cols}, ${tall.cols}`);
  check('the grid with no measurement is the grid at the fallback cell',
        JSON.stringify(terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, null)) === JSON.stringify(base),
        JSON.stringify(terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, null)));

  // And the advance reaches the grid, which is #115's half: a narrower glyph measured off
  // the face that really loaded is more columns told to the shell, and the rows are untouched.
  const narrow = terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, null, 7.15);
  const wide = terminalGrid(TERMINAL_SIZE, TERMINAL_FONT_SIZE, null, 9);
  check('a measured advance moves the columns', narrow.cols > wide.cols,
        `${wide.cols} at a 9px glyph → ${narrow.cols} at 7.15px`);
  check('and only the columns', narrow.rows === wide.rows && narrow.rows === base.rows,
        `${base.rows}, ${wide.rows}, ${narrow.rows}`);

  // A block dragged to nothing is still a grid a shell can repaint into, at any font.
  const tiny = terminalGrid({ width: 0, height: 0 }, TERMINAL_FONT_RANGE?.max ?? 24);
  check('an empty block still reports the floor rather than zero',
        tiny.cols >= 20 && tiny.rows >= 4, JSON.stringify(tiny));
}

console.log('\n4. the default is a grid, and the size a fresh block gets is derived from it');
if (has('TERMINAL_GRID', TERMINAL_GRID, 'object') && has('terminalSizeFor', terminalSizeFor)) {
  check('the default grid is the 125 × 30 the observation asked for',
        TERMINAL_GRID.cols === 125 && TERMINAL_GRID.rows === 30, JSON.stringify(TERMINAL_GRID));
  check('and the unmeasured default size is what that grid comes to, not a second number',
        JSON.stringify(TERMINAL_SIZE) === JSON.stringify(terminalSizeFor()),
        `${JSON.stringify(TERMINAL_SIZE)} vs ${JSON.stringify(terminalSizeFor())}`);

  // The round trip, which is the whole claim: a size derived from a grid divides back into
  // that grid. Swept across the font range **and** across cells, because the two cells this
  // stack can resolve are five per cent apart and a rectangle right for one is seven columns
  // out for the other — which is the defect #199 was opened about, and what an ordinary
  // "the constant is 1140" case cannot see.
  const cells = [
    ['unmeasured', null, null],
    ['Comic Shanns', 1.72, 0.55],
    ['the fallback stack', 1.15, 0.5859],
    ['a face nothing here has met', 2.4, 0.75],
  ];
  const wrong = [];
  const { min, max, step } = TERMINAL_FONT_RANGE ?? { min: 8, max: 24, step: 1 };
  for (const [name, box, advance] of cells) {
    for (let size = min; size <= max; size += step) {
      const lineBox = box === null ? null : box * size;
      const glyph = advance === null ? null : advance * size;
      const derived = terminalSizeFor(TERMINAL_GRID, size, lineBox, glyph);
      const grid = terminalGrid(derived, size, lineBox, glyph);
      if (grid.cols !== TERMINAL_GRID.cols || grid.rows !== TERMINAL_GRID.rows) {
        wrong.push(`${name} at ${size}px: ${derived.width}×${derived.height} reads ${grid.cols}×${grid.rows}`);
      }
    }
  }
  check('every cell and every size in the range derives a block that reads back as the grid',
        wrong.length === 0, wrong.slice(0, 4).join('; '));

  // Rounded up rather than to the nearest, which is #199's first open question answered: a
  // block a fraction short of `cols × advance` reports one column fewer, and a whole scene
  // unit of slack cannot buy an extra one — a cell is ten of them.
  const exact = terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_SIZE, 31, 9.9);
  check('the derived size is whole scene units',
        Number.isInteger(exact.width) && Number.isInteger(exact.height), JSON.stringify(exact));
  check('and it is never smaller than the grid needs',
        exact.width >= TERMINAL_GRID.cols * 9.9 + terminalChrome(TERMINAL_FONT_SIZE).width
        && exact.height >= TERMINAL_GRID.rows * 31 + terminalChrome(TERMINAL_FONT_SIZE).height,
        JSON.stringify(exact));

  // Bigger text is a bigger block for the same screen — the other reading of "125 × 30 at 18"
  // would have been a rectangle fixed at 18 and a grid that shrank as the reader stepped up.
  const small = terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_RANGE?.min ?? 8);
  const large = terminalSizeFor(TERMINAL_GRID, TERMINAL_FONT_RANGE?.max ?? 24);
  check('the same grid at a bigger font is a bigger block',
        large.width > small.width && large.height > small.height,
        `${small.width}×${small.height} → ${large.width}×${large.height}`);

  // A caller that asks for nonsense gets a block rather than a zero-width shape nobody can
  // grab: the grid is what the shell is told, and no shell is told about no columns.
  const floored = terminalSizeFor({ cols: 0, rows: -4 });
  check('a grid of nothing still derives a block with something in it',
        floored.width > 0 && floored.height > 0, JSON.stringify(floored));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
