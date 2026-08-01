#!/usr/bin/env node
/**
 * Checks the Claude Code usage HUD in a real browser: what it says, where it sits, how often
 * it asks, and whether either theme can be read.
 *
 * Compiling is not working, and this repository has paid for that three times in the UI
 * layer alone. Everything below is decided by the cascade, by flex layout and by a timer —
 * none of which `tsc` or `vite build` runs.
 *
 * The claims:
 *
 *  - **Both environments, top right, legible.** Different accounts is the normal case, so
 *    the rows have to be told apart at a glance and neither may carry the other's email.
 *  - **Not on the canvas.** "Top right" has two answers and Excalidraw owns one of them:
 *    `layer-ui__wrapper__top-right` is its grid column, holding the library trigger. The HUD
 *    is in the header, a sibling of the canvas container — so it must not overlap either the
 *    canvas or that island, and it must survive `Hide Menus`, which is about Excalidraw's
 *    chrome and not about this board's.
 *  - **A minute, and nothing while hidden.** Counted inside the page by wrapping `fetch`
 *    before the document loads, so this measures what the page really sent rather than what
 *    the constant says.
 *  - **A stale reading is visibly stale.** The figures are only as fresh as the last session
 *    that ran a status line; a percentage that has quietly aged out is the one way this can
 *    lie rather than say nothing.
 *  - **Both themes, judged on rendered pixels.** Dark mode on this board is a canvas filter,
 *    so a declared colour proves nothing in general — and reading the screen is the method
 *    that stays correct whether the rule that painted it was the one anybody expected.
 *  - **One account is one quota.** Two machines signed in as the same person are drawing the
 *    same two windows twice, differing only in how stale each copy is, so they collapse to one
 *    row naming both — with the figures from the fresher reading. A missing account joins
 *    nobody, and an account that changes splits the row on the next poll, because the merge is
 *    decided at render time and has no state of its own to go wrong.
 *  - **Off says so.** An unset directory makes the route a 404, and a header corner that then
 *    draws nothing is indistinguishable from a board that does not have the feature.
 *
 * Self-contained: it writes its own status directory, starts its own canvas server on a free
 * port and drives its own headless Chrome. Nothing here talks to the board, to GitHub, to
 * WSL or to the network. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-claude-status-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
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

if (!existsSync(join(repoRoot, 'dist', 'frontend', 'index.html'))) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => value.replace(/\\/g, '/');

// ─── Contrast, the way WCAG defines it ────────────────────────

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// ─── Pixels, as the screen really has them ────────────────────

/**
 * Enough of a PNG decoder to read a clipped screenshot back. Eight-bit, colour type 2 or 6,
 * which is all Chrome emits; all five row filters, because which one it picks for a given
 * strip is its business. Lifted from `check-terminal-paper-browser.mjs`.
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
  return { header, lanes, stride, out };
}

// ─── A status directory with two environments in it ───────────

const workDir = mkdtempSync(join(tmpdir(), 'check-claude-status-browser-'));
const statusDir = join(workDir, 'claude-status');
const projectDir = join(workDir, 'hud-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [statusDir, projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const WORKSPACE = 'hud-project';
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'HUD Project', repo: 'vitorengers/vibemaxxing',
}), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: WORKSPACE, path: slash(projectDir) },
    { id: 'ubuntu-project', path: '/home/me/ubuntu-project', distro: 'Ubuntu-22.04' },
  ],
}), 'utf8');

const NOW = Math.floor(Date.now() / 1000);
const HOST_ACCOUNT = 'windows-user@example.com';
const WSL_ACCOUNT = 'ubuntu-user@example.com';

// The host: fresh, both windows, and a five-hour window with just over an hour on it.
// Whose account it says is a parameter, because half of what is under test below is what the
// HUD does when the two files name the same one — and that is a rewrite of these two files
// and a poll, with nothing else moving.
const writeHost = (account) => writeFileSync(join(statusDir, 'native.json'), JSON.stringify({
  ...(account === null ? {} : { account }),
  fiveHour: { usedPercent: 23.5, resetsAt: NOW + 3600 + 4 * 60 + 30 },
  sevenDay: { usedPercent: 41.2, resetsAt: NOW + 5 * 86400 + 23 * 3600 },
  observedAt: NOW,
}), 'utf8');

// The distro: ninety minutes old, and no five-hour window at all.
const writeDistro = (account) => writeFileSync(join(statusDir, 'wsl-Ubuntu-22.04.json'), JSON.stringify({
  ...(account === null ? {} : { account }),
  rate_limits: { seven_day: { used_percentage: 12, resets_at: NOW + 2 * 86400 + 5 * 3600 } },
  observedAt: NOW - 90 * 60,
}), 'utf8');

// Two accounts to start with, which is the case the HUD was built for.
writeHost(HOST_ACCOUNT);
writeDistro(WSL_ACCOUNT);

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_CLAUDE_STATUS: statusDir,
};
// Nothing this machine exports reaches the child: `scripts/lib/spawn-canvas.mjs` strips every
// `EXCALIDRAW_*` before the check's own values go in, so there is no terminal block over the
// board — and no other inherited setting — unless this check asks for it.

let serverLog = '';
const server = startCanvas({
  env: serverEnv,
}).child;
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();
const consoleLog = [];

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
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? [])
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ');
      consoleLog.push(`${message.params.type}: ${text}`);
      return;
    }
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
 * What one box of the screen really is: its background, and the pixel in it that stands out
 * furthest from that background.
 *
 * The background is the commonest colour in the box — a strip of text is mostly not text —
 * and the foreground is whichever pixel contrasts with it most, which sidesteps having to
 * guess where inside a proportional font a glyph's stem lands. Antialiasing only ever pulls
 * a pixel *towards* the background, so the extreme is the honest one to judge legibility on.
 */
async function readBox(rect) {
  const clip = {
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.max(2, Math.round(rect.w)), height: Math.max(2, Math.round(rect.h)),
    scale: 1,
  };
  const { data } = await send('Page.captureScreenshot', { format: 'png', clip });
  const { header, lanes, stride, out } = decodePng(Buffer.from(data, 'base64'));

  const tally = new Map();
  const pixels = [];
  for (let y = 0; y < header.height; y++) {
    for (let x = 0; x < header.width; x++) {
      const base = y * stride + x * lanes;
      const pixel = [out[base], out[base + 1], out[base + 2]];
      pixels.push(pixel);
      const key = pixel.join(',');
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  let background = null;
  let most = -1;
  for (const [key, count] of tally) {
    if (count > most) { most = count; background = key.split(',').map(Number); }
  }
  let text = background;
  let best = 1;
  for (const pixel of pixels) {
    const ratio = contrast(pixel, background);
    if (ratio > best) { best = ratio; text = pixel; }
  }
  return { background, text, ratio: best };
}

/** The imperative API, through the container's React fibre. See check-board-sections-browser. */
const GRAB_API = `(() => {
  const host = document.querySelector('.excalidraw-container') || document.querySelector('.excalidraw');
  if (!host) return false;
  const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
  if (!key) return false;
  let node = host[key];
  for (let up = 0; up < 60 && node; up++) {
    let state = node.memoizedState;
    for (let along = 0; along < 40 && state; along++) {
      const value = state.memoizedState;
      if (value && typeof value === 'object'
          && typeof value.getSceneElements === 'function' && typeof value.updateScene === 'function') {
        window.__hudApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The reads that need no screenshot: boxes, text, and what the page has actually asked for.
 *
 * Rows are keyed by the environment label they carry, because that is what a reader keys
 * them by; anything that mixed two machines' rows up would fail here rather than look tidy.
 */
const PROBE = `(() => {
  const boxOf = (node) => {
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      x: rect.x, y: rect.y, w: rect.width, h: rect.height,
      right: rect.right, bottom: rect.bottom,
      visible: rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
      fontSize: parseFloat(style.fontSize),
      text: (node.textContent || '').replace(/\\s+/g, ' ').trim(),
    };
  };
  const hud = document.querySelector('.claude-status');
  const rows = Array.from(document.querySelectorAll('.claude-status__row')).map((row) => ({
    label: (row.querySelector('.claude-status__env') || {}).textContent || '',
    stale: row.classList.contains('claude-status__row--stale'),
    box: boxOf(row),
    env: boxOf(row.querySelector('.claude-status__env')),
    account: boxOf(row.querySelector('.claude-status__account')),
    // The count matters as much as the box: one row carrying an account twice is two
    // readings drawn on one line rather than the one quota they share.
    accounts: Array.from(row.querySelectorAll('.claude-status__account')).map(boxOf),
    windows: Array.from(row.querySelectorAll('.claude-status__window')).map(boxOf),
    silent: Array.from(row.querySelectorAll('.claude-status__silent')).map(boxOf),
    age: boxOf(row.querySelector('.claude-status__age')),
  }));
  return {
    hud: boxOf(hud),
    hudTitle: hud ? hud.title : null,
    off: boxOf(document.querySelector('.claude-status__off')),
    pollMs: hud ? hud.dataset.pollMs : null,
    rows,
    header: boxOf(document.querySelector('.header')),
    controls: boxOf(document.querySelector('.controls')),
    canvas: boxOf(document.querySelector('.excalidraw')),
    island: boxOf(document.querySelector('.layer-ui__wrapper__top-right')),
    toolbar: boxOf(document.querySelector('.shapes-section')),
    theme: (document.querySelector('.app') || { dataset: {} }).dataset.theme || null,
    viewport: { w: window.innerWidth, h: window.innerHeight },
    polls: (window.__claudeStatusCalls || []).length,
  };
})()`;

/**
 * Counted inside the page, and installed before the document runs.
 *
 * Reading the server's log would count every tab in the browser and every request this check
 * made itself; what has to be true is about *this page's* timer.
 */
const COUNTER = `(() => {
  window.__claudeStatusCalls = [];
  const original = window.fetch;
  window.fetch = function (...args) {
    const first = args[0];
    const url = String(first && first.url ? first.url : first || '');
    if (url.includes('/api/claude-status')) window.__claudeStatusCalls.push(Date.now());
    return original.apply(this, args);
  };
  window.__hideTab = () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  };
})()`;

const PRESS_TOGGLE = `(() => {
  const header = document.querySelector('.header');
  const button = header
    ? Array.from(header.querySelectorAll('button')).find((b) => /menus/i.test(b.textContent || ''))
    : null;
  if (!button) return false;
  button.click();
  return true;
})()`;

const setTheme = (theme) => `(() => {
  window.__hudApi.updateScene({ appState: { theme: '${theme}' } });
  return true;
})()`;

const rowNamed = (seen, label) => seen.rows.find((row) => row.label === label) ?? null;

/**
 * The page's own view once it has had a chance to catch up — whether or not it did.
 *
 * `waitFor` throws, which is right for a precondition: with no HUD on screen nothing below it
 * can be asserted at all. The sections about merging are different. Each is an independent
 * claim about the same rendered rows, so a section that gives up must not take the ones after
 * it down with it — a run that stops at the first disagreement says nothing about the other
 * three, which is exactly what a check written against the old code is for. So this hands
 * back the last thing it saw and lets the cases below name what was wrong with it.
 */
async function probeUntil(predicate, tries = 40) {
  let last = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    last = await evaluate(PROBE);
    if (predicate(last)) return last;
    await sleep(250);
  }
  return last;
}

/** Both themes have to clear this, and the numbers are the same numbers in both. */
async function assertLegible(theme, seen) {
  const host = rowNamed(seen, 'Windows') ?? rowNamed(seen, 'Host');
  const wsl = rowNamed(seen, 'Ubuntu-22.04');

  const fresh = await readBox(host.windows[0]);
  check(`${theme}: the 5-hour figure has at least 4.5:1 where it is painted`,
    fresh.ratio >= 4.5, `${hex(fresh.text)} on ${hex(fresh.background)} is ${fresh.ratio.toFixed(2)}:1`);

  const account = await readBox(host.account);
  check(`${theme}: the account beside it is readable too`,
    account.ratio >= 4.5, `${hex(account.text)} on ${hex(account.background)} is ${account.ratio.toFixed(2)}:1`);

  const aged = await readBox(wsl.age);
  check(`${theme}: the age on the stale row is readable`,
    aged.ratio >= 4.5, `${hex(aged.text)} on ${hex(aged.background)} is ${aged.ratio.toFixed(2)}:1`);

  // Warm against neutral, read off the screen rather than off a declaration. A stale row
  // that differed only in wording would pass a DOM assertion and be invisible at a glance.
  const warmth = (pixel) => pixel[0] - pixel[2];
  check(`${theme}: the stale row is painted a different colour from a fresh one`,
    warmth(aged.text) > warmth(fresh.text) + 40,
    `stale ${hex(aged.text)} (warmth ${warmth(aged.text)}) vs fresh ${hex(fresh.text)} (warmth ${warmth(fresh.text)})`);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  // Before the document runs, so the very first poll is counted.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTER });
  await send('Page.navigate', { url: `${BASE}/?workspace=${WORKSPACE}` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');

  let seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.rows.length >= 2 ? now : null;
  }, 'the HUD to render both environments');
  await shot('01-light');

  // ─── Both environments, told apart ──────────────────────────

  console.log('\n1. both environments, side by side in the header');

  const host = rowNamed(seen, 'Windows') ?? rowNamed(seen, 'Host');
  const wsl = rowNamed(seen, 'Ubuntu-22.04');

  check('the host has a row', host !== null, JSON.stringify(seen.rows.map((r) => r.label)));
  check('and the distro has one under its own name', wsl !== null,
    JSON.stringify(seen.rows.map((r) => r.label)));
  check('the HUD is on screen', seen.hud?.visible === true, JSON.stringify(seen.hud));
  check('at a size somebody can read', (seen.hud?.fontSize ?? 0) >= 11, `${seen.hud?.fontSize}px`);

  check('the host row names its own account',
    host?.box.text.includes(HOST_ACCOUNT), host?.box.text);
  check('and not the other one', !host?.box.text.includes(WSL_ACCOUNT), host?.box.text);
  check('the distro row names its own account',
    wsl?.box.text.includes(WSL_ACCOUNT), wsl?.box.text);
  check('and not the other one', !wsl?.box.text.includes(HOST_ACCOUNT), wsl?.box.text);

  console.log('\n2. the two windows, with what is left of each');

  check('the host shows its 5-hour window rounded, with a countdown',
    /5h 24% \(1h \d\dm\)/.test(host?.box.text ?? ''), host?.box.text);
  check('and its 7-day window in days and hours',
    /7d 41% \(5d \d\dh\)/.test(host?.box.text ?? ''), host?.box.text);
  check('the distro’s 7-day window comes through in Claude Code’s own spelling',
    /7d 12% \(2d 0\dh\)/.test(wsl?.box.text ?? ''), wsl?.box.text);
  check('a window nothing was said about is a dash, never 0%',
    /5h —/.test(wsl?.box.text ?? '') && !/5h 0%/.test(wsl?.box.text ?? ''), wsl?.box.text);

  console.log('\n3. a reading that has aged out says so');

  check('the stale row is marked stale', wsl?.stale === true, JSON.stringify(wsl?.stale));
  check('and says how old it is, in words', /1h old/.test(wsl?.box.text ?? ''), wsl?.box.text);
  check('the fresh row is not marked', host?.stale === false, JSON.stringify(host?.stale));
  check('and carries no age, because there is nothing to warn about',
    host?.age === null, JSON.stringify(host?.age));

  // ─── Where it sits ──────────────────────────────────────────

  console.log('\n4. top right of the page, and off Excalidraw’s grid');

  check('the HUD is in the right-hand half of the window',
    seen.hud.x > seen.viewport.w / 2, `x=${Math.round(seen.hud.x)} of ${seen.viewport.w}`);
  check('and inside the header’s own controls',
    seen.hud.x >= seen.controls.x - 1 && seen.hud.right <= seen.controls.right + 1,
    `hud ${Math.round(seen.hud.x)}–${Math.round(seen.hud.right)}, controls ${Math.round(seen.controls.x)}–${Math.round(seen.controls.right)}`);
  check('entirely above the canvas, so it can never be over a scene element',
    seen.hud.bottom <= seen.canvas.y + 1,
    `hud bottom ${Math.round(seen.hud.bottom)}, canvas top ${Math.round(seen.canvas.y)}`);
  check('and clear of the island Excalidraw keeps in that corner',
    seen.island === null || seen.hud.bottom <= seen.island.y || seen.hud.y >= seen.island.bottom
    || seen.hud.right <= seen.island.x || seen.hud.x >= seen.island.right,
    `hud ${JSON.stringify(seen.hud)} island ${JSON.stringify(seen.island)}`);

  console.log('\n5. Hide Menus is about Excalidraw’s chrome, not this board’s');

  check('the toolbar is there to begin with', seen.toolbar?.visible === true, JSON.stringify(seen.toolbar));
  const pressed = await evaluate(PRESS_TOGGLE);
  check('there is a control in the header for it', pressed === true);
  await sleep(500);
  seen = await evaluate(PROBE);
  await shot('02-chrome-hidden');
  check('the toolbar goes', seen.toolbar?.visible !== true, JSON.stringify(seen.toolbar));
  check('and the HUD stays, with both rows',
    seen.hud?.visible === true && seen.rows.length >= 2, JSON.stringify(seen.hud));
  await evaluate(PRESS_TOGGLE);
  await sleep(500);

  // ─── Legibility, off the screen ─────────────────────────────

  console.log('\n6. light mode, judged on rendered pixels');

  seen = await evaluate(PROBE);
  check('the board is in light mode to start', seen.theme === 'light', JSON.stringify(seen.theme));
  await assertLegible('light', seen);

  console.log('\n7. dark mode, judged the same way');

  await evaluate(setTheme('dark'));
  seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.theme === 'dark' && now.rows.length >= 2 ? now : null;
  }, 'the board to go dark');
  await sleep(400);
  seen = await evaluate(PROBE);
  await shot('03-dark');
  await assertLegible('dark', seen);
  await evaluate(setTheme('light'));
  await sleep(400);

  // ─── How often it asks ──────────────────────────────────────

  console.log('\n8. a minute, not a render loop');

  seen = await evaluate(PROBE);
  check('the page says the interval it is using, and it is a minute',
    seen.pollMs === '60000', `data-poll-ms was ${JSON.stringify(seen.pollMs)}`);
  const early = seen.polls;
  check('it has asked once so far', early === 1, `${early} requests`);
  await sleep(4000);
  seen = await evaluate(PROBE);
  check('and has not asked again four seconds later', seen.polls === early,
    `${seen.polls} requests after four seconds`);

  console.log('\n9. and nothing at all while the tab is hidden');

  // The same page, told to poll fast, so the cases below take seconds rather than minutes.
  // The cadence itself was settled above; what is under test here is the visibility gate.
  await send('Page.navigate', { url: `${BASE}/?workspace=${WORKSPACE}&claudeStatusPollMs=400` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the reload');
  seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.rows.length >= 2 ? now : null;
  }, 'the HUD to render again');
  check('the page honours a slower or faster cadence when it is asked for one',
    seen.pollMs === '400', `data-poll-ms was ${JSON.stringify(seen.pollMs)}`);

  await sleep(2000);
  const whileVisible = (await evaluate(PROBE)).polls;
  check('it really is polling, so the count below means something',
    whileVisible >= 3, `${whileVisible} requests in two seconds at 400ms`);

  await evaluate('window.__hideTab()');
  const atHide = (await evaluate(PROBE)).polls;
  await sleep(2500);
  const afterHide = (await evaluate(PROBE)).polls;
  check('a hidden tab sends nothing, however long its timer has been running',
    afterHide === atHide, `${atHide} → ${afterHide} while hidden`);

  // ─── One account is one quota, however many machines spent it ───

  console.log('\n10. two environments on the same account are one row');

  // The same address in both files, spelled differently on purpose: an email is not
  // case-sensitive and a status line's stray space is not a second subscription.
  writeHost(`  ${HOST_ACCOUNT.toUpperCase()} `);
  writeDistro(HOST_ACCOUNT);

  // The tab above was told it was hidden; a fresh document is one that is really visible.
  await send('Page.navigate', { url: `${BASE}/?workspace=${WORKSPACE}&claudeStatusPollMs=400` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the accounts met');
  seen = await probeUntil((now) => now.rows.length === 1);
  await shot('04-merged');

  const merged = seen.rows[0];
  check('one row, not one per machine', seen.rows.length === 1,
    JSON.stringify(seen.rows.map((row) => row.label)));
  check('and it names the host', /Windows|Host/.test(merged?.label ?? ''), merged?.label);
  check('and the distro, in the same label', /Ubuntu-22\.04/.test(merged?.label ?? ''), merged?.label);
  check('the account is written once, not once per machine',
    merged?.accounts.length === 1, `${merged?.accounts.length} account spans`);
  check('and it is the account they share',
    new RegExp(HOST_ACCOUNT, 'i').test(merged?.box.text ?? ''), merged?.box.text);
  check('the figures are the fresher reading’s five-hour window',
    /5h 24% \(1h \d\dm\)/.test(merged?.box.text ?? ''), merged?.box.text);
  check('and its seven-day window',
    /7d 41% \(5d \d\dh\)/.test(merged?.box.text ?? ''), merged?.box.text);
  check('never the ninety-minute-old reading’s figures, which are the same quota gone stale',
    !/7d 12%/.test(merged?.box.text ?? ''), merged?.box.text);
  check('so the row is not marked stale, because what it is showing is not',
    merged?.stale === false, JSON.stringify(merged?.stale));

  console.log('\n11. and an account that changes splits it again, on the next poll');

  // Nothing reloads and nothing is clicked: one file is rewritten, and the poll that was
  // already running is what has to notice. An account can change mid-session, and the merge
  // is decided per render precisely so that costs no machinery.
  writeDistro(WSL_ACCOUNT);
  seen = await probeUntil((now) => now.rows.length === 2);
  await shot('05-split');

  const splitHost = rowNamed(seen, 'Windows') ?? rowNamed(seen, 'Host');
  const splitWsl = rowNamed(seen, 'Ubuntu-22.04');
  check('two rows again', seen.rows.length === 2,
    JSON.stringify(seen.rows.map((row) => row.label)));
  check('the host is back under its own name alone', splitHost !== null,
    JSON.stringify(seen.rows.map((row) => row.label)));
  check('and the distro under its own', splitWsl !== null,
    JSON.stringify(seen.rows.map((row) => row.label)));
  // The host's file still carries the shouted spelling section 10 wrote into it: folding case
  // is what decides whether two readings are one quota, and it is not licence to rewrite what
  // the operator's own script said.
  check('each naming its own account again, as its own file spells it',
    new RegExp(HOST_ACCOUNT, 'i').test(splitHost?.box.text ?? '')
    && splitWsl?.box.text.includes(WSL_ACCOUNT),
    `${splitHost?.box.text} / ${splitWsl?.box.text}`);
  check('and the distro’s own figures are back with it',
    /7d 12% \(2d 0\dh\)/.test(splitWsl?.box.text ?? ''), splitWsl?.box.text);

  console.log('\n12. a reading with no account joins nobody, not even another silence');

  writeHost(null);
  writeDistro(null);
  seen = await probeUntil((now) => now.rows.length === 2 && now.rows.every((row) => row.account === null));
  await shot('06-anonymous');

  check('two rows, because "not said" is not an account two machines have in common',
    seen.rows.length === 2, JSON.stringify(seen.rows.map((row) => row.label)));
  check('the host is still under its own name',
    (rowNamed(seen, 'Windows') ?? rowNamed(seen, 'Host')) !== null,
    JSON.stringify(seen.rows.map((row) => row.label)));
  check('and the distro under its own',
    rowNamed(seen, 'Ubuntu-22.04') !== null, JSON.stringify(seen.rows.map((row) => row.label)));
  check('and each still shows what it did report',
    /5h 24%/.test((rowNamed(seen, 'Windows') ?? rowNamed(seen, 'Host'))?.box.text ?? '')
    && /7d 12%/.test(rowNamed(seen, 'Ubuntu-22.04')?.box.text ?? ''),
    JSON.stringify(seen.rows.map((row) => row.box.text)));

  // ─── Off, and legibly so ────────────────────────────────────

  console.log('\n13. a board nobody configured says so, rather than showing nothing');

  // A second canvas, started without the setting. It has to be a second server: the
  // directory is read once, when the server starts, so "unset" is not something the running
  // one can be asked about.
  const OFF_PORT = await freePort();
  const offServer = startCanvas({
    env: {
      PORT: String(OFF_PORT),
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
    },
  }).child;
  children.push(offServer);
  offServer.stdout.on('data', (chunk) => { serverLog += chunk; });
  offServer.stderr.on('data', (chunk) => { serverLog += chunk; });
  const OFF_BASE = `http://127.0.0.1:${OFF_PORT}`;
  await waitFor(async () => (await fetch(`${OFF_BASE}/health`)).ok, 'the unconfigured canvas server');

  const refused = await fetch(`${OFF_BASE}/api/claude-status`);
  check('the route really is a 404 there', refused.status === 404, `status ${refused.status}`);

  await send('Page.navigate', { url: `${OFF_BASE}/?workspace=${WORKSPACE}` });
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle on the unconfigured board');
  const quiet = await probeUntil((now) => now.off !== null);
  await shot('07-off');

  check('the header says the HUD is off rather than leaving an empty corner',
    quiet.off?.visible === true, JSON.stringify(quiet.off));
  check('and points at the document that explains how to turn it on',
    /docs\/claude-status\.md/.test(quiet.off?.text ?? ''), quiet.off?.text);
  check('no row is drawn, because there is nothing to draw',
    quiet.rows.length === 0, JSON.stringify(quiet.rows.map((row) => row.label)));
  check('the server’s own sentence is there for a reader who hovers',
    /CLAUDE_STATUS/.test(quiet.hudTitle ?? ''), JSON.stringify(quiet.hudTitle));
  check('and it is still in the header’s controls, where the rows were',
    quiet.hud !== null && quiet.hud.x >= quiet.controls.x - 1
    && quiet.hud.right <= quiet.controls.right + 1,
    `hud ${JSON.stringify(quiet.hud)} controls ${JSON.stringify(quiet.controls)}`);

  const offLine = quiet.off ? await readBox(quiet.off) : null;
  check('legible where it is painted, like everything else in this corner',
    offLine !== null && offLine.ratio >= 4.5,
    offLine
      ? `${hex(offLine.text)} on ${hex(offLine.background)} is ${offLine.ratio.toFixed(2)}:1`
      : 'there was no line to read');
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
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) {
  if (consoleLog.length) console.error(`\nthe page said:\n  ${consoleLog.slice(-30).join('\n  ')}`);
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
