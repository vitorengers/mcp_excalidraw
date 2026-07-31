#!/usr/bin/env node
/**
 * Checks the path that carries `projectCardLimit` from a project's config to what is drawn.
 *
 * The setting has existed since the mirror did, and until #239 nothing had ever read it out
 * of a config file: `check-project-board.mjs` hands `cardLimit` to `toBoard` directly and
 * `check-project-board-pagination.mjs` only ever passes `0`, so the fallback at
 * `project-board.ts` — `options.cardLimit ?? workspace.projectCardLimit` — was reachable only
 * from the running server. A default of 12 that nobody had configured away looks exactly like
 * a cap that cannot be configured, which is the reading #239 opened with.
 *
 * So the cases are the two ends of that path and the wire between them: this repository's own
 * `board.config.json` says 8, a workspace loaded from a config file draws by what the file
 * says, and a file that says nothing still draws the documented default of 12.
 *
 * Self-contained: it writes a stub `gh`, loads throwaway workspaces from a throwaway registry,
 * and calls the reader in this process. No server, no browser and no GitHub account.
 * Run `./node_modules/.bin/tsc` first — it reads the compiled modules.
 *
 * Usage: node scripts/check-project-card-limit.mjs
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

// ─── The workspaces, the stub and the fixture ─────────────────

const workDir = join(tmpdir(), `check-card-limit-${process.pid}`);
const stubPath = join(workDir, 'stub-gh.mjs');
const payloadPath = join(workDir, 'payload.json');
const registryPath = join(workDir, 'workspaces.json');

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

/**
 * The board as project 5 actually stands: 116 in Done, one in In Progress, Todo empty.
 *
 * The numbers are the issue's, not an invented shape — 116 is what
 * `gh project item-list 5` reported, and it is the number the header has to keep printing
 * whatever the cap does to the cards underneath it.
 */
const DONE_ITEMS = 116;

function item(id, { number, title, createdAt, option, type = 'Issue', state = 'CLOSED' }) {
  return {
    id,
    fieldValueByName: option ? { optionId: option.id, name: option.name } : null,
    content: {
      __typename: type,
      number,
      title,
      url: `https://github.com/vitorengers/vibemaxxing/${type === 'Issue' ? 'issues' : 'pull'}/${number}`,
      createdAt,
      state,
      repository: { nameWithOwner: 'vitorengers/vibemaxxing' },
    },
  };
}

// Newest last, so a reader that forgets to sort is caught by which cards survive the cap
// rather than only by how many.
const ITEMS = [
  ...Array.from({ length: DONE_ITEMS }, (_, index) =>
    item(`PVTI_done_${index}`, {
      number: 100 + index,
      title: `Landed #${100 + index}`,
      // One a day, ascending, so "the newest N" is a list this check can write down.
      createdAt: `2026-0${1 + Math.floor(index / 31)}-${String((index % 31) + 1).padStart(2, '0')}T10:00:00Z`,
      option: DONE,
    })),
  item('PVTI_doing', {
    number: 239,
    title: 'The Done column draws 12 cards, not 8',
    createdAt: '2026-07-30T10:00:00Z',
    option: DOING,
    state: 'OPEN',
  }),
];

const NEWEST_DONE = [...ITEMS]
  .filter((node) => node.fieldValueByName?.optionId === DONE.id)
  .sort((left, right) => right.content.createdAt.localeCompare(left.content.createdAt))
  .map((node) => node.content.number);

mkdirSync(workDir, { recursive: true });

writeFileSync(payloadPath, JSON.stringify({
  data: {
    owner: {
      projectV2: {
        id: 'PVT_kwHOBVSHIs4BefUS',
        title: 'mcp_excalidraw',
        url: 'https://github.com/users/vitorengers/projects/5',
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
        items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: ITEMS },
      },
    },
  },
}), 'utf8');

// One answer, whatever it is asked. Nothing here is about paging; that is #206's check.
writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
process.stdout.write(readFileSync(process.env.STUB_GH_PAYLOAD, 'utf8'));
`, 'utf8');

/** A project directory whose `board.config.json` is exactly what this case is about. */
function workspaceDir(id, config) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: id,
    repo: 'vitorengers/vibemaxxing',
    githubProject: 'https://github.com/users/vitorengers/projects/5',
    ...config,
  }, null, 2), 'utf8');
  return dir;
}

const CASES = [
  { id: 'says-eight', config: { projectCardLimit: 8 }, draws: 8 },
  // Not 8, and not the default either: the drawn count has to follow the file rather than
  // any constant in the code, or this check would pass against a hard-coded 8.
  { id: 'says-five', config: { projectCardLimit: 5 }, draws: 5 },
  { id: 'says-nothing', config: {}, draws: null },
  // 0 is how every uncapped reader — the queue, a drag, a move — asks for the whole column.
  { id: 'says-zero', config: { projectCardLimit: 0 }, draws: DONE_ITEMS },
];

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    // The real project, read through the real loader: the file this issue edits.
    { id: 'this-repo', path: repoRoot.replace(/\\/g, '/') },
    ...CASES.map((one) => ({
      id: one.id,
      path: workspaceDir(one.id, one.config).replace(/\\/g, '/'),
    })),
  ],
}), 'utf8');

// Set before the modules load: `GH_COMMAND` is read once, at import.
process.env.EXCALIDRAW_GH_COMMAND = `node "${stubPath.replace(/\\/g, '/')}"`;
process.env.STUB_GH_PAYLOAD = payloadPath;
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

try {
  const boardModule = await importDist(join('core', 'project-board.js'), 'the project board reader');
  const layoutModule = await importDist(join('core', 'project-board-layout.js'), 'the project board layout');
  const workspaceModule = await importDist(join('core', 'workspaces.js'), 'the workspace registry');
  const { readProjectBoard, findColumn, DEFAULT_CARD_LIMIT } = boardModule;
  const { layoutBoard } = layoutModule;

  const workspaces = await workspaceModule.loadWorkspaces(registryPath);
  const byId = (id) => {
    const found = workspaces.find((candidate) => candidate.id === id);
    if (!found) throw new Error(`the throwaway workspace "${id}" did not load`);
    return found;
  };

  console.log('1. this board asks for eight, in the file the board is configured by');
  const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
  check('board.config.json carries projectCardLimit', 'projectCardLimit' in config,
        `keys: ${Object.keys(config).join(', ')}`);
  check('and it is 8', config.projectCardLimit === 8, `got ${JSON.stringify(config.projectCardLimit)}`);
  check('the loader reads it back off disk', byId('this-repo').projectCardLimit === 8,
        `got ${JSON.stringify(byId('this-repo').projectCardLimit)}`);
  check('which is not the documented default, or the setting would prove nothing',
        DEFAULT_CARD_LIMIT !== 8, `DEFAULT_CARD_LIMIT=${DEFAULT_CARD_LIMIT}`);

  console.log('\n2. so the column this board draws is eight cards deep');
  const board = await readProjectBoard(byId('this-repo'));
  const done = findColumn(board, 'Done');
  check('Done draws 8', done?.cards.length === 8, `drew ${done?.cards.length}`);
  check('and counts the rest as hidden, rather than dropping them',
        done?.hidden === DONE_ITEMS - 8, `hidden=${done?.hidden}`);
  check('the eight are the newest, which is what the cap is applied after',
        done?.cards.map((card) => card.number).join(' ') === NEWEST_DONE.slice(0, 8).join(' '),
        (done?.cards ?? []).map((card) => `#${card.number}`).join(' '));
  check('a column under the cap is untouched',
        findColumn(board, 'In Progress')?.cards.length === 1
        && findColumn(board, 'In Progress')?.hidden === 0,
        `${findColumn(board, 'In Progress')?.cards.length} card(s), ` +
        `${findColumn(board, 'In Progress')?.hidden} hidden`);

  console.log('\n3. and the header still prints the whole project, not the eight');
  const laid = layoutBoard(board, { x: 0, y: 0 });
  const headers = laid.elements
    .filter((element) => element.customData?.role === 'section')
    .map((element) => laid.elements.find((child) => child.containerId === element.id)?.text ?? '');
  check(`Done reads "Done (${DONE_ITEMS}, ${DONE_ITEMS - 8} hidden)"`,
        headers.includes(`Done (${DONE_ITEMS}, ${DONE_ITEMS - 8} hidden)`), headers.join(' | '));
  check('the total is the project\'s, so nothing was lost by capping',
        (done?.cards.length ?? 0) + (done?.hidden ?? 0) === DONE_ITEMS,
        `${done?.cards.length} + ${done?.hidden}`);

  console.log('\n4. the number drawn is the file\'s, not a constant');
  for (const one of CASES) {
    const expected = one.draws ?? DEFAULT_CARD_LIMIT;
    const drawn = findColumn(await readProjectBoard(byId(one.id)), 'Done');
    check(`${JSON.stringify(one.config)} draws ${expected}`, drawn?.cards.length === expected,
          `drew ${drawn?.cards.length}`);
    check(`  and hides ${DONE_ITEMS - expected}`, drawn?.hidden === DONE_ITEMS - expected,
          `hidden=${drawn?.hidden}`);
  }

  console.log('\n5. an explicit cardLimit still wins, which is how the queue reads uncapped');
  const uncapped = findColumn(await readProjectBoard(byId('this-repo'), { cardLimit: 0 }), 'Done');
  check('cardLimit 0 lifts the configured 8', uncapped?.cards.length === DONE_ITEMS,
        `drew ${uncapped?.cards.length}`);
  check('and nothing is reported hidden', uncapped?.hidden === 0, `hidden=${uncapped?.hidden}`);
  const three = findColumn(await readProjectBoard(byId('this-repo'), { cardLimit: 3 }), 'Done');
  check('a caller asking for 3 gets 3, over the file\'s 8', three?.cards.length === 3,
        `drew ${three?.cards.length}`);
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
