#!/usr/bin/env node
/**
 * Checks that a *research* run says how long it has been going, and how much it has spent
 * when the agent is willing to say.
 *
 * The implement agent got both halves in #67. The research agent shares `runAgent` and got
 * neither: `markState('running')` wrote a state and no instant, `runIssueAgent` passed no
 * `onUsage`, and the only thing the panel had to show for a run was one fixed sentence that
 * never changed for its whole length. That is the same complaint #67 was opened about, one
 * agent over — nothing is wrong, and there is no way to tell that from wedged.
 *
 * Modelled on `check-implement-progress.mjs`, and the two halves have different answers here
 * for the same reasons they do there:
 *
 *  - **Elapsed time is unconditional.** The block carries `issueStartedAt` and, once it
 *    settles, `issueEndedAt`; the clock ticks in the browser from the first of them. So the
 *    case that matters most is the one about `version`: a server writing the seconds onto the
 *    shape would bump every running block's version once a second and churn every export. The
 *    check watches a version across a span of real time and requires it to stand still while
 *    the elapsed time derived from it advances.
 *  - **Token counts are opt-in**, because they can only come from the agent reporting them in
 *    a machine-readable stream, and the agent command belongs to whoever starts the board. A
 *    command that does not ask for a stream must behave exactly as it did before — no figures,
 *    and the same prompt, byte for byte.
 *
 * The figures cannot go on the element: they change throughout a run, so writing them to a
 * shape would broadcast an update every time. They go on an in-memory record instead, which
 * the panel polls at `GET /api/issue-block/:id/run` — and that record has to **outlive** the
 * run, because the panel's last read happens after the run settles. A record deleted at the
 * end would lose the total at exactly the moment it became worth reading.
 *
 * The recreate run — an issue researched again — is the same seam and is checked with it.
 *
 * Self-contained: it builds a throwaway workspace, writes a stub agent that streams NDJSON
 * shaped like `claude -p --output-format stream-json --verbose`, stubs `gh`, starts its own
 * canvas servers on free ports and kills them. Nothing here talks to GitHub or to an agent.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-issue-progress.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An ISO timestamp the browser could actually build a clock out of. */
function parsedTime(value) {
  if (typeof value !== 'string' || !value) return null;
  const when = Date.parse(value);
  return Number.isFinite(when) ? when : null;
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-progress-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const REPO = 'vitorengers/mcp_excalidraw';
const issue = (n) => `https://github.com/${REPO}/issues/${n}`;

/** No `githubProject`, so the mirror stays dormant and no `gh` is spent moving a card. */
function makeProject(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'),
    JSON.stringify({ name, repo: REPO }), 'utf8');
  return dir;
}

const plainDir = makeProject('plain');
const streamedDir = makeProject('streamed');

/**
 * Stands in for the research agent, in both of the shapes an operator can configure.
 *
 * Given `--output-format stream-json` on its own command line it writes NDJSON, including the
 * detail that makes naive counting wrong: **one message arrives more than once** as it
 * streams, partial first and then final, so a total that adds up every event it sees is
 * roughly double. Without that flag it writes plain text, which is today's default and must
 * stay exactly as it is.
 *
 * Which run it is answering for is read out of the prompt. A rewrite names the issue —
 * *The issue to rewrite: .../issues/N* — and a first investigation does not, so the
 * observations below carry a number of their own for it to find. Either way it waits to be
 * released, so a run can be looked at while it is live.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const streaming = process.argv.join(' ').includes('stream-json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const rewriting = /issues\\/(\\d+)/.exec(input);
  const number = rewriting ? rewriting[1] : (/observation (\\d+)/.exec(input) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'prompt-' + number + '.txt'), input, 'utf8');
  writeFileSync(join(workDir, 'run-' + number), '', 'utf8');

  const url = 'https://github.com/${REPO}/issues/' + number;
  const failing = existsSync(join(workDir, 'fail-' + number));
  const waitFor = async (marker) => {
    for (let attempt = 0; attempt < 1800; attempt++) {
      if (existsSync(join(workDir, marker + '-' + number))) return;
      await sleep(100);
    }
  };

  if (!streaming) {
    await waitFor('release');
    process.stdout.write(failing ? 'I could not work out what this is about.\\n' : url + '\\n');
    return;
  }

  const line = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  const usage = (input_tokens, cache_creation, cache_read, output_tokens) => ({
    input_tokens,
    cache_creation_input_tokens: cache_creation,
    cache_read_input_tokens: cache_read,
    output_tokens,
  });
  /**
   * Reasoning, in the shape Claude Code actually publishes it: an event of its own, with a
   * running total that restarts at every assistant turn. The deltas are what accumulate.
   */
  const thinking = (estimated_tokens, estimated_tokens_delta) =>
    line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens, estimated_tokens_delta });

  line({ type: 'system', subtype: 'init', session_id: 'stub' });
  thinking(30, 30);
  // The same id twice: the partial, then the same message finished. 4+10+20 and 10+30+60.
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(4, 10, 20, 3) } });
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(10, 30, 60, 10) } });
  thinking(80, 50);
  await waitFor('release');
  // The run's own final accounting, and the URL inside a JSON string rather than on a line
  // of its own — which is the other thing that could quietly break.
  line({
    type: 'result',
    subtype: 'success',
    result: failing ? 'I could not work out what this is about.' : url,
    usage: usage(20, 30, 150, 55),
  });
});
`, 'utf8');

/**
 * Stands in for `gh`, so the end of a successful run has an issue to read back.
 *
 * Only two calls ever reach it: `issue view` when a created block adopts its title, and
 * `issue comment` when a rewrite posts the observations it was given. Anything else is a
 * call this feature did not mean to make, and saying so beats answering it.
 */
writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const number = (/issues\\/(\\d+)/.exec(args.join(' ')) ?? [])[1] ?? '0';

if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: Number(number),
    title: 'Researched issue ' + number,
    body: 'The body of issue ' + number,
    state: 'OPEN',
    comments: [],
    stateReason: null,
    closedByPullRequestsReferences: [],
  }));
} else if (args[0] === 'issue' && args[1] === 'comment') {
  process.stdin.resume();
  process.stdin.on('end', () => { process.stdout.write('commented\\n'); });
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'plain', path: plainDir.replace(/\\/g, '/') },
    { id: 'streamed', path: streamedDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];

function startCanvas(port, agentCommand) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_ISSUE_AGENT: agentCommand,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

const stubPath = agentStub.replace(/\\/g, '/');
const port = 37400 + (process.pid % 150);
const streamedPort = port + 1;
const BASE = `http://127.0.0.1:${port}`;
const STREAMED_BASE = `http://127.0.0.1:${streamedPort}`;

async function call(base, workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const canvas = (path, options) => call(BASE, 'plain', path, options);
const streamed = (path, options) => call(STREAMED_BASE, 'streamed', path, options);

const mark = (marker, n) => writeFileSync(join(workDir, `${marker}-${n}`), '', 'utf8');

/** A draft block carrying the observation the run is about. */
async function blockFor(fn, n) {
  const created = await fn('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: n, width: 260, height: 120,
      text: `observation ${n}`,
      customData: { kind: 'issue', issueState: 'draft' },
    }),
  });
  return created.body?.element?.id ?? '';
}

const research = (fn, id) => fn(`/api/issue-block/${id}`, { method: 'POST' });

async function runRecord(fn, id) {
  return (await fn(`/api/issue-block/${id}/run`)).body?.run ?? null;
}

const elementNow = async (fn, id) => (await fn(`/api/elements/${id}`)).body?.element ?? null;

async function until(predicate, what, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return null;
}

/** Wait for a block to leave `running`, so a later assertion is not racing it. */
async function settledBlock(fn, id, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const element = await elementNow(fn, id);
    const state = element?.customData?.issueState;
    if (state && state !== 'running') return element;
    await sleep(150);
  }
  return null;
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port, `node "${stubPath}" -p`);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. a research run in flight says when it started');
  const blockId = await blockFor(canvas, 301);
  const before = Date.now();
  const accepted = await research(canvas, blockId);
  check('the run was accepted', accepted.status === 202,
        `got ${accepted.status} ${JSON.stringify(accepted.body)}`);

  const live = await until(async () => {
    const found = await runRecord(canvas, blockId);
    return found?.state === 'running' ? found : null;
  }, 'the research run to be recorded as running');

  const startedAt = parsedTime(live?.startedAt);
  check('startedAt is there and parses', startedAt !== null, `startedAt=${live?.startedAt}`);
  check('and it is when the run actually started',
        startedAt !== null && startedAt >= before - 1000 && startedAt <= Date.now() + 1000,
        `startedAt=${live?.startedAt}, asked at ${new Date(before).toISOString()}`);
  check('nothing has ended yet', live?.endedAt == null, `endedAt=${live?.endedAt}`);

  console.log('\n2. a block with no run has no record at all');
  const idle = await blockFor(canvas, 999);
  const untouched = await runRecord(canvas, idle);
  check('no record for a block never researched', untouched === null, JSON.stringify(untouched));

  console.log('\n3. the block carries the start time, and reads without the network');
  const atRest = await until(async () => {
    const element = await elementNow(canvas, blockId);
    return element?.customData?.issueState === 'running' ? element : null;
  }, 'the block to be marked running');
  check('issueStartedAt is on the element',
        parsedTime(atRest?.customData?.issueStartedAt) !== null,
        `customData=${JSON.stringify(atRest?.customData)}`);
  check('and it is the same instant the record reports',
        atRest?.customData?.issueStartedAt === live?.startedAt,
        `element=${atRest?.customData?.issueStartedAt} record=${live?.startedAt}`);
  check('nothing claims the run has ended',
        atRest?.customData?.issueEndedAt == null,
        `issueEndedAt=${atRest?.customData?.issueEndedAt}`);

  console.log('\n4. the clock advances without the board churning');
  const versionBefore = atRest?.version ?? 0;
  const updatedAtBefore = atRest?.updatedAt ?? '';
  await sleep(6000);
  const later = await elementNow(canvas, blockId);
  const elapsed = Date.now() - (parsedTime(later?.customData?.issueStartedAt) ?? Date.now());
  check('the elapsed time has moved on', elapsed >= 5000, `${elapsed}ms since the start`);
  check('the element version did not move with it', later?.version === versionBefore,
        `version ${versionBefore} became ${later?.version} — a clock written onto the shape churns every export`);
  check('nor did its updatedAt', later?.updatedAt === updatedAtBefore,
        `${updatedAtBefore} became ${later?.updatedAt}`);
  check('the run is still running', (await runRecord(canvas, blockId))?.state === 'running');

  console.log('\n5. a command that does not stream records no figures, and is told nothing new');
  const midRun = await runRecord(canvas, blockId);
  check('no token counts for a plain command', midRun?.usage == null, JSON.stringify(midRun?.usage));
  const prompt = readFileSync(join(workDir, 'prompt-301.txt'), 'utf8');
  check('the prompt says nothing about streaming or tokens',
        !/stream-json|token|usage/i.test(prompt),
        'the opt-in must not leak into what every agent is told');
  check('and it is still the observation that was written', /observation 301/.test(prompt),
        prompt.slice(-200));

  console.log('\n6. a finished run shows a total rather than a clock');
  mark('release', 301);
  const created = await settledBlock(canvas, blockId);
  check('the block reached created', created?.customData?.issueState === 'created',
        JSON.stringify(created?.customData));
  check('issueStartedAt survived the ending',
        created?.customData?.issueStartedAt === live?.startedAt,
        `${live?.startedAt} became ${created?.customData?.issueStartedAt}`);
  const endedAt = parsedTime(created?.customData?.issueEndedAt);
  check('issueEndedAt is on the element and parses', endedAt !== null,
        `issueEndedAt=${created?.customData?.issueEndedAt}`);
  check('and it is not before the start', endedAt !== null && startedAt !== null && endedAt >= startedAt,
        `${created?.customData?.issueStartedAt} .. ${created?.customData?.issueEndedAt}`);

  // The record has to outlive the run: the panel's last read happens *after* it settles,
  // because the ending arrives over the socket as an element update carrying the state and
  // not the figures. A record deleted at the end loses the total exactly when it is worth
  // reading.
  const kept = await runRecord(canvas, blockId);
  check('the record outlived the run', kept !== null, JSON.stringify(kept));
  check('and it settled with the block', kept?.state === 'created', JSON.stringify(kept));
  check('the record and the element agree about the ending',
        kept?.endedAt === created?.customData?.issueEndedAt,
        `record=${kept?.endedAt} element=${created?.customData?.issueEndedAt}`);

  console.log('\n7. a failed run is timed the same way');
  const failedId = await blockFor(canvas, 302);
  writeFileSync(join(workDir, 'fail-302'), '', 'utf8');
  await research(canvas, failedId);
  await until(async () => existsSync(join(workDir, 'run-302')), 'the failing run to start');
  mark('release', 302);
  const failed = await settledBlock(canvas, failedId);
  check('it failed', failed?.customData?.issueState === 'failed',
        JSON.stringify(failed?.customData));
  check('it still says when it started',
        parsedTime(failed?.customData?.issueStartedAt) !== null,
        `issueStartedAt=${failed?.customData?.issueStartedAt}`);
  check('and when it stopped', parsedTime(failed?.customData?.issueEndedAt) !== null,
        `issueEndedAt=${failed?.customData?.issueEndedAt}`);
  const failedRecord = await runRecord(canvas, failedId);
  check('the record says so too', failedRecord?.state === 'failed' && Boolean(failedRecord?.endedAt),
        JSON.stringify(failedRecord));

  console.log('\n8. the reset takes the timing with everything else');
  const cleared = await canvas(`/api/issue-block/${failedId}`, { method: 'DELETE' });
  check('the reset was accepted', cleared.status === 200, `got ${cleared.status}`);
  const afterReset = await elementNow(canvas, failedId);
  check('no start time is left on the block', !afterReset?.customData?.issueStartedAt,
        `issueStartedAt=${afterReset?.customData?.issueStartedAt}`);
  check('nor an end time', !afterReset?.customData?.issueEndedAt,
        `issueEndedAt=${afterReset?.customData?.issueEndedAt}`);
  check('and the record went with them', (await runRecord(canvas, failedId)) === null,
        JSON.stringify(await runRecord(canvas, failedId)));

  console.log('\n9. a command that streams reports what it is spending, while it spends it');
  const streamingServer = startCanvas(
    streamedPort, `node "${stubPath}" -p --output-format stream-json`
  );
  await waitForHealth(STREAMED_BASE, streamingServer.child, streamingServer.read);
  const streamedId = await blockFor(streamed, 401);
  await research(streamed, streamedId);

  // At least 100, not exactly: the partial and the finished copy of the same message may be
  // read as one chunk or as two, and a total of 34 on the way to 100 is honest. What is not
  // allowed is 134 — the two counted as two messages.
  const spending = await until(async () => {
    const found = await runRecord(streamed, streamedId);
    return (found?.usage?.inputTokens ?? 0) >= 100 ? found : null;
  }, 'token counts to appear for a research run');
  check('the counts arrived before the agent exited', spending?.state === 'running',
        `state=${spending?.state} — arriving only at exit is the behaviour this replaces`);
  check('one message counted once, not twice', spending?.usage?.inputTokens === 100,
        `inputTokens=${spending?.usage?.inputTokens}, expected 100`);
  check('output too', spending?.usage?.outputTokens === 10,
        `outputTokens=${spending?.usage?.outputTokens}`);
  check('reasoning is reported while the run is live', spending?.usage?.thinkingTokens === 80,
        `thinkingTokens=${spending?.usage?.thinkingTokens}, expected 80 (30 + 50)`);
  check('and the run still says when it started',
        parsedTime(spending?.startedAt) !== null, `startedAt=${spending?.startedAt}`);

  console.log('\n10. and the figures survive the ending they were spent on');
  mark('release', 401);
  const streamedBlock = await settledBlock(streamed, streamedId);
  check('the block reached created', streamedBlock?.customData?.issueState === 'created',
        JSON.stringify(streamedBlock?.customData));
  const streamedDone = await runRecord(streamed, streamedId);
  check('the record settled', streamedDone?.state === 'created', JSON.stringify(streamedDone));
  // The agent's own final accounting, which counts output the streamed events had not
  // finished reporting. Taking the live sum instead would under-report every run.
  check('the final total is the one the agent settled on',
        streamedDone?.usage?.inputTokens === 200 && streamedDone?.usage?.outputTokens === 55,
        JSON.stringify(streamedDone?.usage));
  check('the reasoning figure survived the event that settled the others',
        streamedDone?.usage?.thinkingTokens === 80,
        `thinkingTokens=${streamedDone?.usage?.thinkingTokens}, expected 80`);
  check('the issue URL was still extracted from NDJSON',
        streamedBlock?.customData?.issueUrl === issue(401),
        `issueUrl=${streamedBlock?.customData?.issueUrl}`);

  console.log('\n11. researching an issue again is the same seam, not a second one');
  const asked = await streamed('/api/issue/recreate', {
    method: 'POST',
    body: JSON.stringify({ url: issue(501), observations: 'The first investigation missed the cache.' }),
  });
  check('the rewrite was accepted', asked.status === 202,
        `got ${asked.status} ${JSON.stringify(asked.body)}`);

  const recreateRecord = async () =>
    (await streamed(`/api/issue/recreate?url=${encodeURIComponent(issue(501))}`)).body?.recreate ?? null;

  const rewriting = await until(async () => {
    const found = await recreateRecord();
    return (found?.usage?.inputTokens ?? 0) >= 100 ? found : null;
  }, 'token counts to appear for a rewrite');
  check('a rewrite reports what it is spending', rewriting?.usage?.inputTokens === 100,
        JSON.stringify(rewriting?.usage));
  check('while it is still going', rewriting?.state === 'running', `state=${rewriting?.state}`);
  check('and it still says when it started', parsedTime(rewriting?.startedAt) !== null,
        `startedAt=${rewriting?.startedAt}`);

  mark('release', 501);
  const rewritten = await until(async () => {
    const found = await recreateRecord();
    return found?.state && found.state !== 'running' ? found : null;
  }, 'the rewrite to settle');
  check('the rewrite finished', rewritten?.state === 'done', JSON.stringify(rewritten));
  check('it has both ends of its clock',
        parsedTime(rewritten?.startedAt) !== null && parsedTime(rewritten?.endedAt) !== null,
        `${rewritten?.startedAt} .. ${rewritten?.endedAt}`);
  check('and its totals survived settling',
        rewritten?.usage?.inputTokens === 200 && rewritten?.usage?.outputTokens === 55,
        JSON.stringify(rewritten?.usage));
} finally {
  for (const n of [301, 302, 401, 501]) {
    try { mark('release', n); } catch { /* the world may already be gone */ }
  }
  await sleep(500);
  stopAll();
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
