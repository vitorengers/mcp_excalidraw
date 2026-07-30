#!/usr/bin/env node
/**
 * Checks the run clock in a real browser.
 *
 * `check-implement-progress.mjs` covers the record, the element copy and the parsing. None
 * of that shows a clock, and the whole feature *is* the clock: the server writes one
 * instant and never mentions it again, so if the browser does not do the arithmetic and
 * re-render on a timer, the panel shows a number that was true when the block was selected
 * and stays wrong for the rest of the run. That failure type-checks perfectly, which is
 * this repository's stated reason for looking at a browser at all.
 *
 * So the questions here are the ones only a browser can answer. Does a duration appear in
 * the panel while a run is in flight? Does it advance on its own, with no reload and no
 * click? Do the token counts turn up beside it when the agent streams them? And does the
 * board stay still while all of that moves — the element's `version` is read from the
 * server across the same span, because a clock that churns the board is the failure this
 * design exists to avoid.
 *
 * Chrome is driven over the DevTools protocol through `ws`, which the server already
 * depends on. Self-contained otherwise: it builds a throwaway workspace, writes a stub
 * agent that streams NDJSON, starts its own canvas server and kills both. Run
 * `./node_modules/.bin/tsc` and `./node_modules/.bin/vite build` first — it loads the
 * built frontend.
 *
 * Usage: node scripts/check-implement-progress-browser.mjs [--chrome <path>] [--shots <dir>]
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

/** `4:07` or `1:12:30` back into seconds, so two readings can be compared. */
function asSeconds(text) {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{2})/.exec(text ?? '');
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// ─── A project with an issue to implement ─────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-progress-browser-'));
const projectDir = join(workDir, 'progress-project');
const profileDir = join(workDir, 'chrome-profile');
const shotDir = argOf('--shots') ?? join(workDir, 'shots');
for (const dir of [projectDir, profileDir, shotDir]) mkdirSync(dir, { recursive: true });

const ISSUE = 'https://github.com/vitorengers/mcp_excalidraw/issues/701';
const registryPath = join(workDir, 'workspaces.json');
const WORKSPACE = 'progress-project';
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: WORKSPACE, path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');
// No githubProject: the mirror stays dormant, so nothing else is drawing on this board.
writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'Progress Project',
  repo: 'vitorengers/mcp_excalidraw',
}), 'utf8');

/**
 * A stub agent that streams the way `claude -p --output-format stream-json --verbose`
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

let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  line({ type: 'system', subtype: 'init', session_id: 'stub' });
  line({ type: 'assistant', message: { id: 'msg_a', usage: usage(120, 900, 6800, 240) } });
  // Reasoning, where Claude Code actually puts it — an event of its own, with a running
  // total that restarts at every turn. 90 + 22 for the first, then 18 for the second: the
  // run is at 130, which is what the panel has to show rather than 18.
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
    result: 'https://github.com/vitorengers/mcp_excalidraw/pull/701',
    usage: { iterations: [usage(120, 900, 6800, 310)] },
  });
});
`, 'utf8');

const PORT = 35700 + (process.pid % 200);
const CDP_PORT = PORT + 400;
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];

let serverLog = '';
const server = spawn(process.execPath, [join(repoRoot, 'dist', 'server.js')], {
  cwd: repoRoot,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'error',
    EXCALIDRAW_WORKSPACES: registryPath,
    EXCALIDRAW_IMPLEMENT_AGENT: `node "${agentStub.replace(/\\/g, '/')}" -p --output-format stream-json`,
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
        window.__progressCheckApi = value;
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
  const hint = document.querySelector('.element-docs__hint');
  const links = [...document.querySelectorAll('.element-docs__issue-link')].map((a) => a.textContent);
  return {
    progress: progress ? progress.textContent : null,
    tokens: tokens ? tokens.textContent : null,
    hint: hint ? hint.textContent : null,
    links,
  };
})()`;

const select = (id) => evaluate(
  `window.__progressCheckApi.updateScene({ appState: { selectedElementIds: { ${JSON.stringify(id)}: true } } })`
);

const versionNow = async (id) => (await (await api(`/api/elements/${id}`)).json())?.element?.version ?? null;

try {
  await waitFor(async () => (await fetch(`${BASE}/health`)).ok, 'the canvas server');

  // A block that already carries the issue, which is what an authored one looks like once
  // the research agent has finished with it.
  const created = await (await api('/api/elements', {
    method: 'POST',
    body: JSON.stringify({
      type: 'rectangle', x: 120, y: 120, width: 260, height: 120,
      customData: { kind: 'issue', issueState: 'created', issueUrl: ISSUE, issueTitle: 'A run to watch' },
    }),
  })).json();
  const blockId = created?.element?.id;
  if (!blockId) throw new Error(`could not create the issue block: ${JSON.stringify(created)}`);

  const started = await (await api('/api/implement', {
    method: 'POST', body: JSON.stringify({ url: ISSUE }),
  })).json();
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
    (await evaluate(`window.__progressCheckApi.getSceneElements().some((e) => e.id === ${JSON.stringify(blockId)})`)),
    'the block to reach the board');

  console.log('1. selecting the block shows how long the run has been going');
  await select(blockId);
  const first = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return asSeconds(panel.progress) === null ? null : panel;
  }, 'a duration in the panel');
  await shot('01-running');
  check('a duration is on screen', asSeconds(first.progress) !== null, `progress=${first.progress}`);
  check('the panel still says the run has no time limit',
        /no time\s*limit/i.test(first.hint ?? ''), `hint=${first.hint}`);

  console.log('\n2. it advances on its own, with no reload and no click');
  const firstSeconds = asSeconds(first.progress);
  const versionBefore = await versionNow(blockId);
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
  const versionAfter = await versionNow(blockId);
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

  console.log('\n5. a finished run shows a total rather than a live clock');
  writeFileSync(join(workDir, 'release'), '', 'utf8');
  const finished = await waitFor(async () => {
    const panel = await evaluate(PANEL);
    return panel.links.some((text) => /Implemented/.test(text ?? '')) ? panel : null;
  }, 'the run to finish in the panel');
  await shot('04-done');
  const frozen = asSeconds(finished.progress);
  check('the duration is still shown once it is over', frozen !== null, `progress=${finished.progress}`);
  await sleep(4000);
  const stillFrozen = await evaluate(PANEL);
  check('and it has stopped moving', asSeconds(stillFrozen.progress) === frozen,
        `${finished.progress} → ${stillFrozen.progress}`);
  check('the pull request is linked',
        stillFrozen.links.some((text) => /Implemented .*\/pull\/701/.test(text ?? '')),
        JSON.stringify(stillFrozen.links));
  check('the final token totals are the ones the agent settled on',
        /310\s*out/.test(stillFrozen.tokens ?? ''), `tokens=${stillFrozen.tokens}`);
  // The `result` event settles input and output and says nothing about reasoning. If the
  // settled totals replace the whole figure, the split is on screen for the length of the
  // run and gone the moment it is finished and worth reading.
  check('and the reasoning split is still there beside them',
        /310\s*out\s*\(\s*130\s*thinking\s*\)/.test(stillFrozen.tokens ?? ''),
        `tokens=${stillFrozen.tokens}`);
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
