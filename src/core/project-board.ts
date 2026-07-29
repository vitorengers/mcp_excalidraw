/**
 * Reading a GitHub project as a board, and writing a card's column back.
 *
 * The point of this file is that nothing in it names a column. GitHub has no board view
 * to read a grouping from on a user-owned project — `views(first:5)` returns one
 * `TABLE_LAYOUT` node with `verticalGroupByFields` empty — so the columns come from the
 * options of a single-select field, `Status` by default and overridable per project. A
 * fourth option added on GitHub is therefore a fourth section here with nothing rebuilt,
 * which is the whole reason this is a mirror rather than a drawing of one.
 *
 * Two things GitHub will not give us, and neither is a choice:
 *
 *  - **Order.** Items come back in `POSITION` order, i.e. whatever arrangement someone
 *    dragged them into. "Newest on top" is sorted here, by creation date, and will not
 *    match GitHub's own order.
 *  - **Push.** `projects_v2_item` webhooks are organisation-scoped and a user account has
 *    no hooks endpoint at all (`GET /users/<login>/hooks` is 404). GitHub to canvas can
 *    only be polled.
 */
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { runGh } from './gh.js';
import {
  BoardCard,
  BoardSection,
  ProjectBoard,
  NO_STATUS_OPTION_ID,
  NO_STATUS_NAME,
} from './project-board-types.js';

// Re-exported so nothing on the server side has to know the types live next door.
export * from './project-board-types.js';

/** The single-select field the columns come from when a project does not name one. */
export const DEFAULT_STATUS_FIELD = 'Status';

/**
 * How many cards a section shows before it starts hiding them.
 *
 * Done is the section this exists for — eleven of fourteen items were already Done when
 * this was written, and that only grows — but the cap is applied to every section on
 * purpose. A cap that knew the name "Done" would be exactly the constant this file is
 * built to avoid. What is hidden is counted and reported rather than silently dropped.
 */
export const DEFAULT_CARD_LIMIT = 12;

/** One page of items. 100 is the most GitHub will return in a single `items` connection. */
const ITEM_PAGE_SIZE = 100;

/**
 * How many pages one read will follow before it stops and says so.
 *
 * A ceiling rather than "until GitHub runs out", because this read happens on a poll: the
 * canvas re-reads every 20 seconds and the queue reads again on top of that, so an
 * unbounded loop against a project that kept growing would turn one board into an
 * indefinite number of `gh` calls per tick. Twenty pages is 2000 items — an order of
 * magnitude past the project that found this — and hitting it is reported on the canvas
 * rather than swallowed, which is the part that was missing when 100 was the ceiling.
 */
const MAX_ITEM_PAGES = 20;

/**
 * What a cursor may contain.
 *
 * GitHub's cursors are opaque base64 and this reader has to hand one back on a command
 * line that a WSL workspace runs through `bash -lc` — the same argument the login and the
 * field name already earn a pattern for. Matched rather than escaped, for the reason at
 * `parseProjectUrl`: a guard you can read beats one you have to trust. A cursor that does
 * not match stops the paging instead of being interpolated, and the board says it is short.
 */
const CURSOR = /^[A-Za-z0-9+/=_-]{1,200}$/;

export interface ProjectRef {
  ownerType: 'user' | 'organization';
  login: string;
  number: number;
}

/**
 * Owner and number from a project URL.
 *
 * The login is matched rather than escaped: it is interpolated into a command line that a
 * WSL workspace runs through `bash -lc`, and a pattern that only admits what GitHub
 * actually allows in a login is a guard you can read, where escaping is one you have to
 * trust. Anything else is refused outright.
 */
export function parseProjectUrl(url: string | null | undefined): ProjectRef | null {
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/(users|orgs)\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/projects\/(\d{1,10})\/?$/
    .exec(url.trim());
  if (!match) return null;
  return {
    ownerType: match[1] === 'orgs' ? 'organization' : 'user',
    login: match[2] as string,
    number: Number(match[3]),
  };
}

/** Field names reach a command line too, so they are held to the same standard. */
const FIELD_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;
/** GraphQL node ids and single-select option ids, as GitHub writes them. */
const NODE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * The query, on one line.
 *
 * One query, not three: the project id and the field id are needed to write a move back,
 * the options are the columns, and the items are the cards. It is asked once per page of
 * items, so a long project repeats the project id and the options — cheaper than the round
 * trips a second query would cost. Newlines are left out because
 * this whole string travels as a single command-line argument through a tokenizer and,
 * for a WSL project, a shell — and a query that cannot contain a quote or a line break
 * cannot be broken by either.
 */
export function buildProjectQuery(ownerType: 'user' | 'organization'): string {
  return [
    'query($login: String!, $number: Int!, $field: String!, $cursor: String) {',
    `owner: ${ownerType}(login: $login) {`,
    'projectV2(number: $number) {',
    'id title url',
    'field(name: $field) { ... on ProjectV2SingleSelectField { id name options { id name } } }',
    // `$cursor` is left unset on the first call and GraphQL reads an absent nullable
    // variable as null, which `after:` takes as "from the beginning" — so the first page
    // costs no extra argument and a project that fits on one page costs no extra call.
    `items(first: ${ITEM_PAGE_SIZE}, after: $cursor) {`,
    'pageInfo { hasNextPage endCursor }',
    'nodes {',
    'id',
    'fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }',
    'content { __typename',
    '... on Issue { number title url createdAt state repository { nameWithOwner } }',
    '... on PullRequest { number title url createdAt state repository { nameWithOwner } }',
    '... on DraftIssue { title createdAt }',
    '} } } } } }',
  ].join(' ');
}

export interface ToBoardOptions {
  /** Cards per section before hiding starts. 0 or less means no cap. */
  cardLimit?: number;
  /** The project's own repository, in `owner/name` form. Cards from elsewhere lock. */
  repo?: string | null;
  /**
   * The one column drawn oldest-first, by name, matched the way `findColumn` matches.
   *
   * Named by the caller rather than known here, because knowing it would be the constant
   * this file is built to avoid. What the caller passes is the workspace's Todo column, and
   * the reason is the queue: it starts the oldest issue first, so a column drawn
   * newest-first would put the card that starts *last* at the top and the one starting next
   * out of sight at the bottom — the board reading backwards from what it is about to do.
   *
   * Only that column. `newestFirst` is what every other section keeps, and flipping them all
   * would hide the newest cards on a long Done behind the card limit rather than the oldest.
   */
  oldestFirstColumn?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Newest first.
 *
 * By creation date, with the number as the tiebreaker and anything undated last. This is
 * the one place the mirror disagrees with GitHub, which returns manual `POSITION` order.
 */
function newestFirst(a: BoardCard, b: BoardCard): number {
  if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1;
  }
  if (Boolean(a.createdAt) !== Boolean(b.createdAt)) return a.createdAt ? -1 : 1;
  return (b.number ?? 0) - (a.number ?? 0);
}

/**
 * Oldest first, for the column a queue drains.
 *
 * `newestFirst` read backwards in its first and last clauses and *not* in its middle one: a
 * card with no creation date still sorts last rather than first. Undated is a draft item or
 * something GitHub would not date, and neither belongs at the head of a queue — "oldest" is
 * a claim about a date, and there is none to make it with.
 *
 * Exported because two things have to agree about it: the column the mirror draws, and the
 * order `implement-queue.ts` starts issues in. A second comparator would be a second place
 * for the two to drift apart, and the drift would read as the board lying about what is next.
 */
export function oldestFirst(a: BoardCard, b: BoardCard): number {
  if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  if (Boolean(a.createdAt) !== Boolean(b.createdAt)) return a.createdAt ? -1 : 1;
  return (a.number ?? 0) - (b.number ?? 0);
}

/**
 * Turn the GraphQL answer into sections.
 *
 * Pure, and separated from the `gh` call for exactly that reason: everything worth
 * checking here — a fourth option becoming a fourth section, an untriaged item not being
 * dropped, the sort that GitHub does not do — is a property of this function and can be
 * checked with no network and no browser.
 */
export function toBoard(raw: unknown, options: ToBoardOptions = {}): ProjectBoard {
  const project = (raw as any)?.data?.owner?.projectV2;
  if (!project) throw new Error('GitHub returned no project at that URL');

  const field = project.field;
  if (!field?.options) {
    throw new Error(
      'The project has no single-select field to take columns from. ' +
      'Name one in board.config.json as "projectField".'
    );
  }

  const cardLimit = options.cardLimit ?? DEFAULT_CARD_LIMIT;
  const repo = options.repo ?? null;
  const oldestFirstColumn = (options.oldestFirstColumn ?? '').trim().toLowerCase();

  // Every declared option becomes a section, in the order the project declares them,
  // whether or not anything is in it. An empty column is information: it is where a card
  // can be dropped.
  const sections = new Map<string, BoardSection>();
  for (const option of field.options as { id: string; name: string }[]) {
    sections.set(option.id, { optionId: option.id, name: option.name, cards: [], hidden: 0 });
  }

  const untriaged: BoardSection = {
    optionId: NO_STATUS_OPTION_ID,
    name: NO_STATUS_NAME,
    cards: [],
    hidden: 0,
  };

  for (const node of (project.items?.nodes ?? []) as any[]) {
    if (!node?.id || !node.content) continue;
    const content = node.content;
    const contentType = asString(content.__typename) ?? 'Unknown';
    const repository = asString(content.repository?.nameWithOwner);

    const card: BoardCard = {
      itemId: node.id,
      contentType,
      number: typeof content.number === 'number' ? content.number : null,
      title: asString(content.title) ?? '(untitled)',
      url: asString(content.url),
      state: asString(content.state),
      createdAt: asString(content.createdAt),
      repository,
      draggable: contentType === 'Issue' && (!repo || repository === repo),
    };

    // An item whose status was never set lands in its own section rather than being
    // dropped. Which column a newly created issue arrives in is the project's *Item added
    // to project* workflow's decision and cannot be read back through the API — so if that
    // workflow is disabled, or sets nothing, this is where those items go, visibly,
    // instead of disappearing.
    const optionId = asString(node.fieldValueByName?.optionId);
    const section = optionId ? sections.get(optionId) : undefined;
    (section ?? untriaged).cards.push(card);
  }

  if (untriaged.cards.length) sections.set(NO_STATUS_OPTION_ID, untriaged);

  const ordered = [...sections.values()];
  for (const section of ordered) {
    // Sorted before the cap is applied, so which cards the cap leaves out follows from the
    // order rather than the other way round.
    section.cards.sort(
      oldestFirstColumn && section.name.trim().toLowerCase() === oldestFirstColumn
        ? oldestFirst
        : newestFirst
    );
    if (cardLimit > 0 && section.cards.length > cardLimit) {
      section.hidden = section.cards.length - cardLimit;
      section.cards = section.cards.slice(0, cardLimit);
      logger.info(`Project board: "${section.name}" is showing ${cardLimit} of ${cardLimit + section.hidden} cards`);
    }
  }

  return {
    projectId: asString(project.id) ?? '',
    projectTitle: asString(project.title) ?? 'Project',
    projectUrl: asString(project.url) ?? '',
    fieldId: asString(field.id) ?? '',
    fieldName: asString(field.name) ?? DEFAULT_STATUS_FIELD,
    sections: ordered,
    morePages: Boolean(project.items?.pageInfo?.hasNextPage),
  };
}

/** Raised when a workspace simply has no project — the caller answers 404, not 500. */
export class NoProjectConfigured extends Error {}

function projectFieldFor(workspace: Workspace): string {
  const configured = workspace.projectField?.trim() || DEFAULT_STATUS_FIELD;
  if (!FIELD_NAME.test(configured)) {
    throw new Error(`"projectField" must look like a field name, got: ${configured}`);
  }
  return configured;
}

export interface ReadBoardOptions {
  /**
   * Overrides the workspace's own cap. `0` reads every item.
   *
   * The cap exists so a section does not draw four hundred cards; a caller that is looking
   * one card up rather than drawing anything must not inherit it, or a card hidden behind
   * the cap reads as a card that is not on the project at all.
   */
  cardLimit?: number;
}

/** Read the workspace's project and lay it out as sections. */
export async function readProjectBoard(
  workspace: Workspace,
  options: ReadBoardOptions = {}
): Promise<ProjectBoard> {
  const ref = parseProjectUrl(workspace.githubProject);
  if (!ref) {
    throw new NoProjectConfigured(
      workspace.githubProject
        ? `"githubProject" is not a GitHub project URL: ${workspace.githubProject}`
        : 'This board has no "githubProject" in its board.config.json.'
    );
  }

  const field = projectFieldFor(workspace);
  const call =
    `api graphql -f 'query=${buildProjectQuery(ref.ownerType)}' ` +
    `-f 'login=${ref.login}' -F 'number=${ref.number}' -f 'field=${field}'`;

  // Every page's items, in the order GitHub returned them. `toBoard` is handed the lot as
  // one answer and stays what it was: a pure function over a single payload, which is why
  // the sort and the cap apply to the whole project rather than to each page separately.
  const nodes: unknown[] = [];
  let parsed: unknown = null;
  let cursor: string | null = null;
  let short = false;
  let pagesRead = 0;

  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    pagesRead++;
    const stdout = await runGh(
      workspace,
      cursor === null ? call : `${call} -f 'cursor=${cursor}'`,
      { what: 'the project board read' }
    );
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`Could not read the gh response: ${(error as Error).message}`);
    }

    // No items at all is not this loop's to diagnose — no project at that URL, or a field
    // that is not a single select. `toBoard` says which, in the words it already has.
    const items = (parsed as any)?.data?.owner?.projectV2?.items;
    if (!items) break;
    nodes.push(...((items.nodes ?? []) as unknown[]));

    if (!items.pageInfo?.hasNextPage) { short = false; break; }
    short = true;

    const next = asString(items.pageInfo.endCursor);
    if (!next || !CURSOR.test(next)) {
      logger.warn(
        'Project board: GitHub returned a cursor this reader will not put on a command line, '
        + `so the mirror stops at ${nodes.length} items`
      );
      break;
    }
    cursor = next;
  }

  // The last page read, carrying every page's items and one honest answer about whether
  // any were left behind. `hasNextPage` stops meaning "there is another page" — every
  // caller of `morePages` wants "cards are missing", and after paging those differ.
  const project = (parsed as any)?.data?.owner?.projectV2;
  if (project?.items) project.items = { pageInfo: { hasNextPage: short }, nodes };

  const cardLimit = options.cardLimit ?? workspace.projectCardLimit;
  const board = toBoard(parsed, {
    ...(cardLimit !== null && cardLimit !== undefined ? { cardLimit } : {}),
    repo: workspace.repo,
    // The queue starts the oldest first, so the column it drains is drawn that way too.
    // Which column that is comes from the workspace, exactly as the queue reads it.
    oldestFirstColumn: todoColumn(workspace).name,
  });
  // Two ways to end short, and the reader says which: the ceiling is a number somebody can
  // raise, a refused cursor is not. The other half of this is on the canvas — a log line is
  // what let the 100-item truncation run unnoticed through two issues.
  if (board.morePages) {
    logger.warn(
      pagesRead >= MAX_ITEM_PAGES
        ? `Project board: stopped after ${MAX_ITEM_PAGES} pages (${nodes.length} items) and the project has more, so cards are missing from the mirror`
        : `Project board: the mirror is showing ${nodes.length} items and the project has more`
    );
  }
  // Written here rather than in `toBoard`, which knows no workspace: this is the one fact on
  // the board that comes from `board.config.json` rather than from GitHub, and the browser
  // needs it to know which cards may be researched again.
  return { ...board, todoColumn: todoColumn(workspace).name };
}

export interface MoveRequest {
  projectId: string;
  fieldId: string;
  itemId: string;
  optionId: string;
}

/**
 * The `gh` arguments a move becomes.
 *
 * Split out from running it so the shape of the command can be checked without a GitHub
 * account: getting the field id wrong here would move nothing and report success.
 */
export function buildMoveArgs(move: MoveRequest): string[] {
  for (const [name, value] of Object.entries(move)) {
    if (!NODE_ID.test(value)) throw new Error(`Invalid ${name}: ${value}`);
  }
  return [
    'project', 'item-edit',
    '--id', move.itemId,
    '--project-id', move.projectId,
    '--field-id', move.fieldId,
    '--single-select-option-id', move.optionId,
  ];
}

/**
 * Move one card to another column.
 *
 * The board is re-read first rather than trusting what the browser sent: the option id
 * has to be one this project actually has, and the project and field ids are not the
 * caller's to supply. It costs one extra `gh` call on a drag, and it means a stale canvas
 * cannot write a column that no longer exists.
 */
export async function moveCard(
  workspace: Workspace,
  itemId: string,
  optionId: string
): Promise<ProjectBoard> {
  if (!NODE_ID.test(itemId)) throw new Error(`Invalid itemId: ${itemId}`);

  const board = await readProjectBoard(workspace);
  const section = board.sections.find((candidate) => candidate.optionId === optionId);
  if (!section || optionId === NO_STATUS_OPTION_ID) {
    throw new NotOnThisBoard(`"${optionId}" is not a column on this project.`);
  }
  if (!board.sections.some((candidate) => candidate.cards.some((card) => card.itemId === itemId))) {
    throw new NotOnThisBoard(`Item ${itemId} is not on this project.`);
  }

  const args = buildMoveArgs({
    projectId: board.projectId,
    fieldId: board.fieldId,
    itemId,
    optionId,
  });
  // Retried like every other `gh` call here, and safe to retry because this write is
  // idempotent: it sets a single-select field to one value rather than appending
  // anything. The first real move made from this machine failed on `dial tcp`, the same
  // socket-buffer exhaustion the issue reader already retries — without a retry that
  // blip would reach the canvas as a card snapping back for no reason anyone can see.
  await runGh(workspace, args.join(' '), { what: 'the project board move' });
  logger.info(`Project board: moved ${itemId} to "${section.name}"`);

  return readProjectBoard(workspace);
}

/** A move naming a column or an item this project does not have — the caller's mistake. */
export class NotOnThisBoard extends Error {}

/**
 * The columns a run lands in when a project does not name them.
 *
 * These are the only two constants in this file that name a column, and they are fallbacks
 * rather than rules: they are what GitHub calls the columns on a project it created, the same
 * default the `+` already leans on when it drops a draft into the first option. A board that
 * renamed one says so in `board.config.json`; a board that has no such column gets no move,
 * because a guess would move somebody's card into a column they never asked for.
 */
export const DEFAULT_IN_PROGRESS_COLUMN = 'In Progress';
export const DEFAULT_TODO_COLUMN = 'Todo';

/** A column to move to, and the setting that would name it if the default is wrong. */
export interface ColumnTarget {
  /** The column's name on the project, matched case-insensitively. */
  name: string;
  /** The `board.config.json` key, so a column that is missing says how to fix itself. */
  setting: string;
}

/** Where an implementation goes when it starts. */
export function inProgressColumn(workspace: Workspace): ColumnTarget {
  return {
    name: workspace.projectInProgressColumn ?? DEFAULT_IN_PROGRESS_COLUMN,
    setting: 'projectInProgressColumn',
  };
}

/** Where a researched issue goes when it exists — out of the column it was drafted in. */
export function todoColumn(workspace: Workspace): ColumnTarget {
  return {
    name: workspace.projectTodoColumn ?? DEFAULT_TODO_COLUMN,
    setting: 'projectTodoColumn',
  };
}

/** A section by name, case-insensitively. No Status is not a column anything can move to. */
export function findColumn(board: ProjectBoard, name: string): BoardSection | null {
  const wanted = name.trim().toLowerCase();
  return board.sections.find((section) =>
    section.optionId !== NO_STATUS_OPTION_ID
    && section.name.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Move the card carrying one issue into a named column.
 *
 * Called at the two moments this repository knows something the board does not: a research
 * run finished, so the issue exists and belongs out of the column it was drafted in; and an
 * implementation started, so it belongs in the in-progress one. Both writes are the
 * server's rather than the agent's. The observations they come from name the agent because
 * the agent is what the click starts, but nothing requires the write to come from that
 * process — and an agent is the one participant that cannot report its own crash, so an
 * agent that died early would leave the card exactly where the failure was invisible. Here
 * the state is written by whoever knows what happened.
 *
 * Everything that is not a move returns `null` rather than throwing: no project, no such
 * column, an issue that is not on the board, a card already in that column. None of them is
 * a fault of the run, and none of them may cost it. Only `gh` itself failing throws, and the
 * caller logs it.
 *
 * Returns the column landed on, or `null` when nothing was written.
 */
export async function moveIssueToColumn(
  workspace: Workspace,
  issueUrl: string,
  target: ColumnTarget
): Promise<string | null> {
  // A board with no project stays exactly as dormant as it was: no `gh`, no read, nothing.
  if (!workspace.githubProject) return null;

  // Read uncapped: the cap is there so a section does not draw hundreds of cards, and a
  // card hidden behind it would read here as an issue that is not on the project. The page
  // size was a second cap this did not lift, and for two issues it was the one that bit —
  // a card past item 100 was reported "not on this project" and its note never left My
  // Notes. `readProjectBoard` follows the pages now; what is left is `MAX_ITEM_PAGES`.
  const board = await readProjectBoard(workspace, { cardLimit: 0 });

  const column = findColumn(board, target.name);
  if (!column) {
    logger.warn(
      `Project board: no "${target.name}" column on this project, so ${issueUrl} was left where it is. `
      + `Name the column as "${target.setting}" in board.config.json.`
    );
    return null;
  }

  const found = board.sections
    .flatMap((section) => section.cards.map((card) => ({ section, card })))
    .find((entry) => entry.card.url === issueUrl);
  if (!found) {
    logger.info(`Project board: ${issueUrl} is not on this project, so nothing was moved`);
    return null;
  }
  if (found.section.optionId === column.optionId) {
    logger.info(`Project board: ${issueUrl} is already in "${column.name}"`);
    return null;
  }

  const args = buildMoveArgs({
    projectId: board.projectId,
    fieldId: board.fieldId,
    itemId: found.card.itemId,
    optionId: column.optionId,
  });
  // `moveCard` is the drag's version of this and re-reads the board afterwards to answer the
  // request with a fresh one. Nothing consumes a board here — the canvas polls — so that
  // read, and the one `moveCard` does to find the item this function has already found,
  // would both be spent on nobody.
  await runGh(workspace, args.join(' '), { what: 'the project board move' });
  logger.info(`Project board: ${issueUrl} moved to "${column.name}"`);

  return column.name;
}
