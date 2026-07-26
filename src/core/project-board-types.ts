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
