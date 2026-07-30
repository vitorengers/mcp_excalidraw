#!/usr/bin/env node
/**
 * Checks the research run's clock in a real browser.
 *
 * `check-issue-progress.mjs` covers the record, the element copy and the parsing. None of that
 * shows a clock, and the whole feature *is* the clock: the server writes one instant and never
 * mentions it again, so if the browser does not do the arithmetic and re-render on a timer, the
 * panel shows a number that was true when the block was selected and stays wrong for the rest
 * of the investigation. That failure type-checks perfectly, which is this repository's stated
 * reason for looking at a browser at all.
 *
 * So the questions here are the ones only a browser can answer. Does a duration appear in a
 * running block's panel, where a fixed sentence used to be the whole of it? Does it advance on
 * its own, with no reload and no click? Do the token counts turn up beside it when the agent
 * streams them — they come from a poll rather than from the element, so they are the half that
 * can silently never arrive? And does the board stay still while all of that moves: the
 * element's `version` is read from the server across the same span, because a clock that churns
 * the board is the failure this design exists to avoid.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already depends
 * on. Self-contained otherwise: it builds a throwaway workspace, writes a stub agent that
 * streams NDJSON and a stub `gh`, starts its own canvas server and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the built
 * frontend.
 *
 * Usage: node scripts/check-issue-progress-browser.mjs [--chrome <path>] [--shots <dir>]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

/** `4:07` or `1:12:30` back into seconds, so two readings can be compared. */
function asSeconds(text) {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(text ?? '');
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// ─── A board with an observation to research ──────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-issue-progress-browser-'));
const projectDir = join(workDir, 'research-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const REPO = 'vitorengers/mcp_excalidraw';
const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'research-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Research Project',
  repo: REPO,
}), 'utf8');

/**
 * A stub research agent that streams the way `claude -p --output-format stream-json --verbose`
 * does, then waits to be released so the run can be watched while it is live.
 */
const agentStub = join(workDir, 'agent.mjs');
writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const workDir = ${JSON.stringify(workDir)};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const usage = (i, cc, cr, o) => ({
  input_tokens: i, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: o,
});

process.stdin.resume();
process.stdin.on('end', async () => {
  line({ type: 'system', subtype: 'init', session_id: 'stub' });
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(120, 900, 6800, 240) } });
  // Reasoning, where Claude Code actually puts it — an event of its own, with a running total
  // that restarts at every turn. 90 + 22 for the first, then 18 for the second: the run is at
  // 130, which is what the panel has to show rather than 18.
  const thinking = (estimated_tokens, estimated_tokens_delta) =>
    line({ type: 'system', subtype: 'thinking_tokens', estimated_tokens, estimated_tokens_delta });
  thinking(90, 90);
  thinking(112, 22);
  thinking(18, 18);
  for (let attempt = 0; attempt < 1800; attempt++) {
    if (existsSync(join(workDir, 'release'))) break;
    await sleep(100);
  }
  line({
    type: 'result',
    subtype: 'success',
    result: 'https://github.com/${REPO}/issues/702',
    usage: usage(120, 900, 6800, 310),
  });
});
`, 'utf8');

/** Stands in for `gh`, so the end of the run has an issue to read back. */
const ghStub = join(workDir, 'gh.mjs');
writeFileSync(ghStub, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'issue' && args[1] === 'view') {
  process.stdout.write(JSON.stringify({
    number: 702,
    title: 'The issue the run produced',
    body: 'Researched.',
    state: 'OPEN',
    comments: [],
    stateReason: null,
    closedByPullRequestsReferences: [],
  }));
} else {
  process.stderr.write('stub gh: unexpected call ' + args.join(' ') + '\\n');
  process.exit(1);
}
`, 'utf8');

const PORT = await freePort();
const CDP_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
// Nothing this machine exports reaches the child: `scripts/lib/spawn-canvas.mjs` strips every
// `EXCALIDRAW_*` before the check's own values go in, so there is no terminal block over the
// board — and no other inherited setting — unless this check asks for it.
const serverEnv = {
  PORT: String(PORT),
  HOST: '127.0.0.1',
  LOG_LEVEL: 'error',
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_ISSUE_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p --output-format stream-json`,
  EXCALIDRAW_GH_COMMAND: `node "${ghStub.replace(/\\/g, '/')}"`,
};

const server = startCanvas({
  env: serverEnv,
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

const api = (path, options = {}) => fetch(
  `${BASE}${path}${path.includes('?') ? '&' : '?'}workspace=${WORKSPACE}`,
  { headers: { 'Content-Type': 'application/json' }, ...options }
);

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
        window.__researchCheckApi = value;
        return true;
      }
      state = state.next;
    }
    node = node.return;
  }
  return false;
})()`;

/** What the panel is showing right now, as the reader sees it. */
const PANEL = `(() => {
  const progress = document.querySelector('.element-docs__progress');
  const tokens = document.querySelector('.element-docs__tokens');
  const hints = [...document.querySelectorAll('.element-docs__hint')].map((p) => p.textContent);
  return {
    progress: progress ? progress.textContent : null,
    tokens: tokens ? tokens.textContent : null,
    hints,
    body: document.querySelector('.element-docs') ? document.querySelector('.element-docs').textContent : null,
  };
})()`;

const select = (id) => evaluate(
  `window.__researchCheckApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(id)}: true } } })`
);

const elementNow = async (id) => (await (await api(`/api/elements/${id}`)).json())?.element ?? null;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // A draft block with an observation written into it, which is what one looks like the
  // moment before somebody presses Create issue.
  const created = await (await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 120, y: 120, width: 300, height: 140,
      text: 'The panel says nothing while a run is going.',
      customData: { kind: 'issue', issueState: 'draft' },
    }),
  })).json();
  const blockId = created?.element?.id;
  if (!blockId) throw new Error(`could not create the issue block: ${JSON.stringify(created)}`);

  const started = await (await api(`/api/issue-block/${blockId}`, { method: 'POST' })).json();
  if (!started?.success) throw new Error(`the run was refused: ${JSON.stringify(started)}`);

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
  await waitFor(async () =>
    (await evaluate(`window.__researchCheckApi.getSceneElements().some((e) => e.id === ${JSON.stringify(blockId)})`)),
    'the block to reach the board');

  console.log('1. selecting a running block shows how long it has been researching');
  await select(blockId);
  const first = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return asSeconds(panel.progress) === null ? null : panel;
  }, 'a duration in the panel');
  await shot('01-running');
  check('a duration is on screen', asSeconds(first.progress) !== null, `progress=${first.progress}`);
  // The sentence this was added beside, still there: the clock is the number it was missing,
  // not a replacement for it.
  check('the panel still says the run has no time limit',
        first.hints.some((text) => /no time\s*limit/i.test(text ?? '')),
        JSON.stringify(first.hints));

  console.log('\n2. it advances on its own, with no reload and no click');
  const firstSeconds = asSeconds(first.progress);
  const versionBefore = (await elementNow(blockId))?.version ?? null;
  await sleep(5000);
  const later = await evaluate(PANEL);
  const laterSeconds = asSeconds(later.progress);
  await shot('02-ticked');
  check('the clock moved on', laterSeconds !== null && laterSeconds - firstSeconds >= 4,
        `${first.progress} → ${later.progress}`);
  check('by about the time that passed, not by a jump',
        laterSeconds !== null && laterSeconds - firstSeconds <= 8,
        `${first.progress} → ${later.progress}`);

  console.log('\n3. and the board did not move while it did');
  const versionAfter = (await elementNow(blockId))?.version ?? null;
  check('the block was not rewritten once a second', versionAfter === versionBefore,
        `version ${versionBefore} became ${versionAfter} — a clock written onto the shape churns every export`);

  console.log('\n4. the token counts turn up beside it, because this agent streams them');
  const spending = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return panel.tokens ? panel : null;
  }, 'token counts in the panel');
  await shot('03-tokens');
  // 120 + 900 + 6800 is what the model was given; 240 is what it wrote back.
  check('the input total is shown', /7\.8k\s*in/.test(spending.tokens ?? ''), `tokens=${spending.tokens}`);
  check('and the output total', /240\s*out/.test(spending.tokens ?? ''), `tokens=${spending.tokens}`);
  // In brackets and after `out`, because it is a part of that figure rather than a third
  // total: 130 of the 240 output tokens went on thinking.
  const thinkingShown = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return /thinking/.test(panel.tokens ?? '') ? panel : null;
  }, 'the reasoning split in the panel');
  await shot('03b-thinking');
  check('the reasoning split reads as part of out, in brackets',
        /240\s*out\s*\(\s*130\s*thinking\s*\)/.test(thinkingShown.tokens ?? ''),
        `tokens=${thinkingShown.tokens}`);

  console.log('\n5. the run ends and the block becomes the issue it produced');
  writeFileSync(join(workDir, 'release'), '', 'utf8');
  const finished = await waitFor(async () => {
    const element = await elementNow(blockId);
    return element?.customData?.issueState === 'created' ? element : null;
  }, 'the block to reach created');
  await sleep(1500);
  await shot('04-created');
  check('the block carries the issue the run returned',
        finished?.customData?.issueUrl === `https://github.com/${REPO}/issues/702`,
        `issueUrl=${finished?.customData?.issueUrl}`);
  // Both ends of the clock are on the shape, so the block reads correctly with nothing
  // selected and with no network — which is the whole reason the instants are not on the
  // record alone.
  check('and both ends of its clock', Boolean(finished?.customData?.issueStartedAt)
        && Boolean(finished?.customData?.issueEndedAt),
        JSON.stringify(finished?.customData));
  const after = await evaluate(PANEL);
  check('the panel moved on to the issue rather than the run',
        !/Researching the repository/.test(after.body ?? ''), (after.body ?? '').slice(0, 200));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  try { writeFileSync(join(workDir, 'release'), '', 'utf8'); } catch { /* already gone */ }
  try { socket?.close(); } catch { /* already gone */ }
  await sleep(400);
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
