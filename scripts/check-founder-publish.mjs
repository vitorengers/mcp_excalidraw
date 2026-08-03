#!/usr/bin/env node
/**
 * Checks that a founder action reaches the GitHub project as a **draft item**, never as an issue.
 *
 * The whole correctness argument of this feature is in how the card is written. A draft item is
 * unstartable three times over — `buildProjectQuery` asks a `DraftIssue` for `title createdAt`
 * and nothing else, so `toBoard` builds it with `url: null` and `draggable: false`, and
 * `startableCards` refuses it on the content type, on the url *and* on `draggable`
 * (`scripts/check-founder-not-startable.mjs` measured which clause holds). An **issue** filed
 * with `gh issue create` would be startable the moment somebody dragged it into the drained
 * column, and a coding agent would be dispatched to put credit on an API.
 *
 * So the cases here are about the *call*, and section 11 is the one that catches the obvious
 * first cut: the whole argv log, across every section, may contain no `gh issue create`, no
 * `gh project item-add` and no `item-edit` naming the queue's own column. It spans the whole log
 * rather than one call because a producer that filed an issue and then moved it would satisfy
 * every other case in this file.
 *
 * Eleven sections:
 *
 *  1. **one door in.** `publishFounderAction(workspace, record)` and nothing else.
 *  2. **one `item-create`, and the body is the composer's.** The title is the record's, the body
 *     is byte-identical to `renderFounderAction(fields, evidence)` — apostrophes, backticks, a
 *     `$(…)` and newlines included, because a body that reached `gh` through a shell would come
 *     back mangled or, on a WSL board, executed. The item id is written onto the record, and the
 *     draft is moved into the founder column by its option id.
 *  3. **the queue cannot start what was published**, over a board fixture holding that very
 *     draft — in the founder column and dragged into the drained one — beside an ordinary issue
 *     the queue *does* start, so the assertion is not vacuous.
 *  4. **the suppression is a suppression.** Set, nothing is published and no `gh` runs at all.
 *  5. **no `githubProject`, no process**, and the record stays canvas-only.
 *  6. **and with neither, it publishes** — nobody turns anything on. Both a board that renamed
 *     its columns and one that did not name them at all.
 *  7. **a project with no founder column** creates nothing, answers null, and warns naming
 *     `projectFounderColumn`.
 *  8. **never published twice**, including from a fresh process that reads the record off disk.
 *  9. **a `gh` failure is non-fatal**: logged, the record left unpublished, and the next attempt
 *     publishes.
 * 10. **the option id comes from an uncapped read** — twelve cards against `projectCardLimit: 8`.
 * 11. **the whole argv log**, as above.
 *
 * The fixture renames every column — `Icebox`, `Underway`, `Shipped` and a founder column called
 * `Over to you` — the convention of `scripts/check-board-counts.mjs`, so nothing here can pass by
 * keying on a string GitHub happens to have chosen.
 *
 * Self-contained and offline: a throwaway state directory and registry in the temp folder, a stub
 * `gh` that answers from a fixture and logs every argv, one short-lived child process for the
 * restart, no canvas server, no browser and nothing asked of GitHub. It imports the built
 * modules, so run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-founder-publish.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const built = (module) => join(repoRoot, 'dist', 'core', `${module}.js`);
const url = (file) => JSON.stringify(pathToFileURL(file).href);

// ─── The throwaway directory, before the first import ─────────
//
// `utils/logger.ts` resolves its file at import and the store resolves its directory at every
// write, so both have to be pointed somewhere throwaway before anything under `dist/` loads.
// `NO_DOTENV` seals the two file layers off: this run is decided by what is set here.

const workDir = join(tmpdir(), `founder-publish-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const stateDir = join(workDir, 'board-workspaces-state');
const stubPath = join(workDir, 'stub-gh.mjs');
const controlPath = join(workDir, 'control.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

mkdirSync(stateDir, { recursive: true });
writeFileSync(logPath, '', 'utf8');

process.env.LOG_FILE_PATH = join(workDir, 'canvas.log');
process.env.VIBEMAXXING_NO_DOTENV = '1';
process.env.VIBEMAXXING_BOARD_STATE = stateDir;
process.env.EXCALIDRAW_GH_COMMAND = `node "${stubPath.replace(/\\/g, '/')}"`;
process.env.STUB_GH_CONTROL = controlPath;
process.env.STUB_GH_LOG = logPath;

// ─── The project fixtures ─────────────────────────────────────

const REPO = 'vitorengers/vibemaxxing';

/** Option ids as GitHub writes them: nothing a column name could be read back off. */
const OPTION = { queue: 'f75ad846', doing: '47fc9ee4', done: '98236657', founder: '4a1c90bb' };

/**
 * Every column renamed, so nothing may key on a name GitHub chose.
 *
 * The convention of `scripts/check-board-counts.mjs`: a fixture whose columns are called `Todo`
 * and `In Progress` cannot tell a resolver that reads the workspace from one that guessed.
 */
const NAMED = { queue: 'Icebox', doing: 'Underway', done: 'Shipped', founder: 'Over to you' };

/** GitHub's own default naming, for the board that configures nothing at all. */
const DEFAULT_NAMES = { queue: 'Todo', doing: 'In Progress', done: 'Done', founder: 'Founder Actions' };

const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

function issueItem(itemId, { number, option, createdAt, state = 'OPEN', repo = REPO }) {
  return {
    id: itemId,
    fieldValueByName: option ? { optionId: option, name: 'whatever the field says' } : null,
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: `https://github.com/${repo}/issues/${number}`,
      createdAt,
      state,
      repository: { nameWithOwner: repo },
    },
  };
}

/**
 * A draft project item, carrying exactly what `buildProjectQuery` asks a `DraftIssue` for.
 *
 * `title` and `createdAt`, and nothing else. A `url` here would be a field GitHub was never
 * asked for, and section 3 would then be measuring the fixture rather than the reader.
 */
function draftItem(itemId, { option, createdAt, title = 'Put credit on the API' }) {
  return {
    id: itemId,
    fieldValueByName: option ? { optionId: option, name: 'whatever the field says' } : null,
    content: { __typename: 'DraftIssue', title, createdAt },
  };
}

/** The answer `gh api graphql` gives for one project. */
function project(number, { names = NAMED, founderColumn = true, nodes = [] } = {}) {
  return {
    data: {
      owner: {
        projectV2: {
          id: `PVT_project${number}`,
          title: `Project ${number}`,
          url: `https://github.com/users/someone/projects/${number}`,
          field: {
            id: `PVTSSF_field${number}`,
            name: 'Status',
            options: [
              { id: OPTION.queue, name: names.queue },
              { id: OPTION.doing, name: names.doing },
              ...(founderColumn ? [{ id: OPTION.founder, name: names.founder }] : []),
              { id: OPTION.done, name: names.done },
            ],
          },
          items: { pageInfo: { hasNextPage: false }, nodes },
        },
      },
    },
  };
}

/** One ordinary open issue in the drained column, so every board has something startable on it. */
const ORDINARY = [issueItem('item-open', { number: 101, option: OPTION.queue, createdAt: day(2) })];

/** Twelve cards in the founder column, against a card limit of eight. */
const TWELVE = Array.from({ length: 12 }, (_, at) =>
  draftItem(`item-old-${at}`, { option: OPTION.founder, createdAt: day(at + 1) }));

const PROJECTS = {
  5: project(5, { nodes: ORDINARY }),
  6: project(6, { nodes: ORDINARY }),
  7: project(7, { founderColumn: false, nodes: ORDINARY }),
  8: project(8, { nodes: [...ORDINARY, ...TWELVE] }),
  9: project(9, { names: DEFAULT_NAMES, nodes: ORDINARY }),
};

// ─── The stub gh ──────────────────────────────────────────────

writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const control = JSON.parse(readFileSync(process.env.STUB_GH_CONTROL, 'utf8'));

if (args.includes('graphql')) {
  const found = args.find((arg) => arg.startsWith('number='));
  const body = found ? control.projects[found.slice('number='.length)] : null;
  if (!body) {
    process.stderr.write('stub gh: no project ' + String(found) + '\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}

if (args[0] === 'issue' && args[1] === 'create') {
  // Answered rather than refused, deliberately. The version this file exists to catch is one
  // built on \`gh issue create\`, and a stub that refused it would make the stub the thing
  // stopping it. It gets a perfectly good issue URL back; section 11 is what refuses it.
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/issues/999\\n');
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-create') {
  if (control.failCreate) {
    process.stderr.write('stub gh: the draft item could not be created\\n');
    process.exit(1);
  }
  // What \`gh project item-create --format json\` prints: the *project item* id, the one
  // \`item-edit --id\` takes. Transcribed from cli/cli's own test —
  // {"id":"item ID","title":"","body":"","type":"Draft"}.
  process.stdout.write(JSON.stringify({
    id: control.newItemId, title: '', body: '', type: 'Draft',
  }) + '\\n');
  process.exit(0);
}

if (args[0] === 'project' && args[1] === 'item-edit') {
  if (control.failEdit) {
    process.stderr.write('stub gh: the item could not be edited\\n');
    process.exit(1);
  }
  process.stdout.write('{}\\n');
  process.exit(0);
}

process.stderr.write('stub gh: nothing here answers ' + args.join(' ') + '\\n');
process.exit(1);
`, 'utf8');

let controlState = { projects: PROJECTS, newItemId: 'PVTI_first' };
function control(patch = {}) {
  controlState = { ...controlState, ...patch };
  writeFileSync(controlPath, JSON.stringify(controlState), 'utf8');
}
control();

// ─── The workspaces ───────────────────────────────────────────

/**
 * One workspace per condition, each pointed at a project of its own.
 *
 * `publishes` renames every column and names the founder one; `default-named` names nothing at
 * all, which is the case that says publication needs nobody to turn anything on.
 */
const WORKSPACES = [
  ['publishes', { githubProject: 'https://github.com/users/someone/projects/5' }],
  ['suppressed', {
    githubProject: 'https://github.com/users/someone/projects/6',
    projectFounderPublishOff: true,
  }],
  ['no-project', {}],
  ['no-column', { githubProject: 'https://github.com/users/someone/projects/7' }],
  ['capped', {
    githubProject: 'https://github.com/users/someone/projects/8',
    projectCardLimit: 8,
  }],
  ['default-named', { githubProject: 'https://github.com/users/someone/projects/9' }],
];

/** The renaming every workspace but `default-named` carries. */
const RENAMING = {
  projectTodoColumn: NAMED.queue,
  projectInProgressColumn: NAMED.doing,
  projectFounderColumn: NAMED.founder,
};

for (const [id, config] of WORKSPACES) {
  const directory = join(workDir, id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'board.config.json'), JSON.stringify({
    name: id,
    repo: REPO,
    ...(id === 'default-named' ? {} : RENAMING),
    ...config,
  }, null, 2), 'utf8');
}

writeFileSync(registryPath, JSON.stringify({
  workspaces: WORKSPACES.map(([id]) => ({ id, path: join(workDir, id).replace(/\\/g, '/') })),
}), 'utf8');

// ─── The modules ──────────────────────────────────────────────

async function importDist(module, what) {
  const file = built(module);
  if (!existsSync(file)) {
    console.error(`  FAIL  ${what} exists — dist/core/${module}.js not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    return null;
  }
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    console.error(`  FAIL  ${what} loads — ${error.message}`);
    return null;
  }
}

const { renderFounderAction, FOUNDER_ACTION_CORPUS } =
  await importDist('founder-action-text', 'the founder action register');
const store = await importDist('founder-store', 'the founder action store');
const { startableCards } = await importDist('implement-queue', 'the implementation queue');
const boardModule = await importDist('project-board', 'the project board reader');
const { loadWorkspaces } = await importDist('workspaces', 'the workspace registry');

const publishModule = await importDist('founder-publish', 'the founder action publisher');

/** A stand-in, so every section below still runs and still fails when the module is missing. */
const publishFounderAction = publishModule?.publishFounderAction
  ?? (() => { throw new Error('src/core/founder-publish.ts does not exist'); });

const workspaces = await loadWorkspaces(registryPath);
const workspaceOf = (id) => workspaces.find((candidate) => candidate.id === id);

for (const [id] of WORKSPACES) {
  const workspace = workspaceOf(id);
  if (!workspace || workspace.error) {
    console.error(`  FAIL  the throwaway workspace "${id}" loaded — ${workspace?.error ?? 'it is not there'}`);
    failures++;
  }
}

// ─── Reading the argv log, and what a call said ───────────────

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const since = (mark) => ghCalls().slice(mark);
const mark = () => ghCalls().length;
const creates = (calls) => calls.filter((args) => args[0] === 'project' && args[1] === 'item-create');
const edits = (calls) => calls.filter((args) => args[0] === 'project' && args[1] === 'item-edit');
const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

/**
 * What one call said on the console, and what it answered or threw.
 *
 * `utils/logger.ts` sends `warn` and above to stderr and everything else to a file, so a warning
 * about a column that is not there shows up here. Scoped to the one call: a capture left in place
 * would swallow `check()`'s own failures.
 */
async function said(run) {
  const heard = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    heard.push(String(chunk));
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') done();
    return true;
  };
  let value = null;
  let threw = null;
  try {
    value = await run();
  } catch (error) {
    threw = error;
  } finally {
    process.stderr.write = real;
  }
  return { value, threw, console: heard.join('') };
}

// ─── The record ───────────────────────────────────────────────

/**
 * Evidence that would not survive a shell.
 *
 * An apostrophe, a `$(…)`, a backtick pair and a newline. It goes through no validator — evidence
 * is exempt from the register — and it is here so that "byte-identical" in section 2 is a claim
 * about text that a command line assembled by string concatenation would have mangled or, on a
 * board inside a distro, executed.
 */
const EVIDENCE = {
  command: 'gh api repos/octo-founder/pantry/collaborators/octo-founder/permission',
  said: "HTTP 403: it's refused — $(echo pwned) `whoami`\nand a second line",
  source: 'src/core/github-push.ts',
};

const FIELDS = FOUNDER_ACTION_CORPUS['gh-billing'];
const KEY = 'publishes:gh-billing';

function recorded(workspaceId, kind = 'gh-billing') {
  const written = store.recordFounderAction({ workspaceId, kind, fields: FIELDS, evidence: EVIDENCE });
  if (!written.ok) throw new Error(`the fixture record was refused: ${JSON.stringify(written.faults)}`);
  return written.record;
}

// ─── 1. One door in ───────────────────────────────────────────

console.log('1. one door in, and the store is where the item id is kept');

check('src/core/founder-publish.ts is built', publishModule !== null,
      'dist/core/founder-publish.js is not there');
check('it exports publishFounderAction', typeof publishModule?.publishFounderAction === 'function',
      `it is ${typeof publishModule?.publishFounderAction}`);

const publishSource = existsSync(join(repoRoot, 'src', 'core', 'founder-publish.ts'))
  ? readFileSync(join(repoRoot, 'src', 'core', 'founder-publish.ts'), 'utf8')
  : '';
check('and the module is written', publishSource.length > 0, 'src/core/founder-publish.ts is not there');
check('the record is marked published through a store door rather than by hand',
      typeof store?.markFounderActionPublished === 'function',
      `it is ${typeof store?.markFounderActionPublished}`);

// ─── 2. One item-create, and the body is the composer's ───────

console.log('\n2. one draft item, carrying the title and the composer\'s own body');

const record = recorded('publishes');
const expectedBody = renderFounderAction(FIELDS, EVIDENCE);

control({ newItemId: 'PVTI_first' });
const before = mark();
const published = await said(() => publishFounderAction(workspaceOf('publishes'), record));
const calls = since(before);

check('publishing answered the item id GitHub made', published.value === 'PVTI_first',
      `${JSON.stringify(published.value)}${published.threw ? ` (threw: ${published.threw.message})` : ''}`);
check('exactly one item-create was spawned', creates(calls).length === 1,
      `${creates(calls).length} of ${calls.length} call(s): ${JSON.stringify(calls.map((args) => args.slice(0, 2)))}`);

const create = creates(calls)[0] ?? [];
check('it names the project number and the owner',
      create.includes('5') && valueOf(create, '--owner') === 'someone',
      JSON.stringify(create.slice(0, 6)));
check('the title is the record\'s own', valueOf(create, '--title') === FIELDS.title,
      JSON.stringify(valueOf(create, '--title')));
check('and the body is byte-identical to what the composer renders',
      valueOf(create, '--body') === expectedBody,
      `${JSON.stringify(String(valueOf(create, '--body')).slice(0, 120))} — ${expectedBody.length} characters expected, `
      + `${String(valueOf(create, '--body')).length} arrived`);
check('the evidence survived intact, apostrophe, dollar and backtick alike',
      String(valueOf(create, '--body')).includes(EVIDENCE.said),
      JSON.stringify(String(valueOf(create, '--body')).slice(-160)));
check('and nothing in it was ever run as a command',
      !calls.some((args) => args.some((arg) => arg === 'pwned' || arg === 'whoami')),
      JSON.stringify(calls.map((args) => args[0])));
check('it asks for the answer as JSON, which is where the id comes from',
      create.includes('--format') && valueOf(create, '--format') === 'json',
      JSON.stringify(create));

check('the draft was moved into the founder column by its option id',
      edits(calls).length === 1 && valueOf(edits(calls)[0] ?? [], '--single-select-option-id') === OPTION.founder,
      JSON.stringify(edits(calls)[0]));
check('naming the item that was just created',
      valueOf(edits(calls)[0] ?? [], '--id') === 'PVTI_first', JSON.stringify(edits(calls)[0]));
check('and the project and field the read resolved',
      valueOf(edits(calls)[0] ?? [], '--project-id') === 'PVT_project5'
      && valueOf(edits(calls)[0] ?? [], '--field-id') === 'PVTSSF_field5',
      JSON.stringify(edits(calls)[0]));

check('the item id is written onto the record',
      store.readFounderAction('publishes', KEY)?.publishedItemId === 'PVTI_first',
      JSON.stringify(store.readFounderAction('publishes', KEY)?.publishedItemId));
check('and nothing else about the record moved',
      store.readFounderAction('publishes', KEY)?.state === 'open'
      && store.readFounderAction('publishes', KEY)?.createdAt === record.createdAt,
      JSON.stringify(store.readFounderAction('publishes', KEY)?.state));

// ─── 3. The queue cannot start what was published ─────────────

console.log('\n3. the queue cannot start the draft, and it does start the issue beside it');

const boardWithDraft = boardModule.toBoard(project(5, {
  nodes: [
    ...ORDINARY,
    draftItem('PVTI_first', { option: OPTION.founder, createdAt: day(1), title: FIELDS.title }),
    // The hazard: `moveCard` has no per-column policy, so a person can drag the published draft
    // into the column the queue drains. It must still be unstartable there.
    draftItem('PVTI_dragged', { option: OPTION.queue, createdAt: day(1), title: FIELDS.title }),
  ],
}), { cardLimit: 0, repo: REPO });

const founderSection = boardModule.findColumn(boardWithDraft, NAMED.founder);
const queueSection = boardModule.findColumn(boardWithDraft, NAMED.queue);

check('the published draft is on the board fixture at all',
      founderSection?.cards.some((card) => card.itemId === 'PVTI_first') === true,
      JSON.stringify(founderSection?.cards.map((card) => card.itemId)));
check('nothing in the founder column is startable',
      startableCards(founderSection?.cards ?? []).length === 0,
      JSON.stringify(startableCards(founderSection?.cards ?? []).map((card) => card.itemId)));
check('and not even when it has been dragged into the drained column',
      startableCards(queueSection?.cards ?? []).every((card) => card.itemId !== 'PVTI_dragged'),
      JSON.stringify(startableCards(queueSection?.cards ?? []).map((card) => card.itemId)));
check('while the ordinary issue beside it still starts — so this is not a vacuous claim',
      startableCards(queueSection?.cards ?? []).map((card) => card.itemId).join() === 'item-open',
      JSON.stringify(startableCards(queueSection?.cards ?? []).map((card) => card.itemId)));

// ─── 4. The suppression is a suppression ──────────────────────

console.log('\n4. with the suppression set, nothing is published and no gh runs at all');

const suppressedRecord = recorded('suppressed');
const beforeSuppressed = mark();
const suppressed = await said(() => publishFounderAction(workspaceOf('suppressed'), suppressedRecord));

check('it answers null', suppressed.value === null,
      `${JSON.stringify(suppressed.value)}${suppressed.threw ? ` (threw: ${suppressed.threw.message})` : ''}`);
check('and no process was spawned at all — not even the read',
      since(beforeSuppressed).length === 0,
      JSON.stringify(since(beforeSuppressed).map((args) => args.slice(0, 2))));
check('the record is still unpublished',
      store.readFounderAction('suppressed', 'suppressed:gh-billing')?.publishedItemId === undefined,
      JSON.stringify(store.readFounderAction('suppressed', 'suppressed:gh-billing')?.publishedItemId));
check('and the suppression is what the workspace read, unset everywhere else',
      workspaceOf('suppressed')?.projectFounderPublishOff === true
      && workspaceOf('publishes')?.projectFounderPublishOff !== true,
      `${workspaceOf('suppressed')?.projectFounderPublishOff} / ${workspaceOf('publishes')?.projectFounderPublishOff}`);

// ─── 5. No project, no process ────────────────────────────────

console.log('\n5. a board with no githubProject spawns nothing and stays canvas-only');

const canvasOnly = recorded('no-project');
const beforeCanvas = mark();
const nowhere = await said(() => publishFounderAction(workspaceOf('no-project'), canvasOnly));

check('it answers null', nowhere.value === null,
      `${JSON.stringify(nowhere.value)}${nowhere.threw ? ` (threw: ${nowhere.threw.message})` : ''}`);
check('nothing was spawned', since(beforeCanvas).length === 0,
      JSON.stringify(since(beforeCanvas).map((args) => args.slice(0, 2))));
check('the record is still there, and still unpublished',
      store.readFounderAction('no-project', 'no-project:gh-billing')?.publishedItemId === undefined
      && store.readFounderAction('no-project', 'no-project:gh-billing')?.state === 'open');

// ─── 6. Nobody turns anything on ──────────────────────────────

console.log('\n6. a board that names nothing publishes anyway');

const defaultRecord = recorded('default-named');
control({ newItemId: 'PVTI_default' });
const beforeDefault = mark();
const byDefault = await said(() => publishFounderAction(workspaceOf('default-named'), defaultRecord));
const defaultCalls = since(beforeDefault);

check('it published', byDefault.value === 'PVTI_default',
      `${JSON.stringify(byDefault.value)}${byDefault.threw ? ` (threw: ${byDefault.threw.message})` : ''}`);
check('with nothing turned on in its config',
      Object.keys(JSON.parse(readFileSync(join(workDir, 'default-named', 'board.config.json'), 'utf8')))
        .every((key) => !/founder/i.test(key)),
      readFileSync(join(workDir, 'default-named', 'board.config.json'), 'utf8'));
check('into the column GitHub calls Founder Actions',
      valueOf(edits(defaultCalls)[0] ?? [], '--single-select-option-id') === OPTION.founder,
      JSON.stringify(edits(defaultCalls)[0]));
check('and the renamed board of section 2 proves nothing keys on that string',
      NAMED.founder !== DEFAULT_NAMES.founder && published.value === 'PVTI_first');

// ─── 7. A project with no founder column ──────────────────────

console.log('\n7. a project whose options hold no founder column creates nothing and says which key would');

const noColumn = recorded('no-column');
const beforeNoColumn = mark();
const missing = await said(() => publishFounderAction(workspaceOf('no-column'), noColumn));
const noColumnCalls = since(beforeNoColumn);

check('it answers null', missing.value === null,
      `${JSON.stringify(missing.value)}${missing.threw ? ` (threw: ${missing.threw.message})` : ''}`);
check('nothing was created', creates(noColumnCalls).length === 0,
      JSON.stringify(noColumnCalls.map((args) => args.slice(0, 2))));
check('and nothing was edited either', edits(noColumnCalls).length === 0,
      JSON.stringify(noColumnCalls.map((args) => args.slice(0, 2))));
check('the warning names the key that would fix it', /projectFounderColumn/.test(missing.console),
      missing.console.trim() || '(nothing was said)');
check('and names the column it looked for', missing.console.includes(NAMED.founder),
      missing.console.trim() || '(nothing was said)');
check('the record is untouched',
      store.readFounderAction('no-column', 'no-column:gh-billing')?.publishedItemId === undefined);

// ─── 8. Never published twice ─────────────────────────────────

console.log('\n8. a record carrying an item id is never published again, restart or no restart');

const beforeSecond = mark();
const again = await said(() =>
  publishFounderAction(workspaceOf('publishes'), store.readFounderAction('publishes', KEY)));

check('it answers the id it already has', again.value === 'PVTI_first',
      `${JSON.stringify(again.value)}${again.threw ? ` (threw: ${again.threw.message})` : ''}`);
check('and creates nothing', creates(since(beforeSecond)).length === 0,
      JSON.stringify(since(beforeSecond).map((args) => args.slice(0, 2))));

// A stale record in a caller's hand is the same question asked the other way round: two
// producers can hold the record as it was before it was published, and the store is what knows.
const stale = { ...record };
delete stale.publishedItemId;
const beforeStale = mark();
const withStale = await said(() => publishFounderAction(workspaceOf('publishes'), stale));
check('a caller holding the record from before publication creates nothing either',
      creates(since(beforeStale)).length === 0,
      JSON.stringify(since(beforeStale).map((args) => args.slice(0, 2))));
check('and is told the id that is already on it', withStale.value === 'PVTI_first',
      JSON.stringify(withStale.value));

/**
 * The restart, in a child process.
 *
 * A cache-busting import would not do it: `founder-publish` imports `founder-store` under its own
 * URL, so a fresh copy of one would go on using the loaded copy of the other, and the map in
 * front of the file would answer from memory. A new process reads the record off the disk, which
 * is the only thing that says the id survived the server that wrote it.
 */
const restartPath = join(workDir, 'restart-probe.mjs');
writeFileSync(restartPath, `const store = await import(${url(built('founder-store'))});
const { publishFounderAction } = await import(${url(built('founder-publish'))});
const { loadWorkspaces } = await import(${url(built('workspaces'))});

const workspaces = await loadWorkspaces(${JSON.stringify(registryPath)});
const workspace = workspaces.find((candidate) => candidate.id === 'publishes');
const record = store.readFounderAction('publishes', ${JSON.stringify(KEY)});

let answered = null;
let threw = null;
try {
  answered = await publishFounderAction(workspace, record);
} catch (error) {
  threw = String(error && error.message);
}
process.stdout.write(JSON.stringify({
  answered, threw, read: record && record.publishedItemId,
}));
`, 'utf8');

const beforeRestart = mark();
const restart = await new Promise((resolve) => {
  const child = spawn(process.execPath, [restartPath], {
    cwd: workDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('close', (code) => {
    let parsed = null;
    try { parsed = JSON.parse(out); } catch { /* reported below */ }
    resolve({ code, parsed, out, err });
  });
});

check('the fresh process ran', restart.code === 0 && restart.parsed !== null,
      `exit ${restart.code}: ${(restart.err || restart.out).slice(0, 400)}`);
check('it read the published id off the disk', restart.parsed?.read === 'PVTI_first',
      JSON.stringify(restart.parsed?.read));
check('it published nothing', creates(since(beforeRestart)).length === 0,
      JSON.stringify(since(beforeRestart).map((args) => args.slice(0, 2))));
check('and answered the id that was already there',
      restart.parsed?.answered === 'PVTI_first' && restart.parsed?.threw === null,
      JSON.stringify(restart.parsed));

// ─── 9. A gh failure is non-fatal ─────────────────────────────

console.log('\n9. a gh that fails leaves the record unpublished and re-publishable');

const failing = recorded('publishes', 'gh-login');
const FAIL_KEY = 'publishes:gh-login';

control({ failCreate: true });
const beforeFailure = mark();
const failed = await said(() => publishFounderAction(workspaceOf('publishes'), failing));

check('something was said about it', /founder/i.test(failed.console) || failed.threw !== null,
      failed.console.trim() || '(nothing was said and nothing threw)');
check('it created nothing that stuck',
      store.readFounderAction('publishes', FAIL_KEY)?.publishedItemId === undefined,
      JSON.stringify(store.readFounderAction('publishes', FAIL_KEY)?.publishedItemId));
check('the record is still open and still there',
      store.readFounderAction('publishes', FAIL_KEY)?.state === 'open');
check('and gh really was asked', creates(since(beforeFailure)).length >= 1,
      JSON.stringify(since(beforeFailure).map((args) => args.slice(0, 2))));

control({ failCreate: false, newItemId: 'PVTI_second' });
const retried = await said(() => publishFounderAction(workspaceOf('publishes'), failing));
check('the next attempt publishes it', retried.value === 'PVTI_second',
      `${JSON.stringify(retried.value)}${retried.threw ? ` (threw: ${retried.threw.message})` : ''}`);
check('and the id lands on the record this time',
      store.readFounderAction('publishes', FAIL_KEY)?.publishedItemId === 'PVTI_second',
      JSON.stringify(store.readFounderAction('publishes', FAIL_KEY)?.publishedItemId));

// ─── 10. The option id comes from an uncapped read ────────────

console.log('\n10. twelve cards against a card limit of eight, and the column is still found');

const capped = recorded('capped');
control({ newItemId: 'PVTI_capped' });
const beforeCapped = mark();
const overCap = await said(() => publishFounderAction(workspaceOf('capped'), capped));
const cappedCalls = since(beforeCapped);

check('the workspace really does cap its board at eight', workspaceOf('capped')?.projectCardLimit === 8,
      String(workspaceOf('capped')?.projectCardLimit));
check('and the founder column really does hold more than that', TWELVE.length > 8, `${TWELVE.length}`);
check('it published anyway', overCap.value === 'PVTI_capped',
      `${JSON.stringify(overCap.value)}${overCap.threw ? ` (threw: ${overCap.threw.message})` : ''}`);
check('into the founder column',
      valueOf(edits(cappedCalls)[0] ?? [], '--single-select-option-id') === OPTION.founder,
      JSON.stringify(edits(cappedCalls)[0]));
// The behaviour above cannot tell a capped read from an uncapped one today — the cap hides
// *cards*, and the option ids are the field's. The read is uncapped so that it stays true when a
// caller asks the board about a card, which is how #199/#200 stranded one; that is a property of
// the source, so it is read as one.
check('and the read that resolved it asks for every card', /cardLimit:\s*0/.test(publishSource),
      'readProjectBoard is called without { cardLimit: 0 }');

// ─── 11. The whole log ────────────────────────────────────────

console.log('\n11. across every call this run made, nothing filed an issue and nothing moved a card into the queue');

const everything = ghCalls();
const flat = everything.map((args) => args.join(' '));

check('there is a log to read at all', everything.length > 0, `${everything.length} call(s)`);
check('no gh issue create, anywhere',
      !everything.some((args) => args[0] === 'issue' && args[1] === 'create'),
      JSON.stringify(flat.filter((line) => /issue create/.test(line))));
check('no gh project item-add, anywhere',
      !everything.some((args) => args[0] === 'project' && args[1] === 'item-add'),
      JSON.stringify(flat.filter((line) => /item-add/.test(line))));
check('no item-edit naming the column the queue drains',
      !edits(everything).some((args) => args.includes(OPTION.queue)),
      JSON.stringify(edits(everything).filter((args) => args.includes(OPTION.queue))));
check('none naming the in-progress column either',
      !edits(everything).some((args) => args.includes(OPTION.doing)),
      JSON.stringify(edits(everything).filter((args) => args.includes(OPTION.doing))));
check('every item-edit this run made named the founder column',
      edits(everything).length > 0
      && edits(everything).every((args) => args.includes(OPTION.founder)),
      `${edits(everything).length} edit(s)`);
check('and every draft created was created with item-create',
      creates(everything).length > 0
      && creates(everything).every((args) => args.includes('--title') && args.includes('--body')),
      `${creates(everything).length} create(s)`);

// ─── Teardown ─────────────────────────────────────────────────
//
// Inside a try/catch: a removal that fails is a Windows file lock on a temporary directory, and a
// green run must not be turned red by one (`scripts/lib/teardown-scan.mjs`).

try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp directory */ }

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
