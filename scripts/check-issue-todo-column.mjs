#!/usr/bin/env node
/**
 * Checks that a finished research run moves the issue it created into the Todo column.
 *
 * A hand-written block is drafted in the notes column — the canvas's own since #97, and not
 * on the project at all — and the issue the agent then creates arrives wherever the
 * project's *Item added to project* workflow puts it. Nothing moved it out. Which column
 * that is, is decided entirely outside this repository: the workflow's configuration is not
 * exposed by the API, so no check could assert it and no comment here may claim to know it.
 * Without this move, "researched" and "not researched yet" are wherever that workflow left
 * them and only a person can tell them apart.
 *
 * The write belongs to the **server**, for the same reason the In Progress move does
 * (`check-implement-in-progress.mjs`): an agent is the one participant that cannot report
 * its own crash, and putting a project URL, a field name and a column name into a prompt
 * whose whole design is to carry none of them would be the wrong place for it twice over.
 *
 * So the cases here are about the server: one `item-edit` per finished run, the column
 * resolved from the project rather than guessed, a failed run moving nothing — and, the half
 * that matters more, a board write that fails costing the run nothing at all. The block still
 * reads `created`, and the route still answered 202 long before any of this ran.
 *
 * Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas server
 * against throwaway workspaces, and kills both. Nothing here talks to GitHub, nothing runs a
 * real coding agent, and nothing needs a browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-issue-todo-column.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const typesPath = join(repoRoot, 'dist', 'core', 'project-board-types.js');
if (!existsSync(typesPath)) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-types.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { NOTES_OPTION_ID } = await import(pathToFileURL(typesPath).href);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Fixtures ─────────────────────────────────────────────────
//
// Shaped like the real `gh api graphql` answer, because that is what the reader parses.
//
// `Scratch` is where the fixture's new items sit, standing in for whatever a project's
// *Item added to project* workflow chose — which this code cannot read, and which is what
// makes this move necessary rather than decorative. It is deliberately *not* the column
// this repository would want them in, and deliberately not called `My Notes`: that name now
// belongs to the canvas's own column, which is not a `Status` option anywhere.
// `Icebox` exists only so a workspace can name a column *other* than the fallback and be
// believed: a check where the configured name and the default are the same column cannot
// tell the two apart.

const SCRATCH = { id: 'aa000001', name: 'Scratch' };
const TODO = { id: 'f75ad846', name: 'Todo' };
const ICEBOX = { id: 'bb000002', name: 'Icebox' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const REPO = 'vitorengers/vibemaxxing';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;

function item(id, { number, option }) {
  return {
    id,
    fieldValueByName: option ? { optionId: option.id, name: option.name } : null,
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: issueUrl(number),
      createdAt: '2026-07-20T10:00:00Z',
      state: 'OPEN',
      repository: { nameWithOwner: REPO },
    },
  };
}

/**
 * One card per case, so no two cases can be confused for one another.
 *
 * Every one of them sits in `Scratch`, standing in for wherever the project's own workflow
 * left the issue the run created. `PVTI_settled` is the exception, already in Todo, for the
 * case where there is nothing to write.
 */
const ITEMS = [
  item('PVTI_default', { number: 31, option: SCRATCH }),
  item('PVTI_named', { number: 32, option: SCRATCH }),
  item('PVTI_missing', { number: 33, option: SCRATCH }),
  item('PVTI_ghfails', { number: 35, option: SCRATCH }),
  item('PVTI_noproject', { number: 36, option: SCRATCH }),
  item('PVTI_failedrun', { number: 37, option: SCRATCH }),
  item('PVTI_settled', { number: 38, option: TODO }),
];

const PAYLOAD = {
  data: {
    owner: {
      projectV2: {
        id: 'PVT_kwHOBVSHIs4BefUS',
        title: 'mcp_excalidraw',
        url: 'https://github.com/users/vitorengers/projects/5',
        field: {
          id: 'PVTSSF_status',
          name: 'Status',
          options: [SCRATCH, TODO, ICEBOX, DOING, DONE],
        },
        items: { pageInfo: { hasNextPage: false }, nodes: ITEMS },
      },
    },
  },
};

// ─── The stubs and the workspaces ─────────────────────────────

const workDir = join(tmpdir(), `check-issue-todo-column-${process.pid}`);
const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const controlPath = join(workDir, 'control.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

mkdirSync(workDir, { recursive: true });

/**
 * A `gh` that answers from a file and logs every call.
 *
 * It also answers `issue view`, which the research path makes on its own account to read
 * the created issue's title back. That read is not what is being checked here, but a stub
 * that failed it would turn every case into a warning about something else.
 *
 * Whether `item-edit` fails is read from a control file on each call rather than from the
 * environment, because the failure case has to be turned on and off again while one server
 * keeps running.
 */
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
const control = JSON.parse(readFileSync(process.env.STUB_GH_CONTROL, 'utf8'));
if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else if (args.includes('item-edit')) {
  if (control.failMove) {
    process.stderr.write('could not update the item\\n');
    process.exit(1);
  }
  process.stdout.write('{}\\n');
} else if (args.includes('issue') && args.includes('view')) {
  const url = args.find((argument) => argument.startsWith('https://')) ?? '';
  const number = Number(/\\/(\\d+)$/.exec(url)?.[1] ?? 0);
  process.stdout.write(JSON.stringify({
    number,
    title: 'Issue ' + number,
    body: 'body',
    state: 'OPEN',
    comments: [],
    stateReason: null,
    closedByPullRequestsReferences: [],
  }) + '\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/**
 * An "agent" that does what the server reads out of one: it prints an issue URL.
 *
 * Which URL comes from the observation it is given, so one command can stand in for every
 * case on one server. `CASE-0` prints nothing, which is a run that created no issue.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  const number = Number(/CASE-(\\d+)/.exec(input)?.[1] ?? 0);
  process.stdout.write('investigated\\n');
  if (number) process.stdout.write('https://github.com/${REPO}/issues/' + number + '\\n');
});
`, 'utf8');

writeFileSync(fixturePath, JSON.stringify(PAYLOAD), 'utf8');
writeFileSync(controlPath, JSON.stringify({ failMove: false }), 'utf8');
writeFileSync(logPath, '', 'utf8');

/**
 * Four boards, differing only in how they name the column a finished run lands in.
 *
 * One server, because the resolution rule is per workspace and a check that restarted the
 * server per case would be checking the environment instead.
 */
const WORKSPACES = [
  { id: 'board-default', config: { githubProject: 'https://github.com/users/vitorengers/projects/5' } },
  {
    id: 'board-named',
    config: {
      githubProject: 'https://github.com/users/vitorengers/projects/5',
      // Lower case on purpose: the column is named "Icebox" on GitHub.
      projectTodoColumn: 'icebox',
    },
  },
  {
    id: 'board-missing',
    config: {
      githubProject: 'https://github.com/users/vitorengers/projects/5',
      projectTodoColumn: 'Nowhere',
    },
  },
  { id: 'board-none', config: {} },
];

for (const workspace of WORKSPACES) {
  const dir = join(workDir, workspace.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({
    name: workspace.id,
    repo: REPO,
    ...workspace.config,
  }), 'utf8');
  workspace.path = dir.replace(/\\/g, '/');
}

writeFileSync(registryPath, JSON.stringify({
  workspaces: WORKSPACES.map((workspace) => ({ id: workspace.id, path: workspace.path })),
}), 'utf8');

// ─── The server ───────────────────────────────────────────────

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let child = null;
let serverOutput = '';

function startCanvas() {
  child = spawnCanvas({
    port,
    env: {
      // Warnings reach stderr, and one of the cases is about a warning being all that
      // happens. Nothing quieter than this would let it be read.
      LOG_LEVEL: 'warn',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
      EXCALIDRAW_ISSUE_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}"`,
      STUB_GH_FIXTURE: fixturePath,
      STUB_GH_CONTROL: controlPath,
      STUB_GH_LOG: logPath,
    },
  }).child;
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${serverOutput}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const resetLog = () => writeFileSync(logPath, '', 'utf8');
const setControl = (control) => writeFileSync(controlPath, JSON.stringify(control), 'utf8');

const isEdit = (args) => args.includes('item-edit');
const isRead = (args) => args.includes('graphql');
const optionOf = (args) => args[args.indexOf('--single-select-option-id') + 1];
const itemOf = (args) => args[args.indexOf('--id') + 1];

/** Wait for a `gh` call matching `predicate`, or give up. */
async function waitForGh(predicate, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ghCalls().find(predicate);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

/**
 * The block, as the server holds it — which is what the browser will be sent.
 *
 * The workspace has to be named on the read as well as on the write: each one has an
 * element store of its own, and a read without it answers 404 from the default board.
 */
async function blockState(workspaceId, elementId) {
  const element = (await call(`/api/elements/${elementId}?workspace=${workspaceId}`)).body.element;
  return (element?.customData ?? {});
}

/** Wait for a run to leave `running`, so a later assertion is not racing it. */
async function settle(workspaceId, elementId) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const custom = await blockState(workspaceId, elementId);
    if (custom.issueState && custom.issueState !== 'running') return custom;
    await sleep(100);
  }
  return await blockState(workspaceId, elementId);
}

/**
 * A hand-written block, exactly as the `+` leaves one: an observation and no issue.
 *
 * Its `sectionOptionId` is the reserved notes id, read from the module that owns it — the
 * `+` has stamped that rather than an option id since #97. The server never reads the
 * field, so nothing below turns on it; writing an option id here would simply describe a
 * block this canvas no longer produces.
 */
async function draftBlock(workspaceId) {
  const created = await call(`/api/elements?workspace=${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 400, height: 120,
      customData: { kind: 'issue', projectBoardDraft: true, sectionOptionId: NOTES_OPTION_ID },
    }),
  });
  return created.body.element.id;
}

/** Start the research run the `+` block's create control starts. */
async function research(workspaceId, caseNumber) {
  const elementId = await draftBlock(workspaceId);
  const started = await call(`/api/issue-block/${elementId}?workspace=${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify({ observation: `CASE-${caseNumber}: something worth an issue.` }),
  });
  return { elementId, started };
}

try {
  startCanvas();
  await waitForHealth();

  console.log('1. a finished run moves the issue it created into Todo');
  resetLog();
  const first = await research('board-default', 31);
  check('the route still answers 202', first.started.status === 202, `got ${first.started.status}`);
  const edit = await waitForGh(isEdit);
  check('gh was asked to edit the item', Boolean(edit), JSON.stringify(ghCalls()));
  check('naming the card that carries the issue just created',
        itemOf(edit ?? []) === 'PVTI_default', JSON.stringify(edit));
  check('and the Todo option, which is where it was not', optionOf(edit ?? []) === TODO.id, JSON.stringify(edit));
  check('against the field the sections came from', (edit ?? []).includes('PVTSSF_status'), JSON.stringify(edit));
  const firstBlock = await settle('board-default', first.elementId);
  check('the block ends up created, carrying its issue',
        firstBlock.issueState === 'created' && firstBlock.issueUrl === issueUrl(31),
        JSON.stringify(firstBlock));
  await sleep(700);
  check('exactly one move, not one per gh retry', ghCalls().filter(isEdit).length === 1,
        JSON.stringify(ghCalls().filter(isEdit)));

  console.log('\n2. a board that names its own column is believed');
  resetLog();
  const named = await research('board-named', 32);
  const namedEdit = await waitForGh(isEdit);
  check('the configured column wins over the default, matched without regard to case',
        optionOf(namedEdit ?? []) === ICEBOX.id, JSON.stringify(namedEdit));
  check('and it is the card for this run', itemOf(namedEdit ?? []) === 'PVTI_named', JSON.stringify(namedEdit));
  await settle('board-named', named.elementId);

  console.log('\n3. a column that does not exist is skipped, never retargeted');
  resetLog();
  const before = serverOutput.length;
  const missing = await research('board-missing', 33);
  check('the board was read', Boolean(await waitForGh(isRead)), JSON.stringify(ghCalls()));
  const missingBlock = await settle('board-missing', missing.elementId);
  check('the run still created its issue', missingBlock.issueState === 'created', JSON.stringify(missingBlock));
  await sleep(700);
  check('nothing was moved, least of all to some other column',
        ghCalls().filter(isEdit).length === 0, JSON.stringify(ghCalls()));
  const said = serverOutput.slice(before);
  check('and the reason was logged, naming the column and the setting that would fix it',
        /Nowhere/.test(said) && /projectTodoColumn/.test(said),
        JSON.stringify(said.slice(-400)));

  console.log('\n4. an issue that is not on the project is skipped, not failed');
  resetLog();
  // 34 is in no fixture item: the issue exists, the project has never heard of it.
  const offBoard = await research('board-default', 34);
  check('the board was read', Boolean(await waitForGh(isRead)), JSON.stringify(ghCalls()));
  const offBoardBlock = await settle('board-default', offBoard.elementId);
  check('the run still created its issue', offBoardBlock.issueState === 'created', JSON.stringify(offBoardBlock));
  await sleep(700);
  check('and nothing was written', ghCalls().filter(isEdit).length === 0, JSON.stringify(ghCalls()));

  console.log('\n5. a board write that fails costs the run nothing');
  resetLog();
  setControl({ failMove: true });
  const failing = await research('board-default', 35);
  check('still 202', failing.started.status === 202, `got ${failing.started.status}`);
  check('the move was attempted', Boolean(await waitForGh(isEdit)), JSON.stringify(ghCalls()));
  const failingBlock = await settle('board-default', failing.elementId);
  check('the block is created, not failed — the issue exists either way',
        failingBlock.issueState === 'created', JSON.stringify(failingBlock));
  check('and it carries no error from the board',
        !failingBlock.issueError, JSON.stringify(failingBlock));
  check('the title was still read back onto it',
        failingBlock.issueTitle === 'Issue 35', JSON.stringify(failingBlock));
  // Waited out rather than assumed: the tail of `gh`'s own retries would otherwise land in
  // the next case's window and be read as a move nobody asked for.
  await sleep(3000);
  setControl({ failMove: false });

  console.log('\n6. a run that created no issue moves nothing');
  resetLog();
  const failed = await research('board-default', 0);
  const failedBlock = await settle('board-default', failed.elementId);
  check('the block failed, as it did before any of this', failedBlock.issueState === 'failed',
        JSON.stringify(failedBlock));
  await sleep(700);
  check('and no board write was even considered', ghCalls().filter(isEdit).length === 0,
        JSON.stringify(ghCalls()));
  check('nor was the board read for one', ghCalls().filter(isRead).length === 0, JSON.stringify(ghCalls()));

  console.log('\n7. an issue already in Todo is left alone');
  resetLog();
  const settled = await research('board-default', 38);
  check('the board was read', Boolean(await waitForGh(isRead)), JSON.stringify(ghCalls()));
  await settle('board-default', settled.elementId);
  await sleep(700);
  check('and no move was written for a card already where it belongs',
        ghCalls().filter(isEdit).length === 0, JSON.stringify(ghCalls()));

  console.log('\n8. a board with no project reads no project');
  resetLog();
  const dormant = await research('board-none', 36);
  check('202, exactly as before this existed', dormant.started.status === 202, `got ${dormant.started.status}`);
  const dormantBlock = await settle('board-none', dormant.elementId);
  check('the run created its issue', dormantBlock.issueState === 'created', JSON.stringify(dormantBlock));
  await sleep(700);
  check('no graphql and no move: a dormant board stays exactly as dormant as it was',
        ghCalls().filter(isRead).length === 0 && ghCalls().filter(isEdit).length === 0,
        JSON.stringify(ghCalls()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}\n${serverOutput}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
