#!/usr/bin/env node
/**
 * The five routes an interface-bound board still answered, and the two it still took.
 *
 * `offLoopback` is the funnel #366 and #456 put every read and every write of a board behind, and
 * PR #500's subject says what that was for: *an interface-bound board is inert*. It was not quite.
 * Five routes still answered a caller on the network, and two of them accepted a write:
 *
 *   - `GET /api/implement` — every implement record for the workspace: each run's state, its pull
 *     request URL, its `error` text, and the **absolute path of the worktree** it left on this
 *     machine;
 *   - `GET /api/issue-block/:id/run` — a research run's state, its two instants and what it spent;
 *   - `GET /api/issue/recreate` — the same for a recreate run;
 *   - `DELETE /api/implement` — **resets** an implement record, by issue URL;
 *   - `DELETE /api/issue-block/:id/implement` — the same reset, by element id, and it read the
 *     element first, so a 404 against a 400 also said whether a given block id was on that board.
 *
 * They were not an exemption anybody decided. Each was added *after* the guard, on the reasoning
 * its own comment gives: they read this process's memory rather than shelling out to `gh`. Reading
 * memory is not the question the guard asks — the guard asks who is calling.
 *
 * **The two `DELETE`s are why a status code is not enough.** A route that refuses *after* it has
 * already reset the record has refused nothing, and that failure is invisible to a caller reading
 * `403`. So each refusal is followed by reading the record back through a loopback call, from the
 * same process, and the assertion is that it is still there.
 *
 * Four servers' worth of question, over two:
 *
 *   1. bound to `0.0.0.0` and called on an address that is not loopback — all five answer 403,
 *      the refusal is the caller guard's rather than the origin gate's, it carries none of the
 *      worktree path with it, and **both records survive both `DELETE`s**;
 *   2. bound to loopback — all five answer exactly as they did before, `GET /api/implement`
 *      carries its `queue` key, and both `DELETE`s really do reset the record they name, so the
 *      guard is a guard rather than a breakage;
 *   3. read off `src/server.ts`: each of the five carries an `offLoopback` call, and none of them
 *      grew a second inlined copy of the rule beside it.
 *
 * **The records are seeded through git, not through a route.** `POST /api/implement` is guarded on
 * the *bind* and refuses everybody on a server bound to `0.0.0.0`, its own operator included, so
 * there is no way to write a record into that process over HTTP. What there is is the path a
 * restart already takes: a checkout named `issue-<n>` holding work makes `recoverInterruptedRuns`
 * write an `interrupted` record at startup, off git and with no agent anywhere near it. Two
 * checkouts, so each `DELETE` can be aimed at a record of its own and neither can pass by
 * resetting the other's.
 *
 * **The remote caller is a real one, and it did not have to be.** #518 was written when the plan
 * was to bind `127.0.0.2` — off loopback to a list of `127.0.0.1` and `::1` exactly, and never
 * leaving the machine. Since #501 the guard asks about the *caller*, and `127.0.0.2` is an
 * ordinary loopback caller by RFC 1122, so that address proves nothing here. `scripts/lib/
 * remote-caller.mjs` is what the funnel's own checks use instead: a host-only adapter where there
 * is one, a real interface named on stdout where there is not, and `null` on a machine with
 * nothing but loopback — where section 1 says it could not run rather than passing as though it
 * had.
 *
 * Self-contained: it builds a throwaway git repository, two checkouts and a registry in a temp
 * directory, starts its own servers on ports the kernel just handed out and kills them. No
 * browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-unguarded-implement-reads.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';
import { looksLikeLoopback, peerAddressSeenOn, remoteInterfaceAddress } from './lib/remote-caller.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 20000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function note(line) {
  console.log(`  note  ${line}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The world ────────────────────────────────────────────────

const REPO = 'vitorengers/vibemaxxing';
const issue = (number) => `https://github.com/${REPO}/issues/${number}`;

/** The record the element-addressed `DELETE` aims at, and the one the URL-addressed one does. */
const BLOCK_ISSUE = issue(518);
const URL_ISSUE = issue(519);

/** The block on the board that carries `BLOCK_ISSUE`, so the element route has something to read. */
const BLOCK_ID = 'implement-guard-block';

/** A block id that is on no board, which is the other half of what a 404 would have published. */
const ABSENT_BLOCK_ID = 'no-such-block-anywhere';

const workDir = join(tmpdir(), `check-unguarded-implement-reads-${process.pid}`);
const projectDir = join(workDir, 'project');
const worktreeRoot = join(workDir, 'project-worktrees');
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

git(projectDir, ['init', '-b', 'main']);
git(projectDir, ['config', 'user.email', 'check@example.com']);
git(projectDir, ['config', 'user.name', 'Check']);
git(projectDir, ['config', 'commit.gpgsign', 'false']);

writeFileSync(join(projectDir, 'board.config.json'), JSON.stringify({
  name: 'project',
  board: 'board.excalidraw',
  repo: REPO,
}), 'utf8');
writeFileSync(join(projectDir, 'board.excalidraw'), JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'check-unguarded-implement-reads',
  elements: [{
    id: BLOCK_ID, type: 'rectangle', x: 0, y: 0, width: 200, height: 100,
    customData: { kind: 'issue', issueUrl: BLOCK_ISSUE },
  }],
  files: {},
}, null, 1), 'utf8');
writeFileSync(join(projectDir, 'README.md'), '# project\n', 'utf8');
git(projectDir, ['add', '.']);
git(projectDir, ['commit', '-m', 'initial']);

/**
 * A checkout holding work, which is the whole of what makes a restart record an interrupted run.
 *
 * One untracked file is enough: `worktreesHoldingWork` keeps any `issue-*` checkout under the
 * project's worktree root with either a commit the base cannot reach or a dirty tree, and a dirty
 * tree is the cheaper of the two to build.
 */
function heldWorktree(number) {
  const at = join(worktreeRoot, `issue-${number}`);
  git(projectDir, ['worktree', 'add', '-b', `issue-${number}`, at]);
  writeFileSync(join(at, 'work.txt'), 'half a change nobody is making any more\n', 'utf8');
  return at;
}

const blockWorktree = heldWorktree(518);
const urlWorktree = heldWorktree(519);

writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'project', path: projectDir.replace(/\\/g, '/') }],
}), 'utf8');

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  dist/server.js is missing — run ./node_modules/.bin/tsc first');
  process.exit(1);
}

// ─── Asking ───────────────────────────────────────────────────

const BOARD = { 'x-workspace-id': 'project' };

async function ask(base, { path, method = 'GET', body }) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...BOARD,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

/**
 * The five, spelled once and asked of both servers.
 *
 * `after` is what a `DELETE` must not have done: the issue whose record is read back through a
 * loopback call once the refusal has been counted.
 */
const ROUTES = [
  ['GET /api/implement', { path: '/api/implement' }],
  ['GET /api/issue-block/:id/run', { path: `/api/issue-block/${BLOCK_ID}/run` }],
  ['GET /api/issue/recreate',
    { path: `/api/issue/recreate?url=${encodeURIComponent(BLOCK_ISSUE)}` }],
  ['DELETE /api/implement',
    { path: '/api/implement', method: 'DELETE', body: { url: URL_ISSUE }, after: URL_ISSUE }],
  ['DELETE /api/issue-block/:id/implement',
    { path: `/api/issue-block/${BLOCK_ID}/implement`, method: 'DELETE', after: BLOCK_ISSUE }],
];

async function waitForHealth(base, child) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Canvas server exited early (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error(`Timed out waiting for the canvas server on ${base}.`);
}

/** One record, read the way the panel reads it: by URL, over loopback. */
async function recordFor(loopbackBase, issueUrl) {
  const answer = await ask(loopbackBase, {
    path: `/api/implement?url=${encodeURIComponent(issueUrl)}`,
  });
  return answer.json?.implement ?? null;
}

/**
 * Both records, once startup has derived them from git.
 *
 * `recoverInterruptedRuns` is deliberately not awaited by the listen callback — a board must not
 * wait on a handful of git processes to open its port — so the records arrive a moment after
 * `/health` does.
 */
async function waitForRecords(loopbackBase) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    const block = await recordFor(loopbackBase, BLOCK_ISSUE);
    const url = await recordFor(loopbackBase, URL_ISSUE);
    if (block && url) return { block, url };
    await sleep(200);
  }
  throw new Error('Startup never derived the two interrupted runs from the checkouts.');
}

const [offPort, loopbackPort] = await freePorts(2);
const env = {
  EXCALIDRAW_WORKSPACES: registryPath,
  EXCALIDRAW_LIBRARY: '',
  LOG_LEVEL: 'error',
  // Configured, so `GET /api/implement` has a `queue` key to keep and the routes are refused by
  // the guard rather than 404'd as a feature nobody turned on. It is never spawned: nothing here
  // starts a run.
  EXCALIDRAW_IMPLEMENT_AGENT: 'node -e "process.exit(0)"',
};

const remote = await remoteInterfaceAddress(note);

let off;
let loopback;

try {
  // ─── 1. Called from off this machine, all five refuse ────────

  if (!remote) {
    note('this machine has no non-loopback address to be called on, so section 1 — the caller '
         + 'that is not on this machine — could not be run at all');
  } else {
    console.log(`\n1. bound to 0.0.0.0 and called on ${remote}, all five refuse`);

    off = startCanvas({
      port: offPort,
      cwd: workDir,
      env: {
        ...env,
        HOST: '0.0.0.0',
        // The origin gate is a different control and this check is not about it. A request to
        // `http://<interface>:<port>` names that authority in `Host`, which a board bound to
        // `0.0.0.0` does not answer for, so without this every case below would be refused by the
        // wrong gate and would pass for the wrong reason.
        EXCALIDRAW_ALLOWED_HOSTS: `${remote}:${offPort}`,
      },
    });
    const offBase = `http://${remote}:${offPort}`;
    const offLoopbackBase = `http://127.0.0.1:${offPort}`;
    await waitForHealth(offLoopbackBase, off.child);

    // The premise, established with a server of this check's own rather than with the code under
    // test: a connection to one of this machine's interface addresses reports that interface as
    // its source, not 127.0.0.1.
    const peer = await peerAddressSeenOn(remote);
    check(`a server on ${remote} sees a peer that is not loopback (${peer})`,
          Boolean(peer) && !looksLikeLoopback(peer), peer);

    const seeded = await waitForRecords(offLoopbackBase);
    check('the two interrupted runs are on the record before anything is asked',
          seeded.block?.state === 'interrupted' && seeded.url?.state === 'interrupted',
          JSON.stringify(seeded).slice(0, 200));
    check('and the record names the worktree it left on this machine, which is what leaks',
          typeof seeded.block?.worktree === 'string' && seeded.block.worktree.length > 0,
          JSON.stringify(seeded.block).slice(0, 200));

    const health = await ask(offBase, { path: '/health' });
    check('the canvas itself is up — this is a guard, not a broken server', health.status === 200,
          `${health.status} ${health.text.slice(0, 120)}`);

    for (const [name, probe] of ROUTES) {
      const refused = await ask(offBase, probe);
      check(`${name} answers 403`, refused.status === 403,
            `got ${refused.status} — ${refused.text.slice(0, 200)}`);
      check(`  ${name} refuses in the words of the caller guard, not of the origin gate`,
            /machine/i.test(refused.text) && !/DNS rebinding/i.test(refused.text),
            refused.text.slice(0, 200));
      const leaked = [blockWorktree, urlWorktree, workDir]
        .filter((path) => refused.text.includes(path) || refused.text.includes(path.replace(/\\/g, '/')));
      check(`  ${name} carries none of the worktree into its refusal`, leaked.length === 0,
            leaked.join(', '));

      // The half a status code cannot see: a route that refused *after* resetting has refused
      // nothing. Read back through a loopback call, from the same process, so this is the record
      // itself rather than a second opinion about it.
      if (probe.after) {
        const still = await recordFor(offLoopbackBase, probe.after);
        check(`  ${name} left the record it was refused exactly where it was`,
              still?.state === 'interrupted',
              `${probe.after} now reads ${JSON.stringify(still)}`);
      }
    }

    // The element route read its element before it refused, so a 404 for a block that is not
    // there and a 400 for one that is told a caller which ids this board holds. Both answers are
    // now the same one.
    const known = await ask(offBase, {
      path: `/api/issue-block/${BLOCK_ID}/implement`, method: 'DELETE',
    });
    const unknown = await ask(offBase, {
      path: `/api/issue-block/${ABSENT_BLOCK_ID}/implement`, method: 'DELETE',
    });
    check('a block that is on the board and one that is not are refused identically',
          known.status === unknown.status && known.text === unknown.text,
          `${known.status} ${known.text.slice(0, 120)} / ${unknown.status} ${unknown.text.slice(0, 120)}`);

    off.stop();
    off = null;
  }

  // ─── 2. And on loopback, all five do what they always did ────

  console.log('\n2. bound to loopback, all five answer a caller the guard admits');

  loopback = startCanvas({ port: loopbackPort, cwd: workDir, env });
  await waitForHealth(loopback.base, loopback.child);
  const seeded = await waitForRecords(loopback.base);
  check('the two interrupted runs are there for this server too',
        seeded.block?.state === 'interrupted' && seeded.url?.state === 'interrupted',
        JSON.stringify(seeded).slice(0, 200));

  const listed = await ask(loopback.base, { path: '/api/implement' });
  check('GET /api/implement answers', listed.status === 200, listed.text.slice(0, 200));
  check('  and lists both runs', (listed.json?.runs ?? []).length === 2,
        JSON.stringify(listed.json?.runs ?? []).slice(0, 200));
  // The one thing this route does differently off loopback, and it is about the *bind* rather
  // than about the caller: the toggle it draws turns `POST /api/implement/queue` on, which is
  // bind-guarded, so a board on an interface must not draw a button that cannot work.
  check('  and keeps its queue key, which is the half a caller the guard admits still needs',
        listed.json?.queue !== undefined, JSON.stringify(listed.json).slice(0, 200));
  check('  and its concurrency cap', typeof listed.json?.concurrency === 'number',
        JSON.stringify(listed.json).slice(0, 200));

  const run = await ask(loopback.base, { path: `/api/issue-block/${BLOCK_ID}/run` });
  check('GET /api/issue-block/:id/run answers',
        run.status === 200 && run.json?.success === true, run.text.slice(0, 200));

  const recreate = await ask(loopback.base, {
    path: `/api/issue/recreate?url=${encodeURIComponent(BLOCK_ISSUE)}`,
  });
  check('GET /api/issue/recreate answers',
        recreate.status === 200 && recreate.json?.success === true, recreate.text.slice(0, 200));

  // And the writes still write: a guard that quietly broke the reset would pass every assertion
  // above and every one in section 1.
  const byUrl = await ask(loopback.base, {
    path: '/api/implement', method: 'DELETE', body: { url: URL_ISSUE },
  });
  check('DELETE /api/implement answers', byUrl.status === 200, byUrl.text.slice(0, 200));
  check('  and really did reset the record it names',
        (await recordFor(loopback.base, URL_ISSUE)) === null,
        JSON.stringify(await recordFor(loopback.base, URL_ISSUE)));

  const byBlock = await ask(loopback.base, {
    path: `/api/issue-block/${BLOCK_ID}/implement`, method: 'DELETE',
  });
  check('DELETE /api/issue-block/:id/implement answers', byBlock.status === 200,
        byBlock.text.slice(0, 200));
  check('  and really did reset the record its block names',
        (await recordFor(loopback.base, BLOCK_ISSUE)) === null,
        JSON.stringify(await recordFor(loopback.base, BLOCK_ISSUE)));

  loopback.stop();
  loopback = null;
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  if (off && process.env.DEBUG_UNGUARDED_IMPLEMENT_READS) console.error(off.read());
  if (loopback && process.env.DEBUG_UNGUARDED_IMPLEMENT_READS) console.error(loopback.read());
} finally {
  if (off) off.stop();
  if (loopback) loopback.stop();
  await sleep(250);
  try { git(projectDir, ['worktree', 'prune']); } catch { /* nothing to prune */ }
  // Guarded, because a teardown is not a verdict (#472): two canvas servers were just killed and
  // on Windows their handles are released asynchronously. `run-checks.mjs` reaps the `check-*`
  // directories left in `os.tmpdir()`, so a leak costs one directory.
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* still held; the next run's reaper collects it */ }
}

// ─── 3. And a sixth cannot be the next one left out ───────────

console.log('\n3. each of the five carries the funnel in src/server.ts, and only the funnel');

const source = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const declarations = [...source.matchAll(/^app\.(get|post|put|delete|patch)\((['"])([^'"]+)\2/gm)];
check(`src/server.ts declares routes (${declarations.length} found)`, declarations.length > 0);

/** The route bodies, by `METHOD /path`, each running to wherever the next route begins. */
const bodyOf = new Map();
declarations.forEach(([, method, , path], index) => {
  const from = declarations[index].index;
  const to = index + 1 < declarations.length ? declarations[index + 1].index : source.length;
  bodyOf.set(`${method.toUpperCase()} ${path}`, source.slice(from, to));
});

for (const [name] of ROUTES) {
  const body = bodyOf.get(name);
  if (body === undefined) { check(`${name} exists`, false, 'no such route'); continue; }
  // A *call* — `offLoopback(res, 'An implementation record is reset')` — for the reason
  // `check-workspaces-guard.mjs` gives: matching the bare name counts a declaration as a use.
  check(`${name} calls offLoopback`, /offLoopback\(res,\s*['"]/.test(body),
        body.slice(0, 200));
  // And exactly one of them: two funnels in one body is two places to change, and the second is
  // the one that gets forgotten.
  check(`  ${name} calls it once`,
        (body.match(/offLoopback\(res,\s*['"]/g) ?? []).length === 1);
  // The bind test is the *other* question and is nobody's business here. `GET /api/implement`
  // reads `LOOPBACK_ADDRESSES.includes(HOST)` on purpose, to decide whether to draw a queue
  // toggle whose route is bind-guarded; what must not appear is the negated form, which is a
  // second, inlined copy of the rule the funnel already states.
  check(`  ${name} grows no second inlined copy of the rule`,
        !/!LOOPBACK_ADDRESSES\.includes\(HOST\)/.test(body),
        body.slice(0, 200));
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: nothing about an implementation is published to, or taken from, a '
            + 'caller that is not on this machine.');
