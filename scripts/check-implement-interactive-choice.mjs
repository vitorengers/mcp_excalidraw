#!/usr/bin/env node
/**
 * Checks that the board can ask for an interactive tab, rather than an environment variable
 * being the only way to have one.
 *
 * #178 gave a run two shapes and let the operator's own command line pick between them: with
 * `-p` the prompt goes to stdin, the session is on pipes and the tab is read-only; without it
 * the prompt travels as the last argument, the session keeps a pseudoterminal and the tab is
 * something to answer. That is the right *default* and it is unchanged. What it is not is a
 * choice anybody can make at the moment they make it — it is `EXCALIDRAW_IMPLEMENT_AGENT` and
 * a server restart, and the same request has now been made twice (#174, #220). #220's comment
 * settled it: the board should offer it.
 *
 * So the offer is per run, and it only ever *removes*. `withoutPrintFlags` takes `-p` and
 * `--print` out, and with them the options Claude Code documents as working only with
 * `--print` — `--output-format`, `--input-format`, `--include-partial-messages` — because a
 * command left carrying those would be refused by the CLI the moment `-p` went. Nothing is
 * ever added: a board cannot invent `--output-format stream-json` for a command it does not
 * own, so a command that is already interactive stays interactive and the queue keeps the
 * headless one it is configured with. That asymmetry is the feature, not an omission.
 *
 * And it refuses rather than degrades. A reader who asked for a tab they can type into and got
 * a private child with its print flags stripped would be worse off than before — no interface,
 * no token counts, nothing to answer. So when the board cannot give a pseudoterminal, the
 * request is a 409 that says why, and no run starts.
 *
 * Self-contained: throwaway git repositories, a stub implement agent, a stub shell, its own
 * canvas servers on free ports. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-implement-interactive-choice.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

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
    if (await predicate()) return true;
    await sleep(100);
  }
  console.error(`  FAIL  timed out waiting for ${what}`);
  failures++;
  return false;
}

// ─── The command line, on its own ─────────────────────────────

const issueAgent = join(repoRoot, 'dist', 'core', 'issue-agent.js');
if (!existsSync(issueAgent)) {
  console.error('  FAIL  the built server exists — dist/core/issue-agent.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { withoutPrintFlags, runsHeadless } = await import(pathToFileURL(issueAgent).href);

console.log('1. the print flags come off a command line, and nothing else does');
check('`withoutPrintFlags` exists', typeof withoutPrintFlags === 'function',
      typeof withoutPrintFlags);
if (typeof withoutPrintFlags === 'function') {
  const cases = [
    // The board's own command line, which is the one this exists for.
    ['claude -p --output-format stream-json --verbose', 'claude --verbose'],
    ['claude --print', 'claude'],
    // The value goes with the option, or the next word becomes the prompt.
    ['claude -p --output-format json', 'claude'],
    ['claude -p --output-format=stream-json', 'claude'],
    ['claude -p --input-format stream-json --include-partial-messages', 'claude'],
    // Everything else is the operator's and is left alone, including a model this board set.
    ['claude -p --model sonnet --add-dir /tmp', 'claude --model sonnet --add-dir /tmp'],
    // Already interactive: unchanged, byte for byte.
    ['claude --verbose', 'claude --verbose'],
    // Not flags. `--print-mode` is not `--print`, and a path with `-p` in it is a path.
    ['claude --print-mode fancy', 'claude --print-mode fancy'],
    ['/opt/claude-p/claude --verbose', '/opt/claude-p/claude --verbose'],
  ];
  for (const [given, expected] of cases) {
    check(`${JSON.stringify(given)} → ${JSON.stringify(expected)}`,
          withoutPrintFlags(given) === expected, JSON.stringify(withoutPrintFlags(given)));
  }
  check('and what comes out no longer reads as headless',
        !runsHeadless(withoutPrintFlags('claude -p --output-format stream-json --verbose')),
        withoutPrintFlags('claude -p --output-format stream-json --verbose'));
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `implement-choice-${process.pid}`);
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

const boardDir = makeProject('board');
const bareDir = makeProject('bare');

/**
 * Stands in for the implement agent, and writes down how it was started.
 *
 * The argv is the whole point here: what a per-run choice changes is the command line, and a
 * transcript cannot show a flag that was never passed. So the stub records it, and the cases
 * below read it back rather than inferring it from the tab's mode.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const argv = process.argv.slice(2);
const headless = argv.includes('-p') || argv.includes('--print');

setTimeout(() => process.exit(3), 120000).unref?.();

function report(prompt, via) {
  const number = (prompt.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  writeFileSync(join(workDir, 'run-' + number + '.json'), JSON.stringify({
    via,
    argv,
    tty: Boolean(process.stdin.isTTY),
    promptLength: prompt.length,
  }), 'utf8');
  return number;
}

const url = (number) => 'https://github.com/vitorengers/mcp_excalidraw/pull/' + number;

if (headless) {
  let input = '';
  process.stdin.on('data', (chunk) => { input += chunk.toString(); });
  process.stdin.on('end', () => {
    const number = report(input, 'stdin');
    setTimeout(() => { process.stdout.write(url(number) + '\\n'); process.exit(0); }, 300);
  });
} else {
  // The prompt is the last argument, which is where buildAgentCommand puts it without -p.
  const number = report(argv[argv.length - 1] ?? '', 'argv');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('sta' + 'rted\\n');
  // An interactive command is ended by the reader; this one ends itself, so the check does
  // not have to drive a session to prove what it is about. What it *is* about — the shape of
  // the command line and the shape of the tab — is settled by the time this fires.
  setTimeout(() => { process.stdout.write(url(number) + '\\n'); process.exit(0); }, 1200);
}
`, 'utf8');

/** Stands in for the operator's shell: it starts, and it stays up until it is killed. */
writeFileSync(shellStub, 'setInterval(() => {}, 1000);\n', 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'board', path: boardDir.replace(/\\/g, '/') },
    { id: 'bare', path: bareDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];
const stubPath = agentStub.replace(/\\/g, '/');
const shellCommand = `node "${shellStub.replace(/\\/g, '/')}"`;

// What this board is really configured with, and the reason the choice has to remove more
// than `-p`: `--output-format` is refused by the CLI the moment `--print` is gone.
const AGENT_COMMAND = `node "${stubPath}" -p --output-format stream-json --verbose`;

function startCanvas(port, extraEnv) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_IMPLEMENT_AGENT: AGENT_COMMAND,
    EXCALIDRAW_TERMINAL: shellCommand,
    ...extraEnv,
  };
  // The PTY is what an interactive run rests on, so a machine that exports the override must
  // not be allowed to answer the question for this check.
  delete env.EXCALIDRAW_TERMINAL_PTY;
  for (const [name, value] of Object.entries(extraEnv ?? {})) {
    if (value === undefined) delete env[name];
  }

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

const PORT = 39300 + (process.pid % 300);
const BARE_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const BARE_BASE = `http://127.0.0.1:${BARE_PORT}`;

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
const started = (n) => existsSync(join(workDir, `run-${n}.json`));
const runReport = (n) => JSON.parse(readFileSync(join(workDir, `run-${n}.json`), 'utf8'));

function startRun(base, workspace, n, body = {}) {
  return call(base, workspace, '/api/implement', {
    method: 'POST',
    body: JSON.stringify({ url: issue(n), ...body }),
  });
}

const viewers = [];
function stopAll() {
  for (const viewer of viewers) viewer.close();
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(PORT);
  await waitForHealth(BASE, server);
  const viewer = watch(PORT, 'board');
  viewers.push(viewer);
  await viewer.open;

  const sessionsOf = () => viewer.messages
    .filter((message) => message.type === 'terminal_session')
    .map((message) => message.session);
  const sessionFor = (n) => sessionsOf().find((one) => one?.owner?.issueUrl === issue(n)) ?? null;

  console.log('\n2. asking for nothing is the run this board always had');
  const plain = await startRun(BASE, 'board', 501);
  check('the run is accepted', plain.status === 202,
        `got ${plain.status} ${JSON.stringify(plain.body)}`);
  await waitFor(() => sessionFor(501), 'the ordinary run to announce its tab');
  const plainSession = sessionFor(501);
  check('its tab is on pipes', plainSession?.mode === 'pipe', String(plainSession?.mode));
  check('and read-only, because its stdin went to the prompt', plainSession?.readOnly === true,
        JSON.stringify(plainSession?.readOnly));

  await waitFor(() => started(501), 'the agent to report how it was started');
  const run501 = started(501) ? runReport(501) : {};
  check('the agent got its prompt on stdin', run501.via === 'stdin', JSON.stringify(run501.via));
  check('and the operator\'s command line reached it whole, print flags and all',
        (run501.argv ?? []).includes('-p') && (run501.argv ?? []).includes('--output-format')
        && (run501.argv ?? []).includes('stream-json') && (run501.argv ?? []).includes('--verbose'),
        JSON.stringify(run501.argv));

  console.log('\n3. asking for an interactive tab gets one, from the same command line');
  const asked = await startRun(BASE, 'board', 502, { interactive: true });
  check('the run is accepted', asked.status === 202,
        `got ${asked.status} ${JSON.stringify(asked.body)}`);
  await waitFor(() => sessionFor(502), 'the interactive run to announce its tab');
  const askedSession = sessionFor(502);
  check('its tab is on a pseudoterminal', askedSession?.mode === 'pty', String(askedSession?.mode));
  check('and it is not read-only, so there is something to type into',
        askedSession?.readOnly === false, JSON.stringify(askedSession?.readOnly));
  check('and it still says whose tab it is', askedSession?.owner?.agent === 'implement',
        JSON.stringify(askedSession?.owner));

  await waitFor(() => started(502), 'the interactive agent to report how it was started');
  const run502 = started(502) ? runReport(502) : {};
  check('the agent got its prompt as the last argument, so stdin was never spent',
        run502.via === 'argv', JSON.stringify(run502.via));
  check('and all of it', (run502.promptLength ?? 0) > 400, `${run502.promptLength} characters`);
  check('its stdin is a terminal, so a full-screen program would draw one',
        run502.tty === true, JSON.stringify(run502.tty));
  check('the print flags are gone from the command line it was given',
        !(run502.argv ?? []).includes('-p') && !(run502.argv ?? []).includes('--print'),
        JSON.stringify(run502.argv));
  check('and so is the output format, which the CLI refuses without them',
        !(run502.argv ?? []).includes('--output-format')
        && !(run502.argv ?? []).includes('stream-json'),
        JSON.stringify(run502.argv));
  check('everything else the operator wrote is still there',
        (run502.argv ?? []).includes('--verbose'), JSON.stringify(run502.argv));

  console.log('\n4. a board with no terminal refuses rather than running it headless anyway');
  const bare = startCanvas(BARE_PORT, { EXCALIDRAW_TERMINAL: undefined });
  await waitForHealth(BARE_BASE, bare);

  const refused = await startRun(BARE_BASE, 'bare', 503, { interactive: true });
  check('the request is a conflict, not a silent downgrade', refused.status === 409,
        `got ${refused.status} ${JSON.stringify(refused.body)}`);
  check('and it says the terminal is what is missing',
        /terminal/i.test(refused.body?.error ?? ''), JSON.stringify(refused.body?.error));
  await sleep(600);
  check('nothing was started', !started(503), 'the agent reported a run');

  const ordinary = await startRun(BARE_BASE, 'bare', 504);
  check('while an ordinary run on the same board is untouched', ordinary.status === 202,
        `got ${ordinary.status} ${JSON.stringify(ordinary.body)}`);
  await waitFor(() => started(504), 'the ordinary run on a terminal-less board');
  const run504 = started(504) ? runReport(504) : {};
  check('and it is the command line the operator wrote',
        (run504.argv ?? []).includes('-p') && (run504.argv ?? []).includes('--output-format'),
        JSON.stringify(run504.argv));
} finally {
  await sleep(400);
  stopAll();
  await sleep(300);
  for (const dir of [boardDir, bareDir]) {
    if (existsSync(dir)) git(dir, ['worktree', 'prune']);
  }
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
