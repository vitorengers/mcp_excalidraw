#!/usr/bin/env node
/**
 * Checks that the two identities which are contracts rather than labels accept their legacy
 * values, so that the rename which is coming can be landed in the safe order.
 *
 * The canvas marker in `/health` is matched exactly — by `isCanvasHealth`, which gates
 * auto-start and `stop`, and again by the identity re-probe in front of every `/api` request.
 * The state directory beside it is a filesystem path that `stop` reads a pidfile out of.
 * Renaming either one in the same commit that starts answering with the new value breaks the
 * case nobody tests: a canvas already running from the old build. The CLI would refuse it with
 * `CANVAS_UNREACHABLE` and a message blaming "a pre-1.1 canvas build or an unrelated service on
 * the port", and `stop` would look for the pidfile in a directory nothing had written, leaving
 * the port held by a server it could no longer find — which on Windows is exactly the failure
 * the restart-from-outside-its-own-tree note was written about.
 *
 * So acceptance ships first and answering changes later. What this asserts is the first half:
 * both markers are accepted and a stranger is still refused, and a pidfile is found in either
 * directory — the one being written today and the one that will be written after the rename.
 *
 * Deliberately not asserted here: what the server *answers* with. That is
 * `scripts/check-health-identity.mjs`'s subject, it still says the legacy value, and it must
 * keep passing unchanged — the two checks are the two halves of the ordering.
 *
 * Self-contained: a stub HTTP server on a free port for the marker cases, one real canvas for
 * the pidfile case, and a throwaway state directory so nothing here can find or disturb a board
 * somebody is looking at. The CLI is pointed at the stub with `--url`, never through the
 * environment. No browser, no network. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-legacy-identity-accepted.mjs
 *
 * Tier: fast
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { canvasEnvironment, repoRoot, startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The CLI's canvas-URL variable, deleted rather than used: `--url` is the explicit way in. */
const URL_VARIABLE = ['EXPRESS', 'SERVER', 'URL'].join('_');

const workDir = join(tmpdir(), `legacy-identity-${process.pid}`);
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
const stateHome = join(workDir, 'state');

delete process.env[URL_VARIABLE];
delete process.env.PORT;
process.env.EXCALIDRAW_NO_DOTENV = '1';
process.env.EXCALIDRAW_STATE_HOME = stateHome;

const stubs = [];
const canvases = [];

/** A server that answers `/health` with the marker given and 404s everything else. */
async function stubAnswering(service) {
  const port = await freePort();
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: 'healthy', service, pid: process.pid,
        elements_count: 0, websocket_clients: 0,
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"success":false,"error":"not this stub\'s business"}');
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  stubs.push(server);
  return { port, url: `http://127.0.0.1:${port}` };
}

function cli(args, extraEnv = {}) {
  const env = canvasEnvironment({ EXCALIDRAW_STATE_HOME: stateHome, ...extraEnv });
  delete env[URL_VARIABLE];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(repoRoot, 'dist', 'bin.js'), ...args], {
      cwd: workDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

let identity = null;
let identityError = '';
try {
  identity = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'identity.js')).href);
} catch (error) {
  identityError = String(error?.message ?? error);
}

let spawnModule = null;
let pidfile = null;
try {
  spawnModule = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'spawn.js')).href);
  pidfile = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'pidfile.js')).href);
} catch (error) {
  identityError ||= String(error?.message ?? error);
}

try {
  // ─── 1. Both markers pass the gate, and nothing else does ─────

  console.log('\n1. isCanvasHealth accepts either marker');

  check('there is a module naming the accepted markers',
        Array.isArray(identity?.ACCEPTED_CANVAS_SERVICE_NAMES),
        identityError || `exports were ${identity ? Object.keys(identity).join(', ') : 'nothing'}`);

  const accepted = identity?.ACCEPTED_CANVAS_SERVICE_NAMES ?? [];
  const legacy = identity?.LEGACY_CANVAS_SERVICE_NAME;
  const current = identity?.CANVAS_SERVICE_NAME;
  const next = identity?.NEXT_CANVAS_SERVICE_NAME;

  check('the legacy marker and the new one are different strings',
        typeof legacy === 'string' && typeof next === 'string' && legacy !== next,
        `legacy ${JSON.stringify(legacy)}, new ${JSON.stringify(next)}`);
  check('both are accepted', accepted.includes(legacy) && accepted.includes(next),
        JSON.stringify(accepted));
  check('and what the server answers with today is still the legacy one, unrenamed',
        current === legacy, `it answers ${JSON.stringify(current)}`);

  const isCanvasHealth = spawnModule?.isCanvasHealth;
  check('isCanvasHealth is still exported', typeof isCanvasHealth === 'function', identityError);
  if (typeof isCanvasHealth === 'function') {
    check('it accepts a payload carrying the legacy marker', isCanvasHealth({ service: legacy }) === true);
    check('it accepts a payload carrying the new marker', isCanvasHealth({ service: next }) === true);
    check('it refuses anything else', isCanvasHealth({ service: 'nginx' }) === false);
    check('it refuses a payload with no marker at all', isCanvasHealth({}) === false);
    check('and it still refuses null', isCanvasHealth(null) === false);
  }

  // ─── 2. A CLI built here attaches to either canvas ────────────

  console.log('\n2. the CLI attaches to a canvas answering either marker');

  for (const [what, service] of [['legacy', legacy], ['new', next]]) {
    if (typeof service !== 'string') {
      check(`a canvas answering the ${what} marker is attached to`, false, 'no marker to test with');
      continue;
    }
    const stub = await stubAnswering(service);
    const status = await cli(['status', '--url', stub.url]);
    const json = parseJson(status.out);
    check(`a canvas answering the ${what} marker is attached to`, status.code === 0,
          `exit ${status.code}\n      ${status.err.trim()}`);
    // `status` reports the refusal on stdout and suppresses the thrown message as `quiet`, so
    // the absence being asserted is the `conflict` field, not a line of stderr.
    check(`and nothing calls it a foreign service`,
          json?.running === true && json?.conflict === undefined,
          `${status.out.trim()} ${status.err.trim()}`);
  }

  const stranger = await stubAnswering('some-other-daemon');
  const refused = await cli(['status', '--url', stranger.url]);
  const refusedJson = parseJson(refused.out);
  check('a service answering something else is still refused', refused.code === 3,
        `exit ${refused.code} ${refused.out.trim()}`);
  check('and it is named as the conflict it is',
        refusedJson?.running === false && typeof refusedJson?.conflict === 'string',
        `${refused.out.trim()} ${refused.err.trim()}`);

  // ─── 3. The pidfile is found in either directory ──────────────

  console.log('\n3. a pidfile is found in the new directory and in the legacy one');

  const directories = typeof pidfile?.stateDirCandidates === 'function'
    ? pidfile.stateDirCandidates()
    : [];
  check('the pidfile module names two directories to look in', directories.length === 2,
        `it named ${directories.length}: ${directories.join(', ')}`);
  check('and both of them are under the state directory this run gave it',
        directories.length === 2 && directories.every((dir) => dir.startsWith(stateHome)),
        directories.join(', ') || 'it named none, so there was nothing to be under it');

  // The live half: a canvas started here writes its pidfile where the code writes it today,
  // and `stop` has to find that file, kill the server and clear it.
  const canvasPort = await freePort();
  const canvas = startCanvas({ port: canvasPort, env: { EXCALIDRAW_STATE_HOME: stateHome } });
  canvases.push(canvas);
  let up = false;
  for (let attempt = 0; attempt < 150 && !up; attempt++) {
    try { up = (await fetch(`${canvas.base}/health`)).ok; } catch { /* not yet */ }
    if (!up) await sleep(100);
  }
  check('a canvas of this run is answering', up, canvas.read().slice(-400));

  const written = typeof pidfile?.pidFilePath === 'function' ? pidfile.pidFilePath(canvasPort) : null;
  check('it wrote a pidfile into the directory this build writes to',
        written !== null && existsSync(written), `${written} is not there`);
  check('which is the legacy directory, unrenamed, as the ordering requires',
        written !== null && written.startsWith(directories[1] ?? ' '),
        `${written} is not under ${directories[1]}`);

  const stopped = await cli(['stop', '--url', canvas.base]);
  const stoppedJson = parseJson(stopped.out);
  check('`stop` finds it through the legacy directory and terminates the server',
        stopped.code === 0 && stoppedJson?.stopped === true,
        `exit ${stopped.code} ${stopped.out.trim()} ${stopped.err.trim()}`);
  check('and the pidfile is gone', written === null || !existsSync(written), `${written} survived`);

  // The forward half: after the rename the file lands in the new directory instead. Nothing
  // writes there yet, so it is put there by hand — the assertion is that a reader looks.
  const orphanPort = await freePort();
  const orphanName = written ? basename(written) : `server-${orphanPort}.pid`;
  const newDirectory = directories[0];
  if (newDirectory) {
    mkdirSync(newDirectory, { recursive: true });
    writeFileSync(join(newDirectory, orphanName.replace(String(canvasPort), String(orphanPort))),
                  String(process.pid), 'utf8');
  }
  const foundInNew = typeof pidfile?.readPidFile === 'function' ? pidfile.readPidFile(orphanPort) : null;
  check('a pidfile in the new directory is found too, so the rename orphans nothing',
        foundInNew === process.pid, `readPidFile said ${foundInNew}`);

  if (typeof pidfile?.removePidFile === 'function') pidfile.removePidFile(orphanPort);
  check('and removing it clears the copy in the new directory as well',
        typeof pidfile?.readPidFile === 'function' && pidfile.readPidFile(orphanPort) === null,
        'the file survived removePidFile');
} finally {
  for (const canvas of canvases) canvas.stop();
  for (const server of stubs) await new Promise((resolve) => server.close(resolve));
  await sleep(300);
  rmSync(workDir, { recursive: true, force: true });
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All checks passed');
