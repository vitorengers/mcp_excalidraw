/**
 * Where the terminal sits on the board, and how big its grid is.
 *
 * Arithmetic only, in a module both the browser and the checks can read — the same split
 * the project mirror's layout already uses. The browser owns the drawing; nothing here
 * knows about Excalidraw beyond the shape of an element literal.
 *
 * The colours the shape is drawn in are not here. They belong to the same palette the overlay
 * and the emulator read, which is `terminal-palette.ts`; this module imports two of them and
 * decides none.
 */

import { TERMINAL_INK, TERMINAL_PAPER } from './terminal-palette.js';

/**
 * The mark that makes a shape the terminal's, and keeps it out of the two doors that save
 * a board: the browser strips it before `POST /api/elements/sync`, and
 * `scripts/export-board.mjs` strips it again before writing `docs/board.excalidraw`. The
 * mirror's `project-board` kind is load bearing in exactly the same way and for the same
 * reason: a derived shape that gets saved becomes a stale copy of something that already
 * has an authority.
 */
export const TERMINAL_KIND = 'terminal';

/**
 * A block's id, which is no longer a name.
 *
 * It used to be the constant `terminal-block`, and it could be: there was one terminal per
 * board, so the shape could have a name rather than an id nobody chose. A board that can
 * hold several — and can split one into two by dragging a tab out — cannot, because two
 * shapes with one id is a scene Excalidraw cannot draw.
 *
 * Generated rather than derived from the session it starts with: a session moves between
 * blocks, and an id that meant "the block for s1" would be a lie the first time s1 was
 * detached and a *new* block wanted the same name.
 */
export function terminalElementId(): string {
  return `terminal-block-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Which sessions a block is showing, and which of them is on top.
 *
 * Kept on the shape rather than in the browser's own state because the shape *is* the
 * arrangement: which block a tab is in is where it was dragged to, and that is geometry
 * Excalidraw already owns. It rides in `customData` beside `kind`, so both doors that save a
 * board strip it along with everything else about the block — a tab list in the committed
 * board file would name sessions that stopped existing when the server did.
 */
export interface TerminalBlockData {
  kind: string;
  sessions: string[];
  /** The tab on top. Always one of `sessions`, or the empty string for a block with none. */
  active: string;
}

/** What a block says about itself, with anything malformed read as "nothing". */
export function terminalBlockData(customData: unknown): TerminalBlockData {
  const raw = (customData ?? {}) as Record<string, unknown>;
  const sessions = Array.isArray(raw.sessions)
    ? raw.sessions.filter((id): id is string => typeof id === 'string')
    : [];
  const active = typeof raw.active === 'string' && sessions.includes(raw.active)
    ? raw.active
    : (sessions[0] ?? '');
  return { kind: TERMINAL_KIND, sessions, active };
}

/**
 * Distance between the terminal region's right edge and the documentation's left edge.
 *
 * The same 120 the mirror leaves between itself and whatever it stands beside. The canvas
 * reads **mirror | terminals | documentation** from the left, and this is the second of the
 * two gaps that says so: the block is `documentation.minX - gap - width`, and the mirror is
 * `terminals.minX - MIRROR_GAP - width` one region further out.
 *
 * That order is #200, and it is the reversal of #96 — which had put the block on the far
 * left, past the mirror, because the block is placed once and never re-anchored and the
 * documentation grows down and right. The observation answers that argument rather than
 * ignoring it: the documentation is now something the board **moves aside**
 * (`documentationClearance`), so the edge the region grows into is no longer an edge the
 * block can be run into. The two halves are load bearing on each other — the reorder is not
 * safe without the push, which is why they landed together.
 *
 * The first block is still placed *once* and then left alone. What changed is which side the
 * region grows on: a detach now goes **right**, into the documentation, and the documentation
 * steps out of the way by exactly the room the region took.
 */
export const TERMINAL_GAP = 120;

/**
 * How big a fresh block is, said in the only unit a terminal has: **its own grid**.
 *
 * The observation on #199 asked for a default of 125 × 30, and what was there to change was a
 * pair of scene units — 1140 × 720 since #144, before that 760 × 480. A scene-unit constant
 * cannot pin a grid, and this file already knew why: half of a cell is a *browser
 * measurement*, not a number here (`terminalCell`), and since #115 the face is a web font, so
 * it is not even fixed for the life of a page. 1140 × 720 read as 147 columns against the
 * fallback cell and 156 against Comic Shanns, and the comment that used to stand here claimed
 * "around 150 × 33" for both. The rows were five out and nothing could notice: an arithmetic
 * check that divides by the same assumed cell the code does agrees with it.
 *
 * So the default is stated as the grid and the size is derived from it at placement time, by
 * `terminalSizeFor` against the cell the browser measured. Two font stacks then get two
 * different rectangles and the *same* screen, which is the half of this that a re-picked
 * constant could not buy.
 *
 * Only a *fresh* block reads this. A detach copies the block the tab came out of and a
 * restore reuses the geometry the reader had, so nothing already on a board moves — which is
 * the other half of the same observation, stated so this change is not scoped as if it could
 * break it.
 */
export const TERMINAL_GRID = { cols: 125, rows: 30 };

/**
 * The size the reader's text is drawn at until they touch `+` or `-`.
 *
 * 18 rather than the 13 it was, which is the second half of #199's answer: the grid above is
 * 125 × 30 *at this size*, and the two numbers were given together. It is a preference about
 * eyes rather than a measurement, so it moves on its own; what it must not do is drag the
 * measured constants below with it, which is what `TERMINAL_METRICS_FONT_SIZE` is for.
 */
export const TERMINAL_FONT_SIZE = 18;

/**
 * The font size the fallback constants in this file were measured at, which is not the size
 * the reader gets.
 *
 * They were one number until #199, and that was honest only while the default never moved:
 * `TERMINAL_CHROME.height` is 64 because a real render at **13** came back 57.7, and
 * `TERMINAL_CELL.width` is 7.6 because the fallback stack advances 0.5859 per font pixel at
 * **13**. `scaleOf` divides by this to carry them to any other size, so re-pointing it at a
 * new default would have re-read every one of those measurements as though it had been taken
 * at 18 — a frame reported 27% smaller than the one on screen, which is #104's defect exactly:
 * too little chrome hands the shell rows the block clips rather than scrolls.
 *
 * So the reader's default moved and this stood still. It changes only when somebody measures
 * a render again, and then the numbers beside it change with it.
 */
export const TERMINAL_METRICS_FONT_SIZE = 13;

/**
 * The face the board itself is drawn in, as far as a terminal can have it.
 *
 * The blocks are lettered in Excalifont, and #115 asked for the terminal to be lettered the
 * same way. It cannot be, literally: xterm draws column N at N × the cell width, and
 * Excalifont is proportional, so the emulator would stop being one. What it can have is the
 * **monospaced member of the same family** — Excalidraw 0.18's font picker offers exactly
 * Excalifont (hand-drawn), Nunito (normal) and Comic Shanns (code), and Comic Shanns is
 * metrically monospaced: every glyph measures 0.55 × the font size, at every size.
 *
 * Nothing is shipped or preloaded for it. Excalidraw registers all of its faces on
 * `document.fonts` whether or not the scene uses them — `Fonts.loadFontFaces` walks
 * `_Fonts.registered` and adds every non-local one — so the family resolves from the
 * stylesheet in the same document as the overlay. What it does *not* do is load them, which
 * is what `frontend/src/terminal-metrics.ts` is for.
 */
export const TERMINAL_FONT_FACE = 'Comic Shanns';

/**
 * What is drawn if the face above never arrives.
 *
 * The stack the block used to be drawn in, kept whole rather than replaced. A web font that
 * fails is not a hypothetical here: the face is registered by a dependency and loaded on
 * demand, so anything between the block appearing and the load finishing renders in this.
 */
export const TERMINAL_FALLBACK_FONT_FAMILY =
  "'Cascadia Code', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace";

/**
 * The monospace stack the emulator draws in.
 *
 * Here rather than in `TerminalPanel.tsx` because the cell below is *this font's* and nothing
 * else's: a measurement taken against one stack and an emulator opened with another would be
 * two different fonts agreeing on a number. `TerminalPanel.css` repeats it for the frame's
 * own text, which a stylesheet cannot import; the two that must not drift are the emulator
 * and the measurement, and they both read this.
 */
export const TERMINAL_FONT_FAMILY =
  `'${TERMINAL_FONT_FACE}', ${TERMINAL_FALLBACK_FONT_FAMILY}`;

/**
 * The line height the emulator is given, and the only part of a row this code chooses.
 *
 * xterm multiplies it by the font's **measured** line box, not by the font size — see
 * `terminalCell`. Passed to `new Terminal({ lineHeight })` from here so the multiplier the
 * grid is derived from is the multiplier the emulator was actually given.
 *
 * It was `1.35` while the block drew in the Cascadia stack, whose line box is a little over
 * `1em`; a row came out around `1.55 ×` the font, which is comfortable. Comic Shanns has a
 * much taller box — `1.72 ×` the font size, measured across the whole range — so the same
 * multiplier would have made a row `2.3 ×` the font and cost the default block seven of its
 * twenty rows to leading nobody asked for. The face brings its own space, so this stops
 * adding any: `1` is also the smallest value xterm will take, which is the one place the
 * arithmetic here and the emulator's own validation meet.
 */
export const TERMINAL_LINE_HEIGHT = 1;

/**
 * The font's own line box, per font pixel, for a cell nobody has measured.
 *
 * A fallback rather than a fact: it is what the grid falls back to off the browser — in
 * `check-terminal-font.mjs`, and in a browser too old to answer `fontBoundingBoxAscent`.
 * Rounded **up** from the tallest face `TERMINAL_FONT_FAMILY` can resolve to, so an
 * unmeasured row is never shorter than a real one: too tall costs the reader a row at the
 * bottom of the block, too short costs them rows they cannot reach at all.
 *
 * That is Comic Shanns, at `1.72–1.75em` across the range — the fallback stack behind it is
 * around `1.15em`, so this is deliberately generous to the one that is not the primary face.
 */
export const TERMINAL_LINE_BOX = 1.75;

/**
 * One character cell, in scene units at 100% zoom.
 *
 * Both halves are fallbacks now, and both are deliberately the **widest and tallest** answer
 * the font stack can give rather than the likeliest one. The primary face measures 0.55 of
 * advance per font pixel and the stack behind it 0.5859, so `7.6` at 13 describes the
 * fallback: a caller with nothing measured then reports slightly *fewer* columns than the
 * block can draw, which costs a column, where the other way round costs the reader the right
 * hand edge of every line — `TerminalPanel.css` clips what the frame cannot hold rather than
 * scrolling it. Same argument as `TERMINAL_LINE_BOX`, same direction.
 *
 * Neither is what a cell really is — see `terminalCell` for the ones that are.
 */
export const TERMINAL_CELL = {
  width: 7.6,
  height: TERMINAL_METRICS_FONT_SIZE * TERMINAL_LINE_BOX * TERMINAL_LINE_HEIGHT,
};

/**
 * Room the frame takes: the header strip, the tab strip and the padding.
 *
 * The tab strip is added rather than absorbed — that is what #94 added it for. The grid is
 * what the *shell* is told, so a strip that took its rows out of the screen without this
 * would have every full-screen program repainting two lines past the bottom of the block.
 *
 * A constant standing for a frame that is sized entirely in `em`, so it is a **measurement**
 * rather than a decision, and #144 moved the frame in both directions at once: the tab strip
 * became half again as tall, and the status bar along the bottom went. That is the coupling
 * #104 is a monument to — a chrome smaller than the real frame hands the shell rows the
 * block clips rather than scrolls, and neither `tsc` nor `vite build` can see it.
 *
 * So this was re-measured off a real render at zoom 1 and **13px** text rather than
 * re-derived on paper: `.terminal-card__body` came back 662.3px tall inside a 720 block, so
 * the frame is 57.7, and the 64 here is that rounded up. 13 was the default then and is
 * `TERMINAL_METRICS_FONT_SIZE` now — the render this was read off did not move when #199
 * moved the reader's size. **Up**, deliberately and in the
 * direction #104 is safe in: too much chrome costs the reader a row at the bottom of the
 * block, too little costs them rows they cannot reach at all. `check-terminal-rows-browser`
 * is what settles it, at 8, 13 and 24, because it divides by a cell read back off the render
 * rather than by the one this file assumed.
 */
export const TERMINAL_CHROME = { width: 20, height: 64 };

/**
 * The strip along the right of the screen the scrollback bar is drawn in.
 *
 * A term of the grid rather than a length in the stylesheet, and #197 is the whole reason it
 * had to become one. The block scrolled from the day it had an emulator — the wheel moves the
 * scrollback — but there was nothing to *see*: no thumb, so a reader could not tell a block had
 * a transcript behind it, could not tell where in it they were, and could not drag to a point.
 * The bar was left out deliberately, and the note that left it out named exactly this: a strip
 * of the block's width that `terminalGrid()` was never told about is the last column drawn
 * under the bar, because `TerminalPanel.css` clips what the frame cannot hold rather than
 * scrolling it. So the strip is named here, subtracted below, and drawn at this width by
 * `TerminalPanel.css` — which reads it as `--terminal-scrollbar`, written onto the card by
 * `TerminalPanel.tsx`, because a stylesheet cannot import TypeScript.
 *
 * **Drawn to this number rather than to the platform's**, which is why 12 is a decision and not
 * a measurement. A native bar is 15–17px on Windows and a zero-width overlay on macOS — xterm's
 * own `Viewport` measures it and falls back to `|| 15` for exactly that reason — and a strip
 * whose width came from the reader's operating system would be a grid that differed per machine
 * for a board two people are looking at. 12 is a thumb wide enough to aim at and about a column
 * and a half of the default block.
 *
 * In `em` in effect, like the frame: it is scaled by the font size the same way
 * `terminalChrome` is, so the bar grows with the text it sits beside and the arithmetic and the
 * stylesheet stay one number at every size.
 *
 * The direction of error is `TERMINAL_CELL`'s and `TERMINAL_LINE_BOX`'s: over-reserving costs a
 * column, under-reserving costs the right-hand edge of every line. The floor in `terminalGrid()`
 * already errs that way, so the strip is reserved at exactly what it is drawn at.
 */
export const TERMINAL_SCROLLBAR = 12;

/**
 * How far the reader may move the text, with `+` and `-` on the block's own header.
 *
 * The bottom is where a monospace glyph stops being a letter; the top is chosen so the
 * floors in `terminalGrid()` are never what stops it — a block placed at the default still
 * holds ninety columns when the text is stepped all the way to 24, so the `+` runs out
 * because the *block* did, which is a thing the reader can see and drag.
 */
export const TERMINAL_FONT_RANGE = { min: 8, max: 24, step: 1 };

/**
 * A font size that came from somewhere untrusted — `localStorage`, a stale key — made into
 * one of the sizes the buttons can reach. Anything that is not a number at all is the
 * default rather than an end of the range: a corrupt key is not a preference.
 */
export function clampTerminalFont(value: unknown): number {
  // A stored preference arrives as a string, and an absent one as `null`. Only the first is
  // worth parsing: `Number(null)` is 0, which would clamp to the smallest size the buttons
  // reach and read as "the reader once chose 8" on a board where nobody chose anything.
  const size = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN);
  if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE;
  const { min, max, step } = TERMINAL_FONT_RANGE;
  const onGrid = min + Math.round((size - min) / step) * step;
  return Math.min(max, Math.max(min, onGrid));
}

/**
 * The cell and the frame at a given font size.
 *
 * Both are proportions of the text rather than constants beside it. The cell is the glyph,
 * so it is the font by definition; the frame is the header, the tab strip and the padding,
 * and every one of those is sized in `em` in `TerminalPanel.css`, so it grows with the text
 * it holds. A frame that stayed 64 while the text doubled would hand the emulator three rows
 * the block has no room to draw.
 *
 * Neither clamps to `TERMINAL_FONT_RANGE`. These answer about the font they were given —
 * holding 30 down to 24 here would report a grid nobody asked for and be impossible to see
 * from the caller. Bounding the reader's choice is `clampTerminalFont`, once, where the
 * choice is made.
 */
const scaleOf = (fontSize: number): number => {
  const size = Number(fontSize);
  // Against the size the constants were *measured* at, never against the size the reader is
  // given. The two were the same number until #199 moved the default to 18. See
  // `TERMINAL_METRICS_FONT_SIZE`.
  return Number.isFinite(size) && size > 0 ? size / TERMINAL_METRICS_FONT_SIZE : 1;
};

/**
 * A row is the font's own line box, not the font size.
 *
 * This is the correction #104 is for. `TERMINAL_LINE_HEIGHT` is what the emulator is given,
 * and it reads as "a row is 1.35 × the font" — but xterm never applies it to the font size.
 * It measures the font first, as `fontBoundingBoxAscent + fontBoundingBoxDescent` for that
 * size, and multiplies *that*: `floor(charHeight × lineHeight)`, in
 * `DomRenderer._updateDimensions`. For the stack above the line box is a little over `1em`,
 * so a real row came out nearer `1.55 ×` the font than the `1.35` the cell assumed, and the
 * block handed the shell two or three rows past the bottom of a frame that clips rather than
 * scrolls.
 *
 * So the line box is **passed in**, measured off the font the browser resolved, and the
 * arithmetic here is xterm's own. It is not a second constant, because it cannot be one: the
 * metrics come back as whole pixels, so the ratio is a staircase — 1.40 at 10px, 1.60 at
 * 20px, 1.54 at 24px on the machine this was written on — and every member of the stack has
 * a line box of its own. A machine that resolves Consolas where this one resolves Cascadia
 * Code gets its own answer rather than this one's.
 *
 * `advance` is the same story for the **width**, and #115 is why it stopped being a constant:
 * a cell width measured against one typeface says nothing about another, and this block
 * changed typeface. xterm does no arithmetic on it at all — `device.cell.width` is the
 * measured advance and `css.cell.width` divides it back out — so unlike the row this is the
 * number itself rather than a formula around it.
 *
 * `undefined` for either is the offline caller and the browser that cannot answer, and falls
 * back to `TERMINAL_CELL`.
 */
export function terminalCell(
  fontSize: number = TERMINAL_FONT_SIZE,
  lineBox?: number | null,
  advance?: number | null
): Size {
  const scale = scaleOf(fontSize);
  const measuredBox = Number(lineBox);
  const measuredAdvance = Number(advance);
  return {
    width: Number.isFinite(measuredAdvance) && measuredAdvance > 0
      ? measuredAdvance
      : TERMINAL_CELL.width * scale,
    height: Number.isFinite(measuredBox) && measuredBox > 0
      // xterm rounds the line box up to whole device pixels before it multiplies, and floors
      // the product. Both are reproduced rather than approximated: a cell half a pixel out
      // is a row over the edge on a tall enough block.
      ? Math.max(1, Math.floor(Math.ceil(measuredBox) * TERMINAL_LINE_HEIGHT))
      : TERMINAL_CELL.height * scale,
  };
}

export function terminalChrome(fontSize: number = TERMINAL_FONT_SIZE): Size {
  const scale = scaleOf(fontSize);
  return { width: TERMINAL_CHROME.width * scale, height: TERMINAL_CHROME.height * scale };
}

/**
 * The scrollback bar's strip at a given font size, in the same units the caller asked in.
 *
 * Scaled like the frame, and for the frame's reason: everything on this card is `em`, so a bar
 * that stood still while the text doubled would be a hairline beside a 24px line at one end of
 * the range and half a column wide at the other. Two callers, and they must not drift — the
 * grid subtracts it in **scene** units at the reader's font size, and `TerminalPanel.tsx`
 * writes it as `--terminal-scrollbar` in **screen** pixels at the size the board's zoom has
 * multiplied. Both are this function; the scale is linear, so they are the same strip.
 */
export function terminalScrollbar(fontSize: number = TERMINAL_FONT_SIZE): number {
  return TERMINAL_SCROLLBAR * scaleOf(fontSize);
}

/**
 * How big a block has to be to stand for this grid — `terminalGrid` read backwards.
 *
 * The one thing #199 needed that this file could not do. Every term is the same term the grid
 * is derived from and in the same direction: a column is the measured advance, a row the
 * measured line box, and the frame and the scrollbar strip are room the emulator does not get,
 * so they are added back rather than divided out.
 *
 * Rounded **up**, to whole scene units, and that is the answer to "exact or at least". A block
 * exactly `cols × advance` wide is one floating-point error from reporting `cols - 1`, and a
 * cell is ten units, so a unit of slack cannot buy an extra column — it can only stop one being
 * lost. It is the direction every other rounding in this file already errs in.
 *
 * `lineBox` and `advance` are the browser's measurements, exactly as `terminalCell` takes them;
 * a caller with neither gets the fallback cell and a rectangle that is right for the fallback
 * stack. That caller is `TERMINAL_SIZE` below.
 */
export function terminalSizeFor(
  grid: { cols: number; rows: number } = TERMINAL_GRID,
  fontSize: number = TERMINAL_FONT_SIZE,
  lineBox?: number | null,
  advance?: number | null
): Size {
  const cell = terminalCell(fontSize, lineBox, advance);
  const chrome = terminalChrome(fontSize);
  const cols = Math.max(1, Math.floor(Number(grid?.cols) || 0));
  const rows = Math.max(1, Math.floor(Number(grid?.rows) || 0));
  return {
    width: Math.ceil(cols * cell.width + chrome.width + terminalScrollbar(fontSize)),
    height: Math.ceil(rows * cell.height + chrome.height),
  };
}

/**
 * The rectangle `TERMINAL_GRID` comes out as when nobody has measured anything.
 *
 * Derived rather than written down, so there is one default and not two that drift: this is
 * `terminalSizeFor()` against the fallback cell, which is what the grid falls back to off the
 * browser — in the checks that import this module, and in a browser too old to answer
 * `fontBoundingBoxAscent`. The fallback stack advances wider than Comic Shanns does, so it is
 * a wider rectangle than the one a real page places, and both stand for 125 × 30.
 *
 * Still the default of `terminalOrigin` and `terminalBlockElement`, because a caller with
 * nothing measured has to be given something. The frontend is not that caller: it measures,
 * and passes the answer to both.
 */
export const TERMINAL_SIZE: Size = terminalSizeFor();

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

/** The bounds Excalidraw's `getCommonBounds` returns, named. */
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Where the block goes for a board with this much on it.
 *
 * One rule, not a pixel column and no longer a choice between two regions: the block lands
 * one gap to the **left of the documentation**, level with its top. `bounds` is that
 * documentation — everything the board authored, which is everything on the canvas that is
 * not the mirror and not another block.
 *
 * The mirror used to be what the block cleared, and taking it out of this is the whole of
 * #200's arithmetic. Since #96 the block sat one gap left of the *mirror*, so the canvas read
 * `terminal | mirror | documentation` and the mirror was the middle region. The observation
 * swaps the two, which re-points one dependency: the block takes the slot the mirror held,
 * measured from the content exactly as a board with no `githubProject` already measured it,
 * and the mirror is placed from **this region** one step further out
 * (`resolveMirrorOrigin`). A board with no mirror is therefore no longer a second case with
 * a rule of its own — it is the same call with one region fewer on the canvas.
 *
 * The block is still placed once and then left alone; the reader is expected to move and
 * resize it. What makes it safe to stand where the documentation grows is that the
 * documentation now moves: `documentationClearance` steps it right by however much the
 * region takes, and back again when the region gives it up.
 *
 * An empty board has no edge to anchor to at all, so the block starts one gap right of the
 * origin. That is the only case where a constant is honest, and it leaves the mirror — which
 * is placed from this block — the whole of the canvas to the left of it.
 */
export function terminalOrigin(
  bounds: Bounds | null | undefined,
  size: Size = TERMINAL_SIZE
): Point {
  const usable = Boolean(bounds)
    && Number.isFinite(bounds!.minX) && Number.isFinite(bounds!.minY);
  if (!usable) return { x: TERMINAL_GAP, y: 0 };
  return { x: bounds!.minX - TERMINAL_GAP - size.width, y: bounds!.minY };
}

/**
 * How far right the documentation has to stand to leave the terminal region its room.
 *
 * The other half of #200, and the half with no precedent here: nothing in this project had
 * ever moved authored content before. It is answered as **a displacement rather than a
 * position** — the caller says where the documentation would sit if no block were open
 * (`natural`), and this says how far from there it has to be. Two consequences, both of them
 * the point:
 *
 *   - **The round trip is exact.** A merge asks the same question with a smaller region and
 *     gets a smaller number; the documentation is put at `natural + answer`, never nudged by
 *     a delta. Nothing accumulates, so opening and closing shells all day cannot walk the
 *     board right by the rounding. The second observation on #200 asked for exactly that:
 *     the push is keyed to detach and **merge**, not to closing a shell.
 *   - **It is measured against the region, not against one block.** A detach steps each new
 *     block one block-width and 40 further right, and the reader may split more than two, so
 *     "enough room" is recomputed against the region's current extent every time rather than
 *     against whatever block happened to be added.
 *
 * **Signed, since #494**, and that reverses what stood here. It used to be clamped at zero,
 * so a region already clear of the documentation asked for nothing — the reasoning being that
 * this is not a rule that pulls a board's content leftward onto a terminal. What that
 * produced is a `TERMINAL_GAP` which is a floor and not a distance: a block placed against a
 * board whose content has since moved, or one the reader dragged left, leaves a gap of
 * whatever the arithmetic happens to give, and no number of blocks opened changes it until
 * the region has grown far enough right to cross `natural` again. The canvas reads
 * `mirror | terminals | documentation` and the first of those two gaps is exactly
 * `MIRROR_GAP` by construction; the observation is that the second one should be the same
 * distance and was several times wider.
 *
 * So it answers where the documentation has to stand for the gap to *be* `TERMINAL_GAP`,
 * which on a region standing well left of the content is a negative displacement. The caller
 * decides whether it may act on one — `commitTerminalLayout` still refuses to move anything
 * on a pass that is not the tool's own decision about the geometry, which is what keeps the
 * board from chasing a block the reader is dragging.
 *
 * The x axis only, per the observation. Each region is placed level with the top of what it
 * measures, so there is no case here where two of them share a column and miss each other
 * vertically.
 */
export function documentationClearance(
  region: Bounds | null | undefined,
  natural: number
): number {
  if (!region || !Number.isFinite(region.maxX) || !Number.isFinite(natural)) return 0;
  return region.maxX + TERMINAL_GAP - natural;
}

/**
 * How many columns and rows a block of this size stands for.
 *
 * From the block's **scene** size rather than from the pixels it currently covers: the
 * overlay scales with the zoom, so measuring the screen would make every pinch a resize.
 * What the reader resized is the shape, and that is what this answers about.
 *
 * The font size is the other input, and it has to be one: xterm sizes its canvas as
 * `cols` × `rows` × the font, so a `+` that only made the text bigger would leave the grid
 * derived from the old cell and the emulator drawing past the frame — which
 * `TerminalPanel.css` clips rather than scrolls. A larger font in the same block is
 * therefore fewer columns and fewer rows, reported through the same route a corner drag
 * uses. It is defaulted, so a caller that has no opinion still gets the block's own.
 *
 * `lineBox` and `advance` are the inputs that are not arithmetic: the font's own line box and
 * its advance width at that size, as the browser measured them. See `terminalCell` for why
 * neither half of a cell can be derived without being measured.
 *
 * The width has a third term since #197, and it is the one the scrollbar was blocked on: the
 * strip the bar is drawn in is room the emulator does not have, exactly as the chrome is. It is
 * subtracted whether or not there is a scrollback to show, because a strip that appeared with
 * the first screenful would re-grid the block — and therefore repaint every full-screen program
 * in it — the moment its shell printed enough to scroll. See `TERMINAL_SCROLLBAR`.
 */
export function terminalGrid(
  size: Size,
  fontSize: number = TERMINAL_FONT_SIZE,
  lineBox?: number | null,
  advance?: number | null
): { cols: number; rows: number } {
  const cell = terminalCell(fontSize, lineBox, advance);
  const chrome = terminalChrome(fontSize);
  const usableWidth = Math.max(0, (size?.width ?? 0) - chrome.width - terminalScrollbar(fontSize));
  const usableHeight = Math.max(0, (size?.height ?? 0) - chrome.height);
  return {
    cols: Math.max(20, Math.floor(usableWidth / cell.width)),
    rows: Math.max(4, Math.floor(usableHeight / cell.height)),
  };
}

/**
 * The shape the overlay renders over.
 *
 * A plain rectangle, because everything that makes it a terminal is the overlay and the
 * mark in `customData`. Being a real scene element is what gives it Excalidraw's own
 * dragging, resizing and selection for free — the alternative was writing a grip and a
 * drag handle to move a box the canvas already knows how to move.
 *
 * Not locked, unlike the mirror's section headers: moving and resizing it *is* the
 * interface here.
 */
export function terminalBlockElement(
  origin: Point,
  size: Size = TERMINAL_SIZE,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: terminalElementId(),
    type: 'rectangle',
    x: origin.x,
    y: origin.y,
    width: size.width,
    height: size.height,
    // Paper, and the surface the overlay paints is whatever this one *renders as*, so the
    // two read as one object in either theme. One literal rather than two, because this is
    // scene data on a canvas Excalidraw darkens with a filter: a fill that followed the
    // reader's theme would make every toggle a change to the board, and would be the one
    // block here that opted out of the filter every other block is drawn through. The dark
    // palette's surface is defined as the colour these come out — see `terminal-palette.ts`.
    //
    // This used to be dark for the zoom argument — the shape is all there is to read once the
    // overlay's text is too small — and that argument did not go away, it moved: see `band`
    // in `terminal-palette.ts` for what carries it now.
    backgroundColor: TERMINAL_PAPER,
    strokeColor: TERMINAL_INK,
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 0,
    roundness: { type: 3 },
    locked: false,
    customData: { kind: TERMINAL_KIND, ...extra },
  };
}
