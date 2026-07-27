/**
 * Where the project mirror's shapes go.
 *
 * Kept out of the component that renders them, for the same reason `anchored-placement.ts`
 * is: this is arithmetic with edge cases — a column with nothing in it, a title too long
 * for its card, a draft block holding the top of a column — and arithmetic can be checked
 * without driving a browser. The component that also did the arithmetic could not be.
 *
 * Everything here is in **scene coordinates**. The caller decides where the region sits;
 * `mirrorWidth` is exported so it can place the mirror by its right edge, which is what
 * anchoring it to the left of the board's own content needs.
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

// Re-exported so the canvas can name the notes column without importing two modules.
export { NOTES_OPTION_ID, NOTES_NAME } from './project-board-types.js';

/** The mark that says an element belongs to the mirror rather than to the board. */
export const MIRROR_KIND = 'project-board';

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
export type CardImplementState = 'running' | 'done' | 'failed';

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
 * in the first column and a researched issue is moved out of it, so the split is done by the
 * columns and repeating it here says nothing.
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
  const headerTop = origin.y + TITLE_HEIGHT + COLUMN_GAP;
  const cardsTop = headerTop + HEADER_HEIGHT + CARD_GAP;

  const title = rectangle({
    id: 'pb-title',
    x: origin.x,
    y: origin.y,
    width,
    height: TITLE_HEIGHT,
    strokeColor: '#495057',
    backgroundColor: '#f1f3f5',
    locked: true,
    link: board.projectUrl || null,
    customData: {
      kind: MIRROR_KIND,
      role: 'title',
      // Selecting the strip explains the region, the way every other block on the board
      // explains itself. `check-board-docs.mjs` resolves this key to docs/project-board.md.
      docKey: MIRROR_DOC_KEY,
    },
  });
  elements.push(title, label(title, `${board.projectTitle} — ${board.fieldName}`, HEADER_FONT_SIZE, '#343a40'));

  let bottom = cardsTop;

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
      // already means; the panel is where the failure is reported.
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
        link: card.url,
        customData: {
          kind: MIRROR_KIND,
          role: 'card',
          sectionOptionId: section.optionId,
          itemId: card.itemId,
          issueUrl: card.url,
          draggable: card.draggable,
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
 * observation, and observations go here. The blocks stamped with the deleted option's id
 * are precisely that population.
 */
export function layoutMirror(
  board: ProjectBoard,
  origin: { x: number; y: number },
  options: LayoutOptions = {}
): MirrorLayout {
  const sections = mirrorSections(board);
  const drawn = new Set(sections.map((section) => section.optionId));
  const drafts = (options.drafts ?? []).map((draft) => (
    drawn.has(draft.sectionOptionId)
      ? draft
      : { ...draft, sectionOptionId: NOTES_OPTION_ID }
  ));
  return layoutBoard({ ...board, sections }, origin, { ...options, drafts });
}

/** Which column a point falls in, or null when it falls between or beyond them. */
export function columnAt(columns: MirrorColumn[], x: number): MirrorColumn | null {
  return columns.find((column) => x >= column.x && x <= column.x + column.width) ?? null;
}
