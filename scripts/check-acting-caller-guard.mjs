#!/usr/bin/env node
/**
 * The routes that *act on this machine* ask who is calling, like the ones that read it.
 *
 * `offLoopback` moved to the caller's own address in #501 and learned an approved device in #522,
 * so the board's contents are the host's and a paired laptop's. The other half did not move. The
 * eleven routes that spawn `gh`, and `actingFor` behind the terminal and the implement agent,
 * still tested the **bind** — `LOOPBACK_ADDRESSES.includes(HOST)` — and a bind is not a caller.
 *
 * What that cost is not theoretical and it is not the stranger's: it is the operator's. A board
 * started on an interface so that a second machine can reach it refused the project mirror, the
 * GitHub status, the founder column, every issue read and the terminal **to the browser on the
 * machine running it**, whose request arrives from loopback. Measured on such a board, at
 * `127.0.0.1`, carrying the board's own token: `/api/elements` 200 and `/api/project-board` 403.
 * Half the product, off, for the one caller no guard was ever trying to stop.
 *
 * The question is now the funnel's: **a caller on this machine, or one on a device this board has
 * approved.** For a caller that is not on this machine that is strictly *tighter* than the bind
 * test rather than looser — the bind test admitted nobody remote and refused the host too, so the
 * only caller this newly admits is the operator's own browser. And it hands an approved device
 * nothing it did not hold: `actingFor` already admitted one to the terminal, and a shell is
 * strictly more than any `gh` route, so refusing that device the project mirror while giving it a
 * shell was an inconsistency rather than a boundary.
 *
 * One board, bound to `0.0.0.0`, reached three ways at the same moment:
 *
 *   1. **the host** — `127.0.0.1`, carrying the board token. Every route below answered 403 to
 *      this caller before the change, and that is the case this check exists for.
 *   2. **a stranger** — this machine's own interface address, carrying the board token and no
 *      device. Refused, and the refusal has to be the caller guard's rather than the origin
 *      gate's, or the case passes for the wrong reason.
 *   3. **an approved device** — the same address, carrying a credential minted by the real
 *      `/api/pair/*` gesture. Served.
 *
 * `403` is the whole verdict and the routes' other statuses are deliberately not asserted. `gh` is
 * sealed by `lib/spawn-canvas.mjs`, the elements named do not exist and the board's project is a
 * fabrication, so a route that gets past the guard answers 404, 400 or 502 — and *which* is that
 * route's business, not this one's. What this check is about is the one status that means "not
 * you".
 *
 * **The wording is checked too**, because a refusal that told the reader about loopback would send
 * whoever hits it to rebind a server that is bound correctly. `offLoopback` says at length why it
 * names the credential instead; these say the same thing for the same reason.
 *
 * `actingFor(null)` — the board asking about *itself*, for a run the queue starts on its own
 * account — is asserted over the source rather than over a request, because there is no request to
 * make: the two callers that pass null (`interactiveTabRefusal`, `implementTerminalHost`) are
 * reached from inside a run. What it must not do is read `HOST`, and section 4 holds that.
 *
 * Self-contained: one throwaway board and registry, one canvas server on a port the kernel just
 * handed out, a throwaway `HOME`, and all of it gone at the end. No browser.
 * Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-acting-caller-guard.mjs
 *
 * Tier: fast
 */

import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';
import { looksLikeLoopback, peerAddressSeenOn, remoteInterfaceAddress } from './lib/remote-caller.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(repoRoot, 'dist', 'server.js'))) {
  console.error('  FAIL  the server is built — dist/server.js not found');
  console.error('        (run ./node_modules/.bin/tsc first)');
  process.exit(1);
}

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};
const note = (line) => console.log(`  note  ${line}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The one header name the server, the page and this check all have to agree on. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

/** Not a failure: the one machine shape on which the remote half cannot be asked. */
class Skip extends Error {}

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-acting-caller-'));
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

/** Where a state file has to appear, spelled out from the platform rather than imported. */
function conventionalStateFile(name) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf, name);
}

const BOARD = 'acting';
const boardDir = join(workDir, BOARD);
mkdirSync(boardDir, { recursive: true });
// A project on it, so `GET /api/project-board` reaches past the workspace lookup and is refused
// by the guard rather than answered 404 for having nothing to mirror.
writeFileSync(join(boardDir, 'board.config.json'), JSON.stringify({
  name: 'acting',
  repo: 'vitorengers/vibemaxxing',
  githubProject: 'https://github.com/users/nobody/projects/1',
}), 'utf8');

const registryPath = join(workDir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: BOARD, path: boardDir.replace(/\\/g, '/') }],
}), 'utf8');

/**
 * One request, over `node:http` rather than `fetch`, reaching a chosen address.
 *
 * `fetch` offers no say over which address it connects *from*, and that is the whole subject here:
 * which socket the server sees.
 */
function call(at, path, { method = 'GET', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: at.address,
      port: at.port,
      path,
      method,
      headers: {
        'x-workspace-id': BOARD,
        ...(payload === null
          ? {}
          : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(host ? { Host: host } : {}),
        ...headers,
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* HTML, or nothing */ }
        resolve({ status: response.statusCode, text, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload !== null) request.write(payload);
    request.end();
  });
}

/**
 * Every route that acts on this machine with the operator's own credentials.
 *
 * The eleven that spawned `gh` behind an inline bind test, plus the two that go through
 * `actingFor`: the implement agent and the terminal. `GET /api/implement` is held out of this
 * table and asked separately, because what is wrong with it is not a status — it answers 200 to
 * the host either way — but a capability flag it drops.
 */
const ACTS = [
  ['POST /api/issue-block/:id',
   { method: 'POST', path: '/api/issue-block/no-such-block', body: {} }],
  ['GET  /api/issue',
   { path: '/api/issue?url=https%3A%2F%2Fgithub.com%2Fnobody%2Fnothing%2Fissues%2F1' }],
  ['POST /api/issue/comment',
   { method: 'POST', path: '/api/issue/comment',
     body: { url: 'https://github.com/nobody/nothing/issues/1', body: 'an observation' } }],
  ['GET  /api/issue-block/:id/issue',
   { path: '/api/issue-block/no-such-block/issue' }],
  ['GET  /api/project-board',
   { path: '/api/project-board' }],
  ['GET  /api/github-status',
   { path: '/api/github-status' }],
  ['POST /api/project-board/move',
   { method: 'POST', path: '/api/project-board/move', body: { itemId: 'PVTI_x', optionId: 'opt' } }],
  ['GET  /api/founder-actions',
   { path: '/api/founder-actions' }],
  ['POST /api/founder-actions/resolve',
   { method: 'POST', path: '/api/founder-actions/resolve', body: { key: 'nothing', how: 'person' } }],
  ['POST /api/founder-actions/chat',
   { method: 'POST', path: '/api/founder-actions/chat', body: { key: 'nothing', message: 'hello' } }],
  ['GET  /api/founder-actions/chat',
   { path: '/api/founder-actions/chat?key=nothing' }],
  ['POST /api/issue-block/:id/implement',
   { method: 'POST', path: '/api/issue-block/no-such-block/implement', body: {} }],
  ['POST /api/terminal',
   { method: 'POST', path: '/api/terminal', body: {} }],
];

const errorOf = (answer) => String(answer.body?.error ?? answer.text ?? '');

let server = null;
let log = '';

try {
  const remote = await remoteInterfaceAddress(note);
  const port = await freePort();

  server = startCanvas({
    port,
    cwd: workDir,
    env: {
      // Every interface, so one board is the host's on loopback and a second machine's on the
      // network at the same moment. Nothing leaves this machine: the address is this machine's
      // own, and connecting to it is what makes the socket a remote one.
      HOST: '0.0.0.0',
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      EXCALIDRAW_WORKSPACES: registryPath,
      // The gate a device credential has to be accepted *by*. `lib/spawn-canvas.mjs` turns
      // authentication off for every check here, and behind that there is no `res.locals.device`
      // for anybody — so every assertion about a device would pass while the board asked nothing.
      EXCALIDRAW_NO_AUTH: undefined,
      // The origin gate is a different control and this check is not about it. A request to
      // `http://<interface>:<port>` names an authority a board bound to `0.0.0.0` does not answer
      // for, so without this the remote cases would be refused by the wrong gate. Opening it is
      // what leaves the caller guard as the only thing able to turn them away — and section 3
      // asserts that it is the one that did.
      ...(remote ? { EXCALIDRAW_ALLOWED_HOSTS: `${remote}:${port}` } : {}),
      EXCALIDRAW_TERMINAL: '1',
      // Configured, because both of these routes answer 404 before they reach the guard when they
      // are not. Harmless: every request below names a block that does not exist, so the guard is
      // the only thing that can answer and nothing is ever spawned.
      EXCALIDRAW_ISSUE_AGENT: 'node -e "process.exit(0)"',
      EXCALIDRAW_IMPLEMENT_AGENT: 'node -e "process.exit(0)"',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
    },
  });
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });

  const host = { address: '127.0.0.1', port };
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* not up */ }
    if (attempt > 150) throw new Error(`the canvas server never came up\n${log}`);
    await sleep(100);
  }
  const boardToken = readFileSync(conventionalStateFile(`server-${port}.token`), 'utf-8').trim();
  const asHost = { [TOKEN_HEADER]: boardToken };

  // ─── 1. The caller on this machine, on a board bound to every interface ───

  console.log('\n1. bound to 0.0.0.0, the operator on this machine acts — every one of these '
              + 'answered 403 before');

  const hostAnswers = new Map();
  for (const [name, request] of ACTS) {
    const answer = await call(host, request.path, { ...request, headers: asHost });
    hostAnswers.set(name, answer);
    check(`${name} is not refused`, answer.status !== 403,
          `got ${answer.status} — ${errorOf(answer).slice(0, 150)}`);
  }

  const queueForHost = await call(host, '/api/implement', { headers: asHost });
  check('GET  /api/implement answers the host', queueForHost.status === 200,
        `${queueForHost.status} ${queueForHost.text.slice(0, 150)}`);
  check('  and carries the queue, so the board draws no toggle its own route would refuse',
        Boolean(queueForHost.body?.queue),
        `queue=${JSON.stringify(queueForHost.body?.queue ?? null)}`);

  // ─── 2. and 3. The same board, from an address that is not this machine ───

  if (!remote) {
    note('this machine has no non-loopback address to be called on, so the stranger and the '
         + 'approved device below could not be made at all, and those cases were not run');
    throw new Skip();
  }

  const away = { address: remote, port };

  console.log(`\n2. the same board, called on ${remote} with the board's own token and no device`);

  // The premise, established with this check's own server rather than with the code under test.
  const peer = await peerAddressSeenOn(remote);
  check(`a server on ${remote} sees a peer that is not loopback (${peer})`,
        Boolean(peer) && !looksLikeLoopback(peer), String(peer));

  for (const [name, request] of ACTS) {
    const answer = await call(away, request.path, { ...request, headers: asHost });
    check(`${name} is refused`, answer.status === 403,
          `got ${answer.status} — ${errorOf(answer).slice(0, 150)}`);
    check(`  by the caller guard rather than the origin gate`,
          !/DNS rebinding/i.test(errorOf(answer)), errorOf(answer).slice(0, 150));
    // The wording, which is the difference between a reader who pairs a device and one who goes
    // and rebinds a server that is bound correctly.
    check(`  naming an approved device rather than the bind`,
          /device/i.test(errorOf(answer)) && !/bound to loopback/i.test(errorOf(answer)),
          errorOf(answer).slice(0, 200));
  }

  const queueAway = await call(away, '/api/implement', { headers: asHost });
  check('GET  /api/implement is refused too', queueAway.status === 403,
        `${queueAway.status} ${queueAway.text.slice(0, 150)}`);

  // ─── 3. And the device the operator approved ─────────────────

  console.log('\n3. and a caller on a device this board has approved acts as the operator does');

  const asked = await call(away, '/api/pair/request', {
    method: 'POST', body: { name: 'a laptop across the desk' },
  });
  check('the device asks to pair from off this machine', asked.status === 200,
        `${asked.status} ${asked.text.slice(0, 200)}`);

  const approved = await call(host, '/api/pair/approve', {
    method: 'POST',
    headers: asHost,
    body: { requestId: asked.body?.requestId, code: asked.body?.code },
  });
  check('the operator approves it from this machine', approved.status === 200,
        `${approved.status} ${approved.text.slice(0, 200)}`);

  const collected = await call(away, `/api/pair/status?requestId=${asked.body?.requestId}`);
  const credential = collected.body?.credential ?? '';
  check('and it collects the one copy of its secret there will ever be',
        typeof credential === 'string' && credential.includes('.'),
        `${collected.status} ${collected.text.slice(0, 200)}`);
  const asDevice = { [TOKEN_HEADER]: credential };

  for (const [name, request] of ACTS) {
    const answer = await call(away, request.path, { ...request, headers: asDevice });
    check(`${name} is not refused to it`, answer.status !== 403,
          `got ${answer.status} — ${errorOf(answer).slice(0, 150)}`);
  }

  const queueForDevice = await call(away, '/api/implement', { headers: asDevice });
  check('GET  /api/implement carries the queue for it as well',
        queueForDevice.status === 200 && Boolean(queueForDevice.body?.queue),
        `${queueForDevice.status} ${queueForDevice.text.slice(0, 150)}`);

  // What the widening must not widen: the desk where a device is approved stays the host's, or an
  // approved laptop could approve the next one.
  const deskFromDevice = await call(away, '/api/pair/pending', { headers: asDevice });
  check('the pairing desk is still the host\'s, not a paired device\'s',
        deskFromDevice.status === 403, `${deskFromDevice.status} ${deskFromDevice.text.slice(0, 150)}`);
} catch (error) {
  if (!(error instanceof Skip)) {
    failures++;
    console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  if (server) server.stop();
  await sleep(300);
  // Forgiven: on Windows a killed server's handles on its directory are released asynchronously,
  // and a run that reported failure because it could not delete a temporary directory would be
  // wrong about the thing it measured (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict; run-checks.mjs reaps it */ }
}

// ─── 4. No route decides this on the bind any more ─────────────

console.log('\n4. the decision is the caller\'s everywhere it is made, and the bind decides nothing');

const source = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');

/**
 * The inline test, in the one spelling all eleven routes wrote it in.
 *
 * Counted over the source rather than inferred from the routes above, because a route that is
 * added tomorrow can copy the line and no request in this file would ask it anything. Read with
 * `readFileSync`: `rg` classifies a file holding a NUL byte as binary and stops part way through
 * it, which is how eleven of these were read as five (#587).
 */
const inlineBindTests = source.split(/\r?\n/)
  .map((line, index) => ({ line: line.trim(), at: index + 1 }))
  .filter(({ line }) => /!LOOPBACK_ADDRESSES\.includes\(HOST\)/.test(line));
check('no route tests the bind inline', inlineBindTests.length === 0,
      inlineBindTests.map(({ at, line }) => `src/server.ts:${at} ${line}`).join('\n        '));

/** The body of a top-level function in that file, or '' when there is no such function. */
const bodyOf = (name) => {
  const at = source.indexOf(`function ${name}(`);
  return at === -1 ? '' : source.slice(at, source.indexOf('\n}', at));
};

/**
 * Followed through the delegation rather than asserted at each site.
 *
 * The two funnels ask one question and it is written once, so "asks the caller" is a property of
 * the predicate they share; asserting `callerIsLocal` inside each of them instead would be a check
 * that fails the day the duplication is removed, which is the wrong thing to hold still. What is
 * held at the sites is the half with the teeth: neither of them reads `HOST`.
 */
const shared = bodyOf('operatorsOwn');
check('the shared predicate asks the caller\'s own address', /callerIsLocal\(/.test(shared),
      shared.slice(0, 240) || 'there is no operatorsOwn');
check('and reads no header to decide it', !/headers|forwarded/i.test(shared), shared.slice(0, 240));

for (const funnel of ['offLoopback', 'actingFor']) {
  const body = bodyOf(funnel);
  check(`${funnel} decides on it`, /operatorsOwn\(/.test(body),
        body.slice(0, 240) || `there is no ${funnel}`);
  check(`  and not on where the server opened`, body !== '' && !/LOOPBACK_ADDRESSES|\bHOST\b/.test(body),
        body.slice(0, 240));
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: acting on this machine is the host\'s and an approved device\'s, '
            + 'and nobody else\'s.');
