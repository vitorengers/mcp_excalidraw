#!/usr/bin/env node
/**
 * Checks that a run is started against a block the server already has.
 *
 * #179, and the half of #92 that #100 did not close. #100 made a schedule the suppression
 * counter refuses **owed** rather than dropped, which removed the *loss*. It did not remove
 * the *latency*: `createIssueFromBlock` still fires `POST /api/issue-block/:id` the instant
 * the button is pressed, and the autosync that would put the block in the server's store
 * runs `AUTO_SYNC_DEBOUNCE_MS` after the last change. Finish the edit, click, and the POST
 * overtakes the sync — `Element pbdraft-… not found`, on a block that is on screen.
 *
 * The window is exactly the debounce and it is open on every click. Whether it bites is only
 * a question of how fast the reader is, which is why waiting for it is the wrong instrument:
 * a check built on losing a race passes on any machine that happens to win it.
 *
 * So neither case here races.
 *
 * 1. **Ordering.** `fetch` is instrumented, the button is clicked, and the two requests are
 *    read off one timeline: the sync has to come *before* the run. That is the property the
 *    fix adds, stated with no clock in it at all.
 * 2. **What the run is given.** A marker is typed and the button pressed straight after, so
 *    the click is always inside the debounce; whether the server holds that marker when the
 *    run is accepted is then a fact about the flush rather than about timing.
 * 3. **The reset.** `DELETE /api/issue-block/:id` addresses a block the same way and is
 *    reachable just as early.
 * 4. **The control.** A block the server already had still runs — the ordinary case, where
 *    there was nothing owed to flush.
 *
 * Each case drafts a block of its own. A run leaves an `issueUrl` behind, and a second click
 * on that block is refused for a different reason entirely (409) — which would have this
 * check reporting the flush broken when what broke was its own setup.
 *
 * Chrome is driven over the DevTools protocol through `ws`, as `check-autosync-drop-browser`
 * does. Self-contained: stub `gh`, stub agent, own canvas server on a free port, own
 * throwaway workspace. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build`
 * first — it loads the built frontend.
 *
 * Usage: node scripts/check-run-flush-browser.mjs [--chrome <path>] [--shots <dir>]
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

const workDir = mkdtempSync(join(tmpdir(), 'check-run-flush-'));
const projectDir = join(workDir, 'flush-check');
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
const TODO = { id: 'f75ad846', name: 'Todo' };

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_flush',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO] },
    items: { pageInfo: { hasNextPage: false }, nodes: [] },
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
 * Nothing here is about what an agent does. It exists so `EXCALIDRAW_ISSUE_AGENT` is set,
 * because the route refuses outright when it is not — and a 404 for *that* reason would look
 * exactly like the 404 this check is about.
 *
 * It hangs when the observation asks it to, which is the only way to reach the state case 3
 * needs: **Reset — the run was lost** is offered while a run is in flight and at no other
 * time. The exit is on a timer rather than never, so a killed check leaves nothing behind.
 */
writeFileSync(stubAgentPath, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  if (input.includes('FAROL-HANG')) { setTimeout(() => process.exit(1), 60000); return; }
  process.stdout.write('investigated\\n');
  process.stdout.write('https://github.com/${REPO}/issues/123\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'flush-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Flush Check',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const WS_ID = 'flush-check';
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
    EXCALIDRAW_LIBRARY: join(repoRoot, 'docs', 'blocks.excalidrawlib'),
    // Inherited from whoever runs this otherwise, and with it set the terminal block's
    // overlay sits over the mirror and swallows the click aimed at the `+`.
    EXCALIDRAW_TERMINAL: '',
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
        window.__flushApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/**
 * Every request the page makes, in order, with what the run answered.
 *
 * The order is the whole of case 1, so this records both kinds rather than only the sync:
 * "a sync happened at some point" is not the claim — "a sync happened *before* the run
 * request left" is.
 */
const INSTRUMENT = `(() => {
  if (window.__flushLog) return true;
  window.__flushLog = [];
  const real = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = ((init && init.method) || 'GET').toUpperCase();
    const kind = url.indexOf('/api/elements/sync') >= 0 ? 'sync'
      : (url.indexOf('/api/issue-block/') >= 0 && url.indexOf('/adopt') < 0 && method === 'POST') ? 'run'
      : (url.indexOf('/api/issue-block/') >= 0 && method === 'DELETE') ? 'reset'
      : null;
    if (!kind) return real.apply(this, arguments);
    const entry = { kind, at: Math.round(performance.now()), status: null };
    window.__flushLog.push(entry);
    return real.apply(this, arguments).then((response) => {
      entry.status = response.status;
      return response;
    }, (error) => { entry.status = 'network-error'; throw error; });
  };
  return true;
})()`;

const PROBE = `(() => {
  const api = window.__flushApi;
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
  out.panel = [...document.querySelectorAll('.docs-card button')].map((b) => (b.textContent || '').trim());
  out.panelText = (document.querySelector('.docs-card')?.textContent || '').replace(/\\s+/g, ' ').trim();
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

const clickButton = (label) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.docs-card button')]
    .find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`);

async function select(id) {
  await evaluate(`window.__flushApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(id)}: true } } })`);
  await sleep(600);
}

async function deselect() {
  await evaluate('window.__flushApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

/** Everything the page requested since the log was last cleared. */
const readLog = () => evaluate('window.__flushLog');
const clearLog = () => evaluate('window.__flushLog.length = 0; true');

async function logUntil(predicate, what, ms = 20_000) {
  const started = Date.now();
  let last = [];
  while (Date.now() - started < ms) {
    last = await readLog();
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
}

/** Whether the store has this block at all. */
async function inStore(id) {
  const { body } = await api('/api/elements');
  return (body.elements ?? []).some((element) => element.id === id);
}

const RUN = 'Research and create the issue';
const RESET = 'Reset — the run was lost';
const OBSERVATION = 'The docs panel takes a long time to open on a large board. ';

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
    '--window-size=1500,950',
    BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  await waitFor(async () => Boolean((await evaluate(PROBE)).add), 'the mirror to render');
  await evaluate(INSTRUMENT);

  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await evaluate(PROBE);

  // ─── One fresh block per case ───────────────────────────────
  //
  // Rather than one block reused: a run leaves an `issueUrl` behind and the next click on
  // that block is refused for a different reason entirely (409), which would have this
  // check reporting the flush broken when what broke was its own setup.

  /** Drop a block with the `+`, write `text` into it, and answer where it is. */
  async function draftBlock(text) {
    const before = (await evaluate(PROBE)).drafts.map((draft) => draft.id);
    let scene = await evaluate(PROBE);
    for (let attempt = 0; attempt < 3; attempt++) {
      const plus = toViewport(scene, scene.add.x + scene.add.w / 2, scene.add.y + scene.add.h / 2);
      await click(plus.x, plus.y);
      await sleep(700);
      scene = await evaluate(PROBE);
      if (scene.drafts.some((draft) => !before.includes(draft.id))) break;
    }
    const made = scene.drafts.find((draft) => !before.includes(draft.id));
    if (!made) throw new Error(`the + dropped no new block (had ${JSON.stringify(before)})`);

    await deselect();
    scene = await evaluate(PROBE);
    const fresh = scene.drafts.find((draft) => draft.id === made.id) ?? made;
    const centre = toViewport(scene, fresh.x + fresh.w / 2, fresh.y + fresh.h / 2);
    await click(centre.x, centre.y, 2);
    await sleep(400);
    if (!(await evaluate(PROBE)).editorOpen) throw new Error('a double click did not open the text editor');
    await typeText(text);
    await pressKey('Escape', 'Escape', 0, 27);
    await sleep(300);
    return made.id;
  }

  console.log('1. the click syncs before it runs');
  {
    const id = await draftBlock(OBSERVATION);
    await select(id);
    const panel = await evaluate(PROBE);
    check('the panel offers the run', panel.panel.includes(RUN), JSON.stringify(panel.panel));

    await clearLog();
    await clickButton(RUN);
    const log = await logUntil((entries) => entries.some((entry) => entry.kind === 'run'), 'the run request');

    const run = log.findIndex((entry) => entry.kind === 'run');
    const sync = log.findIndex((entry) => entry.kind === 'sync');
    check('a sync is issued before the run request leaves',
          sync >= 0 && sync < run,
          `requests were ${JSON.stringify(log.map((entry) => entry.kind))}`);
    await shot('01-ordered');
  }

  console.log('\n2. what the reader last typed is what the run is given');
  {
    // The behavioural half, and it needs no race: the marker is typed and the button is
    // pressed straight after, so the click is always inside the debounce. Whether the server
    // has the marker when the run is accepted is then a fact about the flush and nothing else.
    const marker = 'FAROL-MARKER-9731';
    const id = await draftBlock(`${OBSERVATION}${marker}`);
    await select(id);

    await clearLog();
    await clickButton(RUN);
    const log = await logUntil((entries) => entries.some((entry) => entry.kind === 'run' && entry.status !== null),
                              'the run to be answered');
    const answered = log.find((entry) => entry.kind === 'run' && entry.status !== null);
    check('the run is accepted', answered?.status === 202,
          `answered ${answered?.status}; requests were ${JSON.stringify(log.map((e) => `${e.kind}:${e.status}`))}`);

    const { body } = await api('/api/elements');
    const held = (body.elements ?? [])
      .filter((element) => element.id === id || element.containerId === id)
      .map((element) => element.text ?? '')
      .join(' ');
    // Whitespace out of both sides before comparing: a bound label is stored **wrapped**, so
    // a marker that crosses the wrap arrives as `FAROL-\nMARKER-9731` and a literal compare
    // would report the flush broken over a line break Excalidraw put in.
    const bare = (value) => value.replace(/\s+/g, '');
    check('the observation the run was started on is in the store',
          bare(held).includes(bare(marker)),
          `the store holds ${JSON.stringify(held.slice(0, 160))}`);
    await shot('02-carried');
  }

  console.log('\n3. the reset addresses a block the same way');
  {
    // The reset is offered while a run is in flight and at no other time, so the run has to
    // be started first and has to stay started — hence the stub that hangs on this marker.
    const id = await draftBlock(`${OBSERVATION}FAROL-HANG`);
    // Settled before the run is started, deliberately: against the unfixed code a run on a
    // block the store has not got is refused, the block goes to `failed` rather than
    // `running`, and the reset is never offered — so this case would be testing case 2's
    // defect instead of its own.
    await waitFor(() => inStore(id), 'the block to reach the store');
    await select(id);
    await clickButton(RUN);

    const offered = await (async () => {
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        if ((await evaluate(PROBE)).panel.includes(RESET)) return true;
        await sleep(250);
      }
      return false;
    })();
    check('a run in flight offers the reset', offered,
          (await evaluate(PROBE)).panel.join(' | '));

    await clearLog();
    const clicked = offered ? await clickButton(RESET) : false;
    if (clicked !== true) {
      const panel = await evaluate(PROBE);
      check(`the panel offers "${RESET}"`, false, panel.panel.join(' | '));
    } else {
      const log = await logUntil((entries) => entries.some((entry) => entry.kind === 'reset'), 'the reset request');
      const reset = log.findIndex((entry) => entry.kind === 'reset');
      const sync = log.findIndex((entry) => entry.kind === 'sync');
      check('a sync is issued before the reset request leaves',
            sync >= 0 && sync < reset,
            `requests were ${JSON.stringify(log.map((entry) => entry.kind))}`);
    }
  }

  console.log('\n4. the control: nothing else about the click changed');
  {
    const id = await draftBlock(OBSERVATION);
    await select(id);
    // Settled first, so this one is the ordinary case rather than the raced one — the run
    // has to still be accepted when there was nothing owed to flush.
    await waitFor(() => inStore(id), 'the block to reach the store');
    await sleep(1500);

    await clearLog();
    await clickButton(RUN);
    const log = await logUntil((entries) => entries.some((entry) => entry.kind === 'run' && entry.status !== null),
                              'the run to be answered');
    const answered = log.find((entry) => entry.kind === 'run' && entry.status !== null);
    check('a block the server already had still runs', answered?.status === 202,
          `answered ${answered?.status}`);
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
