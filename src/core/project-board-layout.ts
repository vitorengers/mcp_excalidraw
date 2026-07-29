/**
 * Where the project mirror's shapes go.
 *
 * Kept out of the component that renders them, for the same reason `anchored-placement.ts`
 * is: this is arithmetic with edge cases — a column with nothing in it, a title too long
 * for its card, a draft block holding the top of a column — and arithmetic can be checked
 * without driving a browser. The component that also did the arithmetic could not be.
 *
 * Everything here is in **scene coordinates**. Where the region sits is `resolveMirrorOrigin`'s
 * answer, measured once against the board's own content and then kept; `mirrorWidth` is what
 * the caller hands it, being the whole width the mirror is about to draw.
 *
 * Not every column here is GitHub's. The first one is the canvas's own — where the `+`
 * drops an observation, and the only column on the mirror no option is behind. It is added
 * by `layoutMirror`; `layoutBoard` below it draws whatever it is given.
 *
 * Every shape produced carries `customData.kind = "project-board"`. That mark is what
 * keeps the mirror out of the export and out of the autosync: these elements are derived
 * from GitHub and rebuilt from it, never restored from a file.
 */
import { layoutLabel } from './text-layout.js';
import {
  BoardSection,
  ProjectBoard,
  NO_STATUS_OPTION_ID,
  NOTES_OPTION_ID,
  NOTES_NAME,
} from './project-board-types.js';
import { TERMINAL_GAP, TERMINAL_KIND } from './terminal-block.js';

// Re-exported so the canvas can name the notes column without importing two modules.
export { NOTES_OPTION_ID, NOTES_NAME } from './project-board-types.js';

/** The mark that says an element belongs to the mirror rather than to the board. */
export const MIRROR_KIND = 'project-board';

/**
 * Distance between the mirror's right edge and the board's own left edge, the first time
 * the region is placed.
 *
 * Beside the arithmetic that uses it rather than in the component, because the component is
 * no longer the only thing that has to agree about it: `check-mirror-anchor.mjs` asks what
 * the region is anchored to, and a constant it had to copy would be a second definition to
 * drift from this one.
 */
export const MIRROR_GAP = 120;

/** The document behind the region, shown when its header is selected. */
export const MIRROR_DOC_KEY = 'project-board';

export const COLUMN_WIDTH = 300;
export const COLUMN_GAP = 24;
export const PADDING = 24;
export const TITLE_HEIGHT = 48;
export const HEADER_HEIGHT = 44;
export const CARD_GAP = 12;
export const CARD_FONT_SIZE = 16;
export const CARD_MIN_HEIGHT = 52;
export const HEADER_FONT_SIZE = 18;
export const ADD_SIZE = 28;

/**
 * What the queue toggle is drawn with: a circular arrow, the thing that goes round again.
 *
 * A glyph rather than a word because it sits in a 28-pixel box beside a column header, and
 * exported here so the checks name it rather than retyping a code point that has to match.
 */
export const QUEUE_GLYPH = '↻';

/** Enough hues to tell columns apart; it wraps rather than running out. */
const COLUMN_STROKES = ['#1971c2', '#e8590c', '#2f9e44', '#6741d9', '#c2255c'];

/**
 * The card fill for each of those hues, in the same order and wrapping the same way.
 *
 * A card carried its column's identity all along — `sectionOptionId` is written onto every
 * one — and drew none of it, so a card in the first column looked exactly like a card in the
 * last. The fill comes from where a section sits, never from what it is called: a project
 * that renames a column, or adds a fourth, gets no edit in this repository.
 */
const COLUMN_FILLS = ['#e7f5ff', '#fff4e6', '#ebfbee', '#f3f0ff', '#fff0f6'];

/** The untriaged section, which has no position of its own to take a hue from. */
const NO_STATUS_STROKE = '#adb5bd';
const NO_STATUS_FILL = '#f1f3f5';

/** A card whose issue is being implemented, or has been. Anything else is unmarked. */
export type CardImplementState = 'running' | 'done' | 'failed' | 'interrupted';

export interface MirrorElement {
  id: string;
  type: 'rectangle' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  locked: boolean;
  roundness: { type: number } | null;
  link: string | null;
  customData: Record<string, unknown>;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: string;
  verticalAlign?: string;
  containerId?: string;
  boundElements?: { id: string; type: 'text' }[] | null;
}

export interface MirrorColumn {
  optionId: string;
  name: string;
  x: number;
  width: number;
  /**
   * The top of the column, above every draft — where a block just dropped belongs, since
   * drafts stack newest-first and a block just dropped is the newest there is.
   */
  draftsTop: number;
  /** Where the mirrored cards start — below whatever drafts are holding the top. */
  cardsTop: number;
}

/**
 * A block the `+` dropped, waiting for the run that turns it into a real card.
 *
 * Only what the placement needs: the block itself is the reader's own element, authored
 * and synced, and this file never draws it — it decides where it goes and how much room
 * the mirrored cards have to give up for it.
 */
export interface DraftBlock {
  id: string;
  /**
   * The column the block belongs to.
   *
   * A column this layout does not have is ignored — `layoutBoard` has nowhere to put it and
   * will not invent one. `layoutMirror` is where that stops being true: it draws a column
   * that is the canvas's own, so a homeless block has a home, and it rehomes before laying
   * anything out.
   */
  sectionOptionId: string;
  /** The block's current height. It grows as its title is typed, which is the point. */
  height: number;
  /**
   * When the block was made, so drafts stack newest-first the way cards do. A block made
   * before this was written carries none; those keep the order they were given, below the
   * dated ones, so an old scene still lays out the same way twice running.
   */
  createdAt?: number;
}

/** Where one draft block goes. The caller moves the element there; this only says where. */
export interface DraftPlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MirrorLayout {
  elements: MirrorElement[];
  columns: MirrorColumn[];
  /** Where the draft blocks go, in the space reserved for them at the top of a column. */
  drafts: DraftPlacement[];
  bounds: { x: number; y: number; width: number; height: number };
}

export interface LayoutOptions {
  /**
   * Failed moves, by item id. A failure snaps the card back to what GitHub says, and the
   * snap-back on its own is ambiguous — it looks like a drag that did not take. The
   * message on the card is what makes it an error rather than a glitch.
   */
  errors?: Record<string, string>;
  /**
   * The blocks the `+` dropped. Each one holds the top of its column and pushes the
   * mirrored cards below it down; without that the next refresh would lay a card straight
   * over a block the reader is still typing into.
   */
  drafts?: DraftBlock[];
  /**
   * What is known about implementing each issue, by issue URL.
   *
   * By URL and not by item id because that is where this state actually lives — on the
   * server, against the issue (`implement-state.ts`), which is what lets two shapes for one
   * issue agree. A column says where somebody put a card; only this says whether an agent
   * is on it. The observation that asked for this asked for exactly that distinction: a
   * card can be In Progress because a person dragged it there, and that is the normal case.
   */
  implementing?: Record<string, CardImplementState>;
  /**
   * The queue toggle: which column carries it, and whether it is on.
   *
   * Which column is the caller's answer for the reason `oldestFirstColumn` is: the column a
   * queue drains is named in the workspace's own config, and a layout that knew the name
   * "Todo" would be the constant this mirror is built to avoid. Absent means no toggle at
   * all — which is what a board with implementing disabled gets, since a button that cannot
   * do anything is worse than no button.
   *
   * The state comes from the server on every refresh and is never read back off the shape.
   * The mirror is rebuilt from GitHub on every poll, so anything written onto a mirrored
   * element is gone by the next one; this is the same reasoning that keeps implement state
   * against the issue URL rather than in `customData`.
   */
  queue?: { sectionOptionId: string; enabled: boolean };
}

/**
 * The drafts of each column, newest first.
 *
 * Newest-first by analogy with the cards (`toBoard` sorts those the same way): a block
 * just dropped is the one being worked on, and it belongs where the eye already is.
 * `sort` is stable, so undated blocks keep their given order among themselves.
 */
function draftsByColumn(drafts: DraftBlock[]): Map<string, DraftBlock[]> {
  const byColumn = new Map<string, DraftBlock[]>();
  for (const draft of drafts) {
    const column = byColumn.get(draft.sectionOptionId);
    if (column) column.push(draft);
    else byColumn.set(draft.sectionOptionId, [draft]);
  }
  for (const column of byColumn.values()) {
    column.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  return byColumn;
}

/** How wide the whole mirror is, before it is laid out. */
export function boardWidth(sectionCount: number): number {
  const columns = Math.max(1, sectionCount);
  return PADDING * 2 + columns * COLUMN_WIDTH + (columns - 1) * COLUMN_GAP;
}

/** Enough of an element to decide whether the region may be measured against it. */
export interface AnchorCandidate {
  id?: string;
  isDeleted?: boolean;
  containerId?: string | null;
  customData?: Record<string, unknown> | null;
  /**
   * Where the shape is, when the caller knows. Marks are what say a shape is derived, and
   * `mirrorAnchors` used to have nothing else to go on; since #188 it also refuses one
   * standing inside the region, which is a question only geometry answers. Optional because
   * an offline caller asking which *kinds* are anchorable has no coordinates to hand.
   */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

/** The left and top of a bounding box — the two numbers a placement needs. */
export interface AnchorBounds {
  minX: number;
  minY: number;
}

/** A whole box, for the two questions that need more than a corner. */
export interface Region extends AnchorBounds {
  maxX: number;
  maxY: number;
}

const overlaps = (element: AnchorCandidate, region: Region): boolean => {
  const { x, y, width, height } = element;
  if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return false;
  }
  return (x as number) < region.maxX && region.minX < (x as number) + (width as number)
    && (y as number) < region.maxY && region.minY < (y as number) + (height as number);
};

/** An origin, and whether it is one worth keeping. */
export interface MirrorOrigin {
  origin: { x: number; y: number };
  /**
   * Whether the caller should remember it. A measured origin is; the empty-canvas fallback
   * is not, or a mirror that rendered before the scene arrived would stay where an empty
   * board put it for the rest of the session.
   */
  settled: boolean;
}

const kindOf = (element: AnchorCandidate): unknown => (element.customData ?? {}).kind;

const isDraft = (element: AnchorCandidate): boolean =>
  (element.customData ?? {}).projectBoardDraft === true && !element.containerId;

/**
 * The elements the region is allowed to be measured against.
 *
 * Three places drop derived shapes and two of them also drop **a label bound to one** —
 * Excalidraw binds text to whatever is selected, and that text carries no `kind` of its own,
 * so on its own terms it looks authored. This is the third: the mirror's own measurement,
 * which used to exclude the terminal blocks but not a title bound to one. Bind a title to a
 * block the reader is expected to drag, drag it up and to the left, and the block was
 * ignored while its label was not.
 *
 * Left out, and why each one:
 *
 * - the mirror's own shapes, or the region would re-anchor to itself;
 * - the terminal blocks, which are placed *from* the board's bounds on the other side, so
 *   measuring against them would walk the two regions apart;
 * - the draft blocks, which live inside the mirror;
 * - anything whose container is one of those, which is the rule this adds to the terminal;
 * - anything standing **inside the region already drawn**, whatever it is marked with.
 *
 * That last one is geometry rather than a mark, and #188 is why. Every exclusion above is by
 * mark, and a draft's mark is `projectBoardDraft` — so a block written in the notes column
 * that lost the mark, or never carried one, is on those terms an ordinary authored shape
 * that happens to sit inside the mirror. Measured against it the region lands one mirror
 * width further left, on top of the terminal, and that origin is a measured one, so it is
 * remembered and stays. A shape inside the region cannot say where the region goes: it is
 * there *because* of where the region already is.
 *
 * `region` is the mirror as it is currently drawn, and there is none on the pass that draws
 * it first. Nothing is excluded then, which is right — there is no inside yet to be in.
 */
export function mirrorAnchors<T extends AnchorCandidate>(
  elements: readonly T[],
  region?: Region | null
): T[] {
  const alive = elements.filter((element) => !element.isDeleted && kindOf(element) !== MIRROR_KIND);
  const derived = new Set(alive
    .filter((element) => isDraft(element) || kindOf(element) === TERMINAL_KIND)
    .map((element) => element.id));
  return alive.filter((element) => !derived.has(element.id)
    && !(element.containerId && derived.has(element.containerId))
    && !(region && overlaps(element, region)));
}

/**
 * Where the mirror's top-left corner goes.
 *
 * **Once, and then kept.** The region used to recompute this on every twenty-second poll
 * from `minX - MIRROR_GAP - width`, storing neither number, which gave it two independent
 * ways to move on its own: a column added on GitHub made it wider and, being pinned by its
 * right edge, pushed every column that was already there one column-width further left; and
 * any element added, moved or erased anywhere on the canvas that changed the scene's
 * leftmost or topmost coordinate dragged the whole region along with it. That is the drift
 * #99 recorded, and neither half needed the mirror or the board's content to be touched.
 *
 * So the measurement happens once, the first time there is something to measure against,
 * and the answer is remembered. What is pinned from then on is the **left** edge: a mirror
 * whose width is set by GitHub cannot keep both, and the left one is where the `+` is, where
 * an observation is written, and — once #96 lands — where the terminal will sit. A column
 * appearing therefore grows the region to the right, toward the board's own content, which
 * is a collision the reader can see and connect to something rather than a drift they cannot.
 *
 * The price is the terminal's own: a board whose content is moved wholesale leaves the
 * region behind. A reload re-measures, which is what puts it back.
 *
 * A canvas with nothing to measure against still has the **terminal block**, when the board
 * has one, and that block is not an arbitrary shape: `terminalOrigin` puts it exactly
 * `TERMINAL_GAP` left of this region's left edge, so its right edge plus that gap is where
 * this region's left edge was. Reading it back is the inverse of the placement rather than a
 * second guess at it, which makes it a fixed point — the block does not move because the
 * region was placed here, because the region was already placed from the block.
 *
 * #188 is what asked for it. Before, an empty anchor set answered with
 * `{ x: -(width + MIRROR_GAP), y: 0 }`, which is an absolute coordinate that knows nothing
 * about the block, is not remembered, and is therefore re-decided every twenty seconds — and
 * `width` is GitHub's, so a column added to the project moved the region a column-width
 * further left, onto a block anchored to where it used to be. A board holding only a mirror
 * and a terminal has an empty anchor set on *every* poll, so that board got the constant every
 * time. Measured against the block instead, the answer is the same number on every pass, and
 * it is a measurement, so it settles and is never taken again.
 *
 * A board with neither content nor a block has nothing at all to anchor to, so the region
 * starts one gap left of the origin — the only case where a constant is honest, and the one
 * origin not worth keeping.
 */
export function resolveMirrorOrigin(
  remembered: { x: number; y: number } | null | undefined,
  bounds: AnchorBounds | null | undefined,
  width: number,
  terminal?: Region | null
): MirrorOrigin {
  if (remembered) return { origin: { x: remembered.x, y: remembered.y }, settled: true };
  if (bounds && Number.isFinite(bounds.minX) && Number.isFinite(bounds.minY)) {
    return { origin: { x: bounds.minX - MIRROR_GAP - width, y: bounds.minY }, settled: true };
  }
  if (terminal && Number.isFinite(terminal.maxX) && Number.isFinite(terminal.minY)) {
    return { origin: { x: terminal.maxX + TERMINAL_GAP, y: terminal.minY }, settled: true };
  }
  return { origin: { x: -(width + MIRROR_GAP), y: 0 }, settled: false };
}

function rectangle(partial: Partial<MirrorElement> & { id: string; x: number; y: number; width: number; height: number; customData: Record<string, unknown> }): MirrorElement {
  return {
    type: 'rectangle',
    strokeColor: '#868e96',
    backgroundColor: '#ffffff',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    locked: false,
    roundness: { type: 3 },
    link: null,
    boundElements: null,
    ...partial,
  } as MirrorElement;
}

/**
 * A label bound to a shape, laid out so it does not hang outside it.
 *
 * Bound rather than merely placed on top: dragging a card has to take its title with it,
 * and a container's own binding is what does that without a group to maintain.
 */
function label(
  container: MirrorElement,
  text: string,
  fontSize: number,
  color = '#1e1e1e'
): MirrorElement {
  const laid = layoutLabel(text, container.width, fontSize);
  const id = `${container.id}-label`;
  container.boundElements = [{ id, type: 'text' }];
  return {
    id,
    type: 'text',
    x: container.x + (container.width - laid.width) / 2,
    y: container.y + (container.height - laid.height) / 2,
    width: laid.width,
    height: laid.height,
    strokeColor: color,
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 1,
    strokeStyle: 'solid',
    roughness: 0,
    locked: container.locked,
    roundness: null,
    link: null,
    text: laid.text,
    fontSize,
    fontFamily: 5,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container.id,
    customData: { kind: MIRROR_KIND, role: 'label' },
  };
}

/**
 * What a section header says it holds: one number, counting everything in the column.
 *
 * Drafts, mirrored cards, and the cards the cap left out. The cap decides what is *drawn*,
 * never what is *held*, so `, N hidden` qualifies the card side — the only side a cap
 * applies to — while the total includes them all the same.
 *
 * It carried two numbers, `drafts / cards`, because two populations shared one column and
 * the header had to say which was which. They no longer share one: hand-written blocks land
 * in the notes column, which no card can be in at all, so the split is done by the columns
 * and repeating it here says nothing. The notes column is therefore always a draft count —
 * by this same sum, with two of its three terms zero, rather than by a rule of its own.
 *
 * **Not a revert to `cards.length + hidden`.** That number counted the mirrored items alone,
 * which is why a column holding three drafts and no cards read `Todo (0)` — the defect #79
 * recorded. Reverting would move that defect one column left, onto the column the drafts now
 * have to themselves. The drafts stay in the sum; only the slash goes.
 */
function headerText(section: BoardSection, drafts: number): string {
  const count = drafts + section.cards.length + section.hidden;
  const hidden = section.hidden ? `, ${section.hidden} hidden` : '';
  return `${section.name} (${count}${hidden})`;
}

function cardText(title: string, number: number | null, error: string | undefined): string {
  const heading = number ? `#${number} ${title}` : title;
  return error ? `${heading}\n! ${error}` : heading;
}

/**
 * Lay the whole mirror out from `origin` (its top-left corner).
 *
 * Columns follow the order the project declares its options in, so where a section sits
 * is GitHub's decision rather than this file's — including a "No Status" section, which
 * `toBoard` only appends when something actually lands in it.
 *
 * It draws the sections it is handed and asks nothing about where they came from. The
 * canvas calls `layoutMirror`, which hands it one the project never declared.
 */
export function layoutBoard(
  board: ProjectBoard,
  origin: { x: number; y: number },
  options: LayoutOptions = {}
): MirrorLayout {
  const errors = options.errors ?? {};
  const drafts = draftsByColumn(options.drafts ?? []);
  const implementing = options.implementing ?? {};
  const elements: MirrorElement[] = [];
  const columns: MirrorColumn[] = [];
  const placements: DraftPlacement[] = [];

  const width = boardWidth(board.sections.length);

  /**
   * A mirror that is missing cards says so on its own strip.
   *
   * `morePages` reached the browser for two issues and nothing read it, so the only sign
   * that the board had stopped showing the newest items was a line in the server log — and
   * the canvas went on looking like the whole project. It is on the title rather than on a
   * column because what is missing is not any one column's: the read ended, wherever those
   * cards were going to land. The count is what it *did* draw, so the sentence stays true
   * whichever ceiling ended it.
   *
   * **On a line of its own**, and the strip grows to hold it. Appended to the title it was
   * one 55-character line, which the estimate in `text-layout.ts` says fits a two-column
   * mirror and the browser does not: Excalidraw re-measured it wider, kept it on one line
   * because that is what it was given, and clipped both ends of it. Two short lines are
   * inside what either measurement admits — and this was only visible in a browser.
   */
  const mirrored = board.sections.reduce(
    (total, section) => total + section.cards.length + section.hidden, 0
  );
  const titleText = board.morePages
    ? `${board.projectTitle} — ${board.fieldName}\nfirst ${mirrored} items, the project has more`
    : `${board.projectTitle} — ${board.fieldName}`;
  const titleHeight = Math.max(
    TITLE_HEIGHT,
    layoutLabel(titleText, width, HEADER_FONT_SIZE).containerHeight
  );

  const headerTop = origin.y + titleHeight + COLUMN_GAP;
  const cardsTop = headerTop + HEADER_HEIGHT + CARD_GAP;

  const title = rectangle({
    id: 'pb-title',
    x: origin.x,
    y: origin.y,
    width,
    height: titleHeight,
    strokeColor: board.morePages ? '#e03131' : '#495057',
    backgroundColor: '#f1f3f5',
    locked: true,
    link: board.projectUrl || null,
    customData: {
      kind: MIRROR_KIND,
      role: 'title',
      // Selecting the strip explains the region, the way every other block on the board
      // explains itself. `check-board-docs.mjs` resolves this key to docs/project-board.md.
      docKey: MIRROR_DOC_KEY,
      ...(board.morePages ? { truncated: true } : {}),
    },
  });
  elements.push(title, label(title, titleText, HEADER_FONT_SIZE, board.morePages ? '#c92a2a' : '#343a40'));

  let bottom = cardsTop;

  /**
   * The column an issue waits in before anything starts on it, if the board named one.
   *
   * Matched the way every other column lookup in this project is — trimmed and without
   * regard to case — and never against the two columns that are not the project's: `No
   * Status` is where an item with no status lands, and the notes column is the canvas's own.
   * Neither is a column a card can be *put* in, so neither is one an issue can wait in.
   */
  const todo = (board.todoColumn ?? '').trim().toLowerCase();
  const isTodo = (section: BoardSection): boolean =>
    Boolean(todo)
    && section.optionId !== NO_STATUS_OPTION_ID
    && section.optionId !== NOTES_OPTION_ID
    && section.name.trim().toLowerCase() === todo;

  board.sections.forEach((section, index) => {
    const x = origin.x + PADDING + index * (COLUMN_WIDTH + COLUMN_GAP);
    // Read once, for the header above the column and for the slots inside it. A draft
    // naming a column the board no longer has is in neither: it is counted by no header
    // for the same reason it is placed nowhere.
    const columnDrafts = drafts.get(section.optionId) ?? [];
    const stroke = section.optionId === NO_STATUS_OPTION_ID
      ? NO_STATUS_STROKE
      : (COLUMN_STROKES[index % COLUMN_STROKES.length] as string);
    const fill = section.optionId === NO_STATUS_OPTION_ID
      ? NO_STATUS_FILL
      : (COLUMN_FILLS[index % COLUMN_FILLS.length] as string);

    const header = rectangle({
      id: `pb-h-${section.optionId || 'none'}`,
      x,
      y: headerTop,
      width: COLUMN_WIDTH,
      height: HEADER_HEIGHT,
      strokeColor: stroke,
      backgroundColor: '#f8f9fa',
      // Locked so a header cannot be dragged out of a mirror that would only put it back.
      locked: true,
      customData: { kind: MIRROR_KIND, role: 'section', sectionOptionId: section.optionId },
    });
    elements.push(header, label(header, headerText(section, columnDrafts.length), HEADER_FONT_SIZE, stroke));

    // `+` on the notes column, which is the canvas's own and the only column a block the
    // reader is still writing belongs in. It used to be drawn on `index === 0` — on
    // whichever option the project declared first — which is what made an empty `Status`
    // option on GitHub load-bearing for a population GitHub never sees.
    if (section.optionId === NOTES_OPTION_ID) {
      const add = rectangle({
        id: 'pb-add',
        x: x + COLUMN_WIDTH - ADD_SIZE - 8,
        y: headerTop + (HEADER_HEIGHT - ADD_SIZE) / 2,
        width: ADD_SIZE,
        height: ADD_SIZE,
        strokeColor: stroke,
        backgroundColor: '#ffffff',
        // Deliberately not locked: a locked shape cannot be clicked, and this one is a
        // button. A stray drag of it is corrected by the next refresh.
        locked: false,
        customData: { kind: MIRROR_KIND, role: 'add', sectionOptionId: section.optionId },
      });
      elements.push(add, label(add, '+', HEADER_FONT_SIZE, stroke));
    }

    // The queue toggle, on the column the queue drains — geometrically the `+`, and unlocked
    // for the same reason: a locked shape cannot be clicked, and this one is a button.
    //
    // Two appearances, and deliberately not two colours. Hue on this mirror already means the
    // column, and a failed move already borrows it; a third meaning would collide with both.
    // On is the column's own stroke filled in solid with a heavier outline, off is white with
    // a thin one — a difference in weight and in fill, legible in a screenshot and to anyone
    // who cannot tell the hues apart.
    if (options.queue && section.optionId === options.queue.sectionOptionId) {
      const on = options.queue.enabled;
      const toggle = rectangle({
        id: 'pb-queue',
        x: x + COLUMN_WIDTH - ADD_SIZE - 8,
        y: headerTop + (HEADER_HEIGHT - ADD_SIZE) / 2,
        width: ADD_SIZE,
        height: ADD_SIZE,
        strokeColor: stroke,
        backgroundColor: on ? stroke : '#ffffff',
        strokeWidth: on ? 2 : 1,
        locked: false,
        customData: {
          kind: MIRROR_KIND,
          role: 'queue',
          sectionOptionId: section.optionId,
          // Carried so a reader — or a check — can ask the shape what it is showing without
          // inferring it from a colour. It is drawn from this, never read back into it.
          queueEnabled: on,
        },
      });
      elements.push(toggle, label(toggle, QUEUE_GLYPH, HEADER_FONT_SIZE, on ? '#ffffff' : stroke));
    }

    // The drafts hold the top of the column and the cards start under them. A draft whose
    // column this layout does not have is left out here and gets no placement: picking one
    // of the project's own columns for it would be a worse answer than leaving it where it
    // is. `layoutMirror` sends it to the notes column before it gets this far, which is a
    // different decision — that column is not one of the project's.
    let y = cardsTop;
    for (const draft of columnDrafts) {
      placements.push({ id: draft.id, x, y, width: COLUMN_WIDTH, height: draft.height });
      y += draft.height + CARD_GAP;
    }
    columns.push({
      optionId: section.optionId,
      name: section.name,
      x,
      width: COLUMN_WIDTH,
      draftsTop: cardsTop,
      cardsTop: y,
    });

    for (const card of section.cards) {
      const error = errors[card.itemId];
      const text = cardText(card.title, card.number, error);
      const laid = layoutLabel(text, COLUMN_WIDTH, CARD_FONT_SIZE);
      const height = Math.max(CARD_MIN_HEIGHT, laid.containerHeight + 8);

      // Whether an agent is on this issue, which the column cannot say: a card is in a
      // column because somebody put it there. `failed` is left unmarked on purpose — the
      // run is over and nothing is being implemented, which is what an unmarked card
      // already means; the panel is where the failure is reported. `interrupted` is unmarked
      // for the same reason and one more: nothing is being implemented there either, and a
      // card that changed outline on its own at every restart would be the board walking
      // backwards while somebody is looking at it.
      const run = card.url ? implementing[card.url] : undefined;
      const outlined = run === 'running' || run === 'done';

      const shape = rectangle({
        id: `pb-c-${card.itemId}`,
        x,
        y,
        width: COLUMN_WIDTH,
        height,
        strokeColor: error ? '#e03131' : (card.draggable ? '#495057' : '#ced4da'),
        // The column tints the card; a card that cannot be moved keeps the grey that says
        // so, because "not this board's to rearrange" outranks which column it sits in.
        backgroundColor: card.draggable ? fill : '#f8f9fa',
        // Weight and outline rather than another colour: hue is already spoken for by the
        // column and by a failed move, and a third meaning for it would collide with both.
        // Dashed while the work is in flight, solid once it has landed — the same reading
        // an issue block's own outline has.
        strokeWidth: outlined ? 2 : 1,
        strokeStyle: run === 'running' ? 'dashed' : 'solid',
        // A card that cannot be moved is locked, so the canvas refuses the drag rather
        // than accepting one this server would have to undo.
        locked: !card.draggable,
        // Deliberately no `element.link`, though the URL is right there in `card.url`.
        // Nothing in `src/` or `frontend/` reads a card's `link`; the board opens the issue
        // from `customData.issueUrl` below, and the panel renders it as a real anchor. What
        // the second copy did buy was Excalidraw's own hyperlink UI, which keys off
        // `element.link` alone: a badge in the card's corner, and — because the popup is
        // drawn above the element's own box — a white bar over whichever cards are stacked
        // on top of this one in the column. Selecting a card should not cover its
        // neighbours to repeat something the panel already says. The title strip keeps its
        // link, at the top of this function: it is full width, so its popup lands over the
        // mirror rather than over a card, and it is the only route from here to the project.
        customData: {
          kind: MIRROR_KIND,
          role: 'card',
          sectionOptionId: section.optionId,
          itemId: card.itemId,
          issueUrl: card.url,
          draggable: card.draggable,
          // Whether the issue is still waiting rather than being worked on, which is what
          // decides whether the panel offers to research it again. Written onto the card
          // rather than derived in the browser from a header's label text: the column's name
          // is drawn into a label that wraps and carries a count, and reading a gate out of
          // that would be reading the wrong thing.
          ...(isTodo(section) ? { inTodo: true } : {}),
          ...(run ? { implementState: run } : {}),
          ...(error ? { moveError: error } : {}),
        },
      });
      elements.push(shape, label(shape, text, CARD_FONT_SIZE, error ? '#c92a2a' : '#1e1e1e'));

      y += height + CARD_GAP;
    }

    bottom = Math.max(bottom, y);
  });

  return {
    elements,
    columns,
    drafts: placements,
    bounds: { x: origin.x, y: origin.y, width, height: bottom + PADDING - origin.y },
  };
}

/**
 * The section observations are written in — the canvas's own, with no option behind it.
 *
 * Empty of cards and always will be: nothing mirrored can land in a column GitHub has no
 * name for, which is exactly what makes it safe to draw one. Its header therefore counts
 * the drafts and nothing else, which `headerText` already does for any column.
 */
export function notesSection(): BoardSection {
  return { optionId: NOTES_OPTION_ID, name: NOTES_NAME, cards: [], hidden: 0 };
}

/**
 * The columns the canvas draws: the notes column, then the project's own, in its order.
 *
 * First, and not because anything sorts it there — it is put in front, because that is
 * where the observations were already written and the `+` goes with them. The project's
 * columns keep the positions they had when an option stood in for this one, so the hues
 * they are drawn in do not shift either.
 */
export function mirrorSections(board: ProjectBoard): BoardSection[] {
  return [notesSection(), ...board.sections];
}

/** How wide the mirror is, the notes column included. The caller anchors by this. */
export function mirrorWidth(board: ProjectBoard): number {
  return boardWidth(board.sections.length + 1);
}

/**
 * Lay out the mirror as the canvas draws it: the project's columns, and the one that is not.
 *
 * `layoutBoard` renders whatever sections it is handed and knows nothing about where they
 * came from. This is the layer that decides — it is the only place that says the notes
 * column exists, so it is also where a block whose column has gone can be given one.
 *
 * **Rehoming is the reversal.** A draft naming a column the board no longer has used to be
 * left where it sat, placed by nothing and counted by nothing: an authored element quietly
 * unplaced, overlapped by the next redraw. That was the right answer while every column was
 * GitHub's — none of them was where the block *belonged*, only where it might be guessed
 * to. The notes column is where it belongs, by construction: every draft was written as an
 * observation, and observations go here.
 *
 * **So every draft goes there, and the stamp it carries decides nothing.** Rehoming keyed
 * on "the board no longer has this column" for one release, which caught the blocks the
 * deleted option left behind and missed the other half of the same population: a block
 * stamped with an option that is still perfectly real. That happened whenever the project's
 * *ordering* changed while the notes column was still an option — the `+` moved to whatever
 * was now first and the blocks already written did not, so they were drawn among the issues
 * in a column whose whole contract is that its cards are issues that exist. Project 5 had
 * three of them, in `Todo`, and no gesture could move them: `settleMirrorDrag` rewrites a
 * column for mirrored cards and nothing else.
 *
 * A draft is an observation; observations are in the notes column. That rule holds whatever
 * a stamp says, so `sectionOptionId` on a draft is now vestigial — written by the `+`, read
 * by nothing that matters, and kept only because `layoutBoard` below places by it.
 */
export function layoutMirror(
  board: ProjectBoard,
  origin: { x: number; y: number },
  options: LayoutOptions = {}
): MirrorLayout {
  const sections = mirrorSections(board);
  const drafts = (options.drafts ?? []).map((draft) => (
    draft.sectionOptionId === NOTES_OPTION_ID
      ? draft
      : { ...draft, sectionOptionId: NOTES_OPTION_ID }
  ));
  return layoutBoard({ ...board, sections }, origin, { ...options, drafts });
}

/** Which column a point falls in, or null when it falls between or beyond them. */
export function columnAt(columns: MirrorColumn[], x: number): MirrorColumn | null {
  return columns.find((column) => x >= column.x && x <= column.x + column.width) ?? null;
}
