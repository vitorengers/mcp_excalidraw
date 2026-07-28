#!/usr/bin/env node
/**
 * Checks, in a real browser, that starting an implementation puts a tab on the board.
 *
 * `check-implement-terminal.mjs` covers the server: a run opens a session, the session says
 * whose it is and starts in the worktree, its output is broadcast while it is alive, and the
 * run settles either way. None of that says anything appears on a board, and this repository
 * has paid for the distinction repeatedly — a panel that never opened, a race in tab
 * initialisation, a click landing on the label rather than on the box. All of them compiled.
 *
 * So the questions here are the ones only a browser can answer. Does a tab appear **with no
 * click**, from an implementation nobody opened a terminal for? Is it labelled with the issue
 * rather than with the next number in the sequence, so it is not mistaken for a shell the
 * reader started? Does its screen actually draw the agent's output as the agent writes it?
 * And, after all of that, is the block still a block — selectable, and resizable by its own
 * corner — which is the question every pointer-taking region on this overlay exists to be
 * asked.
 *
 * The agent is a stub that prints, pauses, prints again and waits to be released, so the
 * board is looked at while the run is live rather than after it. Nothing here talks to
 * GitHub.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Run `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the
 * built frontend.
 *
 * Usage: node scripts/check-implement-terminal-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── A project an implementation can run in ───────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-implement-terminal-'));
const projectDir = join(workDir, 'run-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// A real repository, because a run gets a worktree of its own and a worktree needs one.
git(projectDir, ['init', '-b', 'main']);
git(projectDir, ['config', 'user.email', 'check@example.com']);
git(projectDir, ['config', 'user.name', 'Check']);
git(projectDir, ['config', 'commit.gpgsign', 'false']);
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Run Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');
writeFileSync(join(projectDir, 'README.md'), '# run project\n', 'utf8');
git(projectDir, ['add', '.']);
git(projectDir, ['commit', '-m', 'initial']);

const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'run-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

/**
 * The implement agent, in as few lines as still make a run.
 *
 * It reads the prompt off stdin, prints a word, waits, prints another, and then waits to be
 * released before printing a pull request URL. The wait is what keeps the run alive long
 * enough for a browser to be looked at; the two words are what makes "the screen is drawing
 * the run as it happens" something a screenshot of the DOM can settle.
 */
const agentStub = join(workDir, 'agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  const number = (input.match(/\\/issues\\/(\\d+)/) ?? [])[1] ?? '0';
  process.stdout.write('open' + 'ing the repository\\n');
  await new Promise((resolve) => setTimeout(resolve, 900));
  process.stdout.write('read' + 'ing the issue\\n');
  for (let attempt = 0; attempt < 900; attempt++) {
    if (existsSync(workDir + '/release')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/vitorengers/mcp_excalidraw/pull/' + number + '\\n');
});
`, 'utf8');

const PORT = 35950 + (process.pid % 250);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const ISSUE = 'https://github.com/vitorengers/mcp_excalidraw/issues/128';
const children = [];

let serverLog = '';
const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  // Both switches on, which is the case the feature exists for. The shell is a stub that
  // does nothing, because nothing here opens one — it is only what the *browser* opens for
  // itself on load, and a PowerShell per run would be a second thing on the board.
  EXCALIDRAW_TERMINAL: `node -e "setInterval(()=>{},1000)"`,
  EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
};
delete serverEnv.EXCALIDRAW_TERMINAL_PTY;

const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(server);
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

async function waitFor(fn, what, tries = 160) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

const api = (path, options = {}) => request(
  `${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`,
  { headers: { 'Content-Type': 'application/json' }, ...options }
);

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();
const consoleLines = [];

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
      consoleLines.push(`${message.params.type}: ${message.params.args
        .map((arg) => arg.value ?? arg.description ?? arg.type).join(' ')}`);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`exception: ${message.params.exceptionDetails?.exception?.description
        ?? message.params.exceptionDetails?.text}`);
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
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(350);
}

/** A drag, in steps: Excalidraw resizes on pointer moves, not on where the pointer lands. */
async function drag(from, to, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= steps; step++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: from.x + ((to.x - from.x) * step) / steps,
      y: from.y + ((to.y - from.y) * step) / steps,
      button: 'left',
      buttons: 1,
    });
    await sleep(25);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(400);
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
        window.__runCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** The board, and every terminal card drawn on it. */
const PROBE = `(() => {
  const api = window.__runCheckApi;
  if (!api) return { error: 'no api handle' };
  const middle = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, width: box.width, height: box.height };
  };
  const out = { blocks: [], cards: [] };
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'terminal') {
      out.blocks.push({ id: element.id, x: element.x, y: element.y, w: element.width, h: element.height,
                        sessions: custom.sessions || [], active: custom.active || '' });
    }
  }
  const state = api.getAppState();
  out.view = { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value };
  out.selected = Object.keys(state.selectedElementIds || {}).filter((id) => state.selectedElementIds[id]);

  for (const card of document.querySelectorAll('.terminal-card')) {
    const box = card.getBoundingClientRect();
    out.cards.push({
      left: box.left, top: box.top, width: box.width, height: box.height,
      tabs: [...card.querySelectorAll('.terminal-card__tab')].map((tab) => ({
        id: tab.getAttribute('data-session'),
        label: (tab.querySelector('.terminal-card__tab-label') || {}).textContent || '',
        title: tab.getAttribute('title') || '',
        active: tab.classList.contains('terminal-card__tab--active'),
        at: middle(tab),
      })),
      screen: [...card.querySelectorAll('.terminal-card__screen')]
        .map((screen) => screen.textContent || '').join(' '),
    });
  }
  return out;
})()`;

const fitBlocks = async () => {
  await evaluate(`(() => {
    const api = window.__runCheckApi;
    const blocks = api.getSceneElements().filter((element) => (element.customData || {}).kind === 'terminal');
    if (blocks.length) api.scrollToContent(blocks, { fitToViewport: true });
    return blocks.length;
  })()`);
  await sleep(700);
};

/** Which card is showing the run, wherever the board put it. */
const runCard = (scene) => scene.cards.find((card) => card.tabs.some((tab) => tab.label.includes('#128')));
const runTab = (scene) => runCard(scene)?.tabs.find((tab) => tab.label.includes('#128')) ?? null;

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
  // The board opens one shell for itself on load. Waiting for it first is what makes the
  // next case about a tab that *arrived*, rather than about one that was already there.
  await waitFor(async () => (await evaluate(PROBE)).cards.length > 0, 'the board to open its own shell');
  const before = await evaluate(PROBE);
  const tabsBefore = before.cards.reduce((total, card) => total + card.tabs.length, 0);

  console.log('1. starting a run puts a tab on the board, with nobody clicking for one');
  const accepted = await api('/api/implement', { method: 'POST', body: JSON.stringify({ url: ISSUE }) });
  check('the run was accepted', accepted.status === 202, String(accepted.status));

  await waitFor(async () => Boolean(runTab(await evaluate(PROBE))), 'the run to draw itself a tab');
  await fitBlocks();
  let scene = await evaluate(PROBE);
  await shot('01-tab-appeared');

  const tab = runTab(scene);
  check('a tab appeared that nobody opened',
        scene.cards.reduce((total, card) => total + card.tabs.length, 0) === tabsBefore + 1,
        `${tabsBefore} before, ${scene.cards.reduce((total, card) => total + card.tabs.length, 0)} after`);
  check('and it is labelled with the issue rather than with its number',
        tab?.label === '#128', JSON.stringify(tab?.label));
  check('with the issue itself a hover away',
        (tab?.title ?? '').includes(ISSUE), tab?.title);
  check('the block still knows the session by its id',
        scene.blocks.some((block) => block.sessions.includes(tab?.id)),
        JSON.stringify(scene.blocks.map((block) => block.sessions)));

  console.log('\n2. the screen draws the run while the run is still going');
  await waitFor(async () => (runCard(await evaluate(PROBE))?.screen ?? '').includes('opening the repository'),
                'the first thing the agent printed');
  const midRun = await (await api(`/api/implement?url=${encodeURIComponent(ISSUE)}`)).json();
  check('the run is still going while the board is showing it',
        midRun?.implement?.state === 'running', JSON.stringify(midRun?.implement));
  check('and the record points at the tab it is in',
        midRun?.implement?.terminal === tab?.id,
        `${JSON.stringify(midRun?.implement?.terminal)} against ${tab?.id}`);

  await waitFor(async () => (runCard(await evaluate(PROBE))?.screen ?? '').includes('reading the issue'),
                'the second thing the agent printed');
  scene = await evaluate(PROBE);
  await shot('02-streaming');
  check('both lines are on the screen, in the order they were written',
        (runCard(scene)?.screen ?? '').indexOf('opening the repository')
          < (runCard(scene)?.screen ?? '').indexOf('reading the issue'),
        JSON.stringify(runCard(scene)?.screen?.slice(0, 200)));

  console.log('\n3. the block is still a block underneath it');
  scene = await evaluate(PROBE);
  const card = runCard(scene);
  const block = scene.blocks.find((one) => one.sessions.includes(tab?.id));
  // The header's bottom-left, which is the strip of the card that gives the pointer back to
  // the canvas — the middle of the row is where the font buttons and the mode chip are.
  await click(card.left + 6, card.top + 4);
  scene = await evaluate(PROBE);
  check('clicking its header selects the shape', scene.selected.includes(block?.id),
        JSON.stringify(scene.selected));

  const widthBefore = block?.w ?? 0;
  const corner = { x: card.left + card.width, y: card.top + card.height };
  await drag(corner, { x: corner.x + 140, y: corner.y + 90 });
  scene = await evaluate(PROBE);
  await shot('03-resized');
  const resized = scene.blocks.find((one) => one.id === block?.id);
  check('and its own corner still resizes it', (resized?.w ?? 0) > widthBefore + 60,
        `${widthBefore} became ${resized?.w}`);
  check('the tab is still there afterwards', Boolean(runTab(scene)),
        JSON.stringify(scene.cards.map((one) => one.tabs.map((each) => each.label))));

  console.log('\n4. the run settles, and nothing about it was ever saved');
  writeFileSync(join(workDir, 'release'), '', 'utf8');
  const settled = await waitFor(async () => {
    const body = await (await api(`/api/implement?url=${encodeURIComponent(ISSUE)}`)).json();
    return body?.implement?.state && body.implement.state !== 'running' ? body.implement : null;
  }, 'the run to settle');
  check('it finished', settled.state === 'done', JSON.stringify(settled));
  check('with the pull request it printed', /\/pull\/128$/.test(settled.url ?? ''), settled.url);

  await sleep(800);
  await shot('04-settled');
  const stored = await (await api('/api/elements')).json();
  check('no terminal block reached the store',
        !stored.elements.some((element) => element.customData?.kind === 'terminal'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
  check('and no session id did either',
        !JSON.stringify(stored.elements).includes('"sessions"'),
        JSON.stringify(stored.elements.map((element) => element.customData)));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  const complaints = consoleLines.filter((line) => !line.startsWith('log:')).slice(-12);
  if (complaints.length > 0) console.error(`the page said:\n${complaints.join('\n')}`);
  if (server.exitCode !== null) console.error(`the canvas server exited (${server.exitCode}):\n${serverLog}`);
} finally {
  try { writeFileSync(join(workDir, 'release'), '', 'utf8'); } catch { /* the world may be gone */ }
  await sleep(400);
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(700);
  if (existsSync(projectDir)) git(projectDir, ['worktree', 'prune']);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  } else {
    console.log(`\nscreenshots in ${shotDir}`);
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
