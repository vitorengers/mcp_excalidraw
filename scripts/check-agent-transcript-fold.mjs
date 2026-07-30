#!/usr/bin/env node
/**
 * Checks that a tool call in a rendered agent tab folds shut, and that clicking it opens the
 * whole of what the transcript used to throw away.
 *
 * The report is a screenshot of an agent tab where every `Bash(...)` and every `Write(...)`
 * costs most of a screen and nothing answers a click. Two things were wrong under it, and they
 * ran in opposite directions:
 *
 * - the **command** was not folded at all — a `Bash` line and its whole result stood open;
 * - the **result** was already folded, and lossily, in the server: `renderResult` kept six
 *   lines and 400 characters, `summariseInput` kept one field of the input cut at 120, and only
 *   that survived into the scrollback. So click-to-expand was never a frontend change. The
 *   detail a click would reveal had never been sent.
 *
 * What is asserted here is therefore both halves at once: that the *transcript* now carries the
 * detail it used to discard, and that the *block* draws one row per tool call and opens it on a
 * real pointer click.
 *
 * **The browser half is not optional and this is the case `CLAUDE.md` names.** A fold is a hit
 * target, and a hit target compiles perfectly whether or not anything can be clicked on it.
 * Three defects in this repository's UI layer did exactly that.
 *
 * ### And the other tab, which does not fold
 *
 * `Implement, and let me answer` runs an agent without `-p`, so nothing renders: the tab is a
 * pseudoterminal and what is drawn is the agent's own full-screen interface repainting itself.
 * A board-side fold there would mean parsing tool calls back out of a program's repaints. What
 * the board does instead is stay out of the way, and section 5 measures exactly that — the
 * child's own transcript toggle, `Ctrl+O`, reaching the process on the far side of the block.
 *
 * Self-contained: it builds a throwaway workspace, starts its own server on a free port, drives
 * Chrome over the DevTools protocol through `ws`, and kills both. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend, so a fix that is
 * only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-agent-transcript-fold.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const renderModule = join(repoRoot, 'dist', 'core', 'agent-stream-render.js');
const sessionModule = join(repoRoot, 'dist', 'core', 'terminal-session.js');
for (const built of [renderModule, sessionModule]) {
  if (existsSync(built)) continue;
  console.error(`  FAIL  the built server exists — ${built} not found`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const render = await import(pathToFileURL(renderModule).href);
const { TerminalSession } = await import(pathToFileURL(sessionModule).href);
const { extractGithubUrl } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'issue-agent.js')).href
);
const { UsageMeter } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'agent-usage.js')).href
);
// The board's own table, so section 3 can ask whether the document resolved a slot against the
// palette rather than merely painted the row *something*. A hard-coded hex here would be the
// defect #242 is about, one file further along.
const { terminalXtermTheme } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-palette.js')).href
);
const PAPER = terminalXtermTheme('light');

/** `#0e7c86` as a browser reports it, which is what `getComputedStyle` answers with. */
function asRgb(hex) {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
  return `rgb(${red}, ${green}, ${blue})`;
}

// ─── What a run streams, built so that clipping is visible ────
//
// The shapes are the ones `check-agent-stream-render.mjs` took off a real
// `claude -p --output-format stream-json` capture. What is chosen here is their *size*: every
// payload runs past the clip the block already applied, and carries a token at the far end of
// it. A token that is absent while the row is folded and present after the click is the whole
// assertion — "the text is all there" is what passed before any of this, because the raw JSON
// contained it too.

const PR_URL = 'https://github.com/vitorengers/mcp_excalidraw/pull/246';
/** Past `oneLine`'s 120 characters, so the folded row cannot be carrying it. */
const BASH_TAIL = 'ZZ-END-OF-THE-COMMAND-ZZ';
/** Past `renderResult`'s six lines and 400 characters. */
const RESULT_TAIL = 'ZZ-END-OF-THE-RESULT-ZZ';
/** Inside a `Write` input, which `summariseInput` reduces to its `file_path` alone. */
const WRITE_TAIL = 'ZZ-END-OF-THE-FILE-ZZ';

const LONG_COMMAND = [
  'git log --oneline --decorate --graph --all',
  '  | head -200',
  `  | grep -v 'nothing at all' # a comment long enough to run past the summary's ceiling`,
  `  | awk '{ print $1, $2, $3, $4, $5, $6, $7, $8 }'`,
  `echo ${BASH_TAIL}`,
].join('\n');

const LONG_RESULT = [
  ...Array.from({ length: 11 }, (_, index) => `line ${index + 1} of a result nobody wants open`),
  RESULT_TAIL,
].join('\n');

const LONG_FILE = [
  '#!/usr/bin/env node',
  ...Array.from({ length: 9 }, (_, index) => `const line${index} = ${index};`),
  `console.log('${WRITE_TAIL}');`,
].join('\n');

const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Bash', 'Write'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: "I'll look at the history." }] } },
  {
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: LONG_COMMAND } }],
    },
  },
  {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: LONG_RESULT }] },
  },
  { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'a private thought' }] } },
  {
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        id: 'toolu_write_1',
        name: 'Write',
        input: { file_path: 'scripts/check-project-card-limit.mjs', content: LONG_FILE },
      }],
    },
  },
  {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_write_1', content: 'Wrote 12 lines to scripts/check-project-card-limit.mjs' }],
    },
  },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: `Done. ${PR_URL}` },
        { type: 'text', text: 'usage follows' },
      ],
      usage: { input_tokens: 1200, output_tokens: 340 },
    },
  },
  { type: 'result', is_error: false, num_turns: 4 },
];

const STREAM = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`;

// ─── 1. The transcript carries what the row hides ─────────────

console.log('1. the rendered transcript keeps the detail it used to discard');

const rendered = new render.AgentStreamRenderer().feed(STREAM);

// Both of these are called through a fallback so that a build with none of this in it fails
// on the cases about folding rather than dying on a `TypeError` — a check that stops before its
// own assertions is red for a reason nobody can read.
const marked = typeof render.hasFoldMarks === 'function' ? render.hasFoldMarks : (() => false);
const strip = typeof render.stripFoldMarks === 'function' ? render.stripFoldMarks : ((text) => text);

check('the transcript is marked as one that folds',
  marked(rendered),
  'no fold mark reached the transcript, so nothing downstream can group it');

const parsed = typeof render.parseFoldedTranscript === 'function'
  ? render.parseFoldedTranscript(rendered)
  : { rows: [], details: {} };

const heads = parsed.rows.filter((row) => row.head);
check('every tool call opens exactly one row',
  heads.length === 2 && heads.every((row) => row.text.startsWith('⏺ ')),
  JSON.stringify(heads.map((row) => row.text)));

check('the rows of a result belong to the call they answer',
  parsed.rows.filter((row) => row.id === 'toolu_bash_1' && !row.head).length > 1,
  'a result row carries no id, so folding the call shut would leave its answer behind');

// #242 landed while this was being written, and the two meet here: it gave the transcript a
// colour vocabulary written as SGR references to the sixteen named slots, precisely so the
// reader's own palette resolves them. A document view that dropped the escapes on its way to a
// `<div>` would be #246 quietly undoing it, so the row comes back cut where its colour changes
// and named by *slot* rather than by hex — the hex is the frontend's, because only the frontend
// knows which theme the board is in.
const bashHead = heads.find((row) => row.text.startsWith('⏺ Bash'));
check("a row keeps the colours #242 gave it, as slots rather than as a hex",
  Boolean(bashHead)
  && bashHead.segments.some((segment) => segment.slot === 'green' && segment.text.includes('Bash'))
  && bashHead.segments.some((segment) => segment.slot === 'brightBlack' && segment.text.startsWith('(')),
  JSON.stringify(bashHead?.segments));
check('and prose keeps the reader\'s own ink rather than being given one',
  parsed.rows.some((row) => row.text === "I'll look at the history."
    && row.segments.every((segment) => segment.slot === null)),
  JSON.stringify(parsed.rows[0]?.segments));

const bash = parsed.details.toolu_bash_1;
const write = parsed.details.toolu_write_1;

check('a Bash call keeps its whole command, past the 120 characters the row shows',
  Boolean(bash) && bash.input.includes(BASH_TAIL),
  bash ? JSON.stringify(bash.input.slice(0, 160)) : 'no record for the Bash call');
check('and its whole result, past the six lines and 400 characters the row shows',
  Boolean(bash) && bash.result !== null && bash.result.includes(RESULT_TAIL),
  bash ? JSON.stringify(String(bash.result).slice(0, 160)) : 'no record for the Bash call');
// The ask names `Write` and `Edit` beside `Bash`, and `summariseInput` reduces a `Write` to
// its `file_path` — the thing the reader wants is the field it drops.
check('a Write call keeps every field of its input, the content among them',
  Boolean(write) && write.input.includes(WRITE_TAIL) && write.input.includes('file_path'),
  write ? JSON.stringify(write.input.slice(0, 160)) : 'no record for the Write call');
check('and a file-writing tool folds exactly as Bash does, so it is not Bash alone',
  Boolean(write) && write.name === 'Write' && heads.some((row) => row.text.startsWith('⏺ Write(')),
  JSON.stringify(heads.map((row) => row.text)));

// The transcript is still the transcript. This is what a reader who never clicks sees, and it
// has to be byte for byte the shape #219 and #220 settled — the marks draw as nothing.
// The SGR sequences come off as well as the marks, and for the same reason: #242 writes the
// colour and neither it nor a mark is a glyph. What is left is what a reader sees.
const stripEscapes = (text) => text.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, '');
const visible = stripEscapes(strip(rendered));
check('with its marks taken out the transcript is the one the block already drew',
  visible.includes('⏺ Bash(') && visible.includes('  ⎿  line 1 of a result')
  && /… \d+ more lines/.test(visible) && !visible.includes(RESULT_TAIL)
  && !visible.includes(BASH_TAIL) && !visible.includes(WRITE_TAIL),
  JSON.stringify(visible.slice(0, 200)));
check('and it is still `\\n`-terminated, with no carriage return anywhere in it',
  !visible.includes('\r'));

// ─── 2. The two other readers of the same bytes ───────────────
//
// #219: `emit()` hands the raw chunk to the tap before it renders anything, because the
// envelopes this file deletes are where the pull request URL and the token counts live.

console.log('\n2. the raw stream still reaches the readers that parse it');

const workDir = mkdtempSync(join(tmpdir(), 'check-fold-'));
const workspace = { id: 'check', path: workDir, innerPath: workDir, environment: { kind: 'native' } };

const streamStub = join(workDir, 'stream.mjs');
writeFileSync(streamStub, `process.stdout.write(${JSON.stringify(STREAM)});\n`, 'utf8');
const plainStub = join(workDir, 'plain.mjs');
writeFileSync(plainStub, `process.stdout.write('just some prose\\nand a second line\\n');\n`, 'utf8');

const node = JSON.stringify(process.execPath);

async function runSession(command) {
  const shown = [];
  const raw = [];
  let exited = false;
  const session = new TerminalSession('s1', workspace, command, {
    onOutput: (data) => { shown.push(data); },
    onRaw: (data) => { raw.push(data); },
    onExit: () => { exited = true; },
  }, false, {});
  await session.started;
  for (let attempt = 0; attempt < 200 && !exited; attempt++) await sleep(50);
  return { shown: shown.join(''), raw: raw.join(''), scrollback: session.scrollback ?? '', exited };
}

const streamed = await runSession(
  `${node} ${JSON.stringify(streamStub)} --output-format stream-json`
);

check('the session ran to the end', streamed.exited);
check('the tap got every byte the process wrote',
  EVENTS.every((event) => streamed.raw.includes(JSON.stringify(event))),
  'the tap saw rendered text instead of the stream');
check('extractGithubUrl still finds the pull request in what the tap collected',
  extractGithubUrl(streamed.raw, 'pull') === PR_URL,
  String(extractGithubUrl(streamed.raw, 'pull')));

let counted = null;
const meter = new UsageMeter((usage) => { counted = usage; }, 0);
meter.take(streamed.raw);
meter.flush();
check('UsageMeter still counts out of the same bytes',
  Boolean(counted) && counted.inputTokens === 1200 && counted.outputTokens === 340,
  JSON.stringify(counted));

check('the scrollback the browser is replayed is the marked one',
  marked(streamed.scrollback) && stripEscapes(strip(streamed.scrollback)).includes('⏺ Bash('),
  JSON.stringify(streamed.scrollback.slice(0, 160)));

const plain = await runSession(`${node} ${JSON.stringify(plainStub)}`);
check('a session whose command does not stream is byte for byte what it was',
  plain.shown === 'just some prose\nand a second line\n' && plain.raw === plain.shown
  && !marked(plain.shown),
  JSON.stringify(plain.shown));

// ─── The browser ──────────────────────────────────────────────

function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => path && existsSync(path)) ?? null;
}

const chromePath = findChrome();
const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('\n  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  failures++;
}

if (!chromePath) {
  console.log('\nSKIPPED — no Chrome or Edge found, so the browser half was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds handles */ }
  process.exit(failures === 0 ? 0 : 1);
}

const projectDir = join(workDir, 'fold-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'fold-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Fold Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

// The streaming stub the block watches. It prints the capture and stays alive: a shell that
// exits is dropped from the session map on the spot, and the block would have nothing to draw.
const agentStub = join(workDir, 'stub-agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(STREAM)});
setInterval(() => {}, 60000);
`, 'utf8');

// The other tab, for section 5: a child that says what bytes reached its stdin. It stands in
// for the agent's own interface, which is the thing the board must not intercept a chord from.
const echoStub = join(workDir, 'stub-echo.mjs');
writeFileSync(echoStub, `#!/usr/bin/env node
process.stdin.on('data', (chunk) => {
  process.stdout.write('bytes ' + [...chunk].map((byte) => byte.toString(16).padStart(2, '0')).join(' ') + '\\n');
});
setInterval(() => {}, 60000);
`, 'utf8');

// `--output-format stream-json` is what `streamsUsage` reads, and it is what turns the
// renderer on for this session. Named in the body of the request, exactly as the operator's
// `EXCALIDRAW_IMPLEMENT_AGENT` names it in a real run.
const AGENT_COMMAND = `node "${agentStub.replace(/\\/g, '/')}" --output-format stream-json`;
const ECHO_COMMAND = `node "${echoStub.replace(/\\/g, '/')}"`;

const children = [];
let serverLog = '';

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;

children.push(spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: '1',
    // What a `-p` run gets anyway, and what makes the echo stub's stdin a pipe this check can
    // write one byte into and read back.
    EXCALIDRAW_TERMINAL_PTY: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
}));
children[0].stdout.on('data', (chunk) => { serverLog += chunk; });
children[0].stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog.slice(-1500)}`);
}

async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}) =>
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

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
 * A real pointer press and release at a point, which is what the ask is about.
 *
 * Not `element.click()`. The block is a DOM overlay over a canvas that claims the pointer, its
 * body stops `pointerdown` and its tab strip cancels the synthesised click on purpose — a
 * dispatched `click()` would sail past all three and prove nothing about what a reader's mouse
 * does. `Input.dispatchMouseEvent` enters where a mouse enters.
 */
async function clickAt(x, y) {
  const shared = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...shared });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...shared });
  await sleep(250);
}

/** Where a selector's box is on screen, or null when there is nothing to aim at. */
const boxOf = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const box = node.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
})()`;

/** What the block is drawing, read out of the DOM rather than out of the transcript. */
const CARD = `(() => {
  const card = document.querySelector('.terminal-card');
  if (!card) return null;
  const transcript = card.querySelector('.terminal-transcript:not([style*="hidden"])');
  return {
    folds: [...card.querySelectorAll('.terminal-transcript__fold')].map((fold) => ({
      id: fold.getAttribute('data-fold'),
      head: (fold.querySelector('.terminal-transcript__row') || {}).textContent || '',
      open: fold.classList.contains('terminal-transcript__fold--open'),
      // What the row is actually painted, straight off the pixels the browser resolved. #242's
      // colours are the board's, and a document view that dropped them would still fold.
      inks: [...fold.querySelectorAll('.terminal-transcript__head span')]
        .map((span) => getComputedStyle(span).color),
    })),
    hasEmulator: Boolean(card.querySelector('.xterm-rows')),
    text: transcript ? (transcript.textContent || '') : (card.textContent || ''),
  };
})()`;

async function openSession(command) {
  const response = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ command }) });
  if (response.status !== 202) {
    throw new Error(`POST /api/terminal answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).session;
}

const scrollbackOf = async (sessionId) => {
  const payload = await (await api('/api/terminal')).json();
  return (payload?.sessions ?? []).find((one) => one.session?.id === sessionId
    || one.id === sessionId)?.scrollback ?? '';
};

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const agentSession = await openSession(AGENT_COMMAND);
  const echoSession = await openSession(ECHO_COMMAND);

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n3. the block draws one row per tool call, with the command folded away');

  const folded = await waitFor(async () => {
    const probed = await evaluate(CARD);
    return probed && probed.folds.length >= 2 ? probed : null;
  }, 'the block to draw a folded transcript');
  await shot('01-folded');

  check('a tool call is one row, and there is one row per call',
    folded.folds.length === 2, JSON.stringify(folded.folds.map((fold) => fold.head)));
  check('the rows say which tool each call was',
    folded.folds[0].head.includes('Bash(') && folded.folds[1].head.includes('Write('),
    JSON.stringify(folded.folds.map((fold) => fold.head)));
  check('every row starts folded shut',
    folded.folds.every((fold) => !fold.open));
  check('the whole command is not on the screen while the row is folded',
    !folded.text.includes(BASH_TAIL), 'the fold is drawn but it is not hiding anything');
  check('nor the whole result',
    !folded.text.includes(RESULT_TAIL));
  check('nor the content of the file that was written',
    !folded.text.includes(WRITE_TAIL));
  check('and the prose the agent wrote is still there, unfolded',
    folded.text.includes("I'll look at the history.") && folded.text.includes('the run finished'),
    JSON.stringify(folded.text.slice(0, 200)));
  // The half #242 would lose if this view had dropped the escapes on its way to a `<div>`. Not
  // "the row has two colours on it", which a stylesheet could have done by accident: the
  // *execution* slot for a `Bash`, the *mutation* slot for a `Write` and the dim ink for the
  // argument, each read back as the hex this board's paper palette resolves that slot to.
  const bashInks = folded.folds.find((fold) => fold.id === 'toolu_bash_1')?.inks ?? [];
  const writeInks = folded.folds.find((fold) => fold.id === 'toolu_write_1')?.inks ?? [];
  check('the row is painted in the slots #242 wrote, resolved against the reader\'s palette',
    bashInks[0] === asRgb(PAPER.green) && writeInks[0] === asRgb(PAPER.yellow),
    `Bash ${JSON.stringify(bashInks)} — expected ${asRgb(PAPER.green)}; `
    + `Write ${JSON.stringify(writeInks)} — expected ${asRgb(PAPER.yellow)}`);
  check('and the argument steps back into the dim ink behind the name',
    bashInks[1] === asRgb(PAPER.brightBlack),
    `${JSON.stringify(bashInks)} — expected ${asRgb(PAPER.brightBlack)}`);

  console.log('\n4. a pointer click on the row opens it, and a second one folds it back');

  const bashRow = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_bash_1"] .terminal-transcript__row'));
  check('there is a row to aim at', Boolean(bashRow), 'the Bash row has no box on screen');
  if (bashRow) {
    await clickAt(bashRow.x, bashRow.y);
    const opened = await evaluate(CARD);
    await shot('02-opened');
    check('the click opened the row it landed on',
      opened.folds.find((fold) => fold.id === 'toolu_bash_1')?.open === true,
      JSON.stringify(opened.folds));
    check('and it opened the one it landed on rather than all of them',
      opened.folds.find((fold) => fold.id === 'toolu_write_1')?.open === false);
    check('the whole command is now on the screen, past the 120 characters the row showed',
      opened.text.includes(BASH_TAIL), JSON.stringify(opened.text.slice(-300)));
    check('and the whole result, past the six lines the row showed',
      opened.text.includes(RESULT_TAIL));
    check('the file that was written is still folded away',
      !opened.text.includes(WRITE_TAIL));

    const writeRow = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_write_1"] .terminal-transcript__row'));
    if (writeRow) {
      await clickAt(writeRow.x, writeRow.y);
      const both = await evaluate(CARD);
      check('a file-writing tool opens the same way, so it is not Bash alone',
        both.text.includes(WRITE_TAIL) && both.text.includes('file_path'),
        JSON.stringify(both.folds));
    } else {
      check('a file-writing tool opens the same way, so it is not Bash alone', false,
        'the Write row has no box on screen');
    }

    const again = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_bash_1"] .terminal-transcript__row'));
    await clickAt(again.x, again.y);
    const closed = await evaluate(CARD);
    await shot('03-closed-again');
    check('a second click folds the row back',
      closed.folds.find((fold) => fold.id === 'toolu_bash_1')?.open === false
      && !closed.text.includes(BASH_TAIL),
      JSON.stringify(closed.folds));
  }

  console.log('\n   the state a reader put the transcript in survives a tab switch and a reload');

  // Re-open the Write row only, so what is asserted afterwards is a *state* rather than
  // "everything happens to be open".
  const writeAgain = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_write_1"] .terminal-transcript__row'));
  const writeIsOpen = await evaluate(`(() => document.querySelector('.terminal-transcript__fold[data-fold="toolu_write_1"]').classList.contains('terminal-transcript__fold--open'))()`);
  if (!writeIsOpen && writeAgain) await clickAt(writeAgain.x, writeAgain.y);

  const otherTab = await evaluate(boxOf(`.terminal-card__tab[data-session="${echoSession.id}"]`));
  check('the other session has a tab to switch to', Boolean(otherTab), echoSession.id);
  if (otherTab) {
    await clickAt(otherTab.x, otherTab.y);
    await sleep(400);
    const back = await evaluate(boxOf(`.terminal-card__tab[data-session="${agentSession.id}"]`));
    await clickAt(back.x, back.y);
    await sleep(400);
    const returned = await evaluate(CARD);
    check('the row that was open is still open after a tab switch',
      returned.folds.find((fold) => fold.id === 'toolu_write_1')?.open === true
      && returned.text.includes(WRITE_TAIL),
      JSON.stringify(returned.folds));
    check('and the row that was folded is still folded',
      returned.folds.find((fold) => fold.id === 'toolu_bash_1')?.open === false);
  }

  await send('Page.navigate', { url: BASE });
  await sleep(2000);
  const reloaded = await waitFor(async () => {
    const probed = await evaluate(CARD);
    return probed && probed.folds.length >= 2 ? probed : null;
  }, 'the block to draw the transcript again after a reload');
  await shot('04-after-reload');
  check('the row that was open comes back open after a reload',
    reloaded.folds.find((fold) => fold.id === 'toolu_write_1')?.open === true
    && reloaded.text.includes(WRITE_TAIL),
    JSON.stringify(reloaded.folds));
  check('and the row that was folded comes back folded',
    reloaded.folds.find((fold) => fold.id === 'toolu_bash_1')?.open === false
    && !reloaded.text.includes(BASH_TAIL));

  console.log('\n5. the other tab: the child\'s own transcript toggle is not the board\'s to take');

  // `Ctrl+O` is what an agent's own interface folds a tool call with. The board claims Alt
  // chords, the editing chords in `terminal-keys.ts`, `Ctrl+C` with a selection and `Ctrl+V`,
  // and nothing else — so this has to arrive at the process on the far side of the block.
  const echoTab = await evaluate(boxOf(`.terminal-card__tab[data-session="${echoSession.id}"]`));
  await clickAt(echoTab.x, echoTab.y);
  await sleep(400);
  const screen = await evaluate(boxOf('.terminal-card__body'));
  await clickAt(screen.x, screen.y);
  await sleep(200);

  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      modifiers: 2, // Ctrl
      key: 'o',
      code: 'KeyO',
      windowsVirtualKeyCode: 79,
      nativeVirtualKeyCode: 79,
      text: type === 'keyDown' ? '\u000f' : undefined,
    });
  }

  const echoed = await waitFor(async () => {
    const text = await scrollbackOf(echoSession.id);
    return text.includes('bytes ') ? text : null;
  }, 'the echo stub to report what reached its stdin').catch((error) => String(error));
  await shot('05-ctrl-o');
  check('Ctrl+O reaches the program in the tab rather than being taken by the board',
    typeof echoed === 'string' && echoed.includes('bytes 0f'),
    JSON.stringify(String(echoed).slice(-200)));
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
