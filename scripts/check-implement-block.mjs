#!/usr/bin/env node
/**
 * Checks the route that implements an issue from the block that opened it.
 *
 * This agent writes to the repository, unlike the one that opens issues, so most of these
 * cases are about the guards rather than the happy path: it must stay off unless its own
 * variable is set, it must refuse a block with no issue, and one block must never become
 * two pull requests.
 *
 * Run against a server started with EXCALIDRAW_IMPLEMENT_AGENT pointing at a stub that
 * prints a pull request URL — the point is this server's behaviour, not an agent's.
 *
 * Usage: node scripts/check-implement-block.mjs [--url http://127.0.0.1:3838] [--disabled]
 *
 * Tier: fast
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';
const EXPECT_DISABLED = process.argv.includes('--disabled');
const WS = 'board-tool';

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

/** A block that already carries an issue, which is the only kind that can be implemented. */
async function blockWithIssue(y) {
  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y, width: 200, height: 100,
      customData: {
        kind: 'issue',
        issueState: 'created',
        issueUrl: 'https://github.com/vitorengers/mcp_excalidraw/issues/1',
      },
    }),
  });
  return created.body.element.id;
}

async function main() {
  console.log(`canvas: ${BASE}${EXPECT_DISABLED ? '  (expecting the feature off)' : ''}`);

  if (EXPECT_DISABLED) {
    console.log('\n1. off unless its own variable is set');
    const id = await blockWithIssue(0);
    const off = await call(`/api/issue-block/${id}/implement`, { method: 'POST' });
    check('404 when EXCALIDRAW_IMPLEMENT_AGENT is unset', off.status === 404, `got ${off.status}`);
    check('says how to enable it', /EXCALIDRAW_IMPLEMENT_AGENT/.test(off.body.error ?? ''), off.body.error);
    // Enabling issue blocks must not enable repository writes.
    check('naming the issue agent instead would not do', !/EXCALIDRAW_ISSUE_AGENT/.test(off.body.error ?? ''));
    await call('/api/elements/clear', { method: 'DELETE' });
    if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
    console.log('\nall cases passed');
    return;
  }

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
  const blockId = await blockWithIssue(300);
  const started = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('202 Accepted, not a held-open request', started.status === 202, `got ${started.status}`);
  check('reports running', started.body.state === 'running', started.body.state);

  console.log('\n4. one block cannot become two pull requests');
  const double = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('409 while in flight', double.status === 409, `got ${double.status}`);

  console.log('\n5. the result lands on the element');
  let element;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    element = (await call(`/api/elements/${blockId}`)).body.element;
    if (element?.customData?.implementState !== 'running') break;
  }
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

  const rerun = await call(`/api/issue-block/${blockId}/implement`, { method: 'POST' });
  check('the block can be implemented again', rerun.status === 202, `got ${rerun.status}`);

  console.log('\n8. a reset cannot hide a run that is actually happening');
  const duringRun = await call(`/api/issue-block/${blockId}/implement`, { method: 'DELETE' });
  check('409 while in flight', duringRun.status === 409, `got ${duringRun.status}`);
  check('says why', /running right now/i.test(duringRun.body.error ?? ''), duringRun.body.error);

  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    const settled = (await call(`/api/elements/${blockId}`)).body.element;
    if (settled?.customData?.implementState !== 'running') break;
  }

  await call('/api/elements/clear', { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
