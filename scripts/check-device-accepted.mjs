#!/usr/bin/env node
/**
 * Checks that the credential a pairing mints is one this board actually accepts, from the only
 * place it is ever used: another machine.
 *
 * `check-device-registry.mjs` holds the module that mints and verifies one, and
 * `check-device-management.mjs` holds the three routes built on it — both from loopback, where
 * a device credential is a second way for the operator to be the operator. This one holds the
 * thing neither can ask: a caller whose socket did **not** come from this machine, carrying a
 * credential, being served. Until that is true the whole registry is decorative — a device can
 * complete the entire gesture, hold a secret nothing refuses, and reach nothing at all.
 *
 * Three gates stand between an approved device and the board, and a credential that satisfies
 * two of them is worth exactly as much as one that satisfies none:
 *
 *  - **the funnel** (`offLoopback`) asks who is calling. Since #501 it refuses every caller that
 *    is not on this machine, whatever they carry — a board token included — so a device with a
 *    perfect credential got 403 from it on every route.
 *  - **the token gate** asks what the caller carries. A device cannot read `server-<port>.token`
 *    off a filesystem it is not on, so its own credential has to be a second accepted secret
 *    there.
 *  - **the origin gate** asks what authority the caller named. It is built from `HOST`, `PORT`
 *    and `ALLOWED_HOSTS` and memoised on the first request, so approving a device and this board
 *    answering for the name that device reaches it under were on different lifetimes: the
 *    approval landed, and the memo built minutes earlier still refused the name.
 *
 * All three are asked here, and separately, because a check that only ever sent a good
 * credential could not tell a board that consults it from a board that stopped asking.
 *
 * **The discriminator is a revoke between two otherwise identical calls.** The same request,
 * the same address, the same header, on either side of one `DELETE /api/devices/:id`: 200 and
 * then 401. No misconfiguration produces that pair, and neither does a board that waves
 * everybody through.
 *
 * **Load-bearing, and not the happy path:**
 *
 *  - `EXCALIDRAW_NO_AUTH: undefined`. `scripts/lib/spawn-canvas.mjs` sets it for every check in
 *    this directory, and behind it there is no gate for a credential to be accepted *by* — every
 *    assertion about a refused one would pass while the board refused nothing.
 *  - The device is paired through the real `/api/pair/*` routes rather than seeded onto disk, so
 *    the `host` its record carries is the one it genuinely arrived under, and the origin-gate
 *    case is about a name a person approved rather than a string this file wrote.
 *  - The board is bound to `0.0.0.0` and reached **two ways at once**: at `127.0.0.1`, where the
 *    caller is the host and holds the board token, and at this machine's own interface address,
 *    where the socket the server sees is genuinely remote. That is what makes the capability
 *    cases mean something — the same board, at the same moment, offers the queue and the
 *    terminal to the device and withholds both from the operator on loopback, because the bind
 *    is what that question is about and the bind has not changed.
 *  - The management surface is asked from the device on purpose. Widening the funnel must not
 *    quietly widen `GET|PATCH|DELETE /api/devices` with it: those stay the host's.
 *
 * Self-contained: one canvas server on a port the kernel just handed out, a throwaway `HOME`,
 * and both are gone at the end. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-device-accepted.mjs
 *
 * Tier: fast
 */

import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The one header name the server, the page and this check all have to agree on. */
const TOKEN_HEADER = 'x-vibemaxxing-token';

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-device-accepted-'));
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

/** Not a failure: the one machine shape on which none of this can be asked. See below. */
class Skip extends Error {}

/** The address a second machine would reach this one on, or null when there is no such address. */
function externalAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

let log = '';
let server = null;

async function waitFor(fn, what, tries = 150) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}\n${log}`);
}

/**
 * The same wait, bounded and never thrown.
 *
 * A `waitFor` inside a case is a case that takes the rest of the file down with it when the
 * thing never happens: one failure is printed and every assertion after it is unevidenced,
 * which is exactly the shape that makes a red run unreadable. This one answers false instead.
 */
async function settles(fn, tries = 50) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { if (await fn()) return true; } catch { /* not yet */ }
    await sleep(100);
  }
  return false;
}

/**
 * One request, over `node:http` rather than `fetch`, and reaching a chosen address.
 *
 * `fetch` will not send a `Host` it was given and offers no say over which address it connects
 * from — and both are the whole subject here: which socket the server sees, and which authority
 * the caller named.
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

/** An upgrade attempt, and what became of it: opened, refused with a status, or closed. */
function upgrade(at, query) {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://${at.address}:${at.port}/${query}`);
    const record = {
      opened: false, refused: null, closed: false, code: null, reason: '', messages: [], socket,
    };
    socket.on('open', () => { record.opened = true; resolve(record); });
    socket.on('message', (data) => { record.messages.push(data.toString()); });
    socket.on('unexpected-response', (_request, response) => {
      record.refused = response.statusCode;
      resolve(record);
    });
    socket.on('error', () => { if (!record.opened) resolve(record); });
    socket.on('close', (code, reason) => {
      record.closed = true;
      record.code = code;
      record.reason = reason?.toString() ?? '';
      resolve(record);
    });
  });
}

const external = externalAddress();

// Loud rather than silent: every case below is about a socket that did not come from this
// machine, and `127.0.0.2` is inside `127.0.0.0/8` and is therefore *on* it. There is no
// second-best address to fall back to here.
if (!external) {
  console.log('  ..    this machine has no non-loopback IPv4 address, so no genuinely remote');
  console.log('        caller can be made here — every case below needs one, and is skipped');
}

try {
  if (!external) throw new Skip();

  const port = await freePort();
  server = startCanvas({
    port,
    env: {
      // Every interface, so the same board is the host's on loopback and a second machine's on
      // the network at the same moment. Nothing leaves this machine: the interface address is
      // this machine's own, and connecting to it is what makes the socket a remote one.
      HOST: '0.0.0.0',
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      // The gate this whole file is about. See the note at the top.
      EXCALIDRAW_NO_AUTH: undefined,
      // Deliberately unset: the authority the device reaches this board under has to come from
      // the approval, and an allowed host here would be the answer written down in advance.
      EXCALIDRAW_ALLOWED_HOSTS: undefined,
      EXCALIDRAW_TERMINAL: '1',
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
  const device = { address: external, port };
  const deviceAuthority = `${external}:${port}`;

  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/health`)).ok, 'the canvas server');
  const boardToken = readFileSync(conventionalStateFile(`server-${port}.token`), 'utf-8').trim();
  const asHost = { [TOKEN_HEADER]: boardToken };

  // ─── 1. The gesture, made from a second machine's address ───

  console.log('\n1. a device asks from off this machine, and the operator approves from on it');

  // Made before anything else asks a question about authorities, so that the memo the origin
  // gate keeps is built here — without this device in it — and has to be rebuilt to admit it.
  const memoBuilt = await call(host, '/health');
  check('the board is answering, so the authority memo is built before the approval',
        memoBuilt.status === 200, `got ${memoBuilt.status}`);

  const asked = await call(device, '/api/pair/request', {
    method: 'POST',
    body: { name: 'a laptop across the desk' },
  });
  check('a device with no credential may ask, from an address that is not this machine',
        asked.status === 200, `${asked.status} ${asked.text.slice(0, 200)}`);

  const pending = await call(host, '/api/pair/pending', { headers: asHost });
  const waiting = pending.body?.requests?.find((entry) => entry.requestId === asked.body?.requestId);
  check('the operator sees it waiting, under the authority it arrived as',
        waiting?.host === deviceAuthority, JSON.stringify(waiting ?? null));

  const approved = await call(host, '/api/pair/approve', {
    method: 'POST',
    headers: asHost,
    body: { requestId: asked.body?.requestId, code: asked.body?.code },
  });
  check('the operator approves it from this machine', approved.status === 200,
        `${approved.status} ${approved.text.slice(0, 200)}`);

  const collected = await call(device, `/api/pair/status?requestId=${asked.body?.requestId}`);
  const credential = collected.body?.credential ?? '';
  check('and the device collects the one copy of its secret there will ever be',
        typeof credential === 'string' && credential.includes('.'),
        `${collected.status} ${collected.text.slice(0, 200)}`);
  const asDevice = { [TOKEN_HEADER]: credential };
  const deviceId = credential.split('.')[0];

  // ─── 2. The funnel, the token gate, and the origin gate ─────

  console.log('\n2. a foreign caller carrying that credential is served, and one without is not');

  const served = await call(device, '/api/elements', { headers: asDevice });
  check('the board is read by a caller that is not on this machine, because of what it carries',
        served.status === 200, `${served.status} ${served.text.slice(0, 200)}`);

  const admitted = await call(device, '/api/pair/admission', { headers: asDevice });
  check('and the page\'s own question answers admitted rather than a refusal to interpret',
        admitted.status === 200 && admitted.body?.admitted === true,
        `${admitted.status} ${admitted.text.slice(0, 200)}`);

  const bare = await call(device, '/api/elements');
  check('the same call carrying nothing is refused', bare.status === 401, `got ${bare.status}`);

  const guessed = await call(device, '/api/elements', {
    headers: { [TOKEN_HEADER]: `${deviceId}.${'f'.repeat(64)}` },
  });
  check('and so is a credential of the right shape and the wrong secret', guessed.status === 401,
        `got ${guessed.status}`);
  check('the refusal names the credential rather than the bind',
        /token|credential/i.test(guessed.body?.error ?? '')
        && !/loopback|bound/i.test(guessed.body?.error ?? ''),
        guessed.body?.error ?? guessed.text.slice(0, 200));

  // The funnel on its own, with the token gate satisfied: the board's own secret is the
  // operator's, and holding it does not make a caller on the network the operator.
  const stolenToken = await call(device, '/api/elements', { headers: asHost });
  check('the board token is not a device, so carrying it off this machine reaches nothing',
        stolenToken.status === 403, `${stolenToken.status} ${stolenToken.text.slice(0, 200)}`);
  check('and that refusal names the credential too, rather than where the server bound',
        /device/i.test(stolenToken.body?.error ?? ''),
        stolenToken.body?.error ?? stolenToken.text.slice(0, 200));

  const fromHost = await call(host, '/api/elements', { headers: asHost });
  check('while the operator on this machine reads the board as they always did',
        fromHost.status === 200, `got ${fromHost.status}`);

  // ─── 3. The authority the device was approved for ───────────

  console.log('\n3. the name that device reaches this board under is one this board answers for');

  check('a request naming it is not refused by the origin gate, though the memo predates it',
        served.status !== 403, `${served.status} ${served.text.slice(0, 200)}`);

  // Carrying nothing, so the only gate that can answer 403 here is the origin gate: 401 is the
  // token gate having been reached, which is the whole claim. The same call is made again in
  // section 7, after the revoke, where it reads 403 — that pair is the memo being rebuilt in
  // both directions rather than merely being wide.
  const nameKnown = await call(device, '/api/pair/admission');
  check('and the name is the record\'s, not a wildcard: an uncredentialled caller gets past it',
        nameKnown.status === 401, `${nameKnown.status} ${nameKnown.text.slice(0, 200)}`);

  const unapproved = await call(device, '/api/elements', {
    headers: asDevice,
    host: `nobody-approved-this.test:${port}`,
  });
  check('one naming an authority nobody approved is still refused — one name each, not a wildcard',
        unapproved.status === 403, `${unapproved.status} ${unapproved.text.slice(0, 200)}`);

  // ─── 4. What the funnel widening must not widen ─────────────

  console.log('\n4. the list, the rename and the revoke stay the host\'s');

  const listedByDevice = await call(device, '/api/devices', { headers: asDevice });
  check('a paired device may not read the list from another machine', listedByDevice.status === 403,
        `${listedByDevice.status} ${listedByDevice.text.slice(0, 200)}`);

  const renamedByDevice = await call(device, `/api/devices/${deviceId}`, {
    method: 'PATCH', headers: asDevice, body: { name: 'renamed from away' },
  });
  check('nor rename anything', renamedByDevice.status === 403,
        `${renamedByDevice.status} ${renamedByDevice.text.slice(0, 200)}`);

  const revokedByDevice = await call(device, `/api/devices/${deviceId}`, {
    method: 'DELETE', headers: asDevice,
  });
  check('nor revoke, itself included', revokedByDevice.status === 403,
        `${revokedByDevice.status} ${revokedByDevice.text.slice(0, 200)}`);

  const listedByHost = await call(host, '/api/devices', { headers: asHost });
  const record = listedByHost.body?.devices?.find((entry) => entry.id === deviceId);
  check('the operator on this machine reads it', listedByHost.status === 200,
        `${listedByHost.status} ${listedByHost.text.slice(0, 200)}`);
  check('and the device is still on it, under the name and host it was approved with',
        record?.name === 'a laptop across the desk' && record?.host === deviceAuthority,
        JSON.stringify(record ?? null));

  // ─── 5. What a paired caller can do that the bind alone refused ───

  console.log('\n5. a board on every interface offers the device what it withholds from the bind');

  const queueForDevice = await call(device, '/api/implement', { headers: asDevice });
  check('GET /api/implement carries the queue for a paired caller',
        queueForDevice.status === 200 && Boolean(queueForDevice.body?.queue),
        `${queueForDevice.status} ${queueForDevice.text.slice(0, 200)}`);

  const queueForHost = await call(host, '/api/implement', { headers: asHost });
  check('and drops it for a caller that is not one, on this same board',
        queueForHost.status === 200 && queueForHost.body?.queue === undefined,
        `${queueForHost.status} ${queueForHost.text.slice(0, 200)}`);

  const terminalForDevice = await call(device, '/api/terminal', { headers: asDevice });
  check('the terminal answers a paired caller', terminalForDevice.status === 200,
        `${terminalForDevice.status} ${terminalForDevice.text.slice(0, 200)}`);

  const terminalForHost = await call(host, '/api/terminal', { headers: asHost });
  check('and is refused to one that is not, because that question is about the bind',
        terminalForHost.status === 403,
        `${terminalForHost.status} ${terminalForHost.text.slice(0, 200)}`);

  // ─── 6. Last seen moves on a served request, not a refused one ───

  console.log('\n6. "last seen" is written on a request the credential served');

  // A second device, so this section reads a row nothing above has already touched.
  const secondAsk = await call(device, '/api/pair/request', {
    method: 'POST', body: { name: 'a phone' },
  });
  await call(host, '/api/pair/approve', {
    method: 'POST',
    headers: asHost,
    body: { requestId: secondAsk.body?.requestId, code: secondAsk.body?.code },
  });
  const secondStatus = await call(device, `/api/pair/status?requestId=${secondAsk.body?.requestId}`);
  const phone = secondStatus.body?.credential ?? '';
  const phoneId = phone.split('.')[0];

  const seenAt = async (id) => {
    const listed = await call(host, '/api/devices', { headers: asHost });
    return listed.body?.devices?.find((entry) => entry.id === id)?.lastSeenAt ?? null;
  };
  check('a device that has made no request has no last seen at all', await seenAt(phoneId) === null,
        String(await seenAt(phoneId)));

  const refusedAsPhone = await call(device, '/api/elements', {
    headers: { [TOKEN_HEADER]: `${phoneId}.${'0'.repeat(64)}` },
  });
  check('a request under its id and the wrong secret is refused', refusedAsPhone.status === 401,
        `got ${refusedAsPhone.status}`);
  check('and writes nothing down — a refusal is not a sighting', await seenAt(phoneId) === null,
        String(await seenAt(phoneId)));

  const servedAsPhone = await call(device, '/api/elements', { headers: { [TOKEN_HEADER]: phone } });
  check('the same id with the right secret is served', servedAsPhone.status === 200,
        `got ${servedAsPhone.status}`);
  check('and that one is written down', typeof await seenAt(phoneId) === 'string',
        String(await seenAt(phoneId)));

  // ─── 7. Revoking reaches the socket, and the very next request ───

  console.log('\n7. a revoke reaches the socket, not only the next request');

  const held = await upgrade(device, `?token=${encodeURIComponent(credential)}`);
  check('a device credential opens the upgrade from off this machine', held.opened,
        `refused with ${held.refused}`);
  check('and the scene goes over it the moment it opens',
        await settles(() => held.messages.some((message) => message.includes('initial_elements'))),
        JSON.stringify(held.messages.map((message) => message.slice(0, 40))));

  const beforeRevoke = await call(device, '/api/elements', { headers: asDevice });
  check('the device reads the board', beforeRevoke.status === 200, `got ${beforeRevoke.status}`);

  const revoked = await call(host, `/api/devices/${deviceId}`, { method: 'DELETE', headers: asHost });
  check('the operator revokes it from this machine', revoked.status === 200,
        `${revoked.status} ${revoked.text.slice(0, 200)}`);
  check('and is told how many connections that disconnected', revoked.body?.socketsClosed === 1,
        JSON.stringify(revoked.body ?? null));

  check('the socket it was holding is closed rather than left streaming',
        await settles(() => held.closed));
  check('with a code that is not a tidy end of conversation, so the page knows to say why',
        held.code === 4003, String(held.code));

  // The discriminator: the same call, the same address, the same header, on either side of one
  // revoke. Nothing but a consulted credential produces this pair.
  const afterRevoke = await call(device, '/api/elements', { headers: asDevice });
  check('the very next request with that same credential is refused — no restart in between',
        afterRevoke.status === 401, `${afterRevoke.status} ${afterRevoke.text.slice(0, 200)}`);

  const reconnect = await upgrade(device, `?token=${encodeURIComponent(credential)}`);
  check('and a fresh upgrade carrying it is refused too', !reconnect.opened,
        `opened with ${reconnect.refused}`);
  try { reconnect.socket.close(); } catch { /* already going */ }

  const phoneStillIn = await call(device, '/api/elements', { headers: { [TOKEN_HEADER]: phone } });
  check('while the device that was kept reaches the board exactly as before',
        phoneStillIn.status === 200, `${phoneStillIn.status} ${phoneStillIn.text.slice(0, 200)}`);

  // The other half of the memo. Both devices asked from the same address, so both records carry
  // the same authority and the name only leaves the set once the last of them does — which is
  // the rule working: an authority is in there because some *record* is, not because it was ever
  // added. Uncredentialled on purpose, so the only gate that can answer is the origin gate: this
  // exact call read 401 in section 3, before either approval had been undone.
  const revokedPhone = await call(host, `/api/devices/${phoneId}`, { method: 'DELETE', headers: asHost });
  check('the operator revokes the last device too', revokedPhone.status === 200,
        `${revokedPhone.status} ${revokedPhone.text.slice(0, 200)}`);

  const nameGone = await call(device, '/api/pair/admission');
  check('and the authority those devices were approved for is one this board no longer answers for',
        nameGone.status === 403, `${nameGone.status} ${nameGone.text.slice(0, 200)}`);
} catch (error) {
  if (!(error instanceof Skip)) {
    failures++;
    console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  }
} finally {
  if (server) server.stop();
  await sleep(300);
  // Guarded, because a teardown is not a verdict (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the directory outlives the run and costs nothing else */ }
}

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: an approved device is a caller this board serves, until it is not.');
