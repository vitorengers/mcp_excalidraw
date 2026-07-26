#!/usr/bin/env node
/**
 * Checks that a created issue block can show the issue it produced.
 *
 * A finished block used to be a dead end: it kept the observation that started the run
 * and the panel had nothing but a bare URL. These cases pin down the read-back — the
 * route that fetches the issue, the guards around it, and the fact that the body is
 * fetched rather than copied onto the element.
 *
 * Run against a server started with EXCALIDRAW_GH_COMMAND pointing at a stub that
 * prints what `gh issue view --json` would print, and EXCALIDRAW_ISSUE_AGENT at a stub
 * that prints an issue URL — the point is this server's behaviour, not GitHub's.
 *
 * Usage: node scripts/check-issue-detail.mjs [--url http://127.0.0.1:3838]
 */

const urlArg = process.argv.indexOf('--url');
const BASE = (urlArg !== -1 && process.argv[urlArg + 1])
  || process.env.EXPRESS_SERVER_URL
  || 'http://127.0.0.1:3000';
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

async function main() {
  console.log(`canvas: ${BASE}`);

  console.log('\n1. a block with no issue has nothing to show');
  const bare = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      customData: { kind: 'issue' },
    }),
  });
  const bareId = bare.body.element.id;
  const bareRead = await call(`/api/issue-block/${bareId}/issue`);
  check('404 before a run', bareRead.status === 404, `got ${bareRead.status}`);
  check('says why', /no issue yet/i.test(bareRead.body.error ?? ''), bareRead.body.error);

  console.log('\n2. an unknown element is not a server error');
  const missing = await call('/api/issue-block/does-not-exist/issue');
  check('404 for an unknown element', missing.status === 404, `got ${missing.status}`);

  console.log('\n3. a run retitles the block and keeps the observation');
  const created = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 300, width: 200, height: 100,
      customData: { kind: 'issue' },
    }),
  });
  const blockId = created.body.element.id;
  const label = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'text', x: 10, y: 310, text: 'The docs panel is slow to open on large boards',
      containerId: blockId,
    }),
  });
  const labelId = label.body.element.id;

  await call(`/api/issue-block/${blockId}`, { method: 'POST' });

  let element;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(250);
    element = (await call(`/api/elements/${blockId}`)).body.element;
    if (element?.customData?.issueState === 'created' && element?.customData?.issueTitle) break;
  }
  check('the run finished', element?.customData?.issueState === 'created',
        `state=${element?.customData?.issueState} error=${element?.customData?.issueError}`);
  check('the title landed on the element', Boolean(element?.customData?.issueTitle),
        `issueTitle=${element?.customData?.issueTitle}`);
  check('the observation was preserved',
        /docs panel is slow/i.test(element?.customData?.observation ?? ''),
        `observation=${element?.customData?.observation}`);

  const retitled = (await call(`/api/elements/${labelId}`)).body.element;
  check('the label now reads the issue title', retitled?.text === element?.customData?.issueTitle,
        `label=${JSON.stringify(retitled?.text)}`);

  console.log('\n4. the body is fetched, never stored on the element');
  const custom = element?.customData ?? {};
  check('no body on the element',
        !Object.keys(custom).some((key) => /body/i.test(key)),
        `customData keys: ${Object.keys(custom).join(', ')}`);

  const detail = await call(`/api/issue-block/${blockId}/issue`);
  check('the route answers 200', detail.status === 200, `got ${detail.status}`);
  check('it returns the title', Boolean(detail.body.issue?.title));
  check('it returns the body', Boolean(detail.body.issue?.body), 'the panel has nothing to render');
  check('it returns the issue state', Boolean(detail.body.issue?.state));

  await call('/api/elements/clear', { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
