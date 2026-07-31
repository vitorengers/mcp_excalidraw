#!/usr/bin/env node
/**
 * Checks that the terminal block's mode chip says *why* the shell is on pipes.
 *
 * `check-pty-fallback-reason.mjs` asserts that the reason reaches the session summary and
 * the server's stderr. Neither of those is what a reader looks at. The chip has said
 * `pipe`, with a tooltip reading "No PTY on this machine, so the shell is on pipes", since
 * the terminal existed — a sentence that states the fact and not the cause, on a board
 * where the cause was a `logger.info` line in a file under `~/.local/state`.
 *
 * So the two cases are the two halves of the tooltip:
 *
 *  1. **On a board with no PTY**, the sentence that was always there is still there, and the
 *     reason is appended to it — the library's own wording, because it names the package to
 *     install. `EXCALIDRAW_TERMINAL_PTY=0` stands in for a machine `@lydell/node-pty` ships
 *     no prebuilt binary for, which is the same fallback taken deliberately.
 *  2. **On a board with a real PTY**, nothing is appended, because there is nothing to
 *     explain, and the `pty` chip keeps exactly the sentence it had.
 *
 * A tooltip is a `title` attribute, so this reads the attribute rather than hovering: what
 * the browser paints from it is the browser's, and what the block put there is the product's.
 * The screenshot beside it is for the reader of a failure, not for the assertion.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, starts its own two
 * canvas servers and kills everything. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-pty-fallback-reason-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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
let skipped = 0;

const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

function skip(name, why) {
  skipped++;
  console.log(`  skip  ${name} — ${why}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

/** The sentence the block has always shown for a pipe. The reason is appended to it. */
const THE_SENTENCE = 'No PTY on this machine, so the shell is on pipes';
const PTY_SETTING = 'EXCALIDRAW_TERMINAL_PTY';

// ─── A project with a terminal ────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-pty-reason-browser-'));
const projectDir = join(workDir, 'pipe-reason-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Pipe Reason Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'pipe-reason-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: slash(projectDir) }],
}), 'utf8');

/** A shell that is not a shell: it starts, says so, and waits to be closed. */
const stubShell = join(workDir, 'stub-shell.mjs');
writeFileSync(stubShell, `#!/usr/bin/env node
process.stdout.write('READY\\n');
process.stdin.resume();
process.stdin.on('data', () => { /* nothing types here */ });
`, 'utf8');

const children = [];

async function startBoard(name, env = {}) {
  const port = await freePort();
  const server = startCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `${name}.log`),
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_TERMINAL: `node "${slash(stubShell)}"`,
      ...env,
    },
  });
  children.push(server.child);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`the ${name} canvas exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the ${name} canvas never answered on ${server.base}:\n${server.read()}`);
}

// ─── Talking to Chrome ────────────────────────────────────────

const CDP_PORT = await freePort();
let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function attach() {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    return (await response.json()).find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
  }, 'a Chrome page target');
  socket = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
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
 * The mode chip, as the page rendered it.
 *
 * `title` rather than a hover: what a tooltip looks like belongs to the browser, and what
 * is in it belongs to the block. There is one chip per live session and the read-only badge
 * shares the class name, so the first is the mode's — the two are ordered in the header.
 */
const CHIP = `(() => {
  const chip = document.querySelector('.terminal-card__mode');
  if (!chip) return null;
  return { text: chip.textContent, title: chip.getAttribute('title') || '' };
})()`;

/** Open the board and wait for a session's chip to be drawn on it. */
async function chipOf(base, label) {
  await send('Page.navigate', { url: base });
  await sleep(1200);
  return waitFor(async () => {
    const chip = await evaluate(CHIP);
    return chip && chip.text ? chip : null;
  }, `the mode chip on the ${label} board`);
}

try {
  const piped = await startBoard('asked-for-pipes', { [PTY_SETTING]: '0' });
  const ordinary = await startBoard('with-pty');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    piped.base,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  // ─── 1 ──────────────────────────────────────────────────────
  console.log('1. a block on pipes says which sentence it is, and why');

  const pipeChip = await chipOf(piped.base, 'no-PTY');
  await shot('01-pipe-tooltip');
  check('the chip reads pipe', pipeChip.text.trim() === 'pipe', JSON.stringify(pipeChip.text));
  check('the tooltip still says what it always said', pipeChip.title.includes(THE_SENTENCE),
        JSON.stringify(pipeChip.title));
  check('and now says why there is no PTY here',
        pipeChip.title.includes(`${PTY_SETTING}=0`),
        `${JSON.stringify(pipeChip.title)} — the cause was a line in the log file, and the `
        + 'block said only that the mode was different');
  check('the reason comes after the sentence rather than instead of it',
        pipeChip.title.indexOf(`${PTY_SETTING}=0`) > pipeChip.title.indexOf(THE_SENTENCE),
        JSON.stringify(pipeChip.title));

  // ─── 2 ──────────────────────────────────────────────────────
  console.log('\n2. a block with a real terminal has nothing appended to it');

  const ptyChip = await chipOf(ordinary.base, 'PTY');
  await shot('02-pty-tooltip');
  if (ptyChip.text.trim() !== 'pty') {
    skip('the pty tooltip is left alone',
         `this machine opened a ${JSON.stringify(ptyChip.text.trim())} session — @lydell/node-pty `
         + 'ships no prebuilt binary for it');
  } else {
    check('the chip reads pty', ptyChip.text.trim() === 'pty', JSON.stringify(ptyChip.text));
    check('its tooltip is the terminal sentence, unchanged', /full-screen programs work/.test(ptyChip.title),
          JSON.stringify(ptyChip.title));
    check('with no reason bolted onto it', !/Why there is none/.test(ptyChip.title),
          JSON.stringify(ptyChip.title));
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(600);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log(skipped ? `\nall cases passed (${skipped} skipped)` : '\nall cases passed');
