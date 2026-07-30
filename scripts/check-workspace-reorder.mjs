#!/usr/bin/env node
/**
 * Checks that the order of the tabs on top of the board can be written down.
 *
 * Until this existed the strip's order was the array order of the registry JSON and nothing
 * else: `WorkspaceTabs.tsx` renders the list exactly as it arrives, `GET /api/workspaces`
 * answers `loadWorkspaces` verbatim, and the only two write paths were an append (`POST`) and
 * a project's own `board.config.json` (`PUT /api/workspaces/:id/config`). A project added
 * from the `+` could therefore only ever arrive last, and the only way to move it was to
 * hand-edit a file that lives outside this repository, on the machine of whoever runs the
 * board.
 *
 * Order is not only cosmetic here. `resolveInitialWorkspace` falls back to `list[0].id`, so
 * the first tab is the board a cold start opens — the position decides the default.
 *
 * So the cases are about writing somebody else's file carefully, which is the same standard
 * `check-workspace-create.mjs` holds the append to. A permutation is applied and comes back
 * out of `GET /api/workspaces` in the new order; keys nobody here knows about survive the
 * rewrite, at both levels; a list that adds, drops or repeats an id is refused with a reason
 * and leaves the file on disk **byte for byte** unchanged, rather than partially applied; and
 * the route refuses off loopback and with no registry configured, like every other route that
 * writes to this machine.
 *
 * Self-contained: throwaway registry and project directories, its own canvas servers on free
 * ports, all killed at the end. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-workspace-reorder.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `workspace-reorder-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A project directory with a config of its own, so no tab is born broken. */
function makeProject(id) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: id }, null, 2), 'utf8');
  return dir;
}

const dirs = {
  alpha: makeProject('alpha'),
  beta: makeProject('beta'),
  gamma: makeProject('gamma'),
};

const registryPath = join(workDir, 'registry.json');

/**
 * A registry with keys the loader has never heard of, at both levels.
 *
 * `note` and `colour` are the point of half the cases below: this file belongs to whoever
 * runs the board, and a writer that re-serialised only the shape it understands would
 * quietly delete the rest of it.
 */
function writeRegistry() {
  writeFileSync(registryPath, JSON.stringify({
    note: 'hand-written, and it stays that way',
    workspaces: [
      { id: 'alpha', path: slash(dirs.alpha), colour: 'green' },
      { id: 'beta', path: slash(dirs.beta) },
      { id: 'gamma', path: slash(dirs.gamma), colour: 'blue' },
    ],
  }, null, 2), 'utf8');
}
writeRegistry();

const rawRegistry = () => readFileSync(registryPath, 'utf8');
const readRegistry = () => JSON.parse(rawRegistry());
const fileOrder = () => readRegistry().workspaces.map((entry) => entry.id);

const serverPath = join(repoRoot, 'dist', 'server.js');
const running = [];

function startCanvas(port, { host = '127.0.0.1', registry = registryPath } = {}) {
  const env = { ...process.env, PORT: String(port), HOST: host, LOG_LEVEL: 'error' };
  if (registry) env.EXCALIDRAW_WORKSPACES = registry;
  else delete env.EXCALIDRAW_WORKSPACES;

  const child = spawn(process.execPath, [serverPath], {
    cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  running.push(child);
  return { child, read: () => output };
}

async function waitForHealth(base, child, read) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${read()}`);
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`the canvas server never answered on ${base}:\n${read()}`);
}

const port = 38200 + (process.pid % 300);
const openPort = port + 1;
const barePort = port + 2;
const BASE = `http://127.0.0.1:${port}`;
const OPEN_BASE = `http://127.0.0.1:${openPort}`;
const BARE_BASE = `http://127.0.0.1:${barePort}`;

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const reorder = (base, body) =>
  call(base, '/api/workspaces/order', { method: 'PUT', body: JSON.stringify(body) });
const listed = async (base) =>
  ((await call(base, '/api/workspaces')).body?.workspaces ?? []).map((workspace) => workspace.id);

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. the strip starts in the order the file is in');
  check('GET /api/workspaces is the registry array order',
        JSON.stringify(await listed(BASE)) === JSON.stringify(['alpha', 'beta', 'gamma']),
        JSON.stringify(await listed(BASE)));

  console.log('\n2. a permutation is applied, and it is what the board then reads');
  const moved = await reorder(BASE, { ids: ['gamma', 'alpha', 'beta'] });
  check('the reorder is accepted', moved.status === 200,
        `got ${moved.status} ${JSON.stringify(moved.body)}`);
  check('the response already carries the list in the new order',
        JSON.stringify((moved.body?.workspaces ?? []).map((workspace) => workspace.id))
          === JSON.stringify(['gamma', 'alpha', 'beta']),
        JSON.stringify(moved.body));
  check('GET /api/workspaces comes back in the new order, with no restart',
        JSON.stringify(await listed(BASE)) === JSON.stringify(['gamma', 'alpha', 'beta']),
        JSON.stringify(await listed(BASE)));
  check('and the registry file on disk is in the new order too',
        JSON.stringify(fileOrder()) === JSON.stringify(['gamma', 'alpha', 'beta']),
        JSON.stringify(fileOrder()));

  console.log('\n3. keys the loader does not understand survive the rewrite');
  const after = readRegistry();
  check('a top-level key is still there', after.note === 'hand-written, and it stays that way',
        JSON.stringify(after.note));
  check('and one inside an entry that moved',
        after.workspaces.find((entry) => entry.id === 'gamma')?.colour === 'blue',
        JSON.stringify(after.workspaces.find((entry) => entry.id === 'gamma')));
  check('every entry kept its path',
        after.workspaces.every((entry) => typeof entry.path === 'string' && entry.path),
        JSON.stringify(after.workspaces));

  console.log('\n4. a list that is not a permutation is refused, not partially applied');
  const refusals = [
    ['an id that is not registered', { ids: ['gamma', 'alpha', 'beta', 'delta'] }],
    ['a list that drops one', { ids: ['gamma', 'alpha'] }],
    ['a list that repeats one', { ids: ['gamma', 'gamma', 'alpha'] }],
    ['a list that is not an array', { ids: 'gamma,alpha,beta' }],
    ['a list of things that are not ids', { ids: [1, 2, 3] }],
    ['no list at all', {}],
    ['an empty list on a registry that has projects', { ids: [] }],
  ];
  for (const [what, body] of refusals) {
    const before = rawRegistry();
    const response = await reorder(BASE, body);
    // 400 exactly, not "any 4xx": a route that does not exist answers 404, and a case that
    // accepted that would be green on the code this check was written against.
    check(`${what} is refused`, response.status === 400,
          `got ${response.status} ${JSON.stringify(response.body)}`);
    check(`  …with a reason worth reading`,
          typeof response.body?.error === 'string' && response.body.error.length > 10,
          JSON.stringify(response.body));
    check(`  …and the file on disk is byte for byte what it was`, rawRegistry() === before,
          `${before}\n  became\n${rawRegistry()}`);
  }
  check('the order the last accepted call set is still the one in force',
        JSON.stringify(await listed(BASE)) === JSON.stringify(['gamma', 'alpha', 'beta']),
        JSON.stringify(await listed(BASE)));

  console.log('\n5. the order the tabs are in is the order a cold start picks from');
  // Not an extra promise, a consequence: `resolveInitialWorkspace` falls back to `list[0].id`,
  // so whatever `GET /api/workspaces` puts first is the board a browser with no remembered id
  // opens. The case is here so that a later change which sorted the list on the way out would
  // have to say so.
  const front = (await listed(BASE))[0];
  check('the first of the list is the project that was dragged to the front', front === 'gamma', String(front));

  console.log('\n6. a board that is not bound to loopback may not write the order');
  const open = startCanvas(openPort, { host: '0.0.0.0' });
  await waitForHealth(OPEN_BASE, open.child, open.read);
  const refused = await reorder(OPEN_BASE, { ids: ['alpha', 'beta', 'gamma'] });
  check('403 for the PUT', refused.status === 403, `got ${refused.status} ${JSON.stringify(refused.body)}`);
  check('and the refusal names loopback', /loopback/i.test(refused.body?.error ?? ''), refused.body?.error);
  check('with the file untouched',
        JSON.stringify(fileOrder()) === JSON.stringify(['gamma', 'alpha', 'beta']),
        JSON.stringify(fileOrder()));

  console.log('\n7. no registry configured is a refusal with a reason, not a silent no-op');
  const bare = startCanvas(barePort, { registry: null });
  await waitForHealth(BARE_BASE, bare.child, bare.read);
  const nowhere = await reorder(BARE_BASE, { ids: ['alpha'] });
  check('the PUT is refused as unavailable rather than as absent', nowhere.status === 503,
        `got ${nowhere.status} ${JSON.stringify(nowhere.body)}`);
  check('and it names the variable that would fix it',
        /EXCALIDRAW_WORKSPACES/.test(nowhere.body?.error ?? ''), nowhere.body?.error);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  stopAll();
  await sleep(400);
  // Windows can still hold a handle on a directory a killed server was reading; a temporary
  // directory left behind is not a failed check.
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
