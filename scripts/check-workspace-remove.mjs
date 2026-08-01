#!/usr/bin/env node
/**
 * Checks that a project can be taken back off the board.
 *
 * The workspace API was add-only. Five routes — `GET`, `POST`, `PUT /order`, and the two
 * `/:id/config` — and no `DELETE`; `workspaces.ts` exported no removal at all; and
 * `reorderWorkspaces` explicitly refuses a list that leaves an id out ("registered but left
 * out"), so the order route could not be pressed into service as one. The first mistake a
 * stranger makes — the wrong folder, or a project they later move — was therefore permanent
 * from inside the product: the tab stayed, `loadWorkspace` marked it broken rather than
 * dropping it, and the only way out was hand-editing a JSON file whose path comes from
 * `EXCALIDRAW_WORKSPACES`, a variable the reader has never set.
 *
 * So the cases are about writing somebody else's file carefully, which is the same standard
 * `check-workspace-create.mjs` holds the append to and `check-workspace-reorder.mjs` holds the
 * permutation to — plus the two things a removal has that neither of those has:
 *
 *   - **What it must not touch.** The registry is the board's to edit; the project directory
 *     is not, and neither is its `board.config.json`. Both are asserted byte for byte after
 *     the entry is gone, because the confirmation the settings dialog shows promises exactly
 *     that in words.
 *   - **The one thing that is arguably the board's own**: the scene saved beside the registry
 *     in `<registry>-state/`, which is the only copy of a drawing anywhere. It is kept by
 *     default — so a project removed by mistake and added back comes back drawn — and
 *     `?board=delete` is the opt-in that says otherwise. A side effect here would be data
 *     loss nobody asked for.
 *
 * The last section is the risk the issue named: a removal while an implementation is in flight
 * would orphan a run whose worktree, branch and pull request all belong to the entry being
 * deleted. It is refused with the URLs of the runs holding it, so the reader knows who to wait
 * for. That case runs a real stub agent in a real throwaway git repository, the way
 * `check-implement-parallel.mjs` does, because there is no other way to have a run genuinely
 * in flight.
 *
 * Self-contained: throwaway registry and project directories, its own canvas servers on free
 * ports, all killed at the end. Nothing here talks to GitHub. Run `./node_modules/.bin/tsc`
 * first.
 *
 * Usage: node scripts/check-workspace-remove.mjs
 *
 * Tier: fast
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const slash = (value) => String(value).replace(/\\/g, '/');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: result.status, out: (result.stdout ?? '').trim() };
}

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `workspace-remove-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

/**
 * A project directory with a config of its own, so no tab is born broken, and one file that
 * has nothing to do with this board. Both are read back after the removal: the promise the
 * confirmation makes is about the whole folder, not only about the config.
 */
function makeProject(id) {
  const dir = join(workDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify({ name: id }, null, 2), 'utf8');
  writeFileSync(join(dir, 'NOTES.md'), `# ${id}\nnot the board's file\n`, 'utf8');
  return dir;
}

const dirs = {
  alpha: makeProject('alpha'),
  beta: makeProject('beta'),
  gamma: makeProject('gamma'),
};

const registryPath = join(workDir, 'registry.json');
/** Where `boardStateDir()` puts a board saved beside this registry. */
const stateDir = join(workDir, 'registry-state');
const savedBoard = (id) => join(stateDir, `${id}.excalidraw`);

/**
 * A registry with keys the loader has never heard of, at both levels.
 *
 * `note` and `colour` are the point of one section below: this file belongs to whoever runs
 * the board, and a writer that re-serialised only the shape it understands would quietly
 * delete the rest of it while removing one line.
 */
function writeRegistry() {
  writeFileSync(registryPath, JSON.stringify({
    note: 'hand-written, and it stays that way',
    workspaces: [
      { id: 'alpha', path: slash(dirs.alpha), colour: 'green' },
      { id: 'beta', path: slash(dirs.beta), colour: 'blue' },
      { id: 'gamma', path: slash(dirs.gamma) },
    ],
  }, null, 2), 'utf8');
}
writeRegistry();

const rawRegistry = () => readFileSync(registryPath, 'utf8');
const readRegistry = () => JSON.parse(rawRegistry());
const fileIds = () => readRegistry().workspaces.map((entry) => entry.id);

/** Everything in a project directory that this check wrote, exactly as it wrote it. */
function projectSnapshot(dir) {
  return JSON.stringify({
    config: readFileSync(join(dir, 'board.config.json'), 'utf8'),
    notes: readFileSync(join(dir, 'NOTES.md'), 'utf8'),
  });
}
const betaBefore = projectSnapshot(dirs.beta);

const running = [];

function startCanvas(port, { host = '127.0.0.1', extra = {} } = {}) {
  const child = spawnCanvas({
    env: {
      PORT: String(port),
      HOST: host,
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      ...extra,
    },
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
const runPort = await freePort();
const BASE = `http://127.0.0.1:${port}`;
const OPEN_BASE = `http://127.0.0.1:${openPort}`;
const RUN_BASE = `http://127.0.0.1:${runPort}`;

async function call(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const remove = (base, id, query = '') =>
  call(base, `/api/workspaces/${encodeURIComponent(id)}${query}`, { method: 'DELETE' });
const listed = async (base) =>
  ((await call(base, '/api/workspaces')).body?.workspaces ?? []).map((workspace) => workspace.id);

/** Put one element on a board, which is what makes it worth saving. */
const draw = (base, workspace, id) =>
  call(base, `/api/elements?workspace=${workspace}`, {
    method: 'POST',
    body: JSON.stringify({ type: 'rectangle', x: 10, y: 10, width: 40, height: 40, id }),
  });

/** The debounce is a second, and the ceiling five; a board written by then is written. */
async function waitForSave(id) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (existsSync(savedBoard(id))) return true;
    await sleep(100);
  }
  return false;
}

function stopAll() {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  const server = startCanvas(port);
  await waitForHealth(BASE, server.child, server.read);

  console.log('1. the board starts with the three projects the file lists');
  check('GET /api/workspaces lists all three',
        JSON.stringify(await listed(BASE)) === JSON.stringify(['alpha', 'beta', 'gamma']),
        JSON.stringify(await listed(BASE)));

  console.log('\n2. DELETE removes exactly that entry, and the tab is gone with no restart');
  const removed = await remove(BASE, 'beta');
  check('the removal is accepted', removed.status === 200,
        `got ${removed.status} ${JSON.stringify(removed.body)}`);
  check('it says which project it removed', removed.body?.removed?.id === 'beta',
        JSON.stringify(removed.body?.removed));
  check('and names the path it left alone',
        slash(removed.body?.removed?.path ?? '').toLowerCase() === slash(dirs.beta).toLowerCase(),
        JSON.stringify(removed.body?.removed));
  check('the response already carries the list without it',
        JSON.stringify((removed.body?.workspaces ?? []).map((workspace) => workspace.id))
          === JSON.stringify(['alpha', 'gamma']),
        JSON.stringify(removed.body));
  check('GET /api/workspaces no longer lists it, with no restart',
        JSON.stringify(await listed(BASE)) === JSON.stringify(['alpha', 'gamma']),
        JSON.stringify(await listed(BASE)));
  check('and the registry file on disk has exactly the other two',
        JSON.stringify(fileIds()) === JSON.stringify(['alpha', 'gamma']),
        JSON.stringify(fileIds()));

  console.log('\n3. keys the loader does not understand survive the rewrite');
  const after = readRegistry();
  check('a top-level key is still there', after.note === 'hand-written, and it stays that way',
        JSON.stringify(after.note));
  check('and one inside an entry that stayed',
        after.workspaces.find((entry) => entry.id === 'alpha')?.colour === 'green',
        JSON.stringify(after.workspaces.find((entry) => entry.id === 'alpha')));
  check('every remaining entry kept its path',
        after.workspaces.every((entry) => typeof entry.path === 'string' && entry.path),
        JSON.stringify(after.workspaces));

  console.log('\n4. the project directory is not the board’s to delete');
  check('the folder is still there', existsSync(dirs.beta), dirs.beta);
  check('its board.config.json and everything beside it are byte for byte what they were',
        projectSnapshot(dirs.beta) === betaBefore, projectSnapshot(dirs.beta));

  console.log('\n5. removing something that is not registered is a 404, not a silent success');
  for (const [what, id] of [
    ['an id nobody ever registered', 'delta'],
    ['the id that was just removed', 'beta'],
  ]) {
    const before = rawRegistry();
    const response = await remove(BASE, id);
    // 404 exactly, not "any 4xx": before this route existed every one of these answered 404
    // too, which is why the section above is what proves the route is there at all.
    check(`${what} is refused with 404`, response.status === 404,
          `got ${response.status} ${JSON.stringify(response.body)}`);
    check('  …with a reason that names it',
          typeof response.body?.error === 'string' && response.body.error.includes(id),
          JSON.stringify(response.body));
    check('  …and the file on disk is byte for byte what it was', rawRegistry() === before,
          `${before}\n  became\n${rawRegistry()}`);
  }

  console.log('\n6. the board this project was drawn on is kept unless deleting it is asked for');
  const drawn = await draw(BASE, 'gamma', 'gamma-shape');
  check('an element goes onto gamma’s board', drawn.status === 200 || drawn.status === 201,
        `got ${drawn.status} ${JSON.stringify(drawn.body)}`);
  check('and the board is saved beside the registry', await waitForSave('gamma'), savedBoard('gamma'));

  const kept = await remove(BASE, 'gamma');
  check('gamma is removed', kept.status === 200, `got ${kept.status} ${JSON.stringify(kept.body)}`);
  check('the answer says the saved board was kept', kept.body?.board?.deleted === false,
        JSON.stringify(kept.body?.board));
  check('and the file is still on disk, so adding the project back brings the drawing with it',
        existsSync(savedBoard('gamma')), savedBoard('gamma'));
  // Past the debounce and its ceiling: a removal that only dropped the entry would leave the
  // timer armed, and the board would be written again seconds later by nobody's project.
  await sleep(1500);
  check('nothing writes that board again once the project is gone',
        existsSync(savedBoard('gamma')), savedBoard('gamma'));

  console.log('\n7. ?board=delete is the opt-in, and it is the only thing that deletes a drawing');
  const drawnAgain = await draw(BASE, 'alpha', 'alpha-shape');
  check('an element goes onto alpha’s board', drawnAgain.status === 200 || drawnAgain.status === 201,
        `got ${drawnAgain.status} ${JSON.stringify(drawnAgain.body)}`);
  check('and alpha’s board is saved too', await waitForSave('alpha'), savedBoard('alpha'));

  const badFlag = await remove(BASE, 'alpha', '?board=maybe');
  check('a value that is neither keep nor delete is refused', badFlag.status === 400,
        `got ${badFlag.status} ${JSON.stringify(badFlag.body)}`);
  check('  …and alpha is still registered', (await listed(BASE)).includes('alpha'),
        JSON.stringify(await listed(BASE)));

  const deleted = await remove(BASE, 'alpha', '?board=delete');
  check('alpha is removed', deleted.status === 200, `got ${deleted.status} ${JSON.stringify(deleted.body)}`);
  check('the answer says the saved board went with it', deleted.body?.board?.deleted === true,
        JSON.stringify(deleted.body?.board));
  check('and the file is gone', !existsSync(savedBoard('alpha')), savedBoard('alpha'));
  check('while the project folder is still untouched',
        existsSync(join(dirs.alpha, 'board.config.json')) && existsSync(join(dirs.alpha, 'NOTES.md')),
        dirs.alpha);
  check('the registry is empty of projects now',
        JSON.stringify(fileIds()) === JSON.stringify([]), JSON.stringify(fileIds()));
  check('and the hand-written key outlived every entry',
        readRegistry().note === 'hand-written, and it stays that way',
        JSON.stringify(readRegistry()));

  console.log('\n8. a board that is not bound to loopback may not remove a project');
  writeRegistry();
  const open = startCanvas(openPort, { host: '0.0.0.0' });
  await waitForHealth(OPEN_BASE, open.child, open.read);
  const before = rawRegistry();
  const refused = await remove(OPEN_BASE, 'beta');
  check('403 for the DELETE', refused.status === 403,
        `got ${refused.status} ${JSON.stringify(refused.body)}`);
  check('and the refusal names loopback', /loopback/i.test(refused.body?.error ?? ''), refused.body?.error);
  check('with the file byte for byte what it was', rawRegistry() === before, rawRegistry());

  console.log('\n9. a project with a run in flight is refused rather than orphaned');
  // A real git repository and a stub agent, because there is no other way to hold a run
  // genuinely `running` while a request arrives. The stub reports nothing and waits to be
  // released; what matters here is only that `runningImplements` has something in it.
  const repoDir = join(workDir, 'repo');
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'check@example.com']);
  git(repoDir, ['config', 'user.name', 'Check']);
  git(repoDir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repoDir, 'board.config.json'),
                JSON.stringify({ name: 'repo', repo: 'vitorengers/vibemaxxing' }), 'utf8');
  writeFileSync(join(repoDir, 'README.md'), '# repo\n', 'utf8');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-m', 'initial']);

  const agentStub = join(workDir, 'agent.mjs');
  writeFileSync(agentStub, `#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const workDir = ${JSON.stringify(workDir)};
let input = '';
process.stdin.on('data', (chunk) => { input += chunk.toString(); });
process.stdin.on('end', async () => {
  for (let attempt = 0; attempt < 600; attempt++) {
    if (existsSync(join(workDir, 'release'))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.stdout.write('https://github.com/vitorengers/vibemaxxing/pull/1\\n');
});
`, 'utf8');

  writeFileSync(registryPath, JSON.stringify({
    workspaces: [{ id: 'repo', path: slash(repoDir) }],
  }, null, 2), 'utf8');

  const runner = startCanvas(runPort, {
    extra: { EXCALIDRAW_IMPLEMENT_AGENT: `node "${slash(agentStub)}" -p` },
  });
  await waitForHealth(RUN_BASE, runner.child, runner.read);

  const started = await call(RUN_BASE, '/api/implement?workspace=repo', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://github.com/vitorengers/vibemaxxing/issues/1' }),
  });
  check('an implementation starts', started.status === 200 || started.status === 202,
        `got ${started.status} ${JSON.stringify(started.body)}`);

  let inFlight = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const runs = (await call(RUN_BASE, '/api/implement?workspace=repo')).body?.runs ?? [];
    if (runs.some((entry) => entry.state === 'running')) { inFlight = true; break; }
    await sleep(100);
  }
  check('and it is running when the removal arrives', inFlight, 'no run reached "running"');

  const held = await remove(RUN_BASE, 'repo');
  check('the removal is refused with 409', held.status === 409,
        `got ${held.status} ${JSON.stringify(held.body)}`);
  check('naming the run that is holding it',
        /issues\/1/.test(held.body?.error ?? ''), held.body?.error);
  check('and the project is still registered',
        JSON.stringify(fileIds()) === JSON.stringify(['repo']), JSON.stringify(fileIds()));

  writeFileSync(join(workDir, 'release'), '', 'utf8');
  let settled = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    const runs = (await call(RUN_BASE, '/api/implement?workspace=repo')).body?.runs ?? [];
    if (runs.length && runs.every((entry) => entry.state !== 'running')) { settled = true; break; }
    await sleep(100);
  }
  check('once the run settles the project can be removed', settled, 'the stub run never settled');
  if (settled) {
    const freed = await remove(RUN_BASE, 'repo');
    check('and it is', freed.status === 200, `got ${freed.status} ${JSON.stringify(freed.body)}`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  stopAll();
  await sleep(400);
  // The worktrees a run makes are a sibling of the project (`<project>-worktrees`), so they
  // are inside `workDir` here and go with it. Windows can still hold a handle on a directory
  // directory left behind is not a failed check.
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
