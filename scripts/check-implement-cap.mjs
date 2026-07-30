#!/usr/bin/env node
/**
 * Checks that the implementation cap is honoured by simultaneous clicks.
 *
 * `beginImplement` counted the runs in flight and refused, but claimed the slot much
 * later — with an `await` on the workspace registry in between. Two requests arriving
 * close enough together both read the same count, both passed, and the cap was exceeded by
 * however many fitted in that window. That is not merely a budget overrun: the extra run is
 * what put two `git worktree add` in the same instant, and they collided on the shared
 * `.git/config`.
 *
 * So the cases here are about the claim, not about the agent. Requests are fired with one
 * `Promise.all` rather than a loop with awaits — a loop cannot reproduce the defect, because
 * each request finishes claiming before the next one counts. And because claiming first
 * moves the write ahead of the validation that follows it, the other direction is checked
 * too: a run refused after claiming has to give the slot back, or the cap leaks downwards
 * until the server restarts.
 *
 * Self-contained: it builds throwaway projects, writes a stub implement agent that parks
 * until released, starts its own canvas server on a free port and kills it. Nothing here
 * talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-cap.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

async function waitFor(predicate, what, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return true;
    await sleep(100);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-cap-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A real git repository, because a run that is accepted goes on to make a worktree. */
function makeProject(name, { config = true } = {}) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'check@example.com']);
  git(dir, ['config', 'user.name', 'Check']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  if (config) {
    writeFileSync(join(dir, 'board.config.json'),
                  JSON.stringify({ name, repo: 'vitorengers/mcp_excalidraw' }), 'utf8');
  }
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

const cappedDir = makeProject('capped');
// Registered, but with no board.config.json — which is what gives a workspace an `error`,
// and so reaches the second of the two refusals that now come after the claim.
const brokenDir = makeProject('broken', { config: false });

/**
 * Stands in for the implement agent. It records that it was started and then parks, so the
 * check can look at the cap while a run is genuinely in flight.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({ cwd: process.cwd() }), 'utf8');

  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('done\\n');
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'capped', path: cappedDir.replace(/\\/g, '/') },
    { id: 'broken', path: brokenDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];

function startCanvas(port, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      ...extraEnv,
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

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

async function call(workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${workspace}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const issue = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;
const start = (workspace, n) =>
  call(workspace, '/api/implement', { method: 'POST', body: JSON.stringify({ url: issue(n) }) });
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const started = (n) => existsSync(join(workDir, `run-${n}.json`));

/** What the server itself says is in flight, which is the count the cap is made of. */
async function inFlight(workspace) {
  const listed = await call(workspace, '/api/implement');
  return (listed.body?.runs ?? []).filter((run) => run.state === 'running');
}

const ISSUES = [301, 302];
const CAP = 1;

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port, { EXCALIDRAW_IMPLEMENT_CONCURRENCY: String(CAP) });
  await waitForHealth(BASE, server.child, server.read);

  console.log(`1. ${ISSUES.length} clicks at once against a cap of ${CAP}`);
  // One `Promise.all`, deliberately: awaiting each request in turn lets every one of them
  // finish claiming before the next one counts, which is exactly the interleaving the
  // defect does not occur in.
  const answers = await Promise.all(ISSUES.map((n) => start('capped', n)));
  const accepted = answers.filter((answer) => answer.status === 202);
  const refused = answers.filter((answer) => answer.status === 409);

  check(`exactly ${CAP} of ${ISSUES.length} simultaneous requests are accepted`,
        accepted.length === CAP,
        `${accepted.length} got 202 — statuses were ${answers.map((a) => a.status).join(', ')}`);
  check('and every other one is refused with 409',
        refused.length === ISSUES.length - CAP,
        answers.map((a) => `${a.status} ${JSON.stringify(a.body)}`).join(' | '));

  console.log('\n2. the refusal still says what to wait for');
  const named = refused.every((answer) =>
    Array.isArray(answer.body?.running)
    && answer.body.running.length > 0
    && answer.body.running.every((url) => ISSUES.some((n) => issue(n) === url))
    && (answer.body?.error ?? '').includes('/issues/'));
  check('a refused request names the runs holding the slots', refused.length > 0 && named,
        refused.map((answer) => JSON.stringify(answer.body)).join(' | '));

  console.log('\n3. and only the accepted runs were actually spawned');
  await waitFor(() => ISSUES.some((n) => started(n)), 'the accepted run to reach the agent');
  // Long enough that a run which was in fact accepted would have reported itself by now.
  await sleep(1500);
  check(`exactly ${CAP} agent(s) were started`,
        ISSUES.filter((n) => started(n)).length === CAP,
        `started: ${ISSUES.filter((n) => started(n)).join(', ') || 'none'}`);
  const live = await inFlight('capped');
  check(`and the server reports ${CAP} run(s) in flight`, live.length === CAP,
        JSON.stringify(live.map((run) => run.issueUrl)));

  console.log('\n4. a run refused for an unregistered workspace gives its slot back');
  const ghostFirst = await start('ghost', 401);
  check('400 for a workspace that is not registered', ghostFirst.status === 400,
        `got ${ghostFirst.status} ${JSON.stringify(ghostFirst.body)}`);
  const ghostSecond = await start('ghost', 402);
  check('a second attempt is refused the same way, not by the cap', ghostSecond.status === 400,
        `got ${ghostSecond.status} ${JSON.stringify(ghostSecond.body)} — the failed run kept its slot`);
  check('and nothing is left running there', (await inFlight('ghost')).length === 0,
        JSON.stringify(await inFlight('ghost')));

  console.log('\n5. nor does a workspace that fails to load');
  const brokenFirst = await start('broken', 501);
  check('400 for an unusable workspace', brokenFirst.status === 400,
        `got ${brokenFirst.status} ${JSON.stringify(brokenFirst.body)}`);
  const brokenSecond = await start('broken', 502);
  check('a second attempt is refused the same way, not by the cap', brokenSecond.status === 400,
        `got ${brokenSecond.status} ${JSON.stringify(brokenSecond.body)} — the failed run kept its slot`);
  check('and nothing is left running there', (await inFlight('broken')).length === 0,
        JSON.stringify(await inFlight('broken')));

  console.log('\n6. the slot comes back when the run that holds it ends');
  for (const n of ISSUES) release(n);
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await inFlight('capped')).length === 0) break;
    await sleep(150);
  }
  check('the cap is free again once the runs settle', (await inFlight('capped')).length === 0,
        JSON.stringify((await inFlight('capped')).map((run) => run.issueUrl)));
} finally {
  for (const n of [...ISSUES, 401, 402, 501, 502]) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
  stopAll();
  await sleep(200);
  for (const dir of [cappedDir, brokenDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
