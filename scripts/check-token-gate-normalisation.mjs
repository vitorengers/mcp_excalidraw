#!/usr/bin/env node
/**
 * Checks that the token gate cannot be walked past by changing the case of `/api`.
 *
 * Measured unauthenticated against the board running on the maintainer's machine, from a second
 * process, before this landed:
 *
 *   401  /api/elements
 *   200  /API/elements          <- the whole board
 *   200  /Api/elements
 *   200  /api/../API/elements
 *   200  /API/workspaces
 *
 * ## The cause
 *
 * The gate decided whether a request needed a token by comparing the path itself —
 * `req.path !== '/api' && !req.path.startsWith('/api/')` — and that comparison is
 * case-sensitive. Express's router is not: `caseSensitive` defaults to false and nothing in
 * `src/` set it. So `/API/elements` failed the gate's test, took the `next()` that is meant for
 * a request which is not an API request at all, and then matched `app.get('/api/elements')`
 * perfectly. The gate and the router disagreed about what a path is, and everything between the
 * two answers was unauthenticated.
 *
 * ## Why it is not merely a read
 *
 * `core/auth-token.ts` names the threat the token exists for: "every other process on the
 * machine — a second user account, a sandboxed process, an npm `postinstall` in a project the
 * operator has just opened". All of those are on loopback, so every loopback guard passes for
 * them and the token was the only thing standing there.
 *
 * Since #510 that set includes `POST /api/pair/approve`, which is behind the token and behind
 * `notTheHost` and behind nothing else. So a local process could ask to pair, approve its own
 * request through the mis-cased spelling, and keep a **persisted, restart-surviving** device
 * secret from `core/device-registry.ts` without ever reading `server-<port>.token`. That is the
 * assertion in section 3, and it is the one worth having: a 200 on a read is a bad afternoon,
 * a minted credential is a bad month.
 *
 * ## What is deliberately not asserted
 *
 * Percent-encoding. `req.path` is the raw pathname and the router matches on the raw pathname,
 * so the two already agree: `/%41PI/elements` matches no route and 404s. Decoding in the gate
 * would invent a disagreement rather than close one. It is measured here anyway, as a control,
 * so that a future change which starts decoding is noticed.
 *
 * Self-contained: it starts its own canvas server with the token gate **on**, into a temporary
 * state directory, and kills it.
 *
 * Usage: node scripts/check-token-gate-normalisation.mjs
 *
 * Tier: fast
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const workDir = mkdtempSync(join(tmpdir(), 'check-token-gate-'));
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

const TOKEN_HEADER = 'x-vibemaxxing-token';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];
let log = '';

async function waitFor(fn, what, tries = 150) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

/**
 * The state file this board wrote, found the way `core/auth-token.ts` looks for one.
 *
 * The board is started with every home-shaped variable pointed at this check's own directory,
 * so the token and the device registry land inside it rather than beside the operator's.
 */
const stateFile = (name) => {
  // The same arithmetic `check-pairing-handshake.mjs:90` does, and for the same reason: on
  // Windows `LOCALAPPDATA` *is* the `AppData\Local` part, so a fake home stands in for it whole.
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  const dir = join(home, leaf);
  try { return { dir, body: readFileSync(join(dir, name), 'utf-8').trim() }; }
  catch { return null; }
};

/** A board of this check's own, with the token gate on — `NO_AUTH` undefined is load-bearing. */
async function startBoard() {
  const port = await freePort();
  const server = startCanvas({
    port,
    env: {
      HOST: '127.0.0.1',
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      EXCALIDRAW_NO_AUTH: undefined,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
    },
  });
  children.push(server.child);
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'the canvas server');
  const held = await waitFor(async () => stateFile(`server-${port}.token`), 'the token file');
  return { port, base: `http://127.0.0.1:${port}`, token: held.body, stateDir: held.dir };
}

/**
 * One request, with the path sent **raw**.
 *
 * `fetch` normalises a URL before it goes out — `/api/../API/elements` becomes `/API/elements`
 * on the wire, which is still the case this is about, but `//api/…` and a `.` segment would be
 * rewritten into something the check did not mean to send. The traversal row is therefore about
 * what the *client* resolves it to, which is the shape a browser or a library would produce, and
 * that is the shape worth defending against.
 */
async function ask(board, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers[TOKEN_HEADER] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${board.base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* not json, which is an answer too */ }
  return { status: response.status, payload };
}

/** Whether an answer is the gate refusing, rather than a handler having run. */
const refused = (answer) => answer.status === 401 || answer.status === 403 || answer.status === 404;

try {
  const board = await startBoard();

  console.log('\n1. the gate is there at all, and the token opens it');

  const bare = await ask(board, '/api/elements?workspace=default');
  check('an unauthenticated /api/elements is refused', bare.status === 401, String(bare.status));
  const withToken = await ask(board, '/api/elements?workspace=default', { token: board.token });
  check('and the same path with the token is served', withToken.status === 200, String(withToken.status));

  console.log('\n2. no spelling of the same path walks past it');

  // Every one of these reached a handler before this landed, except the two controls.
  const spellings = [
    { path: '/API/elements?workspace=default', why: 'upper' },
    { path: '/Api/elements?workspace=default', why: 'mixed' },
    { path: '/aPi/elements?workspace=default', why: 'mixed, other way' },
    { path: '/API/workspaces', why: 'a different route, same trick' },
    { path: '/api/../API/elements?workspace=default', why: 'traversal, as a client resolves it' },
    { path: '/api/elements/?workspace=default', why: 'trailing slash' },
    { path: '/API/elements/?workspace=default', why: 'both at once' },
  ];
  for (const spelling of spellings) {
    const answer = await ask(board, spelling.path);
    check(`refused: ${spelling.path.split('?')[0]} (${spelling.why})`,
      refused(answer), `${answer.status} ${JSON.stringify(answer.payload).slice(0, 90)}`);
  }

  // The control. `req.path` is not decoded and the router matches on the raw pathname, so these
  // two agree already; if this ever starts being served, something began decoding.
  const encoded = await ask(board, '/%41PI/elements?workspace=default');
  check('percent-encoding reaches no route at all, as it did before', refused(encoded), String(encoded.status));

  console.log('\n3. and a local process cannot mint itself a device credential');

  // The bootstrap stays open, because a device that holds no credential has to be able to ask
  // for one. The caller below is therefore not sneaking in here — it is using the front door
  // exactly as intended, and then trying to escalate. That is what makes the rest of this
  // section the exploit rather than a probe.
  const asked = await ask(board, '/api/pair/request', { method: 'POST', body: { name: 'a stranger' } });
  check('asking to pair is open without a credential, as it must be', asked.status === 200,
    `${asked.status} ${JSON.stringify(asked.payload).slice(0, 120)}`);
  const requestId = asked.payload?.request?.requestId ?? asked.payload?.requestId ?? null;
  check('and it answered with a request id', Boolean(requestId), JSON.stringify(asked.payload).slice(0, 160));

  // Open by design does not mean open in every spelling. With the router case-sensitive there
  // is exactly one path that reaches this route, and that is the point: the exception the gate
  // makes for the bootstrap is an exception for *a path*, and a second spelling of that path
  // would be a second exception nobody wrote down. A 404 here is the right answer.
  const misAsked = await ask(board, '/API/pair/request', { method: 'POST', body: { name: 'a stranger' } });
  check('but only in the spelling this server declares', refused(misAsked),
    `${misAsked.status} ${JSON.stringify(misAsked.payload).slice(0, 120)}`);

  // The pending list is the operator's, and it carries the code. That is correct for a list
  // only the host can read, and it is the whole chain when the host test can be walked past:
  // the code is what `approve` demands, so a caller who can read this can satisfy it.
  const pending = await ask(board, '/API/pair/pending');
  check('the pending list is not readable without the board token',
    refused(pending), `${pending.status} ${JSON.stringify(pending.payload).slice(0, 120)}`);

  /**
   * The whole exploit, end to end, rather than one step of it.
   *
   * Asking to pair is open by design and approving demands the code — so a check that only
   * tried `approve` with no code got a 409 about the code and would have called that a
   * refusal. It is not one: the code is printed in the pending list, the pending list is
   * behind the same gate as everything else, and this caller is on loopback, which is the
   * only other thing `approve` asks about. So it reads its own code and answers the question.
   *
   * A device in the registry at the end of this is a persisted, restart-surviving credential
   * that a process on this machine minted for itself without ever reading the token file.
   */
  const leaked = (pending.payload?.requests ?? []).find((one) => one.requestId === requestId);
  const approved = await ask(board, '/API/pair/approve', {
    method: 'POST',
    body: { requestId, code: leaked?.code },
  });
  check('approving is refused even with the code the list would have leaked',
    refused(approved), `${approved.status} ${JSON.stringify(approved.payload).slice(0, 120)}`);

  // The durable half, and the one that outlives the process: nothing may have been written to
  // the registry the operator revokes from.
  const registry = stateFile('devices.json');
  const devices = registry ? (JSON.parse(registry.body).devices ?? []) : [];
  check('and no device was minted', devices.length === 0,
    JSON.stringify(devices.map((one) => one.name ?? one.id)));

  console.log('\n4. the page still loads, which strict routing could have taken');

  const root = await fetch(`${board.base}/`);
  check('GET / is still served', root.status === 200, String(root.status));
  const health = await fetch(`${board.base}/health`);
  check('and /health is still open', health.status === 200, String(health.status));
} catch (error) {
  failures++;
  console.error(`  FAIL  the run completed — ${error?.message ?? error}`);
} finally {
  for (const child of children) { try { child.kill(); } catch { /* going anyway */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds it */ }
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
