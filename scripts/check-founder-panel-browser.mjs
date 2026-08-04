#!/usr/bin/env node
/**
 * Checks the founder-action panel in a browser: what it says, what it offers, and what it does.
 *
 * The card face carries one line and nothing else — `cardText` builds `#N Title` and `label`
 * centres it at roughly 32 characters a line — so the why, the steps and the conversation can
 * only be read in the panel. Before this there was no panel body for a founder card at all:
 * selecting one opened the anchored card with nothing in it, and there was no compose box.
 *
 * Why a browser, and why not a unit test. Every claim here is about what a reader gets:
 * whether `Evidence` is closed on the frame the card opens, whether a refusal stays on screen
 * instead of the panel closing under it, whether a second **Ask** can be pressed while one is
 * in flight, whether a revision reaches the steps without a reload. None of that is answerable
 * by asking a function what it returns — a `<details>` with no `open` attribute and a
 * `<details open>` compile identically, and only the DOM can be asked which one shipped.
 *
 * Two servers, each with one hand-filed action, and the page is navigated between them:
 *
 *  - the **blocked** board holds a `gh-login` action, which a probe can settle and which is
 *    still blocked while the stub `gh` says so. Everything about reading, asking and refusing
 *    happens here;
 *  - the **trust** board holds a `gh-billing` action, which nothing on this machine can ever
 *    verify. It settles on the first press and the panel has to say so, because a board that
 *    recorded that as checked would be claiming something it did not do.
 *
 * One action per board is not tidiness: the column header counts what is in it, and `(1)` on a
 * board with no `githubProject` is the thing being asserted.
 *
 * Neither board has a project, so `GET /api/project-board` answers 404 and the canvas draws its
 * notes column and returns. That is the whole of the second claim: a founder read nested inside
 * that success path would never run here, and a column that appears anyway proves the fetch is
 * its own.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on, in the style of `scripts/check-autosync-drop-browser.mjs`. Headless, and every press goes
 * through `Input.dispatchMouseEvent` at a point `document.elementFromPoint` has just been asked
 * about: a headless page is never occluded, so the renderer is never throttled and no dispatch
 * is dropped, and hit-testing the point first is also what proves nothing is covering the card.
 *
 * Self-contained: it writes a stub `gh`, a stub agent, two throwaway workspaces and the founder
 * records themselves, starts its own canvas servers on free ports and kills everything. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-founder-panel-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── Two boards, neither of them with a project ───────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-founder-panel-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const ghStub = join(workDir, 'gh.mjs');
const agentStub = join(workDir, 'agent.mjs');
const authPath = join(workDir, 'gh-auth.txt');
const chatModePath = join(workDir, 'chat-mode.txt');
const agentLogPath = join(workDir, 'agent-calls.log');

/** Signed out until section 8 flips it, which is what a founder pressing **Done** does. */
writeFileSync(authPath, 'out', 'utf8');
/** `silent` until the chat sections ask for a revision. */
writeFileSync(chatModePath, 'silent', 'utf8');
writeFileSync(agentLogPath, '', 'utf8');

/** One board, one hand-filed action. Returns the registry path. */
function makeBoard(name) {
  const projectDir = join(workDir, name);
  const stateDir = join(workDir, `${name}-registry-state`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  // Deliberately no `githubProject`: this is the board the column exists for.
  writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({ name }), 'utf8');
  const registryPath = join(workDir, `${name}-registry.json`);
  writeFileSync(registryPath, JSON.stringify({
    workspaces: [{ id: name, path: projectDir.replace(/\\/g, '/') }],
  }), 'utf8');
  return { registryPath, stateDir, projectDir };
}

/**
 * A founder action, written straight into the store's own file.
 *
 * Hand-filed on purpose: the producers that notice these need a `gh` failure to happen first,
 * and what is being checked is the panel rather than the noticing. The fields are the register's
 * own corpus entries, so nothing here teaches a shape the composer would not produce.
 */
function fileAction(stateDir, workspaceId, record) {
  writeFileSync(join(stateDir, `${workspaceId}.founder-actions.json`), `${JSON.stringify({
    type: 'founder-actions',
    version: 1,
    workspaceId,
    savedAt: new Date().toISOString(),
    actions: [record],
  })}\n`, 'utf8');
}

const BLOCKED = 'blocked-board';
const TRUST = 'trust-board';
const blocked = makeBoard(BLOCKED);
const trust = makeBoard(TRUST);

const LOGIN_KEY = `${BLOCKED}:gh-login`;
const LOGIN_STEPS = [
  'Run `gh auth login` in a terminal and answer the questions it asks.',
  'Choose the account that owns the project you want this board to show.',
];
const LOGIN_EVIDENCE = {
  command: 'gh auth status',
  said: 'gh: please run gh auth login to use this tool',
  source: 'src/core/github-status.ts',
};

fileAction(blocked.stateDir, BLOCKED, {
  key: LOGIN_KEY,
  kind: 'gh-login',
  workspaceId: BLOCKED,
  fields: {
    title: 'Sign the GitHub CLI in to your account',
    what: 'The GitHub CLI is on this machine, but it is not signed in to any account yet.',
    why: 'Signed out, the board can show you nothing from GitHub and can start no run at all.',
    steps: [...LOGIN_STEPS],
    confirm: 'The board shows your project again instead of asking you to sign in.',
  },
  evidence: LOGIN_EVIDENCE,
  state: 'open',
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  chat: [],
});

const BILLING_KEY = `${TRUST}:gh-billing`;
fileAction(trust.stateDir, TRUST, {
  key: BILLING_KEY,
  kind: 'gh-billing',
  workspaceId: TRUST,
  fields: {
    title: 'GitHub is refusing work until billing is settled',
    what: 'GitHub says this account owes a payment, and it is refusing the work the board asks for.',
    why: 'Nothing here can settle a bill, and every run is refused until the account is in good standing.',
    steps: [
      'Open https://github.com/settings/billing and read what it says is owed.',
      'Add a payment method there, or fix the one already on the account.',
    ],
    confirm: 'The billing page shows nothing owed, and a run starts instead of being refused.',
  },
  evidence: {},
  state: 'open',
  createdAt: new Date().toISOString(),
  lastSeenAt: new Date().toISOString(),
  chat: [],
});

// ─── The stubs ────────────────────────────────────────────────

/** A `gh` that is signed out until the control file says otherwise. */
writeFileSync(ghStub, `#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const signedIn = () => {
  try { return readFileSync(${JSON.stringify(authPath)}, 'utf8').trim() === 'in'; }
  catch { return false; }
};

if (args[0] === '--version') {
  process.stdout.write('gh version 2.62.0 (2026-01-01)\\n');
  process.exit(0);
}

if (args[0] === 'auth' && args[1] === 'status') {
  if (!signedIn()) {
    process.stderr.write('gh: please run gh auth login to use this tool\\n');
    process.exit(1);
  }
  process.stdout.write('github.com\\n  Logged in to github.com account someone (keyring)\\n'
    + '  Token scopes: gist, project, read:org, repo\\n');
  process.exit(0);
}

process.stdout.write('{}\\n');
`, 'utf8');

/**
 * A Claude Code stub: it reads its prompt off stdin and answers as a stream of events.
 *
 * `claude-code` rather than the passthrough backend, and that is a requirement rather than a
 * preference: the founder chat refuses to run on an invocation whose GitHub writes could not be
 * taken off it, and there is nothing to narrow on a `raw` command line. A board this check could
 * chat on therefore has to be one with a real backend behind it.
 *
 * It is deliberately slow, so that "a second send while one is in flight" is a state the page
 * is actually in for long enough to press something.
 */
writeFileSync(agentStub, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';

let prompt = '';
process.stdin.on('data', (chunk) => { prompt += chunk.toString(); });
process.stdin.on('end', () => {
  appendFileSync(${JSON.stringify(agentLogPath)},
                 JSON.stringify({ args: process.argv.slice(2), promptLength: prompt.length }) + '\\n');

  let mode = 'silent';
  try { mode = readFileSync(${JSON.stringify(chatModePath)}, 'utf8').trim(); } catch { /* silent */ }

  const key = (prompt.match(/Its key is \`([^\`]+)\`/) ?? [])[1] ?? '';
  const fence = (block) => '\\n\\n\\u0060\\u0060\\u0060founder-action\\n' + JSON.stringify(block)
    + '\\n\\u0060\\u0060\\u0060';

  let text = 'You are signed out, so nothing here can reach GitHub yet.';
  if (mode === 'clean') {
    text += fence({ key, steps: [
      'Run \`gh auth login\` and pick GitHub.com when it asks.',
      'Pick a browser sign-in and paste the code it shows you.',
      'Come back here and press Done.',
    ] });
  } else if (mode === 'refused') {
    // Eight steps, where the register allows seven: a revision that is refused for a reason a
    // reader could be told, rather than for a malformed block.
    text += fence({ key, steps: Array.from({ length: 8 }, (_, at) => 'Step number ' + (at + 1) + '.') });
  }

  const events = [
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  ];
  setTimeout(() => {
    for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
    process.exit(0);
  }, 1500);
});
`, 'utf8');

const ghCommand = `node "${ghStub.replace(/\\/g, '/')}"`;
const agentCommand = `node "${agentStub.replace(/\\/g, '/')}"`;

const children = [];
let serverLog = '';

function startBoard(port, registryPath) {
  const server = startCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      EXCALIDRAW_GH_COMMAND: ghCommand,
      EXCALIDRAW_AGENT_BACKEND: 'claude-code',
      EXCALIDRAW_ISSUE_AGENT: agentCommand,
      // Off: the pass would re-probe and could settle a seeded record behind the check's back,
      // and every claim here is about what a *press* does.
      EXCALIDRAW_FOUNDER_PASS_MS: '0',
      // The resolve route invalidates this memo itself; off as well, so a section that flips the
      // control file cannot be answered from something remembered before it did.
      EXCALIDRAW_GH_STATUS_MEMO_MS: '0',
    },
  }).child;
  children.push(server);
  server.stdout.on('data', (chunk) => { serverLog += chunk; });
  server.stderr.on('data', (chunk) => { serverLog += chunk; });
  return server;
}

const BLOCKED_PORT = await freePort();
const TRUST_PORT = await freePort();
const CDP_PORT = await freePort();
const BLOCKED_BASE = `http://127.0.0.1:${BLOCKED_PORT}`;
const TRUST_BASE = `http://127.0.0.1:${TRUST_PORT}`;

startBoard(BLOCKED_PORT, blocked.registryPath);
startBoard(TRUST_PORT, trust.registryPath);

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${serverLog}`);
}

/** One request, with two more goes at the connection. See check-terminal-focus-browser. */
async function request(url, options, attempts = 3) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fetch(url, options); } catch (error) { last = error; await sleep(250); }
  }
  throw last;
}

/** The run record and the item, straight from the route the panel polls. */
async function chatRun(base, workspaceId, key) {
  const response = await request(
    `${base}/api/founder-actions/chat?workspace=${workspaceId}&key=${encodeURIComponent(key)}`
  );
  return response.json().catch(() => ({}));
}

const agentCalls = () =>
  readFileSync(agentLogPath, 'utf8').split('\n').filter((line) => line.trim()).length;

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

/** The imperative API, through the container's React fibre. See check-terminal-browser. */
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
        window.__founderApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** The mirror as the scene holds it: the founder cards, and the header of every column. */
const SCENE = `(() => {
  const api = window.__founderApi;
  if (!api) return { error: 'no api handle' };
  const out = { cards: [], headers: [] };
  const elements = api.getSceneElements();
  for (const element of elements) {
    if (element.isDeleted) continue;
    const data = element.customData || {};
    if (data.kind !== 'project-board') continue;
    const label = elements.find((candidate) => candidate.containerId === element.id);
    if (data.founderKey) {
      out.cards.push({
        id: element.id, key: data.founderKey, kind: data.founderKind, state: data.founderState,
        locked: element.locked === true, text: (label && label.text) || element.text || '',
      });
    }
    if (data.role === 'section') out.headers.push((label && label.text) || '');
  }
  return out;
})()`;

/**
 * The panel, as a reader gets it.
 *
 * Text rather than markup wherever the claim is about what it says, because a class name is
 * this check's own invention and a sentence is the product's. The hit tests are
 * `document.elementFromPoint`, which applies the stacking order the way an eye does.
 */
const PANEL = `(() => {
  const boxOf = (node) => {
    if (!node) return null;
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
             width: box.width, height: box.height };
  };
  const nameOf = (node) => {
    if (!node) return 'nothing';
    const tag = node.tagName ? node.tagName.toLowerCase() : '?';
    const cls = typeof node.className === 'string' && node.className
      ? '.' + node.className.trim().split(/\\s+/).join('.') : '';
    return tag + cls;
  };

  const cards = Array.from(document.querySelectorAll('.docs-card'));
  const card = cards[0] || null;
  const body = document.querySelector('.element-docs__founder');
  const out = {
    cardCount: cards.length,
    hasBody: Boolean(body),
    insideCard: Boolean(card && body && card.contains(body)),
    box: boxOf(card),
    window: { width: window.innerWidth, height: window.innerHeight },
  };
  if (!body) return out;

  const text = (selector) => {
    const node = body.querySelector(selector);
    return node ? node.textContent.trim() : null;
  };
  out.heading = text('.element-docs__title');
  out.what = text('.element-docs__founder-what');
  out.why = text('.element-docs__founder-why');
  out.confirm = text('.element-docs__founder-confirm');
  const list = body.querySelector('ol.element-docs__founder-steps');
  out.listTag = list ? list.tagName.toLowerCase() : null;
  out.steps = list ? Array.from(list.querySelectorAll('li')).map((item) => item.textContent.trim()) : [];

  const evidence = body.querySelector('details.element-docs__founder-evidence');
  out.evidence = evidence
    ? { open: evidence.open, summary: evidence.querySelector('summary').textContent.trim(),
        box: boxOf(evidence.querySelector('summary')),
        text: evidence.textContent.trim() }
    : null;

  const done = body.querySelector('.element-docs__founder-done');
  const ask = body.querySelector('.element-docs__founder-send');
  out.done = done ? { label: done.textContent.trim(), disabled: done.disabled, box: boxOf(done) } : null;
  out.ask = ask ? { label: ask.textContent.trim(), disabled: ask.disabled, box: boxOf(ask) } : null;
  out.buttons = Array.from(document.querySelectorAll('.docs-card button')).map((node) => node.textContent.trim());
  out.refusal = text('.element-docs__founder-refusal');
  out.settled = text('.element-docs__founder-settled');
  out.hints = Array.from(body.querySelectorAll('.element-docs__hint')).map((node) => node.textContent.trim());
  out.errors = Array.from(body.querySelectorAll('.element-docs__error')).map((node) => node.textContent.trim());
  out.turns = Array.from(body.querySelectorAll('.element-docs__founder-turn')).map((node) => ({
    who: node.className.includes('--founder') ? 'founder' : 'agent',
    text: node.textContent.trim(),
  }));
  const draft = body.querySelector('.element-docs__founder-draft');
  out.draft = draft ? { value: draft.value, box: boxOf(draft) } : null;

  if (out.box) {
    // Clamped into the window first. The card is anchored to a shape in the mirror, which sits
    // at large negative scene coordinates, so placement can legitimately leave part of it off
    // the left edge — and elementFromPoint answers null for a point that is not on the page,
    // which is a fact about the viewport rather than about anything covering the card.
    const visible = {
      left: Math.max(out.box.left, 0), top: Math.max(out.box.top, 0),
      right: Math.min(out.box.right, window.innerWidth), bottom: Math.min(out.box.bottom, window.innerHeight),
    };
    out.visible = visible;
    const points = [
      { name: 'top left', x: visible.left + 12, y: visible.top + 12 },
      { name: 'middle', x: (visible.left + visible.right) / 2, y: (visible.top + visible.bottom) / 2 },
      { name: 'bottom right', x: visible.right - 12, y: visible.bottom - 12 },
    ];
    out.hits = points.map((point) => {
      const found = document.elementFromPoint(point.x, point.y);
      return { name: point.name, found: nameOf(found),
               onCard: Boolean(card && found && (card === found || card.contains(found))) };
    });
  }
  return out;
})()`;

/**
 * A press where a reader would put it, hit-tested before it is dispatched.
 *
 * The hit test is not decoration. The card grows as the conversation does, so a box read a
 * moment ago can have moved by the time it is pressed — and a press that misses lands on the
 * canvas, empties the selection and takes the panel off the screen, which would be reported as
 * whatever assertion came next rather than as a stale coordinate.
 */
async function press(box, what = 'a control') {
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const onCard = await evaluate(`(() => {
    const found = document.elementFromPoint(${x}, ${y});
    const card = document.querySelector('.docs-card');
    return Boolean(card && found && (card === found || card.contains(found)));
  })()`);
  if (!onCard) {
    throw new Error(`the press for ${what} at ${Math.round(x)},${Math.round(y)} does not land on the card`);
  }
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(250);
}

/**
 * The same, addressed by selector: scrolled into view, re-measured, then pressed.
 *
 * The card is a reading column with a ceiling on its height, so a control near the bottom of a
 * growing conversation can be below the fold. Scrolling it into view first is what a reader
 * does, and re-measuring afterwards is what keeps the coordinate honest.
 */
async function pressSelector(selector, what) {
  const box = await evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return null;
    node.scrollIntoView({ block: 'center' });
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  })()`);
  if (!box) throw new Error(`there is no ${what} on the page to press`);
  await press(box, what);
}

const EVIDENCE_SUMMARY = 'details.element-docs__founder-evidence > summary';
const DONE = '.element-docs__founder-done';
const ASK = '.element-docs__founder-send';
const DRAFT = '.element-docs__founder-draft';

const select = async (id) => {
  await evaluate(`window.__founderApi.updateScene({ appState: { selectedElementIds: { '${id}': true } } })`);
  await sleep(600);
  return evaluate(PANEL);
};

/** Poll the panel until it says something, so a wait is bounded rather than a fixed sleep. */
async function panelWhen(predicate, what, tries = 80) {
  return waitFor(async () => {
    const seen = await evaluate(PANEL);
    return predicate(seen) ? seen : null;
  }, what, tries);
}

async function openBoard(base, workspaceId) {
  await send('Page.navigate', { url: base });
  await send('Page.bringToFront');
  await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
  return waitFor(async () => {
    const seen = await evaluate(SCENE);
    return seen && seen.cards && seen.cards.length === 1 ? seen : null;
  }, `the founder card of ${workspaceId} to reach the canvas`);
}

try {
  await waitFor(async () => (await fetch(`${BLOCKED_BASE}/health`)).ok, 'the blocked board server');
  await waitFor(async () => (await fetch(`${TRUST_BASE}/health`)).ok, 'the trust board server');

  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1500,1000',
    BLOCKED_BASE,
  ], { stdio: 'ignore' }));

  await attach();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');

  console.log('1. the route answers on a board with no project at all');
  {
    const response = await request(`${BLOCKED_BASE}/api/founder-actions?workspace=${BLOCKED}`);
    const body = await response.json().catch(() => ({}));
    check('GET /api/founder-actions answers 200', response.status === 200, `status ${response.status}`);
    check('with the one action this board is holding',
          Array.isArray(body.actions) && body.actions.length === 1
          && body.actions[0].key === LOGIN_KEY,
          JSON.stringify(body.actions));
    check('and the column the workspace calls it', body.columnName === 'Founder Actions', String(body.columnName));
    check('and a capabilities object rather than a probe',
          Boolean(body.capabilities) && body.capabilities.resolve === true
          && body.capabilities.chat === true,
          JSON.stringify(body.capabilities));

    const board = await request(`${BLOCKED_BASE}/api/project-board?workspace=${BLOCKED}`);
    check('while the project read on the same board answers 404', board.status === 404,
          `status ${board.status}`);
  }

  console.log('\n2. the canvas draws the column, and the header counts what is in it');
  const start = await openBoard(BLOCKED_BASE, BLOCKED);
  await shot('01-column');
  {
    check('a founder card is on the board', start.cards.length === 1, JSON.stringify(start.cards));
    check('it carries the store key and nothing has to be inferred',
          start.cards[0].key === LOGIN_KEY, start.cards[0].key);
    check('it is selectable — a locked shape cannot be clicked', start.cards[0].locked === false,
          `locked=${start.cards[0].locked}`);
    check('the column header reads Founder Actions (1)',
          start.headers.includes('Founder Actions (1)'), JSON.stringify(start.headers));
    check('and the notes column is still there beside it',
          start.headers.some((header) => header.startsWith('My Notes')), JSON.stringify(start.headers));
  }

  console.log('\n3. selecting it opens the whole action, and nothing else');
  let panel = await select(start.cards[0].id);
  await shot('02-panel');
  {
    check('the panel has a founder body', panel.hasBody, 'no .element-docs__founder on the page');
    check('the title is a heading', panel.heading === 'Sign the GitHub CLI in to your account',
          String(panel.heading));
    check('the what is there, in one short sentence',
          (panel.what ?? '').startsWith('The GitHub CLI is on this machine'), String(panel.what));
    check('and the why beside it',
          (panel.why ?? '').startsWith('Signed out, the board can show you nothing'), String(panel.why));
    check('the steps are a real ordered list', panel.listTag === 'ol', String(panel.listTag));
    check('with one step per item, numbered as stored',
          JSON.stringify(panel.steps) === JSON.stringify(LOGIN_STEPS),
          JSON.stringify(panel.steps));
    check('and the confirm sentence is shown',
          panel.confirm === 'The board shows your project again instead of asking you to sign in.',
          String(panel.confirm));
  }

  console.log('\n4. Evidence is present, and closed');
  {
    check('there is an Evidence disclosure', Boolean(panel.evidence), 'no <details> for the evidence');
    check('it is closed on the frame the card opens', panel.evidence?.open === false,
          `open=${panel.evidence?.open}`);
    check('and what it is hiding is the machine half',
          (panel.evidence?.text ?? '').includes(LOGIN_EVIDENCE.command),
          String(panel.evidence?.text));
    await pressSelector(EVIDENCE_SUMMARY, 'the Evidence disclosure');
    const opened = await evaluate(PANEL);
    check('pressing it opens it', opened.evidence?.open === true, `open=${opened.evidence?.open}`);
    await pressSelector(EVIDENCE_SUMMARY, 'the Evidence disclosure');
    panel = await evaluate(PANEL);
    check('and pressing it again puts it away', panel.evidence?.open === false,
          `open=${panel.evidence?.open}`);
  }

  console.log('\n5. nothing offers to build it, and there is only one card on the layer');
  {
    const offered = panel.buttons.map((label) => label.toLowerCase());
    for (const control of ['implement', 'resume', 'fix', 'recreate']) {
      check(`no ${control} control is offered`,
            !offered.some((label) => label.includes(control)), JSON.stringify(panel.buttons));
    }
    check('Done is', Boolean(panel.done), JSON.stringify(panel.buttons));
    check('the founder body is inside the anchored docs card', panel.insideCard,
          'the body is not a descendant of .docs-card');
    check('and it added no second overlay of its own', panel.cardCount === 1,
          `${panel.cardCount} .docs-card elements`);
    check('nothing on the page covers the card',
          (panel.hits ?? []).every((hit) => hit.onCard),
          `${JSON.stringify(panel.hits)} card ${JSON.stringify(panel.box)} in ${JSON.stringify(panel.window)}`);
  }

  console.log('\n6. a question reaches the transcript at once, and only one agent runs');
  {
    writeFileSync(chatModePath, 'clean', 'utf8');
    const before = agentCalls();
    await pressSelector(DRAFT, 'the compose box');
    await send('Input.insertText', { text: 'I have just signed in — what now?' });
    await sleep(200);
    panel = await evaluate(PANEL);
    check('the box holds what was typed', panel.draft.value === 'I have just signed in — what now?',
          String(panel.draft.value));
    check('and Ask is offered', panel.ask && panel.ask.disabled === false, JSON.stringify(panel.ask));

    await pressSelector(ASK, 'Ask');
    const asking = await panelWhen(
      (seen) => seen.turns?.some((turn) => turn.who === 'founder'),
      'the question to appear in the transcript'
    );
    check('the question is in the transcript before any answer',
          asking.turns.filter((turn) => turn.who === 'agent').length === 0
          && asking.turns[0].text.includes('what now?'),
          JSON.stringify(asking.turns));
    check('and a second Ask is refused while one is in flight',
          asking.ask === null || asking.ask.disabled === true, JSON.stringify(asking.ask));

    // Pressed anyway, at the box the button has *now*: the claim is that no second agent
    // starts, and a stale coordinate would prove nothing about it.
    const stillAsking = await evaluate(PANEL);
    if (stillAsking.ask) await pressSelector(ASK, 'the second Ask');

    const settledRun = await waitFor(async () => {
      const seen = await chatRun(BLOCKED_BASE, BLOCKED, LOGIN_KEY);
      return seen?.run && seen.run.state !== 'running' ? seen : null;
    }, 'the chat run to settle');
    check('the run finished rather than failing', settledRun.run.state === 'done',
          JSON.stringify(settledRun.run));

    const answered = await panelWhen(
      (seen) => seen.turns?.some((turn) => turn.who === 'agent')
        || (seen.errors ?? []).length > 0,
      'the agent to answer'
    );
    check('and nothing was reported as an error', (answered.errors ?? []).length === 0,
          JSON.stringify(answered.errors));
    check('the reply arrives when the run settles',
          answered.turns.some((turn) => turn.who === 'agent' && turn.text.includes('signed out')),
          JSON.stringify(answered.turns));
    // The stub streams its answer as events, which is what a board configured the ordinary way
    // gets: `--output-format stream-json` is on every headless Claude Code invocation this
    // repository builds. What the founder must read is the sentence inside them, not the
    // transcript of them — and the fenced revision below is inside the same text, so a reply
    // taken straight off the process's stdout would also mean no revision could ever be applied.
    check('and it is what the agent said, not what its process printed',
          answered.turns.every((turn) => !turn.text.includes('"type":"assistant"')),
          JSON.stringify(answered.turns.map((turn) => turn.text.slice(0, 80))));
    check('and exactly one agent was started', agentCalls() - before === 1,
          `${agentCalls() - before} calls`);
    await shot('03-answered');
  }

  console.log('\n7. a clean patch re-renders the steps in place, with no reload');
  {
    panel = await panelWhen(
      (seen) => seen.steps?.length === 3,
      'the revised steps to reach the panel'
    );
    check('the steps are the revised ones', panel.steps[2] === 'Come back here and press Done.',
          JSON.stringify(panel.steps));
    check('and it is still an ordered list of one step per item', panel.listTag === 'ol'
          && panel.steps.length === 3, JSON.stringify(panel.steps));
    check('the rest of the item is untouched',
          panel.heading === 'Sign the GitHub CLI in to your account', String(panel.heading));

    const stored = await (await request(`${BLOCKED_BASE}/api/founder-actions?workspace=${BLOCKED}`)).json();
    check('and the store agrees, so it is a revision rather than a screenful',
          stored.actions?.[0]?.fields?.steps?.length === 3,
          JSON.stringify(stored.actions?.[0]?.fields?.steps));
  }

  console.log('\n8. a refused patch shows the reply and says the item was left alone');
  {
    writeFileSync(chatModePath, 'refused', 'utf8');
    const stepsBefore = JSON.stringify(panel.steps);
    await pressSelector(DRAFT, 'the compose box');
    await send('Input.insertText', { text: 'Rewrite this as eight steps.' });
    await sleep(200);
    panel = await evaluate(PANEL);
    await pressSelector(ASK, 'Ask');

    const answered = await panelWhen(
      (seen) => seen.turns?.filter((turn) => turn.who === 'agent').length === 2,
      'the second answer'
    );
    check('the reply is still shown',
          answered.turns.filter((turn) => turn.who === 'agent').length === 2,
          JSON.stringify(answered.turns.map((turn) => turn.who)));
    check('and a plain sentence says the item was left unchanged',
          answered.hints.some((hint) => /left as it is|left unchanged/i.test(hint)),
          JSON.stringify(answered.hints));
    check('the steps are exactly what they were', JSON.stringify(answered.steps) === stepsBefore,
          `${JSON.stringify(answered.steps)} vs ${stepsBefore}`);
    await shot('04-refused');
  }

  console.log('\n9. the transcript comes from the store, so a reload keeps all of it');
  {
    const reloaded = await openBoard(BLOCKED_BASE, BLOCKED);
    panel = await select(reloaded.cards[0].id);
    panel = await panelWhen((seen) => (seen.turns ?? []).length >= 4, 'the transcript to come back');
    check('all four turns are back after a reload', panel.turns.length === 4,
          JSON.stringify(panel.turns.map((turn) => turn.who)));
    check('in the order they were said',
          panel.turns.map((turn) => turn.who).join(',') === 'founder,agent,founder,agent',
          panel.turns.map((turn) => turn.who).join(','));
  }

  console.log('\n10. Done while the blocker is still there refuses in place');
  {
    check('Done is offered on an open action', Boolean(panel.done), JSON.stringify(panel.buttons));
    await pressSelector(DONE, 'Done');
    const refused = await panelWhen((seen) => Boolean(seen.refusal), 'the refusal to be shown');
    check('the probe\'s own sentence is shown in place',
          /still signed in to no account/i.test(refused.refusal ?? ''), String(refused.refusal));
    check('and the panel stayed open', refused.hasBody && refused.cardCount === 1,
          `body=${refused.hasBody} cards=${refused.cardCount}`);
    check('Done is still offered', Boolean(refused.done), JSON.stringify(refused.buttons));

    const stored = await (await request(`${BLOCKED_BASE}/api/founder-actions?workspace=${BLOCKED}`)).json();
    check('and the action is still open', stored.actions?.length === 1
          && stored.actions[0].state === 'open', JSON.stringify(stored.actions));
    await shot('05-refused-done');
  }

  console.log('\n11. flipping the blocker and pressing again settles it, with no reload');
  {
    writeFileSync(authPath, 'in', 'utf8');
    panel = await evaluate(PANEL);
    await pressSelector(DONE, 'Done');
    const settled = await panelWhen((seen) => Boolean(seen.settled), 'the item to read as settled');
    check('the panel says it is done', /done|settled|signed in/i.test(settled.settled ?? ''),
          String(settled.settled));
    check('and it does not claim it was taken on trust',
          !/on trust/i.test(settled.settled ?? ''), String(settled.settled));
    check('the Done button is gone', settled.done === null, JSON.stringify(settled.buttons));

    const stored = await (await request(`${BLOCKED_BASE}/api/founder-actions?workspace=${BLOCKED}`)).json();
    check('and the open list no longer holds it', (stored.actions ?? []).length === 0,
          JSON.stringify(stored.actions));
    await shot('06-settled');
  }

  console.log('\n12. an action nothing can verify settles on the first press, and says so');
  {
    const trustBoard = await openBoard(TRUST_BASE, TRUST);
    check('the trust board draws its own card', trustBoard.cards[0].key === BILLING_KEY,
          trustBoard.cards[0].key);
    panel = await select(trustBoard.cards[0].id);
    panel = await panelWhen((seen) => Boolean(seen.done), 'the Done control on the trust board');
    await pressSelector(DONE, 'Done');
    const settled = await panelWhen((seen) => Boolean(seen.settled), 'the item to read as settled');
    check('it settled on the first press', Boolean(settled.settled), String(settled.settled));
    check('and the panel says it was taken on trust', /on (your word|trust)/i.test(settled.settled ?? ''),
          String(settled.settled));

    const stored = await (await request(`${TRUST_BASE}/api/founder-actions?workspace=${TRUST}`)).json();
    check('the open list no longer holds it', (stored.actions ?? []).length === 0,
          JSON.stringify(stored.actions));
    await shot('07-trust');
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
  for (const child of children) {
    if (child.exitCode !== null && child.spawnfile !== chromePath) {
      console.error(`a canvas server exited (${child.exitCode}):\n${serverLog}`);
      break;
    }
  }
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

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
