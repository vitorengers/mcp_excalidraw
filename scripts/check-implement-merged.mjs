#!/usr/bin/env node
/**
 * Checks that a run is only recorded `done` when its pull request actually merged.
 *
 * `done` used to mean "a pull request URL appeared somewhere in the agent's stdout", which is a
 * fact about stdout rather than about the repository. On 2026-07-31 two runs out of eight —
 * issues #314 and #315 — opened a pull request, never merged it, printed the URL and exited 0.
 * Both were recorded `done` while their pull requests stayed open, their issues stayed open, and
 * their cards stayed in In Progress. The board reported a success and work-in-flight for the same
 * run at the same time.
 *
 * So the cases here are about what the server does *after* the agent exits: it asks GitHub what
 * became of the pull request, and the answer decides the record. Three of them matter more than
 * the rest.
 *
 * **A `gh` that cannot answer must leave the outcome alone.** A verification that turns a blip
 * into a failure would be worse than no verification: it invents defeats for runs that won.
 *
 * **A pull request deliberately left open is not a failure.** The implement prompt tells an agent
 * to leave one open and stop when it cannot reconcile a conflict, so that outcome is correct
 * behaviour and has to be recorded as its own thing — `blocked` — or the next feature to read
 * this signal will send a second agent to force a merge the first one refused on purpose.
 *
 * **The URL survives.** The old failure branch wrote `url: null`, so a board that had just been
 * told a pull request exists threw away where it was.
 *
 * Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas server on a port
 * the kernel hands out, and kills it. Nothing here talks to GitHub, nothing runs a real coding
 * agent, and nothing needs a browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-merged.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const REPO = 'vitorengers/vibemaxxing';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;
/** The stub agent derives its pull request from the issue, so a case is one number. */
const pullUrl = (number) => `https://github.com/${REPO}/pull/${1000 + number}`;

// ─── The stubs ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-implement-merged-${process.pid}`);
const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const pullsPath = join(workDir, 'pulls.json');
const logPath = join(workDir, 'gh-calls.log');
const registryPath = join(workDir, 'workspaces.json');
const boardDir = join(workDir, 'board');

mkdirSync(boardDir, { recursive: true });

/**
 * What GitHub says about each pull request, by number.
 *
 * `refuse` is a `gh` that exits non-zero, which is the blip case rather than a fourth answer:
 * the point of that case is that nothing is learned, not that something bad was learned.
 */
const PULLS = {
  [1000 + 31]: { state: 'MERGED', mergedAt: '2026-07-31T10:00:12Z' },
  [1000 + 32]: { state: 'OPEN', mergedAt: null },
  [1000 + 33]: { state: 'CLOSED', mergedAt: null },
  [1000 + 34]: { refuse: true },
  [1000 + 35]: { state: 'OPEN', mergedAt: null },
};

/** A `gh` that answers for a pull request and logs every call. */
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.STUB_GH_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'pr' && args[1] === 'view') {
  const pulls = JSON.parse(readFileSync(process.env.STUB_GH_PULLS, 'utf8'));
  const number = (args[2] || '').split('/').pop();
  const answer = pulls[number];
  if (!answer) {
    process.stderr.write('stub gh: no such pull request ' + args[2] + '\\n');
    process.exit(1);
  }
  if (answer.refuse) {
    process.stderr.write('dial tcp: connect: connection reset by peer\\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    url: args[2], state: answer.state, mergedAt: answer.mergedAt,
  }) + '\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/**
 * An "agent" that ends the way the real ones did: it prints a pull request URL and exits 0.
 *
 * The issue number is read out of the prompt on stdin, so one stub serves every case and the
 * pull request it names is derivable from the case rather than configured beside it.
 *
 * `STUB_AGENT_SAY` is the marker an agent prints when it is stopping deliberately, and
 * `STUB_AGENT_SILENT` is the run that produced no pull request at all.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk.toString(); });
process.stdin.on('end', () => {
  if (process.env.STUB_AGENT_SILENT === '1') {
    process.stdout.write('I could not get anywhere with this.\\n');
    return;
  }
  const issue = (prompt.match(/issues\\/(\\d+)/) || [])[1];
  const url = 'https://github.com/${REPO}/pull/' + (1000 + Number(issue));
  process.stdout.write('worked on ' + issue + '\\n');
  if (process.env.STUB_AGENT_SAY) process.stdout.write(process.env.STUB_AGENT_SAY + ' ' + url + '\\n');
  else process.stdout.write(url + '\\n');
});
`, 'utf8');

writeFileSync(pullsPath, JSON.stringify(PULLS), 'utf8');
writeFileSync(logPath, '', 'utf8');

/**
 * One board, and deliberately one with no `githubProject`.
 *
 * A project would put board reads and card moves into the same `gh` log this check reads, and
 * the question here is about one call: what the server asked about the pull request.
 */
writeFileSync(join(boardDir, 'board.config.json'), JSON.stringify({
  name: 'board', repo: REPO,
}), 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'board', path: boardDir.replace(/\\/g, '/') }],
}), 'utf8');

// ─── The server ───────────────────────────────────────────────

const serverPath = join(repoRoot, 'dist', 'server.js');
if (!existsSync(serverPath)) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let child = null;
let serverOutput = '';

/**
 * Started once per case, because what the stub agent does is set in its environment.
 *
 * The alternative — a control file the stub reads per invocation, as the other implement checks
 * use — buys nothing here: no case needs the agent to change behaviour while a run is in flight.
 */
async function startCanvas(env = {}) {
  child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}" -p`,
      EXCALIDRAW_IMPLEMENT_CONCURRENCY: '0',
      STUB_GH_PULLS: pullsPath,
      STUB_GH_LOG: logPath,
      ...env,
    },
  }).child;
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();
}

async function stopCanvas() {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  child = null;
  // The port has to come back before the next case binds it.
  await sleep(300);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${serverOutput}`);
}

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const ghCalls = () => readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const resetLog = () => writeFileSync(logPath, '', 'utf8');

/** Wait for a run to stop being `running`, and give back the whole record. */
async function settle(url) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const record = (await call(`/api/implement?workspace=board&url=${encodeURIComponent(url)}`))
      .body.implement;
    if (record?.state && record.state !== 'running') return record;
    await sleep(100);
  }
  return { state: 'running' };
}

async function run(number) {
  resetLog();
  const started = await call('/api/implement?workspace=board', {
    method: 'POST',
    body: JSON.stringify({ url: issueUrl(number) }),
  });
  if (started.status !== 202) throw new Error(`starting #${number} answered ${started.status}`);
  return settle(issueUrl(number));
}

try {
  console.log('1. a pull request that merged is still done');
  // Green before this change and after it: this is the half that must not move.
  await startCanvas();
  const merged = await run(31);
  check('state is done', merged.state === 'done', JSON.stringify(merged));
  check('the pull request is on the record', merged.url === pullUrl(31), JSON.stringify(merged));
  check('with no error', !merged.error, String(merged.error));
  const asked = ghCalls().find((args) => args[0] === 'pr' && args[1] === 'view');
  check('gh was asked about that pull request', asked?.[2] === pullUrl(31), JSON.stringify(ghCalls()));

  console.log('\n2. a pull request left open is not done');
  const open = await run(32);
  check('state is not done', open.state !== 'done', JSON.stringify(open));
  check('state is failed', open.state === 'failed', JSON.stringify(open));
  check('the pull request is still on the record', open.url === pullUrl(32), JSON.stringify(open));
  check('and the error names it', String(open.error).includes(pullUrl(32)), String(open.error));

  console.log('\n3. a pull request closed without merging is not done either');
  const closed = await run(33);
  check('state is failed', closed.state === 'failed', JSON.stringify(closed));
  check('the pull request is on the record', closed.url === pullUrl(33), JSON.stringify(closed));

  console.log('\n4. a gh that cannot answer leaves the outcome alone');
  // The rule that keeps this from being worse than no verification at all.
  const blip = await run(34);
  check('state is done, exactly as before this existed', blip.state === 'done', JSON.stringify(blip));
  check('the pull request is on the record', blip.url === pullUrl(34), JSON.stringify(blip));
  check('gh was asked and gave up', ghCalls().filter((a) => a[0] === 'pr').length >= 1,
        JSON.stringify(ghCalls()));
  await stopCanvas();

  console.log('\n5. a run that stopped deliberately is blocked, not failed');
  await startCanvas({ STUB_AGENT_SAY: 'NEEDS A PERSON:' });
  const escalated = await run(35);
  check('state is blocked', escalated.state === 'blocked', JSON.stringify(escalated));
  check('not failed', escalated.state !== 'failed', JSON.stringify(escalated));
  check('not done either', escalated.state !== 'done', JSON.stringify(escalated));
  check('the pull request is on the record', escalated.url === pullUrl(35), JSON.stringify(escalated));
  await stopCanvas();

  console.log('\n6. a run that produced no pull request asks gh nothing');
  await startCanvas({ STUB_AGENT_SILENT: '1' });
  const silent = await run(36);
  check('state is failed, as it always was', silent.state === 'failed', JSON.stringify(silent));
  check('no url', !silent.url, String(silent.url));
  await sleep(300);
  // Scoped to the pull request, not to `gh` as a whole: the server also runs `gh --version`
  // and `gh auth status` at startup (#307's preflight), which has nothing to do with a run
  // and would make this assertion fail for being about the wrong thing.
  check('and no pull request was asked about',
        ghCalls().filter((args) => args[0] === 'pr').length === 0, JSON.stringify(ghCalls()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
