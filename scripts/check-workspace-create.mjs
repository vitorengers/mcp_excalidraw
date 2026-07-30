#!/usr/bin/env node
/**
 * Checks that a project can be added to the registry from the board.
 *
 * Until this existed the registry was read-only in code: `workspaces.ts` imported
 * `fs/promises` for `readFile` alone, `GET /api/workspaces` was the only route on that
 * path, and adding a project meant hand-editing a JSON file that lives outside this
 * repository and is owned by whoever runs the board. A `+` on the tab strip has nothing
 * to call.
 *
 * So the cases here are about writing somebody else's file carefully. Exactly one entry
 * is appended; keys the loader does not understand survive the rewrite, because a
 * rewrite that dropped them would silently damage that file; the new project is listed
 * without a restart, which is what makes a `+` cheap; the two spellings of one project
 * that `workspace-paths.ts` already collapses are refused as the duplicate they are; and
 * the two refusals that must never be silent — a server not bound to loopback, and no
 * registry configured at all — say so with a reason worth reading.
 *
 * The directory picker is here too, and for the same reason it exists at all: the
 * browser cannot learn a folder path — `showDirectoryPicker()` hands back a handle that
 * deliberately exposes none — so the participant with a filesystem has to do the
 * listing, behind the same loopback guard as everything else that touches this machine.
 *
 * Self-contained: it builds a throwaway registry and project directories, starts its own
 * canvas servers on free ports and kills them. Nothing here talks to GitHub. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-workspace-create.mjs
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `workspace-create-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/** A project directory. `configured` gets a board.config.json of its own. */
function makeProject(name, configured = false) {
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  if (configured) {
    writeFileSync(join(dir, 'board.config.json'),
      JSON.stringify({ name: `${name} (already named)`, repo: 'someone/else' }, null, 2), 'utf8');
  }
  return dir;
}

const seededDir = makeProject('seeded', true);
const freshDir = makeProject('fresh-project');
const namedDir = makeProject('named-project', true);
const registryPath = join(workDir, 'registry.json');

/**
 * A registry with a key the loader has never heard of, at both levels.
 *
 * `note` and `colour` are the point of the case: this file belongs to whoever runs the
 * board, and a writer that re-serialised only the shape it understands would quietly
 * delete the rest of it.
 */
function writeRegistry() {
  writeFileSync(registryPath, JSON.stringify({
    note: 'hand-written, and it stays that way',
    workspaces: [
      { id: 'seeded', path: slash(seededDir), colour: 'green' },
      // Never resolvable on this machine, and that is fine: it is here to be collided
      // with. The UNC spelling of the same project must be refused as a duplicate.
      { id: 'wsl-project', path: '/home/me/proj', distro: 'Ubuntu-22.04' },
    ],
  }, null, 2), 'utf8');
}
writeRegistry();

const readRegistry = () => JSON.parse(readFileSync(registryPath, 'utf8'));

const running = [];

function startCanvas(port, { host = '127.0.0.1', registry = registryPath } = {}) {
  const env = { PORT: String(port), HOST: host, LOG_LEVEL: 'error' };
  // Nothing to delete in the other case: the child's environment starts with no
  // `EXCALIDRAW_*` in it at all, so "not granted" is "never named".
  if (registry) env.EXCALIDRAW_WORKSPACES = registry;

  const child = spawnCanvas({
    env: env,
  }).child;
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

const port = await freePort();
const openPort = await freePort();
const barePort = await freePort();
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

const add = (base, body) => call(base, '/api/workspaces', { method: 'POST', body: JSON.stringify(body) });
const list = (base) => call(base, '/api/workspaces');

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. the + writes the registry, and writes it once');
  const before = readRegistry().workspaces.length;
  const created = await add(BASE, { path: slash(freshDir) });
  check('the project is accepted', created.status === 201,
        `got ${created.status} ${JSON.stringify(created.body)}`);
  const after = readRegistry();
  check('exactly one entry was appended', after.workspaces.length === before + 1,
        `${before} before, ${after.workspaces.length} after`);
  check('and it names the project that was asked for',
        after.workspaces.some((entry) => slash(entry.path ?? '').toLowerCase() === slash(freshDir).toLowerCase()),
        JSON.stringify(after.workspaces));

  console.log('\n2. keys the loader does not understand survive the rewrite');
  check('a top-level key is still there', after.note === 'hand-written, and it stays that way',
        JSON.stringify(after.note));
  check('and one inside an entry it did not touch',
        after.workspaces.find((entry) => entry.id === 'seeded')?.colour === 'green',
        JSON.stringify(after.workspaces.find((entry) => entry.id === 'seeded')));

  console.log('\n3. the new project is listed without a restart');
  const listed = await list(BASE);
  const found = (listed.body?.workspaces ?? []).find((workspace) => workspace.id === created.body?.workspace?.id);
  check('it turns up in GET /api/workspaces', Boolean(found),
        JSON.stringify((listed.body?.workspaces ?? []).map((workspace) => workspace.id)));
  check('the response to the POST already carried it',
        Boolean(created.body?.workspace?.id) && Array.isArray(created.body?.workspaces),
        JSON.stringify(created.body));

  console.log('\n4. a project with no config gets a minimal one, so the tab is not born broken');
  check('board.config.json was written', existsSync(join(freshDir, 'board.config.json')));
  check('and the workspace loads cleanly', found?.error === null, JSON.stringify(found));
  check('with a name rather than nothing', Boolean(found?.name), JSON.stringify(found));

  console.log('\n5. a project that already had a config keeps it');
  const named = await add(BASE, { path: slash(namedDir) });
  check('accepted', named.status === 201, `got ${named.status} ${JSON.stringify(named.body)}`);
  const keptConfig = JSON.parse(readFileSync(join(namedDir, 'board.config.json'), 'utf8'));
  check('the config was not overwritten', keptConfig.repo === 'someone/else', JSON.stringify(keptConfig));
  check('and its name is the one it already had',
        named.body?.workspace?.name === 'named-project (already named)', JSON.stringify(named.body?.workspace));

  console.log('\n6. one project cannot register twice, however it is spelled');
  const sameAgain = await add(BASE, { path: slash(freshDir).toUpperCase() });
  check('a second spelling of a registered project is refused', sameAgain.status === 409,
        `got ${sameAgain.status} ${JSON.stringify(sameAgain.body)}`);
  check('and the refusal says why', /already/i.test(sameAgain.body?.error ?? ''), sameAgain.body?.error);
  const uncSpelling = await add(BASE, { path: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\me\\proj' });
  check('the UNC spelling of a WSL project already registered by its inner path is refused',
        uncSpelling.status === 409, `got ${uncSpelling.status} ${JSON.stringify(uncSpelling.body)}`);
  const idClash = await add(BASE, { path: slash(join(workDir, 'another')), id: 'seeded' });
  check('and an id already in use is refused too', idClash.status === 409,
        `got ${idClash.status} ${JSON.stringify(idClash.body)}`);
  check('nothing was appended by the refusals', readRegistry().workspaces.length === before + 2,
        JSON.stringify(readRegistry().workspaces.map((entry) => entry.id)));

  console.log('\n7. a path that is not a directory is refused');
  const missing = await add(BASE, { path: slash(join(workDir, 'nowhere-at-all')) });
  check('400 for a directory that does not exist', missing.status === 400,
        `got ${missing.status} ${JSON.stringify(missing.body)}`);
  const empty = await add(BASE, { path: '   ' });
  check('400 for an empty path', empty.status === 400, `got ${empty.status}`);

  console.log('\n8. the directory picker runs on the server, because the browser cannot');
  const browsed = await call(BASE, `/api/fs/directories?path=${encodeURIComponent(slash(workDir))}`);
  check('200 for a directory', browsed.status === 200, `got ${browsed.status} ${JSON.stringify(browsed.body)}`);
  const names = (browsed.body?.entries ?? []).map((entry) => entry.name);
  check('it lists the project directories under it',
        names.includes('fresh-project') && names.includes('seeded'), JSON.stringify(names));
  check('each entry carries a path the POST can use',
        (browsed.body?.entries ?? []).length > 0
          && browsed.body.entries.every((entry) => typeof entry.path === 'string' && entry.path),
        JSON.stringify(browsed.body?.entries?.slice(0, 3)));
  check('and a parent to walk back up to', typeof browsed.body?.parent === 'string', JSON.stringify(browsed.body));

  const roots = await call(BASE, '/api/fs/directories');
  check('the root listing answers', roots.status === 200, `got ${roots.status} ${JSON.stringify(roots.body)}`);
  check(process.platform === 'win32'
          ? 'and on Windows it is the drive letters'
          : 'and on POSIX it starts at /',
        process.platform === 'win32'
          ? (roots.body?.entries ?? []).some((entry) => /^[A-Za-z]:/.test(entry.path ?? ''))
          : (roots.body?.entries ?? []).length > 0,
        JSON.stringify((roots.body?.entries ?? []).slice(0, 5)));

  console.log('\n9. a board that is not bound to loopback may not write anything');
  const open = startCanvas(openPort, { host: '0.0.0.0' });
  await waitForHealth(OPEN_BASE, open.child, open.read);
  const refused = await add(OPEN_BASE, { path: slash(join(workDir, 'seeded')) });
  check('403 for the POST', refused.status === 403, `got ${refused.status} ${JSON.stringify(refused.body)}`);
  check('and the refusal names loopback', /loopback/i.test(refused.body?.error ?? ''), refused.body?.error);
  const refusedBrowse = await call(OPEN_BASE, '/api/fs/directories');
  check('403 for the directory listing too', refusedBrowse.status === 403,
        `got ${refusedBrowse.status} ${JSON.stringify(refusedBrowse.body)}`);

  console.log('\n10. no registry configured is a refusal with a reason, not a silent no-op');
  const bare = startCanvas(barePort, { registry: null });
  await waitForHealth(BARE_BASE, bare.child, bare.read);
  const nowhere = await add(BARE_BASE, { path: slash(freshDir) });
  check('the POST is refused', nowhere.status >= 400, `got ${nowhere.status} ${JSON.stringify(nowhere.body)}`);
  check('and it names the variable that would fix it',
        /EXCALIDRAW_WORKSPACES/.test(nowhere.body?.error ?? ''), nowhere.body?.error);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  stopAll();
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
