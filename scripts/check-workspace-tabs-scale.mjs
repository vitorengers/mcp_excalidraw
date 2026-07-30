#!/usr/bin/env node
/**
 * Measures the size of the project tab strip in a real browser.
 *
 * The strip is the board's top-level navigation and it was the smallest text on the screen:
 * a 13px label inside 6px/12px padding, set smaller than the header it sits under and
 * smaller than the documentation it navigates between. #110 asks for 2.5x — and asks for it
 * as a *strip*, not as a font size, because a 32.5px name inside 6px padding is a bug of its
 * own.
 *
 * A stylesheet is exactly the layer `CLAUDE.md` says compiles perfectly and does nothing:
 * `font-size: calc(13px * var(--workspace-tab-scale))` is valid CSS that renders at 13px if
 * the property never reaches the element. So every number here is read back out of the
 * browser — `getComputedStyle` for the type scale and the padding, `getBoundingClientRect`
 * for the hit area — rather than out of the file.
 *
 * Four questions, and only a browser answers any of them:
 *
 *   - is the label 2.5x its old size, and are the strip padding, the button padding, the
 *     badge, the gear and the `+` on the same factor, so the tabs grow as targets?
 *   - is there one lever? Forcing `--workspace-tab-scale: 1` on the strip must put the whole
 *     of it back to its old height, or the multiplier is spread across declarations again
 *     and the next tuning pass is another hunt;
 *   - does the strip still scroll rather than wrap when the projects do not fit, which is
 *     what keeps a fourth project reachable — asked at a narrow viewport, since wider tabs
 *     reach that point with fewer projects;
 *   - and does Excalidraw re-measure? The anchored overlays map scene coordinates through
 *     `appState.offsetTop`, the strip only renders once `GET /api/workspaces` resolves, and
 *     a strip that grows after the canvas has mounted moves the canvas's top edge. If that
 *     offset goes stale the documentation card and the terminal land off by the strip's
 *     height — a ~34px error at the old size and a ~85px one at this size.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: throwaway registry and project directories, its own canvas
 * server, both killed at the end. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-workspace-tabs-scale.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome({ what: 'nothing was measured.' });

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

/**
 * What the strip used to be, declaration by declaration, and the factor #110 asks for.
 *
 * These are the numbers the issue names, not numbers read back from the new stylesheet —
 * the expectation has to come from the request, or the check describes whatever the fix
 * happened to do.
 */
const SCALE = 2.5;
const BASE = {
  'the project name': { selector: '.workspace-tab__select', property: 'font-size', was: 13 },
  'the name it is a button around': { selector: '.workspace-tab__select', property: 'padding-top', was: 6 },
  'and the width of that target': { selector: '.workspace-tab__select', property: 'padding-left', was: 12 },
  'the strip it sits on': { selector: '.workspace-tabs', property: 'padding-top', was: 6 },
  'and the strip on its sides': { selector: '.workspace-tabs', property: 'padding-left', was: 8 },
  'the WSL badge': { selector: '.workspace-tab__badge', property: 'font-size', was: 9 },
  'the gear': { selector: '.workspace-tab__config', property: 'font-size', was: 12 },
  'the +': { selector: '.workspace-tabs__add', property: 'font-size', was: 18 },
  'the padding that centres the +': { selector: '.workspace-tabs__add', property: 'padding-left', was: 9 },
};

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Three projects, so the strip has something to be wide with ──

const workDir = mkdtempSync(join(tmpdir(), 'check-workspace-tabs-scale-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const PROJECTS = [
  { id: 'board-tool', name: 'Board Tool' },
  { id: 'field-notes', name: 'Field Notes' },
  { id: 'harvest-planner', name: 'Harvest Planner' },
];

const registry = { workspaces: [] };
for (const project of PROJECTS) {
  const dir = join(workDir, 'projects', project.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: project.name }), 'utf8');
  registry.workspaces.push({ id: project.id, path: dir.replace(/\\/g, '/') });
}
// A WSL-backed project, last so it never becomes the active board, purely so the `WSL`
// badge is on screen to be measured. It is the one size on the strip that no ordinary
// project renders, and a badge that stayed at 9px beside a 32.5px name is exactly the
// lopsided strip #110 asks not to end up with.
registry.workspaces.push({ id: 'wsl-project', path: '//wsl.localhost/Ubuntu/home/board/wsl-project' });
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify(registry, null, 2), 'utf8');

const PORT = 36800 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
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

/** One number, out of the browser's own box model rather than out of the stylesheet. */
const computed = (selector, property) => evaluate(`(() => {
  const node = document.querySelector(${JSON.stringify(selector)});
  if (!node) return null;
  return getComputedStyle(node).getPropertyValue(${JSON.stringify(property)});
})()`);

/** The whole strip as it is laid out: what is on it, how tall, and whether it is one row. */
const stripBox = () => evaluate(`(() => {
  const bar = document.querySelector('.workspace-tabs');
  if (!bar) return null;
  const tabs = [...document.querySelectorAll('.workspace-tab')].map((tab) => {
    const box = tab.getBoundingClientRect();
    return { top: box.top, height: box.height, width: box.width };
  });
  const box = bar.getBoundingClientRect();
  return {
    top: box.top, bottom: box.bottom, height: box.height,
    scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth,
    overflowX: getComputedStyle(bar).overflowX,
    tabs,
  };
})()`);

/**
 * The imperative API, through the container's React fibre — the only honest reader of the
 * offset the anchored overlays are drawn through. Borrowed from
 * `check-mirror-anchor-browser.mjs`, which reaches it the same way.
 */
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
        window.__tabScaleApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const near = (a, b, slack = 0.05) => a !== null && b !== null && Math.abs(a - b) <= slack;
const px = (value) => (value === null ? null : Number.parseFloat(value));

try {
  await waitFor(async () => (await fetch(`${BASE_URL}/health`)).ok, 'the canvas server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    BASE_URL,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');

  await waitFor(async () => {
    const box = await stripBox();
    return box && box.tabs.length === PROJECTS.length + 1 ? box : null;
  }, 'the strip with every project on it');
  check('the WSL project is on the strip, so its badge can be measured',
        await evaluate(`Boolean(document.querySelector('.workspace-tab__badge'))`));
  await shot('01-strip');

  console.log(`1. every size on the strip is ${SCALE}x what it was`);
  for (const [name, spec] of Object.entries(BASE)) {
    const want = spec.was * SCALE;
    const got = px(await computed(spec.selector, spec.property));
    check(`${name} — ${spec.property} ${spec.was}px → ${want}px`, near(got, want),
          `it is ${got}px (${spec.selector})`);
  }

  console.log('\n2. the tab grew as a target, not only as text');
  const scaled = await stripBox();
  // Put the strip back to 1x through the property the sizes are meant to derive from. If
  // the whole strip does not return to its old height, the multiplier is not in one place.
  await evaluate(`document.querySelector('.workspace-tabs').style.setProperty('--workspace-tab-scale', '1')`);
  await sleep(150);
  const unscaled = await stripBox();
  await shot('02-forced-to-1x');
  await evaluate(`document.querySelector('.workspace-tabs').style.removeProperty('--workspace-tab-scale')`);
  await sleep(150);

  const heightRatio = unscaled.tabs[0].height ? scaled.tabs[0].height / unscaled.tabs[0].height : 0;
  const widthRatio = unscaled.tabs[0].width ? scaled.tabs[0].width / unscaled.tabs[0].width : 0;
  check(`the tab is about ${SCALE}x as tall`, Math.abs(heightRatio - SCALE) <= 0.15,
        `${unscaled.tabs[0].height}px → ${scaled.tabs[0].height}px, a factor of ${heightRatio.toFixed(2)}`);
  check(`and about ${SCALE}x as wide`, Math.abs(widthRatio - SCALE) <= 0.15,
        `${unscaled.tabs[0].width}px → ${scaled.tabs[0].width}px, a factor of ${widthRatio.toFixed(2)}`);
  check('one property is the whole lever', unscaled.height < scaled.height,
        `forcing --workspace-tab-scale: 1 left the strip at ${unscaled.height}px of ${scaled.height}px, `
        + 'so the sizes are not all derived from it');

  console.log('\n3. it still scrolls rather than wraps when the projects do not fit');
  await send('Emulation.setDeviceMetricsOverride',
             { width: 620, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const narrow = await stripBox();
  await shot('03-narrow');
  check('the strip overflows horizontally', narrow.scrollWidth > narrow.clientWidth,
        `${narrow.scrollWidth}px of content in ${narrow.clientWidth}px`);
  check('and reaches it by scrolling', narrow.overflowX === 'auto', narrow.overflowX);
  const tops = narrow.tabs.map((tab) => Math.round(tab.top));
  check('nothing wrapped onto a second row', new Set(tops).size === 1, JSON.stringify(tops));
  check('so the strip is no taller than one row',
        Math.abs(narrow.height - scaled.height) <= 1,
        `${scaled.height}px wide, ${narrow.height}px narrow`);
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(300);

  console.log('\n4. the canvas re-measured under the taller strip, so the anchors still land');
  check('the scene API is reachable', await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API'));
  const anchor = await evaluate(`(() => {
    const state = window.__tabScaleApi.getAppState();
    const host = document.querySelector('.excalidraw');
    const bar = document.querySelector('.workspace-tabs');
    return {
      offsetTop: state.offsetTop,
      canvasTop: host ? host.getBoundingClientRect().top : null,
      stripBottom: bar ? bar.getBoundingClientRect().bottom : null,
    };
  })()`);
  await shot('04-anchored');
  check('the offset the overlays are drawn through is the canvas\'s real top edge',
        near(anchor.offsetTop, anchor.canvasTop, 1),
        `appState.offsetTop is ${anchor.offsetTop}, the canvas starts at ${anchor.canvasTop} — `
        + 'an overlay would land off by the difference');
  check('and the canvas starts below the strip, which therefore took its own height',
        anchor.canvasTop >= anchor.stripBottom - 1,
        `strip ends at ${anchor.stripBottom}, canvas starts at ${anchor.canvasTop}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
