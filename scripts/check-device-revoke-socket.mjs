#!/usr/bin/env node
/**
 * Checks that revoking a device closes the socket it is holding, not merely its next request.
 *
 * This is the half of a revocation that a person cannot see, and it is the half that is still
 * sending. The upgrade streams `initial_elements` on connect and then every scene change and
 * every live shell's scrollback for as long as it stays open — so a revocation that only made
 * the *next HTTP request* answer 401 would take a device off the list, show it gone on the
 * management surface, and go on publishing the board and every terminal to it until somebody
 * restarted the server. An operator who pressed Revoke because a laptop was sold would have no
 * way of knowing, and nothing about the surface would look wrong.
 *
 * Four cases, and the third and fourth are what make the first two mean something:
 *
 *   - the socket a paired device holds is **closed**, promptly, and with a code that says why;
 *   - a **new** upgrade carrying the revoked secret is refused, so the device cannot simply
 *     reconnect into the state it was just taken out of;
 *   - the **operator's own socket survives** — a revocation that closed every socket on the
 *     board would pass the first case for the wrong reason, and would log the operator out of
 *     their own board every time they tidied the list;
 *   - and a **second device's socket survives**, which is the same trap one door along.
 *
 * The board runs with the token on and a throwaway `HOME`, like `check-device-management.mjs`,
 * and the registry is seeded on disk because there is no pairing exchange yet (#503).
 *
 * Self-contained: a canvas server on a port the kernel just handed out, killed at the end. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-device-revoke-socket.mjs
 *
 * Tier: fast
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const TOKEN_HEADER = 'x-vibemaxxing-token';

const workDir = mkdtempSync(join(tmpdir(), 'check-device-revoke-socket-'));
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

/** Where this board keeps its runtime state, spelled out from the platform rather than imported. */
function stateDir() {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf);
}

const registryFile = join(stateDir(), 'devices.json');

function device(id, name) {
  const secret = randomBytes(32).toString('hex');
  return {
    // `<id>.<secret>`, which is `core/device-registry.ts`'s own spelling of a credential: one
    // opaque string, because a WebSocket handshake has room for exactly one query parameter.
    secret: `${id}.${secret}`,
    record: {
      id,
      name,
      secretHash: createHash('sha256').update(secret).digest('hex'),
      createdAt: '2026-07-01T10:00:00.000Z',
      lastSeenAt: '2026-07-01T10:00:00.000Z',
      approvedFrom: '192.168.1.44',
      host: 'board.lan:3737',
    },
  };
}

const sold = device('dev-sold-laptop', 'The laptop that was sold');
const kept = device('dev-kept-phone', 'The phone still in use');

const children = [];
const sockets = [];
let log = '';

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

/**
 * A socket, with everything that happened to it recorded on the object.
 *
 * `closed` rather than a promise, because two of the four cases assert that a socket is *still
 * open* some time later — which is a state to read, not an event to await.
 */
function open(url, secret) {
  const socket = new WebSocket(url, { headers: { [TOKEN_HEADER]: secret } });
  sockets.push(socket);
  const state = { socket, opened: false, closed: false, code: null, reason: '', refused: null, messages: [] };
  socket.on('open', () => { state.opened = true; });
  socket.on('message', (raw) => {
    try { state.messages.push(JSON.parse(raw.toString())?.type); } catch { /* not ours */ }
  });
  socket.on('close', (code, reason) => {
    state.closed = true;
    state.code = code;
    state.reason = reason?.toString() ?? '';
  });
  socket.on('unexpected-response', (_request, response) => { state.refused = response.statusCode; });
  socket.on('error', () => { /* a refused upgrade errors too; `refused` is what is read */ });
  return state;
}

try {
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, JSON.stringify({ version: 1, devices: [sold.record, kept.record] }, null, 2), 'utf8');

  const server = startCanvas({
    port: await freePort(),
    env: {
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
  await waitFor(async () => (await fetch(`${server.base}/health`)).ok, 'the canvas server');

  const tokenFile = join(stateDir(), `server-${server.port}.token`);
  const hostToken = await waitFor(
    () => (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null),
    'the board to write its token',
  );
  const wsBase = server.base.replace(/^http/, 'ws');

  // ─── 1. Three sockets, all of them streaming the board ──────

  console.log('1. a paired device opens a socket and is sent the board on it');
  const soldSocket = open(`${wsBase}/?workspace=default`, sold.secret);
  const keptSocket = open(`${wsBase}/?workspace=default`, kept.secret);
  const hostSocket = open(`${wsBase}/?workspace=default`, hostToken);

  await waitFor(() => soldSocket.opened && keptSocket.opened && hostSocket.opened,
                'three sockets to open');
  check('a device secret opens the upgrade, as the board token does', soldSocket.opened);
  check('and the scene is sent over it the moment it opens',
        await waitFor(() => soldSocket.messages.includes('initial_elements'),
                      'the scene on the device socket'));
  check('the operator\'s own socket is open too', hostSocket.opened);
  check('and a second device\'s', keptSocket.opened);

  // ─── 2. Revoked, and the socket goes with it ────────────────

  console.log('\n2. revoking the device closes what it is holding open');
  const revoked = await fetch(`${server.base}/api/devices/${sold.record.id}`, {
    method: 'DELETE',
    headers: { [TOKEN_HEADER]: hostToken },
  });
  const answer = await revoked.json().catch(() => ({}));
  check('DELETE /api/devices/:id from the host answers 200', revoked.status === 200,
        `got ${revoked.status} ${JSON.stringify(answer).slice(0, 200)}`);
  check('and says how many sockets it disconnected', answer?.socketsClosed === 1,
        JSON.stringify(answer?.socketsClosed));

  await waitFor(() => soldSocket.closed, 'the revoked device\'s socket to close', 40);
  check('the revoked device\'s socket is closed rather than left streaming', soldSocket.closed);
  check('with a code that is not a normal end of conversation', soldSocket.code === 4003,
        String(soldSocket.code));
  check('and a reason the other end can read', /revoked/i.test(soldSocket.reason),
        JSON.stringify(soldSocket.reason));

  // ─── 3. The sockets that had nothing to do with it ──────────

  console.log('\n3. and only that one — this is a revocation, not a disconnect-everybody');
  await sleep(600);
  check('the operator\'s own socket is untouched', !hostSocket.closed,
        `closed with ${hostSocket.code}`);
  check('and so is the other device\'s', !keptSocket.closed, `closed with ${keptSocket.code}`);

  // The board is still a board on the sockets that survived: a scene change reaches them.
  await fetch(`${server.base}/api/elements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: hostToken },
    body: JSON.stringify({ type: 'rectangle', x: 10, y: 10, width: 20, height: 20 }),
  });
  check('a scene change still reaches the device that was kept',
        await waitFor(() => keptSocket.messages.includes('element_created'),
                      'the kept device to be sent the new element', 40));

  // ─── 4. And it cannot simply come back ──────────────────────

  console.log('\n4. the revoked secret cannot open a new socket either');
  const again = open(`${wsBase}/?workspace=default`, sold.secret);
  await waitFor(() => again.refused !== null || again.opened, 'the second upgrade to be decided', 40);
  check('a fresh upgrade carrying the revoked secret is refused', !again.opened,
        'it opened');
  check('and refused with 401 rather than dropped', again.refused === 401, String(again.refused));

  const stillIn = open(`${wsBase}/?workspace=default`, kept.secret);
  await waitFor(() => stillIn.opened || stillIn.refused !== null, 'the kept device to reconnect', 40);
  check('while the device that was kept can still open one', stillIn.opened, String(stillIn.refused));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const socket of sockets) { try { socket.close(); } catch { /* gone */ } }
  await sleep(200);
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
}

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
