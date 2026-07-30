#!/usr/bin/env node
/**
 * Checks the two things #260 asks of an `Implement / Fix` tab: that a file-editing tool call
 * opens as a **diff**, and that a reader who has scrolled away has a way **back to the bottom**.
 *
 * The observation is two screenshots of the same tool call in the two tabs. `Implement, and let
 * me answer` — the pseudoterminal — draws `⏺ Update(App.tsx)` and then a unified diff, because
 * that picture is the agent's own program repainting itself and the board never parses it.
 * `Implement / Fix` — the tab the board composes — drew `old_string:` followed by the whole old
 * text and `new_string:` followed by the whole new text, two near-identical blocks with nothing
 * marking what differs. The reader diffed them by eye.
 *
 * ## Where the diff has to be computed, and why that decides the shape of this check
 *
 * In the **server**, in `agent-stream-render.ts`, and both halves of that are measurable here:
 *
 * - the frontend is handed `input` already flattened to one string, so an `old_string` whose own
 *   text contains a line reading `new_string:` defeats parsing it back apart in the browser;
 * - the record is capped at `DETAIL_CHARS` **before** it is written into the transcript, so a
 *   diff computed after the cap would be a diff of a truncated file.
 *
 * So section 1 asks the renderer directly, with no browser: the detail record for an `Edit` is
 * already a diff by the time it reaches the scrollback. Section 2 then asks the browser whether
 * that diff is *drawn* as one, which is the case `CLAUDE.md` names — a colour compiles perfectly
 * whether or not the screen shows two.
 *
 * ## Colour is asserted twice, and the second time off the screen
 *
 * Once as **slots** — SGR 31 and 32, never a `38;2;r;g;b`, because a literal hex is the light
 * palette printed into a dark card (`terminal-palette.ts`). And once as **pixels**: a clip of the
 * removed line and a clip of the added line are captured, decoded, and the strongest ink in each
 * is asked which of the two palette entries it is nearer. `getComputedStyle` would answer with
 * the declaration; this answers with the render.
 *
 * ## And the control
 *
 * `Jump to bottom (ctrl+End)`, in the observation's own words. Section 3 measures it as a reader
 * meets it: absent while the view is already at the end, on screen once a wheel has scrolled the
 * transcript away from it, landing at the bottom on a real pointer click, and following the
 * output that arrives afterwards. `Ctrl+End` is then asked to do the same thing from the
 * keyboard — and asked to reach **neither** the board's hotkeys nor Excalidraw's tools, which is
 * measured by a bubble-phase listener on `document` that must never see the key at all.
 *
 * Self-contained: it builds a throwaway workspace, starts its own server on a free port, drives
 * Chrome over the DevTools protocol through `ws`, and kills both. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend, so a fix that is
 * only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-agent-transcript-diff-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

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
if (!existsSync(renderModule)) {
  console.error(`  FAIL  the built server exists — ${renderModule} not found`);
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

const render = await import(pathToFileURL(renderModule).href);
// The board's own table, so the pixel cases can ask whether the screen resolved a *slot* against
// the reader's palette rather than merely painted the line something reddish. A hex literal here
// would be the defect #242 is about, one file further along.
const { terminalXtermTheme } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'terminal-palette.js')).href
);
const PAPER = terminalXtermTheme('light');

const rgbOf = (hex) => {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16));
};
const asRgb = (hex) => `rgb(${rgbOf(hex).join(', ')})`;

// ─── What a run streams ───────────────────────────────────────
//
// Four tool calls, one per shape the change has an opinion about: an `Edit`, whose two strings
// have to become one diff; a `MultiEdit`, which is the same thing once per edit; a `Write`, whose
// whole content is added because the old content is not in the input; and a `Bash`, which is
// every other tool and must be exactly what it was.

const EDIT_CONTEXT = 'EDIT-CONTEXT-LINE';
const EDIT_REMOVED = 'EDIT-REMOVED-LINE';
const EDIT_ADDED = 'EDIT-ADDED-LINE';
const MULTI_REMOVED = 'MULTI-SECOND-REMOVED-LINE';
const MULTI_ADDED = 'MULTI-SECOND-ADDED-LINE';
const WRITE_ADDED = 'WRITE-ADDED-LINE';
const BASH_TAIL = 'ZZ-END-OF-THE-COMMAND-ZZ';

/** Enough prose that the transcript overflows the block, which is what section 3 needs. */
const PROSE = Array.from({ length: 120 }, (_, index) => `prose line ${index + 1} of the run`);

const EDIT_INPUT = {
  file_path: 'C:/tmp/fold-project/frontend/src/App.tsx',
  old_string: `${EDIT_CONTEXT}\n${EDIT_REMOVED}\n`,
  new_string: `${EDIT_CONTEXT}\n${EDIT_ADDED}\n`,
  replace_all: false,
};

const MULTI_INPUT = {
  file_path: 'C:/tmp/fold-project/src/server.ts',
  edits: [
    { old_string: 'MULTI-FIRST-REMOVED-LINE\n', new_string: 'MULTI-FIRST-ADDED-LINE\n' },
    { old_string: `${MULTI_REMOVED}\n`, new_string: `${MULTI_ADDED}\n` },
  ],
};

const WRITE_INPUT = {
  file_path: 'scripts/check-project-card-limit.mjs',
  content: `#!/usr/bin/env node\nconsole.log('${WRITE_ADDED}');\n`,
};

const BASH_INPUT = {
  command: `git log --oneline --decorate --graph --all | head -200\necho ${BASH_TAIL}`,
};

const toolCall = (id, name, input) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id, content) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});

const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Edit', 'Write'] },
  { type: 'assistant', message: { content: [{ type: 'text', text: PROSE.join('\n') }] } },
  toolCall('toolu_edit_1', 'Edit', EDIT_INPUT),
  toolResult('toolu_edit_1', 'The file has been updated.'),
  toolCall('toolu_multi_1', 'MultiEdit', MULTI_INPUT),
  toolResult('toolu_multi_1', 'Applied 2 edits.'),
  toolCall('toolu_write_1', 'Write', WRITE_INPUT),
  toolResult('toolu_write_1', 'Wrote 2 lines.'),
  toolCall('toolu_bash_1', 'Bash', BASH_INPUT),
  toolResult('toolu_bash_1', 'a line of output'),
];

const STREAM = `${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`;

// ─── 1. The renderer writes a diff, before the cap ────────────

console.log('1. the detail record of a file-editing call is already a diff');

const rendered = new render.AgentStreamRenderer().feed(STREAM);
const parsed = typeof render.parseFoldedTranscript === 'function'
  ? render.parseFoldedTranscript(rendered)
  : { rows: [], details: {} };

const edit = parsed.details.toolu_edit_1;
const multi = parsed.details.toolu_multi_1;
const write = parsed.details.toolu_write_1;
const bash = parsed.details.toolu_bash_1;

/** One line of a detail record, with every escape taken out — what a reader sees. */
const plainLines = (text) => String(text ?? '')
  .split('\n')
  .map((line) => line.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ''));

/**
 * The foreground slot in force where a marker begins, read the way an emulator reads it.
 *
 * Walked rather than asked of the parser, so this case is a second opinion about the sequence
 * rather than an agreement with whatever the renderer's own reader happens to say.
 */
function slotAt(text, marker) {
  const at = String(text ?? '').indexOf(marker);
  if (at < 0) return undefined;
  const names = new Map([
    [30, 'black'], [31, 'red'], [32, 'green'], [33, 'yellow'],
    [34, 'blue'], [35, 'magenta'], [36, 'cyan'], [37, 'white'],
    [90, 'brightBlack'], [91, 'brightRed'], [92, 'brightGreen'], [93, 'brightYellow'],
    [94, 'brightBlue'], [95, 'brightMagenta'], [96, 'brightCyan'], [97, 'brightWhite'],
  ]);
  let slot = null;
  const pattern = /\u001b\[([0-9;]*)m/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= at) break;
    for (const part of match[1].split(';')) {
      const code = Number(part === '' ? 0 : part);
      if (code === 0 || code === 39) slot = null;
      else if (names.has(code)) slot = names.get(code);
    }
  }
  return slot;
}

check('an Edit still carries a record at all',
  Boolean(edit) && edit.name === 'Edit', JSON.stringify(Object.keys(parsed.details)));

const editLines = plainLines(edit?.input);
check('the raw `old_string:` / `new_string:` pair is gone from what the reader opens',
  editLines.every((line) => !/^old_string:/.test(line) && !/^new_string:/.test(line)),
  JSON.stringify(editLines.slice(0, 8)));
check('and the fields that are not the text being changed stay above the diff',
  editLines.some((line) => line.startsWith('file_path: '))
  && editLines.some((line) => line.startsWith('replace_all: ')),
  JSON.stringify(editLines.slice(0, 4)));

const removedLine = editLines.find((line) => line.includes(EDIT_REMOVED));
const addedLine = editLines.find((line) => line.includes(EDIT_ADDED));
const contextLine = editLines.find((line) => line.includes(EDIT_CONTEXT));
check('the line that went away is marked as removed',
  Boolean(removedLine) && /^\s*- /.test(removedLine.replace(/^\s*\d*/, '')),
  JSON.stringify(removedLine));
check('the line that arrived is marked as added',
  Boolean(addedLine) && /^\s*\+ /.test(addedLine.replace(/^\s*\d*/, '')),
  JSON.stringify(addedLine));
check('and the line that did not move is marked as neither',
  Boolean(contextLine) && !/[-+]/.test(contextLine.replace(EDIT_CONTEXT, '')),
  JSON.stringify(contextLine));

check('removed is written in the failure slot and added in the success slot',
  slotAt(edit?.input, EDIT_REMOVED) === 'red' && slotAt(edit?.input, EDIT_ADDED) === 'green',
  `removed ${slotAt(edit?.input, EDIT_REMOVED)}, added ${slotAt(edit?.input, EDIT_ADDED)}`);
check('and context keeps the reader\'s own ink rather than being given one',
  slotAt(edit?.input, EDIT_CONTEXT) === null,
  String(slotAt(edit?.input, EDIT_CONTEXT)));
check('the colours are slot references, never a literal hex',
  !/\u001b\[[0-9;]*(?:38|48);/.test(String(edit?.input ?? '')),
  'a 38;2;r;g;b is the light palette printed into a dark card');

// The record travels in an OSC payload whose terminator is a BEL and whose parser stops at the
// first ESC. `JSON.stringify` escapes every byte below 0x20, so a diff full of SGR sequences is
// still one line that `trimScrollback` cannot cut in half — #246's two invariants.
check('a diff full of escapes still leaves the mark one unbroken line',
  render.hasFoldMarks(rendered)
  && !rendered.split('\n').some((line) => /\u001b\]1338;/.test(line) && !/\u0007/.test(line)),
  'a fold mark ran past the end of its line');

const visible = render.stripFoldMarks(rendered).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
check('and outside the fold view the transcript is the picture it always was',
  visible.includes('⏺ Edit(') && visible.includes('⏺ Bash(')
  && !visible.includes(EDIT_REMOVED) && !visible.includes(WRITE_ADDED),
  JSON.stringify(visible.slice(-200)));

const multiLines = plainLines(multi?.input);
check('a MultiEdit is the same diff, once per edit',
  multiLines.some((line) => line.includes('MULTI-FIRST-REMOVED-LINE') && line.includes('-'))
  && multiLines.some((line) => line.includes(MULTI_ADDED) && line.includes('+'))
  && multiLines.every((line) => !/^edits:/.test(line)),
  JSON.stringify(multiLines.slice(0, 12)));
check('and it says which edit each hunk is',
  multiLines.some((line) => /edit 2 of 2/.test(line)), JSON.stringify(multiLines));

const writeLines = plainLines(write?.input);
check('a Write shows its whole content as added, since the old content is not in the input',
  writeLines.some((line) => line.includes(WRITE_ADDED) && line.includes('+'))
  && writeLines.every((line) => !/^content:/.test(line)),
  JSON.stringify(writeLines));
check('and the file it writes is still named above it',
  writeLines.some((line) => line.startsWith('file_path: ')), JSON.stringify(writeLines.slice(0, 3)));
check('a Write is written in the success slot, having nothing to remove',
  slotAt(write?.input, WRITE_ADDED) === 'green', String(slotAt(write?.input, WRITE_ADDED)));

check('every other tool keeps the `key: value` record it had',
  Boolean(bash) && plainLines(bash.input).some((line) => line.startsWith('command: '))
  && String(bash.input).includes(BASH_TAIL),
  JSON.stringify(plainLines(bash?.input).slice(0, 3)));
check('and no colour is written into one',
  !/\u001b\[/.test(String(bash?.input ?? '')),
  'a Bash record was painted, which is a diff vocabulary leaking onto every tool');

// ─── The browser ──────────────────────────────────────────────

const chromePath = findChrome();
const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('\n  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  failures++;
}

if (!chromePath) skipWithoutChrome({ lead: '\n', failures });

/**
 * Enough of a PNG decoder to read a clipped screenshot back.
 *
 * The same one `check-terminal-paper-browser.mjs` reads the board's own paper with. Eight-bit,
 * colour type 2 or 6, which is all Chrome emits; all five row filters, because which one it
 * picks for a given strip is its business rather than ours.
 */
function decodePng(buffer) {
  let at = 8;
  let header = null;
  const parts = [];
  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('ascii', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], colour: body[9] };
    if (type === 'IDAT') parts.push(body);
    at += 12 + length;
  }
  const lanes = header?.colour === 6 ? 4 : header?.colour === 2 ? 3 : 0;
  if (!lanes || header.depth !== 8) throw new Error(`unreadable screenshot: ${JSON.stringify(header)}`);
  const raw = inflateSync(Buffer.concat(parts));
  const stride = header.width * lanes;
  const out = Buffer.alloc(stride * header.height);
  let source = 0;
  for (let row = 0; row < header.height; row++) {
    const filter = raw[source++];
    for (let index = 0; index < stride; index++) {
      const value = raw[source + index];
      const left = index >= lanes ? out[row * stride + index - lanes] : 0;
      const up = row > 0 ? out[(row - 1) * stride + index] : 0;
      const upLeft = row > 0 && index >= lanes ? out[(row - 1) * stride + index - lanes] : 0;
      let restored;
      if (filter === 0) restored = value;
      else if (filter === 1) restored = value + left;
      else if (filter === 2) restored = value + up;
      else if (filter === 3) restored = value + ((left + up) >> 1);
      else {
        const guess = left + up - upLeft;
        const toLeft = Math.abs(guess - left);
        const toUp = Math.abs(guess - up);
        const toCorner = Math.abs(guess - upLeft);
        restored = value + (toLeft <= toUp && toLeft <= toCorner ? left : toUp <= toCorner ? up : upLeft);
      }
      out[row * stride + index] = restored & 255;
    }
    source += stride;
  }
  return { header, lanes, stride, at: (x, y) => [out[y * stride + x * lanes], out[y * stride + x * lanes + 1], out[y * stride + x * lanes + 2]] };
}

const workDir = mkdtempSync(join(tmpdir(), 'check-diff-'));
const projectDir = join(workDir, 'diff-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'diff-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Diff Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

// The streaming stub the block watches. It prints the capture, then turns anything written to
// its stdin into one more line of transcript — which is how section 3 asks for output *after*
// the reader has jumped to the bottom, at a moment of the check's choosing rather than a timer's.
const agentStub = join(workDir, 'stub-agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(STREAM)});
process.stdin.on('data', (chunk) => {
  for (const line of String(chunk).split('\\n')) {
    const text = line.trim();
    if (!text) continue;
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\\n');
  }
});
setInterval(() => {}, 60000);
`, 'utf8');

const AGENT_COMMAND = `node "${agentStub.replace(/\\/g, '/')}" --output-format stream-json`;

const children = [];
let serverLog = '';

const PORT = 36100 + (process.pid % 90);
const CDP_PORT = PORT + 100;
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
    // Pipes rather than a PTY, so the stub's stdin is something this check can write one line
    // into and read a rendered line back out of.
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
 * Every inked pixel inside a box on screen, sorted into the two colours it might be.
 *
 * A count rather than one point, and the reason is measured: `#d20f39` and `#3f8f24` are almost
 * exactly the same distance from `#faf6ee`, so "the pixel furthest from the paper" is decided by
 * a single stray from the line above and reports the wrong colour with total confidence. A
 * tally cannot be turned over by one pixel. The clip is also inset by a row top and bottom,
 * because a removed line and the line that replaced it are adjacent by construction.
 *
 * Pixels that *are* the paper are skipped: most of a line of text is the surface between the
 * strokes, and a surface says nothing about which colour was asked for.
 */
async function inkTally(box, first, second) {
  const { data } = await send('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: Math.round(box.left), y: Math.round(box.top) + 1,
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height) - 2),
      scale: 1,
    },
  });
  const png = decodePng(Buffer.from(data, 'base64'));
  const paper = rgbOf(PAPER.background);
  const away = (target, pixel) =>
    rgbOf(target).reduce((sum, lane, index) => sum + (lane - pixel[index]) ** 2, 0);
  const tally = { first: 0, second: 0 };
  for (let y = 0; y < png.header.height; y++) {
    for (let x = 0; x < png.header.width; x++) {
      const pixel = png.at(x, y);
      if (pixel.reduce((sum, lane, index) => sum + (lane - paper[index]) ** 2, 0) < 3000) continue;
      if (away(first, pixel) < away(second, pixel)) tally.first += 1;
      else tally.second += 1;
    }
  }
  return tally;
}

async function clickAt(x, y) {
  const shared = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...shared });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...shared });
  await sleep(250);
}

async function wheelAt(x, y, deltaY) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: Math.round(x), y: Math.round(y), deltaX: 0, deltaY, button: 'none',
  });
  await sleep(200);
}

async function pressCtrlEnd() {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {
      type,
      modifiers: 2, // Ctrl
      key: 'End',
      code: 'End',
      windowsVirtualKeyCode: 35,
      nativeVirtualKeyCode: 35,
    });
  }
  await sleep(300);
}

/**
 * Where a selector's box is on screen, or null when there is nothing a mouse could reach.
 *
 * **Off the bottom of the window counts as nothing**, and that is not defensive padding. A
 * terminal block is a scene element with a size of its own, so a window shorter than the card
 * leaves its tool rows below the viewport with perfectly ordinary-looking rects — and
 * `Input.dispatchMouseEvent` at a `y` past the window hits nothing at all. Measured: the first
 * run of this check clicked four times into empty space and reported the feature missing.
 */
const boxOf = (selector) => `(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  const box = node.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) return null;
  return { ...point, left: box.left, top: box.top, width: box.width, height: box.height };
})()`;

/** The box of the first span of the open detail whose text carries a marker. */
const spanBox = (token) => `(() => {
  const spans = [...document.querySelectorAll('.terminal-transcript__detail-text span')];
  const found = spans.find((span) => (span.textContent || '').includes(${JSON.stringify(token)}));
  if (!found) return null;
  const box = found.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  return { left: box.left, top: box.top, width: box.width, height: box.height, colour: getComputedStyle(found).color };
})()`;

/** Where the transcript is, and whether the way back to the end of it is on screen. */
const VIEW = `(() => {
  const box = document.querySelector('.terminal-transcript:not([style*="hidden"])');
  if (!box) return null;
  const jump = box.querySelector('.terminal-transcript__jump-button');
  return {
    scrollTop: box.scrollTop,
    clientHeight: box.clientHeight,
    scrollHeight: box.scrollHeight,
    atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2,
    jump: jump ? (jump.textContent || '') : null,
    text: box.textContent || '',
  };
})()`;

async function openSession(command) {
  const response = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ command }) });
  if (response.status !== 202) {
    throw new Error(`POST /api/terminal answered ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).session;
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  const agentSession = await openSession(AGENT_COMMAND);

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    // Tall enough for the whole card, which is the size the *scene* gives the block rather than
    // one this check chooses: a shorter window puts the tool rows below the viewport, where a
    // dispatched mouse event reaches nothing and every case downstream is red for that reason
    // instead of its own.
    '--window-size=1500,1500',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  console.log('\n2. the block draws the diff, in colours read off the screen');

  await waitFor(async () => {
    const folds = await evaluate(`document.querySelectorAll('.terminal-transcript__fold').length`);
    return folds >= 4 ? folds : null;
  }, 'the block to draw four folded tool calls');
  await shot('01-folded');

  const editRow = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_edit_1"] .terminal-transcript__row'));
  check('there is an Edit row to aim at', Boolean(editRow), 'the Edit row has no box on screen');
  if (editRow) {
    await clickAt(editRow.x, editRow.y);
    const opened = await evaluate(VIEW);
    await shot('02-edit-open');

    check('the opened Edit shows no raw old_string / new_string pair',
      !opened.text.includes('old_string:') && !opened.text.includes('new_string:'),
      JSON.stringify(opened.text.slice(-400)));
    check('and it shows the removed line, the added line and the context between them',
      opened.text.includes(EDIT_REMOVED) && opened.text.includes(EDIT_ADDED)
      && opened.text.includes(EDIT_CONTEXT),
      JSON.stringify(opened.text.slice(-400)));

    const removedBox = await evaluate(spanBox(EDIT_REMOVED));
    const addedBox = await evaluate(spanBox(EDIT_ADDED));
    const contextBox = await evaluate(spanBox(EDIT_CONTEXT));
    check('the removed and added lines are their own runs on the screen',
      Boolean(removedBox) && Boolean(addedBox) && Boolean(contextBox),
      `removed ${JSON.stringify(removedBox)}, added ${JSON.stringify(addedBox)}`);

    if (removedBox && addedBox && contextBox) {
      const removedInk = await inkTally(removedBox, PAPER.red, PAPER.green);
      const addedInk = await inkTally(addedBox, PAPER.green, PAPER.red);
      check('the removed line is painted the palette\'s red, read off the render',
        removedInk.first > 0 && removedInk.first > removedInk.second,
        `${removedInk.first} pixels nearer ${PAPER.red}, ${removedInk.second} nearer ${PAPER.green}`);
      check('the added line is painted the palette\'s green, read off the render',
        addedInk.first > 0 && addedInk.first > addedInk.second,
        `${addedInk.first} pixels nearer ${PAPER.green}, ${addedInk.second} nearer ${PAPER.red}`);
      check('and the context line is neither, in the reader\'s own ink',
        contextBox.colour !== asRgb(PAPER.red) && contextBox.colour !== asRgb(PAPER.green),
        String(contextBox.colour));
      // The declaration as well as the render, because the two agreeing is what says the slot
      // was resolved against this board's palette rather than painted some red by a stylesheet.
      check('the run was resolved from the slot rather than from a hex in the frontend',
        removedBox.colour === asRgb(PAPER.red) && addedBox.colour === asRgb(PAPER.green),
        `removed ${removedBox.colour} / ${asRgb(PAPER.red)}, added ${addedBox.colour} / ${asRgb(PAPER.green)}`);
    }

    await clickAt(editRow.x, editRow.y);
  }

  const writeRow = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_write_1"] .terminal-transcript__row'));
  if (writeRow) {
    await clickAt(writeRow.x, writeRow.y);
    const writeBox = await evaluate(spanBox(WRITE_ADDED));
    await shot('03-write-open');
    check('a Write shows its content as added, in the same green',
      Boolean(writeBox) && writeBox.colour === asRgb(PAPER.green),
      JSON.stringify(writeBox));
    await clickAt(writeRow.x, writeRow.y);
  } else {
    check('a Write shows its content as added, in the same green', false, 'no Write row on screen');
  }

  const bashRow = await evaluate(boxOf('.terminal-transcript__fold[data-fold="toolu_bash_1"] .terminal-transcript__row'));
  if (bashRow) {
    await clickAt(bashRow.x, bashRow.y);
    const bashDetail = await evaluate(`(() => {
      const open = document.querySelector('.terminal-transcript__fold[data-fold="toolu_bash_1"] .terminal-transcript__detail');
      if (!open) return null;
      return {
        text: open.textContent || '',
        colours: [...open.querySelectorAll('.terminal-transcript__detail-text span')]
          .map((span) => getComputedStyle(span).color),
      };
    })()`);
    await shot('04-bash-open');
    check('a Bash call is the record it always was, uncoloured and unmarked',
      Boolean(bashDetail) && bashDetail.text.includes('command: ')
      && bashDetail.text.includes(BASH_TAIL)
      && !bashDetail.colours.includes(asRgb(PAPER.red))
      && !bashDetail.colours.includes(asRgb(PAPER.green)),
      JSON.stringify(bashDetail));
    await clickAt(bashRow.x, bashRow.y);
  } else {
    check('a Bash call is the record it always was, uncoloured and unmarked', false, 'no Bash row');
  }

  console.log('\n3. the way back to the bottom');

  const view = await evaluate(boxOf('.terminal-transcript:not([style*="hidden"])'));
  check('the transcript has more to show than fits, which is what the control is for',
    Boolean(view), 'no transcript on screen');

  const atBottom = await evaluate(VIEW);
  check('the transcript opens at the end of the run',
    atBottom.atEnd && atBottom.scrollHeight > atBottom.clientHeight,
    JSON.stringify(atBottom, null, 0).slice(0, 200));
  check('and while it is at the end the control is not on screen',
    atBottom.jump === null, JSON.stringify(atBottom.jump));

  // A wheel rather than an assignment to `scrollTop`: the box is under an overlay that hands a
  // wheel it has no use for back to the canvas, so this is also the path a reader's own scroll
  // takes.
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = await evaluate(VIEW);
    if (!now.atEnd && now.scrollTop < now.scrollHeight - now.clientHeight - 20) break;
    await wheelAt(view.x, view.y, -400);
  }
  const scrolled = await evaluate(VIEW);
  await shot('05-scrolled-up');
  check('a wheel scrolls the transcript away from the end',
    !scrolled.atEnd, JSON.stringify(scrolled).slice(0, 200));
  check('and then the control is on screen, in the words the ask used',
    scrolled.jump === 'Jump to bottom (ctrl+End)', JSON.stringify(scrolled.jump));

  const jumpBox = await evaluate(boxOf('.terminal-transcript__jump-button'));
  check('the control has a box to aim at', Boolean(jumpBox), 'nothing to click');
  if (jumpBox) {
    await clickAt(jumpBox.x, jumpBox.y);
    const landed = await evaluate(VIEW);
    await shot('06-jumped');
    check('clicking it lands at the bottom', landed.atEnd, JSON.stringify(landed).slice(0, 200));
    check('and once there it takes itself off the screen', landed.jump === null,
      JSON.stringify(landed.jump));

    // Later output has to be followed again, which is the half a plain `scrollTo` would miss:
    // the view is pinned to the end, not merely put there once.
    await api('/api/terminal/input', {
      method: 'POST',
      body: JSON.stringify({ sessionId: agentSession.id, data: 'LATER-LINE-AFTER-THE-JUMP\n' }),
    });
    const followed = await waitFor(async () => {
      const now = await evaluate(VIEW);
      return now.text.includes('LATER-LINE-AFTER-THE-JUMP') ? now : null;
    }, 'the line written after the jump').catch((error) => ({ error: String(error) }));
    await shot('07-followed');
    check('and the output that arrives afterwards is followed again',
      Boolean(followed) && followed.atEnd === true,
      JSON.stringify(followed).slice(0, 300));
  }

  console.log('\n   the same thing from the keyboard, and no further');

  // A bubble-phase listener on `document`. The card stops every key it has not been told is one
  // of the board's four, and React's `stopPropagation` calls the native one at its own root —
  // *below* `document` — so a chord that is handled inside the card can never be seen here.
  // Excalidraw's own tool bindings and the board's hotkeys both listen at or below this point.
  await evaluate(`(() => {
    window.__endKeys = 0;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'End') window.__endKeys++;
    });
    return true;
  })()`);

  // Focus the transcript by clicking a line of it — a line rather than a fold row, which would
  // toggle, and one that is **on screen** rather than the first in the document: this box is
  // scrolled, so the top of the run is somewhere above the card and a click aimed at it would
  // land on the canvas. That is not a hypothetical; it is what this case measured first time.
  const line = await evaluate(`(() => {
    const box = document.querySelector('.terminal-transcript:not([style*="hidden"])');
    if (!box) return null;
    const frame = box.getBoundingClientRect();
    const found = [...box.querySelectorAll('.terminal-transcript__line')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.height > 1 && rect.top >= frame.top + 4 && rect.bottom <= frame.bottom - 4;
    });
    if (!found) return null;
    const rect = found.getBoundingClientRect();
    return { x: rect.left + Math.min(20, Math.max(2, rect.width / 2)), y: rect.top + rect.height / 2 };
  })()`);
  check('there is a line of the transcript on screen to click into', Boolean(line));
  if (line) await clickAt(line.x, line.y);
  check('and clicking it puts the keyboard in the transcript',
    (await evaluate(`String(document.activeElement && document.activeElement.className || '')`))
      .includes('terminal-transcript'),
    await evaluate(`String(document.activeElement && document.activeElement.className || '(none)')`));

  for (let attempt = 0; attempt < 8; attempt++) {
    const now = await evaluate(VIEW);
    if (!now.atEnd && now.scrollTop < now.scrollHeight - now.clientHeight - 20) break;
    await wheelAt(view.x, view.y, -400);
  }
  const beforeKey = await evaluate(VIEW);
  check('the transcript is scrolled away again, with the control back on screen',
    !beforeKey.atEnd && beforeKey.jump === 'Jump to bottom (ctrl+End)',
    JSON.stringify(beforeKey).slice(0, 200));

  await pressCtrlEnd();
  const afterKey = await evaluate(VIEW);
  await shot('08-ctrl-end');
  check('Ctrl+End does what the click does',
    afterKey.atEnd && afterKey.jump === null, JSON.stringify(afterKey).slice(0, 200));
  check('and it reaches neither the board\'s hotkeys nor Excalidraw\'s tools',
    (await evaluate('window.__endKeys')) === 0,
    `${await evaluate('window.__endKeys')} End keys got past the card`);
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
