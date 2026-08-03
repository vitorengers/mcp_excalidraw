#!/usr/bin/env node
/**
 * The implement queue can never start a founder action.
 *
 * A founder action is work only a human can do — put credit on the card, sign the
 * agreement, answer the email — and it is published to the project as a **draft item**. The
 * hazard this fences is one press away: a coding agent dispatched at "put credit on the API"
 * burns a run and opens a pull request against a decision no repository holds. That is a
 * correctness requirement rather than a polish item, so it lands as a check, and it lands
 * *before* anything files a founder action rather than after — a fence installed after the
 * producer it protects has a window with nothing in it.
 *
 * It pins behaviour that exists today and changes no source at all. It is red only against a
 * tree in which somebody has broken one of the three independent arguments below, which is
 * exactly its job.
 *
 *  1. **A published founder action is a draft project item, and a draft is unstartable.**
 *     This is the load-bearing one and it is provable with a pure fixture.
 *     `buildProjectQuery` selects `... on DraftIssue { title createdAt }` — no `url`, no
 *     `number`, no `state`, no `repository` — so `toBoard` builds the card with `url: null`,
 *     `number: null` and `draggable: false`, and `startableCards` filters on
 *     `contentType === 'Issue' && Boolean(card.url) && card.state !== 'CLOSED' &&
 *     card.draggable !== false`. A draft fails three of those. It is unstartable **even if a
 *     human drags it into Todo**, which is the hazard that matters, because `moveCard` has no
 *     per-column policy at all.
 *  2. **The canvas-owned column's option id is unwritable.** `canvas:founder` carries a `:`,
 *     which fails the `NODE_ID` pattern every write to the project is validated against, so
 *     `buildMoveArgs` refuses it and `moveCard`, which builds its arguments there, refuses it
 *     as a target. The same guarantee `NOTES_OPTION_ID` already carries. Asserted against a
 *     constant this file declares locally, so this check does not depend on the column
 *     itself having landed; that column's own check asserts the constant matches.
 *  3. **The queue drains exactly one column, by name.** `dispatchQueue` resolves
 *     `todoColumn(workspace)`, calls `findColumn`, and feeds `column.cards` — and nothing
 *     else — to `startableCards`. `findColumn` excludes `NO_STATUS_OPTION_ID`.
 *
 * **Nothing here is allowed to be vacuously green.** Every section carries a positive
 * control: the same fixture with a real open issue present must report that issue as
 * startable, a deliberately mutated draft must be reported startable, an ordinary hex option
 * id must be accepted by `buildMoveArgs`, and section 3's source assertion is run against a
 * mutated copy of the function body that must fail it. An assertion that cannot fail is not
 * evidence.
 *
 * Every column in the fixture is also renamed and every assertion re-run, the way
 * `scripts/check-board-counts.mjs` does it, so nothing may key on the literal string
 * `Founder Actions` or `Todo`.
 *
 * Pure: no server, no Chrome, no network, no temporary directory. It imports
 * `dist/core/implement-queue.js` and `dist/core/project-board.js` and reads two files under
 * `src/`. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-not-startable.mjs
 *
 * Tier: fast
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const { startableCards } = await import(
  new URL('../dist/core/implement-queue.js', import.meta.url).href
);
const {
  buildMoveArgs,
  buildProjectQuery,
  findColumn,
  toBoard,
  todoColumn,
  NOTES_OPTION_ID,
  NO_STATUS_NAME,
  NO_STATUS_OPTION_ID,
} = await import(new URL('../dist/core/project-board.js', import.meta.url).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The fixture ──────────────────────────────────────────────

const REPO = 'vitorengers/vibemaxxing';
const ELSEWHERE = 'someone-else/their-tool';

/**
 * The option ids, as GitHub writes them: hex, and nothing a column name could be read off.
 *
 * Two namings are run over the same ids below, so a card's identity through the whole check
 * is its item id and its issue number rather than the column it happens to sit in.
 */
const OPTION = { queue: 'f75ad846', founder: '4a1c90bb', doing: '47fc9ee4' };

/** GitHub's own names for a project it created, plus what a founder column would be called. */
const SHIPPED_NAMES = { queue: 'Todo', founder: 'Founder Actions', doing: 'In Progress' };
/** The same board with every column renamed. Nothing may behave differently under these. */
const RENAMED = { queue: 'Up Next', founder: 'By Hand', doing: 'Underway' };

/** A day in July 2026, so "oldest" is a fact of the fixture rather than of the clock. */
const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

function issueItem(itemId, { number, option, createdAt, state = 'OPEN', repo = REPO, type = 'Issue' }) {
  return {
    id: itemId,
    fieldValueByName: option ? { optionId: option, name: 'whatever the field says' } : null,
    content: {
      __typename: type,
      number,
      title: `Item ${number}`,
      url: `https://github.com/${repo}/${type === 'PullRequest' ? 'pull' : 'issues'}/${number}`,
      createdAt,
      state,
      repository: { nameWithOwner: repo },
    },
  };
}

/**
 * A draft project item, carrying exactly what `buildProjectQuery` asks a `DraftIssue` for.
 *
 * `title` and `createdAt`, and nothing else. Adding a `url` here would be inventing a field
 * GitHub was never asked for, and the check would then be measuring the fixture.
 */
function draftItem(itemId, { option, createdAt, title = 'Put credit on the API' }, mutate = null) {
  const content = { __typename: 'DraftIssue', title, createdAt };
  return {
    id: itemId,
    fieldValueByName: option ? { optionId: option, name: 'whatever the field says' } : null,
    content: mutate ? { ...content, ...mutate } : content,
  };
}

/**
 * The project GitHub would answer with.
 *
 * The founder column holds all four kinds of card that must never start: the draft, a closed
 * issue, a pull request and an issue belonging to another repository. The queue column holds
 * one open issue of this repository's own — and the same draft dragged in by hand, which is
 * the hazard, because nothing refuses that drag.
 */
function project(names, { openIssueInFounder = false, draftMutation = null } = {}) {
  return {
    data: {
      owner: {
        projectV2: {
          id: 'PVT_kwHOAA',
          title: 'The board',
          url: 'https://github.com/users/somebody/projects/5',
          field: {
            id: 'PVTSSF_lADO',
            name: 'Status',
            options: [
              { id: OPTION.queue, name: names.queue },
              { id: OPTION.founder, name: names.founder },
              { id: OPTION.doing, name: names.doing },
            ],
          },
          items: {
            pageInfo: { hasNextPage: false },
            nodes: [
              // The queue's own column: one real issue, and a founder action somebody dragged.
              issueItem('item-open', { number: 101, option: OPTION.queue, createdAt: day(2) }),
              draftItem('item-dragged', { option: OPTION.queue, createdAt: day(1) }, draftMutation),

              // The founder column: the four kinds that must never start.
              draftItem('item-draft', { option: OPTION.founder, createdAt: day(1) }, draftMutation),
              issueItem('item-closed', {
                number: 102, option: OPTION.founder, createdAt: day(3), state: 'CLOSED',
              }),
              issueItem('item-pull', {
                number: 103, option: OPTION.founder, createdAt: day(4), type: 'PullRequest',
              }),
              issueItem('item-foreign', {
                number: 104, option: OPTION.founder, createdAt: day(5), repo: ELSEWHERE,
              }),
              ...(openIssueInFounder
                ? [issueItem('item-founder-open', { number: 106, option: OPTION.founder, createdAt: day(6) })]
                : []),

              // Elsewhere on the project, and an item the project never gave a status.
              issueItem('item-doing', { number: 105, option: OPTION.doing, createdAt: day(7) }),
              issueItem('item-untriaged', { number: 107, option: null, createdAt: day(8) }),
            ],
          },
        },
      },
    },
  };
}

/** The board as `readProjectBoard` would build it: this repository's own, no cap. */
const board = (names, options = {}, repo = REPO) =>
  toBoard(project(names, options), { cardLimit: 0, repo, oldestFirstColumn: names.queue });

const column = (built, names, key) => findColumn(built, names[key]);
const startableIn = (built, names, key) => startableCards(column(built, names, key).cards);
const named = (cards) => cards.map((card) => `${card.contentType} ${card.itemId}`).join(', ') || '(none)';

// ─── 1. A draft is unstartable, however it got there ──────────

console.log('\n1. a published founder action is a draft project item, and a draft is unstartable');

const draftSelection = /\.\.\. on DraftIssue \{([^}]*)\}/.exec(buildProjectQuery('user'));
check('the query asks a draft for a title and a date',
      draftSelection !== null && draftSelection[1].trim() === 'title createdAt',
      draftSelection ? JSON.stringify(draftSelection[1]) : 'no DraftIssue selection in the query');
check('and for nothing a run could be started from — no url, number, state or repository',
      draftSelection !== null
      && !/\b(url|number|state|repository)\b/.test(draftSelection[1]),
      draftSelection ? JSON.stringify(draftSelection[1]) : '');
check('the same is true of an organisation-owned project, which is a second query',
      /\.\.\. on DraftIssue \{ title createdAt \}/.test(buildProjectQuery('organization')));

for (const [naming, names] of [['as GitHub names them', SHIPPED_NAMES], ['with every column renamed', RENAMED]]) {
  console.log(`\n1. (${naming})`);

  const built = board(names);
  const founder = column(built, names, 'founder');
  const drafts = founder.cards.filter((card) => card.contentType === 'DraftIssue');

  check(`the draft is on the board and is a draft — ${naming}`,
        drafts.length === 1 && drafts[0].itemId === 'item-draft',
        named(founder.cards));
  check(`it carries no url, no number and is not draggable — ${naming}`,
        drafts[0].url === null && drafts[0].number === null && drafts[0].draggable === false,
        JSON.stringify(drafts[0]));

  check(`the column holding a draft, a closed issue, a pull request and another repository's card starts nothing — ${naming}`,
        startableIn(built, names, 'founder').length === 0,
        named(startableIn(built, names, 'founder')));

  // The hazard: nothing refuses the drag, so the card is in the drained column.
  const queue = startableIn(built, names, 'queue');
  check(`a draft dragged into the drained column is still not startable — ${naming}`,
        queue.every((card) => card.contentType === 'Issue' && card.itemId !== 'item-dragged'),
        named(queue));
  check(`and the real issue beside it is — the positive control — ${naming}`,
        queue.length === 1 && queue[0].number === 101,
        named(queue));

  // The positive control on the founder column itself: the same column, one real issue added.
  const withIssue = startableIn(board(names, { openIssueInFounder: true }), names, 'founder');
  check(`the same column reports its one open issue when there is one — ${naming}`,
        withIssue.length === 1 && withIssue[0].number === 106,
        named(withIssue));
}

console.log('\n1b. the assertion is capable of failing — a mutated draft IS reported startable');

// Literally what the issue names: `contentType: 'Issue'` plus a url. On a project whose
// workspace declares no `repo`, `draggable` is true for any issue, so this is the mutation
// on its own, with nothing else standing in its way.
const MUTATION = {
  __typename: 'Issue',
  url: `https://github.com/${REPO}/issues/999`,
  number: 999,
  state: 'OPEN',
};
const asIssue = { __typename: MUTATION.__typename, url: MUTATION.url };

const noRepo = board(SHIPPED_NAMES, { draftMutation: asIssue }, null);
const mutatedNoRepo = startableCards(findColumn(noRepo, SHIPPED_NAMES.founder).cards);
check('the draft given a content type of Issue and a url is startable on a board with no repo',
      mutatedNoRepo.some((card) => card.itemId === 'item-draft'),
      named(mutatedNoRepo));

// And with the repo declared, which is what this board actually runs as, the same mutation
// is stopped by the *second* guard rather than by the first — `draggable`, from a card that
// names no repository. Two independent clauses, so it is worth knowing which one bit.
const stillGuarded = startableIn(board(SHIPPED_NAMES, { draftMutation: asIssue }), SHIPPED_NAMES, 'founder');
check('with the repo declared, that same mutation is still refused — by draggable, the second clause',
      !stillGuarded.some((card) => card.itemId === 'item-draft'),
      named(stillGuarded));

const fully = startableIn(
  board(SHIPPED_NAMES, { draftMutation: { ...MUTATION, repository: { nameWithOwner: REPO } } }),
  SHIPPED_NAMES,
  'founder'
);
check('and a draft mutated into a full issue of this repository IS startable, so the check can go red',
      fully.some((card) => card.itemId === 'item-draft' && card.number === 999),
      named(fully));

// ─── 2. The column's option id cannot be written back ─────────

console.log("\n2. a canvas-owned column's option id is unwritable");

/**
 * Declared here rather than imported.
 *
 * This check is a fence installed ahead of the column it fences, so it must not fail to run
 * because that column has not landed. The column's own check asserts that the constant in
 * `project-board-types.ts` is this string; here it is a literal, and what is being asserted
 * is a property of the *shape* — a `:` in an option id is refused.
 */
const FOUNDER_OPTION_ID = 'canvas:founder';

const HEX = 'PVTSSF_lADOAbcd';
const move = (optionId) => ({ projectId: HEX, fieldId: HEX, itemId: HEX, optionId });

function refused(optionId) {
  try {
    buildMoveArgs(move(optionId));
    return null;
  } catch (error) {
    return error.message;
  }
}

check('the notes column id is the one this repository already ships', NOTES_OPTION_ID === 'canvas:notes', NOTES_OPTION_ID);

for (const optionId of ['canvas:notes', FOUNDER_OPTION_ID]) {
  const message = refused(optionId);
  check(`buildMoveArgs refuses "${optionId}"`, message !== null, 'it built arguments for it');
  check(`and says which field it refused — "${optionId}"`,
        typeof message === 'string' && message.includes('Invalid optionId') && message.includes(optionId),
        String(message));
}

check('the colon is the reason — the same word without one is accepted',
      refused('canvasfounder') === null,
      String(refused('canvasfounder')));
check('an ordinary GitHub option id is accepted, and becomes the six flags a move is — the positive control',
      JSON.stringify(buildMoveArgs(move(OPTION.founder)))
      === JSON.stringify([
        'project', 'item-edit',
        '--id', HEX,
        '--project-id', HEX,
        '--field-id', HEX,
        '--single-select-option-id', OPTION.founder,
      ]),
      JSON.stringify(buildMoveArgs(move(OPTION.founder))));

/** `moveCard` is where a drag lands, and its refusal is `buildMoveArgs`'s or it is nothing. */
const projectBoardSource = readFileSync(join(repoRoot, 'src', 'core', 'project-board.ts'), 'utf8');
const moveCardBody = /export async function moveCard\([\s\S]*?\n\}/.exec(projectBoardSource);
check('moveCard builds its arguments through buildMoveArgs, so that refusal is the one a drag meets',
      moveCardBody !== null && moveCardBody[0].includes('buildMoveArgs({'),
      moveCardBody ? 'it does not call buildMoveArgs' : 'moveCard was not found in project-board.ts');

// ─── 3. The queue drains exactly one column, by name ──────────

console.log('\n3. the queue drains exactly one column, by name');

check('the column a queue drains is the workspace\'s, defaulting to GitHub\'s own name',
      todoColumn({}).name === 'Todo' && todoColumn({ projectTodoColumn: RENAMED.queue }).name === RENAMED.queue,
      `${todoColumn({}).name} | ${todoColumn({ projectTodoColumn: RENAMED.queue }).name}`);

for (const [naming, names] of [['as GitHub names them', SHIPPED_NAMES], ['with every column renamed', RENAMED]]) {
  const built = board(names);

  check(`findColumn resolves the drained column by name, and it is the one holding #101 — ${naming}`,
        column(built, names, 'queue')?.optionId === OPTION.queue,
        String(column(built, names, 'queue')?.optionId));
  check(`the founder column is reachable only by asking for it by its own name — ${naming}`,
        column(built, names, 'founder')?.optionId === OPTION.founder
        && findColumn(built, names.queue).optionId !== OPTION.founder,
        String(column(built, names, 'founder')?.optionId));
  check(`a name no column carries resolves to nothing — ${naming}`,
        findColumn(built, 'A Column That Was Renamed') === null);
  check(`the match is case-insensitive and trimmed, so it is a name and not a token — ${naming}`,
        findColumn(built, `  ${names.queue.toUpperCase()}  `)?.optionId === OPTION.queue);

  const untriaged = built.sections.find((section) => section.optionId === NO_STATUS_OPTION_ID);
  check(`the untriaged section exists and holds the item with no status — ${naming}`,
        untriaged !== undefined && untriaged.cards.some((card) => card.itemId === 'item-untriaged'),
        untriaged ? named(untriaged.cards) : 'there is no untriaged section');
  check(`and findColumn will not resolve it, however it is asked for — ${naming}`,
        findColumn(built, NO_STATUS_NAME) === null && findColumn(built, '') === null,
        `${findColumn(built, NO_STATUS_NAME)} | ${findColumn(built, '')}`);
}

console.log('\n3b. renaming every column changes only the names');

const shipped = board(SHIPPED_NAMES);
const renamed = board(RENAMED);
const ids = (built, names, key) => startableIn(built, names, key).map((card) => card.itemId).join(',');
check('the drained column starts the same cards under either naming',
      ids(shipped, SHIPPED_NAMES, 'queue') === ids(renamed, RENAMED, 'queue')
      && ids(shipped, SHIPPED_NAMES, 'queue') === 'item-open',
      `${ids(shipped, SHIPPED_NAMES, 'queue')} | ${ids(renamed, RENAMED, 'queue')}`);
check('and the founder column starts nothing under either naming',
      ids(shipped, SHIPPED_NAMES, 'founder') === '' && ids(renamed, RENAMED, 'founder') === '',
      `${ids(shipped, SHIPPED_NAMES, 'founder')} | ${ids(renamed, RENAMED, 'founder')}`);
check('no column name reaches the cards at all — the sections differ in nothing but their names',
      JSON.stringify(shipped.sections.map((section) => [section.optionId, section.cards.map((card) => card.itemId)]))
      === JSON.stringify(renamed.sections.map((section) => [section.optionId, section.cards.map((card) => card.itemId)])));

console.log('\n3c. the queue feeds one column, and only that column, to the filter');

/**
 * Read off `dispatchQueue` rather than driven.
 *
 * Driving it would need a server, a stub `gh` and a stub agent — which
 * `check-implement-queue.mjs` already does, at the cost of a minute a run. What this section
 * has to say is narrower and is a property of the source: whatever else that function reads,
 * the list it hands to `startableCards` is the resolved column's cards. It reads every
 * section to build a lookup of issue numbers to states — that is how a dependency is checked
 * — and a lookup is not a queue.
 */
const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const dispatchBody = /\nasync function dispatchQueue\([\s\S]*?\n\}\n/.exec(serverSource);
check('dispatchQueue was found in src/server.ts', dispatchBody !== null);

const body = dispatchBody ? dispatchBody[0] : '';
const startableCalls = (text) => [...text.matchAll(/startableCards\(([^)]*)\)/g)].map((match) => match[1]);
const findColumnCalls = (text) => [...text.matchAll(/findColumn\(([^)]*)\)/g)].map((match) => match[1]);

check('it resolves exactly one column, by the name the workspace gives it',
      findColumnCalls(body).length === 1 && findColumnCalls(body)[0] === 'board, target.name'
      && /const target = todoColumn\(workspace\)/.test(body),
      findColumnCalls(body).join(' | '));
// Two calls today — one walking the column for dependencies, one starting what is left —
// and the assertion is over every one of them rather than over a count, because a third
// would be as legitimate as the second and feeding it another list would not be.
const startableArguments = startableCalls(body);
check('and every list it filters for startable cards is that column\'s',
      startableArguments.length > 0
      && startableArguments.every((argument) => argument.split(',')[0].trim() === 'column.cards'),
      startableArguments.join(' | '));

// The positive control for the two assertions above: the same reading, over a body that has
// been broken on purpose, has to report it.
const broken = body.replace('startableCards(column.cards, blocked)', 'startableCards(board.sections.flatMap((s) => s.cards), blocked)');
check('a body that filtered every section instead would be reported — so this reading bites',
      broken !== body
      && !startableCalls(broken).every((argument) => argument.split(',')[0].trim() === 'column.cards'),
      startableCalls(broken).join(' | '));

if (failures) {
  console.error(`\n${failures} case${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('\nall cases passed');
