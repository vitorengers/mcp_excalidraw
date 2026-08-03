/**
 * Putting a founder action on the GitHub project — as a **draft item**, never as an issue.
 *
 * ## Why the shape of the card is the whole correctness argument
 *
 * A draft item is unstartable three times over, and none of the three is a policy anybody has to
 * remember. `buildProjectQuery` asks a `DraftIssue` for `title createdAt` and nothing else, so
 * `toBoard` builds the card with `url: null`, `number: null` and `draggable: false`, and
 * `startableCards` refuses it on the content type, on the url *and* on `draggable`. It is
 * therefore unstartable **even after a person has dragged it into the column the queue drains**,
 * which matters because `moveCard` has no per-column policy at all.
 * `scripts/check-founder-not-startable.mjs` is where that is measured rather than asserted.
 *
 * The alternative is a trap, and it is worth writing down because it is the obvious first cut.
 * `gh issue create` followed by `moveIssueToColumn` cannot work: nothing here has a
 * `gh project item-add`, so the issue is not on the project and the move answers "is not on this
 * project, so nothing was moved". Worse, if the project's *Item added to project* workflow is on,
 * GitHub adds the issue with the project's default Status — commonly Todo — and races the move.
 * That decision is made outside this repository and cannot be read back. A coding agent would
 * then be dispatched to put credit on somebody's API.
 *
 * ## Publication is on, and off is the switch
 *
 * The queue's `setQueueEnabled` is the analogy that does *not* hold. That one starts coding
 * agents against a repository and is rightly off until somebody says so. This one writes a draft
 * item to a column: it spawns nothing, changes no code, and the column exists so that the
 * operator sees a blocker without going and looking for it. A feature whose whole point is
 * visibility must not ship invisible, so the boolean read from the workspace is a
 * **suppression** — `projectFounderPublishOff` — and it is unset on a fresh board.
 *
 * ## What is not a refusal
 *
 * A board with no `githubProject`, a project whose options hold no founder column, a `gh` that
 * failed: none of them costs the action anything. The store is the record and GitHub is a
 * projection of it, so the card is written and drawn on the canvas either way. The degradation
 * follows `moveIssueToColumn`'s terms verbatim — no project spawns no `gh` at all and answers
 * null; no founder column creates nothing, answers null and warns naming the setting that would
 * fix it; only `gh` itself failing throws, and a throw is non-fatal to the caller.
 */
import logger from '../utils/logger.js';
import { Workspace } from './workspaces.js';
import { runGh } from './gh.js';
import {
  buildMoveArgs,
  findColumn,
  founderColumn,
  parseProjectUrl,
  readProjectBoard,
} from './project-board.js';
import { renderFounderAction } from './founder-action-text.js';
import {
  FounderActionRecord,
  markFounderActionPublished,
  readFounderAction,
} from './founder-store.js';

/**
 * The id `gh project item-create --format json` answers with.
 *
 * `{"id":"…","title":"","body":"","type":"Draft"}`, and the `id` is the **project item's** —
 * the one `gh project item-edit --id` takes — rather than the draft issue's own. Read off the
 * command's own test in cli/cli rather than remembered.
 */
interface CreatedItem {
  id?: unknown;
}

/** The id out of that answer, or nothing when `gh` printed something else entirely. */
function createdItemId(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout) as CreatedItem;
    return typeof parsed?.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * Publish one founder action to the workspace's project, and remember what it became.
 *
 * Answers the project item id — the one just created, or the one this record already carried —
 * and `null` for every case that is not a publication. Only `gh` failing throws.
 */
export async function publishFounderAction(
  workspace: Workspace,
  record: FounderActionRecord
): Promise<string | null> {
  // The record in the caller's hand may be older than the store's: two producers can hold the
  // same blocker, and one of them may have published it a moment ago. The store is what knows,
  // and it is read before anything is spawned — a second draft item for one blocker is the
  // failure this guard exists for, and it survives a restart because the store does.
  const stored = readFounderAction(record.workspaceId, record.key);
  const already = record.publishedItemId ?? stored?.publishedItemId ?? null;
  if (already) return already;

  if (workspace.projectFounderPublishOff) {
    logger.info(`Founder actions: "${workspace.id}" has publication turned off, so ${record.key} `
      + 'stays on the canvas');
    return null;
  }

  // A board with no project stays exactly as dormant as it was: no `gh`, no read, nothing. Same
  // first line as `moveIssueToColumn`, and for the same reason — most boards have no project.
  const ref = parseProjectUrl(workspace.githubProject);
  if (!ref) return null;

  // Read uncapped, for the reason `moveIssueToColumn` reads uncapped: the cap is there so a
  // section does not draw hundreds of cards, and a caller looking one thing up must not inherit
  // it. `projectCardLimit` is 8 on the board this was written for, and a capped read is exactly
  // how #199/#200 stranded cards nobody could see were there.
  const board = await readProjectBoard(workspace, { cardLimit: 0 });

  const target = founderColumn(workspace);
  const column = findColumn(board, target.name);
  if (!column) {
    logger.warn(
      `Founder actions: no "${target.name}" column on this project, so ${record.key} was not `
      + `published. Name the column as "${target.setting}" in board.config.json.`
    );
    return null;
  }

  // The title and the body are the register's, not this module's: `renderFounderAction` is the
  // only thing that turns a record into text, and a second composer here would be a second
  // answer to what a founder action reads like. The body carries newlines, backticks and
  // whatever a tool printed, so it travels as an argv element rather than on a command line.
  const body = renderFounderAction(record.fields, record.evidence);
  const stdout = await runGh(
    workspace,
    [
      'project', 'item-create', String(ref.number),
      '--owner', ref.login,
      '--title', record.fields.title,
      '--body', body,
      '--format', 'json',
    ],
    { what: 'the founder action publish' }
  ).catch((error: unknown) => {
    // Said here rather than left to the caller: the caller is a producer that has just noticed a
    // blocker, and the one thing it must not do is lose the record over a projection of it.
    logger.warn(`Founder actions: ${record.key} was not published — ${(error as Error).message}`);
    throw error;
  });

  const itemId = createdItemId(stdout);
  if (!itemId) {
    logger.warn(`Founder actions: ${record.key} was published and gh named no item, so nothing `
      + `was remembered: ${stdout.trim().slice(0, 200)}`);
    return null;
  }

  // Written onto the record *before* the column is set, and that order is deliberate. A move that
  // fails leaves a draft item in whatever column the project's own workflow chose — visible,
  // unstartable, and one card. Recording the id afterwards would instead leave the id unwritten
  // with the item already created, and the next pass would file a second one.
  markFounderActionPublished(record.workspaceId, record.key, itemId);

  // `item-create` has no way to set a field, and a draft left where GitHub put it is a draft in
  // whichever column the project's *Item added to project* workflow chose — the very decision
  // this module refuses to depend on. The ids are validated by `buildMoveArgs` against the
  // pattern every project write goes through.
  const args = buildMoveArgs({
    projectId: board.projectId,
    fieldId: board.fieldId,
    itemId,
    optionId: column.optionId,
  });
  await runGh(workspace, args, { what: 'the founder action placement' }).catch((error: unknown) => {
    logger.warn(`Founder actions: ${record.key} was published as ${itemId} and could not be moved `
      + `into "${column.name}" — ${(error as Error).message}`);
    throw error;
  });

  logger.info(`Founder actions: ${record.key} published as ${itemId} in "${column.name}"`);
  return itemId;
}
