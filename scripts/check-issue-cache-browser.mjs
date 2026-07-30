#!/usr/bin/env node
/**
 * Checks the remembered issue in a real browser.
 *
 * `check-issue-cache.mjs` covers the resolver and the server; this covers the half that has
 * burnt this project before — what the panel actually paints. The report was about a
 * *frame*: click a block and, for the whole of the second `gh issue view` takes, it says
 * *"Reading the issue…"* and offers **Implement / Fix** on an issue that is closed or
 * already being implemented. That is not a claim any amount of compiling can settle.
 *
 * So the stub `gh` here sleeps two seconds on every read, and every case is asserted on
 * whatever is on screen within half a second of the click. Anything correct in that window
 * was correct before the read landed.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it writes a stub `gh` and a stub implement agent,
 * starts its own canvas server against a throwaway workspace, and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-issue-cache-browser.mjs [--chrome <path>] [--shots <dir>]
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

// ─── A project to mirror, and a gh that takes its time ────────

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-cache-'));
const projectDir = join(workDir, 'issue-cache');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const ghStub = join(workDir, 'gh-stub.mjs');
const agentStub = join(workDir, 'agent-stub.mjs');
const fixturePath = join(workDir, 'fixture.json');
const counterPath = join(workDir, 'gh-calls.log');
const versionPath = join(workDir, 'body-version.txt');
const registryPath = join(workDir, 'workspaces.json');

writeFileSync(counterPath, '', 'utf8');
writeFileSync(versionPath, 'one', 'utf8');

const REPO = 'vitorengers/mcp_excalidraw';
const urlOf = (number) => `https://github.com/${REPO}/issues/${number}`;

/** Open, nothing against it: the plain case the report was written about. */
const PLAIN = 3;
/** Closed and shipped: must never offer to be implemented, on any selection after the first read. */
const CLOSED = 21;
/** Already implemented: must never offer it at all, including before the first read lands. */
const WORKED = 9;

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, title, createdAt, option) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: urlOf(number),
    createdAt,
    state: 'OPEN',
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
      item('PVTI_a', PLAIN, 'A plain open issue', '2026-07-01T10:00:00Z', TODO),
      item('PVTI_b', CLOSED, 'An issue already shipped', '2026-07-20T10:00:00Z', TODO),
      item('PVTI_d', WORKED, 'An issue being worked on', '2026-07-05T10:00:00Z', DOING),
    ] },
  } } },
}), 'utf8');

// Two seconds per read, which is the whole point: every assertion below is taken well
// inside that window, so nothing that passes can have been fed by the read.
writeFileSync(ghStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const url = args.find((candidate) => candidate.startsWith('https://')) ?? '';

if (args.includes('issue') && args.includes('view')) {
  appendFileSync(process.env.STUB_GH_COUNTER, url + '\\n');
  await new Promise((resolve) => setTimeout(resolve, Number(process.env.STUB_GH_SLEEP_MS ?? 0)));
  const version = readFileSync(process.env.STUB_GH_VERSION, 'utf8').trim();
  const number = Number(url.split('/').pop());
  const closed = number === ${CLOSED};
  process.stdout.write(JSON.stringify({
    number,
    title: 'Issue ' + number + ' as gh reports it',
    body: 'Body version ' + version + ' of issue ' + number + '.',
    state: closed ? 'CLOSED' : 'OPEN',
    comments: [],
    stateReason: closed ? 'COMPLETED' : null,
    closedByPullRequestsReferences: [],
  }));
} else if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

// Ends the way a real implement agent ends: a pull request URL on stdout.
writeFileSync(agentStub, `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', () => {
  process.stdout.write('https://github.com/${REPO}/pull/999\\n');
});
`, 'utf8');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'issue-cache', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Issue Cache Check',
  repo: REPO,
  githubProject: 'https://github.com/users/vitorengers/projects/5',
}), 'utf8');

const PORT = 34900 + (process.pid % 300);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
/**
 * Off, so that one selection is one `gh` and the count below means something.
 *
 * The server memo is what stops a burst of clicks becoming a burst of `gh` processes, and
 * `check-issue-cache.mjs` counts that, against a clock it controls because no browser is in
 * the way. Here it was merely turned *down*, to four seconds, which left it half in: what a
 * `gh` count measured was not the panel's behaviour but whether two consecutive clicks
 * happened to fall inside four seconds of each other — and clicking away between them costs
 * about five, since three of the six points `deselect` can reach sit under Excalidraw's own
 * left-hand properties island, which is on screen precisely because something is selected.
 * So the two counts in section 7 were assertions about how fast this script runs.
 *
 * Turned off entirely instead. Every selection then reaches the stub, which is what makes
 * *one read per selection, and never two* checkable here at all: with the memo on, a panel
 * that read twice for one click would have had the second read swallowed and counted the
 * same as a correct one.
 */
const MEMO_MS = 0;
const GH_SLEEP_MS = 2000;

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
    EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p`,
    EXCALIDRAW_ISSUE_MEMO_MS: String(MEMO_MS),
    STUB_GH_FIXTURE: fixturePath,
    STUB_GH_COUNTER: counterPath,
    STUB_GH_VERSION: versionPath,
    STUB_GH_SLEEP_MS: String(GH_SLEEP_MS),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
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
}

async function pressKey(code, key, modifiers = 0, windowsVirtualKeyCode = undefined) {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, modifiers, windowsVirtualKeyCode });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, modifiers, windowsVirtualKeyCode });
  await sleep(150);
}

/** The Excalidraw imperative API, reached through the container's React fibre. */
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
  const cards = [];
  const sections = [];
  const clickable = [];
  const carried = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    const box = { x: element.x, y: element.y, w: element.width, h: element.height };
    if (custom.kind === 'project-board' && custom.role === 'card') {
      cards.push({ id: element.id, ...box, url: custom.issueUrl, run: custom.implementState ?? null });
    }
    if (custom.kind === 'project-board' && custom.role === 'section') {
      sections.push({ id: element.id, ...box, optionId: custom.sectionOptionId });
    }
    // A locked shape is click-through, so only the rest can swallow a click meant for the
    // canvas — which is what deselecting has to land on.
    if (!element.locked) clickable.push(box);
    if (custom && Object.keys(custom).length) {
      carried.push({ id: element.id, keys: Object.keys(custom), json: JSON.stringify(custom) });
    }
  }
  const state = api.getAppState();
  const panel = document.querySelector('.docs-card');
  const rect = panel ? panel.getBoundingClientRect() : null;
  return {
    cards,
    sections,
    clickable,
    carried,
    selected: Object.keys(state.selectedElementIds || {}),
    panel: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : null,
    window: { width: window.innerWidth, height: window.innerHeight },
    view: { scrollX: state.scrollX, scrollY: state.scrollY, zoom: state.zoom.value,
            offsetLeft: state.offsetLeft, offsetTop: state.offsetTop },
  };
})()`;

/**
 * Watch the card for a window of time, rather than sampling it once.
 *
 * The claim under test is about frames the reader sees, and a single sample cannot express
 * either half of it: *"it never said Reading the issue"* and *"it never offered
 * Implement / Fix"* are statements about every frame in the window, not about one. So this
 * samples throughout and reports what was ever seen, alongside the first and last frames.
 *
 * The window is always far shorter than the two seconds the stub `gh` sleeps, so anything
 * this saw was painted before the read behind it could have landed.
 */
const watching = (ms) => `(async () => {
  const started = Date.now();
  const shotOf = (card) => {
    const text = card.innerText || '';
    return {
      reading: /Reading the issue/.test(text),
      title: (card.querySelector('.element-docs__title') || {}).textContent || '',
      body: Array.from(card.querySelectorAll('.element-docs__body')).map((node) => node.textContent).join(' '),
      buttons: Array.from(card.querySelectorAll('button')).map((node) => (node.textContent || '').trim()),
      text,
    };
  };
  let waited = null, first = null, last = null, samples = 0;
  let everReading = false, everOffered = false;
  while (Date.now() - started < ${ms}) {
    const card = document.querySelector('.docs-card');
    if (card) {
      const now = shotOf(card);
      samples++;
      if (waited === null) { waited = Date.now() - started; first = now; }
      last = now;
      if (now.reading) everReading = true;
      if (now.buttons.some((label) => /Implement \\/ Fix/.test(label))) everOffered = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return { present: samples > 0, samples, waited, first, last, everReading, everOffered };
})()`;

const SNAPSHOT = `(() => {
  const card = document.querySelector('.docs-card');
  if (!card) return { present: false };
  const text = card.innerText || '';
  return {
    present: true,
    reading: /Reading the issue/.test(text),
    title: (card.querySelector('.element-docs__title') || {}).textContent || '',
    body: Array.from(card.querySelectorAll('.element-docs__body')).map((node) => node.textContent).join(' '),
    buttons: Array.from(card.querySelectorAll('button')).map((node) => (node.textContent || '').trim()),
    text,
  };
})()`;

const toViewport = (view, x, y) => ({
  x: (x + view.scrollX) * view.zoom + view.offsetLeft,
  y: (y + view.scrollY) * view.zoom + view.offsetTop,
});

const ghReads = (url) => readFileSync(counterPath, 'utf8')
  .split('\n').filter((line) => line.trim() && (!url || line.trim() === url)).length;

/**
 * Every card this script has clicked, in order.
 *
 * Section 7 counts reads against this rather than against numbers written by hand: what a
 * read has to be is *one per selection*, so the expectation is the selections themselves,
 * and adding a case above cannot leave a stale total below.
 */
const selections = [];

/** Click the card for an issue and watch what the panel paints while the read is in flight. */
async function selectIssue(number, ms = 600) {
  selections.push(number);
  const scene = await evaluate(PROBE);
  const card = scene.cards.find((candidate) => candidate.url === urlOf(number));
  if (!card) throw new Error(`no mirrored card for issue ${number}: ${JSON.stringify(scene.cards)}`);
  const at = toViewport(scene.view, card.x + card.w / 2, card.y + card.h / 2);
  await click(at.x, at.y);
  return { card, watch: await evaluate(watching(ms)) };
}

/**
 * Click away, the way the report describes it.
 *
 * Onto the board rather than onto a keyboard shortcut, and onto a column rather than a
 * guessed empty coordinate: a mirror section is drawn locked, so it is click-through, and
 * a click that lands on one is a click on the canvas. The point is chosen away from every
 * unlocked shape and from wherever the card itself currently sits.
 */
async function deselect() {
  const scene = await evaluate(PROBE);
  const inside = (box, point) =>
    point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h;

  const candidates = [];
  for (const section of scene.sections) {
    for (const fraction of [0.9, 0.75, 0.6]) {
      candidates.push(toViewport(scene.view, section.x + section.w / 2, section.y + section.h * fraction));
    }
  }

  const free = candidates.filter((point) =>
    point.x > 20 && point.x < scene.window.width - 20
    && point.y > 140 && point.y < scene.window.height - 90
    && !scene.clickable.some((box) => inside(
        { ...toViewport(scene.view, box.x, box.y), w: box.w * scene.view.zoom, h: box.h * scene.view.zoom },
        point))
    && !(scene.panel && inside(scene.panel, point)));
  if (!free.length) throw new Error(`nowhere free to click away to: ${JSON.stringify(scene).slice(0, 400)}`);

  const gone = `(async () => {
    const started = Date.now();
    while (Date.now() - started < 1200) {
      if (!document.querySelector('.docs-card')) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  })()`;

  // Every free point in turn: the card follows the shape it belongs to, so which parts of
  // the board it covers changes with the selection, and one candidate being under it is not
  // a reason to give up on the board.
  for (const point of free) {
    await click(point.x, point.y);
    if (await evaluate(gone)) return;
  }
  await shot('xx-could-not-click-away');
  throw new Error(`the card was still on screen after clicking away at ${JSON.stringify(free)}`);
}

/** Wait for the read behind a selection to land — or for the panel to settle on something. */
async function panelUntil(predicate, what, ms = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < ms) {
    last = await evaluate(SNAPSHOT);
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last).slice(0, 400)}`);
}

const offersImplement = (panel) => panel.buttons.some((label) => /Implement \/ Fix/.test(label));
const offersObservations = (panel) => panel.buttons.some((label) => /Add observations/.test(label));

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // A finished implementation against one of the mirrored issues, made before the browser
  // ever loads: the claim is about a card the reader has never selected in this session.
  const started = await fetch(`${BASE}/api/implement?workspace=issue-cache`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: urlOf(WORKED) }),
  });
  if (started.status !== 202) {
    throw new Error(`could not start the stub run: ${started.status} `
      + `${JSON.stringify(await started.json().catch(() => ({})))}\n${serverLog}`);
  }
  await waitFor(async () => {
    const response = await fetch(
      `${BASE}/api/implement?workspace=issue-cache&url=${encodeURIComponent(urlOf(WORKED))}`);
    return (await response.json())?.implement?.state === 'done';
  }, 'the stub implementation to finish');

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
  await waitFor(async () => (await evaluate(PROBE)).cards.length >= 3, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  await shot('01-mirror');

  console.log('1. the first selection of an issue does read it — the stub is genuinely slow');
  const firstPlain = await selectIssue(PLAIN);
  await shot('02-first-selection');
  check('the card opened', firstPlain.watch.present, JSON.stringify(firstPlain.watch).slice(0, 240));
  check('and said it was reading the issue', firstPlain.watch.everReading,
        `after ${firstPlain.watch.waited}ms: ${firstPlain.watch.last?.text?.slice(0, 200)}`);
  const loadedPlain = await panelUntil((panel) => /Body version one of issue 3/.test(panel.body),
                                       'the first read to land');
  check('the body arrived', /Body version one of issue 3/.test(loadedPlain.body), loadedPlain.body);
  check('and an open issue with no run offers Implement / Fix', offersImplement(loadedPlain),
        JSON.stringify(loadedPlain.buttons));

  // "At once" is the claim, not "without reading again": the panel revalidates on every
  // selection by design, and section 7 counts that. What the cache buys is this frame.
  console.log('\n2. selecting it again paints it at once, without waiting for the read behind it');
  await deselect();
  const again = await selectIssue(PLAIN);
  await shot('03-second-selection');
  check(`the card was back within ${again.watch.waited}ms`, again.watch.present);
  check('and never said "Reading the issue…" once', again.watch.everReading === false,
        again.watch.first?.text?.slice(0, 200));
  // The title GitHub gave it, not the label the card is drawn with — the card's own text is
  // there whether the issue was ever read or not, so it would prove nothing.
  check('the title GitHub gave it was already there on the first frame',
        /Issue 3 as gh reports it/.test(again.watch.first?.title ?? ''), again.watch.first?.title);
  check('and the body with it', /Body version one of issue 3/.test(again.watch.first?.body ?? ''),
        again.watch.first?.body);
  check('with the same buttons as before',
        offersImplement(again.watch.first) && offersObservations(again.watch.first),
        JSON.stringify(again.watch.first?.buttons));
  check('well inside the two seconds a read takes', again.watch.waited < 400, `${again.watch.waited}ms`);

  console.log('\n3. a card whose issue is already implemented never offers to implement it');
  await deselect();
  const beforeSelecting = await evaluate(PROBE);
  check('the mirror had already written the run onto the card',
        beforeSelecting.cards.find((card) => card.url === urlOf(WORKED))?.run === 'done',
        JSON.stringify(beforeSelecting.cards));
  const worked = await selectIssue(WORKED);
  await shot('04-worked-on');
  check('the card opened', worked.watch.present);
  check('it is the first selection, so it is still reading',
        worked.watch.everReading, worked.watch.last?.text?.slice(0, 200));
  check('and yet Implement / Fix is offered on no frame of that second',
        worked.watch.everOffered === false, JSON.stringify(worked.watch.first?.buttons));
  check('while Add observations still is', offersObservations(worked.watch.first),
        JSON.stringify(worked.watch.first?.buttons));
  const workedLoaded = await panelUntil((panel) => /Body version one of issue 9/.test(panel.body),
                                        'the run card\'s read to land');
  check('and it stays that way once the read lands', offersImplement(workedLoaded) === false,
        JSON.stringify(workedLoaded.buttons));
  check('with the pull request it produced', /pull\/999/.test(workedLoaded.text), workedLoaded.text.slice(0, 300));

  console.log('\n4. a closed issue stops offering to be implemented, and stays stopped');
  await deselect();
  await selectIssue(CLOSED);
  const closedLoaded = await panelUntil((panel) => /Body version one of issue 21/.test(panel.body),
                                        'the closed issue to be read');
  check('once read, it does not offer Implement / Fix', offersImplement(closedLoaded) === false,
        JSON.stringify(closedLoaded.buttons));
  await deselect();
  const closedAgain = await selectIssue(CLOSED);
  await shot('05-closed-again');
  check('and on the next selection it offers it on no frame either',
        closedAgain.watch.everReading === false && closedAgain.watch.everOffered === false,
        `${closedAgain.watch.waited}ms: ${JSON.stringify(closedAgain.watch.first?.buttons)}`);
  check('Add observations survives on a closed issue', offersObservations(closedAgain.watch.first),
        JSON.stringify(closedAgain.watch.first?.buttons));

  console.log('\n5. what is remembered is still revalidated — an edit on GitHub arrives');
  writeFileSync(versionPath, 'two', 'utf8');
  await deselect();
  const stale = await selectIssue(PLAIN);
  check('the remembered copy is what paints first, not a spinner',
        stale.watch.everReading === false && /version one/.test(stale.watch.first?.body ?? ''),
        `${stale.watch.waited}ms: ${stale.watch.first?.body}`);
  const revalidated = await panelUntil((panel) => /Body version two of issue 3/.test(panel.body),
                                       'the revalidation to land');
  check('and the new body replaces it, one selection later, with no reload',
        /Body version two of issue 3/.test(revalidated.body), revalidated.body);
  check('without ever showing "Reading the issue…" in between', revalidated.reading === false,
        revalidated.text?.slice(0, 200));

  console.log('\n6. none of it was written onto the board');
  const finalScene = await evaluate(PROBE);
  // `issueState` is deliberately not on this list: on an authored block it is the block's
  // own stage, which belongs on the element. What must never land there is the issue itself.
  const leaked = finalScene.carried.filter((element) =>
    /Body version/.test(element.json)
    || element.keys.some((key) => /^(body|comments|issueBody|githubState|stateReason)$/.test(key)));
  check('no element carries an issue body, its comments or its GitHub state',
        leaked.length === 0, JSON.stringify(leaked).slice(0, 400));
  check('the cards still carry only what the mirror draws them from',
        finalScene.cards.every((card) => card.url && typeof card.url === 'string'),
        JSON.stringify(finalScene.cards));

  // A selection is a read, and a read is a selection. Stale-while-revalidate means the panel
  // asks again every time a card is chosen — that is what the cache above buys the frame for,
  // not freshness — so what is checkable is the *rate*: never twice for one click, and never
  // once for a card nobody clicked. A mirror that read every card it drew, or an effect that
  // re-fired on a render, would both land here and nowhere else in this file.
  console.log('\n7. and the reads were the ones a read had to be');
  const selectedTimes = (number) => selections.filter((candidate) => candidate === number).length;
  for (const number of [PLAIN, WORKED, CLOSED]) {
    check(`issue ${number} was read once per selection, over ${selectedTimes(number)} of them`,
          ghReads(urlOf(number)) === selectedTimes(number),
          `${ghReads(urlOf(number))} gh invocations`);
  }
  check('and nothing was read that no click had asked for',
        ghReads(null) === selections.length,
        `${ghReads(null)} gh invocations for ${selections.length} selections`);
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
