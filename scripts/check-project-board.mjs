#!/usr/bin/env node
/**
 * Checks the GitHub project mirror.
 *
 * The mirror's whole claim is that it is *derived*: the columns are whatever single-select
 * options the project has, not a list written here, and a card's column is whatever GitHub
 * says it is. So the cases that matter are the ones where a constant would still pass the
 * happy path — a fourth option appearing, an item with no status, an item whose column has
 * to be written back.
 *
 * Self-contained: it writes a stub `gh`, starts its own canvas server against a throwaway
 * workspace, and kills both. Nothing here talks to GitHub, and nothing needs a browser.
 * Run `./node_modules/.bin/tsc` first — the offline half reads the compiled modules.
 *
 * Usage: node scripts/check-project-board.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    console.error('        (the project board mirror is not built yet; run tsc if it is)');
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

// ─── Fixtures ─────────────────────────────────────────────────
//
// Shaped like the real `gh api graphql` answer, because that is what the reader parses.
// Verified against project 5: options carry ids, an item's column arrives as
// fieldValueByName.optionId, and items come back in POSITION order rather than by date.

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

function item(id, { number, title, createdAt, option, type = 'Issue', state = 'OPEN' }) {
  return {
    id,
    type: type === 'Issue' ? 'ISSUE' : 'PULL_REQUEST',
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

/** A project payload. `options` is what makes a fourth column appear with no code change. */
function payload({ options = [TODO, DOING, DONE], items = DEFAULT_ITEMS, hasNextPage = false } = {}) {
  return {
    data: {
      owner: {
        projectV2: {
          id: 'PVT_kwHOBVSHIs4BefUS',
          title: 'mcp_excalidraw',
          url: 'https://github.com/users/vitorengers/projects/5',
          field: { id: 'PVTSSF_status', name: 'Status', options },
          items: { pageInfo: { hasNextPage }, nodes: items },
        },
      },
    },
  };
}

// Deliberately out of date order, and out of number order, so a reader that just keeps
// GitHub's own ordering cannot pass.
const DEFAULT_ITEMS = [
  item('PVTI_old', { number: 3, title: 'Oldest todo', createdAt: '2026-07-01T10:00:00Z', option: TODO }),
  item('PVTI_new', { number: 21, title: 'Newest todo', createdAt: '2026-07-20T10:00:00Z', option: TODO }),
  item('PVTI_mid', { number: 12, title: 'Middle todo', createdAt: '2026-07-10T10:00:00Z', option: TODO }),
  item('PVTI_doing', { number: 9, title: 'Being worked on', createdAt: '2026-07-05T10:00:00Z', option: DOING }),
  item('PVTI_done', { number: 1, title: 'Finished', createdAt: '2026-06-01T10:00:00Z', option: DONE }),
  item('PVTI_pr', { number: 4, title: 'A pull request', createdAt: '2026-07-18T10:00:00Z', option: DOING, type: 'PullRequest' }),
  item('PVTI_nostatus', { number: 30, title: 'Never triaged', createdAt: '2026-07-22T10:00:00Z', option: null }),
];

// ─── 1. Reading the project ───────────────────────────────────

console.log('1. sections come from the project, not from a list written here');

const board = await importDist(join('core', 'project-board.js'), 'the project board reader');
const { toBoard, parseProjectUrl, buildMoveArgs, NO_STATUS_OPTION_ID } = board;

const three = toBoard(payload(), { repo: 'vitorengers/mcp_excalidraw' });
check('one section per single-select option',
      three.sections.filter((section) => section.optionId !== NO_STATUS_OPTION_ID).length === 3,
      `got ${three.sections.map((s) => s.name).join(', ')}`);
check('named after the options', ['Todo', 'In Progress', 'Done'].every(
        (name) => three.sections.some((section) => section.name === name)),
      three.sections.map((s) => s.name).join(', '));
check('in the order the project declares them',
      three.sections[0]?.name === 'Todo' && three.sections[1]?.name === 'In Progress',
      three.sections.map((s) => s.name).join(', '));
check('the field the sections came from is reported back',
      three.fieldId === 'PVTSSF_status' && three.fieldName === 'Status',
      `${three.fieldName}/${three.fieldId}`);

console.log('\n2. a fourth option on GitHub becomes a fourth section, with no edit here');
const BLOCKED = { id: 'aa11bb22', name: 'Blocked' };
const four = toBoard(payload({ options: [TODO, DOING, BLOCKED, DONE] }), {});
check('four sections now', four.sections.filter((s) => s.optionId !== NO_STATUS_OPTION_ID).length === 4,
      four.sections.map((s) => s.name).join(', '));
check('the new one is where GitHub put it', four.sections[2]?.name === 'Blocked',
      four.sections.map((s) => s.name).join(', '));
check('and it carries the option id, so a card can be moved into it',
      four.sections[2]?.optionId === 'aa11bb22');

console.log('\n3. newest issue on top, which is not the order GitHub returns');
const todo = three.sections.find((section) => section.name === 'Todo');
check('Todo holds its three cards', todo?.cards.length === 3, `got ${todo?.cards.length}`);
check('newest first', todo?.cards.map((card) => card.title).join(' | ') === 'Newest todo | Middle todo | Oldest todo',
      todo?.cards.map((card) => card.title).join(' | '));

console.log('\n4. an item with no status is shown, not dropped');
const noStatus = three.sections.find((section) => section.optionId === NO_STATUS_OPTION_ID);
check('a No Status section exists', Boolean(noStatus), 'the untriaged item vanished');
check('holding the untriaged item', noStatus?.cards[0]?.title === 'Never triaged');
check('and it is last', three.sections[three.sections.length - 1]?.optionId === NO_STATUS_OPTION_ID);
check('a project where everything has a status grows no such section',
      !toBoard(payload({ items: DEFAULT_ITEMS.filter((node) => node.fieldValueByName) }), {})
        .sections.some((section) => section.optionId === NO_STATUS_OPTION_ID));

console.log('\n5. only issues are draggable; a pull request rides along read-only');
const doing = three.sections.find((section) => section.name === 'In Progress');
const pr = doing?.cards.find((card) => card.contentType === 'PullRequest');
check('the pull request is on the board', Boolean(pr));
check('but it cannot be dragged', pr?.draggable === false);
check('the issue beside it can', doing?.cards.find((card) => card.contentType === 'Issue')?.draggable === true);

console.log('\n6. the cap is reported, not silently applied');
const capped = toBoard(payload(), { cardLimit: 2 });
const cappedTodo = capped.sections.find((section) => section.name === 'Todo');
check('only the newest two survive', cappedTodo?.cards.length === 2, `got ${cappedTodo?.cards.length}`);
check('and it says how many it left out', cappedTodo?.hidden === 1, `hidden=${cappedTodo?.hidden}`);
check('the ones kept are the newest', cappedTodo?.cards[0]?.title === 'Newest todo');

console.log('\n7. the project URL resolves to an owner and a number');
check('a user project', JSON.stringify(parseProjectUrl('https://github.com/users/vitorengers/projects/5'))
      === JSON.stringify({ ownerType: 'user', login: 'vitorengers', number: 5 }));
check('an organisation project',
      parseProjectUrl('https://github.com/orgs/acme/projects/12')?.ownerType === 'organization');
check('anything else is refused', parseProjectUrl('https://example.com/board') === null);
check('so is an owner that could not survive a command line',
      parseProjectUrl('https://github.com/users/a;rm -rf b/projects/5') === null);

console.log('\n8. a move is written back as an item-edit on the same field');
const args = buildMoveArgs({
  projectId: 'PVT_kwHOBVSHIs4BefUS',
  fieldId: 'PVTSSF_status',
  itemId: 'PVTI_new',
  optionId: DOING.id,
});
const joined = args.join(' ');
check('it edits the item', joined.includes('project item-edit'), joined);
check('naming the item', joined.includes('--id PVTI_new'), joined);
check('the project', joined.includes('--project-id PVT_kwHOBVSHIs4BefUS'), joined);
check('the field the sections came from', joined.includes('--field-id PVTSSF_status'), joined);
check('and the option to land on', joined.includes(`--single-select-option-id ${DOING.id}`), joined);

// ─── 2. Laying it out on the canvas ───────────────────────────

console.log('\n9. the mirror renders as real elements, marked as a mirror');
const layoutModule = await importDist(join('core', 'project-board-layout.js'), 'the project board layout');
const { layoutBoard, boardWidth, MIRROR_KIND } = layoutModule;

const laid = layoutBoard(three, { x: -1200, y: 0 });
check('every element is marked as mirror', laid.elements.length > 0
      && laid.elements.every((element) => element.customData?.kind === MIRROR_KIND),
      `${laid.elements.filter((e) => e.customData?.kind !== MIRROR_KIND).length} unmarked`);
const headers = laid.elements.filter((element) => element.customData?.role === 'section');
check('one header per section', headers.length === three.sections.length, `got ${headers.length}`);
check('headers are locked', headers.every((element) => element.locked === true));
const cards = laid.elements.filter((element) => element.customData?.role === 'card');
check('every card carries its item and its column',
      cards.length > 0 && cards.every((element) =>
        typeof element.customData?.itemId === 'string' && typeof element.customData?.sectionOptionId === 'string'),
      `${cards.length} card(s)`);
check('a pull request card is locked, an issue card is not',
      cards.some((element) => element.locked === true) && cards.some((element) => element.locked !== true));
check('cards sit in their own column',
      three.sections.every((section, index) => {
        const columnCards = cards.filter((card) => card.customData.sectionOptionId === section.optionId);
        return columnCards.every((card) => card.x === laid.columns[index].x);
      }));
check('within a column they go top-down in the order the section holds them', (() => {
  const first = three.sections[0];
  const columnCards = cards.filter((card) => card.customData.sectionOptionId === first.optionId);
  const byItem = new Map(columnCards.map((card) => [card.customData.itemId, card.y]));
  return first.cards.every((card, index) =>
    index === 0 || byItem.get(card.itemId) > byItem.get(first.cards[index - 1].itemId));
})());
check('the mirror stays within the width it reserved',
      laid.elements.every((element) => element.x >= -1200 - 1
        && element.x + (element.width ?? 0) <= -1200 + boardWidth(three.sections.length) + 1),
      `width=${boardWidth(three.sections.length)}`);
check('the whole mirror carries a docKey, so the region can explain itself',
      laid.elements.some((element) => element.customData?.docKey === 'project-board'));

console.log('\n10. a failed move is visible on the card that failed');
const withError = layoutBoard(three, { x: 0, y: 0 }, { errors: { PVTI_new: 'gh said no' } });
const failedCard = withError.elements.find((element) => element.customData?.itemId === 'PVTI_new'
  && element.customData?.role === 'card');
const failedLabel = withError.elements.find((element) => element.containerId === failedCard?.id);
check('the message is on the card', /gh said no/.test(failedLabel?.text ?? ''), failedLabel?.text);
check('and the card is marked failed', failedCard?.customData?.moveError === 'gh said no');

// ─── 3. The endpoints ─────────────────────────────────────────

const workDir = join(tmpdir(), `check-project-board-${process.pid}`);
const stubPath = join(workDir, 'stub-gh.mjs');
const fixturePath = join(workDir, 'fixture.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');
const projectDir = join(workDir, 'mirror-check');

mkdirSync(projectDir, { recursive: true });

/**
 * A `gh` that answers from a file.
 *
 * The file is what the check rewrites between requests, which is how "a fourth option
 * appears with no code change" gets tested end to end rather than only in the mapper.
 */
writeFileSync(stubPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else if (args.includes('item-edit')) {
  if (process.env.STUB_GH_FAIL_MOVE) {
    process.stderr.write('could not update the item\\n');
    process.exit(1);
  }
  process.stdout.write('{}\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

writeFileSync(fixturePath, JSON.stringify(payload()), 'utf8');
writeFileSync(logPath, '', 'utf8');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'mirror-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Mirror Check',
  repo: 'vitorengers/mcp_excalidraw',
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const running = [];

function startCanvas(port, host) {
  const child = spawnCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
      STUB_GH_FIXTURE: fixturePath,
      STUB_GH_LOG: logPath,
    },
  }).child;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

function stopAll() {
  for (const child of running) {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

try {
  const local = startCanvas(port, '127.0.0.1');
  await waitForHealth(BASE, local.child, local.read);

  console.log('\n11. the endpoint answers with the project, through gh');
  const read = await call('/api/project-board?workspace=mirror-check');
  check('200 OK', read.status === 200, `got ${read.status}: ${JSON.stringify(read.body).slice(0, 200)}`);
  check('three named sections plus No Status', read.body.board?.sections?.length === 4,
        `got ${read.body.board?.sections?.length}`);
  check('read through gh, not a new HTTP client',
        ghCalls().some((args) => args.includes('graphql')));
  check('asking for the configured field',
        ghCalls().some((args) => args.some((arg) => arg === 'field=Status')),
        JSON.stringify(ghCalls()[0] ?? []));

  console.log('\n12. a fourth option shows up on the next read, with nothing rebuilt');
  writeFileSync(fixturePath, JSON.stringify(payload({ options: [TODO, DOING, BLOCKED, DONE] })), 'utf8');
  const reread = await call('/api/project-board?workspace=mirror-check');
  check('five sections now', reread.body.board?.sections?.length === 5,
        (reread.body.board?.sections ?? []).map((s) => s.name).join(', '));
  check('Blocked among them', (reread.body.board?.sections ?? []).some((s) => s.name === 'Blocked'));
  writeFileSync(fixturePath, JSON.stringify(payload()), 'utf8');

  console.log('\n13. a board with no project configured stays dormant');
  const dormant = await call('/api/project-board?workspace=default');
  check('404, not an error page', dormant.status === 404, `got ${dormant.status}`);
  check('and it says why', /project/i.test(dormant.body.error ?? ''), dormant.body.error);

  console.log('\n14. a move is written back to GitHub');
  writeFileSync(logPath, '', 'utf8');
  const moved = await call('/api/project-board/move?workspace=mirror-check', {
    method: 'POST',
    body: JSON.stringify({ itemId: 'PVTI_new', optionId: DOING.id }),
  });
  check('200 OK', moved.status === 200, `got ${moved.status}: ${JSON.stringify(moved.body).slice(0, 200)}`);
  const edit = ghCalls().find((args) => args.includes('item-edit'));
  check('gh was asked to edit the item', Boolean(edit), JSON.stringify(ghCalls()));
  check('with the item id', (edit ?? []).includes('PVTI_new'), JSON.stringify(edit));
  check('and the option it was dropped on', (edit ?? []).includes(DOING.id), JSON.stringify(edit));
  check('against the field the sections came from', (edit ?? []).includes('PVTSSF_status'), JSON.stringify(edit));

  console.log('\n15. a move that GitHub refuses comes back as a failure');
  const rejected = await call('/api/project-board/move?workspace=mirror-check', {
    method: 'POST',
    body: JSON.stringify({ itemId: 'PVTI_new', optionId: 'not-an-option' }),
  });
  check('an unknown option is refused before gh is run', rejected.status === 400,
        `got ${rejected.status}`);

  console.log('\n16. the move route refuses to run off loopback');
  const remotePort = await freePort();
  const remote = startCanvas(remotePort, '0.0.0.0');
  const REMOTE_BASE = `http://127.0.0.1:${remotePort}`;
  await waitForHealth(REMOTE_BASE, remote.child, remote.read);
  const offLoopback = await fetch(`${REMOTE_BASE}/api/project-board/move?workspace=mirror-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: 'PVTI_new', optionId: DOING.id }),
  });
  check('403 Forbidden', offLoopback.status === 403, `got ${offLoopback.status}`);
  const offBody = await offLoopback.json().catch(() => ({}));
  check('and it says loopback', /loopback/i.test(offBody.error ?? ''), offBody.error);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  stopAll();
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
