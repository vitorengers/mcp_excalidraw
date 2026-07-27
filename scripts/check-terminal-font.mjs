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
  TERMINAL_FONT_RANGE,
  TERMINAL_SIZE,
  terminalCell,
  terminalChrome,
  terminalGrid,
  clampTerminalFont,
} = block;

/** Missing exports are a failure, once, rather than a TypeError that hides the rest. */
const has = (name, value, kind = 'function') => {
  const ok = kind === 'function' ? typeof value === 'function' : value != null && typeof value === kind;
  if (!ok) { failures++; console.error(`  FAIL  the module exports ${name} — got ${typeof value}`); }
  return ok;
};

console.log('1. the font size is a number the reader can move, with a default that has not changed');
check('the default is still 13', TERMINAL_FONT_SIZE === 13, String(TERMINAL_FONT_SIZE));
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
  const cell = terminalCell(TERMINAL_FONT_SIZE);
  // The numbers the block was drawn against: a little under 0.6em wide, a 1.35em line box.
  check('the cell at the default is the one the block was measured with',
        Math.abs(cell.width - 7.6) < 0.001 && Math.abs(cell.height - 17.5) < 0.001,
        JSON.stringify(cell));
  const doubled = terminalCell(TERMINAL_FONT_SIZE * 2);
  check('twice the font is twice the cell',
        Math.abs(doubled.width - cell.width * 2) < 0.001
        && Math.abs(doubled.height - cell.height * 2) < 0.001,
        JSON.stringify(doubled));
  check('and no argument means the default', JSON.stringify(terminalCell()) === JSON.stringify(cell),
        JSON.stringify(terminalCell()));
}
if (has('terminalChrome', terminalChrome)) {
  const chrome = terminalChrome(TERMINAL_FONT_SIZE);
  check('the frame at the default is the measured 20 × 62',
        Math.abs(chrome.width - 20) < 0.001 && Math.abs(chrome.height - 62) < 0.001,
        JSON.stringify(chrome));
  // The header, the prompt strip and the padding are all `em`, so they grow with the text
  // they hold. A frame that stayed 62 would hand the emulator rows the block cannot show.
  const doubled = terminalChrome(TERMINAL_FONT_SIZE * 2);
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

  // A block dragged to nothing is still a grid a shell can repaint into, at any font.
  const tiny = terminalGrid({ width: 0, height: 0 }, TERMINAL_FONT_RANGE?.max ?? 24);
  check('an empty block still reports the floor rather than zero',
        tiny.cols >= 20 && tiny.rows >= 4, JSON.stringify(tiny));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
