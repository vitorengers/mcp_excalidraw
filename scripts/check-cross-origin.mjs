#!/usr/bin/env node

/**
 * A page the operator visits must not be able to drive this board.
 *
 * Every guard on this server tests the bind address — `LOOPBACK_ADDRESSES.includes(HOST)` —
 * which a page at any origin, running in the operator's own browser, satisfies exactly as the
 * board does. With `app.use(cors())` supplying `origin: '*'`, one cross-origin fetch to
 * `/api/terminal` is a shell running as the operator and the answer is readable. The
 * WebSocket is the same hole by a door CORS does not cover at all: it streams
 * `initial_elements` and every live shell's scrollback on connect.
 *
 * This check starts its own server on a free port and asserts the gate from both sides. It
 * spawns with a `cwd` that holds no `.env`, so the operator's own configuration cannot reach
 * the server under test and decide the result.
 *
 * The positive browser case — the real board still loads and its socket reaches Connected —
 * is check-board-landing-browser.mjs; a wrong allowlist leaves a blank canvas that compiles.
 */

import { createServer } from 'node:net';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

import { startCanvas } from './lib/spawn-canvas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const EVIL = 'https://evil.example';
const startupTimeoutMs = 15000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A raw request, because `fetch` will not let a caller set `Host` or an arbitrary `Origin`. */
function send(port, { method = 'GET', path = '/health', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      },
    );
    req.once('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Resolves with the first message the socket receives, or how it was refused. */
function connect(port, origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?workspace=default`, {
      headers: origin ? { origin } : {},
    });
    const done = (outcome) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closing */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => done({ refused: true, why: 'no message within 2s' }), 2000);
    ws.on('message', (data) => {
      let parsed = null;
      try { parsed = JSON.parse(data.toString()); } catch { /* not ours */ }
      done({ refused: false, type: parsed?.type ?? null });
    });
    ws.on('error', (error) => done({ refused: true, why: error.message }));
    ws.on('unexpected-response', (_req, res) => done({ refused: true, why: `HTTP ${res.statusCode}` }));
  });
}

async function waitForHealth(port, child) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Canvas server exited early (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const res = await send(port);
      if (res.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`Timed out waiting for the canvas server on ${port}.`);
}

const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

const port = await freePort();
// No .env here, so the operator's own configuration cannot decide this check.
const workdir = mkdtempSync(join(tmpdir(), 'check-cross-origin-'));
const child = startCanvas({
  port,
  cwd: workdir,
  env: {
    EXCALIDRAW_TERMINAL: '1',
    EXCALIDRAW_WORKSPACES: '',
    LOG_LEVEL: 'error',
  },
}).child;
let output = '';
child.stdout.on('data', (c) => { output += c; });
child.stderr.on('data', (c) => { output += c; });

try {
  await waitForHealth(port, child);
  const ownOrigin = `http://127.0.0.1:${port}`;

  // 1. A cross-origin read is refused. This is the door every other route shares.
  const evilRead = await send(port, { path: '/api/elements', headers: { origin: EVIL } });
  expect(evilRead.status === 403, `A cross-origin GET /api/elements answered ${evilRead.status}, not 403.`);
  expect(
    evilRead.headers['access-control-allow-origin'] !== '*',
    'The server still answers Access-Control-Allow-Origin: * , so a browser hands the body to any page.',
  );

  // 2. A cross-origin shell is refused. Nothing may be spawned before the refusal.
  const evilShell = await send(port, {
    method: 'POST',
    path: '/api/terminal',
    headers: { origin: EVIL },
    body: { workspace: 'default' },
  });
  expect(evilShell.status === 403, `A cross-origin POST /api/terminal answered ${evilShell.status}, not 403.`);

  // 3. A caller with no Origin is not a browser, and is what the CLI, the MCP server and the
  //    ~130 check scripts are. It must go through untouched.
  const plain = await send(port, { path: '/api/elements' });
  expect(plain.status === 200, `A request with no Origin answered ${plain.status}, not 200.`);

  // 4. The board's own page still works.
  const same = await send(port, { path: '/api/elements', headers: { origin: ownOrigin } });
  expect(same.status === 200, `A same-origin request answered ${same.status}, not 200.`);

  // 5. DNS rebinding: the Origin can be omitted by an attacker who controls the name the
  //    browser resolved, so the Host header has to be checked too.
  const rebound = await send(port, { path: '/api/elements', headers: { host: 'board.evil.example' } });
  expect(rebound.status === 403, `A request whose Host is board.evil.example answered ${rebound.status}, not 403.`);

  // 6. The socket is the same hole by a door CORS does not cover.
  const evilSocket = await connect(port, EVIL);
  expect(evilSocket.refused, `A cross-origin WebSocket was accepted and sent "${evilSocket.type}".`);

  // 7. And it still opens for the board itself.
  const ownSocket = await connect(port, ownOrigin);
  expect(!ownSocket.refused, `A same-origin WebSocket was refused: ${ownSocket.why}.`);
  expect(
    ownSocket.type === 'initial_elements',
    `A same-origin WebSocket received "${ownSocket.type}" instead of initial_elements.`,
  );
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(workdir, { recursive: true, force: true });
}

if (failures.length) {
  console.error('Cross-origin check FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  if (process.env.DEBUG_CROSS_ORIGIN && output.trim()) console.error(`\n${output.trim()}`);
  process.exit(1);
}

console.log(
  `Cross-origin check passed on port ${port}: cross-origin reads, shells and sockets are ` +
  'refused, a foreign Host is refused, and the board\'s own page and socket still work.',
);
