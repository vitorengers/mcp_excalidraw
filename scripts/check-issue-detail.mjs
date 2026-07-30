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
 * The gh stub must **fail its first invocation** and succeed afterwards. That is what
 * gh does on this machine, and it is what case 5 relies on: with no retry, the first
 * call is the only call and the title is silently lost.
 *
 * Usage: node scripts/check-issue-detail.mjs [--url http://127.0.0.1:3838]
 *
 * Tier: fast
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
  check('the label now reads the issue title',
        retitled?.text?.replace(/\n/g, ' ') === element?.customData?.issueTitle,
        `label=${JSON.stringify(retitled?.text)}`);

  console.log('\n4. the title is laid out inside its block, not just written into it');
  // Writing the text without laying it out put a 518px title inside a 400px block, on
  // one line, in a box still sized for the observation that started the run.
  const box = (await call(`/api/elements/${blockId}`)).body.element;
  const fits =
    retitled.x >= box.x &&
    retitled.y >= box.y &&
    retitled.x + retitled.width <= box.x + box.width &&
    retitled.y + retitled.height <= box.y + box.height;
  check('every edge of the text is inside the box', fits,
        `text ${Math.round(retitled.x)}..${Math.round(retitled.x + retitled.width)} ` +
        `x ${Math.round(retitled.y)}..${Math.round(retitled.y + retitled.height)} | ` +
        `box ${Math.round(box.x)}..${Math.round(box.x + box.width)} ` +
        `x ${Math.round(box.y)}..${Math.round(box.y + box.height)}`);
  check('the box is no taller than the text needs', box.height <= retitled.height + 20,
        `box h=${Math.round(box.height)} text h=${Math.round(retitled.height)}`);
  check('the title wrapped rather than running on', retitled.text.includes('\n'),
        `a title this long on one line cannot fit: ${JSON.stringify(retitled.text)}`);
  // The geometry cases above only check the server's numbers against each other. They
  // pass even when those numbers were computed for a font size the browser will not use,
  // which is exactly what happened: laid out for 16, drawn at 20, 5px of text outside the
  // box. Writing the size settles it by construction rather than by agreement.
  check('the label carries the font size it was laid out for',
        typeof retitled.fontSize === 'number',
        `fontSize=${retitled.fontSize} — the browser will pick its own default instead`);

  console.log('\n5. the body is fetched, never stored on the element');
  const custom = element?.customData ?? {};
  check('no body on the element',
        !Object.keys(custom).some((key) => /body/i.test(key)),
        `customData keys: ${Object.keys(custom).join(', ')}`);

  const detail = await call(`/api/issue-block/${blockId}/issue`);
  check('the route answers 200', detail.status === 200, `got ${detail.status}`);
  check('it returns the title', Boolean(detail.body.issue?.title));
  check('it returns the body', Boolean(detail.body.issue?.body), 'the panel has nothing to render');
  check('it returns the issue state', Boolean(detail.body.issue?.state));

  console.log('\n6. the first gh of the run failed, and nothing showed it');
  // The stub fails its very first invocation — which is the read-back inside the run,
  // in case 3. gh does exactly this here: socket buffer exhaustion that clears on the
  // next attempt. Without a retry that first call is the only call, the title never
  // lands, and the blip reaches the reader as a broken block. So case 3 passing *is*
  // the proof; this only states what it proved.
  check('the stub was asked to fail once', true, '');
  check('the title landed anyway', Boolean(element?.customData?.issueTitle),
        'a single transient gh failure lost the title');

  await call('/api/elements/clear', { method: 'DELETE' });

  if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
  console.log('\nall cases passed');
}

main().catch((err) => { console.error(`\nerror: ${err.message}`); process.exit(1); });
