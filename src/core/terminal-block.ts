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

export function terminalCell(fontSize: number = TERMINAL_FONT_SIZE): Size {
  const scale = scaleOf(fontSize);
  return { width: TERMINAL_CELL.width * scale, height: TERMINAL_CELL.height * scale };
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
 */
export function terminalGrid(
  size: Size,
  fontSize: number = TERMINAL_FONT_SIZE
): { cols: number; rows: number } {
  const cell = terminalCell(fontSize);
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
