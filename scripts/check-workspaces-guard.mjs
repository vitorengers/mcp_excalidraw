#!/usr/bin/env node
/**
 * `GET /api/workspaces` answers only while the server is bound to loopback.
 *
 * The route returns the registry: every project's `id`, its **absolute filesystem path** and,
 * for a WSL project, its `innerPath`. That is the map of everything the operator works on, and
 * it was the one route in its block with no guard at all — its five siblings (`POST
 * /api/workspaces`, `PUT /api/workspaces/order`, both `/api/workspaces/:id/config` routes and
 * `GET /api/fs/directories`) each call `offLoopback`. The guard's own comment says they are
 * guarded because reaching them from the network would be strictly worse than reaching a route
 * that only reads a project; this one reads more than a project, it reads the map of all of
 * them.
 *
 * Two servers, one registry, and the same request to both:
 *
 *   1. bound to loopback — 200, and the project's path is in the answer, which is what the tab
 *      strip and the picker need and what must keep working;
 *   2. bound off loopback — 403, no `workspaces` array, and that path nowhere in the body.
 *
 * **The off-loopback server is bound to `127.0.0.2`, not to a real interface.** The guard's
 * question is `LOOPBACK_ADDRESSES.includes(HOST)`, and its list is `127.0.0.1` and `::1`
 * exactly — so `127.0.0.2` is off loopback as far as the code under test is concerned while
 * never leaving this machine. A check that had to publish a board on the LAN for a second to
 * assert that it refuses would be a strange way to prove a security property. Where the
 * platform will not bind a loopback alias, the first real interface address is the fallback,
 * printed when it happens; either way the port is one the kernel just handed out and never
 * 3737.
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

import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 15000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Whether this machine will let a server sit on `host`. */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * An address the guard calls "not loopback" and this machine will bind.
 *
 * `127.0.0.2` first, because it is off loopback only in the sense the code under test means and
 * is unreachable from anywhere else. A platform that assigns the loopback interface `127.0.0.1`
 * alone (macOS) refuses it, and then a real interface is the only honest way left to ask the
 * question.
 */
async function offLoopbackHost() {
  if (await canBind('127.0.0.2')) return '127.0.0.2';
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && (await canBind(entry.address))) {
        console.log(`  note  127.0.0.2 is not bindable here; using the interface ${entry.address}`);
        return entry.address;
      }
    }
  }
  throw new Error('No non-loopback address on this machine could be bound.');
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

async function get(base, path) {
  const response = await fetch(`${base}${path}`);
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

let loopback;
let off;

try {
  const offHost = await offLoopbackHost();

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

  // 2. Bound anywhere else, it refuses before it reads anything.
  console.log(`\n2. bound to ${offHost}`);
  off = startCanvas({ port: offPort, cwd: workdir, env: { ...env, HOST: offHost } });
  const offBase = `http://${offHost}:${offPort}`;
  await waitForHealth(offBase, off.child);

  const refused = await get(offBase, '/api/workspaces');
  check('GET /api/workspaces answers 403', refused.status === 403, `got ${refused.status}`);
  check('the refusal is the loopback guard, not some other 403',
        /loopback/i.test(refused.text), refused.text.slice(0, 200));
  check('no workspaces array in the body', refused.json?.workspaces === undefined,
        refused.text.slice(0, 200));
  check('the project path is nowhere in the body',
        !refused.text.includes(JSON.stringify(projectPath).slice(1, -1))
        && !refused.text.includes(JSON.stringify(workdir).slice(1, -1)),
        refused.text.slice(0, 200));

  const sibling = await post(offBase, '/api/workspaces', { path: projectPath });
  check('POST /api/workspaces is still refused too', sibling.status === 403, `got ${sibling.status}`);

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
  rmSync(workdir, { recursive: true, force: true });
}

// ─── 3. Nothing in that block is unguarded ────────────────────

console.log('\n3. every route in the workspaces block carries the guard');

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
console.log('All cases passed: the registry is readable on loopback and refused off it.');
