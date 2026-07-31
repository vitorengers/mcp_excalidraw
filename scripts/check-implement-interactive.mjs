#!/usr/bin/env node
/**
 * Checks that an implementation whose command is interactive runs in a tab a reader can use.
 *
 * A run has had a tab since `check-implement-terminal.mjs`, and what that tab showed was
 * whatever the configured command printed. For the command the board is actually configured
 * with — `claude -p --output-format stream-json --verbose` — that is NDJSON, and the session
 * was read-only by construction: the prompt was written to stdin and stdin was ended, and a
 * pseudoterminal has no end of file, so an owned session could never be on one.
 *
 * The shape of the command is what decides now, mirroring `streamsUsage()`. A command that
 * says `-p` is headless and everything about it stays exactly what it was. A command that
 * does not is started on a pseudoterminal with the prompt as its last argument, so stdin is
 * never spent and what the reader types reaches the agent.
 *
 * So the cases here are about the two shapes, side by side. The interactive one has to be on
 * a PTY, has to still say whose tab it is, has to have been given its prompt without stdin,
 * has to carry a keystroke through to the process, and has to settle `done` with the pull
 * request it printed. The headless one has to be indistinguishable from the run this
 * repository had before any of it: pipes, the prompt on stdin, and a tab that refuses input
 * rather than answering 202 for bytes it drops.
 *
 * Self-contained: it builds throwaway git repositories, writes a stub implement agent and a
 * stub shell, starts its own canvas servers on free ports and kills them. Nothing here talks
 * to GitHub. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-implement-interactive.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

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

const workDir = join(tmpdir(), `implement-interactive-${process.pid}`);
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
                JSON.stringify({ name, repo: 'vitorengers/vibemaxxing' }), 'utf8');
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial']);
  return dir;
}

const liveDir = makeProject('live');
const headlessDir = makeProject('headless');

/**
 * Stands in for the implement agent, in whichever of the two shapes it was started in.
 *
 * The shape is read the way the server reads it: `-p` among its arguments means the prompt
 * comes on stdin and the run is over when it has printed. Without it the prompt is expected
 * as the last argument, stdin is a terminal it puts into raw mode — which is what every
 * full-screen program does, and what makes a keystroke arrive as a keystroke — and the run
 * ends when it is told to end.
 *
 * It reports how it was started to a file, because that is the half of the contract no
 * transcript can show: a prompt that arrived on stdin and a prompt that arrived as an
 * argument look identical once the agent has read either.
 *
 * Every marker it prints is spelled in halves it joins, so that an assertion about the word
 * cannot be satisfied by a transcript that merely echoed the prompt back.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const args = process.argv.slice(2).filter((one) => one !== '-p');
const headless = process.argv.slice(2).includes('-p');

// Nothing here may outlive the check, whichever shape it was started in.
setTimeout(() => process.exit(3), 120000).unref?.();

function report(prompt, via) {
  const number = (prompt.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({
    via,
    promptLength: prompt.length,
    cwd: process.cwd(),
    tty: Boolean(process.stdin.isTTY),
  }), 'utf8');
  return number;
}

const url = (number) => 'https://github.com/vitorengers/vibemaxxing/pull/' + number;

if (headless) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk.toString(); });
  process.stdin.on('end', () => {
    const number = report(input, 'stdin');
    process.stdout.write('fir' + 'st burst\\n');
    // Anything the board managed to send after the prompt would arrive here; it must not.
    process.stdin.on('data', (chunk) => process.stdout.write('hea' + 'rd:' + chunk.toString() + '\\n'));
    setTimeout(() => {
      process.stdout.write(url(number) + '\\n');
      process.exit(0);
    }, 1500);
  });
} else {
  const number = report(args[args.length - 1] ?? '', 'argv');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('fir' + 'st burst\\n');
  let typed = '';
  process.stdin.on('data', (chunk) => {
    const text = chunk.toString();
    typed += text;
    process.stdout.write('\\nhea' + 'rd:' + text.replace(/[\\r\\n]/g, '') + '\\n');
    if (/zzfinish/.test(typed)) {
      process.stdout.write(url(number) + '\\n');
      setTimeout(() => process.exit(0), 200);
    }
  });
}
`, 'utf8');

/** Stands in for the operator's shell: it starts, and it stays up until it is killed. */
writeFileSync(shellStub, `setInterval(() => {}, 1000);\n`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'live', path: liveDir.replace(/\\/g, '/') },
    { id: 'headless', path: headlessDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const running = [];
const stubPath = agentStub.replace(/\\/g, '/');
const shellCommand = `node "${shellStub.replace(/\\/g, '/')}"`;

function startCanvas(port, agentCommand) {
  const env = {
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_IMPLEMENT_AGENT: agentCommand,
    EXCALIDRAW_TERMINAL: shellCommand,
  };
  // The PTY is the thing under test, and a machine that exports the override must not be
  // allowed to answer the question for this check — which is why nothing here inherits it.

  const child = spawnCanvas({
    env,
  }).child;
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

const PORT = await freePort();
const HEADLESS_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const HEADLESS_BASE = `http://127.0.0.1:${HEADLESS_PORT}`;

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

const issue = (n) => `https://github.com/vitorengers/vibemaxxing/issues/${n}`;
const started = (n) => existsSync(join(workDir, `run-${n}.json`));
const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));

function startRun(base, workspace, n) {
  return call(base, workspace, '/api/implement', {
    method: 'POST',
    body: JSON.stringify({ url: issue(n) }),
  });
}

function type(base, workspace, sessionId, data) {
  return call(base, workspace, '/api/terminal/input', {
    method: 'POST',
    body: JSON.stringify({ sessionId, data }),
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
  const server = startCanvas(PORT, `node "${stubPath}"`);
  await waitForHealth(BASE, server);
  const viewer = watch(PORT, 'live');
  viewers.push(viewer);
  await viewer.open;

  console.log('1. a command with no -p opens a tab that is a terminal');
  const accepted = await startRun(BASE, 'live', 401);
  check('the run is accepted', accepted.status === 202,
        `got ${accepted.status} ${JSON.stringify(accepted.body)}`);

  await waitFor(() => viewer.messages.some((message) => message.type === 'terminal_session'),
                'the run to announce a session nobody asked for');
  const announced = viewer.messages.find((message) => message.type === 'terminal_session');
  const session = announced?.session ?? null;
  check('a session was announced without anyone opening one', Boolean(session),
        JSON.stringify(viewer.messages.map((message) => message.type)));
  check('and it is on a pseudoterminal, not on pipes', session?.mode === 'pty',
        String(session?.mode));
  check('and it still names the agent that owns it', session?.owner?.agent === 'implement',
        JSON.stringify(session?.owner));
  check('and the issue it is running', session?.owner?.issueUrl === issue(401),
        JSON.stringify(session?.owner));
  check('with a label short enough to be a tab', (session?.owner?.label ?? '').includes('401'),
        JSON.stringify(session?.owner?.label));
  check('and it does not claim to be read-only', session?.readOnly === false,
        JSON.stringify(session?.readOnly));

  console.log('\n2. the prompt arrived without spending stdin');
  await waitFor(() => started(401), 'the agent to report how it was started');
  const run401 = started(401) ? runReport(401) : {};
  check('the agent was given its prompt as an argument', run401.via === 'argv',
        JSON.stringify(run401.via));
  check('and all of it', (run401.promptLength ?? 0) > 400, `${run401.promptLength} characters`);
  check('and its stdin is a terminal, so a full-screen program would draw one',
        run401.tty === true, JSON.stringify(run401.tty));
  check('the session starts where the agent runs', samePath(session?.cwd, run401.cwd),
        `session=${session?.cwd} agent=${run401.cwd}`);
  check('which is not the tree the board lives in', !samePath(run401.cwd, liveDir),
        `both ${liveDir}`);

  console.log('\n3. a keystroke reaches the process');
  const outputs = () => viewer.messages
    .filter((message) => message.type === 'terminal_output' && message.sessionId === session?.id)
    .map((message) => String(message.data))
    .join('');
  await waitFor(() => outputs().includes('first burst'), 'the agent to say it had started');

  // A word no prompt contains: the stub echoes whatever reaches it, and the prompt reaches
  // it too on the path this replaces, so an assertion on an ordinary word would pass on a
  // session that had merely been handed its prompt.
  const typed = await type(BASE, 'live', session?.id, 'zzping\r');
  check('the board took the keystroke', typed.status === 202,
        `got ${typed.status} ${JSON.stringify(typed.body)}`);
  await waitFor(() => /heard:[^\n]*zzping/.test(outputs()), 'the agent to say what it heard');
  check('the agent heard what was typed, and it came back in the transcript',
        /heard:[^\n]*zzping/.test(outputs()), JSON.stringify(outputs().slice(-300)));

  const midRun = await readRecord(BASE, 'live', 401);
  check('and the record still says the run is going', midRun?.state === 'running',
        JSON.stringify(midRun));
  check('in the tab it named', Boolean(session?.id) && midRun?.terminal === session.id,
        `record says ${JSON.stringify(midRun?.terminal)}, session is ${session?.id}`);

  console.log('\n4. the run still settles done, with the pull request it printed');
  await type(BASE, 'live', session?.id, 'zzfinish\r');
  const done = await settled(BASE, 'live', 401);
  check('it finished', done?.state === 'done', JSON.stringify(done));
  check('with the pull request it printed', /\/pull\/401$/.test(done?.url ?? ''), done?.url);
  check('and the record still names the tab it ran in',
        Boolean(session?.id) && done?.terminal === session.id,
        JSON.stringify(done?.terminal));

  console.log('\n5. a -p command is byte for byte the run it always was');
  const headless = startCanvas(HEADLESS_PORT, `node "${stubPath}" -p`);
  await waitForHealth(HEADLESS_BASE, headless);
  const headlessViewer = watch(HEADLESS_PORT, 'headless');
  viewers.push(headlessViewer);
  await headlessViewer.open;

  const headlessRun = await startRun(HEADLESS_BASE, 'headless', 402);
  check('the run is accepted', headlessRun.status === 202,
        `got ${headlessRun.status} ${JSON.stringify(headlessRun.body)}`);
  await waitFor(() => headlessViewer.messages.some((message) => message.type === 'terminal_session'),
                'the headless run to announce its session');
  const headlessSession = headlessViewer.messages
    .find((message) => message.type === 'terminal_session')?.session ?? null;
  check('it is on pipes, because a prompt still needs an end of file',
        headlessSession?.mode === 'pipe', String(headlessSession?.mode));
  check('and it says so: the tab is read-only', headlessSession?.readOnly === true,
        JSON.stringify(headlessSession?.readOnly));

  await waitFor(() => started(402), 'the headless agent to report how it was started');
  const run402 = started(402) ? runReport(402) : {};
  check('the agent got its prompt on stdin, as it always did', run402.via === 'stdin',
        JSON.stringify(run402.via));
  check('and all of it', (run402.promptLength ?? 0) > 400, `${run402.promptLength} characters`);

  const refused = await type(HEADLESS_BASE, 'headless', headlessSession?.id, 'zzping\r');
  check('and typing into it is refused rather than answered with a sequence number',
        refused.status === 409, `got ${refused.status} ${JSON.stringify(refused.body)}`);
  const headlessOutputs = () => headlessViewer.messages
    .filter((message) => message.type === 'terminal_output' && message.sessionId === headlessSession?.id)
    .map((message) => String(message.data))
    .join('');
  check('nothing the reader typed was echoed into the transcript',
        !/zzping/.test(headlessOutputs()), JSON.stringify(headlessOutputs().slice(-300)));

  const headlessDone = await settled(HEADLESS_BASE, 'headless', 402);
  check('and it settles as it always did', headlessDone?.state === 'done',
        JSON.stringify(headlessDone));
  check('with its pull request', /\/pull\/402$/.test(headlessDone?.url ?? ''), headlessDone?.url);
} finally {
  await sleep(400);
  stopAll();
  await sleep(300);
  for (const dir of [liveDir, headlessDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
