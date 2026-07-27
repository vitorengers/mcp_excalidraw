/**
 * What a mirrored project board is, with nothing that can only run on a server.
 *
 * Split out from `project-board.ts` because the browser needs these shapes to lay the
 * mirror out, and that module spawns `gh` — importing it from the frontend would drag
 * `child_process` into a Vite bundle. The reader re-exports everything here, so a caller
 * on the server side never has to know the split exists.
 */

export interface BoardCard {
  /** The `ProjectV2Item` node id — what a move is addressed to, not the issue number. */
  itemId: string;
  contentType: string;
  number: number | null;
  title: string;
  url: string | null;
  state: string | null;
  createdAt: string | null;
  repository: string | null;
  /**
   * Whether this card may be dragged between columns. Only issues from the project's own
   * repository, to start with: a pull request's status is usually driven by its own
   * lifecycle, and an item from elsewhere is not this board's to rearrange.
   */
  draggable: boolean;
}

export interface BoardSection {
  /** The single-select option id, or `NO_STATUS_OPTION_ID` for the untriaged section. */
  optionId: string;
  name: string;
  cards: BoardCard[];
  /** Cards the cap left out, so the canvas can say so instead of quietly truncating. */
  hidden: number;
}

export interface ProjectBoard {
  projectId: string;
  projectTitle: string;
  projectUrl: string;
  fieldId: string;
  fieldName: string;
  sections: BoardSection[];
  /** True when the project holds more items than one page returns. */
  morePages: boolean;
}

/** The section for items the project holds but never gave a status. */
export const NO_STATUS_OPTION_ID = '';
export const NO_STATUS_NAME = 'No Status';

/**
 * The section observations are written in, which is the canvas's own.
 *
 * It used to be an ordinary `Status` option — whichever one the project declared first —
 * and that was the whole of its representation: the `+` was drawn on `index === 0` and
 * stamped that option's id onto every block it dropped. Nothing ever put a *project item*
 * in it, by design, so GitHub was being asked to keep an empty option alive for the sole
 * purpose of lending its id to blocks that live here. Delete the option and the `+` moves
 * onto the next column along, where observations and real issues share a column again, and
 * every block already stamped with the old id names a column the board no longer has.
 *
 * So it has an id of its own. Reserved the way `NO_STATUS_OPTION_ID` is, and deliberately
 * shaped so it cannot be mistaken for an option: GitHub writes those as hex, and the `:`
 * here is refused by the `NODE_ID` pattern every write to the project is validated against.
 * A card dropped into this column therefore cannot be written back even by a caller that
 * tried — which is the honest answer, because there is no option to write.
 */
export const NOTES_OPTION_ID = 'canvas:notes';

/**
 * What that column is called.
 *
 * The one column name in this repository that is a constant, and it has to be: every other
 * name is GitHub's to choose because every other column is GitHub's. This one is drawn
 * here, so its name comes from here or from nowhere. `My Notes` is what the board already
 * called it when it was an option, so nothing on screen changes.
 */
export const NOTES_NAME = 'My Notes';
