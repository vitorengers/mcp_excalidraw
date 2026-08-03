#!/usr/bin/env node
/**
 * Checks the pairing handshake: a device asks, the host approves, and only the host may approve.
 *
 * Until #503 the only way onto this board was the per-start token file, which is readable by
 * exactly one account on exactly one machine. A second machine could not be let in at all — not
 * narrowly, not on purpose. The gesture this adds is: open the board on the second machine, read
 * a code off it, approve it on the machine that is running the board.
 *
 * Three shapes are checked here, and only the first of them would compile away:
 *
 *   - **the exchange** — `POST /api/pair/request` open to a caller with no credential,
 *     `GET /api/pair/status` open in the same way, `POST /api/pair/approve` reachable only by
 *     the operator, and the minted secret handed over on exactly one poll and never again;
 *   - **who may approve** — the caller's own socket address, which is the one thing about a
 *     caller nobody can forge. A board bound to an interface is reached from that interface, and
 *     the approve route refuses it — including when it claims loopback through
 *     `X-Forwarded-For`, which is the trap #501 names and which this route must not fall into
 *     either;
 *   - **the bounds** — one live request per remote address, a ceiling overall, a short expiry.
 *     They are what stops a stranger on the network filling the operator's screen with prompts,
 *     and they are refusals nobody sees rather than dialogs.
 *
 * The bounds are driven against `dist/core/pairing.js` directly, with the clock passed in and a
 * minter that writes nowhere. An expiry a check can wait out is an expiry too short to be one, a
 * ceiling proved over HTTP would need as many distinct source addresses as the ceiling is high,
 * and a desk built here with the real `addDevice` would pair devices into the state directory of
 * whoever ran this. The routes are proved over HTTP; the arithmetic behind them is proved in the
 * module that does it.
 *
 * The board is given a throwaway `HOME`/`USERPROFILE`/`LOCALAPPDATA`/`XDG_STATE_HOME`, so the
 * token and the device registry land inside this check's own temporary directory and the
 * operator's real state directory is never read or written. Where they land is spelled out here
 * from the platform rather than imported: a check that asks the code under test where it put a
 * file agrees with any answer it gives.
 *
 * **This check binds `0.0.0.0` for the length of one run**, the way
 * `check-non-loopback-github-browser.mjs` already does, because a caller that is genuinely not
 * loopback is the whole of the third shape and cannot be simulated by a header. On a machine
 * with no non-loopback IPv4 address that section says so and is skipped rather than passing
 * vacuously.
 *
 * Self-contained: canvas servers on ports the kernel just handed out, all killed at the end. Run
 * `./node_modules/.bin/tsc` first — it drives the built server and imports the built module.
 *
 * Usage: node scripts/check-pairing-handshake.mjs
 *
 * Tier: fast
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const built = join(repoRoot, 'dist', 'server.js');
if (!existsSync(built)) {
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

const workDir = mkdtempSync(join(tmpdir(), 'check-pairing-'));
/** The home each board is told it has, and the only place it may keep state. */
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
 * A board of this check's own, with the token gate **on**.
 *
 * `EXCALIDRAW_NO_AUTH: undefined` is load-bearing here: `canvasEnvironment` sets that variable
 * for every check in this directory, and the claim being made is which routes are open *when
 * there is a gate to be open in front of*. Behind the opt-out every route is open and this
 * check would assert nothing.
 */
async function startBoard({ host = '127.0.0.1', reachAt = '127.0.0.1', allowedHosts } = {}) {
  const port = await freePort();
  const server = startCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, 'board.log'),
      EXCALIDRAW_NO_AUTH: undefined,
      EXCALIDRAW_ALLOWED_HOSTS: allowedHosts,
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
  const token = readFileSync(conventionalStateFile(`server-${port}.token`), 'utf-8').trim();
  return { port, reachAt, token, base: `http://${reachAt}:${port}` };
}

/**
 * One request, over `node:http` rather than `fetch`.
 *
 * `Host` is a forbidden header for `fetch`, and naming an authority this board does not answer
 * for is half of what a second origin *is*. So the requests here are made by the module that
 * lets a caller say who it thinks it is talking to.
 */
function call(board, path, { method = 'GET', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : JSON.stringify(body);
    const request = http.request({
      host: board.reachAt,
      port: board.port,
      path,
      method,
      headers: {
        ...(payload === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
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

/** The address a second machine would reach this one on, or null when there is no such address. */
function externalAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

// ─── The cases ────────────────────────────────────────────────

try {
  // ─── 1. The exchange, end to end ────────────────────────────
  console.log('\nThe exchange');

  const board = await startBoard();

  const asked = await call(board, '/api/pair/request', {
    method: 'POST',
    body: { name: 'a laptop' },
  });
  check('a device with no credential may ask to pair', asked.status === 200,
        `${asked.status} ${asked.text.slice(0, 200)}`);
  check('and is answered a requestId and a code',
        Boolean(asked.body?.requestId) && Boolean(asked.body?.code),
        asked.text.slice(0, 200));
  check('and nothing secret is in that answer',
        !/secret/i.test(asked.text), asked.text.slice(0, 200));

  const requestId = asked.body?.requestId ?? 'nothing-was-issued';
  const code = asked.body?.code ?? '';

  const polled = await call(board, `/api/pair/status?requestId=${encodeURIComponent(requestId)}`);
  check('the waiting device may poll with no credential, and is told it is pending',
        polled.status === 200 && polled.body?.state === 'pending',
        `${polled.status} ${polled.text.slice(0, 200)}`);

  const listedOpen = await call(board, '/api/pair/pending');
  check('the pending list is not one of the open routes', listedOpen.status === 401,
        `${listedOpen.status} ${listedOpen.text.slice(0, 200)}`);

  const listed = await call(board, '/api/pair/pending', { headers: { [TOKEN_HEADER]: board.token } });
  const entry = listed.body?.requests?.find((request) => request.requestId === requestId);
  check('the host is shown the request, with the code to compare', Boolean(entry) && entry.code === code,
        `${listed.status} ${listed.text.slice(0, 300)}`);
  check('and the Host and the remote address it arrived with',
        Boolean(entry?.host) && Boolean(entry?.remoteAddress),
        JSON.stringify(entry ?? null));
  check('and no secret, because there is not one yet',
        !/secret/i.test(listed.text), listed.text.slice(0, 300));

  const mismatched = await call(board, '/api/pair/approve', {
    method: 'POST',
    headers: { [TOKEN_HEADER]: board.token },
    body: { requestId, code: '000-000' },
  });
  check('an approval naming the wrong code is refused', mismatched.status === 409,
        `${mismatched.status} ${mismatched.text.slice(0, 200)}`);

  const stillPending = await call(board, `/api/pair/status?requestId=${encodeURIComponent(requestId)}`);
  check('and the request is still pending after it', stillPending.body?.state === 'pending',
        stillPending.text.slice(0, 200));

  const approved = await call(board, '/api/pair/approve', {
    method: 'POST',
    headers: { [TOKEN_HEADER]: board.token },
    body: { requestId, code },
  });
  check('the operator approves it from the machine running the board', approved.status === 200,
        `${approved.status} ${approved.text.slice(0, 200)}`);
  check('and the approval does not carry the secret back to the operator',
        !/secret/i.test(approved.text), approved.text.slice(0, 200));

  const collected = await call(board, `/api/pair/status?requestId=${encodeURIComponent(requestId)}`);
  // One opaque string, the id and the secret joined — what `verifyDevice` takes, and the only
  // shape that fits in the one place a bearer credential has to travel in.
  const credential = collected.body?.credential ?? '';
  const secret = credential.split('.')[1] ?? '';
  check('the waiting device is handed its credential on its next poll',
        collected.body?.state === 'approved' && secret.length >= 32,
        collected.text.slice(0, 200));

  const registryFile = conventionalStateFile('devices.json');
  let devices = [];
  try { devices = JSON.parse(readFileSync(registryFile, 'utf-8')).devices ?? []; } catch { /* not written */ }
  const device = devices.find((entry) => entry.name === 'a laptop');
  check('the approved device is written where a restart will find it', Boolean(device),
        `${registryFile}: ${devices.length} device(s)`);
  check('and the registry holds the hash of the secret, never the secret',
        Boolean(device) && device.secretHash === createHash('sha256').update(secret).digest('hex')
        && !readFileSync(registryFile, 'utf-8').includes(secret),
        JSON.stringify(device ?? null));
  if (process.platform === 'win32') {
    console.log('  note  the registry file\'s mode is not asserted on Windows — the ACL on '
                + 'LOCALAPPDATA is what protects it');
  } else {
    check('and the file denies group and other',
          (statSync(registryFile).mode & 0o077) === 0,
          `mode ${(statSync(registryFile).mode & 0o777).toString(8)}`);
  }

  const again = await call(board, `/api/pair/status?requestId=${encodeURIComponent(requestId)}`);
  check('a second poll of a consumed requestId answers as unknown', again.body?.state === 'unknown',
        again.text.slice(0, 200));

  const approvedTwice = await call(board, '/api/pair/approve', {
    method: 'POST',
    headers: { [TOKEN_HEADER]: board.token },
    body: { requestId, code },
  });
  check('and it cannot be approved a second time', approvedTwice.status === 404,
        `${approvedTwice.status} ${approvedTwice.text.slice(0, 200)}`);

  const drivenWithCredential = await call(board, '/api/elements', {
    headers: { [TOKEN_HEADER]: credential },
  });
  check('the credential is not the board token — the guard learns it in #501',
        drivenWithCredential.status === 401, `${drivenWithCredential.status}`);

  // ─── 2. A second origin ─────────────────────────────────────
  console.log('\nA second origin');

  const elsewhere = `board.somewhere.test:${board.port}`;

  const fromElsewhere = await call(board, '/api/pair/request', {
    method: 'POST',
    body: { name: 'a machine over there' },
    host: elsewhere,
  });
  check('a device reaching this board under a name it does not answer for may still ask',
        fromElsewhere.status === 200, `${fromElsewhere.status} ${fromElsewhere.text.slice(0, 200)}`);

  const listedAgain = await call(board, '/api/pair/pending', { headers: { [TOKEN_HEADER]: board.token } });
  const overThere = listedAgain.body?.requests?.find(
    (request) => request.requestId === fromElsewhere.body?.requestId);
  check('and the name it used is recorded verbatim, for the operator to recognise',
        overThere?.host === elsewhere, JSON.stringify(overThere ?? null));

  const crossOrigin = await call(board, '/api/pair/request', {
    method: 'POST',
    body: { name: 'a page somewhere else' },
    headers: { Origin: 'https://evil.example' },
  });
  check('but a page at another origin cannot put a prompt on the operator\'s screen',
        crossOrigin.status === 403, `${crossOrigin.status} ${crossOrigin.text.slice(0, 200)}`);

  const ordinary = await call(board, '/api/elements', {
    headers: { [TOKEN_HEADER]: board.token },
    host: elsewhere,
  });
  check('and the pin still holds on every other route', ordinary.status === 403,
        `${ordinary.status} ${ordinary.text.slice(0, 200)}`);

  // ─── 3. Only the host may approve ───────────────────────────
  console.log('\nOnly the host may approve');

  const external = externalAddress();
  if (!external) {
    console.log('  note  this machine has no non-loopback IPv4 address, so a caller that is '
                + 'genuinely remote cannot be made here — section skipped');
  } else {
    const open = await startBoard({
      host: '0.0.0.0',
      reachAt: external,
      // So that the origin gate lets these requests reach the route at all: the claim being
      // made is that the *approve* route refuses a remote caller, and a 403 from the Host pin
      // would be the right status for the wrong reason.
      allowedHosts: external,
    });
    // Reached at the interface address, so the socket this server sees really is a remote one.
    const remoteAsk = await call(open, '/api/pair/request', {
      method: 'POST',
      body: { name: 'a machine on the network' },
    });
    check('a caller that is genuinely remote may ask to pair', remoteAsk.status === 200,
          `${remoteAsk.status} ${remoteAsk.text.slice(0, 200)}`);

    const remoteApprove = await call(open, '/api/pair/approve', {
      method: 'POST',
      headers: { [TOKEN_HEADER]: open.token },
      body: { requestId: remoteAsk.body?.requestId, code: remoteAsk.body?.code },
    });
    check('and cannot approve itself, even holding the board token', remoteApprove.status === 403,
          `${remoteApprove.status} ${remoteApprove.text.slice(0, 200)}`);

    const forwarded = await call(open, '/api/pair/approve', {
      method: 'POST',
      headers: { [TOKEN_HEADER]: open.token, 'X-Forwarded-For': '127.0.0.1' },
      body: { requestId: remoteAsk.body?.requestId, code: remoteAsk.body?.code },
    });
    check('and a forwarded header claiming loopback does not make it the host',
          forwarded.status === 403, `${forwarded.status} ${forwarded.text.slice(0, 200)}`);

    const fromHost = await call({ ...open, reachAt: '127.0.0.1' }, '/api/pair/approve', {
      method: 'POST',
      headers: { [TOKEN_HEADER]: open.token },
      body: { requestId: remoteAsk.body?.requestId, code: remoteAsk.body?.code },
    });
    check('the operator, on the machine running the board, approves the same request',
          fromHost.status === 200, `${fromHost.status} ${fromHost.text.slice(0, 200)}`);
  }

  // ─── 4. The bounds ──────────────────────────────────────────
  console.log('\nThe bounds');

  let pairing = null;
  try {
    pairing = await import(new URL('../dist/core/pairing.js', import.meta.url).href);
  } catch (error) {
    check('the pairing module is built', false, String(error?.message ?? error));
  }

  if (pairing) {
    const { createPairingDesk, PAIRING_EXPIRY_MS, PAIRING_MAX_PENDING } = pairing;
    /**
     * A registry that writes nowhere, in the shape `addDevice` answers in.
     *
     * The real one writes into the state directory of whoever is running this, which is the
     * operator's own — and the desk is being driven here in this process rather than in a
     * throwaway server's. Section 1 above is what proves the real one is wired up.
     */
    let minted = 0;
    const mint = (approval) => {
      const secret = createHash('sha256').update(`secret-${minted}`).digest('hex')
        + createHash('sha256').update(`salt-${minted}`).digest('hex');
      minted++;
      return {
        secret,
        device: {
          id: `device-${minted}`,
          name: approval.name,
          secretHash: createHash('sha256').update(secret).digest('hex'),
          createdAt: new Date(0).toISOString(),
          lastSeenAt: null,
          approvedFrom: approval.approvedFrom,
          host: approval.host,
        },
      };
    };
    const ask = (desk, at, remoteAddress, name = 'a device') =>
      desk.request({ name, remoteAddress, host: 'board.test:3737', now: at });

    const desk = createPairingDesk({ mint });
    const first = ask(desk, 1_000, '10.0.0.5');
    check('a device may ask', first.ok === true, JSON.stringify(first));

    const second = ask(desk, 2_000, '10.0.0.5');
    check('a second live request from the same address is refused',
          second.ok === false && second.refusal === 'one-per-address', JSON.stringify(second));
    check('and the first one is still the live one, rather than being replaced',
          desk.pending(2_000).length === 1
          && desk.pending(2_000)[0].requestId === first.pending.requestId,
          JSON.stringify(desk.pending(2_000)));

    const afterExpiry = 1_000 + PAIRING_EXPIRY_MS + 1;
    check('a request past its expiry is no longer pending',
          desk.pending(afterExpiry).length === 0, JSON.stringify(desk.pending(afterExpiry)));
    check('and answers as unknown rather than as pending',
          desk.status({ requestId: first.pending.requestId, now: afterExpiry }).state === 'unknown');
    check('and cannot be approved',
          desk.approve({ requestId: first.pending.requestId, code: first.pending.code, now: afterExpiry }).ok === false);
    check('and that address may ask again once it has expired',
          ask(desk, afterExpiry, '10.0.0.5').ok === true);

    const ceiling = createPairingDesk({ mint });
    for (let index = 0; index < PAIRING_MAX_PENDING; index++) {
      ask(ceiling, 1_000, `10.0.1.${index}`);
    }
    const overCeiling = ask(ceiling, 1_000, '10.0.9.9');
    check('a ceiling holds however many addresses ask',
          overCeiling.ok === false && overCeiling.refusal === 'too-many-pending',
          JSON.stringify(overCeiling));
    check('and one expiring makes room again',
          ask(ceiling, 1_000 + PAIRING_EXPIRY_MS + 1, '10.0.9.9').ok === true);

    const codes = createPairingDesk({ mint });
    const issued = new Set();
    for (let index = 0; index < PAIRING_MAX_PENDING; index++) {
      const asked = ask(codes, 1_000, `10.0.2.${index}`);
      if (asked.ok) issued.add(asked.pending.code);
    }
    check('two live requests never carry the same code, because the operator compares them',
          issued.size === PAIRING_MAX_PENDING, `${issued.size} distinct of ${PAIRING_MAX_PENDING}`);

    const minting = createPairingDesk({ mint });
    const toApprove = ask(minting, 1_000, '10.0.3.1', 'a mac');
    const approval = minting.approve({
      requestId: toApprove.pending.requestId, code: toApprove.pending.code, now: 1_100,
    });
    check('approving asks the registry for a secret and a device record',
          approval.ok === true && typeof approval.secret === 'string' && approval.secret.length >= 32,
          JSON.stringify({ ok: approval.ok }));
    check('and hands it the name, the address it was approved from and the authority it used',
          approval.device.approvedFrom === '10.0.3.1'
          && approval.device.host === 'board.test:3737'
          && approval.device.name === 'a mac',
          JSON.stringify({ ...approval.device, secretHash: '<hash>' }));
    check('and the pending record is gone the moment it is approved',
          minting.pending(1_100).length === 0, JSON.stringify(minting.pending(1_100)));
    check('a refusal to write is not a consumed gesture — the request survives it',
          (() => {
            const failing = createPairingDesk({ mint: () => { throw new Error('read-only'); } });
            const asked = ask(failing, 1_000, '10.0.4.1');
            let threw = false;
            try { failing.approve({ requestId: asked.pending.requestId, code: asked.pending.code, now: 1_100 }); }
            catch { threw = true; }
            return threw && failing.pending(1_100).length === 1;
          })());
    check('the credential is handed over exactly once',
          minting.status({ requestId: toApprove.pending.requestId, now: 1_200 }).credential
            === `${approval.device.id}.${approval.secret}`
          && minting.status({ requestId: toApprove.pending.requestId, now: 1_300 }).state === 'unknown');
  }

  // ─── 5. The bounds, on the wire ─────────────────────────────
  console.log('\nThe bounds, on the wire');

  const bounded = await startBoard();
  const one = await call(bounded, '/api/pair/request', { method: 'POST', body: { name: 'one' } });
  const two = await call(bounded, '/api/pair/request', { method: 'POST', body: { name: 'two' } });
  check('a second live request from the same address is refused on the wire',
        one.status === 200 && two.status === 429,
        `${one.status} then ${two.status}: ${two.text.slice(0, 200)}`);
  check('and quietly — the refusal says no more than that it was refused',
        two.body?.success === false && !/secret|requestId/.test(two.text),
        two.text.slice(0, 200));

  const unnamed = await startBoard();
  const nameless = await call(unnamed, '/api/pair/request', { method: 'POST', body: {} });
  check('a request that proposes no name is refused rather than listed as an empty row',
        nameless.status === 400, `${nameless.status} ${nameless.text.slice(0, 200)}`);
} catch (error) {
  failures++;
  console.error(`  FAIL  the check ran to the end — ${error?.stack ?? error}`);
} finally {
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows still holds it */ }
}

console.log('');
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All pairing handshake checks passed.');
