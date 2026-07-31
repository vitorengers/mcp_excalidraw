#!/usr/bin/env node
/**
 * Checks **Recreate with observations** in a real browser.
 *
 * `check-issue-recreate.mjs` covers the route, the prompt, the refusals and the memo —
 * everything that can be asked of the server. None of that puts a control on screen, and the
 * whole point of the feature is that somebody reading an issue whose first investigation went
 * the wrong way is offered a way to fix it rather than only a way to append to it. Three
 * defects in this panel have compiled perfectly and done none of what they claimed, which is
 * why this exists.
 *
 * So the questions here are the ones only a browser can answer. Does a card in Todo offer the
 * control, beside **Add observations** rather than instead of it? Do the two cards that must
 * not offer it — one in another column, one with a run against it — leave it off? Does typing
 * into the box and confirming actually start a run, with the observations reaching the agent?
 * And when the run lands, does the panel show the *new* body without the reader having to
 * click away and back — the half that neither the server memo nor the browser cache would
 * give for free?
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: a stub `gh`, a stub issue agent that holds until it is let
 * go, a stub implement agent, and a canvas server of its own. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-issue-recreate-browser.mjs [--chrome <path>] [--shots <dir>]
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
if (!chromePath) skipWithoutChrome();

if (!existsSync(join(repoRoot, 'dist', 'frontend', 'index.html'))) {
  console.error('  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}
if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  the compiled server exists — dist/server.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── A project to mirror ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-recreate-'));
const projectDir = join(workDir, 'recreate');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(projectDir, { recursive: true });
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const ghStub = join(workDir, 'gh-stub.mjs');
const agentStub = join(workDir, 'agent-stub.mjs');
const implementStub = join(workDir, 'implement-stub.mjs');
const fixturePath = join(workDir, 'fixture.json');
const storePath = join(workDir, 'issues.json');
const promptPath = join(workDir, 'revise-prompt.txt');
const releasePath = join(workDir, 'release');

const REPO = 'vitorengers/vibemaxxing';
const urlOf = (number) => `https://github.com/${REPO}/issues/${number}`;

/** Open, in Todo, nothing against it: the case the control exists for. */
const WAITING = 201;
/** Open, but in another column: past Todo there is nothing to gate on any more. */
const SHIPPED = 202;
/** Open and in Todo, but an agent has already been sent at it. */
const WORKED = 203;

const TODO = { id: 'f75ad846', name: 'Todo' };
const DOING = { id: '47fc9ee4', name: 'In Progress' };
const DONE = { id: '98236657', name: 'Done' };

const item = (id, number, title, option) => ({
  id,
  type: 'ISSUE',
  fieldValueByName: { optionId: option.id, name: option.name },
  content: {
    __typename: 'Issue',
    number,
    title,
    url: urlOf(number),
    createdAt: `2026-07-0${number - 200}T10:00:00Z`,
    state: 'OPEN',
    repository: { nameWithOwner: REPO },
  },
});

writeFileSync(fixturePath, JSON.stringify({
  data: { owner: { projectV2: {
    id: 'PVT_kwHOBVSHIs4BefUS',
    title: 'mcp_excalidraw',
    url: 'https://github.com/users/someone/projects/5',
    field: { id: 'PVTSSF_status', name: 'Status', options: [TODO, DOING, DONE] },
    items: { pageInfo: { hasNextPage: false }, nodes: [
      item('PVTI_a', WAITING, 'An investigation that went the wrong way', TODO),
      item('PVTI_b', SHIPPED, 'An issue somebody already shipped', DONE),
      item('PVTI_c', WORKED, 'An issue an agent is already on', TODO),
    ] },
  } } },
}), 'utf8');

writeFileSync(storePath, JSON.stringify(Object.fromEntries(
  [WAITING, SHIPPED, WORKED].map((number) => [number, {
    number,
    title: `Issue ${number} as gh reports it`,
    body: `The first investigation of ${number}, which went the wrong way.`,
    state: 'OPEN',
    comments: [],
  }])
)), 'utf8');

writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const store = () => JSON.parse(readFileSync(process.env.STUB_GH_ISSUES, 'utf8'));
const numberOf = () => {
  const url = args.find((argument) => argument.startsWith('https://')) ?? '';
  return /\\/(\\d+)$/.exec(url)?.[1] ?? '';
};

if (args[0] === 'issue' && args[1] === 'comment') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const all = store();
    const issue = all[numberOf()];
    if (issue) {
      issue.comments.push({
        author: { login: 'vitorengers' },
        body: input,
        createdAt: '2026-07-28T12:00:00Z',
        url: 'https://github.com/${REPO}/issues/' + issue.number + '#issuecomment-1',
      });
      writeFileSync(process.env.STUB_GH_ISSUES, JSON.stringify(all), 'utf8');
    }
    process.stdout.write('commented\\n');
  });
} else if (args[0] === 'issue' && args[1] === 'view') {
  const issue = store()[numberOf()];
  if (!issue) { process.stderr.write('stub gh: no such issue\\n'); process.exit(1); }
  process.stdout.write(JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    comments: issue.comments,
    stateReason: null,
    closedByPullRequestsReferences: [],
  }));
} else if (args.includes('graphql')) {
  process.stdout.write(readFileSync(process.env.STUB_GH_FIXTURE, 'utf8'));
} else {
  process.stdout.write('{}\\n');
}
`, 'utf8');

/**
 * The issue agent, holding until it is let go.
 *
 * Held on purpose: the claim is about two states the reader passes through, and a run that
 * finished instantly would have skipped the first. It writes down the prompt it was given, so
 * a case can ask what the agent was actually told rather than what the panel meant to say.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  writeFileSync(process.env.STUB_AGENT_PROMPT, input, 'utf8');
  const number = /issues\\/(\\d+)/.exec(input)?.[1] ?? '';
  while (!existsSync(process.env.STUB_AGENT_RELEASE)) await sleep(100);

  const all = JSON.parse(readFileSync(process.env.STUB_GH_ISSUES, 'utf8'));
  if (all[number]) {
    // What \`gh issue edit --body-file -\` does: the same number, a new body.
    all[number].body = 'Rewritten from the observations the reader typed.';
    writeFileSync(process.env.STUB_GH_ISSUES, JSON.stringify(all), 'utf8');
  }
  process.stdout.write('https://github.com/${REPO}/issues/' + number + '\\n');
});
`, 'utf8');

writeFileSync(implementStub, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('https://github.com/${REPO}/pull/900\\n');
});
`, 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'recreate', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Recreate',
  repo: REPO,
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');

// ─── The server ───────────────────────────────────────────────

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
  EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}"`,
  EXCALIDRAW_IMPLEMENT_AGENT: `node "${implementStub.replace(/\\/g, '/')}" -p`,
  STUB_GH_FIXTURE: fixturePath,
  STUB_GH_ISSUES: storePath,
  STUB_AGENT_PROMPT: promptPath,
  STUB_AGENT_RELEASE: releasePath,
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
        window.__recreateApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

const CARDS = `(() => {
  const api = window.__recreateApi;
  if (!api) return { error: 'no api handle' };
  const cards = [];
  for (const element of api.getSceneElements()) {
    const custom = element.customData || {};
    if (custom.kind === 'project-board' && custom.role === 'card') {
      cards.push({ id: element.id, url: custom.issueUrl, inTodo: custom.inTodo === true,
                   run: custom.implementState ?? null });
    }
  }
  return { cards };
})()`;

/** What the panel is showing right now, as the reader sees it. */
const PANEL = `(() => {
  const card = document.querySelector('.docs-card');
  if (!card) return { present: false };
  return {
    present: true,
    title: (card.querySelector('.element-docs__title') || {}).textContent || '',
    body: Array.from(card.querySelectorAll('.element-docs__body')).map((n) => n.textContent).join(' '),
    buttons: Array.from(card.querySelectorAll('button')).map((n) => (n.textContent || '').trim()),
    hints: Array.from(card.querySelectorAll('.element-docs__hint')).map((n) => n.textContent),
    errors: Array.from(card.querySelectorAll('.element-docs__error')).map((n) => n.textContent),
    composing: Boolean(card.querySelector('textarea.element-docs__draft')),
    draft: (card.querySelector('textarea.element-docs__draft') || {}).value ?? null,
    text: card.innerText || '',
  };
})()`;

/**
 * Select a card by driving the pointer at it, rather than by writing the selection.
 *
 * The click is the gesture under test as much as the button is: a card is a shape on a
 * canvas, and "clicking the card opens its panel" has been wrong here before.
 */
async function selectCard(number) {
  const scene = await evaluate(`(() => {
    const api = window.__recreateApi;
    const state = api.getAppState();
    const card = api.getSceneElements().find((element) =>
      (element.customData || {}).role === 'card'
      && (element.customData || {}).issueUrl === ${JSON.stringify(urlOf(number))});
    if (!card) return null;
    return {
      x: (card.x + card.width / 2 + state.scrollX) * state.zoom.value + state.offsetLeft,
      y: (card.y + card.height / 2 + state.scrollY) * state.zoom.value + state.offsetTop,
    };
  })()`);
  if (!scene) throw new Error(`no mirrored card for issue ${number}`);
  await click(scene.x, scene.y);
  await sleep(250);
}

/** Nothing selected, so the panel is unmounted and the next selection is a fresh one. */
async function deselect() {
  await evaluate('window.__recreateApi.updateScene({ appState: { selectedElementIds: {} } })');
  await sleep(400);
}

const clickButton = (label) => evaluate(`(() => {
  const button = [...document.querySelectorAll('.docs-card button')]
    .find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
  if (!button) return false;
  button.click();
  return true;
})()`);

async function panelUntil(predicate, what, ms = 30_000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < ms) {
    last = await evaluate(PANEL);
    if (predicate(last)) return last;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last).slice(0, 500)}`);
}

const offers = (panel, label) => panel.buttons.some((text) => text === label);
const RECREATE = 'Recreate with observations';

/** Everything a shell would have mangled, so the box is not the polite case. */
const OBSERVATIONS = 'The root cause is in another file entirely — $(echo hi) and `backticks`.';

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // A finished implementation against one of the Todo cards, made before the browser loads:
  // the claim is about a card the reader has never selected in this session.
  const started = await fetch(`${BASE}/api/implement?workspace=recreate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: urlOf(WORKED) }),
  });
  if (started.status !== 202) {
    throw new Error(`could not start the stub run: ${started.status}\n${serverLog}`);
  }
  await waitFor(async () => {
    const response = await fetch(
      `${BASE}/api/implement?workspace=recreate&url=${encodeURIComponent(urlOf(WORKED))}`);
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
  await waitFor(async () => (await evaluate(CARDS)).cards?.length >= 3, 'the mirror to render');

  // Alt+B fits the mirror to the viewport, the way a reader brings it into view.
  await pressKey('KeyB', 'b', 1, 66);
  await sleep(1200);
  await shot('01-mirror');

  console.log('1. the mirror marks which cards are still waiting');
  const drawn = await evaluate(CARDS);
  const cardFor = (number) => drawn.cards.find((card) => card.url === urlOf(number));
  check('the card in Todo is marked', cardFor(WAITING)?.inTodo === true, JSON.stringify(drawn.cards));
  check('the card in another column is not', cardFor(SHIPPED)?.inTodo !== true, JSON.stringify(drawn.cards));
  check('and the mirror already knows about the run on the third',
        cardFor(WORKED)?.run === 'done', JSON.stringify(drawn.cards));

  console.log('\n2. a card in Todo offers to have its issue researched again');
  await selectCard(WAITING);
  const waiting = await panelUntil((panel) => panel.present && /went the wrong way/.test(panel.body),
                                   'the Todo card to open with its issue read');
  await shot('02-offered');
  check('Recreate with observations is on screen', offers(waiting, RECREATE),
        JSON.stringify(waiting.buttons));
  check('and adding observations is still offered beside it',
        offers(waiting, 'Add observations'), JSON.stringify(waiting.buttons));
  check('as is implementing it', offers(waiting, 'Implement / Fix'), JSON.stringify(waiting.buttons));

  console.log('\n3. the two cards that must not offer it do not');
  await deselect();
  await selectCard(SHIPPED);
  const shipped = await panelUntil((panel) => panel.present && /went the wrong way/.test(panel.body),
                                   'the shipped card to open');
  await shot('03-not-in-todo');
  check('a card outside Todo does not offer it', !offers(shipped, RECREATE),
        JSON.stringify(shipped.buttons));
  check('while Add observations survives there', offers(shipped, 'Add observations'),
        JSON.stringify(shipped.buttons));

  await deselect();
  await selectCard(WORKED);
  const worked = await panelUntil((panel) => panel.present && /pull\/900/.test(panel.text),
                                  'the implemented card to open');
  await shot('04-already-implemented');
  check('a card with a run against it does not offer it, Todo or not',
        !offers(worked, RECREATE), JSON.stringify(worked.buttons));

  console.log('\n4. typing into the box and confirming starts a run');
  await deselect();
  await selectCard(WAITING);
  await panelUntil((panel) => offers(panel, RECREATE), 'the control to come back');
  check('the control responded to a click', await clickButton(RECREATE));
  const opened = await panelUntil((panel) => panel.composing, 'the observations box to open');
  await shot('05-box-open');
  check('a box opened to write in', opened.composing);
  check('and it is not the comment box: the confirm says what it will do',
        offers(opened, 'Research it again'), JSON.stringify(opened.buttons));

  await evaluate(`(() => {
    document.querySelector('textarea.element-docs__draft').focus();
    return true;
  })()`);
  await send('Input.insertText', { text: OBSERVATIONS });
  await sleep(200);
  const typed = await evaluate(PANEL);
  check('the observations reached the box, byte for byte', typed.draft === OBSERVATIONS,
        JSON.stringify(typed.draft));

  check('the confirm responded to a click', await clickButton('Research it again'));
  const running = await panelUntil(
    (panel) => panel.hints.some((hint) => /investigating this issue again/i.test(hint ?? '')),
    'the panel to say a run is under way');
  await shot('06-running');
  check('the panel says an agent is on it', true);
  check('the box is put away', !running.composing, JSON.stringify(running.draft));
  check('and the control is gone while the run is going', !offers(running, RECREATE),
        JSON.stringify(running.buttons));

  console.log('\n5. the agent was told which issue, and what is new about it');
  await waitFor(async () => existsSync(promptPath), 'the agent to be spawned');
  const prompt = readFileSync(promptPath, 'utf8');
  check('it was given the issue', prompt.includes(urlOf(WAITING)), prompt.slice(0, 200));
  check('and the observations, byte for byte', prompt.includes(OBSERVATIONS),
        'what the reader typed did not reach the agent unchanged');
  check('told to rewrite in place', /gh issue edit/.test(prompt), prompt.slice(0, 400));

  console.log('\n6. when the run lands, the panel shows the new body with no reselection');
  writeFileSync(releasePath, '', 'utf8');
  const rewritten = await panelUntil((panel) => /Rewritten from the observations/.test(panel.body),
                                     'the rewritten body to appear on its own');
  await shot('07-rewritten');
  check('the new body is on screen without the reader touching anything',
        /Rewritten from the observations/.test(rewritten.body), rewritten.body.slice(0, 200));
  check('the panel says the issue was rewritten',
        rewritten.hints.some((hint) => /rewritten/i.test(hint ?? '')), JSON.stringify(rewritten.hints));
  check('nothing failed', rewritten.errors.length === 0, JSON.stringify(rewritten.errors));
  check('and the observations are on the issue as a comment too',
        /1 comment/.test(rewritten.text), rewritten.text.slice(-400));

  console.log('\n7. it is the same issue, and reselecting it agrees');
  await deselect();
  await selectCard(WAITING);
  const reselected = await panelUntil((panel) => panel.present && Boolean(panel.body),
                                      'the card to open again');
  await shot('08-reselected');
  check('the body is still the rewritten one', /Rewritten from the observations/.test(reselected.body),
        reselected.body.slice(0, 200));
  check('and it is still issue 201', /Issue 201/.test(reselected.title), reselected.title);
  const stored = JSON.parse(readFileSync(storePath, 'utf8'))[String(WAITING)];
  check('with its number unchanged on GitHub', stored?.number === WAITING, JSON.stringify(stored).slice(0, 200));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { writeFileSync(releasePath, '', 'utf8'); } catch { /* already gone */ }
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(600);
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  await sleep(400);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
