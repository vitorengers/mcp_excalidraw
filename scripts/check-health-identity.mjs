#!/usr/bin/env node
/**
 * Checks that `GET /health` says what kind of canvas is answering.
 *
 * A terminal on the board was asked to restart the server. It killed the server that hosts the
 * terminal, and `ensureCanvasRunning` — from an MCP server attached to an editor session —
 * auto-started a replacement with the environment it happened to be holding, which had no
 * `EXCALIDRAW_*` in it at all. The stand-in bound the board's port with no workspace registry,
 * no terminal and no agents, and answered `/health` with `status: healthy` and the same
 * `service` marker as the board it replaced.
 *
 * So nothing about the one endpoint whose job is to say whether the thing works distinguished a
 * working board from a shell of one. Telling them apart took three more requests —
 * `/api/workspaces` for `configured:false`, `/api/terminal` for its 404, `/api/elements` for the
 * empty canvas — and until somebody thought to make them, every sign said the restart had
 * worked.
 *
 * `service` and `pid` are deliberately asserted unchanged: they are the identity contract
 * `stop` and `isCanvasHealth` depend on, and this must add to `/health` without disturbing them.
 *
 * Self-contained: it starts its own canvas servers on free ports of their own and kills them,
 * one with nothing configured and one with a registry and a terminal. Nothing here talks to the
 * board, to GitHub or to the network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-health-identity.mjs
 *
 * Tier: fast
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function healthOf(port, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

const workDir = join(tmpdir(), `health-identity-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const started = [];

/**
 * A canvas server with exactly the environment given. The stripping this used to do by hand —
 * every `EXCALIDRAW_*` out of the child's environment, so the machine running the check cannot
 * decide the answer — is `scripts/lib/spawn-canvas.mjs`'s job now, and it also turns off the
 * `.env` beside the working directory, which the hand-rolled version never could.
 */
async function canvasWith(extraEnv) {
  const port = await freePort();
  const { child } = startCanvas({ port, env: extraEnv });
  started.push(child);
  const health = await healthOf(port);
  return { port, health, pid: child.pid };
}

// ─── A canvas with nothing configured ─────────────────────────

console.log('\nA canvas with nothing configured');

const bare = await canvasWith({});
check('it answers /health at all', bare.health !== null);

if (bare.health) {
  check('it still identifies as this service',
    bare.health.service === 'mcp-excalidraw-canvas', `service was ${bare.health.service}`);
  check('and still self-reports its pid, which `stop` depends on',
    bare.health.pid === bare.pid, `said ${bare.health.pid}, is ${bare.pid}`);
  check('/health says it has no workspace registry',
    bare.health.workspaces === 'none', `workspaces was ${JSON.stringify(bare.health.workspaces)}`);
  check('/health says it has no terminal',
    bare.health.terminal === false, `terminal was ${JSON.stringify(bare.health.terminal)}`);
  check('/health says neither agent is configured',
    bare.health.agents?.issue?.configured === false
    && bare.health.agents?.implement?.configured === false,
    `agents was ${JSON.stringify(bare.health.agents)}`);
}

// ─── A canvas configured the way a board is ───────────────────

console.log('\nA canvas configured the way a board is');

const registry = join(workDir, 'registry.json');
writeFileSync(registry, JSON.stringify({ workspaces: [] }), 'utf8');

// Since #307 the preflight really does spawn argv[0] of these, so they are chosen to be a
// binary nothing has: the probe answers `not found`, which is the truth about them and is not
// what this check is about. What is asserted here is `configured`, the expression the routes
// are gated on, which anything non-empty exercises.
const board = await canvasWith({
  EXCALIDRAW_WORKSPACES: registry,
  EXCALIDRAW_TERMINAL: '1',
  EXCALIDRAW_ISSUE_AGENT: 'agent-that-is-never-run --research',
  EXCALIDRAW_IMPLEMENT_AGENT: 'agent-that-is-never-run --implement',
});
check('it answers /health at all', board.health !== null);

if (board.health) {
  check('it identifies as the same service, so the marker still means what it meant',
    board.health.service === 'mcp-excalidraw-canvas', `service was ${board.health.service}`);
  check('/health says it has a workspace registry',
    board.health.workspaces === 'configured', `workspaces was ${JSON.stringify(board.health.workspaces)}`);
  check('/health says it has a terminal',
    board.health.terminal === true, `terminal was ${JSON.stringify(board.health.terminal)}`);
  check('/health says both agents are configured',
    board.health.agents?.issue?.configured === true
    && board.health.agents?.implement?.configured === true,
    `agents was ${JSON.stringify(board.health.agents)}`);
  check('and never reports the command lines themselves',
    !JSON.stringify(board.health).includes('agent-that-is-never-run'),
    'a command line leaked into /health');
}

// ─── The asymmetry a single boolean would lose ────────────────

console.log('\nOne agent on and the other off');

// The two variables are separate on purpose: sharing one command would mean that turning on
// issue blocks quietly turned on repository writes. A single `agents: true` would hide exactly
// that, so the split has to survive into what /health says.
const researchOnly = await canvasWith({
  EXCALIDRAW_WORKSPACES: registry,
  EXCALIDRAW_ISSUE_AGENT: 'agent-that-is-never-run --research',
});

if (researchOnly.health) {
  check('the issue agent reads as on',
    researchOnly.health.agents?.issue?.configured === true,
    `agents was ${JSON.stringify(researchOnly.health.agents)}`);
  check('and the implement agent, separately, as off',
    researchOnly.health.agents?.implement?.configured === false,
    `agents was ${JSON.stringify(researchOnly.health.agents)}`);
}

// ─── The two are distinguishable, which is the whole point ────

console.log('\nTold apart by /health alone');

if (bare.health && board.health) {
  check('the same `status` on both, so `status` was never the signal',
    bare.health.status === board.health.status);
  check('a stand-in cannot be mistaken for the board from /health alone',
    bare.health.workspaces !== board.health.workspaces
    || bare.health.terminal !== board.health.terminal,
    'both answered identically');
}

// ─── Done ─────────────────────────────────────────────────────

for (const child of started) child.kill();
await sleep(300);
// Forgiven: on Windows a killed server's handles on its state directory are
// released asynchronously, and a run that reported failure because it could not
// delete a temporary directory would be wrong about the thing it measured (#472).
try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
