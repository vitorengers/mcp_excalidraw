#!/usr/bin/env node
/**
 * Checks, in a real browser, that the board says why the project mirror is empty.
 *
 * Every GitHub failure used to end in the same silence. `runGh` rejects with the last 300
 * characters of `gh`'s stderr, `GET /api/project-board` turns that into a 502, and the page
 * dropped it: a missing CLI, a logged-out one, a token without the `project` scope and a
 * project URL with a typo in it were one blank corner of canvas, repainted every twenty
 * seconds. `#254` fixed half of it — a *cold* board draws a strip — and left the other half,
 * which is a board whose mirror is already up and then stops being read.
 *
 * So the questions here are the ones only a browser settles, and one the server settles:
 *
 *  - **the reason reaches the reader as words**, in the DOM, within one poll, carrying `gh`'s
 *    own text rather than a sentence this project invented about it;
 *  - **it is said once.** The failure is the same failure every twenty seconds, so a toast per
 *    poll would be the fix becoming its own nuisance — the risk the issue names;
 *  - **a board with no project still says nothing at all.** Most boards are that board, and a
 *    toast on every one of them would make the feature unusable;
 *  - **a `githubProject` that is not a project URL is not that board.** The two shared one 404
 *    until now, which is why somebody who wrote a URL and got a typo in it got the silence
 *    meant for somebody who wrote nothing;
 *  - **`/health` says whether `gh` was found**, on a board with one and on a board without.
 *
 * Self-contained: three throwaway canvas servers, each with a stub `gh` of its own, and one
 * headless Chrome that visits three boards on the first of them. Run `./node_modules/.bin/tsc`
 * and `./node_modules/.bin/vite build` first — it loads the built frontend.
 *
 * Usage: node scripts/check-github-status-browser.mjs [--chrome <path>] [--shots <dir>]
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
import { openCanvas } from './lib/spawn-canvas.mjs';

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
const posix = (value) => value.replace(/\\/g, '/');

/**
 * One numbered section, whose failure is recorded rather than allowed to end the run.
 *
 * Written this way because of how this check was first proved. Run against the build that did
 * not have the fix, section 1 timed out waiting for a `/health` field that did not exist yet and
 * took the browser sections down with it — so the run reported one thing wrong when six were. A
 * check that stops at the first defect cannot say how much of a feature is missing, which is
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

// ─── Three boards and three `gh`s ─────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-gh-status-'));
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
mkdirSync(profileDir, { recursive: true });
mkdirSync(shotDir, { recursive: true });

const PROJECT_URL = 'https://github.com/users/vitorengers/projects/5';
/** What `gh` says when the credential is there and refused. The words the toast must carry. */
const REFUSAL = 'gh: Bad credentials (HTTP 401)';
/** What `gh` says when nobody is logged in at all. */
const LOGGED_OUT = 'You are not logged into any GitHub hosts. To log in, run: gh auth login';

const board = (id, config) => {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: id, ...config }), 'utf8');
  return { id, path: posix(dir) };
};

/**
 * Three boards on one server, because the failure being checked is per board rather than per
 * canvas: the frontend picks its board off `?workspace=`, so one Chrome can visit all three
 * without a click landing anywhere.
 */
const boards = [
  board('gh-refuses', { repo: 'vitorengers/vibemaxxing', githubProject: PROJECT_URL }),
  board('no-project', { repo: 'vitorengers/vibemaxxing' }),
  board('bad-url', { repo: 'vitorengers/vibemaxxing', githubProject: 'github.com/vitorengers' }),
];

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({ workspaces: boards }), 'utf8');

const soloDir = join(workDir, 'solo');
mkdirSync(soloDir, { recursive: true });
writeFileSync(join(soloDir, 'board.config.json'), JSON.stringify({
  name: 'solo', repo: 'vitorengers/vibemaxxing', githubProject: PROJECT_URL,
}), 'utf8');
const soloRegistry = join(workDir, 'workspaces-solo.json');
writeFileSync(soloRegistry, JSON.stringify({
  workspaces: [{ id: 'solo', path: posix(soloDir) }],
}), 'utf8');

/**
 * A `gh` that is installed and logged in, and that GitHub refuses.
 *
 * Installed and logged in on purpose: it is the *board read* that fails, so the sentence the
 * canvas has to reach for is `gh`'s own and not the preflight's. A stub that failed at every
 * step would let a toast that only ever says "gh is not installed" pass.
 */
const stubRefuses = join(workDir, 'gh-refuses.mjs');
writeFileSync(stubRefuses, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('gh version 2.96.0 (2026-07-02)\\n');
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write([
    'github.com',
    '  x Logged in to github.com account octocat (keyring)',
    "  - Token scopes: 'gist', 'project', 'read:org', 'repo'",
    '',
  ].join('\\n'));
  process.exit(0);
}
process.stderr.write(${JSON.stringify(REFUSAL)} + '\\n');
process.exit(1);
`, 'utf8');

/** A `gh` that is installed and has nobody logged into it. */
const stubLoggedOut = join(workDir, 'gh-logged-out.mjs');
writeFileSync(stubLoggedOut, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('gh version 2.96.0 (2026-07-02)\\n');
  process.exit(0);
}
process.stderr.write(${JSON.stringify(LOGGED_OUT)} + '\\n');
process.exit(1);
`, 'utf8');

/** No `gh` at all: a path that is not a file, which is what a machine without one looks like. */
const missingGh = posix(join(workDir, 'no-such-directory', 'gh.exe'));

const children = [];
const servers = [];

async function canvas(env) {
  const server = await openCanvas({ env: { LOG_LEVEL: 'error', ...env } });
  servers.push(server);
  return server;
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

/**
 * Two recorders, installed before the page's own scripts on every navigation.
 *
 * **The DOM one is the assertion the issue asks for** — a toast that was raised and never
 * rendered is the silence this is about, one layer along. It cannot answer "how many times",
 * because Excalidraw's toast lives for ten seconds and a second one carrying the same words
 * changes nothing in the DOM to see.
 *
 * **So the count comes off `console.warn`**, which `sayOnCanvas` writes to before it touches
 * the toast. That is one entry per call whatever the DOM does, which is exactly the question
 * the suppression rule has to answer.
 */
const RECORDERS = `
window.__warns = [];
const warn = console.warn.bind(console);
console.warn = (...parts) => {
  try { window.__warns.push(parts.map((part) => String(part && part.message ? part.message : part)).join(' ')); }
  catch (error) { /* nothing worth breaking the page for */ }
  warn(...parts);
};
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

/** Every mirror element on the scene, which is what "draws nothing" has to be measured against. */
const MIRROR = `(() => {
  const api = window.__boardCheckApi;
  if (!api) return null;
  return api.getSceneElements()
    .filter((element) => (element.customData || {}).kind === 'project-board')
    .map((element) => (element.customData || {}).role || 'unknown');
})()`;

const SAID = 'The project board could not be read';
const saidCount = async () =>
  (await evaluate(`(window.__warns || []).filter((line) => line.indexOf(${JSON.stringify(SAID)}) >= 0).length`));

/** Open a board and wait until the page has an Excalidraw to look at. */
async function openBoard(base, workspace) {
  await send('Page.navigate', { url: `${base}/?workspace=${encodeURIComponent(workspace)}` });
  await waitFor(() => evaluate(GRAB_API), `the Excalidraw API handle on "${workspace}"`);
}

const json = async (url) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

try {
  const refuses = await canvas({
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_GH_COMMAND: `node "${posix(stubRefuses)}"`,
  });
  const withoutGh = await canvas({
    EXCALIDRAW_WORKSPACES: soloRegistry,
    EXCALIDRAW_GH_COMMAND: `"${missingGh}"`,
  });
  const loggedOut = await canvas({
    EXCALIDRAW_WORKSPACES: soloRegistry,
    EXCALIDRAW_GH_COMMAND: `node "${posix(stubLoggedOut)}"`,
  });

  await stage('1. /health says whether gh was found', async () => {
  // The preflight is not awaited before `listen` — on purpose, so a `gh` that reaches the
  // network cannot delay the board coming up — so `probing` is the honest first answer and
  // this waits it out rather than asserting against it.
  const settled = (base) => waitFor(async () => {
    const health = (await json(`${base}/health`)).body;
    return health?.gh && health.gh.resolved !== 'probing' ? health : null;
  }, `the gh preflight on ${base}`, 60);

  const foundHealth = await settled(refuses.base);
  check('a board with a gh reports it found', foundHealth.gh.resolved === 'found',
        JSON.stringify(foundHealth.gh));
  check('with the version number it printed and nothing else', foundHealth.gh.version === '2.96.0',
        JSON.stringify(foundHealth.gh));
  check('and no login, scope or stderr on this unauthenticated route',
        !('login' in foundHealth.gh) && !('scopes' in foundHealth.gh) && !('error' in foundHealth.gh),
        JSON.stringify(foundHealth.gh));

  const missingHealth = await settled(withoutGh.base);
  check('a board without one reports it not found', missingHealth.gh.resolved === 'not found',
        JSON.stringify(missingHealth.gh));
  });

  await stage('2. GET /api/github-status answers what gh said about itself', async () => {
  const ok = await json(`${refuses.base}/api/github-status?workspace=gh-refuses`);
  check('a working gh answers 200', ok.status === 200, JSON.stringify(ok.body));
  check('installed and authenticated', ok.body?.gh?.installed === true && ok.body?.gh?.authenticated === true,
        JSON.stringify(ok.body?.gh));
  check('naming the account it is logged in as', ok.body?.gh?.login === 'octocat',
        JSON.stringify(ok.body?.gh));
  check('and the scopes, including the one a project board needs',
        Array.isArray(ok.body?.gh?.scopes) && ok.body.gh.scopes.includes('project'),
        JSON.stringify(ok.body?.gh?.scopes));

  const out = await json(`${loggedOut.base}/api/github-status?workspace=solo`);
  check('a logged-out gh is installed but not authenticated',
        out.body?.gh?.installed === true && out.body?.gh?.authenticated === false,
        JSON.stringify(out.body?.gh));
  check('carrying gh\'s own first line rather than a sentence about it',
        out.body?.gh?.error === LOGGED_OUT, JSON.stringify(out.body?.gh?.error));
  check('and no login or scopes claimed for an account that is not logged in',
        out.body?.gh?.login === null && Array.isArray(out.body?.gh?.scopes)
        && out.body.gh.scopes.length === 0, JSON.stringify(out.body?.gh));

  const none = await json(`${withoutGh.base}/api/github-status?workspace=solo`);
  check('a gh that is not there is not installed', none.body?.gh?.installed === false,
        JSON.stringify(none.body?.gh));
  });

  await stage('3. the two things a 404 used to mean are two answers', async () => {
  const silent = await json(`${refuses.base}/api/project-board?workspace=no-project`);
  check('a board with no githubProject is still 404', silent.status === 404,
        `${silent.status} ${JSON.stringify(silent.body)}`);
  check('and says so in the body', silent.body?.reason === 'no-project',
        JSON.stringify(silent.body));

  const typo = await json(`${refuses.base}/api/project-board?workspace=bad-url`);
  check('a githubProject that is not a project URL is not 404', typo.status !== 404,
        `${typo.status} ${JSON.stringify(typo.body)}`);
  check('it is 422, with a reason of its own', typo.status === 422
        && typo.body?.reason === 'bad-project-url', `${typo.status} ${JSON.stringify(typo.body)}`);
  check('naming the URL that could not be read',
        String(typo.body?.error ?? '').includes('github.com/vitorengers'),
        JSON.stringify(typo.body?.error));

  const refused = await json(`${refuses.base}/api/project-board?workspace=gh-refuses`);
  check('and a gh that refuses is still 502, carrying its own words',
        refused.status === 502 && String(refused.body?.error ?? '').includes('Bad credentials'),
        `${refused.status} ${JSON.stringify(refused.body)}`);
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDERS });

  await stage('4. the canvas says it, in a browser, within one poll', async () => {
  await openBoard(refuses.base, 'gh-refuses');
  const spoke = await waitFor(async () => {
    const toasts = await evaluate('window.__toasts || []');
    return toasts.some((text) => text.includes(SAID)) ? toasts : null;
  }, 'the board to say the project could not be read', 240);
  await shot('01-gh-refuses');
  check('the toast reached the DOM', spoke.some((text) => text.includes(SAID)),
        JSON.stringify(spoke));
  check('and it carries gh\'s own text rather than a status code',
        spoke.some((text) => text.includes('Bad credentials')), JSON.stringify(spoke));
  });

  await stage('5. and says it once, not once per poll', async () => {
  const before = await saidCount();
  check('said once so far', before === 1, String(before));
  // A refresh forced rather than waited for: the poll is twenty seconds and the page runs one
  // on becoming visible, which is the same call by the same path — what is being asserted is
  // the suppression, not the timer.
  for (let again = 0; again < 3; again++) {
    await evaluate('document.dispatchEvent(new Event("visibilitychange")); true');
    await sleep(1200);
  }
  const after = await saidCount();
  check('and still once after three more refreshes', after === 1, String(after));
  });

  await stage('6. a board with no githubProject draws nothing and says nothing', async () => {
  await openBoard(refuses.base, 'no-project');
  // Long enough for the first poll to have landed and been answered 404.
  await sleep(4000);
  await shot('02-no-project');
  const quietMirror = await evaluate(MIRROR);
  check('nothing of the mirror is drawn', Array.isArray(quietMirror) && quietMirror.length === 0,
        JSON.stringify(quietMirror));
  check('and nothing is said', (await saidCount()) === 0,
        JSON.stringify(await evaluate('window.__warns || []')));
  });

  await stage('7. a githubProject that is not a project URL is said out loud', async () => {
  await openBoard(refuses.base, 'bad-url');
  const typoSaid = await waitFor(async () => {
    const toasts = await evaluate('window.__toasts || []');
    return toasts.some((text) => text.includes(SAID)) ? toasts : null;
  }, 'the board to say the project URL could not be read', 240);
  await shot('03-bad-url');
  check('the toast reached the DOM', typoSaid.some((text) => text.includes(SAID)),
        JSON.stringify(typoSaid));
  check('naming the URL out of the board\'s own config',
        typoSaid.some((text) => text.includes('github.com/vitorengers')), JSON.stringify(typoSaid));
  });

  // The milestone's own case: a fresh clone, before anything is configured. What `gh` fails with
  // there is a spawn error naming a path, which is not something a reader can act on — so this
  // is the board that has to be handed the diagnosis rather than only the failure, and it is
  // what `GET /api/github-status` exists for.
  await stage('8. a board with no gh at all is told so, not shown a spawn error', async () => {
  await openBoard(withoutGh.base, 'solo');
  const clone = await waitFor(async () => {
    const toasts = await evaluate('window.__toasts || []');
    return toasts.some((text) => text.includes(SAID)) ? toasts : null;
  }, 'the board with no gh to say the project could not be read', 240);
  await shot('04-no-gh');
  check('the toast reached the DOM', clone.some((text) => text.includes(SAID)),
        JSON.stringify(clone));
  check('and says the CLI was not found rather than only quoting the spawn',
        clone.some((text) => text.includes('gh CLI was not found')), JSON.stringify(clone));
  check('naming the variable that points at it',
        clone.some((text) => text.includes('EXCALIDRAW_GH_COMMAND')), JSON.stringify(clone));
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
