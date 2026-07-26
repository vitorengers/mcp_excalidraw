#!/usr/bin/env node
/**
 * Checks for the issue block endpoint.
 *
 * This route spawns a process with full repository access on an API that has no
 * authentication, so most of these cases are about the guards rather than the happy
 * path: it must stay off unless explicitly enabled, and one observation must never
 * become two issues.
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
      text: 'O painel de docs demora a abrir em boards grandes',
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

  console.log('\n5. a block with nothing written in it is rejected');
  const empty = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, customData: { kind: 'issue' } }),
  });
  const emptyRun = await call(`/api/issue-block/${empty.body.element.id}`, { method: 'POST' });
  check('400 with no observation', emptyRun.status === 400, `got ${emptyRun.status}`);

  await call('/api/elements/clear', { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
