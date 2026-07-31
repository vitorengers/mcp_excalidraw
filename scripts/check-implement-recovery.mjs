#!/usr/bin/env node
/**
 * Checks that a run which ended without its pull request is tried once more — and exactly once.
 *
 * Two runs on 2026-07-31 ended the same way. #306's agent had the whole change committed on its
 * branch and never ran `git push`; #314's opened a pull request and never merged it. Both ended
 * their turn while a background `npm test` was still going, and in headless `claude -p` a turn
 * ending is the process ending. Both exited **zero**. The prompt already forbade exactly this,
 * in those words, and both agents did it anyway — so what was missing was a mechanism, not a
 * third copy of the rule.
 *
 * The cases here are about the bound as much as the recovery, because an automatic second
 * attempt argues with a rule `dispatchQueue` states on purpose — *"the queue tries each issue
 * once"* — which is what stops a broken build being retried forever. Three of them are that
 * argument:
 *
 * **Exactly once, never twice.** An agent that fails the same way twice is a defect, not a blip,
 * and the third attempt is where an automatic recovery becomes a loop nobody asked for.
 *
 * **Nothing automatic over a deliberate stop.** A pull request left open because the agent could
 * not reconcile a conflict is a finished run. Sending a second agent at it would force the merge
 * the first one refused.
 *
 * **Nothing automatic over a run that got nowhere.** With no pull request and no work in the
 * checkout there is nothing to *finish*, and re-entering would be a re-run — which is precisely
 * what the queue's rule forbids.
 *
 * A real git repository, because "its worktree holds work" is a fact read off git and is half
 * the trigger. Self-contained: it writes a stub `gh` and a stub agent, starts its own canvas
 * server on a port the kernel hands out, and kills it. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-recovery.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const REPO = 'vitorengers/vibemaxxing';
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;
const pullUrl = (number) => `https://github.com/${REPO}/pull/${number}`;

// ─── The world ────────────────────────────────────────────────

const workDir = join(tmpdir(), `check-implement-recovery-${process.pid}`);
const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const controlPath = join(workDir, 'control.json');
const pullsPath = join(workDir, 'pulls.json');
const runsDir = join(workDir, 'runs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(runsDir, { recursive: true });

/** A real git repository: the worktree the agent is given has to be a real checkout. */
const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
git(projectDir, ['init', '-b', 'main']);
git(projectDir, ['config', 'user.email', 'check@example.com']);
git(projectDir, ['config', 'user.name', 'Check']);
git(projectDir, ['config', 'commit.gpgsign', 'false']);
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({ name: 'project', repo: REPO }), 'utf8');
writeFileSync(join(projectDir, 'README.md'), '# project\n', 'utf8');
git(projectDir, ['add', '.']);
git(projectDir, ['commit', '-m', 'initial']);

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'project', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/**
 * What each case's agent does, by issue number, and what GitHub says about each pull request.
 *
 * One stub with a mode per case rather than a stub per case: every case turns on the *same*
 * two facts — how many times the agent was started and what it left behind — and reading those
 * out of one place is what makes "exactly once" assertable rather than assumed.
 */
const CONTROL = {
  31: 'finish',    // committed, no pull request; the second attempt opens and merges one
  32: 'never',     // commits, never produces a pull request, however often it is asked
  33: 'merge',     // opens a pull request and does not merge it; the second attempt merges
  34: 'crash',     // exits non-zero
  35: 'escalate',  // stops on purpose and says so
  36: 'nothing',   // exits zero having done nothing at all
  37: 'streaming', // exits zero having said something, in stream-json rather than in prose
};

const PULLS = {
  1031: { state: 'MERGED' },
  1033: { state: 'OPEN' },
  2033: { state: 'MERGED' },
  1035: { state: 'OPEN' },
};

writeFileSync(controlPath, JSON.stringify(CONTROL), 'utf8');
writeFileSync(pullsPath, JSON.stringify(PULLS), 'utf8');

/** A `gh` that answers for a pull request and refuses everything else. */
writeFileSync(stubGhPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') {
  const pulls = JSON.parse(readFileSync(process.env.STUB_GH_PULLS, 'utf8'));
  const answer = pulls[(args[2] || '').split('/').pop()];
  if (!answer) { process.stderr.write('no such pull request\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({ state: answer.state, mergedAt: null }) + '\\n');
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

/**
 * The agent, which records every start and behaves by the case's mode.
 *
 * It writes the prompt it was given to `runs/<issue>-<n>.txt`, so the count of those files *is*
 * the number of times it ran, and so a case can assert what the second attempt was actually
 * told — a recovery that failed to say a pull request already exists would invite a second one.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk.toString(); });
process.stdin.on('end', () => {
  const runs = process.env.STUB_RUNS;
  const issue = (prompt.match(/issues\\/(\\d+)/) || [])[1];
  const before = readdirSync(runs).filter((f) => f.startsWith(issue + '-')).length;
  const attempt = before + 1;
  writeFileSync(join(runs, issue + '-' + attempt + '.txt'), prompt, 'utf8');

  const mode = JSON.parse(readFileSync(process.env.STUB_CONTROL, 'utf8'))[issue];
  const commit = (name) => {
    try {
      writeFileSync(join(process.cwd(), name), 'work\\n', 'utf8');
      execFileSync('git', ['add', name], { cwd: process.cwd() });
      execFileSync('git', ['commit', '-m', 'work'], { cwd: process.cwd() });
    } catch { /* the case that cares asserts on the checkout, not on this */ }
  };

  if (mode === 'crash') { process.stderr.write('boom\\n'); process.exit(2); }
  if (mode === 'nothing') { process.stdout.write('I got nowhere.\\n'); return; }
  if (mode === 'streaming') {
    // The shape a real \`--output-format stream-json\` run ends in: what the agent said, then
    // machinery. #306's board showed the machinery.
    const say = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    process.stdout.write(say('Waiting on npm test; both background waiters will report.') + '\\n');
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'task_notification', summary: 'Wait for the suite output to land' }) + '\\n');
    process.stdout.write(JSON.stringify({ end_time: 1785491933119, uuid: 'ee83a80f-9ac1' }) + '\\n');
    return;
  }
  if (mode === 'escalate') {
    process.stdout.write('NEEDS A PERSON: ' + 'https://github.com/${REPO}/pull/1035' + '\\n');
    return;
  }
  if (mode === 'never') { commit('work-' + attempt + '.txt'); process.stdout.write('no luck\\n'); return; }
  if (mode === 'finish') {
    commit('work-' + attempt + '.txt');
    if (attempt === 1) { process.stdout.write('committed, but I stopped here\\n'); return; }
    process.stdout.write('https://github.com/${REPO}/pull/1031\\n');
    return;
  }
  if (mode === 'merge') {
    commit('work-' + attempt + '.txt');
    process.stdout.write('https://github.com/${REPO}/pull/' + (attempt === 1 ? '1033' : '2033') + '\\n');
  }
});
`, 'utf8');

// ─── The server ───────────────────────────────────────────────

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  dist/server.js exists — run tsc first');
  process.exit(1);
}

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;
let child = null;
let serverOutput = '';

function startCanvas() {
  child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}" -p`,
      EXCALIDRAW_IMPLEMENT_CONCURRENCY: '0',
      STUB_CONTROL: controlPath,
      STUB_GH_PULLS: pullsPath,
      STUB_RUNS: runsDir,
    },
  }).child;
  child.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverOutput}`);
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
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

/** How many times the agent was started for one issue, and with what. */
const attemptsFor = (number) =>
  readdirSync(runsDir).filter((f) => f.startsWith(`${number}-`)).sort();
/**
 * An attempt that never happened reads as empty rather than throwing, so a red run reports
 * every case instead of stopping at the first missing file. That matters most on the run this
 * check was written for — the one against the old code, where the whole point is the shape of
 * the failure.
 */
const promptOf = (number, attempt) => {
  try { return readFileSync(join(runsDir, `${number}-${attempt}.txt`), 'utf8'); }
  catch { return ''; }
};

async function settle(number) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const record = (await call(
      `/api/implement?workspace=project&url=${encodeURIComponent(issueUrl(number))}`
    )).body.implement;
    if (record?.state && record.state !== 'running') return record;
    await sleep(100);
  }
  return { state: 'running' };
}

async function run(number) {
  const started = await call('/api/implement?workspace=project', {
    method: 'POST',
    body: JSON.stringify({ url: issueUrl(number) }),
  });
  if (started.status !== 202) throw new Error(`starting #${number} answered ${started.status}`);
  return settle(number);
}

try {
  startCanvas();
  await waitForHealth();

  console.log('1. a run that committed and never opened a pull request is tried once more');
  const finished = await run(31);
  check('the agent ran twice', attemptsFor(31).length === 2, attemptsFor(31).join(', '));
  check('and the run ends done', finished.state === 'done', JSON.stringify(finished));
  check('at the pull request the second attempt opened', finished.url === pullUrl(1031), finished.url);
  check('the record says a recovery happened', finished.recovered === true, JSON.stringify(finished));

  console.log('\n2. the second attempt is told what the first one left');
  const second = promptOf(31, 2);
  check('it says the previous attempt did not finish',
        /did not finish|ended without/i.test(second), second.slice(-400));
  check('and names the defect it is recovering from — the backgrounded wait',
        /background/i.test(second), second.slice(-400));
  check('the first attempt was told none of it', !/did not finish/i.test(promptOf(31, 1)));

  console.log('\n3. exactly once, never twice');
  const hopeless = await run(32);
  await sleep(600);
  check('the agent ran twice and no more', attemptsFor(32).length === 2, attemptsFor(32).join(', '));
  check('and the run is failed', hopeless.state === 'failed', JSON.stringify(hopeless));
  check('the record still says a recovery was spent', hopeless.recovered === true, JSON.stringify(hopeless));

  console.log('\n4. a pull request that did not merge is finished, not reopened');
  const merged = await run(33);
  check('the agent ran twice', attemptsFor(33).length === 2, attemptsFor(33).join(', '));
  check('and the run ends done', merged.state === 'done', JSON.stringify(merged));
  // The recovery has to say the pull request exists, or it invites a second one — and nothing
  // downstream counts pull requests, so two for one issue is an error nowhere.
  check('the second attempt was told the pull request already exists',
        promptOf(33, 2).includes(pullUrl(1033)), promptOf(33, 2).slice(-400));

  console.log('\n5. a crash gets no recovery');
  // A non-zero exit is a broken command or a broken machine, not a turn that ended early.
  const crashed = await run(34);
  await sleep(600);
  check('the agent ran once', attemptsFor(34).length === 1, attemptsFor(34).join(', '));
  check('and the run is failed', crashed.state === 'failed', JSON.stringify(crashed));
  check('no recovery was spent', !crashed.recovered, JSON.stringify(crashed));

  console.log('\n6. a deliberate stop gets no recovery');
  const escalated = await run(35);
  await sleep(600);
  check('the agent ran once', attemptsFor(35).length === 1, attemptsFor(35).join(', '));
  check('and the run is blocked', escalated.state === 'blocked', JSON.stringify(escalated));

  console.log('\n7. a run that got nowhere gets no recovery');
  // Nothing to finish: no pull request, and a checkout with nothing in it. Re-entering would be
  // a re-run, which is what the queue's own rule refuses.
  const nowhere = await run(36);
  await sleep(600);
  check('the agent ran once', attemptsFor(36).length === 1, attemptsFor(36).join(', '));
  check('and the run is failed', nowhere.state === 'failed', JSON.stringify(nowhere));

  console.log('\n8. the failure a person reads is what the agent said, not the machinery');
  // #306's block reported its failure as a session-end record and a task notification, which
  // is true and is not an explanation. What the agent said one event earlier was the diagnosis.
  const streamed = await run(37);
  check('the run is failed', streamed.state === 'failed', JSON.stringify(streamed));
  check('the error carries what the agent said',
        String(streamed.error).includes('Waiting on npm test'), String(streamed.error));
  check('and not the JSON around it',
        !String(streamed.error).includes('task_notification')
        && !String(streamed.error).includes('end_time'), String(streamed.error));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
  try { git(projectDir, ['worktree', 'prune']); } catch { /* nothing to prune */ }
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
