#!/usr/bin/env node
/**
 * `GET /api/workspaces` answers only a caller on this machine.
 *
 * The route returns the registry: every project's `id`, its **absolute filesystem path** and,
 * for a WSL project, its `innerPath`. That is the map of everything the operator works on, and
 * it was the one route in its block with no guard at all — its siblings (`POST
 * /api/workspaces`, `DELETE /api/workspaces/:id`, `PUT /api/workspaces/order`, both
 * `/api/workspaces/:id/config` routes and `GET /api/fs/directories`) each call `offLoopback`.
 * The guard's own comment says they are
 * guarded because reaching them from the network would be strictly worse than reaching a route
 * that only reads a project; this one reads more than a project, it reads the map of all of
 * them.
 *
 * Two servers, one registry, and three callers:
 *
 *   1. bound to loopback — 200, and the project's path is in the answer, which is what the tab
 *      strip and the picker need and what must keep working;
 *   2. bound to `0.0.0.0` and called from loopback — 200 as well, since #501. The guard asks who
 *      is calling rather than where the server opened, so the browser on the host machine is
 *      served on a board that also listens somewhere else. It answered 403 before;
 *   3. that same board, called on an address that is not loopback — 403, no `workspaces` array,
 *      and the project's path nowhere in the body.
 *
 * **The remote caller is a real one, and it did not have to be.** While the guard tested the
 * bind, this check could ask the whole question by binding `127.0.0.2` — off loopback to a list
 * of `127.0.0.1` and `::1` exactly, and never leaving the machine. Now that the guard tests the
 * caller, `127.0.0.2` is a loopback address like the rest of `127.0.0.0/8` and there is no
 * substitute left. `scripts/lib/remote-caller.mjs` prefers a host-only adapter — a Hyper-V or
 * WSL virtual switch, a Docker bridge — says on stdout when it had to take a real interface, and
 * answers `null` on a machine that has nothing but loopback, where case 3 says it could not run
 * rather than passing as though it had. Either way the port is one the kernel just handed out
 * and never 3737.
 *
 * The third case is read off `src/server.ts` rather than off a server: every route in the
 * workspaces block calls `offLoopback`. Line numbers move, so the block is found by its section
 * comments — the point is that a route added there later cannot be the next one left out.
 *
 * Self-contained: it builds a throwaway registry in a temp directory, starts its own servers on
 * free ports and kills them. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-workspaces-guard.mjs
 *
 * Tier: fast
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';
import { looksLikeLoopback, peerAddressSeenOn, remoteInterfaceAddress } from './lib/remote-caller.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 15000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function note(line) {
  console.log(`  note  ${line}`);
}

async function waitForHealth(base, child) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Canvas server exited early (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for the canvas server on ${base}.`);
}

async function get(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

// ─── A registry with a path worth not leaking ─────────────────

const workdir = mkdtempSync(join(tmpdir(), 'check-workspaces-guard-'));
const projectPath = join(workdir, 'a-project-the-network-should-not-learn-about');
mkdirSync(projectPath);
writeFileSync(join(projectPath, 'board.config.json'), JSON.stringify({ name: 'Guarded' }));
const registryPath = join(workdir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({ workspaces: [{ id: 'guarded', path: projectPath }] }));

const [loopbackPort, offPort] = await freePorts(2);
const env = { EXCALIDRAW_WORKSPACES: registryPath, LOG_LEVEL: 'error' };
const remote = await remoteInterfaceAddress(note);

let loopback;
let off;

try {
  // 1. Bound to loopback, the route answers exactly as it does today.
  console.log('\n1. bound to loopback');
  loopback = startCanvas({ port: loopbackPort, cwd: workdir, env });
  await waitForHealth(loopback.base, loopback.child);

  const allowed = await get(loopback.base, '/api/workspaces');
  check('GET /api/workspaces answers 200', allowed.status === 200, `got ${allowed.status}`);
  check('the registry comes back', Array.isArray(allowed.json?.workspaces), allowed.text.slice(0, 200));
  check('the project is in it', allowed.json?.workspaces?.[0]?.id === 'guarded',
        JSON.stringify(allowed.json?.workspaces ?? null).slice(0, 200));
  check('and so is its path — this is what the guard has to keep working',
        allowed.text.includes(JSON.stringify(projectPath).slice(1, -1)));

  loopback.stop();

  // 2. On every interface, and still the caller's own address that decides.
  console.log('\n2. bound to 0.0.0.0, the caller on this machine is served all the same');
  off = startCanvas({
    port: offPort,
    cwd: workdir,
    env: {
      ...env,
      HOST: '0.0.0.0',
      // The origin gate is a different control and this check is not about it. A request to
      // `http://<interface>:<port>` names that authority in `Host`, which a board bound to
      // `0.0.0.0` does not answer for, so without this the remote case would be refused by the
      // wrong gate and would pass for the wrong reason.
      ...(remote ? { EXCALIDRAW_ALLOWED_HOSTS: `${remote}:${offPort}` } : {}),
    },
  });
  const localBase = `http://127.0.0.1:${offPort}`;
  await waitForHealth(localBase, off.child);

  const served = await get(localBase, '/api/workspaces');
  check('GET /api/workspaces answers 200 — it answered 403 before #501',
        served.status === 200, `got ${served.status} — ${served.text.slice(0, 200)}`);
  check('and the registry is in it', served.json?.workspaces?.[0]?.id === 'guarded',
        served.text.slice(0, 200));

  if (!remote) {
    note('this machine has no non-loopback address to be called on, so case 3 — the caller that '
         + 'is not on this machine — could not be run at all');
  } else {
    console.log(`\n3. and called on ${remote}, it refuses before it reads anything`);

    // The premise, established with a server of this check's own rather than with the code under
    // test: a connection to one of this machine's interface addresses reports that interface as
    // its source, not 127.0.0.1.
    const peer = await peerAddressSeenOn(remote);
    check(`a server on ${remote} sees a peer that is not loopback (${peer})`,
          Boolean(peer) && !looksLikeLoopback(peer), peer);

    const offBase = `http://${remote}:${offPort}`;
    const refused = await get(offBase, '/api/workspaces');
    check('GET /api/workspaces answers 403', refused.status === 403, `got ${refused.status}`);
    check('the refusal is the caller guard, not some other 403',
          /machine/i.test(refused.text) && !/DNS rebinding/i.test(refused.text),
          refused.text.slice(0, 200));
    check('no workspaces array in the body', refused.json?.workspaces === undefined,
          refused.text.slice(0, 200));
    check('the project path is nowhere in the body',
          !refused.text.includes(JSON.stringify(projectPath).slice(1, -1))
          && !refused.text.includes(JSON.stringify(workdir).slice(1, -1)),
          refused.text.slice(0, 200));

    const sibling = await post(offBase, '/api/workspaces', { path: projectPath });
    check('POST /api/workspaces is still refused too', sibling.status === 403, `got ${sibling.status}`);

    const claiming = await get(offBase, '/api/workspaces', { 'x-forwarded-for': '127.0.0.1' });
    check('and a forwarded header does not make that caller local', claiming.status === 403,
          `got ${claiming.status} — ${claiming.text.slice(0, 200)}`);
  }

  off.stop();
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  if (loopback && process.env.DEBUG_WORKSPACES_GUARD) console.error(loopback.read());
  if (off && process.env.DEBUG_WORKSPACES_GUARD) console.error(off.read());
} finally {
  if (loopback) loopback.stop();
  if (off) off.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

// ─── 4. Nothing in that block is unguarded ────────────────────

console.log('\n4. every route in the workspaces block carries the guard');

const source = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const blockStart = source.indexOf('─── Workspaces API');
const blockEnd = source.indexOf('─── Issue block', blockStart + 1);
check('the workspaces block is where this expects it', blockStart > 0 && blockEnd > blockStart,
      `start ${blockStart}, end ${blockEnd}`);

if (blockStart > 0 && blockEnd > blockStart) {
  const block = source.slice(blockStart, blockEnd);
  const routes = [...block.matchAll(/^app\.(get|post|put|delete|patch)\((['"])([^'"]+)\2/gm)];
  check(`the block holds the routes this is about (${routes.length} found)`, routes.length >= 6,
        routes.map(([, method, , path]) => `${method.toUpperCase()} ${path}`).join(', '));

  const unguarded = [];
  for (let index = 0; index < routes.length; index++) {
    const from = routes[index].index;
    const to = index + 1 < routes.length ? routes[index + 1].index : block.length;
    // A *call*, `offLoopback(res, 'Projects are listed')` — the guard's own declaration sits
    // between the first route and the second, and matching the bare name counted it as the
    // first route's guard, which is exactly the route that had none.
    if (!/offLoopback\(res,\s*['"]/.test(block.slice(from, to))) {
      unguarded.push(`${routes[index][1].toUpperCase()} ${routes[index][3]}`);
    }
  }
  check('no route in the block lacks an offLoopback call', unguarded.length === 0,
        unguarded.join(', '));
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: the registry is readable from this machine and refused off it.');
