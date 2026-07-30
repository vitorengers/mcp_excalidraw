#!/usr/bin/env node
/**
 * Checks that the project mirror reads every page, not the first one.
 *
 * The defect this exists for is silent by construction: below 100 items one page *is* the
 * project, so every case in `check-project-board.mjs` passes and goes on passing. At 101
 * the read starts truncating, and it truncates the **newest** items — the ones a research
 * run has just created — so the two writes and the queue read that `docs/project-board.md`
 * presents as guarantees all stop working on the cards that matter most.
 *
 * So the cases here are the ones a single-page reader passes and a paginating one does not:
 * an item that exists *only* on page two, asked for three times over — is it on the board,
 * can it be moved, and would the queue start it.
 *
 * Self-contained: it writes a stub `gh` that serves pages keyed on the cursor it is handed,
 * loads a throwaway workspace, and calls the reader in this process. No server, no browser
 * and no GitHub account. Run `./node_modules/.bin/tsc` first — it reads the compiled modules.
 *
 * Usage: node scripts/check-project-board-pagination.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ─── The workspace, the stub and the fixtures ─────────────────

const workDir = join(tmpdir(), `check-board-pagination-${process.pid}`);
const projectDir = join(workDir, 'paged-check');
const stubPath = join(workDir, 'stub-gh.mjs');
const controlPath = join(workDir, 'control.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

mkdirSync(projectDir, { recursive: true });

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

function item(id, { number, title, createdAt, option, type = 'Issue', state = 'OPEN' }) {
  return {
    id,
    fieldValueByName: option ? { optionId: option.id, name: option.name } : null,
    content: {
      __typename: type,
      number,
      title,
      url: `https://github.com/vitorengers/mcp_excalidraw/${type === 'Issue' ? 'issues' : 'pull'}/${number}`,
      createdAt,
      state,
      repository: { nameWithOwner: 'vitorengers/mcp_excalidraw' },
    },
  };
}

/**
 * One page of the answer.
 *
 * Shaped like the real `gh api graphql` reply, cursor and all. GitHub's cursors are opaque
 * base64, and these look like them on purpose: a reader that has to pass one back through a
 * command line has to survive what GitHub actually sends, `=` padding included.
 */
function page(items, { hasNextPage = false, endCursor = null } = {}) {
  return {
    data: {
      owner: {
        projectV2: {
          id: 'PVT_kwHOBVSHIs4BefUS',
          title: 'mcp_excalidraw',
          url: 'https://github.com/users/vitorengers/projects/5',
          field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
          items: { pageInfo: { hasNextPage, endCursor }, nodes: items },
        },
      },
    },
  };
}

const CURSOR_1 = 'Y3Vyc29yOnYyOpHOAAGZfw==';
const CURSOR_2 = 'Y3Vyc29yOnYyOpHOAAGaKA==';

// Page one is the project as a single-page reader sees it. Nothing on it is newer than
// anything on page two, which is the real shape: GitHub returns items in POSITION order and
// the newest cards are the ones that fall off the end.
const PAGE_ONE = [
  item('PVTI_done1', { number: 1, title: 'Finished long ago', createdAt: '2026-06-01T10:00:00Z', option: DONE }),
  item('PVTI_todo_old', { number: 12, title: 'Oldest waiting issue', createdAt: '2026-07-01T10:00:00Z', option: TODO }),
  item('PVTI_doing', { number: 40, title: 'Being worked on', createdAt: '2026-07-05T10:00:00Z', option: DOING }),
];

// Page two is where a project past 100 items puts what it just created. #199 is the card
// this whole check is about: on GitHub, in Todo, and invisible to a reader that stops at
// the first page.
const PAGE_TWO = [
  item('PVTI_todo_new', { number: 199, title: 'A fresh terminal block opens at the wrong grid', createdAt: '2026-07-28T23:23:40Z', option: TODO }),
  item('PVTI_done_new', { number: 218, title: 'Newest of all, and Done', createdAt: '2026-07-29T09:00:00Z', option: DONE }),
];

const PAGE_199_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/199';

/**
 * A `gh` that pages.
 *
 * It refuses a cursor it never issued rather than serving page one again: a reader that
 * loses the cursor would otherwise loop over the first page forever and look like it was
 * working. `runaway` is the other direction — a project that never ends, to prove the
 * reader stops on its own.
 */
writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const control = JSON.parse(readFileSync(process.env.STUB_GH_CONTROL, 'utf8'));

if (args.includes('item-edit')) {
  process.stdout.write('{}\\n');
  process.exit(0);
}
if (!args.includes('graphql')) {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}

const cursorArg = args.find((arg) => arg.startsWith('cursor='));
const cursor = cursorArg ? cursorArg.slice('cursor='.length) : null;

if (control.runaway) {
  // Every page has another page after it. The endCursor changes each time so a reader
  // cannot be caught out by repeating itself.
  const calls = readFileSync(process.env.STUB_GH_LOG, 'utf8').trim().split('\\n').filter(Boolean).length;
  process.stdout.write(JSON.stringify(control.runaway.page).replace(
    '"__RUNAWAY__"', JSON.stringify('Y3Vyc29yOnJ1bmF3YXk' + calls + '=')
  ));
  process.exit(0);
}

const index = cursor === null ? 0 : control.cursors.indexOf(cursor) + 1;
if (index <= 0 && cursor !== null) {
  process.stderr.write('stub gh: no such cursor: ' + cursor + '\\n');
  process.exit(1);
}
const body = control.pages[index];
if (!body) {
  process.stderr.write('stub gh: asked for page ' + index + ', which does not exist\\n');
  process.exit(1);
}
process.stdout.write(JSON.stringify(body));
`, 'utf8');

function control(value) {
  writeFileSync(controlPath, JSON.stringify(value), 'utf8');
}

/** Two pages, cursor-linked, as GitHub would serve them. */
const TWO_PAGES = {
  cursors: [CURSOR_1, CURSOR_2],
  pages: [
    page(PAGE_ONE, { hasNextPage: true, endCursor: CURSOR_1 }),
    page(PAGE_TWO, { hasNextPage: false, endCursor: CURSOR_2 }),
  ],
};

control(TWO_PAGES);
writeFileSync(logPath, '', 'utf8');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'paged-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Paged Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

// Set before the modules load: `GH_COMMAND` is read once, at import.
process.env.EXCALIDRAW_GH_COMMAND = `node "${stubPath.replace(/\\/g, '/')}"`;
process.env.STUB_GH_CONTROL = controlPath;
process.env.STUB_GH_LOG = logPath;
process.env.LOG_LEVEL = 'error';

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    console.error('        (run ./node_modules/.bin/tsc first)');
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const graphqlCalls = () => ghCalls().filter((args) => args.includes('graphql'));
const resetLog = () => writeFileSync(logPath, '', 'utf8');
const cursorsAsked = () => graphqlCalls()
  .map((args) => args.find((arg) => arg.startsWith('cursor=')) ?? null)
  .map((arg) => (arg === null ? null : arg.slice('cursor='.length)));

try {
  const boardModule = await importDist(join('core', 'project-board.js'), 'the project board reader');
  const queueModule = await importDist(join('core', 'implement-queue.js'), 'the implementation queue');
  const workspaceModule = await importDist(join('core', 'workspaces.js'), 'the workspace registry');
  const { buildProjectQuery, readProjectBoard, moveIssueToColumn, todoColumn, findColumn } = boardModule;
  const { startableCards } = queueModule;

  const workspaces = await workspaceModule.loadWorkspaces(registryPath);
  const workspace = workspaces.find((candidate) => candidate.id === 'paged-check');
  if (!workspace) throw new Error('the throwaway workspace did not load');
  if (workspace.error) throw new Error(`the throwaway workspace is unusable: ${workspace.error}`);

  console.log('1. the query can ask for a page other than the first');
  const query = buildProjectQuery('user');
  check('it declares a cursor variable', /\$cursor:\s*String/.test(query), query.slice(0, 120));
  check('and hands it to items(after:)', /items\(first:\s*\d+,\s*after:\s*\$cursor\)/.test(query),
        (query.match(/items\([^)]*\)/) ?? ['(no items call)'])[0]);
  check('asking for the cursor that reaches the next page',
        /pageInfo\s*{[^}]*endCursor/.test(query),
        (query.match(/pageInfo\s*{[^}]*}/) ?? ['(no pageInfo)'])[0]);

  console.log('\n2. an item only on page two is on the board');
  resetLog();
  const board = await readProjectBoard(workspace, { cardLimit: 0 });
  const cards = board.sections.flatMap((section) => section.cards);
  check('every item from both pages is there', cards.length === PAGE_ONE.length + PAGE_TWO.length,
        `got ${cards.length}: ${cards.map((card) => `#${card.number}`).join(' ')}`);
  check('#199 among them', cards.some((card) => card.number === 199),
        cards.map((card) => `#${card.number}`).join(' ') || '(nothing)');
  check('in the column GitHub put it in',
        findColumn(board, 'Todo')?.cards.some((card) => card.number === 199) === true,
        (findColumn(board, 'Todo')?.cards ?? []).map((card) => `#${card.number}`).join(' '));
  check('and the reader no longer claims cards are missing', board.morePages === false,
        `morePages=${board.morePages}`);

  console.log('\n3. it followed the cursor GitHub gave it');
  check('two reads, not one', graphqlCalls().length === 2, `made ${graphqlCalls().length}`);
  check('the first asks for no cursor', cursorsAsked()[0] === null, String(cursorsAsked()[0]));
  check('the second asks for the one page one ended on', cursorsAsked()[1] === CURSOR_1,
        String(cursorsAsked()[1]));

  console.log('\n4. the pages are one project, sorted together');
  const done = findColumn(board, 'Done');
  check('the newest card overall is at the head of its column, though it arrived last',
        done?.cards[0]?.number === 218, (done?.cards ?? []).map((card) => `#${card.number}`).join(' '));
  const todo = findColumn(board, 'Todo');
  check('and the column the queue drains still reads oldest first across both pages',
        todo?.cards.map((card) => card.number).join(' ') === '12 199',
        (todo?.cards ?? []).map((card) => `#${card.number}`).join(' '));

  console.log('\n5. a card off page one can be moved, which is what strands a note');
  resetLog();
  const landed = await moveIssueToColumn(workspace, PAGE_199_URL, {
    name: 'In Progress', setting: 'projectInProgressColumn',
  });
  check('the move happened', landed === 'In Progress', `returned ${JSON.stringify(landed)}`);
  const edit = ghCalls().find((args) => args.includes('item-edit'));
  check('gh was asked to edit that item', Boolean(edit), JSON.stringify(ghCalls()));
  check('naming the item from page two', (edit ?? []).includes('PVTI_todo_new'), JSON.stringify(edit));
  check('and the column it was sent to', (edit ?? []).includes(DOING.id), JSON.stringify(edit));

  console.log('\n6. and the queue would start it');
  const startable = startableCards(findColumn(board, todoColumn(workspace).name)?.cards ?? []);
  check('#199 is startable', startable.some((card) => card.number === 199),
        startable.map((card) => `#${card.number}`).join(' ') || '(nothing startable)');
  check('after the older card, which is the order the queue drains in',
        startable.map((card) => card.number).join(' ') === '12 199',
        startable.map((card) => `#${card.number}`).join(' '));

  console.log('\n7. a project that never ends does not spin gh forever');
  control({ runaway: { page: page(PAGE_ONE, { hasNextPage: true, endCursor: '__RUNAWAY__' }) } });
  resetLog();
  const truncated = await readProjectBoard(workspace, { cardLimit: 0 });
  const spins = graphqlCalls().length;
  check('it stops on its own', spins > 1 && spins <= 50, `made ${spins} reads`);
  check('keeping what it read', truncated.sections.flatMap((section) => section.cards).length > 0);
  check('and saying cards are missing, rather than drawing a whole board',
        truncated.morePages === true, `morePages=${truncated.morePages}`);

  console.log('\n8. a cursor that could not survive a command line is refused');
  control({
    cursors: ['ignored'],
    pages: [page(PAGE_ONE, { hasNextPage: true, endCursor: 'abc"; touch /tmp/pwned; echo "' })],
  });
  resetLog();
  const guarded = await readProjectBoard(workspace, { cardLimit: 0 });
  check('nothing was run with it',
        !ghCalls().some((args) => args.some((arg) => /touch |pwned/.test(arg))),
        JSON.stringify(ghCalls()));
  check('one read, then it stopped', graphqlCalls().length === 1, `made ${graphqlCalls().length}`);
  check('the page it did read is still a board',
        guarded.sections.flatMap((section) => section.cards).length === PAGE_ONE.length);
  check('and it says cards are missing', guarded.morePages === true, `morePages=${guarded.morePages}`);

  console.log('\n9. a mirror that is missing cards says so on the canvas, not only in the log');
  const layoutModule = await importDist(join('core', 'project-board-layout.js'), 'the project board layout');
  const { layoutBoard, MIRROR_KIND } = layoutModule;
  const titleOf = (value) => {
    const laid = layoutBoard(value, { x: 0, y: 0 });
    const strip = laid.elements.find((element) => element.customData?.role === 'title');
    const text = laid.elements.find((element) => element.containerId === strip?.id);
    return { strip, text: text?.text ?? '' };
  };
  const shortTitle = titleOf(truncated);
  check('the strip says the project has more', /the project has more/i.test(shortTitle.text),
        shortTitle.text);
  check('and how many it did draw', new RegExp(`\\b${
    truncated.sections.reduce((total, section) => total + section.cards.length + section.hidden, 0)
  }\\b`).test(shortTitle.text), shortTitle.text);
  check('the strip is marked, so the browser can find it without reading its label',
        shortTitle.strip?.customData?.truncated === true,
        JSON.stringify(shortTitle.strip?.customData));
  check('and it is still a mirror element like everything else',
        shortTitle.strip?.customData?.kind === MIRROR_KIND);
  // The sentence was one line to begin with, which fit by the estimate in `text-layout.ts`
  // and not in a browser: Excalidraw re-measured it wider and clipped both ends. These two
  // are what a browser cannot be asked about here — that it is *given* two lines, and that
  // the strip is tall enough to hold them.
  check('the notice is on a line of its own', shortTitle.text.split('\n').length === 2,
        JSON.stringify(shortTitle.text));
  check('above it, the title is what an untruncated board would say',
        shortTitle.text.split('\n')[0] === titleOf(board).text, JSON.stringify(shortTitle.text));
  check('and the strip grew to hold both', (shortTitle.strip?.height ?? 0) > 48,
        `height=${shortTitle.strip?.height}`);
  check('the columns moved down with it, rather than under it', (() => {
    const laid = layoutBoard(truncated, { x: 0, y: 0 });
    const strip = laid.elements.find((element) => element.customData?.role === 'title');
    const headers = laid.elements.filter((element) => element.customData?.role === 'section');
    return headers.length > 0 && headers.every((header) => header.y >= strip.y + strip.height);
  })());

  const wholeTitle = titleOf(board);
  check('a board that read the whole project says nothing of the sort',
        !/more/i.test(wholeTitle.text), wholeTitle.text);
  check('and its strip carries no mark', wholeTitle.strip?.customData?.truncated === undefined,
        JSON.stringify(wholeTitle.strip?.customData));

  console.log('\n10. a project that fits on one page still costs one read');
  control({ cursors: [], pages: [page([...PAGE_ONE, ...PAGE_TWO], { hasNextPage: false, endCursor: CURSOR_1 })] });
  resetLog();
  const small = await readProjectBoard(workspace, { cardLimit: 0 });
  check('one gh call', graphqlCalls().length === 1, `made ${graphqlCalls().length}`);
  check('no cursor asked for', cursorsAsked()[0] === null, String(cursorsAsked()[0]));
  check('and nothing is reported missing', small.morePages === false, `morePages=${small.morePages}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.stack ?? error.message}`);
} finally {
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed.`);
  process.exit(1);
}
console.log('All checks passed.');
