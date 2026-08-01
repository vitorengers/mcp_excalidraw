#!/usr/bin/env node
/**
 * Checks the header control that hides Excalidraw's own menus, in a real browser.
 *
 * Three menus were named: the hamburger at the top left, the properties island that
 * appears beside a selected shape, and the toolbar across the top. All three live inside
 * `<Excalidraw>`, and Excalidraw offers no prop that removes them — `UIOptions` only edits
 * the *contents* of the hamburger, `zenModeEnabled` moves one of the three off screen and
 * leaves the other two, and `viewModeEnabled` hides two but turns a main-button press into
 * a pan. So what is under test is CSS over Excalidraw's own class names, driven by an
 * attribute on the app root, and the only place that can be answered is a browser: it is
 * the cascade and the rendered box that decide, and neither `tsc` nor `vite build` runs
 * either.
 *
 * The three are read by the class names Excalidraw gives them in 0.18:
 *
 *   `.main-menu-trigger`  the hamburger        (`dist/dev/index.js:17559`)
 *   `.App-menu__left`     the properties island (`dist/dev/chunk-3KPV5WBD.js:181`)
 *   `.shapes-section`     the toolbar          (`dist/dev/index.js:21182`)
 *
 * They are read as *rendered boxes*, not as declarations: an element with no width and no
 * height is not on screen whichever rule put it there, which is the only claim the reader
 * made. An upstream rename would fail this check loudly, which is the right way round —
 * the rule it guards is written against those same names.
 *
 * The case that separates this from `viewModeEnabled` is section 3. With the chrome hidden,
 * a real mouse press on a documented block still has to select it and open the
 * documentation panel. Under view mode that press pans the canvas instead, nothing is
 * selected, and this board's panel — which opens off `selectedElementIds` — never appears.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway registry with two projects,
 * starts its own canvas server on a free port and kills both. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-chrome-toggle-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// ─── Two projects, one of them documented ─────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-chrome-toggle-'));
const projectDir = join(workDir, 'chrome-a');
const otherDir = join(workDir, 'chrome-b');
const docsDir = join(projectDir, 'docs');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, otherDir, docsDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const WORKSPACE = 'chrome-a';
const OTHER = 'chrome-b';
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: WORKSPACE, path: projectDir.replace(/\\/g, '/') },
    { id: OTHER, path: otherDir.replace(/\\/g, '/') },
  ],
}), 'utf8');

// No githubProject on either: the mirror stays dormant, so nothing but this check's own
// block is drawn on the board and no coordinate below can land on somebody else's card.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Chrome A', repo: 'vitorengers/vibemaxxing', docsDir: 'docs',
}), 'utf8');
writeFileSync(join(otherDir, 'board.config.json'), JSON.stringify({
  name: 'Chrome B', repo: 'vitorengers/vibemaxxing',
}), 'utf8');

const DOC_KEY = 'chrome-sample';
writeFileSync(join(docsDir, `${DOC_KEY}.md`), [
  '# Chrome sample',
  '',
  'A document behind a block, so that selecting the block has something visible to do.',
  '',
].join('\n'), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
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

const api = (path, options = {}) => fetch(
  `${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`,
  { headers: { 'Content-Type': 'application/json' }, ...options },
);

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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
}

async function pressKey(code, key, windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, text: key, unmodifiedText: key, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode });
  await sleep(250);
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
        window.__chromeCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * What is on screen, as boxes.
 *
 * `display: none`, `visibility: hidden` and never-rendered all read the same here, and
 * deliberately: the reader asked for the menus to be gone, not for one particular way of
 * making them gone. A box with no area is gone.
 *
 * The toggle is found by what it says rather than by a class this check invented, so it
 * has to be a control a reader could find in the header for the same reason.
 */
const PROBE = `(() => {
  const box = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return { present: false, visible: false };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const visible = rect.width > 0 && rect.height > 0
      && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    return {
      present: true, visible,
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
      display: style.display,
    };
  };
  const root = document.querySelector('.app');
  const header = document.querySelector('.header');
  const toggleNode = header
    ? Array.from(header.querySelectorAll('button')).find((b) => /menus/i.test(b.textContent || ''))
    : null;
  let toggle = { present: false, visible: false };
  if (toggleNode) {
    const rect = toggleNode.getBoundingClientRect();
    const style = getComputedStyle(toggleNode);
    toggle = {
      present: true,
      visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      // On screen, not merely in the document: a control scrolled or pushed out of the
      // window is no more reachable than one that was never drawn.
      onScreen: rect.top >= 0 && rect.left >= 0
        && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth,
      inControls: Boolean(toggleNode.closest('.controls')),
      label: (toggleNode.textContent || '').trim(),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
    };
  }
  const api = window.__chromeCheckApi;
  const state = api ? api.getAppState() : null;
  return {
    toggle,
    hamburger: box('.main-menu-trigger'),
    island: box('.App-menu__left'),
    toolbar: box('.shapes-section'),
    // Not one of the three, and that is the point: it was not named, it is how blocks
    // reach a board, and it shares a three-column grid with the two that do go.
    library: box('.default-sidebar-trigger'),
    canvasWidth: (document.querySelector('.excalidraw') || { clientWidth: 0 }).clientWidth,
    attr: root ? (root.dataset.chrome || null) : null,
    stored: (() => { try { return window.localStorage.getItem('vibemaxxing-canvas-chrome'); } catch { return null; } })(),
    docsCard: Boolean(document.querySelector('.docs-card')),
    activeTab: (document.querySelector('.workspace-tab--active .workspace-tab__name') || {}).textContent || null,
    selected: state ? Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]) : [],
    view: state ? {
      scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
      offsetLeft: state.offsetLeft, offsetTop: state.offsetTop,
      viewMode: Boolean(state.viewModeEnabled), zenMode: Boolean(state.zenModeEnabled),
      tool: state.activeTool ? state.activeTool.type : null,
    } : null,
  };
})()`;

const BLOCK = `(() => {
  const api = window.__chromeCheckApi;
  if (!api) return null;
  const found = api.getSceneElements().find((element) => (element.customData || {}).docKey === '${DOC_KEY}');
  return found ? { id: found.id, x: found.x, y: found.y, w: found.width, h: found.height } : null;
})()`;

/** Press the toggle the way a reader does, and let React settle. */
const PRESS_TOGGLE = `(() => {
  const header = document.querySelector('.header');
  const button = header
    ? Array.from(header.querySelectorAll('button')).find((b) => /menus/i.test(b.textContent || ''))
    : null;
  if (!button) return false;
  button.click();
  return true;
})()`;

const CLEAR_SELECTION = `(() => {
  window.__chromeCheckApi.updateScene({ appState: { selectedElementIds: {} } });
  return true;
})()`;

const select = (id) => `(() => {
  window.__chromeCheckApi.updateScene({ appState: { selectedElementIds: { '${id}': true } } });
  return true;
})()`;

const toViewport = (view, x, y) => ({
  x: (x + view.scrollX) * view.zoom + view.offsetLeft,
  y: (y + view.scrollY) * view.zoom + view.offsetTop,
});

/** All three named menus, in one line, for a failure message worth reading. */
const describe = (seen) => `hamburger=${JSON.stringify(seen.hamburger)} `
  + `island=${JSON.stringify(seen.island)} toolbar=${JSON.stringify(seen.toolbar)}`;

async function press() {
  const pressed = await evaluate(PRESS_TOGGLE);
  if (!pressed) throw new Error('no control in the header says anything about menus');
  await sleep(400);
  return evaluate(PROBE);
}

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // Well clear of both islands and of the toolbar, so a press on it is a press on it: the
  // properties island covers the left ~210px of the canvas and the toolbar its top ~110px,
  // and this check has to click the block while the chrome is *shown* as well as hidden.
  await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 520, y: 260, width: 300, height: 160,
      backgroundColor: '#e7f5ff', text: 'documented', customData: { docKey: DOC_KEY },
    }),
  });

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  const block = await waitFor(() => evaluate(BLOCK), 'the documented block to reach the canvas');

  console.log('\n1. by default the menus are there, and so is a control for them');
  await evaluate(select(block.id));
  await sleep(700);
  let seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.island.present ? now : null;
  }, 'the properties island to appear beside the selected block');
  await shot('01-shown');

  check('there is a button in the header controls that names the menus',
        seen.toggle.present && seen.toggle.visible && seen.toggle.inControls,
        JSON.stringify(seen.toggle));
  check('the hamburger, the properties island and the toolbar are all on screen',
        seen.hamburger.visible && seen.island.visible && seen.toolbar.visible, describe(seen));
  check('and the documentation panel is open on the selected block', seen.docsCard,
        `selected=${JSON.stringify(seen.selected)}`);
  check('the library trigger is on the right-hand side of the board',
        seen.library.visible && seen.library.x > seen.canvasWidth / 2,
        `${JSON.stringify(seen.library)} of ${seen.canvasWidth}`);
  const libraryWhenShown = seen.library;

  console.log('\n2. pressing it hides all three, twice in a row');
  for (let round = 1; round <= 2; round++) {
    seen = await press();
    await shot(`02-hidden-${round}`);
    check(`round ${round}: the hamburger is gone`, !seen.hamburger.visible, JSON.stringify(seen.hamburger));
    check(`round ${round}: the properties island is gone`, !seen.island.visible, JSON.stringify(seen.island));
    check(`round ${round}: the toolbar is gone`, !seen.toolbar.visible, JSON.stringify(seen.toolbar));
    check(`round ${round}: the button that hid them is still on screen`,
          seen.toggle.visible && seen.toggle.onScreen, JSON.stringify(seen.toggle));
    // Not view mode, and not zen mode: those were considered and rejected, and either one
    // would pass the three cases above while failing section 3.
    check(`round ${round}: the board is not in Excalidraw's view or zen mode`,
          seen.view && !seen.view.viewMode && !seen.view.zenMode, JSON.stringify(seen.view));
    // The chrome that was not named has to be left where it was, not merely left rendered:
    // the three share a grid with it, and taking two columns out of the flow slid this one
    // across the board to the far left, under the project tabs.
    check(`round ${round}: the library trigger has not moved`,
          seen.library.visible && Math.abs(seen.library.x - libraryWhenShown.x) <= 2,
          `${JSON.stringify(libraryWhenShown)} → ${JSON.stringify(seen.library)}`);

    if (round === 1) {
      // Section 3 runs inside the first hidden round, because that is the state it is about.
      console.log('\n3. a block can still be selected while they are hidden');
      await evaluate(CLEAR_SELECTION);
      await sleep(600);
      let cleared = await evaluate(PROBE);
      check('with nothing selected the documentation panel is closed',
            !cleared.docsCard && cleared.selected.length === 0,
            `docsCard=${cleared.docsCard} selected=${JSON.stringify(cleared.selected)}`);

      const centre = toViewport(cleared.view, block.x + block.w / 2, block.y + block.h / 2);
      await click(centre.x, centre.y);
      await sleep(900);
      const clicked = await evaluate(PROBE);
      await shot('03-clicked-while-hidden');
      check('a press on the documented block selects it',
            clicked.selected.includes(block.id),
            `pressed (${Math.round(centre.x)}, ${Math.round(centre.y)}), `
            + `selected=${JSON.stringify(clicked.selected)}`);
      check('and the documentation panel opens on it', clicked.docsCard,
            `selected=${JSON.stringify(clicked.selected)}`);
      check('while the menus are still hidden',
            !clicked.hamburger.visible && !clicked.island.visible && !clicked.toolbar.visible,
            describe(clicked));
      // The scene did not move under the press either — a pan would have carried it away.
      check('and the board did not pan under the press',
            Math.abs(clicked.view.scrollX - cleared.view.scrollX) < 1
            && Math.abs(clicked.view.scrollY - cleared.view.scrollY) < 1,
            `${JSON.stringify(cleared.view)} → ${JSON.stringify(clicked.view)}`);

      // The toolbar is where a reader picks a tool, and it is gone. `docs/canvas-frontend.md`
      // says the shortcuts still reach them, so that is asked rather than asserted:
      // Excalidraw binds them on its container, not on the buttons.
      check('the board is on the selection tool to begin with',
            clicked.view.tool === 'selection', JSON.stringify(clicked.view.tool));
      await pressKey('KeyR', 'r', 82);
      const drawing = await evaluate(PROBE);
      check('a tool can still be picked by its keyboard shortcut',
            drawing.view.tool === 'rectangle', JSON.stringify(drawing.view.tool));
      // Back to selection, or the next press on the board would draw rather than select.
      await pressKey('KeyV', 'v', 86);
      const back = await evaluate(PROBE);
      check('and the selection tool comes back the same way',
            back.view.tool === 'selection', JSON.stringify(back.view.tool));
      await evaluate(select(block.id));
      await sleep(400);
    }

    seen = await press();
    await shot(`04-shown-again-${round}`);
    check(`round ${round}: pressing it again brings all three back`,
          seen.hamburger.visible && seen.island.visible && seen.toolbar.visible, describe(seen));
    check(`round ${round}: with the documentation panel still open`, seen.docsCard,
          `selected=${JSON.stringify(seen.selected)}`);
  }

  console.log('\n4. the setting survives a reload');
  seen = await press();
  check('hidden again, ready to be reloaded', !seen.toolbar.visible, describe(seen));
  check('and the setting is written down where a reload can read it',
        typeof seen.stored === 'string' && seen.stored.length > 0, JSON.stringify(seen.stored));

  await send('Page.reload');
  await sleep(1500);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle after the reload');
  await waitFor(() => evaluate(BLOCK), 'the documented block after the reload');
  // The island only exists beside a selection, so put one back before asking about it.
  await evaluate(select(block.id));
  seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.toggle.present ? now : null;
  }, 'the header to render after the reload');
  await shot('05-after-reload');
  check('the menus are still hidden after a reload',
        !seen.hamburger.visible && !seen.island.visible && !seen.toolbar.visible, describe(seen));
  check('and the button is still there to bring them back',
        seen.toggle.visible && seen.toggle.onScreen, JSON.stringify(seen.toggle));

  console.log('\n5. and it is the same on the other project');
  const switched = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.workspace-tab__select'));
    const other = tabs.find((tab) => !tab.closest('.workspace-tab--active'));
    if (!other) return false;
    other.click();
    return true;
  })()`);
  check('there is a second project to switch to', switched);
  await sleep(2500);
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle on the other board');
  seen = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.activeTab === 'Chrome B' ? now : null;
  }, 'the other board to become the active tab');
  await shot('06-other-board');
  check('the menus are hidden on the other board too',
        !seen.hamburger.visible && !seen.toolbar.visible, describe(seen));
  check('and the setting did not travel to the server',
        seen.attr === 'hidden' || seen.attr === null, JSON.stringify(seen.attr));

  seen = await press();
  await shot('07-restored');
  check('one press there brings them back, on this board as on the other',
        seen.hamburger.visible && seen.toolbar.visible, describe(seen));
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
