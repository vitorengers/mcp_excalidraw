#!/usr/bin/env node
/**
 * Checks that a created issue block can show the issue it produced.
 *
 * A finished block used to be a dead end: it kept the observation that started the run
 * and the panel had nothing but a bare URL. These cases pin down the read-back — the
 * route that fetches the issue, the guards around it, and the fact that the body is
 * fetched rather than copied onto the element.
 *
 * Self-contained: it builds a throwaway workspace, writes a stub issue agent that prints an
 * issue URL and a stub `gh` that answers what `gh issue view --json` would, starts its own
 * canvas on a free port and kills it. Nothing here talks to GitHub. Run
 * `./node_modules/.bin/tsc` first.
 *
 * **The `gh` stub refuses its first `issue view`** and succeeds afterwards. That is what `gh`
 * does on this machine — socket buffer exhaustion that clears on the next attempt — and it is
 * what case 3 rests on: with no retry the first call is the only call and the title is
 * silently lost. Keyed on the call rather than on the invocation count, because the run makes
 * other `gh` calls and a counter that any of them could satisfy would leave the read-back
 * succeeding first time, which is exactly the way this check could pass for the wrong reason.
 * Case 6 reads the stub's own log back rather than asserting `true`.
 *
 * `--url` points the same cases at a board you are already looking at; there the stubs are
 * yours to arrange, and the workspace to name.
 *
 * Usage: node scripts/check-issue-detail.mjs [--url http://127.0.0.1:3737 --workspace <id>]
 *
 * Tier: fast
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCanvas, urlOverride } from './lib/spawn-canvas.mjs';

const url = urlOverride();
const workspaceArg = process.argv.indexOf('--workspace');
/** The id the registry below declares — or, against somebody else's board, the id they name. */
const WS = workspaceArg !== -1 && process.argv[workspaceArg + 1]
  ? process.argv[workspaceArg + 1]
  : 'issue-detail-check';

if (url && workspaceArg === -1) {
  console.error('--url needs --workspace <id>: which board on that server these cases run in '
    + 'is not something this check may guess.');
  process.exit(2);
}

/** Long enough that it cannot fit on one line of a 200px block — case 4 is about that. */
const TITLE = 'The docs panel is slow to open on large boards';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-detail-check-${process.pid}`);
const projectDir = join(workDir, 'project');
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const ghLog = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');

if (!url) {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(ghLog, '', 'utf8');

  writeFileSync(agentStub, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('Investigated, and opened one issue.\\n');
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/issues/7\\n');
});
`, 'utf8');

  writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

const log = ${JSON.stringify(ghLog)};
const args = process.argv.slice(2);
const reading = args[0] === 'issue' && args[1] === 'view';
const before = readFileSync(log, 'utf8').split('\\n').filter(Boolean);
appendFileSync(log, args.join(' ') + '\\n');

// The blip this machine really produces, on the call the run depends on. Every later one
// succeeds, so a retry is the difference between a title and a broken-looking block.
if (reading && !before.some((line) => line.startsWith('issue view'))) {
  process.stderr.write('error connecting to api.github.com\\n');
  process.exit(1);
}

if (reading) {
  const number = (/issues\\/(\\d+)/.exec(args.join(' ')) ?? [])[1] ?? '0';
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: ${JSON.stringify(TITLE)},
    body: 'What the issue says, fetched rather than stored.',
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
    name: 'Issue Detail Check',
    repo: 'vitorengers/mcp_excalidraw',
  }), 'utf8');
}

const canvas = await openCanvas({
  url,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
  },
});
const BASE = canvas.base;

/** Every `gh` command line the stub was given, in order. */
const ghCalls = () => (url ? [] : readFileSync(ghLog, 'utf8').split('\n').filter(Boolean));

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${glue}workspace=${WS}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

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
  // The stub refuses the run's own read-back, in case 3. Without a retry that first call is
  // the only call, the title never lands, and the blip reaches the reader as a broken block.
  // So case 3 passing *is* the proof — as long as the refusal really happened, which is what
  // the stub's log says here rather than being taken on trust.
  const views = ghCalls().filter((line) => line.startsWith('issue view'));
  check('the stub was asked to read the issue more than once',
        url ? true : views.length >= 2,
        `${views.length} issue view call(s) — the first was refused, so a single call means no retry`);
  check('the title landed anyway', Boolean(element?.customData?.issueTitle),
        'a single transient gh failure lost the title');

  await call('/api/elements/clear', { method: 'DELETE' });
}

try {
  await main();
} catch (error) {
  console.error(`\nerror: ${error.message}`);
  failures++;
} finally {
  canvas.stop();
  if (!url) {
    await sleep(200);
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
