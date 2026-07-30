#!/usr/bin/env node
/**
 * Checks the Resume control in a real browser.
 *
 * `check-implement-resume.mjs` covers the detection, the route and the prompt — everything
 * that can be asked of the server. None of that puts a button on screen, and the whole point
 * of the feature is that somebody looking at a stranded issue is offered a way to continue it
 * rather than only a way to start over. Three defects in this panel have compiled perfectly
 * and done none of what they claimed, which is why this exists at all.
 *
 * So the questions here are the ones only a browser can answer. Does an interrupted run put
 * **Resume** in the panel, next to **Implement / Fix** rather than instead of it? Does an issue
 * with no run at all offer neither Resume nor a reason to? And does clicking it actually resume
 * — the same checkout, with the agent told what is in it — rather than starting a second run?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: a throwaway git repository, a stub agent that hangs so it can
 * be killed at a known point, a stub `gh`, two canvas servers of its own. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-implement-resume-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (a, b) =>
  String(a ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  === String(b ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim() };
}

// ─── A project with a run that lost its server ────────────────

// Not named after this check: the worktree path ends up inside the agent's prompt, and a
// directory called `…resume…` would satisfy an assertion about what the agent was told.
const workDir = mkdtempSync(join(tmpdir(), 'check-restart-browser-'));
const projectDir = join(workDir, 'project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const REPO = 'vitorengers/mcp_excalidraw';
const WORKSPACE = 'restarted';
const STRANDED = `https://github.com/${REPO}/issues/711`;
const UNTOUCHED = `https://github.com/${REPO}/issues/712`;

mkdirSync(projectDir, { recursive: true });
git(projectDir, ['init', '-b', 'main']);
git(projectDir, ['config', 'user.email', 'check@example.com']);
git(projectDir, ['config', 'user.name', 'Check']);
git(projectDir, ['config', 'commit.gpgsign', 'false']);
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Restarted Project',
  repo: REPO,
}), 'utf8');
writeFileSync(join(projectDir, 'README.md'), '# Restarted Project\n', 'utf8');
git(projectDir, ['add', '.']);
git(projectDir, ['commit', '-m', 'initial']);

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/** Leaves a commit and an uncommitted file behind, then hangs until released. */
const agentStub = join(workDir, 'agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  try {
    writeFileSync(join(process.cwd(), 'landed-' + number + '.txt'), 'committed work\\n', 'utf8');
    execSync('git add -A && git commit -m "work in progress"', { stdio: 'ignore' });
  } catch {}
  writeFileSync(join(process.cwd(), 'unfinished-' + number + '.txt'), 'work in progress\\n', 'utf8');
  writeFileSync(join(workDir, 'run-' + number + '.json'),
    JSON.stringify({ cwd: process.cwd(), prompt: input }), 'utf8');

  for (let attempt = 0; attempt < 1800; attempt++) {
    if (existsSync(join(workDir, 'release'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

/** Enough `gh` for the panel to learn that both issues are open. */
const ghStub = join(workDir, 'gh.mjs');
writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args.find((value) => /\\/issues\\/\\d+$/.test(value)) ?? '';
const number = Number((url.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? 0);
process.stdout.write(JSON.stringify({
  number,
  title: 'Issue ' + number,
  body: 'The body, read live.',
  state: 'OPEN',
  comments: [],
}));
`, 'utf8');

const PORT = 35900 + (process.pid % 150);
const SECOND_PORT = PORT + 1;
const CDP_PORT = PORT + 300;
const BASE = `http://127.0.0.1:${PORT}`;
const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
const children = [];

let serverLog = '';
function startCanvas(port) {
  const child = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
      EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  return child;
}

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

const api = (base, path, options = {}) => fetch(
  `${base}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`,
  { headers: { 'Content-Type': 'application/json' }, ...options }
);

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function attach() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const waiting = message.id && pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
    else waiting.resolve(message.result);
  });
}

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, 'base64'));
}

/** The imperative API, through the container's React fibre. See check-board-drafts-browser. */
const GRAB_API = `(() => {
  const host = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
  if (!host) return false;
  const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
  if (!key) return false;
  let node = host[key];
  for (let up = 0; up < 60 && node; up++) {
    let state = node.memoizedState;
    for (let along = 0; along < 40 && state; along++) {
      const value = state.memoizedState;
      if (value && typeof value === 'object'
          && typeof value.getSceneElements === 'function' && typeof value.updateScene === 'function') {
        window.__resumeCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** The buttons and the prose the panel is showing right now, as the reader sees them. */
const PANEL = `(() => ({
  buttons: [...document.querySelectorAll('.element-docs__action')].map((b) => b.textContent.trim()),
  hints: [...document.querySelectorAll('.element-docs__hint')].map((p) => p.textContent),
  title: document.querySelector('.element-docs__title')?.textContent ?? null,
}))()`;

const select = (id) => evaluate(
  `window.__resumeCheckApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(id)}: true } } })`
);
const clear = () => evaluate(`window.__resumeCheckApi.updateScene({ appState: { selectedElementIds: {} } })`);

const clickButton = (label) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.element-docs__action')]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`);

async function block(base, issueUrl, title) {
  const created = await (await api(base, '/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 120, y: issueUrl === STRANDED ? 120 : 320, width: 260, height: 120,
      customData: { kind: 'issue', issueState: 'created', issueUrl, issueTitle: title },
    }),
  })).json();
  const id = created?.element?.id;
  if (!id) throw new Error(`could not create the issue block: ${JSON.stringify(created)}`);
  return id;
}

const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));

try {
  console.log('1. a run is started and its server is killed under it');
  const first = startCanvas(PORT);
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the first canvas server');

  const started = await (await api(BASE, '/api/implement', {
    method: 'POST', body: JSON.stringify({ url: STRANDED }),
  })).json();
  check('the run starts', started?.success === true, JSON.stringify(started));
  await waitFor(async () => existsSync(join(workDir, 'run-711.json')), 'the agent to reach its worktree');
  const original = runReport(711);
  check('it has a checkout of its own', existsSync(original.cwd), original.cwd);

  first.kill('SIGKILL');
  await waitFor(async () => first.exitCode !== null || first.signalCode !== null, 'the first server to die');
  // The record only ever lived in that process. Nothing else was written down.
  unlinkSync(join(workDir, 'run-711.json'));

  console.log('\n2. the panel of a restarted board offers Resume for it');
  startCanvas(SECOND_PORT);
  await waitFor(async () => (await fetch(`${SECOND}/health`)).ok, 'the restarted canvas server');
  await waitFor(async () => {
    const body = await (await api(SECOND, '/api/implement')).json();
    return (body?.runs ?? []).some((run) => run.issueUrl === STRANDED && run.state === 'interrupted');
  }, 'the restarted server to find the interrupted run');

  const strandedId = await block(SECOND, STRANDED, 'A run that lost its server');
  const untouchedId = await block(SECOND, UNTOUCHED, 'An issue nobody has started');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    SECOND,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => evaluate(
    `window.__resumeCheckApi.getSceneElements().some((e) => e.id === ${JSON.stringify(strandedId)})`
  ), 'the blocks to reach the board');

  await select(strandedId);
  const stranded = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return panel.buttons.includes('Resume') ? panel : null;
  }, 'Resume in the panel');
  await shot('01-resume-offered');
  check('Resume is on screen', stranded.buttons.includes('Resume'), JSON.stringify(stranded.buttons));
  check('and starting over is still offered beside it',
        stranded.buttons.includes('Implement / Fix'), JSON.stringify(stranded.buttons));
  check('the panel says what happened and what is in the checkout',
        stranded.hints.some((text) => /did not survive/i.test(text ?? '')
          && /uncommitted path/i.test(text ?? '')),
        JSON.stringify(stranded.hints));

  console.log('\n3. an issue nobody has started offers no Resume');
  await clear();
  await select(untouchedId);
  const untouched = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return panel.buttons.includes('Implement / Fix') && /712/.test(panel.title ?? '') ? panel : null;
  }, 'the second block in the panel');
  await shot('02-healthy');
  check('Implement / Fix is offered', untouched.buttons.includes('Implement / Fix'),
        JSON.stringify(untouched.buttons));
  check('Resume is not', !untouched.buttons.includes('Resume'), JSON.stringify(untouched.buttons));
  // #220: the other way to start the same run — in a tab that is something to answer rather
  // than something to watch. Beside "Implement / Fix" and never instead of it, which is the
  // same rule this check already holds Resume to, and for the same reason: two controls that
  // start different runs must not be one control that changes meaning with the state.
  check('and the interactive run is offered beside the ordinary one',
        untouched.buttons.includes('Implement, and let me answer'),
        JSON.stringify(untouched.buttons));

  console.log('\n4. clicking Resume continues that attempt rather than starting another');
  await clear();
  await select(strandedId);
  await waitFor(async () => (await evaluate(PANEL)).buttons.includes('Resume'), 'Resume again');
  check('the button responded to a click', await clickButton('Resume'));

  await waitFor(async () => existsSync(join(workDir, 'run-711.json')), 'the resumed agent to start');
  const resumed = runReport(711);
  await shot('03-resumed');
  check('it was put back in the same checkout', samePath(resumed.cwd, original.cwd),
        `first ${original.cwd}, resumed ${resumed.cwd}`);
  check('and told to read what the previous attempt left',
        /resuming an implementation that was interrupted/i.test(resumed.prompt)
        && /git status/i.test(resumed.prompt),
        resumed.prompt.slice(-300));

  const runs = (await (await api(SECOND, '/api/implement')).json())?.runs ?? [];
  check('there is still exactly one run for the issue',
        runs.filter((run) => run.issueUrl === STRANDED).length === 1, JSON.stringify(runs));
  check('and it is running', runs.find((run) => run.issueUrl === STRANDED)?.state === 'running',
        JSON.stringify(runs));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { writeFileSync(join(workDir, 'release'), '', 'utf8'); } catch { /* already gone */ }
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(600);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (existsSync(projectDir)) {
    git(projectDir, ['worktree', 'remove', '--force', join(workDir, 'project-worktrees', 'issue-711')]);
    git(projectDir, ['worktree', 'prune']);
  }
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
