#!/usr/bin/env node
/**
 * Checks that an implementation runs in a terminal session the board can show.
 *
 * Before this, `beginImplement` spawned a private child on three pipes and read what it had
 * written once it had exited — `stdout += chunk`, one read on close — so a board could say a
 * run was `running` and nothing else. The terminal had been built beside it and nothing ever
 * joined the two: `docs/terminal.md` recorded the gap three times.
 *
 * So the cases here are about *where the run happens*, not about the agent. A run opens a
 * session by itself, the session says whose it is and starts in the worktree of the run, its
 * output arrives while the run is still alive rather than at the end, and the run settles
 * exactly as it did before. The last group is the other half of the contract: with the
 * terminal off, with the PTY forced off, or with the session cap already full, the run must
 * still start and still settle — a tab is something a run is given, never something it needs.
 *
 * The "while it is alive" case is the one the feature exists for, and it is asserted the way
 * `scripts/check-terminal.mjs` asserts it for a shell: an agent that prints, pauses and
 * prints again has to arrive as *two* messages before it exits. One message with both halves
 * in it is the old buffering wearing a new route.
 *
 * Self-contained: it builds a throwaway git repository, writes a stub implement agent and a
 * stub shell, starts its own canvas servers on free ports and kills them. Nothing here talks
 * to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-terminal.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One spelling for paths that arrive from git, from Node and from an API. */
function samePath(a, b) {
  const clean = (value) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return clean(a) === clean(b);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() };
}

async function waitFor(predicate, what, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-terminal-${process.pid}`);
const agentStub = join(workDir, 'agent.mjs');
const shellStub = join(workDir, 'shell.mjs');
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

const projectDir = makeProject('project');
const plainDir = makeProject('plain');
const ptylessDir = makeProject('ptyless');

/**
 * Stands in for the implement agent.
 *
 * It reads its prompt from stdin the way the real one does — which is the half of the
 * contract a pseudoterminal cannot keep, so a session that hosts this has to be on pipes —
 * then prints in two bursts a second apart, waits to be released, and prints a pull request
 * URL. The two bursts are what "output arrives while the run is alive" is asserted against;
 * the wait is what keeps the run live long enough to look at it.
 *
 * Both words are spelled in halves the stub joins, because the prompt is several hundred
 * words long and an assertion about the word `first` must not be satisfied by a transcript
 * that merely echoed the prompt back.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'),
    JSON.stringify({ cwd: process.cwd(), promptLength: input.length }), 'utf8');

  process.stdout.write('fir' + 'st burst\\n');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  process.stdout.write('seco' + 'nd burst\\n');

  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/pull/' + number + '\\n');
});
`, 'utf8');

/** Stands in for the operator's shell: it starts, and it stays up until it is killed. */
writeFileSync(shellStub, `setInterval(() => {}, 1000);\n`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'hosted', path: projectDir.replace(/\\/g, '/') },
    { id: 'plain', path: plainDir.replace(/\\/g, '/') },
    { id: 'ptyless', path: ptylessDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];
const agentCommand = `node "${agentStub.replace(/\\/g, '/')}"`;
const shellCommand = `node "${shellStub.replace(/\\/g, '/')}"`;

function startCanvas(port, extraEnv = {}) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_IMPLEMENT_AGENT: agentCommand,
  };
  // Removed before `extraEnv` puts back whichever of them this server wants, because
  // "unset" is one of the states under test and a check cannot assert it while inheriting
  // it. A board running on the same machine exports `EXCALIDRAW_TERMINAL=1`, so the case
  // about a board with no terminal was quietly being run against one that had it.
  delete env.EXCALIDRAW_TERMINAL;
  delete env.EXCALIDRAW_TERMINAL_PTY;
  Object.assign(env, extraEnv);

  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, server) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`the canvas server exited early:\n${server.read()}`);
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${server.read()}`);
}

/** A viewer of one board, keeping every terminal message it was sent, in order. */
function watch(port, workspace) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?workspace=${workspace}`);
  const messages = [];
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (String(message?.type ?? '').startsWith('terminal_')) messages.push(message);
    } catch { /* not for us */ }
  });
  const open = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { open, messages, close: () => { try { socket.close(); } catch { /* gone */ } } };
}

const PORT = 38600 + (process.pid % 300);
const PLAIN_PORT = PORT + 1;
const PTYLESS_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;
const PLAIN_BASE = `http://127.0.0.1:${PLAIN_PORT}`;
const PTYLESS_BASE = `http://127.0.0.1:${PTYLESS_PORT}`;

async function call(base, workspace, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}${glue}workspace=${workspace}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const issue = (n) => `https://github.com/vitorengers/mcp_excalidraw/issues/${n}`;
const release = (n) => writeFileSync(join(workDir, `release-${n}`), '', 'utf8');
const started = (n) => existsSync(join(workDir, `run-${n}.json`));
const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));

function startRun(base, workspace, n) {
  return call(base, workspace, '/api/implement', {
    method: 'POST',
    body: JSON.stringify({ url: issue(n) }),
  });
}

async function readRecord(base, workspace, n) {
  return (await call(base, workspace, `/api/implement?url=${encodeURIComponent(issue(n))}`))
    .body?.implement ?? null;
}

async function settled(base, workspace, n, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const record = await readRecord(base, workspace, n);
    if (record?.state && record.state !== 'running') return record;
    await sleep(150);
  }
  return null;
}

const viewers = [];
function stopAll() {
  for (const viewer of viewers) viewer.close();
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(PORT, { EXCALIDRAW_TERMINAL: shellCommand });
  await waitForHealth(BASE, server);
  const viewer = watch(PORT, 'hosted');
  viewers.push(viewer);
  await viewer.open;

  console.log('1. a run opens a tab by itself, and the tab says whose it is');
  const before = await call(BASE, 'hosted', '/api/terminal');
  check('the board has no session before the run',
        (before.body?.sessions ?? []).length === 0, JSON.stringify(before.body?.sessions));

  const accepted = await startRun(BASE, 'hosted', 301);
  check('the run is accepted', accepted.status === 202,
        `got ${accepted.status} ${JSON.stringify(accepted.body)}`);

  await waitFor(() => viewer.messages.some((message) => message.type === 'terminal_session'),
                'the run to announce a session nobody asked for');
  const announced = viewer.messages.find((message) => message.type === 'terminal_session');
  const session = announced?.session ?? null;
  check('a session was announced without anyone opening one', Boolean(session),
        JSON.stringify(viewer.messages.map((message) => message.type)));
  check('and it names the agent that owns it', session?.owner?.agent === 'implement',
        JSON.stringify(session?.owner));
  check('and the issue it is running', session?.owner?.issueUrl === issue(301),
        JSON.stringify(session?.owner));
  check('with a label short enough to be a tab', (session?.owner?.label ?? '').includes('301'),
        JSON.stringify(session?.owner?.label));

  console.log('\n2. the tab is the worktree of the run, not the project');
  await waitFor(() => started(301), 'the agent to report where it was started');
  const run301 = started(301) ? runReport(301) : { cwd: '', promptLength: 0 };
  check('the agent got its prompt on stdin, as it always did', run301.promptLength > 400,
        `${run301.promptLength} characters arrived`);
  check('the session starts where the agent runs', samePath(session?.cwd, run301.cwd),
        `session=${session?.cwd} agent=${run301.cwd}`);
  check('which is not the tree the board lives in', !samePath(run301.cwd, projectDir),
        `both ${projectDir}`);
  check('the session is on pipes, because a prompt needs an end of file',
        session?.mode === 'pipe', String(session?.mode));

  console.log('\n3. output arrives while the run is alive, not at the end');
  const outputs = () => viewer.messages.filter(
    (message) => message.type === 'terminal_output' && message.sessionId === session?.id
  );
  await waitFor(() => outputs().some((message) => String(message.data).includes('first burst')),
                'the first burst');
  const midRun = await readRecord(BASE, 'hosted', 301);
  check('the record still says the run is going', midRun?.state === 'running', JSON.stringify(midRun));
  check('and the record names the session it is running in',
        Boolean(session?.id) && midRun?.terminal === session.id,
        `record says ${JSON.stringify(midRun?.terminal)}, session is ${session?.id}`);

  await waitFor(() => outputs().some((message) => String(message.data).includes('second burst')),
                'the second burst');
  check('the two bursts arrived as two messages, not one buffered at the end',
        outputs().filter((message) => /first burst|second burst/.test(String(message.data))).length >= 2,
        JSON.stringify(outputs().map((message) => message.data)));
  check('and both arrived before the process exited',
        outputs().length > 0
          && !viewer.messages.some((message) => message.type === 'terminal_exit'
                                             && message.sessionId === session?.id),
        outputs().length ? 'the session had already exited' : 'nothing was streamed at all');

  console.log('\n4. the run settles exactly as it did before');
  release(301);
  const done = await settled(BASE, 'hosted', 301);
  check('it finished', done?.state === 'done', JSON.stringify(done));
  check('with the pull request it printed', /\/pull\/301$/.test(done?.url ?? ''), done?.url);
  check('and the record still names the tab it ran in',
        Boolean(session?.id) && done?.terminal === session.id,
        JSON.stringify(done?.terminal));

  console.log('\n5. the tab goes back to the board when the run ends');
  await waitFor(() => viewer.messages.some((message) => message.type === 'terminal_exit'
                                                     && message.sessionId === session?.id),
                'the session to be announced as exited');
  const after = await call(BASE, 'hosted', '/api/terminal');
  check('the session no longer holds a slot',
        Boolean(session?.id) && !(after.body?.sessions ?? []).some((one) => one.id === session.id),
        JSON.stringify((after.body?.sessions ?? []).map((one) => one.id)));

  console.log('\n6. a full cap costs the run its tab and nothing else');
  const opened = [];
  for (let index = 0; index < 20; index++) {
    const response = await call(BASE, 'hosted', '/api/terminal', { method: 'POST' });
    if (response.status !== 202) break;
    opened.push(response.body?.session?.id);
  }
  const full = await call(BASE, 'hosted', '/api/terminal', { method: 'POST' });
  check('the cap is reachable by hand', full.status === 409, `got ${full.status} after ${opened.length}`);

  const capped = await startRun(BASE, 'hosted', 303);
  check('a run still starts with the cap full', capped.status === 202,
        `got ${capped.status} ${JSON.stringify(capped.body)}`);
  await waitFor(() => started(303), 'the run refused a tab to run anyway');
  const cappedRecord = await readRecord(BASE, 'hosted', 303);
  check('and the record says it had no tab', cappedRecord?.terminal === null,
        JSON.stringify(cappedRecord?.terminal));
  release(303);
  const cappedDone = await settled(BASE, 'hosted', 303);
  check('it settles all the same', cappedDone?.state === 'done', JSON.stringify(cappedDone));
  check('with its pull request', /\/pull\/303$/.test(cappedDone?.url ?? ''), cappedDone?.url);

  console.log('\n7. with the terminal off, a run is what it always was');
  const plain = startCanvas(PLAIN_PORT);
  await waitForHealth(PLAIN_BASE, plain);
  const plainViewer = watch(PLAIN_PORT, 'plain');
  viewers.push(plainViewer);
  await plainViewer.open;

  const plainRun = await startRun(PLAIN_BASE, 'plain', 304);
  check('the run is accepted', plainRun.status === 202,
        `got ${plainRun.status} ${JSON.stringify(plainRun.body)}`);
  await waitFor(() => started(304), 'the run to start with no terminal to run in');
  const plainRecord = await readRecord(PLAIN_BASE, 'plain', 304);
  check('the record says it had no tab', plainRecord?.terminal === null,
        JSON.stringify(plainRecord?.terminal));
  release(304);
  const plainDone = await settled(PLAIN_BASE, 'plain', 304);
  check('and it settles', plainDone?.state === 'done', JSON.stringify(plainDone));
  check('with its pull request', /\/pull\/304$/.test(plainDone?.url ?? ''), plainDone?.url);
  check('nothing announced a session on a board with no terminal',
        !plainViewer.messages.some((message) => message.type === 'terminal_session'),
        JSON.stringify(plainViewer.messages.map((message) => message.type)));

  console.log('\n8. with no PTY binding, a run still gets its tab');
  const ptyless = startCanvas(PTYLESS_PORT, {
    EXCALIDRAW_TERMINAL: shellCommand,
    EXCALIDRAW_TERMINAL_PTY: '0',
  });
  await waitForHealth(PTYLESS_BASE, ptyless);
  const ptylessViewer = watch(PTYLESS_PORT, 'ptyless');
  viewers.push(ptylessViewer);
  await ptylessViewer.open;

  const ptylessRun = await startRun(PTYLESS_BASE, 'ptyless', 305);
  check('the run is accepted', ptylessRun.status === 202,
        `got ${ptylessRun.status} ${JSON.stringify(ptylessRun.body)}`);
  await waitFor(() => ptylessViewer.messages.some((message) => message.type === 'terminal_session'),
                'a session on a board with the PTY forced off');
  release(305);
  const ptylessDone = await settled(PTYLESS_BASE, 'ptyless', 305);
  check('and it settles', ptylessDone?.state === 'done', JSON.stringify(ptylessDone));
  check('with its pull request', /\/pull\/305$/.test(ptylessDone?.url ?? ''), ptylessDone?.url);
} finally {
  for (const n of [301, 302, 303, 304, 305]) {
    try { release(n); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
  stopAll();
  await sleep(300);
  for (const dir of [projectDir, plainDir, ptylessDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
