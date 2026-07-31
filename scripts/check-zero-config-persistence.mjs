#!/usr/bin/env node
/**
 * The board a user with nothing configured draws on survives a restart (#314).
 *
 * Two mechanisms used to make that one board the one board that structurally could not be
 * saved. The first was the registry path, which returned nothing until #310 gave it a per-OS
 * default — with no registry there was no directory to save into. The second is what this
 * checks: the `default` store was the plain `Map` exported from `types.ts` rather than a
 * store that reports its own changes, so nothing could ever schedule a save of it, and
 * `seedBoardsFromFiles` only ever walked *registered* workspaces, so nothing ever read one
 * back. A user with no project registered drew, restarted, and it was gone.
 *
 * Self-contained and offline. No `EXCALIDRAW_*` reaches the server other than
 * `EXCALIDRAW_STATE_HOME`, which is the seam `core/settings.ts` documents for exactly this:
 * the run gets a throwaway config home in the temporary directory, so the registry it
 * resolves, the state directory it saves into and the pidfiles it writes are all this check's
 * and never the board the maintainer is looking at. There is no `--url`: pointing this at a
 * running board would assert against a registry that has projects in it, which is the one
 * case it is not about.
 *
 * No browser. The element goes in over `POST /api/elements` with no workspace named, which
 * is the same door the CLI and the MCP tools use when nobody has configured anything.
 *
 * Run `./node_modules/.bin/tsc` first — it reads `dist/`.
 *
 * Usage: node scripts/check-zero-config-persistence.mjs
 *
 * Tier: fast
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas, repoRoot } from './lib/spawn-canvas.mjs';

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

// ─── A config home of this run's own ──────────────────────────
//
// Before any compiled module is imported: this process asks `boardStateFile()` where the
// board would be saved, and it reads the environment in its own module body. The session
// this runs in exports the operator's whole `EXCALIDRAW_*` set and `PORT=3737`, and either
// would answer for the throwaway board below.

const workDir = join(tmpdir(), `zero-config-persistence-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const stateHome = join(workDir, 'config-home');
mkdirSync(stateHome, { recursive: true });

for (const key of Object.keys(process.env)) {
  if (key.startsWith('EXCALIDRAW_')) delete process.env[key];
}
delete process.env.PORT;
delete process.env.HOST;
process.env.EXCALIDRAW_NO_DOTENV = '1';
process.env.EXCALIDRAW_STATE_HOME = stateHome;

const boardStatePath = join(repoRoot, 'dist', 'core', 'board-state.js');
if (!existsSync(boardStatePath)) {
  console.error('  FAIL  the board state module exists — dist/core/board-state.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}
const { boardStateFile } = await import(pathToFileURL(boardStatePath).href);
const { registryPath } = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'workspaces.js')).href);

/**
 * The environment the servers below get: this check's, which has already had every
 * `EXCALIDRAW_*` but the config home taken out of it.
 *
 * `startCanvas` does the same stripping again for itself, so what is listed here is only what
 * is deliberately being handed over.
 */
const serverEnv = {
  EXCALIDRAW_STATE_HOME: stateHome,
  EXCALIDRAW_NO_DOTENV: '1',
  LOG_LEVEL: 'info',
};

const running = [];

async function start() {
  const server = startCanvas({ port: await freePort(), env: serverEnv });
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

const ELEMENT = {
  type: 'rectangle',
  x: 137,
  y: 241,
  width: 80,
  height: 40,
  backgroundColor: '#ffec99',
};

try {
  // ─── 1. Nothing is configured, and the board still knows where it would save ───

  console.log('1. nothing is configured, and the board still resolves a registry and a state file');

  const registry = registryPath();
  check('the registry resolves without EXCALIDRAW_WORKSPACES',
        Boolean(registry) && registry.startsWith(stateHome),
        `registryPath() = ${registry}, config home = ${stateHome}`);
  check('and nobody has written one yet — this is a first run',
        !existsSync(registry), registry);

  const savedFile = boardStateFile('default');
  check('the default board has a state file it would be saved in',
        typeof savedFile === 'string' && savedFile.startsWith(stateHome),
        `boardStateFile('default') = ${savedFile}`);
  check('which does not exist before anything is drawn',
        !existsSync(String(savedFile)), String(savedFile));

  // ─── 2. An element drawn on the board nobody configured ────────

  console.log('\n2. an element posted with no workspace named is written to disk');

  const first = await start();
  const created = await fetch(`${first.base}/api/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ELEMENT),
  });
  const createdBody = await created.json().catch(() => ({}));
  check('POST /api/elements is accepted', created.ok, `HTTP ${created.status}: ${JSON.stringify(createdBody)}`);

  const elementId = createdBody?.element?.id;
  check('and it answers with the element it stored', typeof elementId === 'string' && elementId.length > 0,
        JSON.stringify(createdBody));

  const inStore = await fetch(`${first.base}/api/elements`).then((r) => r.json());
  check('the running server has it', (inStore.elements ?? []).some((element) => element.id === elementId),
        `${(inStore.elements ?? []).length} element(s)`);

  // The save is debounced by a second with a five-second ceiling, so this is a poll rather
  // than a sleep: what is being asserted is that a file appears at all, not when.
  const appeared = await waitFor(async () => existsSync(String(savedFile)), 15_000);
  check('a board state file is written while the server is still up',
        Boolean(appeared),
        `nothing at ${savedFile} after 15s. Server log:\n${first.read()}`);

  check('and the server never said the default store cannot be saved',
        !/shared default store/.test(first.read()),
        first.read().split('\n').filter((line) => /default store/.test(line)).join('\n'));

  let saved = null;
  if (appeared) {
    try {
      saved = JSON.parse(readFileSync(String(savedFile), 'utf-8'));
    } catch (error) {
      check('the state file is a scene', false, (error).message);
    }
  }
  check('the file holds the element that was drawn',
        Boolean(saved) && (saved.elements ?? []).some((element) => element.id === elementId
          && element.x === ELEMENT.x && element.y === ELEMENT.y),
        JSON.stringify(saved?.elements ?? []).slice(0, 400));

  await stop(first);
  check('the state file survives the server that wrote it', existsSync(String(savedFile)));

  // ─── 3. And it is there again after a restart ──────────────────

  console.log('\n3. restarting the same zero-config board brings the element back');

  const second = await start();
  const back = await waitFor(async () => {
    const body = await fetch(`${second.base}/api/elements`).then((r) => r.json()).catch(() => null);
    const found = (body?.elements ?? []).find((element) => element.id === elementId);
    return found ?? null;
  }, 15_000);

  check('the element is in the default store of the new process', Boolean(back),
        `Server log:\n${second.read()}`);
  check('with the geometry it was drawn with',
        back?.x === ELEMENT.x && back?.y === ELEMENT.y && back?.width === ELEMENT.width,
        JSON.stringify(back ?? null));

  // A second edit on the restored board, to prove the restart left it saving rather than
  // merely restored once: a board that comes back read-only is the same loss one restart later.
  const again = await fetch(`${second.base}/api/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...ELEMENT, x: 900, y: 900 }),
  });
  const secondId = (await again.json().catch(() => ({})))?.element?.id;
  const both = await waitFor(async () => {
    try {
      const scene = JSON.parse(readFileSync(String(savedFile), 'utf-8'));
      const ids = new Set((scene.elements ?? []).map((element) => element.id));
      return ids.has(elementId) && ids.has(secondId) ? scene : null;
    } catch {
      return null;
    }
  }, 15_000);
  check('the restored board is still being saved, and keeps what it was restored with',
        Boolean(both),
        `Server log:\n${second.read()}`);

  await stop(second);
} finally {
  for (const server of running) server.stop();
  // Best effort: on Windows a file the dead child still holds keeps the directory alive for
  // a moment, and a cleanup that throws would hide the result of the run.
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* it is a temp dir */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
