#!/usr/bin/env node
/**
 * The guard asks who is calling, not where the server opened.
 *
 * `offLoopback` tested the **bind address**, so a board on any interface was inert for
 * everybody — the browser on the host machine included, whose request is loopback and was
 * refused all the same. `HOST=0.0.0.0` and `HOST=100.x.y.z` on a private overlay were treated
 * alike, so the guard punished the careful configuration exactly as hard as the reckless one,
 * and there was no configuration, however narrow, in which this board was reachable from a
 * second machine. #501 changes the question to the caller's own address:
 *
 *   - the caller reached this server from this machine → allowed, exactly as before;
 *   - the caller is remote → refused. The device credential that is meant to let one in is the
 *     next issue in this milestone; until it exists, "remote" and "refused" are the same answer,
 *     which is why a board with no device paired behaves exactly as it did.
 *
 * **The thing that must not be got wrong is `X-Forwarded-For`.** A reverse proxy reaches this
 * server on loopback, which is why a proxy configuration worked before and is untouched. Reading
 * a forwarded header would turn the one property of a caller nobody can forge into one anybody
 * can set, so a remote caller could simply claim to be loopback. Section 4 is that request, and
 * it is refused.
 *
 * One server, bound to `0.0.0.0`, and two callers:
 *
 *   1. the address predicate on its own, over the spellings a socket produces — `::ffff:127.0.0.1`
 *      is loopback and has to be read as such, the whole of `127.0.0.0/8` is loopback, a name is
 *      not an address, and a comma-separated forwarded-header value is not one either.
 *   2. **called from loopback: served.** The board, the images, the documents, the library, the
 *      snapshots and the socket that streams the scene. Every one of these answered 403 before
 *      this change, and that is the case this check exists for.
 *   3. **called from a non-loopback address: refused**, with none of the board in the refusal,
 *      and the upgrade refused too — it hands over `initial_elements` and every live shell's
 *      scrollback on connect, so an HTTP-only guard would have left the rest decorative.
 *   4. **and a forwarded header does not buy it back.** `X-Forwarded-For: 127.0.0.1` and
 *      `Forwarded: for="127.0.0.1"` from that same remote socket are still refused.
 *   5. read off the source rather than off a server: both funnels ask the socket, and the
 *      decision reads no header at all.
 *
 * The remote caller is a real one. While the guards tested the bind, a check could ask the whole
 * question by binding `127.0.0.2` and never leave the machine; now that they test the caller,
 * `127.0.0.2` is a loopback address like any other in `127.0.0.0/8` and there is no substitute
 * left. `scripts/lib/remote-caller.mjs` picks a host-only adapter — a Hyper-V or WSL virtual
 * switch, a Docker bridge — in preference to a real interface, says on stdout when it had to take
 * a real one, and answers `null` on a machine that has nothing but loopback. Sections 3 and 4
 * then say which cases they could not run rather than passing as though they had.
 *
 * Self-contained: it builds a throwaway project and registry in a temp directory, starts its own
 * server on a port the kernel just handed out and kills it. No browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-caller-guard.mjs
 *
 * Tier: fast
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';
import { looksLikeLoopback, peerAddressSeenOn, remoteInterfaceAddress } from './lib/remote-caller.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 15000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function note(line) {
  console.log(`  note  ${line}`);
}

async function waitForHealth(base, child) {
  const start = Date.now();
  while (Date.now() - start < startupTimeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Canvas server exited early (${child.exitCode ?? child.signalCode}).`);
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for the canvas server on ${base}.`);
}

/**
 * The board every request below is about, named in the header rather than in the query, for the
 * reason `check-board-reads-guard.mjs` gives: it is the one form that reaches all of these routes
 * without going anywhere near a filter.
 */
const BOARD = { 'x-workspace-id': 'callers' };

async function get(base, path, headers = {}) {
  const response = await fetch(`${base}${path}`, { headers: { ...BOARD, ...headers } });
  const text = await response.text();
  return { status: response.status, text };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...BOARD },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

/**
 * Connect a plain WebSocket and report what the server said, or how it refused.
 *
 * No browser and no `Origin` header: this is the caller the origin gate deliberately allows — a
 * program, which can set any header it likes — and therefore the caller only an address the
 * kernel filled in can turn away.
 */
function socketVerdict(url) {
  return new Promise((resolve) => {
    let socket;
    const done = (verdict) => {
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already gone */ }
      resolve(verdict);
    };
    const timer = setTimeout(() => done({ outcome: 'timeout' }), 8000);
    try {
      socket = new WebSocket(url);
    } catch (error) {
      done({ outcome: 'refused', detail: error.message });
      return;
    }
    socket.on('unexpected-response', (_request, response) => {
      done({ outcome: 'refused', status: response.statusCode });
    });
    socket.on('error', (error) => done({ outcome: 'refused', detail: error.message }));
    socket.on('message', (raw) => {
      const text = raw.toString();
      let message = null;
      try { message = JSON.parse(text); } catch { /* not JSON */ }
      if (message?.type !== 'initial_elements') return;
      done({ outcome: 'accepted', text });
    });
  });
}

// ─── 1. The address, on its own ───────────────────────────────

console.log('1. the address a socket hands over, read for what it is');

/**
 * `::ffff:127.0.0.1` is what a dual-stack listener reports for a plain IPv4 loopback client, so
 * a guard that does not read it as loopback refuses the browser on the operator's own machine.
 * `127.0.0.2` and the rest of `127.0.0.0/8` are loopback by RFC 1122, and no packet carrying one
 * as its source is accepted off an interface — which is the property this whole guard rests on.
 */
const LOCAL = [
  '127.0.0.1',
  '127.0.0.2',
  '127.1.2.3',
  '::1',
  '::ffff:127.0.0.1',
  '::ffff:127.0.0.53',
  '[::1]',
  '::1%lo0',
  '  127.0.0.1  ',
  '0:0:0:0:0:0:0:1',
];

/**
 * Everything else, and three of them are the point. `::ffff:192.168.1.10` is a remote caller
 * wearing the mapped form the loopback case arrives in; `127.0.0.1, 10.0.0.4` is the *value* of
 * an `X-Forwarded-For`, which must not parse as an address at all; `localhost` is a name, and a
 * name is not something a socket ever reports.
 */
const REMOTE = [
  '192.168.1.10',
  '10.0.0.4',
  '100.70.4.22',
  '172.17.96.1',
  '::ffff:192.168.1.10',
  'fe80::1',
  '2001:db8::1',
  '0.0.0.0',
  'localhost',
  '127.0.0.1, 10.0.0.4',
  '127.0.0.1.evil.example',
  '1270.0.0.1',
  '',
  '   ',
  null,
  undefined,
];

let isLoopbackAddress = null;
try {
  ({ isLoopbackAddress } = await import(
    pathToFileURL(join(repoRoot, 'dist', 'core', 'caller-gate.js')).href));
} catch (error) {
  check('dist/core/caller-gate.js is there to be asked', false,
        error instanceof Error ? error.message : String(error));
}

if (typeof isLoopbackAddress === 'function') {
  const wrong = LOCAL.filter((address) => isLoopbackAddress(address) !== true);
  check(`every loopback spelling reads as loopback (${LOCAL.length} of them)`, wrong.length === 0,
        wrong.map((address) => JSON.stringify(address)).join(', '));
  const admitted = REMOTE.filter((address) => isLoopbackAddress(address) !== false);
  check(`and nothing else does (${REMOTE.length} of them)`, admitted.length === 0,
        admitted.map((address) => JSON.stringify(address)).join(', '));
} else {
  check('isLoopbackAddress is exported for this to ask', false, String(isLoopbackAddress));
}

// ─── A project with contents worth not publishing ─────────────

const workdir = mkdtempSync(join(tmpdir(), 'check-caller-guard-'));
const projectPath = join(workdir, 'a-board-only-this-machine-may-read');
mkdirSync(join(projectPath, 'notes'), { recursive: true });

const SECRET_TEXT = 'the-drawing-only-this-machine-may-read';
const SECRET_DOC = 'the-document-only-this-machine-may-read';
const SECRET_SHAPE = 'the-library-shape-only-this-machine-may-read';
const SECRET_IMAGE_ID = 'the-image-only-this-machine-may-read';
// A 1x1 PNG is enough: what matters is that a dataURL exists under an id a route will serve.
const SECRET_IMAGE_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'C0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TEXT_ELEMENT_ID = 'the-secret-text-element';

writeFileSync(join(projectPath, 'board.config.json'), JSON.stringify({
  name: 'Callers',
  board: 'board.excalidraw',
  docsDir: 'notes',
  library: 'shapes.excalidrawlib',
}), 'utf8');

writeFileSync(join(projectPath, 'board.excalidraw'), JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'check-caller-guard',
  elements: [
    {
      id: TEXT_ELEMENT_ID, type: 'text', x: 0, y: 0, width: 400, height: 25,
      text: SECRET_TEXT, originalText: SECRET_TEXT, fontSize: 20, fontFamily: 1,
    },
    {
      id: 'the-secret-image-element', type: 'image', x: 0, y: 60, width: 10, height: 10,
      fileId: SECRET_IMAGE_ID,
    },
  ],
  files: {
    [SECRET_IMAGE_ID]: {
      id: SECRET_IMAGE_ID, dataURL: SECRET_IMAGE_DATA, mimeType: 'image/png', created: 1,
    },
  },
}, null, 1), 'utf8');

writeFileSync(join(projectPath, 'notes', 'private-note.md'), `# Private\n\n${SECRET_DOC}\n`, 'utf8');

writeFileSync(join(projectPath, 'shapes.excalidrawlib'), JSON.stringify({
  type: 'excalidrawlib',
  version: 2,
  libraryItems: [{ id: SECRET_SHAPE, status: 'published', elements: [] }],
}), 'utf8');

const registryPath = join(workdir, 'workspaces.json');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [{ id: 'callers', path: projectPath }],
}), 'utf8');

/** Every read the same board answers, as a caller writes it. */
const READS = [
  ['GET /api/elements', '/api/elements'],
  ['GET /api/elements/search', '/api/elements/search'],
  ['GET /api/elements/:id', `/api/elements/${TEXT_ELEMENT_ID}`],
  ['GET /api/files', '/api/files'],
  ['GET /api/files/:id', `/api/files/${SECRET_IMAGE_ID}`],
  ['GET /api/docs/:key', '/api/docs/private-note'],
  ['GET /api/library', '/api/library'],
  ['GET /api/snapshots', '/api/snapshots'],
  ['GET /api/snapshots/:name', '/api/snapshots/before-the-network'],
  ['GET /api/workspaces', '/api/workspaces'],
];

const SECRETS = [SECRET_TEXT, SECRET_DOC, SECRET_SHAPE, SECRET_IMAGE_DATA.slice(-40)];

const port = await freePort();
const remote = await remoteInterfaceAddress(note);

let canvas;

try {
  // ─── 2. One board on every interface, and the caller on it ───

  console.log('\n2. bound to 0.0.0.0, the caller on this machine is served — every one of these '
              + 'answered 403 before #501');

  canvas = startCanvas({
    port,
    cwd: workdir,
    env: {
      EXCALIDRAW_WORKSPACES: registryPath,
      // The project's own library alone: the packaged one would be served here too, and a shape
      // this check did not put on the board is not evidence about this check's board.
      EXCALIDRAW_LIBRARY: '',
      LOG_LEVEL: 'error',
      HOST: '0.0.0.0',
      // The origin gate is a different control and this check is not about it. A request to
      // `http://<interface>:<port>` names that authority in `Host`, which a board bound to
      // `0.0.0.0` does not answer for, so without this the remote sections below would be
      // refused by the wrong gate and would pass for the wrong reason. Opening it is what makes
      // the caller guard the only thing left to refuse them.
      ...(remote ? { EXCALIDRAW_ALLOWED_HOSTS: `${remote}:${port}` } : {}),
    },
  });
  const localBase = `http://127.0.0.1:${port}`;
  await waitForHealth(localBase, canvas.child);

  // Taken rather than seeded: snapshots live in memory, so the only way a server has one to be
  // asked for is to have been told to take it.
  const saved = await post(localBase, '/api/snapshots', { name: 'before-the-network' });
  check('a snapshot of the seeded board was taken', saved.status === 200,
        `${saved.status} ${saved.text.slice(0, 160)}`);

  const answers = new Map();
  for (const [name, path] of READS) {
    const answer = await get(localBase, path);
    answers.set(name, answer);
    check(`${name} answers 200`, answer.status === 200,
          `got ${answer.status} — ${answer.text.slice(0, 160)}`);
  }

  check('the board came back', answers.get('GET /api/elements')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/elements')?.text.slice(0, 200));
  check('the image is served', answers.get('GET /api/files/:id')?.text.includes(SECRET_IMAGE_DATA),
        answers.get('GET /api/files/:id')?.text.slice(0, 120));
  check('the document is served', answers.get('GET /api/docs/:key')?.text.includes(SECRET_DOC),
        answers.get('GET /api/docs/:key')?.text.slice(0, 200));
  check('the library shape is served', answers.get('GET /api/library')?.text.includes(SECRET_SHAPE),
        answers.get('GET /api/library')?.text.slice(0, 200));
  check('the snapshot reads back holding the board',
        answers.get('GET /api/snapshots/:name')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/snapshots/:name')?.text.slice(0, 200));
  check('and the registry, which is the map of every project',
        answers.get('GET /api/workspaces')?.text.includes('callers'),
        answers.get('GET /api/workspaces')?.text.slice(0, 200));

  const openSocket = await socketVerdict(`ws://127.0.0.1:${port}/?workspace=callers`);
  check('the upgrade is accepted', openSocket.outcome === 'accepted', JSON.stringify(openSocket));
  check('and initial_elements carries the scene', String(openSocket.text ?? '').includes(SECRET_TEXT),
        String(openSocket.text ?? '').slice(0, 200));

  // ─── 3. The same board, a caller that is not on this machine ───

  if (!remote) {
    note('this machine has no non-loopback address to be called on, so the remote caller and the '
         + 'forwarded-header cases below could not be run at all');
  } else {
    console.log(`\n3. the same board, called on ${remote}, refuses before it reads anything`);

    // The premise, established with this check's own server rather than with the code under
    // test: a connection to one of this machine's interface addresses reports that interface as
    // its source, not 127.0.0.1.
    const peer = await peerAddressSeenOn(remote);
    check(`a server on ${remote} sees a peer that is not loopback (${peer})`,
          Boolean(peer) && !looksLikeLoopback(peer), peer);

    const remoteBase = `http://${remote}:${port}`;
    const health = await get(remoteBase, '/health');
    check('the canvas itself answers there — this is a guard, not a broken server',
          health.status === 200, `${health.status} ${health.text.slice(0, 120)}`);

    for (const [name, path] of READS) {
      const refused = await get(remoteBase, path);
      check(`${name} answers 403`, refused.status === 403,
            `got ${refused.status} — ${refused.text.slice(0, 200)}`);
      check(`  ${name} is refused by the caller guard, not by the origin gate`,
            /machine/i.test(refused.text) && !/DNS rebinding/i.test(refused.text),
            refused.text.slice(0, 200));
      const leaked = SECRETS.filter((secret) => refused.text.includes(secret));
      check(`  ${name} leaks none of the board into the refusal`, leaked.length === 0,
            leaked.join(', '));
    }

    const refusedSocket = await socketVerdict(`ws://${remote}:${port}/?workspace=callers`);
    check('the upgrade is refused too', refusedSocket.outcome === 'refused',
          JSON.stringify(refusedSocket).slice(0, 240));
    check('so no scene left over it', !String(refusedSocket.text ?? '').includes(SECRET_TEXT),
          String(refusedSocket.text ?? '').slice(0, 200));

    // ─── 4. And a header does not make a caller local ───

    console.log('\n4. and the same caller claiming loopback through a forwarded header is refused');

    const claims = [
      ['X-Forwarded-For: 127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }],
      ['X-Forwarded-For with a chain', { 'x-forwarded-for': '127.0.0.1, 10.0.0.4' }],
      ['X-Real-IP: 127.0.0.1', { 'x-real-ip': '127.0.0.1' }],
      ['Forwarded: for="127.0.0.1"', { forwarded: 'for="127.0.0.1"' }],
      ['X-Forwarded-For: ::1', { 'x-forwarded-for': '::1' }],
    ];
    for (const [name, headers] of claims) {
      const refused = await get(remoteBase, '/api/elements', headers);
      check(`${name} is still 403`, refused.status === 403,
            `got ${refused.status} — ${refused.text.slice(0, 200)}`);
      check(`  and the board is not in that answer`, !refused.text.includes(SECRET_TEXT),
            refused.text.slice(0, 200));
    }
  }

  canvas.stop();
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  if (canvas && process.env.DEBUG_CALLER_GUARD) console.error(canvas.read());
} finally {
  if (canvas) canvas.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Forgiven: on Windows a killed server's handles on its directory are released
  // asynchronously, and a run that reported failure because it could not delete a temporary
  // directory would be wrong about the thing it measured (#472).
  try { rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* a teardown is not a verdict; run-checks.mjs reaps it */ }
}

// ─── 5. Both funnels ask the socket, and read no header ───────

console.log('\n5. both funnels ask the socket, and the decision reads no header at all');

const server = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');

const guardStart = server.indexOf('function offLoopback(');
const guard = guardStart === -1 ? '' : server.slice(guardStart, server.indexOf('\n}', guardStart));
check('offLoopback asks about the caller', /callerIsLocal\(/.test(guard), guard.slice(0, 240));
check('and no longer about the bind', !/boundToLoopback\(/.test(guard), guard.slice(0, 240));

const upgradeStart = server.indexOf('new WebSocketServer(');
const upgrade = upgradeStart === -1
  ? ''
  : server.slice(upgradeStart, server.indexOf('// Middleware', upgradeStart));
check('the socket upgrade asks the same question', /callerIsLocal\(/.test(upgrade),
      upgrade.slice(0, 240));
check('and it too has stopped asking about the bind', !/boundToLoopback\(/.test(upgrade),
      upgrade.slice(0, 240));

let gate = '';
try {
  gate = readFileSync(join(repoRoot, 'src', 'core', 'caller-gate.ts'), 'utf8');
} catch (error) {
  check('src/core/caller-gate.ts is where the decision lives', false,
        error instanceof Error ? error.message : String(error));
}

/**
 * The prose in that file has to be free to explain *why* a forwarded header is not read, so the
 * comments come out before this asks whether the code reads one.
 */
const code = gate.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the decision reads no header', gate !== '' && !/headers/i.test(code), code.slice(0, 240));
check('and names no forwarding header', gate !== '' && !/forwarded|real-ip/i.test(code),
      code.slice(0, 240));

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: the guard asks who is calling, and a header cannot answer for them.');
