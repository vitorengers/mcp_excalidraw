#!/usr/bin/env node
/**
 * Checks that a research run's result survives the browser's next autosync.
 *
 * #118: three blocks on the board produced #94, #95 and #96 and kept no record of it. They
 * still carry the dashed first-stage outline, no `issueState` and no `issueUrl` — so nothing
 * can retire them, nothing can run them again without opening a second issue, and the board
 * says three observations are waiting to be researched when all three were.
 *
 * **What was measured.** A real board was driven through a whole run with both sides
 * instrumented (`check-issue-state-sync-browser.mjs` is that measurement, kept as a check).
 * The numbers are the finding: with the run in flight the browser held the block at
 * `version` 8 while the store held it at 3, and stayed there for two seconds. Excalidraw
 * bumps a version on every keystroke, drag and nudge; the server bumps it once per state
 * change. So the browser is routinely *ahead*, and `POST /api/elements/sync` — which merges
 * whole elements, higher version wins — hands it the whole element when it is. Everything
 * the run wrote goes back to whatever that browser last knew, which for a block whose run
 * started while the reader was still working on it is the pristine draft.
 *
 * That is the payload case 1 sends: the block exactly as the browser had it before the run,
 * at a version five ahead of the store's. Against the unfixed code the store takes it whole
 * and `issueUrl` is gone — the defect, reproduced with both versions printed. Against the
 * fix the server's own fields are carried over and the browser's geometry still lands, which
 * is the other half: this must not become "the store ignores the browser".
 *
 * Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas server on a
 * free port against a throwaway workspace, and kills it. Run `./node_modules/.bin/tsc`
 * first — it runs `dist/server.js`.
 *
 * Usage: node scripts/check-issue-state-sync.mjs
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-state-sync-'));
const projectDir = join(workDir, 'state-check');
mkdirSync(projectDir, { recursive: true });

const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const registryPath = join(workDir, 'workspaces.json');

const REPO = 'vitorengers/mcp_excalidraw';
const ISSUE_URL = `https://github.com/${REPO}/issues/94`;
const ISSUE_TITLE = 'The terminal should have tabs on top';
const OTHER_ISSUE_URL = `https://github.com/${REPO}/issues/95`;

// `gh issue view --json` is the only call these cases make. The project-board reader is not
// configured here, so nothing asks for the graphql fixture.
writeFileSync(stubGhPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args.find((value) => value.indexOf('https://github.com/') === 0) || '';
if (args.includes('issue') && args.includes('view')) {
  const number = Number(url.split('/').pop());
  process.stdout.write(JSON.stringify({
    number,
    title: number === 94 ? ${JSON.stringify(ISSUE_TITLE)} : 'Another researched observation',
    body: 'Investigated.', state: 'OPEN', comments: [],
    stateReason: null, closedByPullRequestsReferences: [],
  }) + '\\n');
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

writeFileSync(stubAgentPath, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('investigated\\n');
  process.stdout.write('${ISSUE_URL}\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'state-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'State Check', repo: REPO,
}), 'utf8');

const PORT = 35800 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const WS = 'state-check';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT), HOST: '127.0.0.1', LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
    EXCALIDRAW_ISSUE_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}"`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${WS}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const stored = async (id) => (await call(`/api/elements/${id}`)).body.element ?? null;

/** A block with an observation written into a label bound to it, the way the `+` leaves one. */
async function dropBlock(y, observation, customData = {}) {
  const block = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 100, y, width: 400, height: 120,
      // The first stage, as the library ships it: the notes column's hue since #195.
      strokeColor: '#1971c2', backgroundColor: '#e7f5ff', strokeStyle: 'dashed',
      customData: {
        kind: 'issue', projectBoardDraft: true,
        sectionOptionId: 'canvas:notes', draftCreatedAt: 1785164170251,
        ...customData,
      },
    }),
  });
  const id = block.body.element.id;
  const label = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({ type: 'text', x: 110, y: y + 10, text: observation, containerId: id }),
  });
  return { id, labelId: label.body.element.id };
}

/** What a browser posts: its whole scene, elements as it holds them. */
const sync = (elements) => call('/api/elements/sync', {
  method: 'POST',
  body: JSON.stringify({ elements, timestamp: new Date().toISOString() }),
});

/**
 * Wait for the block to settle.
 *
 * On the title rather than on the state: `issueState` turns `created` one write before the
 * run reads the issue back, so waiting on the state alone reads the block halfway through
 * the ending and blames the merge for a race in this script.
 */
async function waitForIssue(id, tries = 60) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const element = await stored(id);
    if (element?.customData?.issueTitle) return element;
    await sleep(250);
  }
  return await stored(id);
}

try {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not yet */ }
    await sleep(250);
  }

  // ── 1. the crossing ─────────────────────────────────────────
  console.log('1. a payload built before the run is applied after it');
  const observation = 'The terminal should have tabs on top so I can alternate between them.';
  const { id, labelId } = await dropBlock(100, observation);

  // The copy the browser had before the run — the four fields the `+` writes, and nothing
  // else. This is not invented: it is what the three blocks in #118 still carry today.
  const beforeTheRun = await stored(id);
  const pristine = JSON.parse(JSON.stringify(beforeTheRun.customData));
  check('the block starts as a draft, with nothing the server wrote on it',
        Object.keys(pristine).sort().join(',') === 'draftCreatedAt,kind,projectBoardDraft,sectionOptionId',
        JSON.stringify(pristine));

  const started = await call(`/api/issue-block/${id}`, { method: 'POST' });
  check('the run is accepted', started.status === 202, `got ${started.status} ${JSON.stringify(started.body)}`);
  const afterTheRun = await waitForIssue(id);
  check('the run recorded its issue on the block',
        afterTheRun?.customData?.issueUrl === ISSUE_URL,
        `state=${afterTheRun?.customData?.issueState} url=${afterTheRun?.customData?.issueUrl}`);

  // Five ahead, which is what six arrow keys during a run measured: the browser owns the
  // number, the server spends one of them per state change.
  const serverVersion = afterTheRun.version ?? 0;
  const browserVersion = serverVersion + 5;
  console.log(`   store holds v=${serverVersion}; the browser posts v=${browserVersion}`);
  const crossing = await sync([{
    ...beforeTheRun,
    customData: pristine,
    // What the reader really did in those five versions, and what must still land.
    x: 640, y: 260,
    version: browserVersion,
    versionNonce: 1,
  }]);
  check('the sync is accepted', crossing.status === 200, `got ${crossing.status}`);

  const afterTheSync = await stored(id);
  check('the issue URL survives a browser copy that outranks it',
        afterTheSync?.customData?.issueUrl === ISSUE_URL,
        `url=${afterTheSync?.customData?.issueUrl} — the store took the browser's whole element`);
  check('and so does the state that says an issue exists',
        afterTheSync?.customData?.issueState === 'created',
        `state=${afterTheSync?.customData?.issueState}`);
  check('and the title the run read back',
        afterTheSync?.customData?.issueTitle === ISSUE_TITLE,
        `title=${afterTheSync?.customData?.issueTitle}`);
  check('the block is still drawn as one with an issue behind it',
        afterTheSync?.strokeStyle === 'solid' && afterTheSync?.strokeColor === '#1864ab',
        `strokeStyle=${afterTheSync?.strokeStyle} strokeColor=${afterTheSync?.strokeColor}`);
  // The other half. A merge that answered #118 by ignoring the browser would break the
  // thing the sync exists for.
  check('the move the browser really made still lands',
        afterTheSync?.x === 640 && afterTheSync?.y === 260,
        `x=${afterTheSync?.x} y=${afterTheSync?.y}`);
  check('and the version it posted is kept, so the next reconciliation still works',
        afterTheSync?.version === browserVersion, `version=${afterTheSync?.version}`);

  // ── 2. mid-run ──────────────────────────────────────────────
  console.log('\n2. the same crossing over the write that precedes the run');
  // Exactly what a restart leaves behind, and what the middle of a run looks like on the
  // element: `running` written, nothing else yet.
  const midRun = await dropBlock(400, 'Switching boards loses the terminal transcript.',
                                 { draftCreatedAt: 1785165023962, issueState: 'running' });
  const running = await stored(midRun.id);
  check('the block is running', running?.customData?.issueState === 'running',
        `state=${running?.customData?.issueState}`);
  await sync([{
    ...running,
    customData: { kind: 'issue', projectBoardDraft: true, sectionOptionId: 'canvas:notes',
                  draftCreatedAt: 1785165023962 },
    version: (running.version ?? 0) + 4,
    versionNonce: 1,
  }]);
  const stillRunning = await stored(midRun.id);
  check('a running block does not go back to being a draft',
        stillRunning?.customData?.issueState === 'running',
        `state=${stillRunning?.customData?.issueState} — the block would look like it never ran`);

  // ── 3. the same rule, backwards ─────────────────────────────
  console.log('\n3. and the browser cannot put back what the server cleared');
  const reset = await call(`/api/issue-block/${midRun.id}`, { method: 'DELETE' });
  check('the stuck run is reset', reset.status === 200, `got ${reset.status}`);
  const cleared = await stored(midRun.id);
  check('the state is gone from the store', !cleared?.customData?.issueState,
        `state=${cleared?.customData?.issueState}`);
  await sync([{
    ...cleared,
    customData: { ...cleared.customData, issueState: 'running' },
    version: (cleared.version ?? 0) + 3,
    versionNonce: 1,
  }]);
  const stillClear = await stored(midRun.id);
  check('a browser still holding the stale state does not reinstate it',
        !stillClear?.customData?.issueState,
        `state=${stillClear?.customData?.issueState} — the reset would be undone on the next autosync`);

  // ── 4. inert everywhere else ────────────────────────────────
  console.log('\n4. everything that is not one of these fields is still the browser\'s');
  const plain = await call('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 900, width: 50, height: 50,
      customData: { kind: 'docs', docKey: 'terminal.md' },
    }),
  });
  const plainId = plain.body.element.id;
  const held = await stored(plainId);
  await sync([{ ...held, customData: { kind: 'docs', docKey: 'workspaces.md' },
                width: 90, version: (held.version ?? 0) + 1, versionNonce: 1 }]);
  const plainAfter = await stored(plainId);
  check('a shape the server never wrote on syncs whole, customData and all',
        plainAfter?.customData?.docKey === 'workspaces.md' && plainAfter?.width === 90,
        JSON.stringify({ customData: plainAfter?.customData, width: plainAfter?.width }));

  // ── 5. the way back ─────────────────────────────────────────
  console.log('\n5. a block that lost its state has a way back');
  const lost = await dropBlock(1200, 'Research runs sometimes keep no record of their issue.');
  const orphan = await stored(lost.id);
  check('nothing else can touch it: the reset is for a running block, and this is not',
        !orphan?.customData?.issueState, `state=${orphan?.customData?.issueState}`);

  const badShape = await call(`/api/issue-block/${plainId}/adopt`, {
    method: 'POST', body: JSON.stringify({ issueUrl: ISSUE_URL }),
  });
  check('a shape that is not an issue block is refused', badShape.status === 400,
        `got ${badShape.status} ${JSON.stringify(badShape.body)}`);

  const badUrl = await call(`/api/issue-block/${lost.id}/adopt`, {
    method: 'POST', body: JSON.stringify({ issueUrl: 'https://example.com/nope' }),
  });
  check('so is anything that is not the URL of a GitHub issue', badUrl.status === 400,
        `got ${badUrl.status} ${JSON.stringify(badUrl.body)}`);

  const adopted = await call(`/api/issue-block/${lost.id}/adopt`, {
    method: 'POST', body: JSON.stringify({ issueUrl: OTHER_ISSUE_URL }),
  });
  check('the block is told which issue it already produced', adopted.status === 200,
        `got ${adopted.status} ${JSON.stringify(adopted.body)}`);
  const recovered = await stored(lost.id);
  check('and now carries it, exactly as a recorded run would have left it',
        recovered?.customData?.issueUrl === OTHER_ISSUE_URL
        && recovered?.customData?.issueState === 'created'
        && Boolean(recovered?.customData?.issueTitle),
        JSON.stringify(recovered?.customData));
  check('drawn as a block with an issue behind it',
        recovered?.strokeStyle === 'solid', `strokeStyle=${recovered?.strokeStyle}`);
  check('the observation that produced it is kept',
        typeof recovered?.customData?.observation === 'string'
        && recovered.customData.observation.includes('keep no record'),
        `observation=${recovered?.customData?.observation}`);
  const labelNow = await stored(lost.labelId);
  check('and the label reads as the issue rather than the observation',
        (labelNow?.text ?? '').includes('Another researched observation'),
        `label=${JSON.stringify(labelNow?.text)}`);

  console.log('\n6. adopting is not a second way to open an issue');
  const secondRun = await call(`/api/issue-block/${lost.id}`, { method: 'POST' });
  check('the adopted block refuses a research run, the way a created one does',
        secondRun.status === 409, `got ${secondRun.status}`);
  const twice = await call(`/api/issue-block/${lost.id}/adopt`, {
    method: 'POST', body: JSON.stringify({ issueUrl: ISSUE_URL }),
  });
  check('and refuses to be pointed at a different issue',
        twice.status === 409, `got ${twice.status}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}\n${serverLog}`);
} finally {
  if (server.exitCode === null) { try { server.kill('SIGKILL'); } catch { /* gone */ } }
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
