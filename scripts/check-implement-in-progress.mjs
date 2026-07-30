#!/usr/bin/env node
/**
 * Checks that starting an implementation moves the issue's card to In Progress.
 *
 * Clicking Implement / Fix used to change nothing on GitHub: the run started, the board kept
 * saying Todo, and the only column nobody writes is the one that therefore drifts. The write
 * belongs to the server rather than to the agent's prompt — an agent that dies early would
 * otherwise leave the card in Todo with a run in flight, and the state would be written by
 * the one participant that cannot report its own crash.
 *
 * So the cases here are about the *server*: one `item-edit` per run, the column resolved
 * from the project rather than guessed, and — the half that matters more — a board write
 * that fails must not cost the implementation.
 *
 * Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas server
 * against throwaway workspaces, and kills both. Nothing here talks to GitHub, nothing runs a
 * real coding agent, and nothing needs a browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-in-progress.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Fixtures ─────────────────────────────────────────────────
//
// Shaped like the real `gh api graphql` answer, because that is what the reader parses.
// `Working` is a fourth option that exists only so a workspace can name a column *other*
// than the default and be believed: a check where the configured name and the fallback are
// the same column cannot tell the two apart.

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const WORKING = { id: 'aa11bb22', name: 'Working' };
const DONE = { id: '98236657', name: 'Done' };

const REPO = 'vitorengers/mcp_excalidraw';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;

function item(id, { number, option, createdAt = '2026-07-20T10:00:00Z' }) {
  return {
    id,
    fieldValueByName: option ? { optionId: option.id, name: option.name } : null,
    content: {
      __typename: 'Issue',
      number,
      title: `Issue ${number}`,
      url: issueUrl(number),
      createdAt,
      state: 'OPEN',
      repository: { nameWithOwner: REPO },
    },
  };
}

/** One card per case, so no two cases can be confused for one another. */
const ITEMS = [
  item('PVTI_url', { number: 21, option: TODO }),
  item('PVTI_block', { number: 22, option: TODO }),
  item('PVTI_ghfails', { number: 23, option: TODO }),
  item('PVTI_twice', { number: 24, option: TODO }),
  item('PVTI_named', { number: 25, option: TODO }),
  item('PVTI_missing', { number: 26, option: TODO }),
  item('PVTI_noproject', { number: 27, option: TODO }),
];

const PAYLOAD = {
  data: {
    owner: {
      projectV2: {
        id: 'PVT_kwHOBVSHIs4BefUS',
        title: 'mcp_excalidraw',
        url: 'https://github.com/users/vitorengers/projects/5',
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, WORKING, DONE] },
        items: { pageInfo: { hasNextPage: false }, nodes: ITEMS },
      },
    },
  },
};

// ─── The stubs and the workspaces ─────────────────────────────

const workDir = join(tmpdir(), `check-implement-in-progress-${process.pid}`);
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
  if (control.failRead) {
    process.stderr.write('could not read the project\\n');
    process.exit(1);
  }
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else if (args.includes('item-edit')) {
  if (control.failMove) {
    process.stderr.write('could not update the item\\n');
    process.exit(1);
  }
  process.stdout.write('{}\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/** An "agent" that does what the server reads out of one: it prints a pull request URL. */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  process.stdout.write('done\\nhttps://github.com/${REPO}/pull/999\\n');
});
`, 'utf8');

writeFileSync(fixturePath, JSON.stringify(PAYLOAD), 'utf8');
writeFileSync(controlPath, JSON.stringify({ failMove: false, failRead: false }), 'utf8');
writeFileSync(logPath, '', 'utf8');

/**
 * Four boards, differing only in how they name the column a run lands in.
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
      // Lower case on purpose: the column is named "Working" on GitHub.
      projectInProgressColumn: 'working',
    },
  },
  {
    id: 'board-missing',
    config: {
      githubProject: 'https://github.com/users/vitorengers/projects/5',
      projectInProgressColumn: 'Icebox',
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
  child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}" -p`,
      // Every case here starts a run; a cap would refuse one for the wrong reason.
      EXCALIDRAW_IMPLEMENT_CONCURRENCY: '0',
      STUB_GH_FIXTURE: fixturePath,
      STUB_GH_CONTROL: controlPath,
      STUB_GH_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
async function waitForGh(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const hit = ghCalls().find(predicate);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

/** Wait until `predicate` has matched `count` calls, then report how many it saw. */
async function waitForGhCount(predicate, count, ms = 10_000) {
  const deadline = Date.now() + ms;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = ghCalls().filter(predicate).length;
    if (seen >= count) return seen;
    await sleep(100);
  }
  return seen;
}

/** Wait for a run to stop being `running`, so a later assertion is not racing it. */
async function settle(workspaceId, url) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const state = (await call(`/api/implement?workspace=${workspaceId}&url=${encodeURIComponent(url)}`))
      .body.implement?.state;
    if (state && state !== 'running') return state;
    await sleep(100);
  }
  return 'running';
}

async function startByUrl(workspaceId, url) {
  return call(`/api/implement?workspace=${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

async function blockFor(workspaceId, url) {
  const created = await call(`/api/elements?workspace=${workspaceId}`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      customData: { kind: 'issue', issueState: 'created', issueUrl: url },
    }),
  });
  return created.body.element.id;
}

try {
  startCanvas();
  await waitForHealth();

  console.log('1. starting a run from a mirrored card moves its issue to In Progress');
  resetLog();
  const byUrl = await startByUrl('board-default', issueUrl(21));
  check('the route still answers 202', byUrl.status === 202, `got ${byUrl.status}`);
  const edit = await waitForGh(isEdit);
  check('gh was asked to edit the item', Boolean(edit), JSON.stringify(ghCalls()));
  check('naming the card that carries this issue', itemOf(edit ?? []) === 'PVTI_url', JSON.stringify(edit));
  check('and the In Progress option', optionOf(edit ?? []) === DOING.id, JSON.stringify(edit));
  check('against the field the sections came from', (edit ?? []).includes('PVTSSF_status'), JSON.stringify(edit));
  await settle('board-default', issueUrl(21));
  check('exactly one move, not one per gh retry', ghCalls().filter(isEdit).length === 1,
        JSON.stringify(ghCalls().filter(isEdit)));

  console.log('\n2. the block route lands in the same place');
  // Both entrances go through beginImplement, so covering one is not covering both.
  resetLog();
  const blockId = await blockFor('board-default', issueUrl(22));
  const byBlock = await call(`/api/issue-block/${blockId}/implement?workspace=board-default`, { method: 'POST' });
  check('202 Accepted', byBlock.status === 202, `got ${byBlock.status}`);
  const blockEdit = await waitForGh(isEdit);
  check('the card moved too', itemOf(blockEdit ?? []) === 'PVTI_block', JSON.stringify(blockEdit));
  check('to In Progress', optionOf(blockEdit ?? []) === DOING.id, JSON.stringify(blockEdit));
  const blockState = await settle('board-default', issueUrl(22));
  check('and the implementation still ran', blockState === 'done', blockState);

  console.log('\n3. a board write that fails does not cost the implementation');
  resetLog();
  setControl({ failMove: true, failRead: false });
  const whileFailing = await startByUrl('board-default', issueUrl(23));
  check('still 202', whileFailing.status === 202, `got ${whileFailing.status}`);
  check('the move was attempted', Boolean(await waitForGh(isEdit)), JSON.stringify(ghCalls()));
  const failedMoveState = await settle('board-default', issueUrl(23));
  check('the agent still spawned and the run finished', failedMoveState === 'done', failedMoveState);
  check('the run records no error from the board', !(await call(
    `/api/implement?workspace=board-default&url=${encodeURIComponent(issueUrl(23))}`)).body.implement?.error);
  // A failing board write is retried like every other `gh` call here and then given up on.
  // Waited out rather than assumed: the tail of those retries would otherwise land in the
  // next case's window and be read as a move nobody asked for.
  const attempts = await waitForGhCount(isEdit, 3);
  check('retried three times, then abandoned', attempts === 3, `saw ${attempts}`);
  setControl({ failMove: false, failRead: false });

  console.log('\n4. an issue that is not on the project is skipped, not failed');
  resetLog();
  const offBoard = await startByUrl('board-default', issueUrl(404));
  check('202 all the same', offBoard.status === 202, `got ${offBoard.status}`);
  check('the board was read', Boolean(await waitForGh(isRead)), JSON.stringify(ghCalls()));
  const offBoardState = await settle('board-default', issueUrl(404));
  check('the implementation ran', offBoardState === 'done', offBoardState);
  await sleep(500);
  check('and nothing was written', ghCalls().filter(isEdit).length === 0, JSON.stringify(ghCalls()));

  console.log('\n5. a second click issues no second move');
  resetLog();
  const first = await startByUrl('board-default', issueUrl(24));
  check('the first is accepted', first.status === 202, `got ${first.status}`);
  const second = await startByUrl('board-default', issueUrl(24));
  check('the second is refused', second.status === 409, `got ${second.status}`);
  await settle('board-default', issueUrl(24));
  await sleep(500);
  check('one move, not two', ghCalls().filter(isEdit).length === 1, JSON.stringify(ghCalls().filter(isEdit)));

  console.log('\n6. a board that names its own column is believed');
  resetLog();
  await startByUrl('board-named', issueUrl(25));
  const namedEdit = await waitForGh(isEdit);
  check('the configured column wins over the default', optionOf(namedEdit ?? []) === WORKING.id,
        JSON.stringify(namedEdit));
  check('matched without regard to case', Boolean(namedEdit), JSON.stringify(ghCalls()));
  await settle('board-named', issueUrl(25));

  console.log('\n7. a column that does not exist is skipped, never retargeted');
  resetLog();
  await startByUrl('board-missing', issueUrl(26));
  check('the board was read', Boolean(await waitForGh(isRead)), JSON.stringify(ghCalls()));
  const missingState = await settle('board-missing', issueUrl(26));
  check('the implementation ran', missingState === 'done', missingState);
  await sleep(500);
  check('nothing was moved, least of all to In Progress',
        ghCalls().filter(isEdit).length === 0, JSON.stringify(ghCalls()));

  console.log('\n8. a board with no project spawns no gh at all');
  resetLog();
  const dormant = await startByUrl('board-none', issueUrl(27));
  check('202, exactly as before this existed', dormant.status === 202, `got ${dormant.status}`);
  const dormantState = await settle('board-none', issueUrl(27));
  check('the implementation ran', dormantState === 'done', dormantState);
  await sleep(500);
  check('gh was never run', ghCalls().length === 0, JSON.stringify(ghCalls()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
