#!/usr/bin/env node
/**
 * The measurement behind #118, and the way back it asks for, in a real browser.
 *
 * #118 is an investigation: three blocks produced #94, #95 and #96 and kept no record of it,
 * no run was captured, and two hypotheses were left standing. This is the run, captured.
 *
 * **What it records.** A real board is driven through a whole research run with both sides
 * instrumented, and the timeline prints, for every autosync the page issues and every read
 * of the store, what each side held for the block: `version`, `versionNonce` and the
 * `customData` keys. That is the record the definition of done asks for — which write won
 * the merge, and what version each side carried.
 *
 * **What it found.** The browser is routinely *ahead*. Excalidraw bumps an element's version
 * on every keystroke, drag and nudge; the server bumps it once per state change. Six arrow
 * keys during a run put the browser at v=8 while the store held v=3, and it stayed there for
 * two seconds. `POST /api/elements/sync` merges whole elements, higher version wins — so for
 * that whole window the browser's copy of the block outranked the store's, and a copy that
 * outranks it replaces `issueState`, `issueUrl` and `issueTitle` along with everything else.
 * Nothing in the sync distinguished "this field was authored on the server" from "this field
 * is stale in the browser"; the whole element was one version. That is hypothesis 1, and it
 * is measured here rather than reasoned about.
 *
 * Case 1 is that measurement and it does not discriminate: the browser runs ahead on the
 * fixed code too, because being ahead is the *precondition*, not the defect. What it buys is
 * that the payload `check-issue-state-sync.mjs` sends — a pre-run copy five versions ahead —
 * is a thing this board really produces rather than one this project invented in order to
 * fail. Cases 2 and 3 are what fail against the unfixed code: the run's result must still be
 * in the store after the reader carries on working, and a block that lost it must have a way
 * back on screen. The second is the half only a browser can answer.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh` and a stub agent, starts its own canvas
 * server on a free port against a throwaway workspace, and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-issue-state-sync-browser.mjs [--chrome <path>] [--shots <dir>]
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

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-state-sync-'));
const projectDir = join(workDir, 'state-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubGhPath = join(workDir, 'stub-gh.mjs');
const stubAgentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const REPO = 'vitorengers/vibemaxxing';
const RESEARCHED_URL = `https://github.com/${REPO}/issues/123`;
const ADOPTED_URL = `https://github.com/${REPO}/issues/94`;
const ADOPTED_TITLE = 'The terminal should have tabs on top';
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
if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else if (args.includes('issue') && args.includes('view')) {
  const url = args.find((value) => value.indexOf('https://github.com/') === 0) || '';
  const number = Number(url.split('/').pop());
  process.stdout.write(JSON.stringify({
    number,
    title: number === 94 ? ${JSON.stringify(ADOPTED_TITLE)} : 'A researched observation',
    body: 'Investigated.', state: 'OPEN', comments: [],
    stateReason: null, closedByPullRequestsReferences: [],
  }) + '\\n');
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

/**
 * An "agent" that does what the server reads out of one: it prints an issue URL.
 *
 * It waits first, because the window this check is about is the one where a run is in
 * flight and the reader is still working on the block.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  setTimeout(() => {
    process.stdout.write('investigated\\n');
    process.stdout.write('${RESEARCHED_URL}\\n');
  }, 3000);
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'state-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'State Check',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WS_ID = 'state-check';
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
    await sleep(25);
  }
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode });
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
        window.__stateCheckApi = value;
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
 * Every autosync the page issues, with the block's own `version`, `versionNonce` and
 * `customData` in it, on one clock with the marks for what a person did. `fetch` is the
 * whole of it: the autosync is the only thing that POSTs to `/api/elements/sync`.
 */
const INSTRUMENT = `(() => {
  if (window.__syncLog) return true;
  window.__syncLog = [];
  window.__t0 = performance.now();
  window.__mark = (name) => {
    window.__syncLog.push({ at: Math.round(performance.now() - window.__t0), mark: name });
    return true;
  };
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/api/elements/sync') >= 0) {
      try {
        const body = JSON.parse((init && init.body) || '{}');
        const drafts = (body.elements || [])
          .filter((element) => (element.customData || {}).projectBoardDraft && !element.containerId)
          .map((element) => ({
            id: element.id, v: element.version, n: element.versionNonce,
            state: (element.customData || {}).issueState || null,
            url: (element.customData || {}).issueUrl || null,
          }));
        window.__syncLog.push({
          at: Math.round(performance.now() - window.__t0),
          sync: (body.elements || []).length, drafts,
        });
      } catch (error) { /* not the shape we log */ }
    }
    return real.apply(this, arguments);
  };
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__stateCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { drafts: [], add: null };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.projectBoardDraft && !element.containerId) {
      out.drafts.push({
        id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
        v: element.version, n: element.versionNonce,
        state: custom.issueState || null, url: custom.issueUrl || null,
        strokeStyle: element.strokeStyle,
      });
    }
    if (custom.kind === 'project-board' && custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height };
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.editorOpen = Boolean(document.querySelector('textarea.excalidraw-wysiwyg'));
  out.drafts.sort((a, b) => a.y - b.y);
  return out;
})()`;

/** A button in the panel, found by what it says. The panel is the only card on screen. */
const buttonSaying = (text) => `(() => {
  const wanted = ${JSON.stringify(text)};
  const button = Array.from(document.querySelectorAll('.element-docs button'))
    .find((candidate) => (candidate.textContent || '').trim() === wanted);
  return button ? true : false;
})()`;

const clickButtonSaying = (text) => `(() => {
  const wanted = ${JSON.stringify(text)};
  const button = Array.from(document.querySelectorAll('.element-docs button'))
    .find((candidate) => (candidate.textContent || '').trim() === wanted);
  if (!button) return false;
  button.click();
  return true;
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

async function stored(id) {
  const { body } = await api('/api/elements');
  return (body.elements ?? []).find((element) => element.id === id) ?? null;
}

/** Both sides of the block at one instant, which is the whole point of this check. */
async function bothSides(id) {
  const server = await stored(id);
  const scene = await evaluate(PROBE);
  const browser = scene.drafts.find((draft) => draft.id === id) ?? null;
  return {
    server: server && { v: server.version, n: server.versionNonce,
                        state: server.customData?.issueState ?? null,
                        url: server.customData?.issueUrl ?? null },
    browser: browser && { v: browser.v, n: browser.n, state: browser.state, url: browser.url },
  };
}

const measurements = [];
async function record(label, id) {
  const both = await bothSides(id);
  measurements.push({ label, ...both });
  return both;
}

/** Drop a block with the `+` and write an observation into it. */
async function dropAndWrite(observation) {
  let scene = await evaluate(PROBE);
  const before = scene.drafts.length;
  for (let attempt = 0; attempt < 4 && scene.drafts.length === before; attempt++) {
    scene = await evaluate(PROBE);
    const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
    await click(plus.x, plus.y);
    await sleep(700);
    scene = await evaluate(PROBE);
  }
  if (scene.drafts.length === before) throw new Error('the + dropped no block');
  // Newest first at the top of the column, so the one just dropped is the one that is new.
  const known = new Set();
  const block = scene.drafts.find((draft) => !known.has(draft.id) && draft.state === null
    && !measurements.some((entry) => entry.id === draft.id)) ?? scene.drafts[0];

  // Nothing selected first: a selected block puts Excalidraw's island and this project's own
  // panel over the canvas, and the double click meant for the box would land on one.
  await evaluate('window.__stateCheckApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
  scene = await evaluate(PROBE);
  const here = scene.drafts.find((draft) => draft.id === block.id);
  const centre = toViewport(scene, here.x + here.w / 2, here.y + here.h / 2);
  await click(centre.x, centre.y, 2);
  await sleep(400);
  await typeText(observation);
  await pressKey('Escape', 'Escape', 0, 27);
  await sleep(2000);
  return block.id;
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

  console.log('1. what each side holds, through a whole run');
  const blockId = await dropAndWrite('The terminal should have tabs on top. ');
  await record('the observation is written', blockId);

  await evaluate('window.__mark("run posted")');
  const run = await api(`/api/issue-block/${blockId}`, { method: 'POST' });
  check('the research run is accepted', run.status === 202,
        `got ${run.status} ${JSON.stringify(run.body)}`);
  await sleep(700);
  const atStart = await record('the run has just started', blockId);
  check('the store has written running onto the block', atStart.server?.state === 'running',
        JSON.stringify(atStart));

  // The reader carries on working on the block while the agent runs, which is the ordinary
  // case rather than a contrived one: the run takes minutes.
  await evaluate(`window.__stateCheckApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(blockId)}: true } } })`);
  await sleep(300);
  await evaluate('window.__mark("the reader nudges the block, six times")');
  for (let press = 0; press < 6; press++) await pressKey('ArrowRight', 'ArrowRight', 0, 39);
  const midRun = await record('mid-run, after six nudges', blockId);

  // The finding, asserted rather than merely printed. It is true of the fixed code too —
  // being ahead is the precondition, not the defect — and what it establishes is that the
  // payload `check-issue-state-sync.mjs` sends is one this board really produces.
  check('the browser outruns the store: its version decides the merge, and it is higher',
        (midRun.browser?.v ?? 0) > (midRun.server?.v ?? 0),
        `browser v=${midRun.browser?.v} store v=${midRun.server?.v} — `
        + 'nothing crossed, so this run measured nothing');

  console.log('\n2. and the result of the run is still there afterwards');
  await waitFor(async () => (await stored(blockId))?.customData?.issueTitle, 'the run to finish', 80);
  await evaluate('window.__mark("run finished")');
  await sleep(1500);
  await record('the run has finished', blockId);

  // Every autosync from here on carries a copy of the block the browser has been editing.
  await evaluate('window.__mark("the reader keeps working")');
  for (let press = 0; press < 8; press++) await pressKey('ArrowRight', 'ArrowRight', 0, 39);
  await sleep(3000);
  const afterwards = await record('the reader has kept working', blockId);
  await shot('01-after-the-run');

  check('the store still holds the issue the run created',
        afterwards.server?.url === RESEARCHED_URL,
        `url=${afterwards.server?.url} — the run succeeded and the block kept no record of it`);
  check('and still says an issue exists', afterwards.server?.state === 'created',
        `state=${afterwards.server?.state}`);
  const drawn = (await evaluate(PROBE)).drafts.find((draft) => draft.id === blockId);
  check('the block is drawn as one with an issue behind it', drawn?.strokeStyle === 'solid',
        `strokeStyle=${drawn?.strokeStyle}`);

  console.log('\n3. a block that lost its state has a way back, on screen');
  const orphanId = await dropAndWrite('A run kept no record of the issue it made. ');
  // Exactly what the three blocks in #118 carry: an observation, and nothing else.
  const orphan = await stored(orphanId);
  check('the block carries nothing the server wrote', !orphan?.customData?.issueState
        && !orphan?.customData?.issueUrl, JSON.stringify(orphan?.customData));

  let scene = await evaluate(PROBE);
  const here = scene.drafts.find((draft) => draft.id === orphanId);
  const centre = toViewport(scene, here.x + here.w / 2, here.y + here.h / 2);
  await click(centre.x, centre.y);
  await sleep(700);
  await shot('02-panel-open');
  check('selecting it opens the panel with the run on offer',
        await evaluate(buttonSaying('Research and create the issue')));
  check('and beside it, the way back for a run whose result never arrived',
        await evaluate(buttonSaying('This block already has an issue')),
        'the panel offers nothing for a block in the state #118 leaves one in');

  await evaluate(clickButtonSaying('This block already has an issue'));
  await sleep(400);
  await evaluate('(() => { const box = document.querySelector(".element-docs__url"); if (box) box.focus(); return true })()');
  await typeText(ADOPTED_URL);
  await sleep(200);
  await shot('03-url-typed');
  check('the URL is in the box',
        (await evaluate('(document.querySelector(".element-docs__url") || {}).value || ""')) === ADOPTED_URL,
        await evaluate('(document.querySelector(".element-docs__url") || {}).value || ""'));

  await evaluate(clickButtonSaying('Record it on this block'));
  const landed = await waitFor(async () => {
    const element = await stored(orphanId);
    return element?.customData?.issueUrl === ADOPTED_URL ? element : null;
  }, 'the adopted issue to reach the block', 40).catch(() => null);
  await sleep(1200);
  await shot('04-adopted');

  check('the block now carries the issue it had already produced', Boolean(landed),
        `customData=${JSON.stringify((await stored(orphanId))?.customData)}`);
  check('and says an issue exists', landed?.customData?.issueState === 'created',
        `state=${landed?.customData?.issueState}`);
  check('with the title read off GitHub rather than guessed',
        landed?.customData?.issueTitle === ADOPTED_TITLE,
        `title=${landed?.customData?.issueTitle}`);
  const adoptedOnScreen = (await evaluate(PROBE)).drafts.find((draft) => draft.id === orphanId);
  check('and is drawn as a block with an issue behind it, in the browser',
        adoptedOnScreen?.strokeStyle === 'solid' && adoptedOnScreen?.url === ADOPTED_URL,
        JSON.stringify(adoptedOnScreen));

  // The measurement, printed whether it passed or failed: this is the record #118 asks for.
  console.log('\nwhat each side held (version · nonce · state · issue)');
  for (const entry of measurements) {
    const side = (value) => value
      ? `v=${String(value.v).padEnd(4)} n=${String(value.n).padEnd(11)} ${String(value.state ?? '—').padEnd(8)} ${value.url ?? '—'}`
      : '(absent)';
    console.log(`  ${entry.label}`);
    console.log(`      store    ${side(entry.server)}`);
    console.log(`      browser  ${side(entry.browser)}`);
  }

  const timeline = await evaluate('window.__syncLog');
  console.log('\ntimeline (ms from the instrumentation being installed)');
  for (const entry of timeline) {
    if (entry.mark) console.log(`  ${String(entry.at).padStart(6)}  · ${entry.mark}`);
    else console.log(`  ${String(entry.at).padStart(6)}  → sync of ${entry.sync} elements`
      + `${entry.drafts.length ? `, blocks: ${JSON.stringify(entry.drafts)}` : ''}`);
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
