#!/usr/bin/env node
/**
 * Checks for the issue block endpoint.
 *
 * This route spawns a process with full repository access on an API that has no
 * authentication, so most of these cases are about the guards rather than the happy
 * path: it must stay off unless explicitly enabled, and one observation must never
 * become two issues.
 *
 * The reset cases are the other half of removing the run's time limit. Nothing kills a
 * wedged agent now, so nothing else clears `running` either — and a block left in that
 * state has no way back, because the panel hides the create control there.
 *
 * Self-contained: it builds a throwaway workspace, writes a stub issue agent that prints an
 * issue URL when it is let go and a stub `gh` for the read-back that follows, and starts two
 * canvases on free ports — one with no agent, to prove the feature is off, and one with the
 * stub — then kills both. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * **The stub waits to be released**, and that is what makes the in-flight cases mean
 * anything: a 409 for a run already going, and a reset refused while one is genuinely live,
 * are both assertions about a run that is still there when the second request arrives. A stub
 * that answered instantly would race, and would pass or fail on scheduling.
 *
 * `--url` points the same cases at a board you are already looking at; there the stubs are
 * yours to arrange, and `--disabled` says which of the two servers you pointed it at.
 *
 * Usage: node scripts/check-issue-block.mjs [--url http://127.0.0.1:3737 [--disabled]]
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const url = urlOverride();
const EXPECT_DISABLED = process.argv.includes('--disabled');

/** The id the registry below declares, and the only place this check learns it from. */
const WS = 'issue-block-check';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-block-check-${process.pid}`);
const projectDir = join(workDir, 'project');
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'workspaces.json');
const releaseFile = join(workDir, 'release');

const hold = () => { rmSync(releaseFile, { force: true }); };
const release = () => { writeFileSync(releaseFile, '', 'utf8'); };

if (!url) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });

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
  process.stdout.write('Investigated, and opened one issue.\\n');
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/issues/42\\n');
});
`, 'utf8');

  // Only the read-back reaches it: a created block adopts the issue's title. Anything else
  // is a call this feature did not mean to make, and saying so beats answering it.
  writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const number = (/issues\\/(\\d+)/.exec(args.join(' ')) ?? [])[1] ?? '0';

if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'The docs panel is slow to open on large boards',
    body: 'The body of issue ' + number,
    state: 'OPEN',
    comments: [],
    stateReason: null,
    closedByPullRequestsReferences: [],
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

  writeFileSync(registryPath, JSON.stringify({
    workspaces: [{ id: WS, path: projectDir.replace(/\\/g, '/') }],
  }), 'utf8');
  writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
    name: 'Issue Block Check',
    repo: 'vitorengers/vibemaxxing',
  }), 'utf8');
}

const serverEnv = {
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
};
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

/** A block carrying an observation, which is the only kind that can be researched. */
async function issueBlock(y, text) {
  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y, width: 200, height: 100,
      ...(text ? { text } : {}),
      customData: { kind: 'issue' },
    }),
  });
  return created.body.element.id;
}

async function settled(elementId, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const element = (await call(`/api/elements/${elementId}`)).body.element;
    if (element?.customData?.issueState !== 'running') return element;
    await sleep(250);
  }
  return (await call(`/api/elements/${elementId}`)).body.element;
}

// ─── The feature off ──────────────────────────────────────────

async function disabledCases() {
  console.log(`canvas: ${BASE}  (expecting the feature off)`);

  console.log('\n1. disabled by default');
  const id = await issueBlock(0, 'The docs panel is slow to open on large boards');
  const off = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('404 when EXCALIDRAW_ISSUE_AGENT is unset', off.status === 404, `got ${off.status}`);
  check('says how to enable it', /VIBEMAXXING_ISSUE_AGENT/.test(off.body.error ?? ''), off.body.error);
  await call('/api/elements/clear', { method: 'DELETE' });
}

// ─── The feature on ───────────────────────────────────────────

async function mainCases() {
  console.log(`canvas: ${BASE}`);

  hold();
  const id = await issueBlock(0, 'The docs panel is slow to open on large boards');

  console.log('\n1. a run starts and answers immediately');
  const started = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('202 Accepted, not a held-open request', started.status === 202, `got ${started.status}`);
  check('reports running', started.body.state === 'running');

  console.log('\n2. a second click cannot open a second issue');
  const double = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('409 while in flight', double.status === 409, `got ${double.status}`);

  console.log('\n3. the result lands on the element');
  release();
  const element = await settled(id);
  check('state became created', element?.customData?.issueState === 'created',
        `state=${element?.customData?.issueState} error=${element?.customData?.issueError}`);
  check('issue URL captured', /github\.com\/.+\/issues\/\d+/.test(element?.customData?.issueUrl ?? ''),
        `url=${element?.customData?.issueUrl}`);

  console.log('\n4. a block that already has an issue refuses to run again');
  const again = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('409 with the existing issue', again.status === 409, `got ${again.status}`);
  check('returns the existing URL', Boolean(again.body.issueUrl));

  console.log('\n5. the observation can live in a label bound to the shape');
  const boxedId = await issueBlock(300, null);
  await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'text', x: 10, y: 310, text: 'Switching tabs is slow on large boards',
      containerId: boxedId,
    }),
  });
  const boxedRun = await call(`/api/issue-block/${boxedId}`, { method: 'POST' });
  check('accepted with the label as the observation', boxedRun.status === 202, `got ${boxedRun.status}`);

  console.log('\n6. a block with nothing written in it is rejected');
  const empty = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, customData: { kind: 'issue' } }),
  });
  const emptyRun = await call(`/api/issue-block/${empty.body.element.id}`, { method: 'POST' });
  check('400 with no observation', emptyRun.status === 400, `got ${emptyRun.status}`);

  // A run has no ceiling any more, so nothing kills a wedged agent and nothing else ever
  // clears `running`. Without a way back the block is dead: the panel hides the create
  // control in that state and the element keeps it across a restart, when the server no
  // longer has any run to point at.
  console.log('\n7. a block stuck in running can be reset');
  await settled(boxedId);
  const stuck = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 600, width: 200, height: 100,
      text: 'The panel forgets the selected block after a reconnect',
      // Exactly what a restart leaves behind: `running` on the element, no run in flight.
      customData: { kind: 'issue', issueState: 'running', issueError: 'stale' },
    }),
  });
  const stuckId = stuck.body.element.id;
  const reset = await call(`/api/issue-block/${stuckId}`, { method: 'DELETE' });
  check('200 for a state no run is behind', reset.status === 200, `got ${reset.status}`);
  const afterReset = (await call(`/api/elements/${stuckId}`)).body.element;
  check('the stuck state is gone', !afterReset?.customData?.issueState,
        `state=${afterReset?.customData?.issueState}`);
  check('and so is the error it was showing', !afterReset?.customData?.issueError,
        `error=${afterReset?.customData?.issueError}`);
  check('the block is still an issue block', afterReset?.customData?.kind === 'issue');

  console.log('\n8. and can then be run again');
  // Held again first: case 9 is about a run that is genuinely still there.
  hold();
  const retry = await call(`/api/issue-block/${stuckId}`, { method: 'POST' });
  check('202 after the reset', retry.status === 202, `got ${retry.status} ${JSON.stringify(retry.body)}`);

  console.log('\n9. a reset is refused while a run is genuinely in flight');
  // Immediately after the 202 above: the state on the element cannot tell a live run from
  // an abandoned one, but the server can, and resetting a live one would only hide it.
  const refused = await call(`/api/issue-block/${stuckId}`, { method: 'DELETE' });
  check('409 while in flight', refused.status === 409, `got ${refused.status}`);
  check('the refusal says why', /running|in flight/i.test(refused.body.error ?? ''), refused.body.error);

  console.log('\n10. a reset does not let one observation become two issues');
  const clearCreated = await call(`/api/issue-block/${id}`, { method: 'DELETE' });
  check('200 on a block that already has an issue', clearCreated.status === 200,
        `got ${clearCreated.status}`);
  const keptUrl = (await call(`/api/elements/${id}`)).body.element;
  check('the issue it produced is still on the block', Boolean(keptUrl?.customData?.issueUrl),
        `url=${keptUrl?.customData?.issueUrl}`);
  const second = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('409 for a second run on it', second.status === 409, `got ${second.status}`);

  console.log('\n11. a reset for a block that does not exist');
  const missing = await call('/api/issue-block/no-such-element', { method: 'DELETE' });
  check('404 rather than a silent success', missing.status === 404, `got ${missing.status}`);

  release();
  await settled(stuckId);
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

    const on = await openCanvas({ env: { ...serverEnv, EXCALIDRAW_ISSUE_AGENT: agentCommand } });
    BASE = on.base;
    try { await mainCases(); } finally { on.stop(); }
  }
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  if (!url) {
    if (existsSync(workDir)) release();
    await sleep(300);
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
