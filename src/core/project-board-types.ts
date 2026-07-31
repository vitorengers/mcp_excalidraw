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
  /**
   * What this workspace calls the column an issue waits in before anything starts on it.
   *
   * Carried on the board rather than resolved wherever it is wanted, because it is the
   * workspace's answer and the browser has no workspace: the reader writes it here, the
   * layout marks the cards that are in it, and the panel gates **Recreate with observations**
   * on that mark. Absent for a board built by `toBoard` alone, which knows no workspace and
   * deliberately names no column.
   */
  todoColumn?: string | null;
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

export interface ProjectRef {
  ownerType: 'user' | 'organization';
  login: string;
  number: number;
}

/**
 * A project URL, as GitHub's address bar actually writes it.
 *
 * `/users/<login>/projects/<n>` and `/orgs/<org>/projects/<n>` are the project; everything
 * after the number is the *view* of it somebody happened to have open. Opening a project puts
 * `/views/1` there, opening a card's side panel adds `?pane=issue&itemId=…`, and neither says
 * anything about which project it is — so both are recognised and dropped rather than refused,
 * because the URL a reader copies has to be a URL this board takes.
 *
 * Recognised, not tolerated: the query and the fragment are matched against the characters
 * GitHub puts in them — no whitespace and no quote of either kind — so `?pane=issue itemId=1`
 * is still refused. Nothing past the number is ever *used* — see `parseProjectUrl` for why the
 * parts that are used are matched at all — but a pattern that ended in `.*` would be one
 * nobody could check by reading it.
 */
const PROJECT_URL =
  /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/projects\/(\d{1,10})(?:\/views\/\d{1,10})?\/?(?:\?[\w%.~!$&()*+,;:@/=|-]*)?(?:#[\w%.~!$&()*+,;:@/=|?-]*)?$/;

/**
 * Owner and number from a project URL, or null for anything that is not one.
 *
 * The login is matched rather than escaped: it is interpolated into a command line that a
 * WSL workspace runs through `bash -lc`, and a pattern that only admits what GitHub
 * actually allows in a login is a guard you can read, where escaping is one you have to
 * trust. Anything else is refused outright.
 *
 * It lives here, beside the shapes, rather than in `project-board.ts` because the write path
 * needs it too — `validateWorkspaceConfigPatch` refuses a `githubProject` this returns null
 * for — and that module spawns `gh`. The reader re-exports it, so nothing on the server side
 * has to know where it moved to.
 */
export function parseProjectUrl(url: string | null | undefined): ProjectRef | null {
  if (typeof url !== 'string') return null;
  const match = PROJECT_URL.exec(url.trim());
  if (!match) return null;
  return {
    ownerType: match[1] === 'orgs' ? 'organization' : 'user',
    login: match[2] as string,
    number: Number(match[3]),
  };
}

/**
 * True for a link to a **classic** repository project, `/<owner>/<repo>/projects[/<n>]`.
 *
 * Only ever asked about a URL `parseProjectUrl` has already refused, and only so a refusal
 * can name what is wrong: a classic project is a real project somebody is looking at, and
 * "that is not a project URL" about it would send the reader hunting for a typo that is not
 * there. The two owner forms are excluded so `/users/x/projects/5` — which is a Projects v2
 * URL that failed for some other reason — is never described as a classic one.
 */
export function isClassicProjectUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  return /^https:\/\/github\.com\/(?!users\/|orgs\/)[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/projects(\/\d{1,10})?\/?$/
    .test(url.trim());
}
