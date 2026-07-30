#!/usr/bin/env node
/**
 * Checks that a read issue is remembered, and that a card's run state is not thrown away.
 *
 * The defect was that nothing remembered a read: the panel's knowledge of an issue was
 * component state, the panel is unmounted the moment nothing is selected, and the server
 * memoised nothing — so every click on a block spent a whole `gh issue view` (1.2–1.3 s on
 * the machine this was reported from) re-reading text that had not changed, and drew
 * **Implement / Fix** from "not read yet" for the whole of that second, on issues that were
 * closed or already being implemented.
 *
 * Two halves, and they fail for different reasons:
 *
 * - `resolvePanelTarget` hardcoded `implementState: null` for a mirrored card, even though
 *   the mirror had already written the run onto that very card. That one is pure, so it is
 *   checked directly.
 * - `GET /api/issue` spawned a `gh` per request. That one is checked through a running
 *   server against a stub `gh` that counts its own invocations.
 *
 * The browser half — that the second selection of a block paints its issue with no
 * *"Reading the issue…"* — is `check-issue-cache-browser.mjs`, because a panel is exactly
 * the kind of thing that compiles and does nothing.
 *
 * Self-contained: it writes a stub `gh`, starts its own canvas server against a throwaway
 * workspace, and kills it. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc`
 * first — it reads the compiled modules.
 *
 * Usage: node scripts/check-issue-cache.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function importDist(relative, what) {
  const modulePath = join(repoRoot, 'dist', relative);
  if (!existsSync(modulePath)) {
    console.error(`  FAIL  ${what} exists — dist/${relative.replace(/\\/g, '/')} not found`);
    process.exit(1);
  }
  return import(pathToFileURL(modulePath).href);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 1. A mirrored card keeps the run the mirror drew on it ───
//
// Offline, because this is the half that decides what the panel offers before any read has
// landed — which is the whole of the first second of every selection.

console.log('1. a mirrored card carries its run state into the panel');

const { resolvePanelTarget } = await importDist(join('core', 'panel-target.js'), 'the panel target resolver');
const { MIRROR_KIND } = await importDist(join('core', 'project-board-layout.js'), 'the mirror layout');
const { offersImplement } = await importDist(join('core', 'issue-appearance.js'), 'the appearance rules');

const CARD_URL = 'https://github.com/vitorengers/mcp_excalidraw/issues/9';

const cardWith = (run) => ({
  id: 'pb-c-PVTI_d',
  type: 'rectangle',
  x: 0, y: 0, width: 220, height: 60,
  customData: {
    kind: MIRROR_KIND,
    role: 'card',
    itemId: 'PVTI_d',
    issueUrl: CARD_URL,
    ...(run ? { implementState: run } : {}),
  },
});
const cardLabelOf = (card) => ({
  id: `${card.id}-label`, type: 'text', x: 8, y: 8, width: 200, height: 40,
  text: 'Being worked on', containerId: card.id,
  customData: { kind: MIRROR_KIND, role: 'card-label' },
});

for (const run of ['running', 'done', 'failed']) {
  const card = cardWith(run);
  const target = resolvePanelTarget([card, cardLabelOf(card)], [card.id]);
  check(`a card marked ${run} resolves to that state`,
        target?.issue?.implementState === run,
        `got ${JSON.stringify(target?.issue?.implementState)}`);
  // Through the label too: clicking a card almost always means clicking its text.
  const viaLabel = resolvePanelTarget([card, cardLabelOf(card)], [`${card.id}-label`]);
  check(`  and the same through its label`, viaLabel?.issue?.implementState === run,
        `got ${JSON.stringify(viaLabel?.issue?.implementState)}`);
}

const unmarked = cardWith(null);
check('a card with no run has no state invented for it',
      resolvePanelTarget([unmarked, cardLabelOf(unmarked)], [unmarked.id])?.issue?.implementState === null,
      'an unmarked card must stay unknown, not become "not running"');

const nonsense = cardWith('whatever-the-mirror-wrote');
check('and a state the mirror never writes is not passed through',
      resolvePanelTarget([nonsense, cardLabelOf(nonsense)], [nonsense.id])?.issue?.implementState === null,
      'only running, done and failed are run states');

// The point of carrying it: what the panel offers on the first paint, with no read yet.
console.log('\n2. so Implement / Fix is not offered on the first paint of a card already being worked on');
for (const run of ['running', 'done']) {
  const card = cardWith(run);
  const target = resolvePanelTarget([card, cardLabelOf(card)], [card.id]);
  check(`a ${run} card does not offer Implement / Fix before /api/issue answers`,
        offersImplement({ githubState: null, implementState: target?.issue?.implementState ?? null }) === false,
        `githubState is still null and implementState is ${JSON.stringify(target?.issue?.implementState)}`);
}
check('a card with nothing against it still offers it',
      offersImplement({
        githubState: null,
        implementState: resolvePanelTarget([unmarked, cardLabelOf(unmarked)], [unmarked.id])?.issue?.implementState ?? null,
      }) === true,
      'an untouched issue must still be implementable');

// ─── The throwaway world for the server half ──────────────────

const workDir = join(tmpdir(), `issue-cache-check-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
const projectDir = join(workDir, 'issue-cache');
mkdirSync(projectDir, { recursive: true });

const ghStub = join(workDir, 'gh-stub.mjs');
const counterPath = join(workDir, 'gh-calls.log');
const versionPath = join(workDir, 'body-version.txt');
const registryPath = join(workDir, 'workspaces.json');

writeFileSync(counterPath, '', 'utf8');
writeFileSync(versionPath, 'one', 'utf8');

// Sleeps, the way the real one does — a memo that only looks fast because the stub is
// instant would prove nothing about a click that takes a second.
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const url = args.find((candidate) => candidate.startsWith('https://')) ?? '';

if (args.includes('issue') && args.includes('view')) {
  appendFileSync(process.env.STUB_GH_COUNTER, url + '\\n');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_GH_SLEEP_MS ?? 0)));
  const version = readFileSync(process.env.STUB_GH_VERSION, 'utf8').trim();
  const number = Number(url.split('/').pop());
  process.stdout.write(JSON.stringify({
    number,
    title: 'An issue read through a stub',
    body: 'Body version ' + version + '.',
    state: number === 21 ? 'CLOSED' : 'OPEN',
    comments: [],
    stateReason: number === 21 ? 'COMPLETED' : null,
    closedByPullRequestsReferences: [],
  }));
} else if (args.includes('issue') && args.includes('comment')) {
  process.stdout.write('commented\\n');
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'issue-cache', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Issue Cache Check',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
/** Short enough that the check does not sit waiting for it, long enough to collapse a burst. */
const MEMO_MS = 4000;

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    EXCALIDRAW_ISSUE_MEMO_MS: String(MEMO_MS),
    STUB_GH_COUNTER: counterPath,
    STUB_GH_VERSION: versionPath,
    STUB_GH_SLEEP_MS: '250',
  },
}).child;
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const reads = (url) => readFileSync(counterPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim() && (!url || line.trim() === url))
  .length;

// Retried once, because `fetch` here fails at connect often enough to be worth surviving —
// the same socket-buffer exhaustion the issue reader itself retries for. A retry that hits
// the memo costs nothing, and one that misses it is counted like any other read.
const readIssue = async (url) => {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(
        `${BASE}/api/issue?workspace=issue-cache&url=${encodeURIComponent(url)}`
      );
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError;
};

const ISSUE = 'https://github.com/vitorengers/mcp_excalidraw/issues/3';
const OTHER = 'https://github.com/vitorengers/mcp_excalidraw/issues/12';

try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (attempt > 120) throw new Error(`the canvas server never answered:\n${serverLog}`);
    await sleep(100);
  }

  console.log('\n3. selecting one issue over and over costs one gh');
  const first = await readIssue(ISSUE);
  check('the first read answers', first.status === 200 && first.body?.issue?.number === 3,
        `${first.status} ${JSON.stringify(first.body).slice(0, 160)}`);
  check('and it ran gh once', reads(ISSUE) === 1, `${reads(ISSUE)} invocation(s)`);

  const repeats = [];
  for (let round = 0; round < 4; round++) repeats.push(await readIssue(ISSUE));
  check('four more selections all answer', repeats.every((read) => read.body?.issue?.number === 3),
        JSON.stringify(repeats.map((read) => read.status)));
  check('with the same body', repeats.every((read) => read.body?.issue?.body === first.body?.issue?.body),
        JSON.stringify(repeats.map((read) => read.body?.issue?.body)));
  check('and gh was still run only once', reads(ISSUE) === 1,
        `${reads(ISSUE)} invocations for five selections`);

  console.log('\n4. selections that arrive together are one read, not five');
  const burst = await Promise.all(Array.from({ length: 5 }, () => readIssue(OTHER)));
  check('every one of them answered', burst.every((read) => read.body?.issue?.number === 12),
        JSON.stringify(burst.map((read) => read.status)));
  check('on one gh', reads(OTHER) === 1, `${reads(OTHER)} invocations`);

  console.log('\n5. one issue is not served from another issue\'s answer');
  check('the second issue is its own', (await readIssue(OTHER)).body?.issue?.number === 12);
  check('and the first is still the first', (await readIssue(ISSUE)).body?.issue?.number === 3);

  console.log('\n6. what is remembered is still revalidated');
  writeFileSync(versionPath, 'two', 'utf8');
  const stale = await readIssue(ISSUE);
  check('inside the window the remembered copy is what answers',
        /version one/.test(stale.body?.issue?.body ?? ''), stale.body?.issue?.body);
  await sleep(MEMO_MS + 500);
  const fresh = await readIssue(ISSUE);
  check('past it, the new body arrives', /version two/.test(fresh.body?.issue?.body ?? ''),
        fresh.body?.issue?.body);
  check('which cost exactly one more gh', reads(ISSUE) === 2, `${reads(ISSUE)} invocations`);

  console.log('\n7. an observation posted from the board is not read back stale');
  const before = reads(ISSUE);
  // Moved on before the comment is posted, so the read-back the route makes is the only
  // thing that can produce this body — a memo left in place would answer "version two".
  writeFileSync(versionPath, 'three', 'utf8');
  const posted = await fetch(`${BASE}/api/issue/comment?workspace=issue-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: ISSUE, body: 'An observation.' }),
  });
  check('the comment was accepted', posted.ok, `got ${posted.status}`);
  const afterComment = await readIssue(ISSUE);
  check('and the next selection is served the read-back, not the copy taken before it',
        /version three/.test(afterComment.body?.issue?.body ?? ''), afterComment.body?.issue?.body);
  check('reading it back was the only extra gh', reads(ISSUE) === before + 1,
        `${before} → ${reads(ISSUE)}`);

  console.log('\n8. a run finishing or being cleared drops what was remembered');
  const beforeReset = reads(ISSUE);
  writeFileSync(versionPath, 'four', 'utf8');
  const reset = await fetch(`${BASE}/api/implement?workspace=issue-cache`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: ISSUE }),
  });
  check('the reset was accepted', reset.ok, `got ${reset.status}`);
  const afterReset = await readIssue(ISSUE);
  check('the issue is read again, because the run may have closed it',
        /version four/.test(afterReset.body?.issue?.body ?? ''), afterReset.body?.issue?.body);
  check('at the cost of one gh', reads(ISSUE) === beforeReset + 1,
        `${beforeReset} → ${reads(ISSUE)}`);

  console.log('\n9. the implement record rides along fresh, never out of the memo');
  const withRecord = await readIssue(ISSUE);
  check('a read still reports the run state', withRecord.body?.implement !== undefined,
        JSON.stringify(withRecord.body));
  check('and it costs no gh to say so', reads(ISSUE) === beforeReset + 1,
        `${reads(ISSUE)} invocations`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  if (server.exitCode === null) { try { server.kill('SIGKILL'); } catch { /* already gone */ } }
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
