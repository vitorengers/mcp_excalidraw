#!/usr/bin/env node
/**
 * Checks the terminal the canvas hosts on the right of the board.
 *
 * The feature spawns a shell with full access to a repository on an API that has no
 * authentication, so most of these cases are about the guards rather than about the shell:
 * unset means the routes do not exist, off loopback means they refuse, and neither may
 * spawn anything. The stub shell writes a marker file the instant it starts, which is how
 * "nothing was spawned" is asserted rather than assumed.
 *
 * The case the feature exists for is incremental output. Every agent this board runs
 * already produces a live stream and `runAgent` buffers the liveness away — `stdout +=
 * chunk` read once the process exits — so one final state reaches the canvas. A command
 * that prints, pauses and prints again must therefore arrive as *two* messages while the
 * process is still alive; one message with both halves in it would be the old behaviour
 * wearing a new route.
 *
 * Self-contained: it builds a throwaway workspace, starts its own canvas servers on free
 * ports and kills them. Nothing here talks to GitHub. The shell is the real one for the
 * cases about a shell, and a Node stub for the cases about the guards.
 *
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-terminal.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One spelling for paths that arrive from a registry, from Node and from a shell. */
const samePath = (a, b) => String(a ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  === String(b ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const containsPath = (haystack, needle) =>
  String(haystack ?? '').replace(/\\/g, '/').toLowerCase()
    .includes(String(needle ?? '').replace(/\\/g, '/').toLowerCase());

/**
 * The transcript with its escape sequences taken out.
 *
 * A shell on a terminal colours its own prompt, moves the cursor and sets the window title,
 * so a chunk that is one word of output is a dozen bytes of instructions around it. What
 * those instructions mean is `check-terminal-ansi-browser.mjs`'s question; here they are
 * noise, and a case about *what the shell said* has to read past them.
 */
const plain = (text) => String(text ?? '')
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  .replace(/\u001b[()#%][0-9A-Za-z]/g, '')
  .replace(/\u001b[=>ME78]/g, '');

/**
 * What Enter is, on the wire.
 *
 * A terminal sends a carriage return, and a shell reading a pipe reads lines ending in a
 * newline. The two are not interchangeable: PowerShell's line editor takes a bare `\n` as
 * "continue this command on the next line" and prints `>>` rather than running anything.
 * Set once the session says which mode it is in.
 */
let ENTER = '\n';

/**
 * A module from `dist`, or nothing.
 *
 * Nothing rather than an exit: run against the code as it stands, none of these modules
 * exists, and a check that dies on the first missing import shows one line about its own
 * harness instead of the several cases it is there to fail. Every case that does not need
 * the module still runs.
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

/**
 * A distro to run the WSL case in, or nothing.
 *
 * `wsl.exe -l -q` answers in UTF-16LE, which read as UTF-8 is every character followed by a
 * null. `docker-desktop` is skipped: it is a distro, and it is not one anybody keeps a
 * project in.
 */
function wslDistro() {
  if (!isWindows) return null;
  const listed = spawnSync('wsl.exe', ['-l', '-q'], { windowsHide: true });
  if (listed.status !== 0 || !listed.stdout) return null;
  return listed.stdout.toString('utf16le')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^docker-desktop/i.test(line)) ?? null;
}

const wsl = (distro, command) =>
  spawnSync('wsl.exe', ['-d', distro, '--', 'bash', '-lc', command], { windowsHide: true }).status === 0;

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `terminal-check-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const projectDir = join(workDir, 'project');
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, 'board.config.json'),
  JSON.stringify({ name: 'Terminal Check', repo: 'vitorengers/mcp_excalidraw' }), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'terminal-check';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/** A shell that is not a shell: it records that it was started, and echoes what it is told. */
const stubShell = join(workDir, 'stub-shell.mjs');
const stubMarker = join(workDir, 'stub-started');
writeFileSync(stubShell, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(stubMarker.replace(/\\/g, '/'))}, String(process.pid), 'utf8');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => process.stdout.write('echo: ' + chunk));
`, 'utf8');

/**
 * A grandchild of the shell, ticking a file until something kills it.
 *
 * This is what makes the orphan case honest: closing a session has to take the process
 * *tree* with it, and a shell whose own pid is gone can still leave a command running.
 */
const tickScript = join(workDir, 'tick.mjs');
const tickFile = join(workDir, 'ticks.txt');
writeFileSync(tickScript, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
setInterval(() => { try { appendFileSync(${JSON.stringify(tickFile.replace(/\\/g, '/'))}, '.'); } catch {} }, 150);
`, 'utf8');

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

/**
 * One request, with two more goes at the connection.
 *
 * Not a retry of the case — a 404 comes straight back, which is most of what this file
 * asserts. This is for the socket itself, which on this machine occasionally refuses with
 * `fetch failed` while three canvas servers are up at once.
 */
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
      if (String(message?.type ?? '').startsWith('terminal_')) {
        messages.push({ ...message, at: Date.now() });
      }
    } catch { /* not for us */ }
  });
  const open = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return {
    open,
    messages,
    output: () => messages.filter((message) => message.type === 'terminal_output'),
    close: () => { try { socket.close(); } catch { /* already gone */ } },
  };
}

const PORT = 38200 + (process.pid % 300);
const DISABLED_PORT = PORT + 1;
const REMOTE_PORT = PORT + 2;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Commands, in whichever shell this machine's default resolves to.
 *
 * Every word these look for is spelled in halves the shell joins, and that is not
 * decoration: the session echoes what was typed into the transcript, so a command
 * containing the word `first` would satisfy an assertion about the word `first` arriving
 * before the assertion had waited for any output at all. Split, the echo cannot be mistaken
 * for the answer.
 */
const script = isWindows
  ? {
    banana: "Write-Output ('ban' + 'ana')",
    twoBursts: "Write-Output ('fir' + 'st'); Start-Sleep -Seconds 1; Write-Output ('seco' + 'nd')",
  }
  : {
    banana: 'echo "ban""ana"',
    twoBursts: 'echo "fir""st"; sleep 1; echo "seco""nd"',
  };

const stubCommand = `node "${stubShell.replace(/\\/g, '/')}"`;

try {
  // ─── 1. The block's placement, before any of it runs ────────
  console.log('1. the block is placed by the mirror\'s rule with the sign flipped');
  const block = await importDist(join('core', 'terminal-block.js'), 'the terminal block module');
  if (block) {
    const { TERMINAL_KIND, TERMINAL_GAP, TERMINAL_SIZE, terminalOrigin, terminalBlockElement, terminalGrid } = block;

    check('the kind is "terminal"', TERMINAL_KIND === 'terminal', String(TERMINAL_KIND));
    const bounds = { minX: -400, minY: 120, maxX: 900, maxY: 700 };
    const origin = terminalOrigin(bounds);
    check('anchored to the right edge of the content, not to a fixed column',
          origin.x === bounds.maxX + TERMINAL_GAP, `${JSON.stringify(origin)} for ${JSON.stringify(bounds)}`);
    check('and to the top of it, the way the mirror is', origin.y === bounds.minY, String(origin.y));
    const moved = terminalOrigin({ ...bounds, maxX: bounds.maxX + 1000 });
    check('a board that grew moves the block with it', moved.x === origin.x + 1000, `${origin.x} → ${moved.x}`);
    check('an empty board still gets an origin', Number.isFinite(terminalOrigin(null).x));

    const element = terminalBlockElement(origin, TERMINAL_SIZE);
    check('the block is marked derived', element.customData?.kind === TERMINAL_KIND,
          JSON.stringify(element.customData));
    check('it is where the origin says', element.x === origin.x && element.y === origin.y,
          `${element.x},${element.y}`);

    const grid = terminalGrid(TERMINAL_SIZE);
    check('a grid is derived from the block\'s size', grid.cols > 20 && grid.rows > 5, JSON.stringify(grid));
    const wider = terminalGrid({ width: TERMINAL_SIZE.width * 2, height: TERMINAL_SIZE.height });
    check('a wider block is more columns', wider.cols > grid.cols, `${grid.cols} → ${wider.cols}`);
    const taller = terminalGrid({ width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height * 2 });
    check('a taller block is more rows', taller.rows > grid.rows, `${grid.rows} → ${taller.rows}`);
  }

  // ─── 2. A WSL workspace is given its inner path ─────────────
  console.log('\n2. a WSL-backed workspace runs inside the distro, at the path the distro names');
  const session = await importDist(join('core', 'terminal-session.js'), 'the terminal session module');
  if (session) {
    const { buildTerminalCommand, shellCommandFrom } = session;

    const wsl = {
      id: 'wsl-project',
      name: 'wsl-project',
      path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\project',
      innerPath: '/home/me/project',
      environment: { kind: 'wsl', distro: 'Ubuntu' },
    };
    const wslCommand = buildTerminalCommand(wsl, shellCommandFrom('1', wsl));
    check('it goes through wsl.exe', wslCommand.command === 'wsl.exe', String(wslCommand.command));
    check('with the distro named', wslCommand.args.includes('Ubuntu'), wslCommand.args.join(' '));
    check('and the inner path as the working directory, not the UNC one',
          wslCommand.args[wslCommand.args.indexOf('--cd') + 1] === wsl.innerPath,
          wslCommand.args.join(' '));
    check('nothing hands it a UNC path', !wslCommand.args.some((arg) => String(arg).includes('wsl.localhost')),
          wslCommand.args.join(' '));

    const local = { ...wsl, environment: { kind: 'native' }, path: projectDir, innerPath: projectDir };
    const localCommand = buildTerminalCommand(local, shellCommandFrom('1', local));
    check('a local workspace starts in its own root', samePath(localCommand.cwd, projectDir),
          String(localCommand.cwd));
    check('an explicit command overrides the default shell',
          buildTerminalCommand(local, shellCommandFrom(stubCommand, local)).args
            .some((arg) => String(arg).includes('stub-shell')),
          JSON.stringify(buildTerminalCommand(local, shellCommandFrom(stubCommand, local))));
    check('an unset variable is no shell at all', shellCommandFrom(undefined, local) === null,
          String(shellCommandFrom(undefined, local)));
  }

  // ─── 3. Unset means the routes do not exist ─────────────────
  console.log('\n3. with EXCALIDRAW_TERMINAL unset the routes refuse, and nothing is spawned');
  // Explicitly empty rather than merely absent: this check runs on machines where the
  // feature is switched on for the board being worked on, and `startCanvas` inherits the
  // environment. Left to chance, the case that proves the routes do not exist is the one
  // most likely to be answered by a server that had them all along.
  const disabled = startCanvas(DISABLED_PORT, { EXCALIDRAW_TERMINAL: '' });
  const DISABLED_BASE = `http://127.0.0.1:${DISABLED_PORT}`;
  await waitForHealth(DISABLED_BASE, disabled);

  const opened = await call(DISABLED_BASE, '/api/terminal', { method: 'POST' });
  check('404 for opening a session', opened.status === 404, `got ${opened.status} ${JSON.stringify(opened.body)}`);
  check('and the refusal names the variable', (opened.body?.error ?? '').includes('EXCALIDRAW_TERMINAL'),
        opened.body?.error);
  for (const [path, options] of [
    ['/api/terminal', {}],
    ['/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: 'pwd\n' }) }],
    ['/api/terminal/resize', { method: 'POST', body: JSON.stringify({ cols: 80, rows: 24 }) }],
    ['/api/terminal', { method: 'DELETE' }],
  ]) {
    const refused = await call(DISABLED_BASE, path, options);
    check(`404 for ${options.method ?? 'GET'} ${path}`, refused.status === 404,
          `got ${refused.status} ${JSON.stringify(refused.body)}`);
  }
  check('no shell was started', !existsSync(stubMarker));

  // ─── 4. Off loopback means they refuse ──────────────────────
  console.log('\n4. bound off loopback they refuse, and still nothing is spawned');
  const remote = startCanvas(REMOTE_PORT, { HOST: '0.0.0.0', EXCALIDRAW_TERMINAL: stubCommand });
  const REMOTE_BASE = `http://127.0.0.1:${REMOTE_PORT}`;
  await waitForHealth(REMOTE_BASE, remote);

  const offLoopback = await call(REMOTE_BASE, '/api/terminal', { method: 'POST' });
  check('403 Forbidden', offLoopback.status === 403,
        `got ${offLoopback.status} ${JSON.stringify(offLoopback.body)}`);
  check('in the wording the other guards use',
        /only run.*while the server is bound to loopback/i.test(offLoopback.body?.error ?? ''),
        offLoopback.body?.error);
  await sleep(500);
  check('no shell was started', !existsSync(stubMarker),
        existsSync(stubMarker) ? `a stub shell reported pid ${readFileSync(stubMarker, 'utf8')}` : '');

  // ─── 5. A session, in the workspace root ────────────────────
  console.log('\n5. a session runs in the project, and pwd says so');
  const canvas = startCanvas(PORT, { EXCALIDRAW_TERMINAL: '1' });
  await waitForHealth(BASE, canvas);

  const viewer = watch(PORT);
  await viewer.open;

  const open = await call(BASE, '/api/terminal', { method: 'POST' });
  check('202 Accepted', open.status === 202, `got ${open.status} ${JSON.stringify(open.body)}`);
  check('the session names the workspace root as its directory',
        samePath(open.body?.session?.cwd, projectDir),
        `${open.body?.session?.cwd} vs ${projectDir}`);
  check('and reports the shell it started', Boolean(open.body?.session?.shell), JSON.stringify(open.body?.session));
  check('and which mode it got', ['pty', 'pipe'].includes(open.body?.session?.mode),
        String(open.body?.session?.mode));
  const pid = open.body?.session?.pid;
  check('and a live process', alive(pid), `pid ${pid}`);

  ENTER = open.body?.session?.mode === 'pty' ? '\r' : '\n';

  // A shell on a terminal has a REPL to start before it can read anything, and a command
  // written into a PowerShell that is still starting is a command nobody runs. A reader
  // waits for the prompt to appear; so does this. A piped shell prints no prompt at all,
  // so there is nothing there to wait for.
  if (ENTER === '\r') {
    await waitFor(() => viewer.output().length > 0, 'the shell to print its first prompt');
    await sleep(500);
  }

  // Everything after this point, and not the prompt before it: a shell on a terminal prints
  // its working directory in the prompt, so "the path is somewhere in the transcript" would
  // be true before `pwd` had been typed at all.
  const beforePwd = viewer.output().length;
  const sincePwd = () => plain(viewer.output().slice(beforePwd).map((message) => message.data).join(''));
  await call(BASE, '/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: `pwd${ENTER}` }) });

  // Typed once and shown once: the shell echoes for itself on a terminal, and the session
  // echoes for it on a pipe. Either way it is there, and `check-terminal-pty.mjs` is what
  // holds the two apart.
  await waitFor(() => sincePwd().includes('pwd'), 'the shell to take the command');
  check('what was typed is in the transcript too', sincePwd().includes('pwd'), sincePwd().slice(-300));

  // Not "on a line of its own": PowerShell's `pwd` is `Get-Location`, which prints a table
  // and puts the next prompt where the cursor moves say rather than after a newline, so the
  // lines a reader sees are made by escapes this has just stripped.
  const answered = () => containsPath(sincePwd(), projectDir);
  await waitFor(answered, 'pwd to report the workspace root');
  check('pwd reports the workspace root', answered(), sincePwd().slice(-300));

  // ─── 6. Incremental, which is the whole point ───────────────
  console.log('\n6. output arrives while the command is still running, not once it exits');
  const before = viewer.output().length;
  await call(BASE, '/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: `${script.twoBursts}${ENTER}` }) });

  await waitFor(() => viewer.output().slice(before).some((message) => plain(message.data).includes('first')),
                'the first burst');
  const firstAt = Date.now();
  const exitedEarly = viewer.messages.some((message) => message.type === 'terminal_exit');
  await waitFor(() => viewer.output().slice(before).some((message) => plain(message.data).includes('second')),
                'the second burst');

  const burst = viewer.output().slice(before);
  const firstIndex = burst.findIndex((message) => plain(message.data).includes('first'));
  const secondIndex = burst.findIndex((message) => plain(message.data).includes('second'));
  check('both halves arrived', firstIndex >= 0 && secondIndex >= 0,
        burst.map((message) => JSON.stringify(message.data)).join(' '));
  check('as two messages, not one buffered at the end', firstIndex !== secondIndex,
        `both in message ${firstIndex}: ${JSON.stringify(burst[firstIndex]?.data)}`);
  check('the first arrived before the second was even produced',
        secondIndex > firstIndex && burst[secondIndex].at - firstAt > 300,
        `${burst[secondIndex]?.at - firstAt}ms after the first`);
  check('and the shell had not exited', burst.length > 0 && !exitedEarly,
        exitedEarly ? 'a terminal_exit arrived mid-command' : 'no output at all');
  check('the process is still alive for the next command', alive(pid), `pid ${pid}`);

  // ─── 7. A command typed in comes back ───────────────────────
  console.log('\n7. a command typed into the block runs and its output comes back');
  const typed = await call(BASE, '/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: `${script.banana}${ENTER}` }) });
  check('the input is accepted', typed.status === 202, `got ${typed.status} ${JSON.stringify(typed.body)}`);
  await waitFor(() => viewer.output().some((message) => plain(message.data).includes('banana')), 'the output');
  // A line of its own, once the escapes are out of the way: what the shell printed, not a
  // word that happens to be inside a prompt or an echo of the command that produced it.
  check('the output came back',
        viewer.output().some((message) => plain(message.data).split(/\r?\n/)
          .some((line) => line.trim() === 'banana')),
        viewer.output().map((message) => JSON.stringify(plain(message.data))).join(' ').slice(-300));

  const empty = await call(BASE, '/api/terminal/input', { method: 'POST', body: JSON.stringify({}) });
  check('input with nothing in it is a 400', empty.status === 400, `got ${empty.status}`);

  // ─── 8. One session per workspace ───────────────────────────
  console.log('\n8. a second session for the same board is refused, not spawned');
  const second = await call(BASE, '/api/terminal', { method: 'POST' });
  check('409 Conflict', second.status === 409, `got ${second.status} ${JSON.stringify(second.body)}`);
  const status = await call(BASE, '/api/terminal');
  check('and the one session is untouched', Boolean(pid) && status.body?.session?.pid === pid,
        `${status.body?.session?.pid} vs ${pid}`);

  // ─── 9. Resizing ───────────────────────────────────────────
  console.log('\n9. the block\'s size reaches the session');
  const resized = await call(BASE, '/api/terminal/resize', { method: 'POST', body: JSON.stringify({ cols: 132, rows: 43 }) });
  check('the resize is accepted', resized.status === 200, `got ${resized.status} ${JSON.stringify(resized.body)}`);
  check('and is remembered', resized.body?.session?.cols === 132 && resized.body?.session?.rows === 43,
        JSON.stringify(resized.body?.session));
  const afterResize = await call(BASE, '/api/terminal');
  check('so a later reader sees it too',
        afterResize.body?.session?.cols === 132 && afterResize.body?.session?.rows === 43,
        JSON.stringify(afterResize.body?.session));
  check('every viewer hears about it',
        viewer.messages.some((message) => message.type === 'terminal_resized' && message.cols === 132),
        JSON.stringify(viewer.messages.filter((message) => message.type === 'terminal_resized')));
  const nonsense = await call(BASE, '/api/terminal/resize', { method: 'POST', body: JSON.stringify({ cols: 0, rows: -3 }) });
  check('nonsense is a 400', nonsense.status === 400, `got ${nonsense.status}`);

  // ─── 10. A reconnecting viewer is caught up ─────────────────
  console.log('\n10. a socket that connects late replays the scrollback');
  const late = watch(PORT);
  await late.open;
  await waitFor(() => late.messages.some((message) => message.type === 'terminal_session'),
                'the session to be announced to a new socket');
  const announced = late.messages.find((message) => message.type === 'terminal_session');
  check('the session is announced', Boolean(announced?.session), JSON.stringify(announced ?? null));
  check('with the scrollback that was already produced',
        containsPath(announced?.scrollback, projectDir) && String(announced?.scrollback).includes('banana'),
        String(announced?.scrollback ?? '').slice(-300));
  check('and the block\'s size', announced?.session?.cols === 132, JSON.stringify(announced?.session));
  late.close();

  // ─── 11. Derived: it never reaches the board file ───────────
  console.log('\n11. a terminal shape is stripped from the exported board');
  const terminalShape = await (await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'rectangle', x: 0, y: 0, width: 100, height: 100,
                           customData: { kind: 'terminal' } }),
  })).json().catch(() => ({}));
  // A label Excalidraw offered to bind to the block, which says nothing about itself: the
  // shape it belongs to is what makes it derived.
  await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'text', x: 10, y: 10, text: 'typed onto the terminal',
                           containerId: terminalShape?.element?.id }),
  });
  await fetch(`${BASE}/api/elements?workspace=${WORKSPACE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'rectangle', x: 400, y: 0, width: 100, height: 100,
                           customData: { docKey: 'authored' } }),
  });
  const exported = join(workDir, 'exported.excalidraw');
  const exportRun = spawnSync(process.execPath, [
    join(repoRoot, 'scripts', 'export-board.mjs'),
    '--url', BASE, '--workspace', WORKSPACE, '--out', exported,
  ], { cwd: repoRoot, encoding: 'utf8' });
  check('the export ran', exportRun.status === 0, `${exportRun.stdout ?? ''}${exportRun.stderr ?? ''}`);
  const saved = existsSync(exported) ? JSON.parse(readFileSync(exported, 'utf8')) : { elements: [] };
  check('the authored shape was saved',
        saved.elements.some((one) => one.customData?.docKey === 'authored'),
        JSON.stringify(saved.elements.map((one) => one.customData)));
  check('and the terminal shape was not',
        !saved.elements.some((one) => one.customData?.kind === 'terminal'),
        JSON.stringify(saved.elements.map((one) => one.customData)));
  check('nor the label bound to it, which carried no mark of its own',
        !saved.elements.some((one) => String(one.text ?? '').includes('typed onto the terminal')),
        JSON.stringify(saved.elements.map((one) => one.text ?? one.customData)));

  // ─── 12. Closing takes the tree with it ────────────────────
  console.log('\n12. closing a session leaves nothing running');
  await call(BASE, '/api/terminal/input', { method: 'POST',
    body: JSON.stringify({ data: `node "${tickScript.replace(/\\/g, '/')}"${ENTER}` }) });
  const ticks = () => (existsSync(tickFile) ? statSync(tickFile).size : 0);
  const ticking = await waitFor(() => ticks() > 3, 'the grandchild to start ticking');

  const closed = await call(BASE, '/api/terminal', { method: 'DELETE' });
  check('the session closes', closed.status === 200, `got ${closed.status} ${JSON.stringify(closed.body)}`);
  await waitFor(() => !alive(pid), 'the shell to go');
  check('the shell is gone', Boolean(pid) && !alive(pid), `pid ${pid} is still alive`);

  await sleep(900);
  const ticksAfterClose = ticks();
  await sleep(900);
  check('and so is the command that was running inside it',
        ticking && ticks() === ticksAfterClose,
        `${ticksAfterClose} → ${ticks()} bytes, so it kept ticking`);

  const gone = await call(BASE, '/api/terminal');
  check('no session is reported any more', !gone.body?.session, JSON.stringify(gone.body));
  const closeAgain = await call(BASE, '/api/terminal', { method: 'DELETE' });
  check('closing what is already closed is a 404', closeAgain.status === 404, `got ${closeAgain.status}`);

  console.log('\n13. and the slot is free again');
  const reopened = await call(BASE, '/api/terminal', { method: 'POST' });
  check('a new session is accepted', reopened.status === 202,
        `got ${reopened.status} ${JSON.stringify(reopened.body)}`);
  check('with a process of its own', reopened.body?.session?.pid !== pid && alive(reopened.body?.session?.pid),
        `${pid} → ${reopened.body?.session?.pid}`);
  check('and an empty transcript',
        !String((await call(BASE, '/api/terminal')).body?.scrollback ?? '').includes('banana'),
        String((await call(BASE, '/api/terminal')).body?.scrollback ?? '').slice(-200));

  console.log('\n14. and a server going down does not leave a shell behind');
  const survivor = reopened.body?.session?.pid;
  canvas.child.kill('SIGTERM');
  // Longer than it used to need. A piped shell went the instant its stdin closed, which is
  // the same moment the server did. A shell on a terminal goes when the terminal does, and
  // on Windows `kill` is a hard terminate — no handler of the server's runs, so what takes
  // the shell down is the operating system tearing the pseudoconsole apart, a second or two
  // later. A shutdown the server is allowed to see still takes the tree itself, which is
  // case 12.
  await waitFor(() => !alive(survivor), 'the shell to go with its server', 200);
  if (alive(survivor) && isWindows) {
    console.error(spawnSync('tasklist', ['/FI', `PID eq ${survivor}`], { encoding: 'utf8' }).stdout);
    console.error(spawnSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "ProcessId=${survivor}" | Select-Object ProcessId,ParentProcessId,CommandLine | Format-List`],
      { encoding: 'utf8' }).stdout);
    console.error('SERVER LOG:', canvas.read().slice(-2000));
  }
  check('the shell went with the server', !alive(survivor), `pid ${survivor} outlived the server`);

  viewer.close();

  // ─── 15. A real WSL-backed project, where it can be had ────
  //
  // Case 2 reads the argv and is worth having on every machine, but it cannot tell whether a
  // shell started that way really lands in the distro. This one runs it. Skipped, loudly,
  // where there is no WSL — which is every machine that is not this one.
  console.log('\n15. and inside WSL, pwd reports the inner path rather than a UNC one');
  const distro = wslDistro();
  if (!distro) {
    console.log('  skip  no WSL distro available, so the WSL half was not run');
  } else {
    const innerPath = `/tmp/terminal-check-${process.pid}`;
    const madeIt = wsl(distro, `mkdir -p ${innerPath} && printf '%s' '{"name":"WSL Check"}' > ${innerPath}/board.config.json`);
    check('a project could be made inside the distro', madeIt, `mkdir in ${distro} failed`);

    const wslRegistry = join(workDir, 'wsl-workspaces.json');
    writeFileSync(wslRegistry, JSON.stringify({
      workspaces: [{ id: WORKSPACE, path: innerPath, distro }],
    }), 'utf8');

    const wslPort = PORT + 3;
    const WSL_BASE = `http://127.0.0.1:${wslPort}`;
    const wslCanvas = startCanvas(wslPort, {
      EXCALIDRAW_WORKSPACES: wslRegistry,
      EXCALIDRAW_TERMINAL: '1',
    });
    await waitForHealth(WSL_BASE, wslCanvas);

    const wslViewer = watch(wslPort);
    await wslViewer.open;
    const wslOpen = await call(WSL_BASE, '/api/terminal', { method: 'POST' });
    check('the session opens', wslOpen.status === 202, `got ${wslOpen.status} ${JSON.stringify(wslOpen.body)}`);
    check('and reports the inner path as its directory', wslOpen.body?.session?.cwd === innerPath,
          String(wslOpen.body?.session?.cwd));

    if (ENTER === '\r') {
      await waitFor(() => wslViewer.output().length > 0, 'the shell inside the distro to start');
      await sleep(500);
    }
    await call(WSL_BASE, '/api/terminal/input', { method: 'POST', body: JSON.stringify({ data: `pwd${ENTER}` }) });
    await waitFor(() => wslViewer.output().some((message) => plain(message.data).includes(innerPath)),
                  'pwd inside the distro');
    const said = wslViewer.output().map((message) => plain(message.data)).join('');
    check('pwd answers with the path the distro names', said.includes(innerPath), said.slice(-200));
    check('and nothing in the transcript is a UNC path', !/wsl\.localhost|wsl\$/i.test(said), said.slice(-200));

    await call(WSL_BASE, '/api/terminal', { method: 'DELETE' });
    wslViewer.close();
    wsl(distro, `rm -rf ${innerPath}`);
  }
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
