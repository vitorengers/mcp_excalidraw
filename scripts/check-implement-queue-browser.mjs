#!/usr/bin/env node
/**
 * Checks the queue toggle in a real browser.
 *
 * `check-implement-queue.mjs` covers what the queue does; this covers the button, which is
 * the half that compiles either way. This project has paid for that three times — a panel
 * that never opened, a race in tab initialisation, a click landing on the label instead of
 * the box — so the questions here are the ones only a browser settles:
 *
 *  - is the toggle drawn on the **Todo** header, and only there;
 *  - does clicking it reach the server, or is it a shape that merely looks like a button;
 *  - do its two states actually look different, in weight and fill rather than in hue alone;
 *  - and does the **second** click work. That one is the trap: this button is handled as a
 *    *selection*, and a selection that does not change is ignored — so a toggle left selected
 *    after the first click can never be switched back, and every state on the server would
 *    still be right while the board was stuck.
 *  - does the appearance survive the twenty-second redraw, which rebuilds every mirrored
 *    shape from GitHub and would take an on-looking button with it;
 *  - and does the board actually drain on screen: queue on, a run going, that run finishes,
 *    and the next one starts by itself with the outlines on the cards following it.
 *
 * The fixture's Todo column holds one closed issue and two open ones, against a cap of one,
 * so the drain is a sequence a browser can watch rather than a burst. The agent parks until
 * the check releases it, which is what makes "one finishes" a moment this can choose.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it writes a stub `gh` and a stub agent, starts its own canvas
 * server against a throwaway workspace, and kills both. Run `./node_modules/.bin/tsc` and
 * `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-implement-queue-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

/** Chrome, wherever this machine keeps it. Edge speaks the same protocol. */
function findChrome() {
  const named = argOf('--chrome');
  if (named) return existsSync(named) ? named : null;
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  return candidates.find((path) => path && existsSync(path)) ?? null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.log('SKIPPED — no Chrome or Edge found, so the browser half was not run.');
  console.log('        Pass --chrome <path> or set CHROME_PATH to run it.');
  process.exit(0);
}

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

const layoutModulePath = join(repoRoot, 'dist', 'core', 'project-board-layout.js');
if (!existsSync(layoutModulePath)) {
  console.error('  FAIL  the compiled server exists — dist/core/project-board-layout.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// The glyph is read from the compiled module rather than retyped here: a check that agreed
// with the code only by being spelled the same way is one edit away from agreeing with
// nothing. `QUEUE_GLYPH` is absent on a build without the feature, which is a failure of the
// first case rather than of the harness.
const layoutModule = await import(pathToFileURL(layoutModulePath).href);
const QUEUE_GLYPH = layoutModule.QUEUE_GLYPH ?? null;

// ─── A project to mirror ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-queue-toggle-'));
const projectDir = join(workDir, 'queue-check');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const stubPath = join(workDir, 'stub-gh.mjs');
const agentPath = join(workDir, 'stub-agent.mjs');
const fixturePath = join(workDir, 'fixture.json');
const registryPath = join(workDir, 'workspaces.json');

const REPO = 'vitorengers/mcp_excalidraw';
const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, createdAt, option, state = 'OPEN') => ({
  id,
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title: `Issue ${number}`,
    url: `https://github.com/${REPO}/issues/${number}`,
    createdAt,
    state,
    repository: { nameWithOwner: REPO },
  },
});

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/vitorengers/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      // The oldest card in Todo is closed, so a queue that took the head of the column
      // without looking would start the one thing there is no work in.
      item('PVTI_a', 31, '2026-07-01T10:00:00Z', TODO, 'CLOSED'),
      item('PVTI_b', 32, '2026-07-02T10:00:00Z', TODO),
      item('PVTI_c', 33, '2026-07-03T10:00:00Z', TODO),
      item('PVTI_d', 34, '2026-07-05T10:00:00Z', DOING),
      item('PVTI_e', 35, '2026-07-09T10:00:00Z', DONE),
    ] },
  } } },
}), 'utf8');

writeFileSync(stubPath, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('graphql')) process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
else process.stdout.write('{}\\n');
`, 'utf8');

/**
 * An agent that parks until this check releases it, so "one run finishes" is a moment the
 * check chooses rather than one it waits out.
 */
writeFileSync(agentPath, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(join(workDir, 'release-' + number))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('done\\nhttps://github.com/${REPO}/pull/' + number + '\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'queue-check', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Queue Check',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = 34900 + (process.pid % 300);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${stubPath.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentPath.replace(/\\/g, '/')}" -p`,
    // One at a time, so the drain is a sequence to watch rather than a burst, and so the
    // second issue starting is provably the first one finishing rather than both at once.
    EXCALIDRAW_IMPLEMENT_CONCURRENCY: '1',
    STUB_GH_FIXTURE: fixturePath,
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(150);
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The imperative API, through the container's React fibre. See check-board-drafts-browser. */
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
        window.__boardCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const PROBE = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return { error: 'no api handle' };
  const out = { queue: null, add: null, headers: [], cards: [], labels: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind !== 'project-board') continue;
    if (custom.role === 'card') {
      out.cards.push({ url: custom.issueUrl || null, col: custom.sectionOptionId,
                       run: custom.implementState || null, y: element.y,
                       strokeStyle: element.strokeStyle, strokeWidth: element.strokeWidth });
    }
    if (custom.role === 'section') {
      out.headers.push({ id: element.id, col: custom.sectionOptionId,
                         x: element.x, y: element.y, w: element.width, h: element.height });
    }
    if (custom.role === 'add') {
      out.add = { x: element.x, y: element.y, w: element.width, h: element.height, col: custom.sectionOptionId };
    }
    if (custom.role === 'queue') {
      out.queue = { id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                    col: custom.sectionOptionId, on: custom.queueEnabled === true,
                    fill: element.backgroundColor, stroke: element.strokeColor,
                    strokeWidth: element.strokeWidth, locked: element.locked === true };
    }
    if (element.containerId && custom.role === 'label') {
      out.labels.push({ containerId: element.containerId, text: element.text || '' });
    }
  }
  if (out.queue) {
    const label = out.labels.find((entry) => entry.containerId === out.queue.id);
    out.queue.text = label ? label.text.trim() : null;
    out.queue.textColor = null;
    for (const element of api.getSceneElements()) {
      if (element.containerId === out.queue.id) out.queue.textColor = element.strokeColor;
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
               offsetLeft: state.offsetLeft, offsetTop: state.offsetTop };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);
  return out;
})()`;

const toViewport = (scene, x, y) => ({
  x: (x + scene.view.scrollX) * scene.view.zoom + scene.view.offsetLeft,
  y: (y + scene.view.scrollY) * scene.view.zoom + scene.view.offsetTop,
});

const serverQueue = async () => {
  const response = await fetch(`${BASE}/api/implement?workspace=queue-check`);
  return (await response.json()).queue ?? null;
};
const serverRuns = async () => {
  const response = await fetch(`${BASE}/api/implement?workspace=queue-check`);
  return (await response.json()).runs ?? [];
};
const issueUrl = (number) => `https://github.com/${REPO}/issues/${number}`;
const stateOf = async (number) =>
  (await serverRuns()).find((run) => run.issueUrl === issueUrl(number))?.state ?? null;
const release = (number) => writeFileSync(join(workDir, `release-${number}`), '', 'utf8');
/** The card the mirror draws for one issue, as the browser currently has it. */
const cardFor = (scene, number) => (scene.cards ?? []).find((card) => card.url === issueUrl(number));

/** Click the toggle where it currently is, and wait for the redraw the click causes. */
async function clickToggle(scene) {
  const spot = toViewport(scene, scene.queue.x + scene.queue.w / 2, scene.queue.y + scene.queue.h / 2);
  await click(spot.x, spot.y);
  await sleep(900);
  return evaluate(PROBE);
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
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 5, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  let scene = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return now.queue ? now : null;
  }, 'the queue toggle to be drawn');
  await shot('01-off');

  console.log('1. the toggle is drawn on the Todo header, and it is a button');
  check('there is a toggle at all', Boolean(scene.queue), JSON.stringify(scene));
  check('on the Todo column, not on another one', scene.queue.col === TODO.id,
        `${scene.queue.col} vs ${TODO.id}`);
  const header = scene.headers.find((entry) => entry.col === TODO.id);
  check('inside that column\'s header', Boolean(header)
        && scene.queue.y >= header.y && scene.queue.y + scene.queue.h <= header.y + header.h
        && scene.queue.x + scene.queue.w <= header.x + header.w,
        `${JSON.stringify(scene.queue)} against ${JSON.stringify(header)}`);
  check('at the right of it', Boolean(header) && scene.queue.x > header.x + header.w / 2,
        `${scene.queue.x} against a header from ${header?.x} to ${header?.x + header?.w}`);
  check('unlocked, because a locked shape cannot be clicked', scene.queue.locked === false,
        JSON.stringify(scene.queue));
  check('carrying the circular arrow', QUEUE_GLYPH !== null && scene.queue.text === QUEUE_GLYPH,
        `${JSON.stringify(scene.queue.text)} vs ${JSON.stringify(QUEUE_GLYPH)}`);
  check('and the notes column keeps its own +, which this did not replace',
        Boolean(scene.add) && scene.add.col !== scene.queue.col,
        JSON.stringify(scene.add));

  console.log('\n2. it starts off, and the server agrees');
  const off = { ...scene.queue };
  check('the shape says off', off.on === false, JSON.stringify(off));
  check('and so does the server', (await serverQueue())?.enabled === false,
        JSON.stringify(await serverQueue()));
  check('naming the column it is drawn on', (await serverQueue())?.column === TODO.name,
        JSON.stringify(await serverQueue()));

  console.log('\n3. clicking it turns the queue on, on the server');
  scene = await clickToggle(scene);
  await shot('02-on');
  check('the server state flipped', (await serverQueue())?.enabled === true,
        JSON.stringify(await serverQueue()));
  check('and the shape says so too', scene.queue?.on === true, JSON.stringify(scene.queue));

  console.log('\n4. the two states are told apart by more than a colour');
  const on = { ...scene.queue };
  check('the fill changed', on.fill !== off.fill, `${off.fill} → ${on.fill}`);
  check('and so did the weight of the outline', on.strokeWidth !== off.strokeWidth,
        `${off.strokeWidth} → ${on.strokeWidth}`);
  check('the on state is filled with the column\'s own stroke', on.fill === on.stroke,
        `${on.fill} vs ${on.stroke}`);
  check('and its glyph is legible against that fill', on.textColor !== on.fill,
        `${on.textColor} on ${on.fill}`);

  console.log('\n5. the board starts draining, oldest open issue first');
  await waitFor(async () => (await stateOf(32)) === 'running', 'the oldest open issue to start');
  check('the oldest *open* issue is the one running', (await stateOf(32)) === 'running',
        JSON.stringify(await serverRuns()));
  check('the closed card above it was passed over', (await stateOf(31)) === null,
        JSON.stringify(await serverRuns()));
  check('and the cap of one is holding: nothing else started', (await stateOf(33)) === null,
        JSON.stringify(await serverRuns()));

  // The cards carry the run marks on the next poll, which is the half a reader sees.
  const drawing = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return cardFor(now, 32)?.run === 'running' ? now : null;
  }, 'the running card to be drawn as running', 240);
  await shot('03-draining');
  check('the card for it is drawn with the outline a run in flight has',
        cardFor(drawing, 32)?.strokeStyle === 'dashed' && cardFor(drawing, 32)?.strokeWidth === 2,
        JSON.stringify(cardFor(drawing, 32)));
  check('while the one that has not started carries no mark',
        cardFor(drawing, 33)?.run == null && cardFor(drawing, 33)?.strokeStyle === 'solid',
        JSON.stringify(cardFor(drawing, 33)));

  console.log('\n6. the toggle survives the poll that redrew all of that');
  // Every mirrored shape is thrown away and drawn again from GitHub on each poll. A toggle
  // whose state lived on the shape would have come back off during the wait above.
  check('still on', drawing.queue?.on === true, JSON.stringify(drawing.queue));
  check('and still drawn the on way', drawing.queue?.fill === on.fill
        && drawing.queue?.strokeWidth === on.strokeWidth, JSON.stringify(drawing.queue));
  check('with the server unchanged underneath it', (await serverQueue())?.enabled === true,
        JSON.stringify(await serverQueue()));

  console.log('\n7. one run finishes and the next starts by itself');
  release(32);
  await waitFor(async () => (await stateOf(32)) === 'done', 'the released run to finish');
  const next = await waitFor(async () => (await stateOf(33)) === 'running' ? true : null,
                             'the next issue to start on its own', 240);
  check('the slot that freed was filled without anybody clicking', next === true,
        JSON.stringify(await serverRuns()));
  const drained = await waitFor(async () => {
    const now = await evaluate(PROBE);
    return cardFor(now, 33)?.run === 'running' ? now : null;
  }, 'the board to draw the second run', 240);
  await shot('04-next-started');
  check('and the board says so: the second card is now the one in flight',
        cardFor(drained, 33)?.strokeStyle === 'dashed', JSON.stringify(cardFor(drained, 33)));
  check('while the finished one is drawn as landed rather than running',
        cardFor(drained, 32)?.run === 'done' && cardFor(drained, 32)?.strokeStyle === 'solid'
        && cardFor(drained, 32)?.strokeWidth === 2, JSON.stringify(cardFor(drained, 32)));
  const afterPoll = drained;

  console.log('\n8. clicking it again turns it off — the click a stale selection would swallow');
  scene = await clickToggle(afterPoll);
  await shot('05-off-again');
  check('the server state flipped back', (await serverQueue())?.enabled === false,
        JSON.stringify(await serverQueue()));
  check('and the shape is drawn the off way again',
        scene.queue?.on === false && scene.queue?.fill === off.fill
        && scene.queue?.strokeWidth === off.strokeWidth,
        JSON.stringify(scene.queue));
  check('the button is not left selected, which is what makes a third click possible',
        !scene.selected.includes(scene.queue?.id), JSON.stringify(scene.selected));
  check('and the run that was in flight is left alone by the switch',
        (await stateOf(33)) === 'running', JSON.stringify(await serverRuns()));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const number of [31, 32, 33, 34, 35]) {
    try { release(number); } catch { /* the world may already be gone */ }
  }
  await sleep(400);
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
