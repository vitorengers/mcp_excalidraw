#!/usr/bin/env node
/**
 * Checks the route that implements an issue from the block that opened it.
 *
 * This agent writes to the repository, unlike the one that opens issues, so most of these
 * cases are about the guards rather than the happy path: it must stay off unless its own
 * variable is set, it must refuse a block with no issue, and one block must never become
 * two pull requests.
 *
 * Self-contained: it builds a throwaway git repository — a real one, because a run is given a
 * worktree of its own — writes a stub implement agent that prints a pull request URL when it
 * is let go, and starts two canvases on free ports: one with no agent, to prove the route is
 * off, and one with the stub. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * **The stub waits to be released**, and the in-flight cases are why: a second POST refused
 * while a run is going, and a reset refused for the same reason, are both assertions about a
 * run that is still there when the next request arrives. A stub that answered instantly would
 * pass or fail on scheduling instead.
 *
 * `--url` points the same cases at a board you are already looking at; there the stub is
 * yours to arrange, the workspace to name, and `--disabled` says which of the two servers you
 * pointed it at. Note that the cases write to that board and start real runs in it.
 *
 * Usage: node scripts/check-implement-block.mjs [--url http://127.0.0.1:3737 --workspace <id> [--disabled]]
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const url = urlOverride();
const EXPECT_DISABLED = process.argv.includes('--disabled');
const workspaceArg = process.argv.indexOf('--workspace');
/** The id the registry below declares — or, against somebody else's board, the id they name. */
const WS = workspaceArg !== -1 && process.argv[workspaceArg + 1]
  ? process.argv[workspaceArg + 1]
  : 'implement-block-check';

if (url && workspaceArg === -1) {
  console.error('--url needs --workspace <id>: which board on that server these cases run in '
    + 'is not something this check may guess.');
  process.exit(2);
}

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-block-check-${process.pid}`);
const projectDir = join(workDir, 'project');
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'workspaces.json');
const releaseFile = join(workDir, 'release');

const hold = () => { rmSync(releaseFile, { force: true }); };
const release = () => { writeFileSync(releaseFile, '', 'utf8'); };

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

if (!url) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });

  // A real repository: the run is given a git worktree cut from the default branch, so a
  // directory that is not one fails long before any of these cases could be reached.
  git(projectDir, ['init', '-b', 'main']);
  git(projectDir, ['config', 'user.email', 'check@example.com']);
  git(projectDir, ['config', 'user.name', 'Check']);
  git(projectDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
    name: 'Implement Block Check',
    repo: 'vitorengers/vibemaxxing',
  }), 'utf8');
  writeFileSync(join(projectDir, 'README.md'), '# Implement Block Check\n', 'utf8');
  git(projectDir, ['add', '.']);
  git(projectDir, ['commit', '-m', 'initial']);

  writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync } from 'node:fs';

const releaseFile = ${JSON.stringify(releaseFile)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  // Held until the check says so, so a run can be looked at while it is live. The cap is a
  // backstop for a check that failed before it released anything, not a timing assumption.
  for (let attempt = 0; attempt < 1800 && !existsSync(releaseFile); attempt++) await sleep(100);
  process.stdout.write('Implemented, and opened one pull request.\\n');
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/pull/99\\n');
});
`, 'utf8');

  writeFileSync(registryPath, JSON.stringify({
    workspaces: [{ id: WS, path: projectDir.replace(/\\/g, '/') }],
  }), 'utf8');
}

const serverEnv = { LOG_LEVEL: 'error', EXCALIDRAW_WORKSPACES: registryPath };
const agentCommand = `node "${agentStub.replace(/\\/g, '/')}" -p`;

let BASE = '';

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${glue}workspace=${WS}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** A block that already carries an issue, which is the only kind that can be implemented. */
async function blockWithIssue(y) {
  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y, width: 200, height: 100,
      customData: {
        kind: 'issue',
        issueState: 'created',
        issueUrl: 'https://github.com/vitorengers/vibemaxxing/issues/1',
      },
    }),
  });
  return created.body.element.id;
}

async function settled(elementId, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const element = (await call(`/api/elements/${elementId}`)).body.element;
    if (element?.customData?.implementState !== 'running') return element;
    await sleep(250);
  }
  return (await call(`/api/elements/${elementId}`)).body.element;
}

// ─── The feature off ──────────────────────────────────────────

async function disabledCases() {
  console.log(`canvas: ${BASE}  (expecting the feature off)`);

  console.log('\n1. off unless its own variable is set');
  const id = await blockWithIssue(0);
  const off = await call(`/api/issue-block/${id}/implement`, { method: 'POST' });
  check('404 when EXCALIDRAW_IMPLEMENT_AGENT is unset', off.status === 404, `got ${off.status}`);
  check('says how to enable it', /VIBEMAXXING_IMPLEMENT_AGENT/.test(off.body.error ?? ''), off.body.error);
  // Enabling issue blocks must not enable repository writes.
  check('naming the issue agent instead would not do', !/VIBEMAXXING_ISSUE_AGENT/.test(off.body.error ?? ''));
  await call('/api/elements/clear', { method: 'DELETE' });
}

// ─── The feature on ───────────────────────────────────────────

async function mainCases() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. a block with no issue has nothing to implement');
  const bare = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      customData: { kind: 'issue' },
    }),
  });
  const bareRun = await call(`/api/issue-block/${bare.body.element.id}/implement`, { method: 'POST' });
  check('400 without an issue', bareRun.status === 400, `got ${bareRun.status}`);
  check('says why', /no issue to implement/i.test(bareRun.body.error ?? ''), bareRun.body.error);

  console.log('\n2. an unknown element is not a server error');
  const missing = await call('/api/issue-block/does-not-exist/implement', { method: 'POST' });
  check('404 for an unknown element', missing.status === 404, `got ${missing.status}`);

  console.log('\n3. a run starts and answers immediately');
  hold();
  const blockId = await blockWithIssue(300);
  const started = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('202 Accepted, not a held-open request', started.status === 202, `got ${started.status}`);
  check('reports running', started.body.state === 'running', started.body.state);

  console.log('\n4. one block cannot become two pull requests');
  const double = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('409 while in flight', double.status === 409, `got ${double.status}`);

  console.log('\n5. the result lands on the element');
  release();
  const element = await settled(blockId);
  check('state became done', element?.customData?.implementState === 'done',
        `state=${element?.customData?.implementState} error=${element?.customData?.implementError}`);
  check('the pull request URL was captured',
        /github\.com\/.+\/pull\/\d+/.test(element?.customData?.implementUrl ?? ''),
        `url=${element?.customData?.implementUrl}`);
  check('the issue it came from is still there',
        Boolean(element?.customData?.issueUrl), 'implementing must not overwrite the issue');

  console.log('\n6. a block that already has one refuses to run again');
  const again = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('409 with the existing pull request', again.status === 409, `got ${again.status}`);
  check('returns that pull request', Boolean(again.body.implementUrl), JSON.stringify(again.body));

  console.log('\n7. a run that was lost can be cleared, and the block tried again');
  // There is no timeout on an implementation, so nothing else ever clears this state.
  const reset = await call(`/api/issue-block/${blockId}/implement`, { method: 'DELETE' });
  check('the reset is accepted', reset.status === 200, `got ${reset.status}`);
  const cleared = (await call(`/api/elements/${blockId}`)).body.element;
  check('the implementation state is gone', !cleared?.customData?.implementState,
        `state=${cleared?.customData?.implementState}`);
  check('and the pull request with it', !cleared?.customData?.implementUrl,
        `url=${cleared?.customData?.implementUrl}`);
  check('the issue it came from survived the reset', Boolean(cleared?.customData?.issueUrl),
        'a reset must not throw away the issue');

  // Held again first: case 8 is about a run that is genuinely still there.
  hold();
  const rerun = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('the block can be implemented again', rerun.status === 202, `got ${rerun.status}`);

  console.log('\n8. a reset cannot hide a run that is actually happening');
  const duringRun = await call(`/api/issue-block/${blockId}/implement`, { method: 'DELETE' });
  check('409 while in flight', duringRun.status === 409, `got ${duringRun.status}`);
  check('says why', /running right now/i.test(duringRun.body.error ?? ''), duringRun.body.error);

  release();
  await settled(blockId);
  await call('/api/elements/clear', { method: 'DELETE' });
}

// ─── Which servers this run needs ─────────────────────────────

try {
  if (url) {
    const canvas = await openCanvas({ url });
    BASE = canvas.base;
    try {
      if (EXPECT_DISABLED) await disabledCases();
      else await mainCases();
    } finally { canvas.stop(); }
  } else {
    // Both halves, because both are this route's behaviour and neither needs the maintainer
    // to remember which server they are pointed at.
    const off = await openCanvas({ env: serverEnv });
    BASE = off.base;
    try { await disabledCases(); } finally { off.stop(); }

    const on = await openCanvas({ env: { ...serverEnv, EXCALIDRAW_IMPLEMENT_AGENT: agentCommand } });
    BASE = on.base;
    try { await mainCases(); } finally { on.stop(); }
  }
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  if (!url) {
    if (existsSync(workDir)) release();
    await sleep(500);
    if (existsSync(projectDir)) git(projectDir, ['worktree', 'prune']);
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
