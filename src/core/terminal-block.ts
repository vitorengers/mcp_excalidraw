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
 * Distance between the board's own right edge and the terminal's left edge.
 *
 * The same 120 the mirror leaves on the left. The symmetry is the point: the mirror is
 * `minX - gap - width` and this is `maxX + gap`, so both regions follow content that grew
 * instead of sitting at a coordinate somebody once picked.
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

/**
 * Room the frame takes: the header strip, the tab strip, the input row and the padding.
 *
 * The tab strip is the 22 that was added for #94, and it is added rather than absorbed: the
 * grid is what the *shell* is told, so a strip that took its rows out of the screen without
 * this would have every full-screen program repainting two lines past the bottom of the
 * block.
 */
export const TERMINAL_CHROME = { width: 20, height: 84 };

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }

/** The bounds Excalidraw's `getCommonBounds` returns, named. */
export interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Where the block goes for a board with this much on it.
 *
 * "The right side" is a rule, not a pixel column: the caller measures whatever the board
 * has authored — leaving out the mirror and the terminal itself, which are derived — and
 * the block lands one gap beyond its right edge, level with its top.
 *
 * An empty board has no right edge to anchor to, so the block starts one gap right of the
 * origin. That is the only case where a constant is honest.
 */
export function terminalOrigin(bounds: Bounds | null | undefined): Point {
  if (!bounds || !Number.isFinite(bounds.maxX) || !Number.isFinite(bounds.minY)) {
    return { x: TERMINAL_GAP, y: 0 };
  }
  return { x: bounds.maxX + TERMINAL_GAP, y: bounds.minY };
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
