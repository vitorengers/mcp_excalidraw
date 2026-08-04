#!/usr/bin/env node
/**
 * Checks what a canvas bound off loopback is, and that it says so — and **since #586 what it is has
 * changed**, so two of the three things below assert the opposite of what they used to.
 *
 * It is no longer a drawing-only board. The guards that made it one asked where the server had
 * *bound* rather than who was calling, and the caller they were refusing was its own operator, whose
 * browser reaches it over loopback like anybody else's on that machine. #501 moved the board's
 * contents to the caller's own address, #522 taught that question about approved devices, and #586
 * moved the last three — the routes that spawn `gh`, the terminal and the implement agent. A board
 * on an interface now serves its operator exactly as a loopback one does, and refuses everyone else
 * unless they are on a device that operator approved.
 *
 * So rule 1 stands unchanged, rule 2 is tightened rather than dropped, and sections 2 and 3 now
 * assert that the operator is *served* and that nothing on their screen blames the bind. The
 * reasoning from when the bind decided this is kept below, because rule 2 is about it.
 *
 * The container this repository used to ship set `ENV HOST=0.0.0.0`, and `HOST` is what every
 * GitHub-shaped route is guarded on: the project mirror, a card move, the GitHub status route,
 * the workspace registry and the issue blocks all answer 403 the moment the bind address is not
 * `127.0.0.1` or `::1`. So the headline feature was disabled by construction in the one install
 * path the README advertised, and the canvas said nothing about it — `refreshProjectBoard`
 * special-cased 404 and success and returned silently for everything else, which made the
 * mirror a blank region rather than a refusal. #300 answered the container half by deleting it
 * (there is no image any more, and `check-no-docker-path.mjs` holds that), and #317 answered the
 * silence by saying every non-404 failure out loud. What was never written down is that a
 * non-loopback bind is still *offered* — `HOST=0.0.0.0` is in the README's security note as a
 * way to expose the board — and what it costs is the whole GitHub half of the product. Since
 * #366 it costs the other half too: the reads of board contents and the WebSocket are behind the
 * same bind guard (`check-board-reads-guard.mjs`), and since #456 the writes are as well
 * (`check-board-writes-guard.mjs`), so what is left on such a bind is a page that can still say
 * why it is empty. Rule 2 below is unchanged by that — a passage offering the bind has to name
 * the cost — and the cost it now names is larger.
 *
 * That is the decision this check holds, in three places, because it can be undone in three:
 *
 *  1. **nothing this repository ships hands the server a non-loopback bind.** The Dockerfile is
 *     gone, but the line in it was one `ENV`, and a launcher, a workflow, a compose file or a
 *     `config.json` can carry the same one. `scripts/` is exempt: the checks that prove the
 *     guard have to bind past it, which is what this one does below.
 *  2. **every document that offers a non-loopback bind says what it costs**, in the passage that
 *     offers it rather than somewhere else in the file. A reader who is deciding whether to set
 *     `HOST` reads that paragraph and no further, and "put access controls in front" reads like
 *     the whole of the consequence when it is the smaller half of it.
 *  3. **the refusal reaches the reader as words on the canvas**, which is the half only a
 *     browser settles. A 403 that is correct, logged and invisible is the state #320 is about.
 *
 * **This check binds `0.0.0.0` on the machine it runs on**, for the length of one run, on a port
 * the kernel just handed out. The issue that asked for it suggested stubbing a 403 instead; that
 * was refused, because a stubbed response asserts this check's idea of what the route says
 * rather than what it says, and the guard, its status code and its sentence are three of the
 * four things being checked. It is also what eight checks in this directory already do to prove
 * the same guard — `check-project-board.mjs`, `check-terminal.mjs`, `check-workspace-create.mjs`
 * and the rest. The server is reached at `127.0.0.1` throughout: `0.0.0.0` is a bind address and
 * not a place to send a request.
 *
 * Self-contained: one throwaway board, one canvas server of its own, one headless Chrome. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — section 3 loads the
 * built frontend, and a stale `dist/frontend` is a green run about code that is not there.
 *
 * Usage: node scripts/check-non-loopback-github-browser.mjs [--chrome <path>] [--shots <dir>]
 *
 * Tier: browser
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { findChrome, skipWithoutChrome } from './lib/find-chrome.mjs';
import { freePort } from './lib/free-port.mjs';
import { openCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const argOf = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const posix = (value) => value.replace(/\\/g, '/');

/**
 * One numbered section, whose failure is recorded rather than allowed to end the run.
 *
 * A check that stops at the first defect cannot say how much of a feature is missing, which is
 * exactly the question being put to it when it is run against the old code on purpose.
 */
async function stage(title, body) {
  console.log(`\n${title}`);
  try {
    await body();
  } catch (error) {
    failures++;
    console.error(`  FAIL  ${title} did not finish — ${error.message}`);
  }
}

// ─── The two rules about the tree, as functions over text ─────

/**
 * Where an artifact hands the server a non-loopback bind.
 *
 * An assignment, not a mention: `src/core/port.ts` compares against `'0.0.0.0'` and
 * `src/core/restart-supervisor.ts` keeps it in a set, and neither of those is a server started
 * on it. `ENV HOST=0.0.0.0`, `HOST: "0.0.0.0"`, `"HOST": "::"` and `--host 0.0.0.0` are the
 * four shapes the same line takes in a Dockerfile, a compose file, a `config.json` and a
 * launcher script.
 *
 * Markdown is not asked this question at all — a document that names the value is *describing*
 * a bind rather than performing one, and the README has to be able to warn about the thing it
 * is warning about. What a document owes is the second rule below, and only that.
 */
const BINDS_OFF_LOOPBACK = [
  /\bHOST\b["']?\s*[:=]\s*["']?(0\.0\.0\.0|::)(?![.\w])/,
  /--host[= ]+["']?(0\.0\.0\.0|::)(?![.\w])/,
];

const bindsOffLoopback = (text) => text.split(/\r?\n/)
  .map((line, index) => ({ line: line.trim(), at: index + 1 }))
  .filter(({ line }) => BINDS_OFF_LOOPBACK.some((shape) => shape.test(line)));

/**
 * Which tracked paths that rule is asked about: the ones a server can be started from.
 *
 * Markdown is deliberately not one of them. A `.excalidraw` is not either — that is a board's
 * content, and what its cards say is the board map check's question.
 */
const isShippedArtifact = (path) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /\.(json|ya?ml|ts|tsx|mjs|js|sh|ps1|cmd|bat)$/.test(name)
    || /^Dockerfile/.test(name)
    || /^\.env/.test(name);
};

/**
 * Where a document offers a non-loopback bind to the reader.
 *
 * The same assignment, plus the sentence the README made it with — "expose it on a network
 * interface" — because a document can offer the thing without spelling the value.
 */
const OFFERS_OFF_LOOPBACK = [
  ...BINDS_OFF_LOOPBACK,
  /\bexpose\b[^.]{0,80}\bnetwork interface\b/i,
  /\bbinds?\b[^.]{0,30}(0\.0\.0\.0|\bany interface\b)/i,
];

/**
 * What such a passage has to say. Three halves now, and the third is #586's.
 *
 * "loopback" alone is the word the default is described with and "403" alone could be about
 * anything, so both of those were always required. The third arrived when the answer changed: the
 * refusal is about the **caller** and not the bind, so the passage that offers a wider `HOST` has to
 * name the one caller off this machine who is *not* refused — a device the operator approved.
 *
 * Requiring it is what stops the old sentence coming back. "Off loopback the routes that read or
 * write a board answer 403" satisfied the first two conjuncts perfectly and is now false: on such a
 * board those routes answer the operator, and the reader who acted on that sentence went and
 * rebound a server that was bound correctly.
 */
const NAMES_THE_COST = (passage) => /\bloopback\b/i.test(passage)
  && /\b(403|refus\w*|answers? nothing|drawing[- ]only|no GitHub)\b/i.test(passage)
  && /\b(approv\w*|paired|pairing|device)\b/i.test(passage);

/**
 * The paragraphs of a Markdown document: contiguous runs of non-blank lines.
 *
 * The unit is the paragraph rather than the file because that is the unit a reader reads. A
 * README that offers `HOST=0.0.0.0` in a security note and explains the cost four hundred lines
 * away in an environment table has told nobody anything.
 */
function paragraphs(text) {
  const out = [];
  let current = [];
  let start = 1;
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      if (current.length) out.push({ at: start, text: current.join('\n') });
      current = [];
      start = index + 2;
    } else {
      if (!current.length) start = index + 1;
      current.push(line);
    }
  });
  if (current.length) out.push({ at: start, text: current.join('\n') });
  return out;
}

const silentOffers = (path, text) => paragraphs(text)
  .filter(({ text: passage }) => OFFERS_OFF_LOOPBACK.some((shape) => shape.test(passage)))
  .filter(({ text: passage }) => !NAMES_THE_COST(passage))
  .map(({ at, text: passage }) => `${path}:${at} — ${passage.trim().slice(0, 90)}`);

// ─── 0. The rules catch their defect, and clear what is right ─

console.log('0. the rules catch their defect, and clear a passage that names the cost');

check('an ENV line in a Dockerfile is caught', bindsOffLoopback('ENV HOST=0.0.0.0\n').length === 1);
check('a compose environment entry is caught',
      bindsOffLoopback('    environment:\n      - HOST=0.0.0.0\n').length === 1);
check('a config.json key is caught', bindsOffLoopback('  "HOST": "::",\n').length === 1);
check('a launcher flag is caught', bindsOffLoopback('node dist/server.js --host 0.0.0.0\n').length === 1);
check('a loopback bind is not', bindsOffLoopback('ENV HOST=127.0.0.1\n"HOST": "::1"\n').length === 0,
      JSON.stringify(bindsOffLoopback('ENV HOST=127.0.0.1\n"HOST": "::1"\n')));
check('a Dockerfile, a compose file, a launcher and a config are asked',
      ['Dockerfile.canvas', 'docker-compose.yml', 'scripts/launch.ps1', 'config.example.json',
       '.env.example'].every(isShippedArtifact));
check('a document is not — describing a bind is not performing one',
      !isShippedArtifact('README.md') && !isShippedArtifact('docs/configuration.md')
      && !isShippedArtifact('docs/board.excalidraw'),
      'what a document owes is the second rule, and only that');
check('source that compares against the string is not',
      bindsOffLoopback("  if (host === '0.0.0.0' || host === '::') return HOST_FALLBACK;\n"
                       + "const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);\n").length === 0,
      'a comparison is not a server started on it');

const SILENT_NOTE = '> **Security note:** The canvas server binds `127.0.0.1` only by default. If '
  + 'you expose it on a network interface (`HOST=0.0.0.0`), put network-level access controls in '
  + 'front — the API has no built-in authentication.';
/** The sentence written while the bind decided this. It named a cost; #586 made it the wrong one. */
const BIND_TEST_NOTE = '> **Security note:** The canvas server binds `127.0.0.1` only by default, '
  + 'and off loopback every GitHub-backed route answers `403` — the board is drawing-only there. If '
  + 'you expose it on a network interface (`HOST=0.0.0.0`) anyway, put network-level access '
  + 'controls in front — the API has no built-in authentication.';
const FULL_NOTE = '> **Security note:** The canvas server binds `127.0.0.1` only by default. Expose '
  + 'it on a network interface (`HOST=0.0.0.0`) and every route answers `403` to a caller that did '
  + 'not arrive over loopback and is not on a device you have approved; pairing one is how a second '
  + 'machine gets in.';
check('a note that offers the bind and names only the authentication is caught',
      silentOffers('README.md', SILENT_NOTE).length === 1,
      JSON.stringify(silentOffers('README.md', SILENT_NOTE)));
check('so is one naming the cost the bind test had, which is no longer what it costs',
      silentOffers('README.md', BIND_TEST_NOTE).length === 1,
      JSON.stringify(silentOffers('README.md', BIND_TEST_NOTE)));
check('the same note carrying what it costs now is accepted',
      silentOffers('README.md', FULL_NOTE).length === 0,
      JSON.stringify(silentOffers('README.md', FULL_NOTE)));
check('a document that never offers one is not asked',
      silentOffers('docs/running.md', 'The board runs on 3737.\n\nStart it with `npm run canvas`.')
        .length === 0);
check('the cost said four hundred lines away is not the same passage',
      silentOffers('README.md', `${SILENT_NOTE}\n\nunrelated\n\nOff loopback it answers 403.`)
        .length === 1,
      'a reader reads the paragraph, not the file');

// ─── 1. The tree carries one answer about the bind ────────────

console.log('\n1. nothing shipped binds off loopback, and every document that offers one says '
            + 'what it costs');

const tracked = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\n').map((line) => line.trim()).filter(Boolean);
const read = (relative) => readFileSync(join(repoRoot, relative), 'utf8');

/**
 * `scripts/` binds it on purpose — this file included — and the log is the dated record of what
 * was decided, so the entry that says `ENV HOST=0.0.0.0` was deleted has to be able to say it.
 * `docs/board.excalidraw` is scene JSON rather than a document, and its text lands in the map
 * check instead.
 */
const EXEMPT = (path) => path.startsWith('scripts/') || path === 'docs/development-log.md'
  || path === 'docs/board.excalidraw';

const shipping = tracked.filter((path) => !EXEMPT(path) && isShippedArtifact(path))
  .flatMap((path) => bindsOffLoopback(read(path)).map(({ line, at }) => `${path}:${at} ${line}`));
check('no tracked artifact starts the server off loopback', shipping.length === 0,
      `\n        ${shipping.join('\n        ')}`);

const documents = tracked.filter((path) => path.endsWith('.md') && !EXEMPT(path));
const silent = documents.flatMap((path) => silentOffers(path, read(path)));
check('every passage that offers a non-loopback bind says what it costs', silent.length === 0,
      `\n        ${silent.join('\n        ')}`
      + '\n        off loopback the GitHub half of the board answers 403; a passage that offers'
      + '\n        the bind and does not say so is the silence #320 is about, one layer up');

// ─── The server, bound where the container used to bind it ────

const chromePath = findChrome();
if (!chromePath) skipWithoutChrome();

const frontend = join(repoRoot, 'dist', 'frontend', 'index.html');
if (!existsSync(frontend)) {
  console.error('\n  FAIL  the built frontend exists — dist/frontend/index.html not found');
  console.error('        (run ./node_modules/.bin/vite build first)');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'check-off-loopback-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

/**
 * A board with a project on it, which is the case that matters.
 *
 * A board with no `githubProject` is answered 404 and says nothing on purpose, so it could not
 * tell a working canvas from a refusing one. This one has a project to mirror, and off loopback
 * is refused before the workspace is even looked up.
 */
const boardDir = join(workDir, 'off-loopback');
mkdirSync(boardDir, { recursive: true });
writeFileSync(join(boardDir, 'board.config.json'), JSON.stringify({
  name: 'off-loopback',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/someone/projects/5',
}), 'utf8');
const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'off-loopback', path: posix(boardDir) }],
}), 'utf8');

const children = [];
const servers = [];

// ─── Talking to Chrome ────────────────────────────────────────

let socket = null;
let nextId = 1;
const pending = new Map();

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function attach(cdpPort) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
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

/** The toast is a DOM node that lives ten seconds, so it is recorded as it appears. */
const RECORDER = `
window.__toasts = [];
window.setInterval(() => {
  const node = document.querySelector('.Toast__message');
  const text = node && node.textContent ? node.textContent.trim() : '';
  if (text && window.__toasts[window.__toasts.length - 1] !== text) window.__toasts.push(text);
}, 100);
`;

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

/**
 * The strip a cold board draws, and the words bound to it.
 *
 * `customData.unreadable` is what tells it from the mirror a board that *was* read draws — the
 * mark `layoutUnreadable` puts there for anything asking the scene rather than reading the
 * words.
 */
const STRIP = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return null;
  const elements = api.getSceneElements();
  const strip = elements.find((element) => (element.customData || {}).unreadable === true);
  if (!strip) return null;
  const text = elements
    .filter((element) => element.type === 'text' && element.containerId === strip.id)
    .map((element) => element.text).join(' ');
  return { text, kind: (strip.customData || {}).kind };
})()`;

const json = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

/**
 * The same wait, bounded and never thrown, answering null instead.
 *
 * A `waitFor` inside a case takes the rest of the file down with it when the thing never happens:
 * one failure is printed and every assertion after it is unevidenced, which is the shape that makes
 * a red run unreadable.
 */
async function settles(fn, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  return null;
}

try {
  // `0.0.0.0` is a bind address; the requests below all go to `127.0.0.1`, which it includes.
  // That is the whole point of the guard: the server cannot tell who reached it, only what it
  // opened itself to.
  const board = await openCanvas({
    env: {
      LOG_LEVEL: 'error',
      HOST: '0.0.0.0',
      EXCALIDRAW_WORKSPACES: registryPath,
    },
  });
  servers.push(board);

  await stage('2. the GitHub routes answer the caller on this machine, on a board bound to every '
              + 'interface', async () => {
    const health = await json(`${board.base}/health`);
    check('the canvas itself is up', health.status === 200,
          `${health.status} ${JSON.stringify(health.body).slice(0, 120)}`);

    // All three answered 403 here until #586, and the caller they were refusing is this one: a
    // request to `127.0.0.1`, from the machine the server runs on, on a board its operator opened
    // so that a second machine could reach it. `gh` is sealed in a check's environment, so what
    // they answer with is a failure about GitHub — which is a different thing from a refusal about
    // where the server opened, and telling those two apart is the whole of this section.
    const mirror = await json(`${board.base}/api/project-board?workspace=off-loopback`);
    check('GET /api/project-board is not refused', mirror.status !== 403,
          `${mirror.status} ${JSON.stringify(mirror.body)}`);
    check('and nothing it says is about the bind',
          !/loopback/i.test(String(mirror.body?.error ?? '')), JSON.stringify(mirror.body));

    const move = await json(`${board.base}/api/project-board/move?workspace=off-loopback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: 'PVTI_x', optionId: 'opt' }),
    });
    check('POST /api/project-board/move is not refused either', move.status !== 403,
          `${move.status} ${JSON.stringify(move.body)}`);

    const status = await json(`${board.base}/api/github-status?workspace=off-loopback`);
    check('and GET /api/github-status answers, which is the route that diagnoses the rest',
          status.status === 200, `${status.status} ${JSON.stringify(status.body)}`);
  });

  const cdpPort = await freePort();
  children.push(spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1400,900',
    'about:blank',
  ], { stdio: 'ignore' }));

  await attach(cdpPort);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });

  await stage('3. and what the reader sees is never a refusal about the bind again', async () => {
    await send('Page.navigate', { url: `${board.base}/?workspace=off-loopback` });
    await waitFor(() => evaluate(GRAB_API), 'the Excalidraw API handle');
    check('the page itself came up, which is what lets it say why it is empty', true);

    // Something has to be said — `gh` is sealed for a check, so this mirror genuinely cannot be
    // read, and a 403 that is correct, logged and invisible is the state #320 is about. What it
    // must not say is that the server is bound in the wrong place: that sentence sent a reader who
    // had opened the board on purpose off to rebind a server that was bound correctly, and it is
    // the screen this whole issue was reported from.
    const spoke = await settles(async () => {
      const toasts = await evaluate('window.__toasts || []');
      return toasts.length ? toasts : null;
    });
    await shot('01-off-loopback');
    check('the board says something about why the mirror is empty', Boolean(spoke),
          'nothing reached the DOM at all, which is the silence #320 is about');
    check('and none of it blames the bind',
          !(spoke ?? []).some((text) => /loopback|bound to/i.test(text)), JSON.stringify(spoke));

    const strip = await settles(() => evaluate(STRIP));
    check('a cold board still draws the reason on itself, where the mirror would have been',
          Boolean(strip) && strip.kind === 'project-board', JSON.stringify(strip));
    check('in words about GitHub rather than about where the server opened',
          !/loopback|bound to/i.test(String(strip?.text ?? '')), JSON.stringify(strip?.text));
  });
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { socket?.close(); } catch { /* already gone */ }
  for (const child of children) {
    if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
  for (const server of servers) server.stop();
  await sleep(500);
  if (!argOf('--shots')) {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows may hold it */ }
  }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
