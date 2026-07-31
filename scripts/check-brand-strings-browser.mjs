#!/usr/bin/env node
/**
 * Checks, in a real browser, that the first strings a reader sees name this product.
 *
 * Two of them, and both named the substrate rather than the tool. `<title>` was
 * `Excalidraw POC - Backend API Integration`, three years stale and describing a proof of
 * concept that shipped; the bar above the canvas opened with a constant `Excalidraw Canvas`
 * that said the same four words on every board of every project. #261 removed the second one
 * on its own merits — the tabs beside it already say which board this is, and a constant title
 * next to the variable one is the least informative use of a row that has to hold both — and
 * its comment recorded where the name went: *"The document still has its name in `<title>`,
 * where a browser tab reads it."* Which made the stale title the only place left, and left it
 * naming Excalidraw.
 *
 * So the name is asked about where it now lives, and in the two forms it has to take:
 *
 *   1. **the served document already says it**, before a single line of the bundle runs — a
 *      tab that is still loading, or a page opened with scripting off, reads `<title>` out of
 *      the HTML, and that string is `board.config.json`'s `name`. Nothing in the frontend can
 *      be the authority for that, so this is where the copy in `frontend/index.html` and the
 *      one in `board.config.json` are held together, the same way `check-readme.mjs` holds the
 *      README to it;
 *   2. **and the running page names the board**, not just the tool. Three projects are
 *      registered here for the same reason `check-merged-bar-browser.mjs` registers three:
 *      with one board the two answers are indistinguishable. The title has to name the active
 *      project *and follow a tab switch*, which is the half a static string would pass.
 *
 * Then the two things the rename must not have cost:
 *
 *   3. **the empty-registry fallback.** A board with no registry has no project to be named
 *      after, and a title bound to one would render blank or `undefined —`. A second server
 *      with no `EXCALIDRAW_WORKSPACES` at all is what answers that, because it is the only way
 *      to get the state the fallback is for;
 *   4. **`window.EXCALIDRAW_ASSET_PATH`.** It is Excalidraw's own API, it is spelled with the
 *      word this change is removing everywhere else, and renaming it would take the canvas
 *      font offline — `check-canvas-fonts-browser.mjs` is where that is measured properly, and
 *      this is the guard that says the brand pass did not walk into it. Every `woff2` the page
 *      fetched has to have come from the board's own `/assets/`, and none from a CDN.
 *
 * Case 2 checks the constant title has not come back too. Reintroducing an `h1` would satisfy
 * the letter of "the header names the product" and undo #261, so the two live in one file:
 * the bar stays titleless, and the browser tab is what carries the name.
 *
 * Self-contained: two throwaway servers on ports the kernel handed out, its own registry and
 * project directories, its own Chrome profile, all killed at the end. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend, so proving it red against the old code needs the old code *built*.
 *
 * Usage: node scripts/check-brand-strings-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome({ what: 'no rendered string was read.' });

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
const slash = (value) => String(value).replace(/\\/g, '/');

/**
 * The product's name, from the one file that owns it.
 *
 * Read rather than written out, so this check cannot drift from `board.config.json` the way
 * the title it is about drifted from the product. Renaming the tool is then one edit plus
 * whatever this goes red on.
 */
const config = JSON.parse(readFileSync(join(repoRoot, 'board.config.json'), 'utf8'));
const PRODUCT = String(config.name);

/** What the old title said, in the two halves worth naming separately. */
const STALE = [/\bPOC\b/i, /Backend API Integration/i];

// ─── Three projects, none of them named after the product ─────
//
// Deliberately: a project called VibeMaxxing would make "the title names the board" and "the
// title names the tool" the same assertion, which is the confusion this whole item is about.

const workDir = mkdtempSync(join(tmpdir(), 'check-brand-strings-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const PROJECTS = [
  { id: 'field-notes', name: 'Field Notes' },
  { id: 'harvest-planner', name: 'Harvest Planner' },
  { id: 'tide-tables', name: 'Tide Tables' },
];

const registry = { workspaces: [] };
for (const project of PROJECTS) {
  const dir = join(workDir, 'projects', project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'),
                JSON.stringify({ name: project.name }, null, 2), 'utf8');
  registry.workspaces.push({ id: project.id, path: slash(dir) });
}
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

const CDP_PORT = await freePort();
const children = [];

/**
 * The board with a registry, and the board without one.
 *
 * Two servers rather than one restarted, because the second is only interesting while it has
 * never had a registry: `EXCALIDRAW_WORKSPACES` unset is the state a single-board install runs
 * in, and it is the state the fallback exists for.
 */
const registered = startCanvas({
  port: await freePort(),
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    // The board's own shell exports this, and a terminal block is a DOM overlay over the
    // mirror that swallows presses aimed at the bar. Nothing here needs a terminal.
    EXCALIDRAW_TERMINAL: '',
  },
});
const solo = startCanvas({
  port: await freePort(),
  env: { LOG_LEVEL: 'error', EXCALIDRAW_WORKSPACES: undefined, EXCALIDRAW_TERMINAL: '' },
});
children.push(registered.child, solo.child);

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${registered.read()}\n${solo.read()}`);
}

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

/** Load a board and wait until its own scene is up, so nothing is read off a blank page. */
async function open(base) {
  await send('Page.navigate', { url: base });
  await waitFor(async () => evaluate(`Boolean(document.querySelector('.excalidraw'))`),
                `the canvas at ${base}`);
  await sleep(600);
}

/** What the bar and the tab say, taken off the page rather than off the props. */
const PROBE = `(() => {
  const text = (node) => (node ? (node.textContent || '').trim() : null);
  return {
    title: document.title,
    headings: Array.from(document.querySelectorAll('.header h1')).map((node) => text(node)),
    // innerText rather than textContent, because the question is what a reader sees: the
    // second one also returns whatever the row is currently hiding.
    headerText: (() => {
      const header = document.querySelector('.header');
      return header ? (header.innerText || '').replace(/\\s+/g, ' ').trim() : null;
    })(),
    activeTab: text(document.querySelector('.workspace-tab--active .workspace-tab__name')),
    tabs: Array.from(document.querySelectorAll('.workspace-tab__name')).map((node) => text(node)),
    assetPath: window.EXCALIDRAW_ASSET_PATH ?? null,
    fonts: performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /\\.woff2?(\\?|$)/i.test(name)),
    origin: location.origin,
  };
})()`;

/** Press the tab whose name is given, through the button the reader would press. */
const clickTab = (name) => `(() => {
  const tab = Array.from(document.querySelectorAll('.workspace-tab__select'))
    .find((node) => (node.textContent || '').trim().includes(${JSON.stringify(name)}));
  if (!tab) return false;
  tab.click();
  return true;
})()`;

try {
  await waitFor(async () => (await fetch(`${registered.base}/health`)).ok, 'the board with a registry');
  await waitFor(async () => (await fetch(`${solo.base}/health`)).ok, 'the board with no registry');

  console.log(`1. the served document already names ${JSON.stringify(PRODUCT)}`);
  {
    // The HTML as it comes off the wire: no bundle has run, which is what a loading tab and a
    // page with scripting off both see.
    const html = await (await fetch(`${registered.base}/`)).text();
    const served = (html.match(/<title>([^<]*)<\/title>/i) ?? [])[1] ?? null;
    check('the document has a title at all', typeof served === 'string' && served.trim().length > 0,
          JSON.stringify(served));
    check(`and it is the name in board.config.json`, (served ?? '').includes(PRODUCT),
          JSON.stringify(served));
    for (const pattern of STALE) {
      check(`nothing in it still matches ${pattern}`, !pattern.test(served ?? ''),
            JSON.stringify(served));
    }
  }

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

  console.log('\n2. and the running page names the board the reader is looking at');
  await open(registered.base);
  const seen = await waitFor(async () => {
    const state = await evaluate(PROBE);
    return state.tabs.length === PROJECTS.length ? state : null;
  }, 'the bar with every project on it');
  await shot('01-first-board');

  console.log(`      (title ${JSON.stringify(seen.title)}, tab ${JSON.stringify(seen.activeTab)})`);
  check('the rendered title still carries the product name',
        seen.title.includes(PRODUCT), JSON.stringify(seen.title));
  for (const pattern of STALE) {
    check(`the rendered title does not match ${pattern}`, !pattern.test(seen.title),
          JSON.stringify(seen.title));
  }
  check('a project is in front', typeof seen.activeTab === 'string' && seen.activeTab.length > 0,
        JSON.stringify(seen.tabs));
  check('and the title names it',
        Boolean(seen.activeTab) && seen.title.includes(seen.activeTab),
        `${JSON.stringify(seen.title)} does not carry ${JSON.stringify(seen.activeTab)}`);
  check('the title names no other project on the strip',
        seen.tabs.filter((name) => name !== seen.activeTab)
          .every((name) => !seen.title.includes(name)),
        JSON.stringify(seen.title));

  // The half a constant string would pass. A switch is the only thing that tells "the title
  // names the board" apart from "the title happens to contain a word that is also on a tab".
  const other = PROJECTS.map((project) => project.name).find((name) => name !== seen.activeTab);
  check(`pressing the ${JSON.stringify(other)} tab is a press that lands`,
        await evaluate(clickTab(other)) === true, 'no such tab on the strip');
  const switched = await waitFor(async () => {
    const state = await evaluate(PROBE);
    return state.activeTab === other ? state : null;
  }, `the ${other} board in front`);
  await sleep(400);
  const after = await evaluate(PROBE);
  await shot('02-after-switch');
  check('the title followed the switch', after.title.includes(other),
        `${JSON.stringify(seen.title)} → ${JSON.stringify(after.title)}`);
  check('and stopped naming the board that was in front before',
        Boolean(switched.activeTab) && !after.title.includes(seen.activeTab),
        JSON.stringify(after.title));
  check('it still carries the product name after the switch',
        after.title.includes(PRODUCT), JSON.stringify(after.title));

  // #261 removed the constant title from the bar and this is where it stays removed: an `h1`
  // saying the product name would pass "the header names the product" and be the row #261
  // took apart. `check-merged-bar-browser.mjs` counts it too, from the layout's side.
  check('the constant title has not come back to the bar',
        after.headings.length === 0, JSON.stringify(after.headings));

  // The done-when asks for the *rendered* header, and counting `h1` at zero only says what is
  // not there. These two say what is: the row names the board in front of it, and the word this
  // item is about appears nowhere on it. Read positively, because "no `h1`" is also satisfied by
  // a bar that names nothing at all.
  console.log(`      (the row reads ${JSON.stringify(after.headerText)})`);
  check('the bar names the project being looked at',
        (after.headerText ?? '').includes(other), JSON.stringify(after.headerText));
  check('and nothing on it names the substrate', !/excalidraw/i.test(after.headerText ?? ''),
        JSON.stringify(after.headerText));

  console.log('\n3. a board with no registry still has a name in its tab');
  await open(solo.base);
  const alone = await waitFor(async () => {
    const state = await evaluate(PROBE);
    return state.title ? state : null;
  }, 'the board with no registry');
  await shot('03-no-registry');
  console.log(`      (title ${JSON.stringify(alone.title)})`);
  check('it has no tab strip to be named after', alone.tabs.length === 0,
        JSON.stringify(alone.tabs));
  check('so the title falls back to the product alone', alone.title === PRODUCT,
        JSON.stringify(alone.title));
  check('rather than to a blank tab or to the word undefined',
        alone.title.trim().length > 0 && !/undefined|null/i.test(alone.title),
        JSON.stringify(alone.title));

  console.log('\n4. and Excalidraw\'s own asset path is untouched');
  await open(registered.base);
  await waitFor(async () => (await evaluate(PROBE)).tabs.length === PROJECTS.length,
                'the registered board again');
  // Ask for the canvas font by name, so the fetch this reads is one this check caused rather
  // than one it hoped a repaint would happen to trigger.
  await evaluate(`document.fonts.load('20px Excalifont', 'brand').then(() => true)`);
  const fonts = await waitFor(async () => {
    const state = await evaluate(PROBE);
    return state.fonts.length ? state : null;
  }, 'the canvas font to be fetched');
  check("window.EXCALIDRAW_ASSET_PATH is still '/assets/'", fonts.assetPath === '/assets/',
        JSON.stringify(fonts.assetPath));
  check('the canvas font really was fetched', fonts.fonts.length > 0, JSON.stringify(fonts.fonts));
  check('every font came from this board rather than a CDN',
        fonts.fonts.every((url) => url.startsWith(`${fonts.origin}/assets/`)),
        JSON.stringify(fonts.fonts.filter((url) => !url.startsWith(`${fonts.origin}/assets/`))));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(300);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
