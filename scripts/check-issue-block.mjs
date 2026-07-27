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
 * Run against a server started with EXCALIDRAW_ISSUE_AGENT pointing at a stub that
 * prints an issue URL — the point is the endpoint's behaviour, not a real agent run.
 *
 * Usage: node scripts/check-issue-block.mjs [--url http://127.0.0.1:3000] [--disabled]
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';
const EXPECT_DISABLED = process.argv.includes('--disabled');
const WS = 'fica-ai';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${glue}workspace=${WS}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`canvas: ${BASE}${EXPECT_DISABLED ? '  (expecting the feature off)' : ''}`);

  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      text: 'The docs panel is slow to open on large boards',
      customData: { kind: 'issue' },
    }),
  });
  const id = created.body.element.id;

  if (EXPECT_DISABLED) {
    console.log('\n1. disabled by default');
    const off = await call(`/api/issue-block/${id}`, { method: 'POST' });
    check('404 when EXCALIDRAW_ISSUE_AGENT is unset', off.status === 404, `got ${off.status}`);
    check('says how to enable it', /EXCALIDRAW_ISSUE_AGENT/.test(off.body.error ?? ''));
    await call('/api/elements/clear', { method: 'DELETE' });
    if (failures) process.exit(1);
    console.log('\nall cases passed');
    return;
  }

  console.log('\n1. a run starts and answers immediately');
  const started = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('202 Accepted, not a held-open request', started.status === 202, `got ${started.status}`);
  check('reports running', started.body.state === 'running');

  console.log('\n2. a second click cannot open a second issue');
  const double = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('409 while in flight', double.status === 409, `got ${double.status}`);

  console.log('\n3. the result lands on the element');
  let element;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    element = (await call(`/api/elements/${id}`)).body.element;
    if (element?.customData?.issueState !== 'running') break;
  }
  check('state became created', element?.customData?.issueState === 'created',
        `state=${element?.customData?.issueState} error=${element?.customData?.issueError}`);
  check('issue URL captured', /github\.com\/.+\/issues\/\d+/.test(element?.customData?.issueUrl ?? ''),
        `url=${element?.customData?.issueUrl}`);

  console.log('\n4. a block that already has an issue refuses to run again');
  const again = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('409 with the existing issue', again.status === 409, `got ${again.status}`);
  check('returns the existing URL', Boolean(again.body.issueUrl));

  console.log('\n5. the observation can live in a label bound to the shape');
  const boxed = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 300, width: 200, height: 100, customData: { kind: 'issue' } }),
  });
  const boxedId = boxed.body.element.id;
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

  await call('/api/elements/clear', { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
