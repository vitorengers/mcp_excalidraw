#!/usr/bin/env node
/**
 * Checks the surface that answers "who can reach my board" — the list, the rename, the revoke.
 *
 * A board that can be paired with a second machine needs the other half or it is a one-time
 * unlock: once there is a second device there is a third, and a laptop that was sold, and a
 * phone paired at an airport that should not still be on the list. What that needs is a list
 * with a name a person can edit — the registry holds whatever the device proposed for itself,
 * and `MacBook-Pro-3` is not what its owner calls it — a `last seen` that tells a device in use
 * from one nobody has opened in months, the address and `Host` it was approved for, and a
 * revoke that takes effect on the device's **next request** rather than at the next restart.
 *
 * Four things here are load-bearing and none of them is the happy path:
 *
 *  - **the hashes never leave the server.** A management page that carried every device's
 *    verifier would put the whole registry through a browser to draw a list, and the registry's
 *    whole difference from the token file is that it stores no secret anybody can use.
 *  - **who may ask.** The host is the operator holding the board token, which is a file only
 *    this account can read, and the host is not on the list. A paired device may see the list —
 *    a device that cannot see the list cannot see that it is on one — may rename nothing, and
 *    may revoke exactly itself. Revoking the device you are reading this on is allowed and is
 *    not special-cased into a refusal: it is "sign this machine out", which is legitimate.
 *  - **the next request, not the next restart.** Every verification reads the file, so a
 *    revoked device is refused by the same gate that let it in a moment earlier.
 *  - **a hand-edited file is no devices, never a throw.** This file is exactly the shape of
 *    thing a person opens in an editor to see who is on the list, and a board that will not
 *    start because they did is a worse failure than one that asks to pair again.
 *
 * The socket half is `check-device-revoke-socket.mjs`, and it is separate because it is the
 * half a person cannot see: an HTTP-only revocation leaves the scene and every live shell's
 * scrollback flowing over an upgrade accepted before the device was removed.
 *
 * The board runs with the token **on** — `EXCALIDRAW_NO_AUTH: undefined`, which every other
 * check in this directory is behind — because a board with no authentication has no way to be
 * anything less than the operator, and the distinction between the host and a device is the
 * whole subject here. It is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/
 * `XDG_STATE_HOME`, so the registry lands in this check's own temporary directory and the
 * operator's real state directory is never read or written.
 *
 * There is no pairing exchange yet (#503), so the registry is seeded on disk — which is also
 * the honest test of the contract, since the file is the whole of what this module reads.
 *
 * Self-contained: a canvas server on a port the kernel just handed out, killed at the end. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-paired-devices.mjs
 *
 * Tier: fast
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The one header name the server, the page and this check all have to agree on. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

const workDir = mkdtempSync(join(tmpdir(), 'check-paired-devices-'));
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

/**
 * Where this board keeps its runtime state, spelled out from the platform.
 *
 * The three answers `stateDir()` gives, written out rather than imported on purpose: a check
 * that asks the code under test where it put a file agrees with any answer it gives.
 */
function stateDir() {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf);
}

const registryFile = join(stateDir(), 'paired-devices.json');

const hashOf = (secret) => createHash('sha256').update(secret).digest('hex');

/** A device record as the registry stores one, with the secret the check keeps to itself. */
function device(name, { approvedFrom, host, createdAt, lastSeenAt }) {
  const secret = randomBytes(32).toString('hex');
  return {
    secret,
    record: {
      id: `dev-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name,
      secretHash: hashOf(secret),
      createdAt,
      lastSeenAt,
      approvedFrom,
      host,
    },
  };
}

const laptop = device('MacBook-Pro-3', {
  approvedFrom: '192.168.1.44',
  host: 'board.lan:3737',
  createdAt: '2026-06-01T09:00:00.000Z',
  lastSeenAt: '2026-08-01T18:30:00.000Z',
});
const phone = device('Pixel-9', {
  approvedFrom: '192.168.1.91',
  host: 'board.lan:3737',
  createdAt: '2026-03-14T21:00:00.000Z',
  lastSeenAt: '2026-03-14T21:04:00.000Z',
});

function seedRegistry(records) {
  mkdirSync(dirname(registryFile), { recursive: true });
  writeFileSync(registryFile, JSON.stringify(records, null, 2), 'utf8');
}

function onDisk() {
  try { return JSON.parse(readFileSync(registryFile, 'utf8')); } catch { return null; }
}

const children = [];
let log = '';

async function waitFor(fn, what, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

let board = null;

async function startBoard() {
  const server = startCanvas({
    port: await freePort(),
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      // The point of this file: every other check runs behind the opt-out, and a board with no
      // authentication cannot tell the host from a device because there is nothing to tell them
      // apart by.
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
  return server;
}

/** A request carrying whatever credential is named, or none at all. */
async function call(path, { secret = null, ...init } = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (secret) headers[TOKEN_HEADER] = secret;
  const response = await fetch(`${board.base}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, body };
}

try {
  seedRegistry([laptop.record, phone.record]);
  board = await startBoard();

  const tokenFile = join(stateDir(), `server-${board.port}.token`);
  const hostToken = await waitFor(
    () => (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : null),
    'the board to write its token',
  );

  // ─── 1. The list, and what is in it ─────────────────────────

  console.log('1. the list says what a person needs to judge a device by');
  const listed = await call('/api/devices', { secret: hostToken });
  check('GET /api/devices from the host answers 200', listed.status === 200, `got ${listed.status}`);
  const devices = listed.body?.devices ?? [];
  check('it lists both seeded devices', devices.length === 2, JSON.stringify(devices).slice(0, 200));

  const shown = devices.find((entry) => entry.id === laptop.record.id) ?? {};
  check('a device is listed under the name the registry holds', shown.name === 'MacBook-Pro-3',
        JSON.stringify(shown.name));
  check('with when it was approved', shown.createdAt === laptop.record.createdAt,
        JSON.stringify(shown.createdAt));
  check('and when it was last seen, which is what tells in use from forgotten',
        typeof shown.lastSeenAt === 'string' && shown.lastSeenAt.length > 0,
        JSON.stringify(shown.lastSeenAt));
  check('the address it was approved from, verbatim', shown.approvedFrom === '192.168.1.44',
        JSON.stringify(shown.approvedFrom));
  check('and the Host it was approved for', shown.host === 'board.lan:3737',
        JSON.stringify(shown.host));

  check('no device\'s hash is in the payload', !('secretHash' in shown),
        JSON.stringify(Object.keys(shown)));
  check('and no hash appears anywhere in the answer at all',
        !listed.text.includes(laptop.record.secretHash) && !listed.text.includes(phone.record.secretHash));
  check('nor, obviously, any secret', !listed.text.includes(laptop.secret));

  // ─── 2. Who may ask ─────────────────────────────────────────

  console.log('\n2. the list is the host\'s and a paired device\'s, and nobody else\'s');
  const stranger = await call('/api/devices');
  check('a caller with no credential is refused', stranger.status === 401, `got ${stranger.status}`);
  check('and told nothing about who is on the list',
        !stranger.text.includes('MacBook-Pro-3') && !stranger.text.includes('Pixel-9'),
        stranger.text.slice(0, 200));

  const guessed = await call('/api/devices', { secret: randomBytes(32).toString('hex') });
  check('a secret of the right shape and the wrong value is refused too', guessed.status === 401,
        `got ${guessed.status}`);

  const byDevice = await call('/api/devices', { secret: laptop.secret });
  check('a paired device may see the list', byDevice.status === 200, `got ${byDevice.status}`);
  check('and is told which entry is itself, so it can offer to sign itself out',
        byDevice.body?.self === laptop.record.id, JSON.stringify(byDevice.body?.self));
  check('the host is told it is on no entry, because the host is not a device',
        listed.body?.self === null, JSON.stringify(listed.body?.self));

  // A device that has just made a request has been seen now, not in June.
  const seenAgain = await call('/api/devices', { secret: hostToken });
  const touched = (seenAgain.body?.devices ?? []).find((entry) => entry.id === laptop.record.id);
  check('a request from a device moves its last seen forward',
        Date.parse(touched?.lastSeenAt ?? 0) > Date.parse(laptop.record.lastSeenAt),
        `${laptop.record.lastSeenAt} -> ${touched?.lastSeenAt}`);
  check('and the one that made no request is untouched',
        (seenAgain.body?.devices ?? []).find((entry) => entry.id === phone.record.id)?.lastSeenAt
          === phone.record.lastSeenAt);

  // ─── 3. The rename ──────────────────────────────────────────

  console.log('\n3. the name is the operator\'s word for a machine, so the host edits it');
  const renamed = await call(`/api/devices/${laptop.record.id}`, {
    method: 'PATCH',
    secret: hostToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: "Ana's laptop" }),
  });
  check('PATCH from the host answers 200', renamed.status === 200,
        `got ${renamed.status} ${renamed.text.slice(0, 200)}`);
  check('and answers with the device under its new name', renamed.body?.device?.name === "Ana's laptop",
        JSON.stringify(renamed.body?.device?.name));
  check('which is what the registry on disk now says',
        (onDisk() ?? []).find((entry) => entry.id === laptop.record.id)?.name === "Ana's laptop",
        JSON.stringify((onDisk() ?? []).map((entry) => entry.name)));
  check('and the rename kept the secret, so the device is still the same device',
        (onDisk() ?? []).find((entry) => entry.id === laptop.record.id)?.secretHash
          === laptop.record.secretHash);

  const blank = await call(`/api/devices/${laptop.record.id}`, {
    method: 'PATCH',
    secret: hostToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '   ' }),
  });
  check('a rename to nothing is refused rather than leaving a nameless row', blank.status === 400,
        `got ${blank.status}`);

  const nowhere = await call('/api/devices/no-such-device', {
    method: 'PATCH',
    secret: hostToken,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Ghost' }),
  });
  check('renaming a device that is not there is 404', nowhere.status === 404, `got ${nowhere.status}`);

  const byNeighbour = await call(`/api/devices/${phone.record.id}`, {
    method: 'PATCH',
    secret: laptop.secret,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Not yours' }),
  });
  check('a paired device may not rename another device', byNeighbour.status === 403,
        `got ${byNeighbour.status}`);
  check('and the name it tried to write is not on disk',
        (onDisk() ?? []).find((entry) => entry.id === phone.record.id)?.name === 'Pixel-9');

  // ─── 4. The revoke, and when it takes effect ────────────────

  console.log('\n4. a revoked device is refused on its next request, not at the next restart');
  const stillIn = await call('/api/devices', { secret: phone.secret });
  check('the phone can reach the board before it is revoked', stillIn.status === 200,
        `got ${stillIn.status}`);

  const revoked = await call(`/api/devices/${phone.record.id}`, {
    method: 'DELETE',
    secret: hostToken,
  });
  check('DELETE from the host answers 200', revoked.status === 200,
        `got ${revoked.status} ${revoked.text.slice(0, 200)}`);
  check('and names the device it removed', revoked.body?.device?.name === 'Pixel-9',
        JSON.stringify(revoked.body?.device?.name));

  const after = await call('/api/devices', { secret: phone.secret });
  check('the phone\'s very next request is refused — no restart in between', after.status === 401,
        `got ${after.status}`);
  check('the laptop is unaffected', (await call('/api/devices', { secret: laptop.secret })).status === 200);
  check('and the registry on disk no longer holds it',
        (onDisk() ?? []).every((entry) => entry.id !== phone.record.id),
        JSON.stringify((onDisk() ?? []).map((entry) => entry.id)));

  const gone = await call(`/api/devices/${phone.record.id}`, { method: 'DELETE', secret: hostToken });
  check('revoking it again is 404 rather than a second success', gone.status === 404,
        `got ${gone.status}`);

  // ─── 5. A device signing itself out ─────────────────────────

  console.log('\n5. revoking the device you are reading this on is allowed, not special-cased');
  const tablet = device('iPad-2', {
    approvedFrom: '192.168.1.7',
    host: 'board.lan:3737',
    createdAt: '2026-07-20T12:00:00.000Z',
    lastSeenAt: '2026-07-20T12:00:00.000Z',
  });
  seedRegistry([{ ...laptop.record, name: "Ana's laptop" }, tablet.record]);

  const neighbour = await call(`/api/devices/${laptop.record.id}`, {
    method: 'DELETE',
    secret: tablet.secret,
  });
  check('a paired device may not revoke a different device', neighbour.status === 403,
        `got ${neighbour.status}`);
  check('and that device is still on the list',
        (onDisk() ?? []).some((entry) => entry.id === laptop.record.id));

  const signedOut = await call(`/api/devices/${tablet.record.id}`, {
    method: 'DELETE',
    secret: tablet.secret,
  });
  check('but it may sign itself out', signedOut.status === 200,
        `got ${signedOut.status} ${signedOut.text.slice(0, 200)}`);
  check('and is told that the device removed was itself', signedOut.body?.self === true,
        JSON.stringify(signedOut.body?.self));
  check('after which its next request is refused like anybody else\'s',
        (await call('/api/devices', { secret: tablet.secret })).status === 401);

  const hostStillIn = await call('/api/devices', { secret: hostToken });
  check('the operator cannot be locked out this way — the host is not on the list',
        hostStillIn.status === 200, `got ${hostStillIn.status}`);

  // ─── 6. The file itself ─────────────────────────────────────

  console.log('\n6. the registry is this account\'s, and a hand-edited one is not a dead board');
  check('the registry is where the pidfile and the token are', existsSync(registryFile), registryFile);
  if (process.platform === 'win32') {
    // Windows has no POSIX mode bits: `statSync().mode` reports a synthesised value whatever the
    // ACL says, so an assertion here would be about Node's fiction. What protects it there is the
    // ACL on `%LOCALAPPDATA%`, and the POSIX case below runs on every other platform this ships to.
    console.log('  ..    the mode case is POSIX-only; this platform has no mode bits to read');
  } else {
    const mode = statSync(registryFile).mode & 0o777;
    check('its permissions deny group and other', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
    check('and grant the owner read and write', (mode & 0o600) === 0o600, `mode ${mode.toString(8)}`);
  }

  writeFileSync(registryFile, '{ this is what an editor leaves behind', 'utf8');
  const mangled = await call('/api/devices', { secret: hostToken });
  check('a registry nobody can parse reads as no devices rather than throwing',
        mangled.status === 200 && Array.isArray(mangled.body?.devices) && mangled.body.devices.length === 0,
        `got ${mangled.status} ${mangled.text.slice(0, 200)}`);
  const boardStillUp = await call('/api/elements', { secret: hostToken });
  check('and the rest of the board is still answering', boardStillUp.status === 200,
        `got ${boardStillUp.status}`);

  writeFileSync(registryFile, JSON.stringify({ devices: 'not a list' }), 'utf8');
  const wrongShape = await call('/api/devices', { secret: hostToken });
  check('a file of the wrong shape reads as no devices too',
        wrongShape.status === 200 && wrongShape.body?.devices?.length === 0,
        `got ${wrongShape.status} ${wrongShape.text.slice(0, 200)}`);
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  for (const child of children) { try { child.kill(); } catch { /* already gone */ } }
  await sleep(400);
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* leave it */ }
}

if (failures) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nall cases passed');
