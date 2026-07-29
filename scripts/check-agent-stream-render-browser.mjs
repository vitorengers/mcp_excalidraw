#!/usr/bin/env node
/**
 * Checks that a pipe-mode session's transcript is *drawn* where it says it is.
 *
 * `check-agent-stream-render.mjs` asserts the string the server produces, and that string was
 * never wrong: since #219 an agent tab holds `⏺ Read(...)`, `⎿` result blocks and prose in
 * rendered form, no JSON envelope anywhere. What #220 reported is that the block is still
 * unreadable — every line starting further right than the one before it, the transcript
 * walking diagonally across the block, wrapping at the right edge and resuming at the left.
 *
 * That staircase is a line feed with no carriage return. The renderer ends every line it
 * produces with a bare `\n`, nothing normalizes it on the way out, and xterm's default is
 * `convertEol: false` — a bare LF moves down a row and leaves the column where it was. A
 * shell on a pseudoterminal never shows it, because the pty translates and `\r\n` arrives; a
 * `-p` run is forced onto pipes deliberately, so the agent tab is the one place a bare LF
 * reaches the emulator unmediated. Any pipe-mode session has it — a platform with no prebuilt
 * `@lydell/node-pty` binary, or a board started with `EXCALIDRAW_TERMINAL_PTY=0`, staircases
 * every `ls` the same way.
 *
 * So the question is asked of the **emulator**, not of the transcript: the rows xterm drew,
 * read out of the DOM, against the lines the renderer wrote. Asserting the string is what
 * already passes. This is the case `CLAUDE.md` names — *"anything that changes what the
 * browser does has to be looked at in a browser"*.
 *
 * **The renderer's own bytes, not an imitation of them.** The session's command is a stub that
 * imports `dist/core/agent-stream-render.js`, feeds it a real `stream-json` capture and prints
 * what comes back. In a hosted run that rendering happens in `TerminalSession.emit` instead —
 * either way the bytes that reach the socket are the renderer's, which is what this is about.
 * Rendering in the stub is what lets the session be an ordinary one: reproducing it through
 * `runImplementAgent` would need a git repository, a stub `gh` and a worktree to assert
 * something none of them take part in.
 *
 * Two servers, one browser. The first is started with `EXCALIDRAW_TERMINAL_PTY=0`, which is
 * how the pipe is forced on a machine that has the binding; the second is started without it,
 * so a pty session can be asked the same question and the fix be seen to be scoped to the mode
 * that needs it. On a machine with no binding the second reports `pipe` too, and its cases say
 * so rather than passing vacuously.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, starts its own servers and
 * kills them. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it
 * loads the built frontend, so a fix that is only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-agent-stream-render-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIPPED — no Chrome or Edge found, so the browser half was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  process.exit(0);
}

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

const rendererModule = join(repoRoot, 'dist', 'core', 'agent-stream-render.js');
if (!existsSync(rendererModule)) {
  console.error('  FAIL  the built server exists — dist/core/agent-stream-render.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── What a real run streams ──────────────────────────────────
//
// Copied from `check-agent-stream-render.mjs`, which took them from a real
// `claude -p --output-format stream-json` capture. The shapes matter here only in that they
// make the renderer produce lines at three different indents: prose at column 0, a `⎿` result
// block at two and then five, and the closing line after a blank one. A staircase is invisible
// in a transcript where every line happens to start in the same place.

const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Read'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'll read that file." }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/server.ts' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'alpha\nbravo\ncharlie' }] } },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'Done, and here is the answer.' }] } },
  { type: 'result', is_error: false, num_turns: 3 },
];

const STREAM = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`;

// The lines the emulator has to be drawing, computed with the same renderer the stub runs, so
// this check cannot drift from it. Trailing newline dropped; the blank line before the closing
// line is kept, because a blank row is part of the shape being asserted.
const { AgentStreamRenderer } = await import(pathToFileURL(rendererModule).href);
const RENDERED = new AgentStreamRenderer().feed(STREAM);
const EXPECTED = RENDERED.replace(/\n$/, '').split('\n');

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-stream-render-browser-'));
const projectDir = join(workDir, 'render-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'render-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Render Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

// The stub the session runs. `\n` is what the renderer put there and nothing here adds to it —
// the point of the check is that nothing on the way out does either.
//
// It stays alive afterwards, which is not decoration: a shell that exits is dropped from the
// session map on the spot, so `GET /api/terminal` would answer with no sessions at all and the
// block would have nothing to draw. Killed with the server in the `finally` below.
const stubPath = join(workDir, 'stub-agent.mjs');
writeFileSync(stubPath, `#!/usr/bin/env node
import { AgentStreamRenderer } from ${JSON.stringify(pathToFileURL(rendererModule).href)};
const stream = ${JSON.stringify(STREAM)};
process.stdout.write(new AgentStreamRenderer().feed(stream));
setInterval(() => {}, 60000);
`, 'utf8');

const SESSION_COMMAND = `node "${stubPath.replace(/\\/g, '/')}"`;

const children = [];
let serverLog = '';

/** One canvas server, on its own port, told whether it may have a pseudoterminal. */
function startServer(port, extraEnv) {
  const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_TERMINAL: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(server);
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  return `http://127.0.0.1:${port}`;
}

const PORT = 35700 + (process.pid % 200);
const CDP_PORT = PORT + 400;
// `EXCALIDRAW_TERMINAL_PTY=0` is how the pipe is forced on a machine that has the binding —
// exactly what `check-terminal-pty.mjs` uses it for, and what a `-p` agent run gets anyway.
const PIPE_BASE = startServer(PORT, { EXCALIDRAW_TERMINAL_PTY: '0' });
// The other one takes whatever this machine has. Deleted rather than left, because this
// machine's own shell may export it — see the note in `docs/running.md` about what a
// self-contained check inherits.
const PTY_BASE = startServer(PORT + 1, { EXCALIDRAW_TERMINAL_PTY: undefined });

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

/** One request, with two more goes at the connection itself. See check-terminal-browser. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (base, path, options = {}) =>
  request(`${base}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

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

/**
 * The rows xterm drew, out of the emulator rather than out of the transcript.
 *
 * The DOM renderer writes one `div` per row of the grid and pads it to the full width, so a
 * row's text is the row's *columns*: a line drawn at column 12 arrives with twelve leading
 * spaces, which is precisely the thing being looked for. The padding on the right is not, so
 * it comes off; the left-hand side is left exactly as drawn. xterm spells a run of blanks with
 * no-break spaces, which are the same columns by another name.
 */
const ROWS = `(() => {
  const card = document.querySelector('.terminal-card');
  if (!card) return null;
  const rows = [...card.querySelectorAll('.xterm-rows > div')]
    .map((row) => (row.textContent || '').replace(/\\u00a0/g, ' ').replace(/\\s+$/, ''));
  return {
    rows,
    mode: (card.querySelector('.terminal-card__mode') || {}).textContent || '',
    // The whole screen as one string, for a failure that has to be read rather than counted.
    screen: (card.querySelector('.xterm-rows') || {}).textContent || '',
  };
})()`;

/**
 * The drawn rows that carry anything, in order.
 *
 * A screen is taller than a transcript, so the empty tail is not part of the comparison. The
 * blank line the renderer itself writes before the closing line is between two rows that do
 * carry text, so it survives the trim at both ends and is compared like any other.
 */
function drawnBody(rows) {
  const first = rows.findIndex((row) => row.trim());
  if (first < 0) return [];
  let last = rows.length - 1;
  while (last > first && !rows[last].trim()) last--;
  return rows.slice(first, last + 1);
}

/** The transcript, as the server is holding it. */
async function scrollbackOf(base) {
  const payload = await (await api(base, '/api/terminal')).json();
  return payload?.sessions?.[0]?.scrollback ?? '';
}

/**
 * Open a session running the stub, and wait until the block has drawn all of it.
 *
 * The command is named in the body rather than left to the configured shell — the route takes
 * one for exactly this, and a check that typed the command into the shell instead would be
 * asserting the shell's echo as much as the renderer's output.
 */
async function openSession(base) {
  const response = await api(base, '/api/terminal', {
    method: 'POST',
    body: JSON.stringify({ command: SESSION_COMMAND }),
  });
  if (response.status !== 202) {
    throw new Error(`POST /api/terminal answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).session;
}

try {
  await waitFor(async () => (await fetch(`${PIPE_BASE}/health`)).ok, 'the pipe-mode canvas server');
  await waitFor(async () => (await fetch(`${PTY_BASE}/health`)).ok, 'the pty-mode canvas server');

  const pipeSession = await openSession(PIPE_BASE);
  const ptySession = await openSession(PTY_BASE);

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    PIPE_BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  console.log('1. the renderer wrote what it always wrote, and the session carried it unchanged');
  const scrollback = await waitFor(async () => {
    const text = await scrollbackOf(PIPE_BASE);
    return text.includes('the run finished') ? text : null;
  }, 'the stub\'s output to reach the transcript');

  check('the session is on pipes, which is where the agent tab is',
        pipeSession.mode === 'pipe', pipeSession.mode);
  check('the transcript is the renderer\'s output, envelopes gone',
        scrollback.includes('⏺ Read(') && scrollback.includes('  ⎿  alpha') && !scrollback.includes('"type"'),
        JSON.stringify(scrollback.slice(0, 200)));
  // The property #219 exists to protect, and the reason the fix is not `\r\n` in the renderer:
  // the raw tap, `extractGithubUrl` and `UsageMeter` all read these bytes.
  check('and it is `\\n`-terminated, with no carriage return anywhere in it',
        !scrollback.includes('\r'),
        JSON.stringify(scrollback.slice(0, 200)));

  console.log('\n2. every line is drawn where it says it is, not where the line before it ended');
  const pipe = await waitFor(async () => {
    const probed = await evaluate(ROWS);
    return probed && probed.rows.some((row) => row.includes('the run finished')) ? probed : null;
  }, 'the block to draw the transcript');
  await shot('01-pipe-mode');

  check('the block says the session is on pipes', pipe.mode.trim() === 'pipe', pipe.mode);

  const pipeBody = drawnBody(pipe.rows);
  check('the emulator drew one row per line of the transcript',
        pipeBody.length === EXPECTED.length,
        `drew ${pipeBody.length}, transcript has ${EXPECTED.length}`);

  // The case the whole check exists for. Row by row, because "the text is all there" is what
  // already passed: a staircase loses nothing, it only puts every line in the wrong column.
  for (const [index, line] of EXPECTED.entries()) {
    const drawn = pipeBody[index] ?? '';
    check(line.trim()
            ? `row ${index + 1} is drawn at column ${line.length - line.trimStart().length}: ${JSON.stringify(line.trim().slice(0, 34))}`
            : `row ${index + 1} is the blank line the renderer wrote`,
          drawn === line,
          `drew ${JSON.stringify(drawn)}`);
  }

  // Said once more the way the screenshot said it, so a failure names the symptom rather than
  // a row number: the reported shape is every line starting further right than the last.
  const starts = pipeBody.map((row) => row.length - row.trimStart().length);
  check('no line is indented past the one before it by the width of that one',
        !starts.some((column, index) => index > 0 && pipeBody[index - 1].trim()
                                        && column > (EXPECTED[index]?.length ?? 0)),
        `columns ${JSON.stringify(starts)}`);

  console.log('\n3. a pty-mode session still draws correctly, so the fix is scoped to the mode that needs it');
  if (ptySession.mode !== 'pty') {
    console.log('  skip  this machine has no @lydell/node-pty binding, so there is no pty session to draw');
    console.log(`        (the second server reported mode "${ptySession.mode}")`);
  } else {
    await send('Page.navigate', { url: PTY_BASE });
    await sleep(1500);
    const pty = await waitFor(async () => {
      const probed = await evaluate(ROWS);
      return probed && probed.rows.some((row) => row.includes('the run finished')) ? probed : null;
    }, 'the pty block to draw the transcript');
    await shot('02-pty-mode');

    check('the block says the session got a pseudoterminal', pty.mode.trim() === 'pty', pty.mode);
    const ptyBody = drawnBody(pty.rows);
    // Not compared against `EXPECTED` line for line: a pty is a screen, and what a program
    // paints on one is the pty's business — `\r\n` from the terminal discipline here, but a
    // cursor move somewhere else. What is asserted is the thing the reader sees: no line
    // starts in a column the transcript never named.
    check('its lines are drawn at the columns the renderer named, none of them adrift',
          ptyBody.length > 0 && ptyBody.every((row) => {
            const text = row.trim();
            if (!text) return true;
            const line = EXPECTED.find((candidate) => candidate.trim() === text);
            return line !== undefined && row === line;
          }),
          JSON.stringify(ptyBody));
  }
} catch (error) {
  failures++;
  console.error(`  FAIL  the check ran to the end — ${error.message}`);
  if (serverLog.trim()) console.error(serverLog.trim().split('\n').slice(-12).join('\n'));
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(500);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds handles */ }
}

console.log(failures === 0
  ? '\nAll checks passed.'
  : `\n${failures} check${failures === 1 ? '' : 's'} failed.`);
if (failures > 0 && !argOf('--shots')) {
  console.log('Pass --shots <dir> to keep the screenshots of what was actually drawn.');
}
process.exit(failures === 0 ? 0 : 1);
