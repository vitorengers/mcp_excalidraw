#!/usr/bin/env node
/**
 * Checks that the board can restart its own server without sawing off the branch it sits on.
 *
 * The failure this is written against is recorded twice in this repository. A terminal block
 * on the board was asked to restart the server; the block is a child of the server, so the
 * kill killed the thing running the kill, and the replacement came from whatever auto-started
 * first — an MCP server attached to an editor, holding no `EXCALIDRAW_*` at all. It bound the
 * port and answered `status: healthy` with the same `service` marker, with no registry, no
 * terminal and no agents (`scripts/check-health-identity.mjs`, `docs/running.md`).
 *
 * So a restart is only a restart if all four of these hold, and `status: healthy` says none of
 * them:
 *
 *   - the process that answered before is *gone*, not merely quiet;
 *   - a **different** pid answers on the same port, which is the half a supervisor inside the
 *     dying process tree cannot do;
 *   - the new one carries the environment the old one had — `workspaces: configured`,
 *     `terminal: true`, both agents — which is what tells the board apart from a stand-in;
 *   - and the route is refused when the server is not on loopback, like every other route
 *     that acts on this machine rather than reading a project.
 *
 * The third is the one worth being pedantic about: an assertion on `status` alone passes
 * against the exact failure this feature exists to prevent.
 *
 * Self-contained: it starts its own canvas servers on free ports of their own, with their own
 * throwaway registry, and kills them — including the one the restart *created*, which is a
 * grandchild this process never spawned and would otherwise be left holding a port. Nothing
 * here talks to the board, to GitHub or to the network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-restart-route.mjs
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
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

/** One reading, or null — used while the port is expected to be changing hands. */
async function healthNow(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** Whether a pid exists at all. Signal 0 asks without sending anything. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const workDir = join(tmpdir(), `restart-route-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const registry = join(workDir, 'registry.json');
writeFileSync(registry, JSON.stringify({ workspaces: [] }), 'utf8');

/** Every pid this run is responsible for, including ones it did not spawn. */
const toKill = [];

/**
 * A canvas server with exactly the environment given. Stripping every `EXCALIDRAW_*` out of the
 * child — so neither the machine running the check nor the board's own environment leaking in
 * through the shell can decide the answer — is `scripts/lib/spawn-canvas.mjs`'s job now,
 * together with the `.env` this used to miss.
 */
async function canvasWith(extraEnv, host = '127.0.0.1') {
  const port = await freePort();
  const { child } = startCanvas({ port, env: { HOST: host, LOG_LEVEL: 'error', ...extraEnv } });
  toKill.push(child.pid);
  const health = await healthOf(port);
  return { port, health, pid: child.pid };
}

// The agent values are never run and never read back — only whether they are set reaches
// /health, so anything non-empty exercises the same expression the routes are gated on.
const BOARD_ENV = {
  EXCALIDRAW_WORKSPACES: registry,
  EXCALIDRAW_TERMINAL: '1',
  EXCALIDRAW_ISSUE_AGENT: 'agent-that-is-never-run --research',
  EXCALIDRAW_IMPLEMENT_AGENT: 'agent-that-is-never-run --implement',
};

try {
  // ─── A board restarts itself ──────────────────────────────────

  console.log('\n1. a board configured the way the operator\'s is');

  const board = await canvasWith(BOARD_ENV);
  check('it answers /health', board.health !== null);
  check('and it is the board rather than a stand-in',
    board.health?.workspaces === 'configured' && board.health?.terminal === true
    && board.health?.agents?.issue === true && board.health?.agents?.implement === true,
    JSON.stringify(board.health));

  const oldPid = board.health?.pid ?? board.pid;

  console.log('\n2. POST /api/restart answers before it goes');

  let posted = null;
  let postStatus = 0;
  try {
    const response = await fetch(`http://127.0.0.1:${board.port}/api/restart`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    postStatus = response.status;
    posted = await response.json();
  } catch (error) {
    posted = { error: String(error) };
  }
  check('the route exists and accepts the request', postStatus === 200,
    `status ${postStatus} — ${JSON.stringify(posted)}`);
  check('it says which pid is going', posted?.pid === oldPid,
    `said ${JSON.stringify(posted?.pid)}, is ${oldPid}`);
  check('and names the process that will bring the replacement up',
    Number.isInteger(posted?.supervisor) && posted.supervisor > 0,
    JSON.stringify(posted?.supervisor));

  console.log('\n3. the old process really goes');

  const goneBy = Date.now() + 20000;
  while (Date.now() < goneBy && isAlive(oldPid)) await sleep(200);
  check('the pid that answered before no longer exists', !isAlive(oldPid),
    `pid ${oldPid} is still running 20s after the restart`);

  console.log('\n4. a different pid answers on the same port');

  const newBy = Date.now() + 40000;
  let fresh = null;
  while (Date.now() < newBy) {
    const health = await healthNow(board.port);
    if (health && health.pid !== oldPid) { fresh = health; break; }
    await sleep(250);
  }
  if (fresh?.pid) toKill.push(fresh.pid);
  check('something answers /health on the port again', fresh !== null,
    `nothing new answered on ${board.port} within 40s`);
  check('and it is a different process, which a restart from inside the dying tree cannot do',
    fresh !== null && fresh.pid !== oldPid, `pid ${fresh?.pid} vs ${oldPid}`);
  check('it identifies as this service', fresh?.service === 'mcp-excalidraw-canvas',
    `service was ${fresh?.service}`);

  console.log('\n5. and it carries the environment, which `status: healthy` never said');

  check('/health says it has the workspace registry', fresh?.workspaces === 'configured',
    `workspaces was ${JSON.stringify(fresh?.workspaces)}`);
  check('/health says it has a terminal', fresh?.terminal === true,
    `terminal was ${JSON.stringify(fresh?.terminal)}`);
  check('/health says both agents are configured',
    fresh?.agents?.issue === true && fresh?.agents?.implement === true,
    `agents was ${JSON.stringify(fresh?.agents)}`);
  check('so the replacement is the board, not the stand-in the port once got',
    fresh?.workspaces === board.health?.workspaces
    && fresh?.terminal === board.health?.terminal
    && JSON.stringify(fresh?.agents) === JSON.stringify(board.health?.agents),
    `${JSON.stringify(fresh)} vs ${JSON.stringify(board.health)}`);

  // ─── Off loopback it is refused ───────────────────────────────

  console.log('\n6. off loopback the route is refused');

  const open = await canvasWith(BOARD_ENV, '0.0.0.0');
  check('the open-bound server is up', open.health !== null);
  let refusedStatus = 0;
  let refusedBody = null;
  try {
    const response = await fetch(`http://127.0.0.1:${open.port}/api/restart`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    refusedStatus = response.status;
    refusedBody = await response.json();
  } catch (error) {
    refusedBody = { error: String(error) };
  }
  check('the restart is refused with 403', refusedStatus === 403,
    `status ${refusedStatus} — ${JSON.stringify(refusedBody)}`);
  check('and it says why', typeof refusedBody?.error === 'string' && /loopback/i.test(refusedBody.error),
    JSON.stringify(refusedBody));
  // The proof it was the guard rather than a crash: it is still there afterwards.
  const stillUp = await healthNow(open.port);
  check('the refusing server is still running', stillUp?.pid === open.health?.pid,
    `${JSON.stringify(stillUp?.pid)} vs ${JSON.stringify(open.health?.pid)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.stack ?? error.message}`);
} finally {
  for (const pid of toKill) {
    if (pid && isAlive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  await sleep(500);
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
