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

/** One terminal per board, so the shape can have a name rather than an id nobody chose. */
export const TERMINAL_ELEMENT_ID = 'terminal-block';

/**
 * Distance between the terminal's right edge and whatever it sits to the left of.
 *
 * The same 120 the mirror leaves between itself and the board. Both regions are
 * `left - gap - width`, so the canvas reads terminal | mirror | content from the left and
 * every region follows content that grew instead of sitting at a coordinate somebody
 * once picked.
 */
export const TERMINAL_GAP = 120;

/** How big the block is when it is first drawn. It is resizable from there. */
export const TERMINAL_SIZE = { width: 760, height: 480 };

/**
 * One character cell, in scene units at 100% zoom.
 *
 * Measured from the monospace stack the overlay renders with at
 * `TERMINAL_FONT_SIZE`: a little under 0.6em wide, and a line box of 1.35em. Close enough
 * that a block sized to 80 columns holds 80 columns; there is no PTY behind this, so the
 * grid is what the block reports rather than something a program is told to obey.
 */
export const TERMINAL_FONT_SIZE = 13;
export const TERMINAL_CELL = { width: 7.6, height: 17.5 };

/** Room the frame takes: the header strip, the input row and the body's padding. */
export const TERMINAL_CHROME = { width: 20, height: 62 };

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
 */
export function terminalGrid(size: Size): { cols: number; rows: number } {
  const usableWidth = Math.max(0, (size?.width ?? 0) - TERMINAL_CHROME.width);
  const usableHeight = Math.max(0, (size?.height ?? 0) - TERMINAL_CHROME.height);
  return {
    cols: Math.max(20, Math.floor(usableWidth / TERMINAL_CELL.width)),
    rows: Math.max(4, Math.floor(usableHeight / TERMINAL_CELL.height)),
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
    id: TERMINAL_ELEMENT_ID,
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
