#!/usr/bin/env node
/**
 * Checks that researching an issue has no time limit unless one is configured.
 *
 * The ceiling was twenty minutes, on the premise that researching an issue is bounded
 * work. It stopped being bounded: the investigation now reads reference images, existing
 * issues and the project's own documentation, and a real run was killed at 1200s having
 * already created its issue. The salvage path could not save it either — the configured
 * agent is `claude -p` with no streaming output, so stdout arrives at process exit and
 * there is nothing to read at the kill.
 *
 * So the default is `null`, the way an implementation's already is, and the env var is
 * what puts a ceiling back for anyone who wants one.
 *
 * Self-contained: it reads the compiled default in child processes with a controlled
 * environment, then runs the endpoint against a stub agent that is slower than the ceiling
 * it is given. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-issue-timeout.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The default the module computes, in a process whose environment we chose.
 *
 * Read in a child rather than imported here: the value is decided once at import time
 * from the environment, so a single process can only ever see one of the two answers.
 */
function defaultTimeout(env) {
  const moduleUrl = pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href;
  const result = spawnSync(process.execPath, [
    '--input-type=module',
    '-e', `const m = await import(${JSON.stringify(moduleUrl)});
           process.stdout.write(JSON.stringify(m.DEFAULT_TIMEOUT_MS ?? null));`,
  ], {
    encoding: 'utf8',
    // `canvasEnvironment` rather than `process.env`: `dist/core/issue-agent.js` pulls in
    // `config.js`, which reads the `.env` beside the working directory — so the value this
    // deliberately leaves unset came straight back from the operator's file.
    env: canvasEnvironment({ EXCALIDRAW_ISSUE_AGENT_TIMEOUT: undefined, ...env }),
  });
  if (result.status !== 0) throw new Error(`could not read the default: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `issue-timeout-${process.pid}`);
const projectDir = join(workDir, 'project');
const agentStub = join(workDir, 'agent.mjs');
const ghStub = join(workDir, 'gh.mjs');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });

const ISSUE_URL = 'https://github.com/vitorengers/vibemaxxing/issues/57';

/**
 * A slow agent, and slow in the way that matters: it prints nothing until it is done.
 *
 * That is the configured command's behaviour — `claude -p` buffers until exit — and it is
 * why the salvage path cannot rescue a killed run. `SLEEP_MS` decides whether it outlives
 * the ceiling it was given.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.SLEEP_MS ?? 0)));
  process.stdout.write('investigated, wrote the issue\\n');
  process.stdout.write('${ISSUE_URL}\\n');
});
`, 'utf8');

writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('issue') && args.includes('view')) {
  process.stdout.write(JSON.stringify({
    number: 57,
    title: 'The issue agent still dies on a 1200s clock',
    body: 'Read back after the run, so the block can be retitled.',
    state: 'OPEN',
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'timeout', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Issue Timeout Check',
  repo: 'vitorengers/vibemaxxing',
}), 'utf8');

const running = [];

function startCanvas(port, extraEnv = {}) {
  const child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}"`,
      EXCALIDRAW_ISSUE_AGENT_TIMEOUT: undefined,
      ...extraEnv,
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

const port = await freePort();
const cappedPort = await freePort();

async function call(base, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${base}${path}${glue}workspace=timeout`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Write an observation, run it, and wait for the block to stop saying `running`. */
async function runBlock(base, text, attempts = 120) {
  const created = await call(base, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
      text, customData: { kind: 'issue' },
    }),
  });
  const id = created.body.element.id;
  const started = await call(base, `/api/issue-block/${id}`, { method: 'POST' });
  if (started.status !== 202) throw new Error(`the run was refused: ${JSON.stringify(started.body)}`);

  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(250);
    const element = (await call(base, `/api/elements/${id}`)).body.element;
    if (element?.customData?.issueState !== 'running') return element?.customData ?? {};
  }
  return { issueState: 'running' };
}

try {
  console.log('1. with nothing configured, there is no ceiling');
  check('the default is null, the way an implementation\'s is',
        defaultTimeout({}) === null, `got ${JSON.stringify(defaultTimeout({}))}`);

  console.log('\n2. the environment still puts one back');
  check('EXCALIDRAW_ISSUE_AGENT_TIMEOUT is read as seconds',
        defaultTimeout({ EXCALIDRAW_ISSUE_AGENT_TIMEOUT: '45' }) === 45_000,
        `got ${JSON.stringify(defaultTimeout({ EXCALIDRAW_ISSUE_AGENT_TIMEOUT: '45' }))}`);
  check('a nonsense value falls back to no ceiling',
        defaultTimeout({ EXCALIDRAW_ISSUE_AGENT_TIMEOUT: 'soon' }) === null);

  console.log('\n3. a run slower than the old ceiling still lands');
  const free = startCanvas(port, { SLEEP_MS: '3000' });
  await waitForHealth(`http://127.0.0.1:${port}`, free.child, free.read);
  const landed = await runBlock(`http://127.0.0.1:${port}`, 'The docs panel is slow on large boards');
  check('the block reports the issue it created', landed.issueState === 'created',
        `state=${landed.issueState} error=${landed.issueError}`);
  check('and the URL came back', landed.issueUrl === ISSUE_URL, `url=${landed.issueUrl}`);

  console.log('\n4. a configured ceiling is still enforced, and says so');
  const capped = startCanvas(cappedPort, { SLEEP_MS: '30000', EXCALIDRAW_ISSUE_AGENT_TIMEOUT: '2' });
  await waitForHealth(`http://127.0.0.1:${cappedPort}`, capped.child, capped.read);
  const killed = await runBlock(`http://127.0.0.1:${cappedPort}`, 'Switching tabs is slow on large boards');
  check('the run was killed', killed.issueState === 'failed',
        `state=${killed.issueState} url=${killed.issueUrl}`);
  check('the error names the ceiling it hit', /timed out after 2s/.test(killed.issueError ?? ''),
        killed.issueError);
  check('and reads as English', !/ a issue /.test(killed.issueError ?? ''), killed.issueError);
} finally {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
