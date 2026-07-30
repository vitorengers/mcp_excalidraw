#!/usr/bin/env node
/**
 * Checks that a running implementation says how long it has been running, and how much it
 * has spent when the agent is willing to say.
 *
 * Before this, `ImplementRecord` was four fields — state, url, error, worktree — and none
 * of them was a time. A block with a run in flight could say only *that* one was in
 * flight, for as long as it lasted, which on a real run is an hour or more of a panel
 * that never changes. Nothing was wrong; there was simply no way to tell that from wedged.
 *
 * The two halves have different answers and are checked as two different things:
 *
 *  - **Elapsed time is unconditional.** The record carries `startedAt`, the element carries
 *    a copy of it, and the clock ticks in the browser from that one number. So the case
 *    that matters most here is the one about `version`: a server that wrote the seconds
 *    onto the shape would bump every issue block's version once a second and make every
 *    export churn. The check watches a version across a span of real time and requires it
 *    to stand still while the elapsed time it is derived from advances.
 *  - **Token counts are opt-in**, because they can only come from the agent reporting them
 *    in a machine-readable stream, and the agent command belongs to whoever starts the
 *    board rather than to this repository. A command that does not ask for a stream must
 *    behave exactly as it did before — no figures, and the same prompt.
 *
 * Self-contained: it builds a throwaway git repository, writes a stub agent that streams
 * NDJSON shaped like `claude -p --output-format stream-json --verbose`, starts its own
 * canvas servers on free ports and kills them. Nothing here talks to GitHub or to an
 * agent. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-progress.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim() };
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-progress-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function makeProject(name) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'board.config.json'),
    JSON.stringify({ name, repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

const plainDir = makeProject('plain');
const streamedDir = makeProject('streamed');

/**
 * Stands in for the implement agent, in both of the shapes an operator can configure.
 *
 * Given `--output-format stream-json` on its own command line it writes NDJSON, including
 * the detail that makes naive counting wrong: **one message arrives more than once** as it
 * streams, partial first and then final, so a total that adds up every event it sees is
 * roughly double. It also puts the pull request URL inside a JSON string rather than on a
 * line of its own, which is the other thing that could quietly break.
 *
 * Without that flag it writes plain text, which is today's default and must stay exactly
 * as it is.
 *
 * Either way it waits to be released, so the check can look at a run while it is live —
 * "before the process exits" is the whole point of the token half.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const streaming = process.argv.join(' ').includes('stream-json');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'prompt-' + number + '.txt'), input, 'utf8');
  writeFileSync(join(workDir, 'run-' + number), '', 'utf8');

  const url = 'https://github.com/vitorengers/mcp_excalidraw/pull/' + number;
  const failing = existsSync(join(workDir, 'fail-' + number));
  const waitFor = async (marker) => {
    for (let attempt = 0; attempt < 900; attempt++) {
      if (existsSync(join(workDir, marker + '-' + number))) return;
      await sleep(100);
    }
  };

  if (!streaming) {
    await waitFor('release');
    process.stdout.write(failing ? 'I could not do it.\\n' : url + '\\n');
    return;
  }

  const line = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
  const usage = (input_tokens, cache_creation, cache_read, output_tokens, details) => ({
    input_tokens,
    cache_creation_input_tokens: cache_creation,
    cache_read_input_tokens: cache_read,
    output_tokens,
    ...(details ? { output_tokens_details: details } : {}),
  });
  /**
   * Reasoning, in the shape Claude Code actually publishes it.
   *
   * Not inside \`usage\`: \`claude -p --output-format stream-json --verbose\` (2.1.220) carries
   * no \`output_tokens_details\` anywhere — not on an assistant message, not on \`result\` — and
   * says this instead, in an event of its own. Its running total **restarts at every
   * assistant turn** (observed 50 → 150 → 173, then 50 → 129), so a run's figure is the sum
   * of the deltas and never the last \`estimated_tokens\`.
   */
  const thinking = (estimated_tokens, estimated_tokens_delta) =>
    line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens, estimated_tokens_delta });

  line({ type: 'system', subtype: 'init', session_id: 'stub' });

  if (number === '402') {
    // Streams its spending and never mentions reasoning: silence, not a zero.
    line({ type: 'assistant', message: { id: 'msg_a', usage: usage(10, 30, 60, 10) } });
    await waitFor('release');
    line({ type: 'result', subtype: 'success', result: url, usage: usage(10, 30, 60, 40) });
    return;
  }

  if (number === '403') {
    // An agent answering in the Messages API's own shape, breakdown included. Nothing
    // requires the configured command to be Claude Code, and this is where the figure
    // lives for anything that reports usage the way the API documents it.
    line({ type: 'assistant', message: { id: 'msg_a', usage: usage(4, 10, 20, 3, { thinking_tokens: 2 }) } });
    line({ type: 'assistant', message: { id: 'msg_a', usage: usage(10, 30, 60, 25, { thinking_tokens: 17 }) } });
    await waitFor('release');
    line({
      type: 'result', subtype: 'success', result: url,
      usage: usage(10, 30, 60, 40, { thinking_tokens: 22 }),
    });
    return;
  }

  thinking(30, 30);
  // The same id twice: the partial, then the same message finished.
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(4, 10, 20, 3) } });
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(10, 30, 60, 10) } });
  thinking(80, 50);
  await waitFor('bump');
  line({ type: 'assistant', message: { id: 'msg_b', usage: usage(20, 30, 150, 20) } });
  await waitFor('think');
  // A new turn, so the agent's own running total starts over at 45 — the run is at 125.
  // Alone in its chunk on purpose: nothing about the in/out totals changes here, and a
  // reporter that only watches those two would never hand this on.
  thinking(45, 45);
  await waitFor('release');
  // The run's own final accounting, and the URL inside a JSON string. It settles input and
  // output and says nothing at all about reasoning — which is exactly how the figure gets
  // lost, if the settled totals are allowed to replace it along with the rest.
  line({
    type: 'result',
    subtype: 'success',
    result: url,
    usage: { iterations: [usage(10, 30, 60, 40), usage(20, 30, 150, 55)] },
  });
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'plain', path: plainDir.replace(/\\/g, '/') },
    { id: 'streamed', path: streamedDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const running = [];

function startCanvas(port, agentCommand) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: agentCommand,
    },
  }).child;
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
const port = await freePort();
const streamedPort = await freePort();
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

const issue = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;
const start = (fn, n) => fn('/api/implement', { method: 'POST', body: JSON.stringify({ url: issue(n) }) });
const mark = (marker, n) => writeFileSync(join(workDir, `${marker}-${n}`), '', 'utf8');

async function record(fn, n) {
  return (await fn(`/api/implement?url=${encodeURIComponent(issue(n))}`)).body?.implement ?? null;
}

async function settled(fn, n, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const found = await record(fn, n);
    if (found?.state && found.state !== 'running') return found;
    await sleep(150);
  }
  return null;
}

async function until(predicate, what, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await predicate();
    if (value) return value;
    await sleep(150);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return null;
}

/** A block that already carries the issue, which is what an authored one looks like. */
async function blockFor(n) {
  const created = await canvas('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: n, width: 200, height: 100,
      customData: { kind: 'issue', issueState: 'created', issueUrl: issue(n) },
    }),
  });
  return created.body?.element?.id ?? '';
}

const elementNow = async (id) => (await canvas(`/api/elements/${id}`)).body?.element ?? null;

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port, `node "${stubPath}" -p`);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. a run in flight says when it started');
  const blockId = await blockFor(301);
  const before = Date.now();
  const accepted = await start(canvas, 301);
  check('the run was accepted', accepted.status === 202,
        `got ${accepted.status} ${JSON.stringify(accepted.body)}`);

  const live = await until(async () => {
    const found = await record(canvas, 301);
    return found?.state === 'running' ? found : null;
  }, 'the run to be recorded as running');

  const startedAt = parsedTime(live?.startedAt);
  check('startedAt is there and parses', startedAt !== null, `startedAt=${live?.startedAt}`);
  check('and it is when the run actually started',
        startedAt !== null && startedAt >= before - 1000 && startedAt <= Date.now() + 1000,
        `startedAt=${live?.startedAt}, asked at ${new Date(before).toISOString()}`);
  check('nothing has ended yet', live?.endedAt == null, `endedAt=${live?.endedAt}`);

  console.log('\n2. an issue with no run has no timing at all');
  const untouched = await record(canvas, 999);
  check('no record for an issue never implemented', untouched === null, JSON.stringify(untouched));

  console.log('\n3. the block carries the start time, and reads without the network');
  // Wait for the worktree, because that is the last write the start path makes: capturing
  // the version before it would see a bump that has nothing to do with the clock.
  await until(async () => (await record(canvas, 301))?.worktree, 'the run to get its worktree');
  const atRest = await elementNow(blockId);
  check('implementStartedAt is on the element',
        parsedTime(atRest?.customData?.implementStartedAt) !== null,
        `customData=${JSON.stringify(atRest?.customData)}`);
  check('and it is the same instant the record reports',
        atRest?.customData?.implementStartedAt === live?.startedAt,
        `element=${atRest?.customData?.implementStartedAt} record=${live?.startedAt}`);

  console.log('\n4. the clock advances without the board churning');
  const versionBefore = atRest?.version ?? 0;
  const updatedAtBefore = atRest?.updatedAt ?? '';
  await sleep(6000);
  const later = await elementNow(blockId);
  const elapsed = Date.now() - (parsedTime(later?.customData?.implementStartedAt) ?? Date.now());
  check('the elapsed time has moved on', elapsed >= 5000, `${elapsed}ms since the start`);
  check('the element version did not move with it', later?.version === versionBefore,
        `version ${versionBefore} became ${later?.version} — a clock written onto the shape churns every export`);
  check('nor did its updatedAt', later?.updatedAt === updatedAtBefore,
        `${updatedAtBefore} became ${later?.updatedAt}`);
  check('the run is still running', (await record(canvas, 301))?.state === 'running');

  console.log('\n5. a command that does not stream records no figures, and is told nothing new');
  const midRun = await record(canvas, 301);
  check('no token counts for a plain command', midRun?.usage == null, JSON.stringify(midRun?.usage));
  const prompt = readFileSync(join(workDir, 'prompt-301.txt'), 'utf8');
  check('the prompt says nothing about streaming or tokens',
        !/stream-json|token|usage/i.test(prompt),
        'the opt-in must not leak into what every agent is told');

  console.log('\n6. a finished run shows a total rather than a clock');
  mark('release', 301);
  const done = await settled(canvas, 301);
  check('it finished', done?.state === 'done', JSON.stringify(done));
  check('startedAt survived the ending', done?.startedAt === live?.startedAt,
        `${live?.startedAt} became ${done?.startedAt}`);
  const endedAt = parsedTime(done?.endedAt);
  check('endedAt is there and parses', endedAt !== null, `endedAt=${done?.endedAt}`);
  check('and it is not before the start', endedAt !== null && startedAt !== null && endedAt >= startedAt,
        `${done?.startedAt} .. ${done?.endedAt}`);
  const finished = await elementNow(blockId);
  check('the block carries the ending too',
        finished?.customData?.implementEndedAt === done?.endedAt,
        `element=${finished?.customData?.implementEndedAt} record=${done?.endedAt}`);

  console.log('\n7. a failed run is timed the same way');
  writeFileSync(join(workDir, 'fail-302'), '', 'utf8');
  await start(canvas, 302);
  await until(async () => existsSync(join(workDir, 'run-302')), 'the failing run to start');
  mark('release', 302);
  const failed = await settled(canvas, 302);
  check('it failed', failed?.state === 'failed', JSON.stringify(failed));
  check('it still says when it started', parsedTime(failed?.startedAt) !== null,
        `startedAt=${failed?.startedAt}`);
  check('and when it stopped', parsedTime(failed?.endedAt) !== null, `endedAt=${failed?.endedAt}`);

  console.log('\n8. the reset takes the timing with everything else');
  const cleared = await canvas('/api/implement', {
    method: 'DELETE', body: JSON.stringify({ url: issue(301) }),
  });
  check('the reset was accepted', cleared.status === 200, `got ${cleared.status}`);
  const afterReset = await elementNow(blockId);
  check('no start time is left on the block', !afterReset?.customData?.implementStartedAt,
        `implementStartedAt=${afterReset?.customData?.implementStartedAt}`);
  check('nor an end time', !afterReset?.customData?.implementEndedAt,
        `implementEndedAt=${afterReset?.customData?.implementEndedAt}`);
  check('and the issue behind it survived',
        afterReset?.customData?.issueUrl === issue(301), afterReset?.customData?.issueUrl);

  console.log('\n9. a command that streams reports what it is spending, while it spends it');
  const streamingServer = startCanvas(streamedPort, `node "${stubPath}" -p --output-format stream-json`);
  await waitForHealth(STREAMED_BASE, streamingServer.child, streamingServer.read);
  await start(streamed, 401);

  // At least 100, not exactly: the partial and the finished copy of the same message may
  // be read as one chunk or as two, and a total of 34 on the way to 100 is honest. What is
  // not allowed is 134 — the two counted as two messages — which is what the assertion
  // below fails on.
  const first = await until(async () => {
    const found = await record(streamed, 401);
    return (found?.usage?.inputTokens ?? 0) >= 100 ? found : null;
  }, 'token counts to appear');
  check('the counts arrived before the agent exited', first?.state === 'running',
        `state=${first?.state} — arriving only at exit is the behaviour this replaces`);
  // 4+10+20 and 10+30+60 are the same message twice; only the second counts.
  check('one message counted once, not twice', first?.usage?.inputTokens === 100,
        `inputTokens=${first?.usage?.inputTokens}, expected 100`);
  check('output too', first?.usage?.outputTokens === 10, `outputTokens=${first?.usage?.outputTokens}`);

  const thought = await until(async () => {
    const found = await record(streamed, 401);
    return (found?.usage?.thinkingTokens ?? 0) >= 80 ? found : null;
  }, 'the reasoning figure to appear');
  check('reasoning is reported while the run is live', thought?.usage?.thinkingTokens === 80,
        `thinkingTokens=${thought?.usage?.thinkingTokens}, expected 80 (30 + 50)`);
  check('and the run is still going as it is reported', thought?.state === 'running',
        `state=${thought?.state}`);

  mark('bump', 401);
  const grown = await until(async () => {
    const found = await record(streamed, 401);
    return (found?.usage?.inputTokens ?? 0) > 100 ? found : null;
  }, 'the counts to grow');
  check('a second message adds to the total', grown?.usage?.inputTokens === 300,
        `inputTokens=${grown?.usage?.inputTokens}, expected 300`);
  check('and the output with it', grown?.usage?.outputTokens === 30,
        `outputTokens=${grown?.usage?.outputTokens}`);
  check('still running while it grows', grown?.state === 'running', `state=${grown?.state}`);
  check('reasoning did not move with a message that reported none',
        grown?.usage?.thinkingTokens === 80, `thinkingTokens=${grown?.usage?.thinkingTokens}`);

  console.log('\n10. a new turn restarts the agent\'s reasoning total, and the run\'s keeps going');
  mark('think', 401);
  const rethought = await until(async () => {
    const found = await record(streamed, 401);
    return (found?.usage?.thinkingTokens ?? 0) > 80 ? found : null;
  }, 'the reasoning figure to grow on its own');
  // 45 is the agent's total for a *new* turn, not the run's. Taking the figure at face
  // value reads 45 here — a run's reasoning going backwards from 80.
  check('the deltas accumulate across turns', rethought?.usage?.thinkingTokens === 125,
        `thinkingTokens=${rethought?.usage?.thinkingTokens}, expected 125 (30 + 50 + 45)`);
  check('the input total stood still while it moved', rethought?.usage?.inputTokens === 300,
        `inputTokens=${rethought?.usage?.inputTokens}`);
  check('and the output total with it', rethought?.usage?.outputTokens === 30,
        `outputTokens=${rethought?.usage?.outputTokens} — reasoning alone must be enough to report`);

  console.log('\n11. and the pull request is still found in a stream of JSON');
  mark('release', 401);
  const streamedDone = await settled(streamed, 401);
  check('the run finished', streamedDone?.state === 'done', JSON.stringify(streamedDone));
  check('the pull request URL was extracted from NDJSON',
        /\/pull\/401$/.test(streamedDone?.url ?? ''), `url=${streamedDone?.url}`);
  check('the run has both ends of its clock',
        parsedTime(streamedDone?.startedAt) !== null && parsedTime(streamedDone?.endedAt) !== null,
        `${streamedDone?.startedAt} .. ${streamedDone?.endedAt}`);
  // The agent's own final accounting, which counts output the streamed events had not
  // finished reporting. Taking the live sum instead would under-report every run.
  check('the final total is the one the agent settled on',
        streamedDone?.usage?.inputTokens === 300 && streamedDone?.usage?.outputTokens === 95,
        JSON.stringify(streamedDone?.usage));
  // The settled totals are the agent's own and carry no reasoning at all. If they replace
  // the whole figure rather than the two halves they speak for, the split is shown for the
  // length of the run and then vanishes at the moment it becomes worth reading.
  check('the reasoning figure survived the event that settled the others',
        streamedDone?.usage?.thinkingTokens === 125,
        `thinkingTokens=${streamedDone?.usage?.thinkingTokens}, expected 125`);

  console.log('\n12. a stream that never mentions reasoning reports none, rather than zero');
  await start(streamed, 402);
  const quiet = await until(async () => {
    const found = await record(streamed, 402);
    return (found?.usage?.inputTokens ?? 0) >= 100 ? found : null;
  }, 'the quiet run to report its spending');
  check('it reports what it did say', quiet?.usage?.outputTokens === 10,
        JSON.stringify(quiet?.usage));
  // Null and 0 are different answers. `0 thinking` on a run whose agent has said nothing
  // about reasoning is a claim, and the wrong one.
  check('and says nothing about reasoning', quiet?.usage?.thinkingTokens === null,
        `thinkingTokens=${JSON.stringify(quiet?.usage?.thinkingTokens)} — silence is not zero`);
  mark('release', 402);
  const quietDone = await settled(streamed, 402);
  check('it finished', quietDone?.state === 'done', JSON.stringify(quietDone));
  check('still nothing about reasoning once settled', quietDone?.usage?.thinkingTokens === null,
        `thinkingTokens=${JSON.stringify(quietDone?.usage?.thinkingTokens)}`);

  console.log('\n13. an agent that answers in the Messages API shape is read there instead');
  await start(streamed, 403);
  // At least 17, not exactly, for the reason section 9 gives about the two halves of one
  // message: seeing the partial's 2 on the way there is honest. What is not allowed is 19.
  const detailed = await until(async () => {
    const found = await record(streamed, 403);
    return (found?.usage?.thinkingTokens ?? 0) >= 17 ? found : null;
  }, 'the breakdown inside usage to be read');
  // 2 and 17 are one message twice, exactly like the input and output beside them.
  check('output_tokens_details.thinking_tokens is counted once, not twice',
        detailed?.usage?.thinkingTokens === 17,
        `thinkingTokens=${detailed?.usage?.thinkingTokens}, expected 17`);
  mark('release', 403);
  const detailedDone = await settled(streamed, 403);
  check('and the breakdown on the settled event wins at the end',
        detailedDone?.usage?.thinkingTokens === 22,
        `thinkingTokens=${detailedDone?.usage?.thinkingTokens}, expected 22`);
} finally {
  for (const n of [301, 302, 401, 402, 403]) {
    try { mark('bump', n); mark('think', n); mark('release', n); } catch { /* the world may already be gone */ }
  }
  await sleep(500);
  stopAll();
  await sleep(200);
  for (const dir of [plainDir, streamedDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
