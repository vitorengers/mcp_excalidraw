#!/usr/bin/env node

/**
 * A card whose foundation has not landed is not startable, however old it is.
 *
 * `startableCards` filtered on content type, a URL, not being closed and being draggable,
 * and then took the oldest. Nothing in it knew that one card is built on another, so at a
 * concurrency of four the second agent could start against a tree where its foundation did
 * not exist. Measured across #270-#355: 58 dependency edges, 18 of them within four
 * positions of their dependency and one filed 25 positions before it.
 *
 * The declaration is already in the issue bodies — `Depends on #302.` — so nothing has to be
 * authored. It has to be read, and read narrowly: a parser that matches a `#302` in prose
 * silently freezes the queue, and one that matches too little silently does nothing. Section
 * 1 is therefore the longest, and it is the part worth distrusting.
 *
 * Self-contained, in the style of `check-implement-queue.mjs`: a stub `gh` answering the
 * project query and `issue view` from a fixture, a stub agent that parks until released, its
 * own canvas server, killed at the end. Nothing here talks to GitHub and nothing runs a real
 * coding agent. Run `./node_modules/.bin/tsc` first.
 *
 * The server is started through `scripts/lib/spawn-canvas.mjs`, on a port from
 * `scripts/lib/free-port.mjs` — so the `.env` beside the working directory is off and every
 * inherited `EXCALIDRAW_*` is stripped, which is what this check was already doing by hand
 * before #271 put both in one place.
 *
 * Usage: node scripts/check-implement-dependencies.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { dependenciesOf, startableCards } = await import(
  new URL('../dist/core/implement-queue.js', import.meta.url).href
);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 1. The parser, which is where the risk is ────────────────

console.log('\n1. what counts as a declared dependency');

const PARSE_CASES = [
  ['Depends on #306.', [306], 'one dependency, the shape the renderer writes'],
  ['Depends on #271, #272.', [271, 272], 'two, comma separated'],
  ['text above\n\nDepends on #326.\n\n---\n\nfooter', [326], 'surrounded by the rest of a body'],
  ['', [], 'an empty body'],
  ['Nothing here at all.', [], 'a body with no declaration'],
  ['This is a follow-up to #306 and nobody is blocked.', [], 'a bare number in prose is not a declaration'],
  ['See https://github.com/o/r/issues/306 for context.', [], 'a URL is not a declaration'],
  ['```\nDepends on #306.\n```', [], 'a fenced block is quoted, not declared'],
  ['    Depends on #306.', [], 'an indented line is a code block too'],
  ['> Depends on #306.', [], 'a quoted line is somebody else speaking'],
  ['Depends on #306, #306.', [306], 'the same number twice is one dependency'],
  ['depends on #306.', [306], 'case is not load-bearing'],
];

for (const [body, expected, name] of PARSE_CASES) {
  let got;
  try { got = dependenciesOf(body); } catch (error) { got = `threw: ${error.message}`; }
  const ok = Array.isArray(got)
    && got.length === expected.length
    && expected.every((n, i) => got[i] === n);
  check(name, ok, `expected [${expected}], got ${JSON.stringify(got)}`);
}

// ─── 2. The filter, which stays pure ──────────────────────────

console.log('\n2. a blocked number is not startable, and nothing else changes');

const card = (number, extra = {}) => ({
  itemId: `PVTI_${number}`,
  contentType: 'Issue',
  number,
  title: `Issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  state: 'OPEN',
  createdAt: `2026-07-${String(number - 300).padStart(2, '0')}T10:00:00Z`,
  repository: 'o/r',
  draggable: true,
  ...extra,
});

const CARDS = [card(302), card(303), card(304)];

const noneBlocked = startableCards(CARDS).map((c) => c.number);
check('with no blocked set at all, the order is what it was', String(noneBlocked) === '302,303,304', String(noneBlocked));

const withBlocked = startableCards(CARDS, new Set([303])).map((c) => c.number);
check('a blocked number is dropped and the rest keep their order', String(withBlocked) === '302,304', String(withBlocked));

const emptyBlocked = startableCards(CARDS, new Set()).map((c) => c.number);
check('an empty blocked set changes nothing', String(emptyBlocked) === '302,303,304', String(emptyBlocked));

const allBlocked = startableCards(CARDS, new Set([302, 303, 304]));
check('everything blocked yields nothing rather than throwing', allBlocked.length === 0, String(allBlocked.length));

// ─── The throwaway world ──────────────────────────────────────

const REPO = 'vitorengers/vibemaxxing';
const issueUrl = (n) => `https://github.com/${REPO}/issues/${n}`;
const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };
const day = (n) => `2026-07-${String(n).padStart(2, '0')}T10:00:00Z`;

/**
 * The board the drain is read off.
 *
 * `#302` is the oldest and startable. `#303` declares it, so it must wait however old it is.
 * `#304` declares `#999`, which is on no board here — unresolvable, and it must start rather
 * than freeze, because a declaration nothing can answer silently stopping the queue is worse
 * than the race the rule exists to stop.
 */
const ITEMS = [
  { n: 302, opt: TODO, at: day(1) },
  { n: 303, opt: TODO, at: day(2) },
  { n: 304, opt: TODO, at: day(3) },
  { n: 310, opt: DOING, at: day(8) },
  { n: 320, opt: DONE, at: day(9) },
];

const BODIES = {
  302: 'The foundation.\n\n---\n\nPart of nothing.',
  303: `Built on it.\n\n---\n\nDepends on #302.\n\n---\n\nPart of nothing.`,
  304: `Built on a card that is not here.\n\n---\n\nDepends on #999.\n\n---\n\nPart of nothing.`,
  310: 'Already moving.',
  320: 'Long done.',
};

const workDir = join(tmpdir(), `implement-deps-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');
const statePath = join(workDir, 'state.json');

/** `closed` names the numbers the stub should report CLOSED — rewritten mid-run. */
writeFileSync(statePath, JSON.stringify({ closed: [] }), 'utf8');

const projectFixture = (closed) => ({
  data: {
    owner: {
      projectV2: {
        id: 'PVT_project5',
        title: 'project 5',
        url: 'https://github.com/users/someone/projects/5',
        field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
        items: {
          pageInfo: { hasNextPage: false },
          nodes: ITEMS.map(({ n, opt, at }) => ({
            id: `PVTI_${n}`,
            fieldValueByName: { optionId: opt.id, name: opt.name },
            content: {
              __typename: 'Issue',
              number: n,
              title: `Issue ${n}`,
              url: issueUrl(n),
              createdAt: at,
              state: closed.includes(n) ? 'CLOSED' : 'OPEN',
              repository: { nameWithOwner: REPO },
            },
          })),
        },
      },
    },
  },
});

writeFileSync(join(workDir, 'bodies.json'), JSON.stringify(BODIES), 'utf8');

/**
 * A `gh` that answers the project query and `issue view` from files on disk, so the fixture
 * can be rewritten mid-run: closing #302 is what section 4 does, and it has to be visible to
 * a stub that was started long before.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
const read = (name) => JSON.parse(readFileSync(join(workDir, name), 'utf8'));
const line = process.argv.slice(2).join(' ');

if (line.includes('graphql')) {
  process.stdout.write(JSON.stringify(read('project.json')));
} else if (line.includes('issue view')) {
  const number = Number((line.match(/issues\\/(\\d+)/) ?? line.match(/issue view (\\d+)/) ?? [])[1] ?? 0);
  process.stdout.write(JSON.stringify({
    number,
    title: 'Issue ' + number,
    body: read('bodies.json')[number] ?? '',
    state: read('state.json').closed.includes(number) ? 'CLOSED' : 'OPEN',
    url: 'https://github.com/${REPO}/issues/' + number,
    comments: [],
    stateReason: null,
    closedBy: [],
  }));
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

const writeProject = () => writeFileSync(
  join(workDir, 'project.json'),
  JSON.stringify(projectFixture(JSON.parse(readFileSync(statePath, 'utf8')).closed)),
  'utf8',
);
writeProject();

writeFileSync(agentStub, `#!/usr/bin/env node
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  appendFileSync(join(workDir, 'started.log'), number + '\\n');
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(join(workDir, 'started.log'), '', 'utf8');

const boardDir = join(workDir, 'board');
mkdirSync(boardDir, { recursive: true });
writeFileSync(join(boardDir, 'board.config.json'), JSON.stringify({
  name: 'board-deps',
  repo: REPO,
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'board-deps', path: boardDir.replace(/\\/g, '/') }],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const QUEUE_MS = 400;
let serverOutput = '';

const child = startCanvas({
  port,
  // No `.env` here either, belt and braces: the helper turns dotenv off, and this working
  // directory has no file for it to read.
  cwd: workDir,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '4',
    EXCALIDRAW_IMPLEMENT_QUEUE_MS: String(QUEUE_MS),
    EXCALIDRAW_ISSUE_MEMO_MS: '1',
  },
}).child;
child.stdout.on('data', (c) => { serverOutput += c.toString(); });
child.stderr.on('data', (c) => { serverOutput += c.toString(); });

const started = () => readFileSync(join(workDir, 'started.log'), 'utf8').split('\n').filter(Boolean);

const call = async (path, options = {}) => {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=board-deps`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/**
 * The queue state once a pass has run that started nothing.
 *
 * A fixed sleep was reading whichever pass happened to be last, and the pass that starts the
 * foundation reports `started` — so this check failed about one run in several on a machine
 * under load, claiming the queue had not blocked anything when it simply had not got there
 * yet. A check that has to be re-run to be believed is worse than one that fails.
 */
async function settledPass() {
  let state = await call('/api/implement');
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((state.body?.queue?.lastPass?.reason ?? 'started') !== 'started') return state;
    await sleep(QUEUE_MS);
    state = await call('/api/implement');
  }
  return state;
}

try {
  for (let attempt = 0; ; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    if (attempt > 120) throw new Error(`the canvas server never answered:\n${serverOutput}`);
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up */ }
    await sleep(100);
  }

  console.log('\n3. the queue leaves a dependent alone while its foundation is open');

  await call('/api/implement/queue', { method: 'POST', body: JSON.stringify({ enabled: true }) });
  await sleep(QUEUE_MS * 6);

  const first = started();
  check('the foundation started', first.includes('302'), first.join(','));
  check('the card built on it did not, though the cap had room', !first.includes('303'), first.join(','));
  check('the card whose dependency is on no board did start', first.includes('304'), first.join(','));

  const state = await settledPass();
  const pass = state.body?.queue?.lastPass ?? {};
  check('the pass says it blocked something', pass.reason === 'blocked', JSON.stringify(pass));
  check('and names what it is waiting on', String(pass.detail ?? '').includes('303') && String(pass.detail ?? '').includes('302'), String(pass.detail ?? ''));
  check('a blocked card is not a stalled queue', state.body?.queue?.stalled !== true, JSON.stringify(state.body?.queue ?? {}));

  console.log('\n4. a foundation that settled without closing is a deadlock, not waiting');

  // Releasing the agent without closing the issue is the shape #326 was in: a settled record
  // against an issue that is still open. `dispatchQueue` skips any issue that already has a
  // record, so nothing will ever start #302 again and #303 can never be unblocked — but the
  // pass reads identically to case 3, where the foundation had simply not run yet. For two
  // hours on 2026-08-01 that difference was the difference between a queue nobody needed to
  // look at and seven cards frozen behind one bad record.
  writeFileSync(join(workDir, 'release-302'), '', 'utf8');
  await sleep(QUEUE_MS * 10);

  const settled = await call(`/api/implement?url=${encodeURIComponent(issueUrl(302))}`);
  check('the foundation has a settled record', settled.body?.implement?.state
        && settled.body.implement.state !== 'running', JSON.stringify(settled.body?.implement ?? {}));
  check('and its issue is still open', !JSON.parse(readFileSync(statePath, 'utf8')).closed.includes(302));

  const stuck = await settledPass();
  const deadPass = stuck.body?.queue?.lastPass ?? {};
  check('the pass no longer calls it plain waiting', deadPass.reason !== 'blocked', JSON.stringify(deadPass));
  check('it says the queue is deadlocked', deadPass.reason === 'deadlocked', JSON.stringify(deadPass));
  check('the queue reports itself stalled', stuck.body?.queue?.stalled === true,
        JSON.stringify(stuck.body?.queue ?? {}));
  check('and the detail names the dependent and its foundation',
        String(deadPass.detail ?? '').includes('303') && String(deadPass.detail ?? '').includes('302'),
        String(deadPass.detail ?? ''));
  check('and the state of the record it cannot get past',
        /done|failed|blocked/.test(String(deadPass.detail ?? '')), String(deadPass.detail ?? ''));
  check('nothing was started by the change in reporting', !started().includes('303'), started().join(','));

  console.log('\n5. and it starts on the pass after the foundation closes');

  writeFileSync(statePath, JSON.stringify({ closed: [302] }), 'utf8');
  writeProject();
  await sleep(QUEUE_MS * 10);

  const second = started();
  check('the dependent started once its foundation closed', second.includes('303'), second.join(','));
  check('and nothing was started twice', new Set(second).size === second.length, second.join(','));
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error.message}`);
} finally {
  child.kill();
  await sleep(300);
  if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} case${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('\nall cases passed');
