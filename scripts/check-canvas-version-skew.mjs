#!/usr/bin/env node
/**
 * Checks that a canvas answering with the *old* code is named rather than used.
 *
 * `ensureCanvasRunning` attaches to whatever answers `/health` with this service's marker and
 * returns `spawned: false`. An auto-started canvas is detached and unref'd, so it outlives every
 * session that could have stopped it — and on a release whose update path is
 * `npx -y <pkg>@latest`, the second run of an upgraded tool meets the first run's server still
 * holding the port, still serving the previous `dist/frontend`, still answering every request
 * exactly as it did. That is `docs/trap-stale-server.md` — "the old one keeps answering, silently,
 * with the old code" — and until this change nothing on the wire could tell the two apart:
 * `/health` reported status, counts, service, pid, workspaces, terminal and agents, and no
 * version at all.
 *
 * So four things are asserted here, and they are the four halves of one fix:
 *
 *   1. `/health` carries the package version, beside `service` and without disturbing it;
 *   2. a canvas-driving call against a canvas of a different version is **refused**, naming both
 *      versions and the remedy — restarting is destructive of whatever the board holds, so the
 *      safe default is to stop rather than to replace somebody's running board unasked;
 *   3. the refusal has an override, because a dev build driving a globally installed canvas is
 *      the maintainer's own setup and refusing it outright would break the machine this is
 *      written on;
 *   4. `restart` replaces the canvas on the same port, with a different pid — and refuses first
 *      when the board is in the middle of implementing something, which a restart would end.
 *
 * `status` is deliberately the one command that does *not* refuse: it is the command whose whole
 * job is to report, so it prints both versions and says which way they differ.
 *
 * Self-contained. Two kinds of server are started, both on ports the kernel just handed out and
 * both killed at the end: real canvases from `dist/server.js`, and a stand-in that answers
 * `/health` with whatever payload a case needs. The stand-in is how an *older* canvas is
 * arranged without a second build on disk — what is being checked is how this build reacts to a
 * payload, and a payload is a thing a check can simply write. It reports its own pid, so nothing
 * here can ever signal a process it did not start. Nothing talks to the board, to GitHub or to
 * the network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-canvas-version-skew.mjs
 *
 * Tier: fast
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, repoRoot, startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const INSTALLED = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const OLDER = '0.0.1-older';
const binPath = join(repoRoot, 'dist', 'bin.js');

const workDir = join(tmpdir(), `canvas-version-skew-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const stateHome = join(workDir, 'state');
mkdirSync(stateHome, { recursive: true });

/** Every process this run is responsible for, including ones a restart created. */
const toKill = [];

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function healthOf(base, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return await response.json();
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return null;
}

/** One reading, or null — for a port that is expected to be changing hands. */
async function healthNow(base) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// ─── The stand-in ─────────────────────────────────────────────

/**
 * A server that answers `/health` with a payload the case chose, and `/api/elements` with an
 * empty scene so that a call which is *allowed* through has somewhere to land.
 *
 * It reports `pid: process.pid` — its own — so that a `stop` reaching for the pid a responder
 * self-reports can only ever signal this process. That is the same rule `stopCanvas` follows,
 * and it is what makes it safe to point a destructive command at a fixture.
 */
const standInScript = join(workDir, 'stand-in.mjs');
writeFileSync(standInScript, `import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const payload = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/health') {
    return json(res, 200, {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      elements_count: 0,
      websocket_clients: 0,
      service: 'mcp-excalidraw-canvas',
      pid: process.pid,
      ...payload,
    });
  }
  if (path === '/api/elements') return json(res, 200, { success: true, elements: [] });
  return json(res, 404, { success: false, error: 'the stand-in serves /health and /api/elements' });
}).listen(port, '127.0.0.1');
`, 'utf8');

/** Start a stand-in answering `payload` merged over the ordinary identity fields. */
async function standIn(payload) {
  const port = await freePort();
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const child = spawn(process.execPath, [standInScript, String(port), encoded], {
    cwd: workDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  toKill.push(child.pid);
  const base = `http://127.0.0.1:${port}`;
  const health = await healthOf(base, 60);
  if (health === null) throw new Error(`the stand-in never answered on ${base}`);
  return { base, port, pid: child.pid, health };
}

// ─── The CLI under test ───────────────────────────────────────

/**
 * Run one CLI command against `base`, with a state directory of this run's own.
 *
 * The target is named with `--url`, the explicit override every command accepts (`src/bin.ts`
 * strips it before dispatch), so which server a case asserts is decided in the case and not by
 * anything the machine is holding.
 */
function cli(args, { base, env = {}, timeoutMs = 60000 } = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args, '--url', base], {
    cwd: repoRoot,
    env: canvasEnvironment({
      EXCALIDRAW_STATE_HOME: stateHome,
      LOG_LEVEL: 'error',
      ...env,
    }),
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    said: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function jsonOut(result) {
  try { return JSON.parse(result.stdout); } catch { return null; }
}

try {
  // ─── 1. /health carries the version ─────────────────────────

  console.log('\n1. /health says which version is answering');

  const realPort = await freePort();
  const real = startCanvas({ port: realPort, env: { EXCALIDRAW_STATE_HOME: stateHome, LOG_LEVEL: 'error' } });
  toKill.push(real.child.pid);
  const realHealth = await healthOf(real.base);

  check('the canvas answers /health at all', realHealth !== null, real.read());
  check('it reports the version of the package it was built from',
    realHealth?.version === INSTALLED,
    `version was ${JSON.stringify(realHealth?.version)}, package.json says ${INSTALLED}`);
  check('and still identifies as this service, which the identity gate reads',
    realHealth?.service === 'mcp-excalidraw-canvas', `service was ${realHealth?.service}`);
  check('and still self-reports its pid, which `stop` depends on',
    realHealth?.pid === real.child.pid, `said ${realHealth?.pid}, is ${real.child.pid}`);
  check('and says nothing is being implemented on it, which `restart` reads before it stops',
    realHealth?.implementing === 0, `implementing was ${JSON.stringify(realHealth?.implementing)}`);

  // ─── 2. An older canvas is refused, not used ────────────────

  console.log('\n2. a call against an older canvas is refused and names the mismatch');

  const older = await standIn({ version: OLDER });
  const refused = cli(['describe'], { base: older.base });

  check('the command fails instead of quietly describing the old board\'s scene',
    refused.code !== 0, `exit ${refused.code}; stdout was ${JSON.stringify(refused.stdout)}`);
  check('it exits 3, the code for a canvas this build cannot drive', refused.code === 3,
    `exit ${refused.code}`);
  check('the refusal names the version that is running', refused.said.includes(OLDER), refused.said);
  check('and the version that is installed', refused.said.includes(INSTALLED), refused.said);
  check('and names `restart` as the remedy', /\brestart\b/.test(refused.said), refused.said);
  check('nothing of the old canvas\'s scene reached stdout', refused.stdout.trim() === '',
    JSON.stringify(refused.stdout));

  // ─── 3. A canvas too old to report a version at all ─────────

  console.log('\n3. a canvas from before /health carried a version is named too');

  const silent = await standIn({});
  check('the stand-in really reports no version', silent.health?.version === undefined,
    JSON.stringify(silent.health?.version));

  const versionless = cli(['describe'], { base: silent.base });
  check('the command is refused', versionless.code === 3, `exit ${versionless.code}`);
  check('and the refusal says the running canvas does not report one',
    /does not report/i.test(versionless.said) || /no version/i.test(versionless.said),
    versionless.said);

  // ─── 4. The refusal has an override ─────────────────────────

  console.log('\n4. the refusal can be overridden, for a dev build against an installed canvas');

  const allowed = cli(['describe'], {
    base: older.base,
    env: { VIBEMAXXING_ALLOW_VERSION_SKEW: '1' },
  });
  check('the same call now goes through', allowed.code === 0,
    `exit ${allowed.code} — ${allowed.said}`);
  check('and nothing was refused over the versions', !allowed.stderr.includes(OLDER),
    allowed.stderr);

  // ─── 5. `status` reports rather than refuses ────────────────

  console.log('\n5. `status` prints both versions and names the mismatch');

  const skewStatus = cli(['status'], { base: older.base });
  const skewed = jsonOut(skewStatus);
  check('`status` still answers rather than refusing', skewStatus.code === 0,
    `exit ${skewStatus.code} — ${skewStatus.said}`);
  check('it prints the version that is running', skewed?.version === OLDER,
    JSON.stringify(skewed));
  check('and the version that is installed', skewed?.installedVersion === INSTALLED,
    JSON.stringify(skewed));
  check('and says the two differ', skewed?.versionMismatch === true, JSON.stringify(skewed));
  check('and names the remedy in prose', /\brestart\b/.test(skewStatus.stderr), skewStatus.stderr);

  const matchedStatus = cli(['status'], { base: real.base });
  const matched = jsonOut(matchedStatus);
  check('against a canvas of this build it reports no mismatch',
    matched?.versionMismatch === false, JSON.stringify(matched));
  check('and both versions read the same', matched?.version === matched?.installedVersion,
    JSON.stringify(matched));

  // ─── 6. `restart` replaces the canvas on its port ───────────

  console.log('\n6. `restart` replaces the running canvas on the same port');

  const oldPid = realHealth?.pid ?? real.child.pid;
  const restarted = cli(['restart'], { base: real.base });
  const restartJson = jsonOut(restarted);
  check('the command succeeds', restarted.code === 0, `exit ${restarted.code} — ${restarted.said}`);
  check('it says which pid it stopped', restartJson?.stopped === oldPid,
    `${JSON.stringify(restartJson)} vs ${oldPid}`);
  check('and the canvas is back on the same URL', restartJson?.url === real.base,
    JSON.stringify(restartJson?.url));

  const replacement = await healthOf(real.base, 60);
  if (replacement?.pid) toKill.push(replacement.pid);
  check('something answers /health on that port again', replacement !== null);
  check('and it is a different process', replacement !== null && replacement.pid !== oldPid,
    `pid ${replacement?.pid} vs ${oldPid}`);
  check('the pid the command reported is the one answering', restartJson?.pid === replacement?.pid,
    `${JSON.stringify(restartJson?.pid)} vs ${JSON.stringify(replacement?.pid)}`);
  check('the process that answered before is gone', !isAlive(oldPid), `pid ${oldPid} is still alive`);
  check('and the replacement reports this build\'s version', replacement?.version === INSTALLED,
    JSON.stringify(replacement?.version));

  // ─── 7. A restart mid-implement says so first ───────────────

  console.log('\n7. `restart` refuses a board that is in the middle of implementing');

  const busy = await standIn({ version: INSTALLED, implementing: 2 });
  const refusedRestart = cli(['restart'], { base: busy.base });
  check('the restart is refused', refusedRestart.code !== 0,
    `exit ${refusedRestart.code} — ${refusedRestart.said}`);
  check('it says how many runs would be ended', /\b2\b/.test(refusedRestart.said),
    refusedRestart.said);
  check('and names the flag that means it anyway', refusedRestart.said.includes('--force'),
    refusedRestart.said);
  check('and the board it refused to restart is still running', isAlive(busy.pid),
    `pid ${busy.pid} is gone`);
  check('which is to say nothing was stopped', (await healthNow(busy.base)) !== null,
    'the stand-in stopped answering');
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.stack ?? error.message}`);
} finally {
  for (const pid of toKill) {
    if (pid && isAlive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  await sleep(500);
  // Forgiven: on Windows a killed server's handles on its state directory are
  // released asynchronously, and a run that reported failure because it could not
  // delete a temporary directory would be wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict (#472); run-checks.mjs reaps it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
