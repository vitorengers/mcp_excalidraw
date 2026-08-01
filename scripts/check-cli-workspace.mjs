#!/usr/bin/env node
/**
 * The CLI and the MCP tools can name a project board, and what they draw on it is saved (#344).
 *
 * `src/core/canvas-client.ts` never sent `?workspace=`, so every CLI command and every MCP tool
 * acted on the `default` store whatever the board had registered. The product's headline claim —
 * that agents draw on your project board — was reachable only by hand-written REST, and an agent
 * that followed the bundled skill drew on a canvas with no tab.
 *
 * Five things are asserted here, and each of them is a way that failed:
 *
 *   1. `add --workspace <id>` lands in that board's store and in no other;
 *   2. with several projects registered and no workspace named, the command **refuses** and names
 *      the registered ids, rather than quietly writing to `default`;
 *   3. the environment variable is the same answer without the flag, and a named id that nobody
 *      registered is refused the same way a missing one is;
 *   4. an MCP `create_element` against a named workspace survives a **server restart** — which is
 *      the whole point of addressing a registered board rather than a scratch one;
 *   5. with exactly one project registered, "none named" is that project; with none registered it
 *      is still `default`, so a zero-config board behaves exactly as it did before.
 *
 * Self-contained and offline. Three throwaway registries in a temporary directory, two project
 * directories with a `board.config.json` each, and a canvas per registry on a port the kernel just
 * handed out. `EXCALIDRAW_STATE_HOME` is a throwaway too, so the pidfiles and the saved boards are
 * this check's and never the board the maintainer is looking at.
 *
 * **The CLI is deliberately given no registry of its own.** It is pointed at this run's canvas
 * with `--url` and told nothing else, because the client has to learn what is registered from the
 * *server* — an agent driving a board from another directory has no registry path and never will.
 *
 * Run `./node_modules/.bin/tsc` first — it runs `dist/bin.js` and reads `dist/`.
 *
 * Usage: node scripts/check-cli-workspace.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, startCanvas, repoRoot } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition, timeout, step = 100) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const answer = await condition();
    if (answer) return answer;
    if (Date.now() >= deadline) return null;
    await sleep(step);
  }
}

const binPath = join(repoRoot, 'dist', 'bin.js');
if (!existsSync(binPath)) {
  console.error('  FAIL  the CLI is built — dist/bin.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

// ─── A world of this run's own ────────────────────────────────

const workDir = join(tmpdir(), `cli-workspace-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const stateHome = join(workDir, 'config-home');
mkdirSync(stateHome, { recursive: true });

/** A project directory the registry can point at, with the config that makes it load clean. */
function project(id, name) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), `${JSON.stringify({ name }, null, 2)}\n`, 'utf-8');
  return dir.replace(/\\/g, '/');
}

const alphaDir = project('alpha', 'Alpha');
const betaDir = project('beta', 'Beta');

/** Write a registry and answer where it is. Its saved boards land beside it, in `<name>-state`. */
function registry(fileName, entries) {
  const file = join(workDir, fileName);
  writeFileSync(file, `${JSON.stringify({ workspaces: entries }, null, 2)}\n`, 'utf-8');
  return file;
}

const twoProjects = registry('two.json', [
  { id: 'alpha', path: alphaDir },
  { id: 'beta', path: betaDir },
]);
const oneProject = registry('one.json', [{ id: 'alpha', path: alphaDir }]);
const noProjects = registry('none.json', []);

const running = [];

async function start(registryPath) {
  const server = startCanvas({
    port: await freePort(),
    env: {
      EXCALIDRAW_STATE_HOME: stateHome,
      EXCALIDRAW_WORKSPACES: registryPath,
      LOG_LEVEL: 'info',
    },
  });
  running.push(server);
  const healthy = await waitFor(async () => {
    if (server.child.exitCode !== null) return null;
    try {
      return (await fetch(`${server.base}/health`)).ok ? true : null;
    } catch {
      return null;
    }
  }, 20_000);
  if (!healthy) {
    server.stop();
    throw new Error(`the canvas never answered on ${server.base}:\n${server.read()}`);
  }
  return server;
}

async function stop(server) {
  server.stop();
  await waitFor(async () => server.child.exitCode !== null || server.child.signalCode !== null, 10_000);
}

/**
 * The environment a client process gets: this one's, stripped of every configuration variable
 * the machine could smuggle in, plus whatever the case is about.
 *
 * No registry path, on purpose — see the note at the top — and no canvas either: which canvas
 * is said on the command line, with `--url`, so that nothing a check talks to is decided by a
 * variable. `scripts/check-no-external-server.mjs` holds every check to that.
 */
function clientEnvironment(overrides = {}) {
  return canvasEnvironment({
    EXCALIDRAW_NO_AUTOSTART: '1',
    ...overrides,
  });
}

/** Run the built CLI and answer what it printed and how it left. */
function runCli(base, args, overrides = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, '--url', base, ...args], {
      cwd: repoRoot,
      env: clientEnvironment(overrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const rectangle = (x, y) => JSON.stringify({
  type: 'rectangle', x, y, width: 80, height: 40, backgroundColor: '#ffec99',
});

/** Elements the server holds for one board, over the door the frontend's tab uses. */
async function elementsOn(base, workspaceId) {
  const url = workspaceId
    ? `${base}/api/elements?workspace=${encodeURIComponent(workspaceId)}`
    : `${base}/api/elements`;
  const body = await fetch(url).then((response) => response.json()).catch(() => null);
  return body?.elements ?? [];
}

/**
 * Call one MCP tool over stdio, the way a client would, and answer the tool's result.
 *
 * The bin is the entry point rather than `dist/index.js` so that what is exercised is the same
 * process an MCP client actually starts.
 */
async function callTool(base, name, args, timeoutMs = 25_000) {
  const child = spawn(process.execPath, [binPath, '--url', base, 'mcp'], {
    cwd: repoRoot,
    env: clientEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.resume();

  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'check-cli-workspace', version: '0' },
    },
  });

  const answerTo = (id) => {
    for (const line of out.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const message = JSON.parse(line);
        if (message.id === id) return message;
      } catch { /* a partial line */ }
    }
    return null;
  };

  try {
    const ready = await waitFor(async () => answerTo(1), timeoutMs);
    if (!ready) return { error: 'the MCP server never answered initialize' };
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
    const answer = await waitFor(async () => answerTo(2), timeoutMs);
    if (!answer) return { error: `the MCP server never answered ${name}` };
    return answer.result ?? { error: JSON.stringify(answer.error) };
  } finally {
    child.kill();
  }
}

/** The tools a client is offered, so that a new argument can be asserted on the schema itself. */
async function listTools(base, timeoutMs = 25_000) {
  const child = spawn(process.execPath, [binPath, '--url', base, 'mcp'], {
    cwd: repoRoot,
    env: clientEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.resume();
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'check-cli-workspace', version: '0' },
    },
  });
  const answerTo = (id) => {
    for (const line of out.split('\n')) {
      if (!line.trim().startsWith('{')) continue;
      try {
        const message = JSON.parse(line);
        if (message.id === id) return message;
      } catch { /* a partial line */ }
    }
    return null;
  };
  try {
    if (!(await waitFor(async () => answerTo(1), timeoutMs))) return [];
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const answer = await waitFor(async () => answerTo(2), timeoutMs);
    return answer?.result?.tools ?? [];
  } finally {
    child.kill();
  }
}

try {
  // ─── 1. A named board is the board that is drawn on ────────────

  console.log('1. `add --workspace <id>` puts the element in that board and in no other');

  const board = await start(twoProjects);

  const named = await runCli(board.base, ['add', '--one', rectangle(10, 20), '--workspace', 'alpha']);
  check('the CLI exits 0', named.code === 0, `exit ${named.code}\n${named.stderr}`);

  let created = null;
  try {
    created = JSON.parse(named.stdout);
  } catch { /* asserted below */ }
  const namedId = created?.elements?.[0]?.id;
  check('and prints the element it created', typeof namedId === 'string' && namedId.length > 0,
        named.stdout.slice(0, 300));

  const inAlpha = await elementsOn(board.base, 'alpha');
  check('the element is in "alpha"', inAlpha.some((element) => element.id === namedId),
        `${inAlpha.length} element(s) in alpha`);

  const inBeta = await elementsOn(board.base, 'beta');
  check('and not in "beta"', !inBeta.some((element) => element.id === namedId),
        `${inBeta.length} element(s) in beta`);

  const inDefault = await elementsOn(board.base, null);
  check('and not in "default" — which is where every CLI command used to land',
        !inDefault.some((element) => element.id === namedId),
        `${inDefault.length} element(s) in default`);

  // ─── 2. Naming none of several is a refusal, not a guess ───────

  console.log('\n2. with two projects registered and no workspace named, the command refuses');

  const ambiguous = await runCli(board.base, ['add', '--one', rectangle(30, 40)]);
  check('the CLI exits non-zero', ambiguous.code !== 0, `exit ${ambiguous.code}\n${ambiguous.stdout}`);
  check('and the message names both registered ids',
        /alpha/.test(ambiguous.stderr) && /beta/.test(ambiguous.stderr),
        ambiguous.stderr.slice(0, 400));
  check('and says how to name one',
        /--workspace/.test(ambiguous.stderr), ambiguous.stderr.slice(0, 400));

  const defaultAfter = await elementsOn(board.base, null);
  check('nothing was written to "default"', defaultAfter.length === 0,
        `${defaultAfter.length} element(s) in default`);

  // ─── 3. The environment is the same answer, and a typo is refused ───

  console.log('\n3. the environment names a default board, and an unregistered id is refused');

  const fromEnv = await runCli(board.base, ['add', '--one', rectangle(50, 60)],
                               { EXCALIDRAW_WORKSPACE: 'beta' });
  check('the CLI exits 0 with EXCALIDRAW_WORKSPACE set', fromEnv.code === 0,
        `exit ${fromEnv.code}\n${fromEnv.stderr}`);
  let fromEnvId = null;
  try { fromEnvId = JSON.parse(fromEnv.stdout)?.elements?.[0]?.id ?? null; } catch { /* below */ }
  const betaAfter = await elementsOn(board.base, 'beta');
  check('and the element is in "beta"', Boolean(fromEnvId) && betaAfter.some((element) => element.id === fromEnvId),
        `${betaAfter.length} element(s) in beta`);

  const flagBeatsEnv = await runCli(board.base, ['add', '--one', rectangle(70, 80), '--workspace', 'alpha'],
                                    { EXCALIDRAW_WORKSPACE: 'beta' });
  let flagId = null;
  try { flagId = JSON.parse(flagBeatsEnv.stdout)?.elements?.[0]?.id ?? null; } catch { /* below */ }
  const alphaAfterFlag = await elementsOn(board.base, 'alpha');
  check('the flag beats the environment', Boolean(flagId) && alphaAfterFlag.some((element) => element.id === flagId),
        `exit ${flagBeatsEnv.code}, alpha holds ${alphaAfterFlag.length}\n${flagBeatsEnv.stderr}`);

  const typo = await runCli(board.base, ['add', '--one', rectangle(90, 100), '--workspace', 'alfa']);
  check('a workspace nobody registered is refused', typo.code !== 0,
        `exit ${typo.code}\n${typo.stdout}`);
  check('and that refusal names the registered ids too',
        /alpha/.test(typo.stderr) && /beta/.test(typo.stderr), typo.stderr.slice(0, 400));
  const typoStore = await elementsOn(board.base, 'alfa');
  check('and nothing was written to the store the typo named', typoStore.length === 0,
        `${typoStore.length} element(s) in "alfa"`);

  // ─── 4. An MCP tool names one, and what it draws survives a restart ───

  console.log('\n4. an MCP create_element against a named workspace survives a restart');

  const tools = await listTools(board.base);
  const createTool = tools.find((tool) => tool.name === 'create_element');
  check('create_element offers a `workspace` argument',
        Boolean(createTool?.inputSchema?.properties?.workspace),
        JSON.stringify(Object.keys(createTool?.inputSchema?.properties ?? {})));
  check('and it is optional', !(createTool?.inputSchema?.required ?? []).includes('workspace'),
        JSON.stringify(createTool?.inputSchema?.required ?? []));

  const mcp = await callTool(board.base, 'create_element', {
    type: 'ellipse', x: 500, y: 600, width: 90, height: 50, workspace: 'alpha',
  });
  const mcpText = (mcp?.content ?? []).map((part) => part.text ?? '').join('\n');
  check('the tool call succeeds', mcp?.isError !== true && !mcp?.error,
        JSON.stringify(mcp ?? null).slice(0, 400));

  const mcpMatch = /"id"\s*:\s*"([^"]+)"/.exec(mcpText);
  const mcpId = mcpMatch?.[1] ?? null;
  check('and answers with the element it created', Boolean(mcpId), mcpText.slice(0, 300));

  const alphaHasMcp = await waitFor(async () => {
    const elements = await elementsOn(board.base, 'alpha');
    return elements.some((element) => element.id === mcpId) ? elements : null;
  }, 10_000);
  check('the element is in "alpha" on the running board', Boolean(alphaHasMcp),
        `alpha holds ${(await elementsOn(board.base, 'alpha')).length}`);

  const defaultAfterMcp = await elementsOn(board.base, null);
  check('and "default" is still empty', defaultAfterMcp.length === 0,
        `${defaultAfterMcp.length} element(s) in default`);

  // The save is debounced with a five-second ceiling, so this waits for the file rather than
  // sleeping. It waits for the file to *hold both elements* rather than merely to exist: the
  // file was created back in section 1, so `existsSync` alone returns at once and the kill
  // below then races the debounce — which is what failed inside a loaded suite run while
  // passing standalone every time.
  const savedFile = join(workDir, 'two-state', 'alpha.excalidraw');
  const saved = await waitFor(async () => {
    try {
      const ids = new Set((JSON.parse(readFileSync(savedFile, 'utf-8')).elements ?? [])
        .map((element) => element.id));
      return ids.has(mcpId) && ids.has(namedId) ? ids : null;
    } catch {
      return null;
    }
  }, 20_000);
  check('alpha is saved beside its registry, with both elements in the file', Boolean(saved),
        `${savedFile}\n${board.read().slice(-1500)}`);

  await stop(board);

  const restarted = await start(twoProjects);
  const back = await waitFor(async () => {
    const elements = await elementsOn(restarted.base, 'alpha');
    return elements.some((element) => element.id === mcpId) ? elements : null;
  }, 15_000);
  check('and it is there again after a restart', Boolean(back),
        `Server log:\n${restarted.read().slice(-1500)}`);
  check('together with what the CLI drew on the same board',
        Boolean(back) && back.some((element) => element.id === namedId),
        JSON.stringify((back ?? []).map((element) => element.id)));

  await stop(restarted);

  // ─── 5. One project, and none ──────────────────────────────────

  console.log('\n5. one registered project is the answer; none registered is still `default`');

  const single = await start(oneProject);
  const unnamed = await runCli(single.base, ['add', '--one', rectangle(110, 120)]);
  check('with exactly one project registered the command does not refuse', unnamed.code === 0,
        `exit ${unnamed.code}\n${unnamed.stderr}`);
  let singleId = null;
  try { singleId = JSON.parse(unnamed.stdout)?.elements?.[0]?.id ?? null; } catch { /* below */ }
  const singleAlpha = await elementsOn(single.base, 'alpha');
  check('and the element lands in that project rather than in `default`',
        Boolean(singleId) && singleAlpha.some((element) => element.id === singleId),
        `alpha holds ${singleAlpha.length}`);
  const singleDefault = await elementsOn(single.base, null);
  check('`default` stays empty', !singleDefault.some((element) => element.id === singleId),
        `${singleDefault.length} element(s) in default`);
  await stop(single);

  const bare = await start(noProjects);
  const zeroConfig = await runCli(bare.base, ['add', '--one', rectangle(130, 140)]);
  check('with nothing registered the command still works', zeroConfig.code === 0,
        `exit ${zeroConfig.code}\n${zeroConfig.stderr}`);
  let zeroId = null;
  try { zeroId = JSON.parse(zeroConfig.stdout)?.elements?.[0]?.id ?? null; } catch { /* below */ }
  const zeroDefault = await elementsOn(bare.base, null);
  check('and it lands on `default`, exactly as it did before this existed',
        Boolean(zeroId) && zeroDefault.some((element) => element.id === zeroId),
        `${zeroDefault.length} element(s) in default`);
  await stop(bare);
} finally {
  for (const server of running) server.stop();
  // Best effort: on Windows a file a dead child still holds keeps the directory alive for a
  // moment, and a cleanup that throws would hide the result of the run.
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
