/**
 * Where the terminal sits on the board, and how big its grid is.
 *
 * Arithmetic only, in a module both the browser and the checks can read — the same split
 * the project mirror's layout already uses. The browser owns the drawing; nothing here
 * knows about Excalidraw beyond the shape of an element literal.
 */

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
 * Distance between the terminal's right edge and whatever it sits to the left of.
 *
 * The same 120 the mirror leaves between itself and the board. Both regions are
 * `left - gap - width`, so the canvas reads terminal | mirror | content from the left and
 * every region is placed from content rather than from a coordinate somebody once picked.
 *
 * Both are placed *once* and then kept — the mirror since #99, where re-measuring it on every
 * poll turned out to be what let it drift away from the board on its own. That is what makes
 * the order above safe to stand on: this block is anchored to the mirror's **left** edge, and
 * that is the edge #99 pins, so a column added on GitHub grows the region to the right, into
 * the gap it keeps from the board, rather than leftward onto this block.
 */
export const TERMINAL_GAP = 120;

/** How big the block is when it is first drawn. It is resizable from there. */
export const TERMINAL_SIZE = { width: 760, height: 480 };

export const TERMINAL_FONT_SIZE = 13;

/**
 * The monospace stack the emulator draws in.
 *
 * Here rather than in `TerminalPanel.tsx` because the cell height below is *this font's*
 * line box and nothing else's: a measurement taken against one stack and an emulator opened
 * with another would be two different fonts agreeing on a number. `TerminalPanel.css` repeats
 * it for the frame's own text, which a stylesheet cannot import; the two that must not drift
 * are the emulator and the measurement, and they both read this.
 */
export const TERMINAL_FONT_FAMILY =
  "'Cascadia Code', 'Cascadia Mono', Menlo, Consolas, 'Courier New', monospace";

/**
 * The line height the emulator is given, and the only part of a row this code chooses.
 *
 * xterm multiplies it by the font's **measured** line box, not by the font size — see
 * `terminalCell`. Passed to `new Terminal({ lineHeight })` from here so the multiplier the
 * grid is derived from is the multiplier the emulator was actually given.
 */
export const TERMINAL_LINE_HEIGHT = 1.35;

/**
 * The font's own line box, per font pixel, for a cell nobody has measured.
 *
 * A fallback rather than a fact: it is what the grid falls back to off the browser — in
 * `check-terminal-font.mjs`, and in a browser too old to answer `fontBoundingBoxAscent`.
 * Rounded **up** from what this machine's stack reports (1.12–1.17em across the range), so
 * an unmeasured row is never shorter than a real one: too tall costs the reader a row at the
 * bottom of the block, too short costs them rows they cannot reach at all.
 */
export const TERMINAL_LINE_BOX = 1.2;

/**
 * One character cell, in scene units at 100% zoom.
 *
 * The **width** is measured and linear: this machine's stack reports 0.5859px of advance per
 * font pixel at every size in the range, and 7.6 at 13 is a shade under it, so a block sized
 * to 80 columns holds 80 columns with a pixel or two to spare.
 *
 * The **height** is the fallback described above, and unlike the width it is not what a row
 * really is — see `terminalCell` for the one that is.
 */
export const TERMINAL_CELL = {
  width: 7.6,
  height: TERMINAL_FONT_SIZE * TERMINAL_LINE_BOX * TERMINAL_LINE_HEIGHT,
};

/**
 * Room the frame takes: the header strip, the tab strip, the input row and the padding.
 *
 * The tab strip is the 22 that was added for #94, and it is added rather than absorbed: the
 * grid is what the *shell* is told, so a strip that took its rows out of the screen without
 * this would have every full-screen program repainting two lines past the bottom of the
 * block.
 */
export const TERMINAL_CHROME = { width: 20, height: 84 };

/**
 * How far the reader may move the text, with `+` and `-` on the block's own header.
 *
 * The bottom is where a monospace glyph stops being a letter; the top is chosen so the
 * floors in `terminalGrid()` are never what stops it — at 24 the default block is still
 * fifty columns wide, so the `+` runs out because the *block* did, which is a thing the
 * reader can see and drag.
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
 * so it is the font by definition; the frame is the header, the prompt strip and the
 * padding, and every one of those is sized in `em` in `TerminalPanel.css`, so it grows with
 * the text it holds. A frame that stayed 62 while the text doubled would hand the emulator
 * three rows the block has no room to draw.
 *
 * Neither clamps to `TERMINAL_FONT_RANGE`. These answer about the font they were given —
 * holding 30 down to 24 here would report a grid nobody asked for and be impossible to see
 * from the caller. Bounding the reader's choice is `clampTerminalFont`, once, where the
 * choice is made.
 */
const scaleOf = (fontSize: number): number => {
  const size = Number(fontSize);
  return Number.isFinite(size) && size > 0 ? size / TERMINAL_FONT_SIZE : 1;
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
 * `undefined` is the offline caller and the browser that cannot answer, and falls back to
 * `TERMINAL_LINE_BOX`.
 */
export function terminalCell(
  fontSize: number = TERMINAL_FONT_SIZE,
  lineBox?: number | null
): Size {
  const scale = scaleOf(fontSize);
  const measured = Number(lineBox);
  return {
    width: TERMINAL_CELL.width * scale,
    height: Number.isFinite(measured) && measured > 0
      // xterm rounds the line box up to whole device pixels before it multiplies, and floors
      // the product. Both are reproduced rather than approximated: a cell half a pixel out
      // is a row over the edge on a tall enough block.
      ? Math.max(1, Math.floor(Math.ceil(measured) * TERMINAL_LINE_HEIGHT))
      : TERMINAL_CELL.height * scale,
  };
}

export function terminalChrome(fontSize: number = TERMINAL_FONT_SIZE): Size {
  const scale = scaleOf(fontSize);
  return { width: TERMINAL_CHROME.width * scale, height: TERMINAL_CHROME.height * scale };
}

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

/** The bounds Excalidraw's `getCommonBounds` returns, named. */
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Where the block goes for a board with this much on it.
 *
 * "The far left" is a rule, not a pixel column: the caller measures the region the block
 * has to clear, and the block lands one gap to the left of it, level with its top.
 *
 * Which region that is depends on whether the board has a mirror. **With one, it is the
 * mirror** — the leftmost thing on the canvas, and the only region that repaints, so it can
 * afford something in the way of where it grows. **With none** — a project that names no
 * `githubProject`, so the mirror stays dormant — the slot the mirror would have had is free
 * and the block takes it, one gap left of the content.
 *
 * The side matters because of *when* the block is anchored. Unlike the mirror it is placed
 * once and then left alone, since the reader is expected to move and resize it; a shape that
 * never moves aside cannot sit on the edge the board grows into. The documentation is the
 * only thing here that grows and it grows down and right, so the left is the edge nothing
 * runs into. This was the other way round until #96, and anything authored past the right
 * edge as it stood when the session opened ran straight into the block.
 *
 * An empty board with no mirror has no edge to anchor to at all, so the block starts one gap
 * right of the origin. That is the only case where a constant is honest.
 */
export function terminalOrigin(
  bounds: Bounds | null | undefined,
  mirror?: Bounds | null | undefined,
  size: Size = TERMINAL_SIZE
): Point {
  const usable = (region: Bounds | null | undefined): region is Bounds =>
    Boolean(region) && Number.isFinite(region!.minX) && Number.isFinite(region!.minY);

  const clear = usable(mirror) ? mirror : (usable(bounds) ? bounds : null);
  if (!clear) return { x: TERMINAL_GAP, y: 0 };
  return { x: clear.minX - TERMINAL_GAP - size.width, y: clear.minY };
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
 * `lineBox` is the third input and the one that is not arithmetic: the font's own line box
 * at that size, as the browser measured it. See `terminalCell` for why a row cannot be
 * derived without it.
 */
export function terminalGrid(
  size: Size,
  fontSize: number = TERMINAL_FONT_SIZE,
  lineBox?: number | null
): { cols: number; rows: number } {
  const cell = terminalCell(fontSize, lineBox);
  const chrome = terminalChrome(fontSize);
  const usableWidth = Math.max(0, (size?.width ?? 0) - chrome.width);
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
    // Dark, so the block reads as a terminal at any zoom — including one too far out for
    // the overlay's text to be legible, which is when the shape is all there is to read.
    backgroundColor: '#1e1e2e',
    strokeColor: '#4c4f69',
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 0,
    roundness: { type: 3 },
    locked: false,
    customData: { kind: TERMINAL_KIND, ...extra },
  };
}
