#!/usr/bin/env node
/**
 * Checks that the terminal gives its shell a real tty, and behaves like one.
 *
 * The observation behind #75 was that `claude` typed into the block never entered its
 * interface: it waited three seconds for something on stdin, decided it was being piped to
 * and took its `--print` path. That is not a bug in the CLI. A process spawned on three
 * pipes sees `stdin.isTTY` false, and every full-screen program asks that question first.
 *
 * So the case this check exists for is one line long: the shell the session started must
 * see a tty. The stub shell here is not a shell — it prints `TTY=<isTTY>` the instant it
 * starts, and everything else it does is in service of the three consequences of the answer
 * being `true`:
 *
 * - **the echo moves.** A shell on a pipe echoes nothing, so the session wrote what was
 *   typed into the transcript itself. A shell on a tty echoes for itself, and a session
 *   that kept its own echo would show every keystroke twice.
 * - **the size is delivered.** `resize()` used to record `cols`/`rows` and tell the child
 *   nothing, because there was no `TIOCSWINSZ` to send. A program that repaints a screen
 *   has to be told, so the stub is asked its own window size and must answer with the size
 *   the block reported.
 * - **the pipe still works.** The PTY binding is an `optionalDependency` with prebuilt
 *   binaries, and `npm install` on a machine it has none for must still leave a server that
 *   starts, opens a session and says which mode it is in. `EXCALIDRAW_TERMINAL_PTY=0`
 *   stands in for that machine.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas servers on free
 * ports and kills them. Nothing here talks to GitHub, and the shell is always the stub —
 * what a real PowerShell does with a tty is `check-terminal.mjs`'s question, not this one.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal-pty.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The two bytes a fixture needs to be an escape stream, written so an editor cannot eat them. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Readable in a failure message: an escape stream printed raw is unreadable. */
const visible = (text) => String(text ?? '').split(ESC).join('\\e');

/**
 * A module from `dist`, or nothing.
 *
 * Nothing rather than an exit: run against the code as it stands, the escape-aware trimming
 * this imports does not exist, and a check that dies on the first missing export shows one
 * line about its own harness instead of the several cases it is there to fail.
 */
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

const workDir = join(tmpdir(), `terminal-pty-check-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'PTY Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'pty-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/**
 * A shell that is not a shell: it answers the one question this check is about.
 *
 * It puts itself in raw mode when it has a tty, which is what any full-screen program does
 * and what makes "typed once, not twice" answerable: raw mode turns the terminal's own echo
 * off, so the only thing that can put the typed word in the transcript twice is a session
 * still echoing on the shell's behalf.
 *
 * `getWindowSize()` rather than `process.stdout.columns`, which is a cached value refreshed
 * by an event this stub is not waiting for. The question is what the tty says *now*.
 */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdout.write('TTY=' + String(Boolean(process.stdin.isTTY)) + '\\n');
if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let line = '';
process.stdin.on('data', (chunk) => {
  for (const character of chunk) {
    if (character === '\\r' || character === '\\n') { run(line); line = ''; }
    else line += character;
  }
});
function run(command) {
  if (command === 'size') {
    const size = process.stdout.getWindowSize ? process.stdout.getWindowSize() : [0, 0];
    process.stdout.write('SIZE=' + size[0] + 'x' + size[1] + '\\n');
  } else if (command) {
    process.stdout.write('<<' + command + '>>\\n');
  }
}
`, 'utf8');

const stubCommand = `node "${stubShell.replace(/\\/g, '/')}"`;

// ─── Servers ──────────────────────────────────────────────────

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];

function startCanvas(port, env = {}) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_TERMINAL: stubCommand,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  running.push(child);
  return { child, read: () => log };
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

/** One request, with two more goes at the socket, which this machine sometimes refuses. */
async function call(base, path, options = {}) {
  const glue = path.includes('?') ? '&' : '?';
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base}${path}${glue}workspace=${WORKSPACE}`, {
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
function watch(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?workspace=${WORKSPACE}`);
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
  return {
    open,
    said: () => messages.filter((message) => message.type === 'terminal_output')
      .map((message) => String(message.data)).join(''),
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

const type = (base, data) =>
  call(base, '/api/terminal/input', { method: 'POST', body: JSON.stringify({ data }) });

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const PORT = await freePort();
const PIPE_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const PIPE_BASE = `http://127.0.0.1:${PIPE_PORT}`;

try {
  // ─── 1. The scrollback is trimmed where a stream can be cut ─
  //
  // On a plain byte stream any boundary is a boundary. On a stream carrying escape
  // sequences it is not: a buffer sliced at an arbitrary offset can hand a viewer the tail
  // of a sequence with no ESC in front of it, which an emulator either swallows the next
  // character over or prints as text. The ceiling still has to be a ceiling, so what gives
  // is the exact cut, not the limit.
  console.log('1. the scrollback is cut between escape sequences, not through one');
  const sessionModule = await importDist(join('core', 'terminal-session.js'), 'the terminal session module');
  if (sessionModule) {
    const { trimScrollback } = sessionModule;
    if (typeof trimScrollback !== 'function') {
      failures++;
      console.error('  FAIL  the session exports an escape-aware trim — trimScrollback is not a function');
    } else {
      const plain = 'abcdefghij';
      check('a stream with no escapes in it is cut at the limit',
            trimScrollback(plain, 4) === 'ghij', JSON.stringify(trimScrollback(plain, 4)));
      check('a stream shorter than the limit is left alone',
            trimScrollback(plain, 40) === plain, JSON.stringify(trimScrollback(plain, 40)));

      // The cut falls in the middle of `ESC [ 3 1 m`, so a naive slice keeps `1m` — which
      // an emulator prints as the two characters "1m" in the middle of the output.
      // 10 of 17 characters, which puts the boundary between the `3` and the `1` of
      // `ESC [ 3 1 m`. The naive slice keeps `1m`, and every viewer replaying the
      // scrollback then prints two characters nobody wrote.
      const coloured = `xxxx${ESC}[31mRED${ESC}[39m`;
      const cut = trimScrollback(coloured, 10);
      check('a cut that falls inside a sequence drops the whole sequence',
            cut === `RED${ESC}[39m`, visible(cut));
      check('and never keeps the half of it that is left', !cut.startsWith('1m'), visible(cut));
      check('the result is never longer than the limit', cut.length <= 10, visible(cut));

      // An OSC sequence — a title, which every shell sets — is terminated by BEL rather
      // than by a letter, and is long enough to straddle a boundary on its own. Cut
      // through, the tail of it is not text: an emulator swallows everything up to the
      // next terminator, which is however much of the transcript comes next.
      const titled = `yyyyyy${ESC}]0;a rather long window title${BEL}tail`;
      const cutTitle = trimScrollback(titled, 20);
      check('an OSC title cut in half is dropped whole rather than printed',
            cutTitle === 'tail', visible(cutTitle));

      const complete = `${ESC}[32mkept${ESC}[39m`;
      check('a sequence that starts after the cut is kept intact',
            trimScrollback(`zz${complete}`, complete.length) === complete,
            visible(trimScrollback(`zz${complete}`, complete.length)));
    }
  }

  // ─── 2. The shell gets a tty ────────────────────────────────
  console.log('\n2. the shell the session starts sees a terminal on its stdin');
  const canvas = startCanvas(PORT);
  await waitForHealth(BASE, canvas);

  const viewer = watch(PORT);
  await viewer.open;

  const open = await call(BASE, '/api/terminal', { method: 'POST' });
  check('the session opens', open.status === 202, `got ${open.status} ${JSON.stringify(open.body)}`);
  check('and says which mode it is in', open.body?.session?.mode === 'pty',
        `mode ${JSON.stringify(open.body?.session?.mode)}`);

  await waitFor(() => viewer.said().includes('TTY='), 'the stub to report what it sees');
  check('the shell sees a tty, which is what a full-screen program asks first',
        viewer.said().includes('TTY=true'), visible(viewer.said()).slice(0, 300));

  // ─── 3. The echo belongs to the terminal now ────────────────
  console.log('\n3. what is typed appears once, not twice');
  await type(BASE, 'ping\r');
  await waitFor(() => viewer.said().includes('<<ping>>'), 'the stub to answer');
  check('the stub read the whole line', viewer.said().includes('<<ping>>'),
        visible(viewer.said()).slice(-200));
  check('and the word is in the transcript once, not echoed a second time by the session',
        occurrences(viewer.said(), 'ping') === 1,
        `${occurrences(viewer.said(), 'ping')} occurrences in ${JSON.stringify(visible(viewer.said()).slice(-200))}`);

  // ─── 4. A resize reaches the child ──────────────────────────
  console.log('\n4. the block\'s size is delivered to the shell, not just recorded');
  const resized = await call(BASE, '/api/terminal/resize',
    { method: 'POST', body: JSON.stringify({ cols: 101, rows: 37 }) });
  check('the resize is accepted', resized.status === 200, `got ${resized.status}`);
  check('and is remembered', resized.body?.session?.cols === 101, JSON.stringify(resized.body?.session));

  await sleep(300);
  await type(BASE, 'size\r');
  await waitFor(() => /SIZE=\d+x\d+/.test(viewer.said()), 'the stub to report its window size');
  const reported = viewer.said().match(/SIZE=(\d+)x(\d+)/g)?.pop() ?? '';
  check('the shell was told the new size', reported === 'SIZE=101x37',
        `${reported} — the child was never told`);

  const closed = await call(BASE, '/api/terminal', { method: 'DELETE' });
  check('the session closes', closed.status === 200, `got ${closed.status}`);
  await waitFor(async () => ((await call(BASE, '/api/terminal')).body?.sessions ?? []).length === 0,
                'the session to go');
  viewer.close();

  // ─── 5. And with no PTY binding, the pipe still works ───────
  //
  // The binding is an optionalDependency with prebuilt binaries. A machine it has none for
  // installs the package without it, and must still get a server that starts, a session
  // that opens, and a summary that says which of the two it got — the feature behaving
  // differently on two machines with no way to tell which is which is the failure this
  // guards against.
  console.log('\n5. with no PTY available the server still starts, and says so');
  const piped = startCanvas(PIPE_PORT, { EXCALIDRAW_TERMINAL_PTY: '0' });
  await waitForHealth(PIPE_BASE, piped);

  const pipeViewer = watch(PIPE_PORT);
  await pipeViewer.open;

  const pipeOpen = await call(PIPE_BASE, '/api/terminal', { method: 'POST' });
  check('a session still opens', pipeOpen.status === 202,
        `got ${pipeOpen.status} ${JSON.stringify(pipeOpen.body)}`);
  check('and reports the pipe rather than pretending', pipeOpen.body?.session?.mode === 'pipe',
        `mode ${JSON.stringify(pipeOpen.body?.session?.mode)}`);

  await waitFor(() => pipeViewer.said().includes('TTY='), 'the stub to report what it sees');
  check('the shell sees a pipe, which is the cost the mode is there to name',
        pipeViewer.said().includes('TTY=false'), visible(pipeViewer.said()).slice(0, 200));

  await type(PIPE_BASE, 'pipe-ping\n');
  await waitFor(() => pipeViewer.said().includes('<<pipe-ping>>'), 'the stub to answer');
  check('and the session still echoes for it, because nothing else will',
        occurrences(pipeViewer.said(), 'pipe-ping') === 2,
        `${occurrences(pipeViewer.said(), 'pipe-ping')} occurrences in ${JSON.stringify(visible(pipeViewer.said()).slice(-200))}`);

  await call(PIPE_BASE, '/api/terminal', { method: 'DELETE' });
  pipeViewer.close();
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const child of running) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
