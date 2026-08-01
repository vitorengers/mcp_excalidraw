#!/usr/bin/env node
/**
 * Checks that every setting this browser remembers survives its key being renamed.
 *
 * The frontend keeps eight things in `localStorage` — the theme, whether Excalidraw's own
 * menus are hidden, which project was last open, the terminal's font size, the terminal's
 * rect per board, how far the documentation has been pushed per board, each board's camera,
 * and which rows of a folded transcript are open. Every one of them used to be spelled as a
 * literal at the point it was read, two of them (`excalidraw-canvas-theme`) as bare strings
 * with no constant at all, and none of them had a fallback: a `getItem` that missed returned
 * the default and warned. So a rename pass that caught six of the eight missed the theme
 * entirely, and one that caught all eight reset every setting on the first load after the
 * upgrade — silently, because resetting to the default is exactly what an absent key means.
 *
 * What is under test is therefore the shim rather than the names: `frontend/src/storage.ts`
 * holds one `STORAGE_KEYS` map of `{ current, legacy }` pairs and one `readSetting` that
 * reads the current key, falls back to the legacy one, and writes the value forward on the
 * first read. The names moved to `vibemaxxing-*` in the same change, which is what makes the
 * cases below non-vacuous: a profile seeded with *only* the old names is exactly the profile
 * every existing installation has.
 *
 * Four sections, in the order the definition of done states them:
 *
 *   1. the source — `localStorage` is spelled in one module, so no key literal is loose;
 *   2. a profile carrying only the legacy keys, loaded once: all eight settings come back;
 *   3. after that load the new keys hold the same values;
 *   4. a profile carrying neither key falls back to `prefers-color-scheme` for the theme.
 *
 * Section 2 asks for the *rendered* answer wherever there is one — the board's `data-theme`,
 * the missing hamburger, the active tab, the camera in `appState`, the block's rect in the
 * scene, the card's font size, the fold row's `--open` class. The documentation shift is the
 * one that has no rendered answer on a load: it is read on the way into `syncTerminalBlocks`
 * and its effect is a *non*-move — content already standing at its resting place stays there
 * whether the shift was restored or lost, and the two only diverge later, when the region
 * shrinks and the board has to be pulled back left. So that one is asserted as the value the
 * page carried forward, which is still red against the old code (which writes the new key
 * never) and still proves the read went through the shim.
 *
 * `prefers-color-scheme` is emulated rather than inherited, in both directions, because a
 * check whose answer depends on the machine's own colour scheme passes somewhere and fails
 * somewhere else for a reason nobody can see.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes its own registry with two projects, runs a stub
 * agent for the transcript the folds belong to, starts its own canvas server on a free port
 * and kills both. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first —
 * it loads the built frontend, so a fix that is only in the source is a fix this cannot see.
 *
 * Usage: node scripts/check-storage-migration-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── 1. The source: one module spells `localStorage` ──────────
//
// The definition of done asks that every key be reachable from a single map and that no
// inline literal be left. Both are one rule once the reads and the writes go through the
// same module: if `localStorage` appears nowhere else, there is nowhere else for a key to
// be spelled. Asked of the source rather than of the bundle, because that is where the
// next rename pass will be run.

const STORAGE_MODULE = join('frontend', 'src', 'storage.ts');

const sourceFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(full);
  return /\.tsx?$/.test(entry.name) ? [full] : [];
});

console.log('1. every localStorage key is reachable from one map');

const frontendSrc = join(repoRoot, 'frontend', 'src');
const files = sourceFiles(frontendSrc);
check('the frontend has sources to read', files.length > 0, `${frontendSrc} is empty`);

const modulePath = join(repoRoot, STORAGE_MODULE);
check(`${STORAGE_MODULE} exists`, existsSync(modulePath), 'there is no single place for the keys to live');
const moduleText = existsSync(modulePath) ? readFileSync(modulePath, 'utf8') : '';

// A *reach into* the store rather than the word: every call site still says "…from
// localStorage" in the message it warns with, and prose is not a key nobody can enumerate.
const REACHES_IN = /localStorage\s*\??\s*\./;
const loose = files
  .filter((file) => relative(repoRoot, file) !== STORAGE_MODULE)
  .filter((file) => REACHES_IN.test(readFileSync(file, 'utf8')))
  .map((file) => relative(repoRoot, file));
check('no other module reaches into localStorage directly',
      loose.length === 0, `${loose.join(', ')} still does`);

// The map itself: eight settings, each a pair, and every quoted key inside this module.
const pairs = [...moduleText.matchAll(/current:\s*'([^']+)'\s*,\s*legacy:\s*'([^']+)'/g)]
  .map(([, current, legacy]) => ({ current, legacy }));
check('the map holds all eight settings', pairs.length === 8, `${pairs.length} pairs declared`);
check('and every key it declares is distinct',
      new Set(pairs.map((pair) => pair.current)).size === pairs.length
      && new Set(pairs.map((pair) => pair.legacy)).size === pairs.length,
      JSON.stringify(pairs));
check('the map is exported, so the set is enumerable from outside',
      /export\s+const\s+STORAGE_KEYS/.test(moduleText), 'STORAGE_KEYS is not exported');

const LEGACY_NAMES = [
  'excalidraw-canvas-theme',
  'excalidraw-canvas-chrome',
  'excalidraw-canvas-workspace',
  'excalidraw-terminal-font-size',
  'excalidraw-terminal-geometry',
  'excalidraw-documentation-shift',
  'excalidraw-board-viewports',
  'excalidraw.terminal.folds',
];
const missing = LEGACY_NAMES.filter((name) => !pairs.some((pair) => pair.legacy === name));
check('and it documents every name a profile out there is already using',
      missing.length === 0, `no legacy entry for ${missing.join(', ')}`);

const byLegacy = new Map(pairs.map((pair) => [pair.legacy, pair.current]));
const currentOf = (legacy) => byLegacy.get(legacy) ?? legacy;

// ─── The board the browser will be shown ──────────────────────

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

if (!existsSync(join(repoRoot, 'dist', 'frontend', 'index.html'))) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'check-storage-migration-'));
const firstDir = join(workDir, 'storage-a');
const secondDir = join(workDir, 'storage-b');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [firstDir, secondDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

// Two projects, and the seeded one is deliberately **not** the first in the registry: with no
// remembered board `resolveInitialWorkspace` opens `list[0]`, so a tab that reads `Storage B`
// can only have come from the key.
const FIRST = 'storage-a';
const SECOND = 'storage-b';
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: FIRST, path: firstDir.replace(/\\/g, '/') },
    { id: SECOND, path: secondDir.replace(/\\/g, '/') },
  ],
}), 'utf8');
// No githubProject on either: the mirror stays dormant, so nothing but this check's own
// shapes is drawn and no rect below is somebody else's card.
writeFileSync(join(firstDir, 'board.config.json'), JSON.stringify({
  name: 'Storage A', repo: 'vitorengers/vibemaxxing',
}), 'utf8');
writeFileSync(join(secondDir, 'board.config.json'), JSON.stringify({
  name: 'Storage B', repo: 'vitorengers/vibemaxxing',
}), 'utf8');

// A run with one tool call in it, so the transcript has a row that folds and the fold has an
// id a seeded key can name. `toolu_read_1` is the agent's own id, which is what the renderer
// marks the row with.
const FOLD_ID = 'toolu_read_1';
const EVENTS = [
  { type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'seeded', tools: ['Read'] },
  {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: FOLD_ID, name: 'Read', input: { file_path: 'FOLDED-FILE' } }] },
  },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: FOLD_ID, content: 'WHAT-CAME-BACK' }] } },
  { type: 'result', is_error: false, num_turns: 1 },
];
const stubPath = join(workDir, 'stub-agent.mjs');
writeFileSync(stubPath, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(`${EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`)});
setInterval(() => {}, 60000);
`, 'utf8');
const SESSION_COMMAND = `node "${stubPath.replace(/\\/g, '/')}" --output-format stream-json`;

// ─── What the old profile holds ───────────────────────────────
//
// Every value is one no default could produce: a theme against the emulated scheme, the
// second project rather than the first, a font size that is not `TERMINAL_FONT_SIZE`, a rect
// far off the origin, a camera at a zoom nothing fits to.

const SEEDED_THEME = 'dark';
const SEEDED_FONT = 19;
const SEEDED_RECT = { x: -500, y: 0, width: 1140, height: 720 };
const SEEDED_SHIFT = 760;
const SEEDED_VIEW = { scrollX: 123, scrollY: 456, zoom: 0.75 };

const legacySeed = {
  'excalidraw-canvas-theme': SEEDED_THEME,
  'excalidraw-canvas-chrome': 'hidden',
  'excalidraw-canvas-workspace': SECOND,
  'excalidraw-terminal-font-size': String(SEEDED_FONT),
  'excalidraw-terminal-geometry': JSON.stringify({ [SECOND]: SEEDED_RECT }),
  'excalidraw-documentation-shift': JSON.stringify({ [SECOND]: SEEDED_SHIFT }),
  'excalidraw-board-viewports': JSON.stringify({ [SECOND]: SEEDED_VIEW }),
};

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_TERMINAL: '1',
    // Pipes, so the stub's output is the transcript and nothing echoes a prompt into it.
    EXCALIDRAW_TERMINAL_PTY: '0',
  },
}).child;
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

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
  request(`${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${SECOND}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

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

/** Which colour scheme the machine is pretending to have. */
const emulateScheme = (value) => send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value }],
});

/** The imperative Excalidraw API, through the container's React fibre. See check-terminal-browser. */
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
        window.__storageCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** Both names of every setting that has one key, so a probe can compare the two sides. */
const WATCHED = [...Object.keys(legacySeed), ...Object.keys(legacySeed).map((name) => currentOf(name))];

/** Everything the eight settings can be read off the page as. */
const PROBE = `(() => {
  const root = document.querySelector('.app');
  const api = window.__storageCheckApi;
  const state = api ? api.getAppState() : null;
  const scene = api ? api.getSceneElements() : [];
  const block = scene.find((element) => ((element.customData || {}).kind) === 'terminal') || null;
  const card = document.querySelector('.terminal-card');
  const fold = document.querySelector('[data-fold=${JSON.stringify(FOLD_ID)}]');
  const hamburger = document.querySelector('.main-menu-trigger');
  const hamburgerBox = hamburger ? hamburger.getBoundingClientRect() : null;
  const read = (name) => { try { return window.localStorage.getItem(name); } catch { return null; } };
  return {
    theme: root ? root.getAttribute('data-theme') : null,
    chrome: root ? root.getAttribute('data-chrome') : null,
    hamburgerVisible: Boolean(hamburgerBox && hamburgerBox.width > 0 && hamburgerBox.height > 0),
    activeTab: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
    view: state ? { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value } : null,
    block: block ? { x: block.x, y: block.y, width: block.width, height: block.height } : null,
    cardFontSize: card ? parseFloat(getComputedStyle(card).fontSize) : null,
    foldPresent: Boolean(fold),
    foldOpen: Boolean(fold && fold.classList.contains('terminal-transcript__fold--open')),
    foldDetail: Boolean(document.querySelector('.terminal-transcript__detail-text')),
    stored: Object.fromEntries(${JSON.stringify(WATCHED)}.map((name) => [name, read(name)])),
  };
})()`;

const near = (a, b, slack = 1) => typeof a === 'number' && Math.abs(a - b) <= slack;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // The board's own content, standing where a board at rest with this terminal region stands:
  // one gap right of the region's right edge, which is `documentationClearance`'s answer and
  // therefore exactly `SEEDED_SHIFT` right of where it was authored.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: SEEDED_RECT.x + SEEDED_RECT.width + 120, y: 0,
      width: 240, height: 120, backgroundColor: '#e7f5ff', text: 'content',
    }),
  });

  const opened = await api('/api/terminal', { method: 'POST', body: JSON.stringify({ command: SESSION_COMMAND }) });
  if (opened.status !== 202) {
    throw new Error(`POST /api/terminal answered ${opened.status}: ${await opened.text()}`);
  }
  const session = (await opened.json()).session;
  console.log(`\nthe run is session ${session.id} on ${session.mode}, and its one tool call is ${FOLD_ID}`);

  // Seeded before the app's first script runs, and once: `addScriptToEvaluateOnNewDocument`
  // fires on **every** document, so a seed that cleared unconditionally would wipe the keys
  // the page had just written forward before anything could read them. The flag is what makes
  // it a one-time seed, and it is set on the same origin the app uses.
  const SEED = { ...legacySeed, [`excalidraw.terminal.folds:${session.id}`]: JSON.stringify([FOLD_ID]) };
  const seedSource = `try {
    if (!window.localStorage.getItem('__storage_check_seeded')) {
      window.localStorage.clear();
      const seed = ${JSON.stringify(SEED)};
      for (const name of Object.keys(seed)) window.localStorage.setItem(name, seed[name]);
      window.localStorage.setItem('__storage_check_seeded', '1');
    }
  } catch (error) { /* no storage */ }`;

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,950',
    'about:blank',
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  // Light, so the seeded `dark` cannot be what this machine would have chosen anyway.
  await emulateScheme('light');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: seedSource });
  // The plain address, with no `?workspace=`: the remembered board is the only thing that can
  // decide which tab opens, which is the case section 2 is about.
  await send('Page.navigate', { url: BASE });
  await sleep(500);

  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  // Waited for rather than required: a build that lost the remembered board opens the *other*
  // project, where there is no session and so no block to wait for. Failing that as a timeout
  // would collapse eight cases into one message about a shape, so the wait gives up quietly
  // and every setting below reports for itself.
  for (let attempt = 0; attempt < 80; attempt++) {
    const now = await evaluate(PROBE);
    if (now.block && now.foldPresent) break;
    await sleep(250);
  }
  await sleep(800);
  const settled = await evaluate(PROBE);
  await shot('01-restored-from-legacy-keys');

  console.log('\n2. a profile holding only the legacy keys restores all eight settings');
  check('the theme is the one that was stored, against a machine emulating light',
        settled.theme === SEEDED_THEME, `the board is ${settled.theme}`);
  check("Excalidraw's own menus are hidden, as the stored setting says",
        settled.chrome === 'hidden' && !settled.hamburgerVisible,
        `data-chrome=${settled.chrome} hamburger=${settled.hamburgerVisible}`);
  check('the board that opens is the remembered one rather than the first in the registry',
        settled.activeTab === 'Storage B', `the active tab is ${JSON.stringify(settled.activeTab)}`);
  check("the board's camera is where it was left",
        settled.view && near(settled.view.scrollX, SEEDED_VIEW.scrollX)
        && near(settled.view.scrollY, SEEDED_VIEW.scrollY)
        && near(settled.view.zoom, SEEDED_VIEW.zoom, 0.001),
        JSON.stringify(settled.view));
  check('the terminal block comes back at the rect it was dragged to',
        settled.block && near(settled.block.x, SEEDED_RECT.x) && near(settled.block.y, SEEDED_RECT.y)
        && near(settled.block.width, SEEDED_RECT.width) && near(settled.block.height, SEEDED_RECT.height),
        JSON.stringify(settled.block));
  // The card's size is the reader's font times the board's zoom, so this reads the two the
  // one way the page composes them — and would be wrong for either half being lost.
  check("the terminal's text is the size it was left at",
        near(settled.cardFontSize, SEEDED_FONT * SEEDED_VIEW.zoom, 0.6),
        `${settled.cardFontSize}px, expected ${SEEDED_FONT * SEEDED_VIEW.zoom}px`);
  check('the row the reader had opened in the transcript is open',
        settled.foldOpen && settled.foldDetail,
        `fold present=${settled.foldPresent} open=${settled.foldOpen} detail=${settled.foldDetail}`);
  check('and the documentation shift the board was pushed by is the stored one',
        settled.stored[currentOf('excalidraw-documentation-shift')]
        === legacySeed['excalidraw-documentation-shift'],
        `${JSON.stringify(settled.stored[currentOf('excalidraw-documentation-shift')])} `
        + `for ${JSON.stringify(legacySeed['excalidraw-documentation-shift'])}`);

  console.log('\n3. and the new keys hold the same values afterwards');
  for (const [legacy, value] of Object.entries(legacySeed)) {
    const current = currentOf(legacy);
    const held = settled.stored[current];
    // The camera is written back as the page runs, so it is the one that is compared as a
    // reading rather than as a string: `{"scrollX":123.0001}` is the same view.
    if (legacy === 'excalidraw-board-viewports') {
      let parsed = null;
      try { parsed = JSON.parse(held ?? 'null'); } catch { /* not JSON */ }
      const view = parsed?.[SECOND];
      check(`${current} carries the camera forward`,
            Boolean(view) && near(view.scrollX, SEEDED_VIEW.scrollX, 2)
            && near(view.scrollY, SEEDED_VIEW.scrollY, 2) && near(view.zoom, SEEDED_VIEW.zoom, 0.001),
            JSON.stringify(held));
      continue;
    }
    check(`${current} holds what ${legacy} held`, held === value,
          `${JSON.stringify(held)} for ${JSON.stringify(value)}`);
  }
  const foldLegacy = `excalidraw.terminal.folds:${session.id}`;
  const foldCurrent = `${currentOf('excalidraw.terminal.folds')}:${session.id}`;
  const folds = await evaluate(
    `(() => { try { return window.localStorage.getItem(${JSON.stringify(foldCurrent)}); } catch { return null; } })()`
  );
  check(`${foldCurrent} holds what ${foldLegacy} held`,
        folds === JSON.stringify([FOLD_ID]), JSON.stringify(folds));
  check('and the legacy keys are left alone, so an older build still finds them',
        settled.stored['excalidraw-canvas-theme'] === SEEDED_THEME,
        JSON.stringify(settled.stored['excalidraw-canvas-theme']));

  console.log('\n4. a profile with neither key falls back to the machine');
  for (const scheme of ['dark', 'light']) {
    // Only the app's own keys go: the seed flag stays, or the script above would put the
    // whole legacy profile back on the next navigation and this would test nothing.
    await evaluate(`(() => {
      const names = ${JSON.stringify([...LEGACY_NAMES, ...pairs.map((pair) => pair.current)])};
      for (const name of names) {
        try { window.localStorage.removeItem(name) } catch { /* no storage */ }
      }
      return true;
    })()`);
    await emulateScheme(scheme);
    await send('Page.navigate', { url: BASE });
    await sleep(1200);
    await waitFor(() => evaluate(GRAB_API), `the Excalidraw API handle on the ${scheme} load`);
    const bare = await waitFor(async () => {
      const now = await evaluate(PROBE);
      return now.theme ? now : null;
    }, `the board to settle on the ${scheme} load`);
    await shot(`02-no-keys-${scheme}`);
    check(`with no key of either name the board follows prefers-color-scheme: ${scheme}`,
          bare.theme === scheme, `the board is ${bare.theme}`);
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
