#!/usr/bin/env node
/**
 * Checks that a scene change whose autosync was refused is not lost.
 *
 * #92: clicking **Research and create the issue** on a block that was just written
 * sometimes answers `Element pbdraft-… not found`. The block is not lost — a minute later
 * it is on the server with the right `customData`. It arrived *after* the click.
 *
 * The obvious reading was that the 1200 ms debounce had not elapsed. It is not that: the
 * timer is never armed at all. `onChange` runs `relayoutForDrafts` and then
 * `scheduleAutoSync`, back to back; a relayout redraws the mirror through
 * `applySceneUpdateWithoutAutoSync`, which raises the suppression counter, and
 * `scheduleAutoSync` sees the counter up and returns **without arming anything**. Nothing
 * re-arms it when the counter drops. The change waits for some later change that happens
 * not to relayout — which is why the failure is intermittent for a person and why a
 * scripted sequence with different timing did not reproduce it.
 *
 * So the check instruments the browser rather than trusting a stopwatch: it records every
 * `/api/elements/sync` the page issues, marks each thing a person does, and prints the two
 * as one timeline. What that timeline has to show is a discriminator, not a wait —
 * **two changes to the same block, under the same debounce, ending differently**:
 *
 *   - typing into the block, which grows it and therefore relayouts → the observation must
 *     still reach the server;
 *   - nudging the block with an arrow key, which moves it without changing the relayout
 *     signature → the control, proving the debounce path itself was never broken.
 *
 * If only the second one lands, the difference is the suppression counter and nothing else.
 * Against the unfixed code the timeline shows exactly that: no sync at all between the
 * editor closing and the arrow key, the observation missing from the store, and the
 * `POST /api/issue-block/:id` a reader's click makes answering 404 or 400.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on, rather than by adding a browser-automation dependency. Self-contained
 * otherwise: it writes a stub `gh` and a stub agent, starts its own canvas server against a
 * throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-autosync-drop-browser.mjs [--chrome <path>] [--shots <dir>]
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

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ─── A project to mirror, and the stubs behind it ─────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-autosync-drop-'));
const projectDir = join(workDir, 'sync-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const REPO = 'vitorengers/mcp_excalidraw';
// One option, and no option for the column the `+` drops into: since #97 that column is
// the canvas's own and the project declares nothing for it. A fixture that still declared
// a `My Notes` option would be asserting the arrangement this repository stopped relying on.
const TODO = { id: 'f75ad846', name: 'Todo' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO] },
    items: { pageInfo: { hasNextPage: false }, nodes: [{
      id: 'PVTI_a',
      type: 'ISSUE',
      fieldValueByName: { optionId: TODO.id, name: TODO.name },
      content: {
        __typename: 'Issue',
        number: 9,
        title: 'Something already researched',
        url: `https://github.com/${REPO}/issues/9`,
        createdAt: '2026-07-05T10:00:00Z',
        state: 'OPEN',
        repository: { nameWithOwner: REPO },
      },
    }] },
  } } },
}), 'utf8');

writeFileSync(stubGhPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

/**
 * An "agent" that does what the server reads out of one: it prints an issue URL.
 *
 * Nothing here is about what the agent does. It exists so `EXCALIDRAW_ISSUE_AGENT` is set,
 * because the route refuses outright when it is not, and a 404 for *that* reason would look
 * exactly like the 404 this check is about.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('investigated\\n');
  process.stdout.write('https://github.com/${REPO}/issues/123\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'sync-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Sync Check',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WS_ID = 'sync-check';
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = startCanvas({
  port: PORT,
  env: {
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubGhPath.replace(/\\/g, '/')}"`,
    EXCALIDRAW_ISSUE_AGENT: `node "${stubAgentPath.replace(/\\/g, '/')}"`,
    STUB_GH_FIXTURE: fixturePath,
    // The `+` drops a block *from the library*: with no template carrying
    // `customData.kind === "issue"` every click is a silent no-op.
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
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

async function click(x, y, clickCount = 1) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount, buttons: 0 });
  await sleep(150);
}

async function typeText(text) {
  for (const character of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: character, unmodifiedText: character, key: character });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: character });
    await sleep(30);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The Excalidraw imperative API, through the container's React fibre. */
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
        window.__syncCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * The instrumentation.
 *
 * Every autosync the page issues, with what it carried, on one clock with the marks for
 * what a person did. `fetch` is the whole of it: the autosync is the only thing that POSTs
 * to `/api/elements/sync`, so a change that produced no entry here produced no sync at all.
 *
 * And the debounce timer itself, which is what tells a sync that is *late* from one that
 * was *dropped*. `AUTO_SYNC_DEBOUNCE_MS` is 1200 and nothing else in the frontend arms a
 * timer of that length, so a `setTimeout(…, 1200)` is `scheduleAutoSync` arming and the
 * absence of one is `scheduleAutoSync` refusing. A stopwatch cannot tell those apart; this
 * can.
 */
const INSTRUMENT = `(() => {
  if (window.__syncLog) return true;
  window.__syncLog = [];
  window.__t0 = performance.now();
  window.__mark = (name) => {
    window.__syncLog.push({ at: Math.round(performance.now() - window.__t0), mark: name });
    return true;
  };
  const realTimeout = window.setTimeout;
  const realClear = window.clearTimeout;
  const armed = new Set();
  window.setTimeout = function (handler, delay) {
    const id = realTimeout.apply(this, arguments);
    if (delay === 1200) {
      armed.add(id);
      window.__syncLog.push({ at: Math.round(performance.now() - window.__t0), armed: true });
    }
    return id;
  };
  window.clearTimeout = function (id) {
    if (armed.has(id)) {
      armed.delete(id);
      window.__syncLog.push({ at: Math.round(performance.now() - window.__t0), cleared: true });
    }
    return realClear.apply(this, arguments);
  };
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/elements/sync') >= 0) {
      let count = null;
      let texts = [];
      try {
        const body = JSON.parse((init && init.body) || '{}');
        count = (body.elements || []).length;
        texts = (body.elements || [])
          .filter((element) => typeof element.text === 'string' && element.text.trim())
          .map((element) => element.id + '@v' + element.version + ' ' + JSON.stringify(element.text.slice(0, 30)));
      } catch (error) { /* not the shape we log */ }
      window.__syncLog.push({ at: Math.round(performance.now() - window.__t0), sync: count, texts });
    }
    return real.apply(this, arguments);
  };
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__syncCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], add: null };
  const labels = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (element.containerId && typeof element.text === 'string') {
      labels.push({ containerId: element.containerId, text: element.text });
    }
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
  }
  for (const draft of out.drafts) {
    draft.text = labels.filter((label) => label.containerId === draft.id)
      .map((label) => label.text).join(' ').replace(/\\s+/g, ' ').trim();
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const api = async (path, options = {}) => {
  const glue = path.includes('?') ? '&' : '?';
  const response = await fetch(`${BASE}${path}${glue}workspace=${WS_ID}`, options);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/** What the server holds for a block: the shape, and the label the observation is in. */
async function stored(id) {
  const { body } = await api('/api/elements');
  const elements = body.elements ?? [];
  const block = elements.find((element) => element.id === id) ?? null;
  const labels = elements.filter((element) => element.containerId === id);
  // Every label, joined: the observation is what the block holds, and reading only the
  // first of them would answer from whichever one the store happens to list first.
  const text = [...labels.map((label) => label.text ?? ''), block?.text ?? '']
    .map((value) => value.trim())
    .filter(Boolean)
    .join(' ⏐ ');
  return { block, labels, text };
}

const OBSERVATION = 'The docs panel takes a long time to open on a large board. ';

/** How many debounce timers were armed between two marks on the instrumented timeline. */
async function armedBetween(from, to) {
  const log = await evaluate('window.__syncLog');
  const end = log.findIndex((entry) => entry.mark === to);
  // The last `from` before `to`: the `+` is clicked again if the first one missed, and only
  // the click that actually dropped the block is the one this is asking about.
  const start = log.slice(0, end < 0 ? log.length : end)
    .map((entry, index) => (entry.mark === from ? index : -1))
    .filter((index) => index >= 0)
    .pop() ?? -1;
  if (start < 0 || end < 0) return 0;
  return log.slice(start + 1, end).filter((entry) => entry.armed).length;
}

/** Wait for a condition on the store, and answer how long it took — or null. */
async function reaches(predicate, budgetMs) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(100);
  }
  return null;
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
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');
  await evaluate(INSTRUMENT);

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);

  console.log('1. the + drops a block, and the block reaches the server');
  // Clicked again if it missed. The mirror is fitted to the window a moment earlier and the
  // first click has been seen landing before that settled, which is a flaky harness rather
  // than anything this check is about.
  for (let attempt = 0; attempt < 3 && scene.drafts.length === 0; attempt++) {
    scene = await evaluate(PROBE);
    const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
    await evaluate('window.__mark("+ clicked")');
    await click(plus.x, plus.y);
    await sleep(600);
    scene = await evaluate(PROBE);
  }
  await shot('01-dropped');
  check('one click, one block', scene.drafts.length === 1, JSON.stringify(scene.drafts));
  const block = scene.drafts[0];

  // Four times the debounce. The question is not whether it is quick, only whether the
  // change ever arrives without another change to carry it.
  const dropArrived = await reaches(async () => Boolean((await stored(block.id)).block), 5000);
  await evaluate('window.__mark("block on the server")');
  check('the dropped block is in the store within four times the debounce',
        dropArrived !== null, `still absent after 5000 ms (${block.id})`);
  // The same failure read at the mechanism rather than at the effect: with the click being
  // the only thing that happened in that window, a debounce that was never armed is a
  // schedule that was refused and never came back — not one that is merely late.
  check('and a debounce was armed for it, rather than the schedule being refused and forgotten',
        (await armedBetween('+ clicked', 'block on the server')) > 0,
        'no setTimeout(…, AUTO_SYNC_DEBOUNCE_MS) between the click and the wait running out');

  console.log('\n2. the observation typed into it reaches the server too');
  // Nothing selected first: a selected block puts Excalidraw's island and this project's
  // own panel over the canvas, and the double click meant for the box would land on one.
  await evaluate('window.__syncCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  const centre = toViewport(scene, block.x + block.w / 2, block.y + block.h / 2);
  await evaluate('window.__mark("double click")');
  await click(centre.x, centre.y, 2);
  await sleep(400);
  check('a double click opens the text editor', (await evaluate(PROBE)).editorOpen);

  await evaluate('window.__mark("typing")');
  // Long enough to outgrow the template, which is what makes the relayout fire: the height
  // is in the signature `relayoutForDrafts` keeps.
  for (let round = 0; round < 3; round++) await typeText(OBSERVATION);
  await evaluate('window.__mark("typed")');
  await pressKey('Escape', 'Escape', 0, 27);
  await evaluate('window.__mark("editor closed")');
  await shot('02-typed');

  const written = OBSERVATION.trim().slice(0, 30);
  // On screen first. A keystroke that never reached the editor would leave the store
  // holding the template text, which reads exactly like a sync that was dropped — and this
  // check would then be blaming the autosync for the harness.
  const onScreen = (await evaluate(PROBE)).drafts.find((draft) => draft.id === block.id)?.text ?? '';
  check('the observation is in the block on screen', onScreen.includes(written),
        `the block reads ${JSON.stringify(onScreen)}`);

  const textArrived = await reaches(async () => (await stored(block.id)).text.includes(written), 5000);
  await evaluate('window.__mark("observation on the server")');
  const holding = await stored(block.id);
  check('the observation is in the store within four times the debounce, with nothing else touched',
        textArrived !== null,
        `still absent after 5000 ms — store has ${JSON.stringify(holding.text)}`
        + ` from ${JSON.stringify(holding.labels.map((label) => ({ id: label.id, v: label.version })))}`);

  console.log('\n3. and the click a reader makes next is answered');
  // What "Research and create the issue" does. 404 is the report in #92 — the store had no
  // such element; 400 is the same defect one step later — the block arrived but the
  // observation typed into it did not, so the server sees nothing to work from.
  const run = await api(`/api/issue-block/${block.id}`, { method: 'POST' });
  check('the research run is accepted', run.status === 202,
        `got ${run.status} ${JSON.stringify(run.body)}`);

  console.log('\n4. the control: a change that does not relayout was never the problem');
  // The same block, the same debounce, one difference — an arrow key moves it without
  // changing the relayout signature, so nothing suppresses the sync. If this lands and the
  // one above did not, the difference is the suppression counter and nothing else.
  await evaluate(`window.__syncCheckApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(block.id)}: true } } })`);
  await sleep(300);
  await evaluate('window.__mark("arrow key")');
  for (let press = 0; press < 12; press++) await pressKey('ArrowRight', 'ArrowRight', 0, 39);
  // Read off the scene, not off the store: against the unfixed code the store may hold no
  // copy of this block at all, and a control that needed one would fail for case 1's reason
  // instead of answering its own question.
  const nudgedTo = (await evaluate(PROBE)).drafts.find((draft) => draft.id === block.id)?.x ?? null;
  const nudgeArrived = await reaches(async () => {
    const now = (await stored(block.id)).block?.x ?? null;
    return nudgedTo !== null && now !== null && Math.abs(now - nudgedTo) < 1;
  }, 5000);
  await evaluate('window.__mark("nudge on the server")');
  check('a move with no relayout behind it still syncs', nudgeArrived !== null,
        `the scene has it at x=${nudgedTo}, the store at x=${(await stored(block.id)).block?.x ?? null}`);

  // The measurement, printed whether it passed or failed: this is the record #92 asks for.
  const timeline = await evaluate('window.__syncLog');
  console.log('\ntimeline (ms from the instrumentation being installed)');
  for (const entry of timeline) {
    if (entry.mark) console.log(`  ${String(entry.at).padStart(6)}  · ${entry.mark}`);
    else if (entry.armed) console.log(`  ${String(entry.at).padStart(6)}  ⏱ debounce armed`);
    else if (entry.cleared) console.log(`  ${String(entry.at).padStart(6)}  ⏹ debounce cleared`);
    else console.log(`  ${String(entry.at).padStart(6)}  → sync of ${entry.sync} elements${entry.texts.length ? `, text: ${JSON.stringify(entry.texts)}` : ''}`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
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
