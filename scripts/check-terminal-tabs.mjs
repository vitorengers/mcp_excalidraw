#!/usr/bin/env node
/**
 * Checks that a board can hold more than one shell, and that each one is addressable.
 *
 * The terminal was built as one session per board — keyed by workspace alone, with no
 * vocabulary anywhere for *which* session: not in the routes, not on the socket, not in the
 * element id. `check-terminal.mjs` asserts that rule from the inside, which is why relaxing
 * it needs a check of its own rather than an edit to that one.
 *
 * The rule was a guard, not an oversight — this runs whatever arrives over an unauthenticated
 * API — so what is asserted here is a guard **relaxed from 1 to N**, cap and all, rather than
 * a limitation removed. The cap answering 409 is as much a case as the second session being
 * accepted.
 *
 * The cases that matter are the ones where an id being ignored would still look like it
 * worked: input sent to one session must reach *that* one and no other, and closing one must
 * leave the other's shell running. A server that resolved "whichever one is open" would pass
 * a naive two-session test and fail both of these.
 *
 * Pipes rather than a PTY (`EXCALIDRAW_TERMINAL_PTY=0`), because these cases are about
 * routing rather than about terminals: a piped session echoes what it was sent into its own
 * transcript, which is exactly what makes "it went to that session and not this one"
 * something a transcript can answer.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas server on a free
 * port and kills it. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal-tabs.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** A module from `dist`, or nothing — so a missing build fails one case rather than the run. */
async function importDist(relative, what) {
  const full = join(repoRoot, 'dist', relative);
  if (!existsSync(full)) {
    failures++;
    console.error(`  FAIL  ${what} is built — dist/${relative.replace(/\\/g, '/')} not found`);
    return null;
  }
  return import(pathToFileURL(full).href);
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `terminal-tabs-check-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Terminal Tabs Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'tabs-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/**
 * A shell that is not a shell: it echoes back whatever it is told, prefixed.
 *
 * The prefix is what makes a transcript answer "did this arrive here": the session already
 * writes what it was sent into its own transcript, so the word alone would be there whether
 * the shell saw it or not.
 */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => process.stdout.write('heard[' + chunk.trim() + ']\\n'));
setInterval(() => {}, 1000);
`, 'utf8');
const stubCommand = `node "${stubShell.replace(/\\/g, '/')}"`;

// ─── The server ───────────────────────────────────────────────

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const running = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: stubCommand,
    EXCALIDRAW_TERMINAL_PTY: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
running.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode !== null) throw new Error(`the canvas server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${BASE}:\n${serverLog}`);
}

/** One request, with two more goes at the connection rather than at the case. */
async function call(path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}${glue}workspace=${WORKSPACE}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

async function waitFor(predicate, what, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return true;
    await sleep(100);
  }
  failures++;
  console.error(`  FAIL  timed out waiting for ${what}`);
  return false;
}

/** A viewer of one board, keeping every terminal message it was sent. */
function watch() {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/?workspace=${WORKSPACE}`);
  const messages = [];
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (String(message?.type ?? '').startsWith('terminal_')) messages.push(message);
    } catch { /* not for us */ }
  });
  return {
    open: new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); }),
    messages,
    outputFor: (id) => messages
      .filter((message) => message.type === 'terminal_output' && message.sessionId === id)
      .map((message) => message.data)
      .join(''),
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

const listed = async () => (await call('/api/terminal')).body?.sessions ?? [];
const scrollbackOf = async (id) => String((await listed()).find((one) => one.id === id)?.scrollback ?? '');
const send = (sessionId, data) =>
  call('/api/terminal/input', { method: 'POST', body: JSON.stringify({ sessionId, data }) });

try {
  await waitForHealth();

  // ─── 1. The cap is a number the module names ────────────────
  console.log('1. the cap is a deliberate number, not "unbounded"');
  const module = await importDist(join('core', 'terminal-session.js'), 'the terminal session module');
  const LIMIT = module?.TERMINAL_SESSION_LIMIT;
  check('the session module names a cap', typeof LIMIT === 'number', String(LIMIT));
  check('and it is more than one, and small enough to still be a guard',
        typeof LIMIT === 'number' && LIMIT > 1 && LIMIT <= 32, String(LIMIT));

  // ─── 2. Two sessions in one workspace ───────────────────────
  console.log('\n2. a second session for the same board is opened, not refused');
  const viewer = watch();
  await viewer.open;

  const first = await call('/api/terminal', { method: 'POST' });
  check('the first session is accepted', first.status === 202,
        `got ${first.status} ${JSON.stringify(first.body)}`);
  const second = await call('/api/terminal', { method: 'POST' });
  check('and so is the second', second.status === 202,
        `got ${second.status} ${JSON.stringify(second.body)}`);

  const alpha = first.body?.session?.id;
  const bravo = second.body?.session?.id;
  check('each session has an id', Boolean(alpha) && Boolean(bravo), `${alpha} / ${bravo}`);
  check('and the two are not the same id', Boolean(alpha) && alpha !== bravo, `${alpha} / ${bravo}`);
  check('each has a process of its own',
        alive(first.body?.session?.pid) && alive(second.body?.session?.pid)
        && first.body.session.pid !== second.body.session.pid,
        `${first.body?.session?.pid} / ${second.body?.session?.pid}`);

  const both = await listed();
  check('GET lists both of them', both.length === 2, JSON.stringify(both.map((one) => one.id)));
  check('with a scrollback each', both.every((one) => typeof one.scrollback === 'string'),
        JSON.stringify(both.map((one) => typeof one.scrollback)));

  // ─── 3. Input goes to the session it names ──────────────────
  console.log('\n3. input reaches the session it names, and no other');
  await send(alpha, 'ping-alpha\n');
  await waitFor(async () => (await scrollbackOf(alpha)).includes('heard[ping-alpha]'),
                'the first shell to answer');
  await send(bravo, 'ping-bravo\n');
  await waitFor(async () => (await scrollbackOf(bravo)).includes('heard[ping-bravo]'),
                'the second shell to answer');

  const alphaText = await scrollbackOf(alpha);
  const bravoText = await scrollbackOf(bravo);
  check('the first session heard what was addressed to it', alphaText.includes('heard[ping-alpha]'),
        alphaText.slice(-200));
  check('and nothing that was addressed to the other', !alphaText.includes('bravo'), alphaText.slice(-200));
  check('the second session heard what was addressed to it', bravoText.includes('heard[ping-bravo]'),
        bravoText.slice(-200));
  check('and nothing that was addressed to the other', !bravoText.includes('alpha'), bravoText.slice(-200));

  check('the output messages say which session produced them',
        viewer.outputFor(alpha).includes('heard[ping-alpha]')
        && !viewer.outputFor(alpha).includes('bravo'),
        JSON.stringify(viewer.messages.filter((one) => one.type === 'terminal_output')).slice(0, 400));

  const unnamed = await call('/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: 'x\n' }) });
  check('input that names no session while two are open is a 400, not a guess',
        unnamed.status === 400, `got ${unnamed.status} ${JSON.stringify(unnamed.body)}`);
  const unknown = await send('no-such-session', 'x\n');
  check('input for a session that does not exist is a 404', unknown.status === 404,
        `got ${unknown.status} ${JSON.stringify(unknown.body)}`);

  // ─── 4. Resizing is per session too ─────────────────────────
  console.log('\n4. a resize reaches the session it names');
  const resized = await call('/api/terminal/resize', {
    method: 'POST', body: JSON.stringify({ sessionId: bravo, cols: 133, rows: 41 }),
  });
  check('the resize is accepted', resized.status === 200,
        `got ${resized.status} ${JSON.stringify(resized.body)}`);
  const sizes = await listed();
  check('the named session has the new size',
        sizes.find((one) => one.id === bravo)?.cols === 133, JSON.stringify(sizes.map((one) => [one.id, one.cols])));
  check('and the other still has its own',
        sizes.find((one) => one.id === alpha)?.cols !== 133, JSON.stringify(sizes.map((one) => [one.id, one.cols])));
  check('the broadcast says which session was resized',
        viewer.messages.some((one) => one.type === 'terminal_resized' && one.sessionId === bravo && one.cols === 133),
        JSON.stringify(viewer.messages.filter((one) => one.type === 'terminal_resized')));

  // ─── 5. A socket connecting late replays both ───────────────
  console.log('\n5. a socket that connects late is given every live session');
  const late = watch();
  await late.open;
  await waitFor(() => late.messages.some((one) => one.type === 'terminal_sessions'),
                'the live sessions to be announced');
  const announced = late.messages.find((one) => one.type === 'terminal_sessions');
  const ids = (announced?.sessions ?? []).map((one) => one.session?.id);
  check('both sessions are announced', ids.includes(alpha) && ids.includes(bravo), JSON.stringify(ids));
  const replayed = Object.fromEntries((announced?.sessions ?? [])
    .map((one) => [one.session?.id, String(one.scrollback ?? '')]));
  check('each with its own transcript and not the other\'s',
        String(replayed[alpha]).includes('ping-alpha') && !String(replayed[alpha]).includes('bravo')
        && String(replayed[bravo]).includes('ping-bravo') && !String(replayed[bravo]).includes('alpha'),
        JSON.stringify(replayed).slice(0, 400));
  late.close();

  // ─── 6. Closing one leaves the other running ────────────────
  console.log('\n6. closing one session leaves the other one running');
  const alphaPid = first.body?.session?.pid;
  const bravoPid = second.body?.session?.pid;
  const closed = await call(`/api/terminal?sessionId=${alpha}`, { method: 'DELETE' });
  check('the named session closes', closed.status === 200,
        `got ${closed.status} ${JSON.stringify(closed.body)}`);
  await waitFor(() => !alive(alphaPid), 'the closed shell to go');
  check('its shell is gone', !alive(alphaPid), `pid ${alphaPid} is still alive`);
  check('the other shell is still running', alive(bravoPid), `pid ${bravoPid} has gone too`);

  const remaining = await listed();
  check('and only the other one is listed', remaining.length === 1 && remaining[0].id === bravo,
        JSON.stringify(remaining.map((one) => one.id)));
  // Waited for rather than read: the broadcast rides the child's `close`, which the runtime
  // delivers a tick or two after the pid stops answering.
  await waitFor(() => viewer.messages.some((one) => one.type === 'terminal_exit' && one.sessionId === alpha),
                'the exit to be announced');
  check('the exit message says which session ended',
        viewer.messages.some((one) => one.type === 'terminal_exit' && one.sessionId === alpha),
        JSON.stringify(viewer.messages.filter((one) => one.type === 'terminal_exit')));

  // The surviving session still answers, which is what "left running" has to mean.
  await send(bravo, 'still-here\n');
  await waitFor(async () => (await scrollbackOf(bravo)).includes('heard[still-here]'),
                'the surviving shell to answer');
  check('and it still answers', (await scrollbackOf(bravo)).includes('heard[still-here]'),
        (await scrollbackOf(bravo)).slice(-200));

  // With one session left, naming it is no longer required: there is nothing to be ambiguous
  // between, and the routes stay scriptable by hand the way `docs/terminal.md` describes.
  const sole = await call('/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: 'sole\n' }) });
  check('with one session open, input that names none reaches it', sole.status === 202,
        `got ${sole.status} ${JSON.stringify(sole.body)}`);

  // ─── 7. The cap answers 409, and says what it is ────────────
  console.log('\n7. past the cap it is a 409 that names the cap');
  const opened = [bravo];
  for (let index = opened.length; index < LIMIT; index++) {
    const extra = await call('/api/terminal', { method: 'POST' });
    check(`session ${index + 1} of ${LIMIT} is accepted`, extra.status === 202,
          `got ${extra.status} ${JSON.stringify(extra.body)}`);
    opened.push(extra.body?.session?.id);
  }
  check('the board is holding the whole cap', (await listed()).length === LIMIT,
        String((await listed()).length));

  const overflow = await call('/api/terminal', { method: 'POST' });
  check('one past the cap is a 409', overflow.status === 409,
        `got ${overflow.status} ${JSON.stringify(overflow.body)}`);
  check('and the refusal names the cap', String(overflow.body?.error ?? '').includes(String(LIMIT)),
        String(overflow.body?.error));
  check('nothing was spawned for it', (await listed()).length === LIMIT,
        String((await listed()).length));

  // A slot freed is a slot usable again, or the cap would be a lifetime budget.
  await call(`/api/terminal?sessionId=${bravo}`, { method: 'DELETE' });
  const afterFree = await call('/api/terminal', { method: 'POST' });
  check('closing one frees a slot', afterFree.status === 202,
        `got ${afterFree.status} ${JSON.stringify(afterFree.body)}`);

  viewer.close();
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  if (server.exitCode !== null) console.error(`the canvas server exited (${server.exitCode}):\n${serverLog}`);
} finally {
  for (const child of running) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
