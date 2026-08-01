#!/usr/bin/env node
/**
 * A board bound off loopback publishes nothing of what it holds.
 *
 * #278 guarded `GET /api/workspaces` — the map of every project — and said in the same breath
 * that the wider question should not wait for it. This is that question, and #366 is where it
 * was answered: **the reads are guarded too.** A non-loopback bind is therefore useless for
 * anything rather than useful for exactly one thing, which is the honest end of the direction
 * #278 started; after it, such a bind could no longer list projects, so the tab strip and the
 * picker were already broken on one.
 *
 * The reads are not one route. `GET /api/elements` is the whole board, and so is
 * `GET /api/elements/search` with no query at all — guarding the first and leaving the second
 * would be a lock beside an open door. So the set is every door onto the same contents:
 *
 *   - `GET /api/elements`, `GET /api/elements/search`, `GET /api/elements/:id`
 *   - `GET /api/files`, `GET /api/files/:id` — every pasted image
 *   - `GET /api/docs/:key` — the project's documents
 *   - `GET /api/library` — the library
 *   - `GET /api/snapshots`, `GET /api/snapshots/:name`
 *   - **and the WebSocket**, which sends `initial_elements` on connect and is the same read by
 *     a transport HTTP guards cannot see. Leaving it open would have made the rest decorative:
 *     #270's own note says both gates ship together, because either alone leaves the board
 *     readable.
 *
 * The origin gate (#270) is not this guard and does not stand in for it. It asks a *browser*
 * question — `Origin`, `Host` — and its own comment says a program that can set headers can set
 * any header. A network caller with `curl` supplies whatever `Host` it likes and is waved
 * through, which is why the socket case below connects with no browser anywhere near it.
 *
 * Four sections, two servers over one registry and one seeded project:
 *
 *   1. bound to loopback — every read answers exactly as it does today, carrying the seeded
 *      board, the image, the document and the library shape. This is what the guard has to keep
 *      working, and it is half the check.
 *   2. bound off loopback — every one answers 403, the refusal names the bind, and none of the
 *      seeded strings is anywhere in the body.
 *   3. the socket, both ways — `initial_elements` on loopback, a refused upgrade off it.
 *   4. read off `src/server.ts` rather than off a server: each of those routes carries an
 *      `offLoopback` call, so a tenth read added beside them cannot be the next one left out.
 *
 * **The off-loopback server is bound to `127.0.0.2`, not to a real interface**, for the reason
 * `check-workspaces-guard.mjs` gives at length: the guard's question is
 * `LOOPBACK_ADDRESSES.includes(HOST)` over a list that is `127.0.0.1` and `::1` exactly, so
 * `127.0.0.2` is off loopback to the code under test while never leaving this machine.
 * Publishing a board on the LAN for a second to assert that it refuses would be a strange way to
 * prove a security property. Where a platform will not bind a loopback alias, the first real
 * interface is the fallback and the check says so on stdout.
 *
 * Self-contained: it builds a throwaway project and registry in a temp directory, starts its own
 * servers on ports the kernel just handed out and kills them. No browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-board-reads-guard.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import WebSocket from 'ws';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const startupTimeoutMs = 15000;

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Whether this machine will let a server sit on `host`. */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/** An address the guard calls "not loopback" and this machine will bind. */
async function offLoopbackHost() {
  if (await canBind('127.0.0.2')) return '127.0.0.2';
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && (await canBind(entry.address))) {
        console.log(`  note  127.0.0.2 is not bindable here; using the interface ${entry.address}`);
        return entry.address;
      }
    }
  }
  throw new Error('No non-loopback address on this machine could be bound.');
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
 * The board every request below is about, named in the header rather than in the query.
 *
 * `?workspace=` would be the obvious spelling and it is the wrong one for exactly one of these
 * routes: `GET /api/elements/search` treats every query parameter it does not recognise as an
 * exact-match filter over element fields, so `?workspace=reads` asks for elements carrying a
 * `workspace` property and a whole board answers empty. The header is the third form
 * `workspaceIdFrom()` accepts and the only one that means the same thing to all nine.
 */
const BOARD = { 'x-workspace-id': 'reads' };

async function get(base, path) {
  const response = await fetch(`${base}${path}`, { headers: BOARD });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...BOARD },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

/**
 * Connect a plain WebSocket and report what the server said, or how it refused.
 *
 * No browser and no `Origin` header: this is the caller the origin gate deliberately allows —
 * a program, which can set any header it likes — and therefore the caller only a bind-address
 * guard can turn away.
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
      done({ outcome: 'accepted', text, message });
    });
  });
}

// ─── A project with contents worth not publishing ─────────────

const workdir = mkdtempSync(join(tmpdir(), 'check-board-reads-guard-'));
const projectPath = join(workdir, 'a-board-the-network-should-not-read');
mkdirSync(join(projectPath, 'notes'), { recursive: true });

/** The four strings. Each one is served by a different route, and none may leave off loopback. */
const SECRET_TEXT = 'the-drawing-the-network-should-not-read';
const SECRET_DOC = 'the-document-the-network-should-not-read';
const SECRET_SHAPE = 'the-library-shape-the-network-should-not-read';
const SECRET_IMAGE_ID = 'the-image-the-network-should-not-read';
// A 1x1 PNG is enough: what matters is that a dataURL exists under an id a route will serve.
const SECRET_IMAGE_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'C0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TEXT_ELEMENT_ID = 'secret-text-element';

writeFileSync(join(projectPath, 'board.config.json'), JSON.stringify({
  name: 'Reads',
  board: 'board.excalidraw',
  docsDir: 'notes',
  library: 'shapes.excalidrawlib',
}), 'utf8');

writeFileSync(join(projectPath, 'board.excalidraw'), JSON.stringify({
  type: 'excalidraw',
  version: 2,
  source: 'check-board-reads-guard',
  elements: [
    {
      id: TEXT_ELEMENT_ID, type: 'text', x: 0, y: 0, width: 400, height: 25,
      text: SECRET_TEXT, originalText: SECRET_TEXT, fontSize: 20, fontFamily: 1,
    },
    {
      id: 'secret-image-element', type: 'image', x: 0, y: 60, width: 10, height: 10,
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
  workspaces: [{ id: 'reads', path: projectPath }],
}), 'utf8');

/** Every read this issue is about, as a caller writes it. The board is the header above. */
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
];

const SECRETS = [SECRET_TEXT, SECRET_DOC, SECRET_SHAPE, SECRET_IMAGE_DATA.slice(-40)];

const [loopbackPort, offPort] = await freePorts(2);
// The library is the project's own alone: the packaged one would be served here too, and a
// shape this check did not put on the board is not evidence about this check's board.
const env = { EXCALIDRAW_WORKSPACES: registryPath, EXCALIDRAW_LIBRARY: '', LOG_LEVEL: 'error' };

let loopback;
let off;

try {
  const offHost = await offLoopbackHost();

  // ─── 1. Bound to loopback, every read answers as it does today ───

  console.log('\n1. bound to loopback, every read answers exactly as it does today');
  loopback = startCanvas({ port: loopbackPort, cwd: workdir, env });
  await waitForHealth(loopback.base, loopback.child);

  // The snapshot is taken here rather than seeded: snapshots live in memory, so the only way a
  // server has one to be asked for is to have been told to take it.
  const saved = await post(loopback.base, '/api/snapshots', { name: 'before-the-network' });
  check('a snapshot of the seeded board was taken', saved.status === 200,
        `${saved.status} ${saved.text.slice(0, 160)}`);

  const answers = new Map();
  for (const [name, path] of READS) {
    const answer = await get(loopback.base, path);
    answers.set(name, answer);
    check(`${name} answers 200`, answer.status === 200, `got ${answer.status} — ${answer.text.slice(0, 160)}`);
  }

  check('the board came back on GET /api/elements',
        answers.get('GET /api/elements')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/elements')?.text.slice(0, 200));
  check('and on the unfiltered search, which is the same board by another door',
        answers.get('GET /api/elements/search')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/elements/search')?.text.slice(0, 200));
  check('and one element by id', answers.get('GET /api/elements/:id')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/elements/:id')?.text.slice(0, 200));
  check('the image is served', answers.get('GET /api/files/:id')?.text.includes(SECRET_IMAGE_DATA),
        answers.get('GET /api/files/:id')?.text.slice(0, 120));
  check('and listed for this board',
        answers.get('GET /api/files')?.text.includes(SECRET_IMAGE_ID),
        answers.get('GET /api/files')?.text.slice(0, 120));
  check('the document is served', answers.get('GET /api/docs/:key')?.text.includes(SECRET_DOC),
        answers.get('GET /api/docs/:key')?.text.slice(0, 200));
  check('the library shape is served', answers.get('GET /api/library')?.text.includes(SECRET_SHAPE),
        answers.get('GET /api/library')?.text.slice(0, 200));
  check('the snapshot is listed', answers.get('GET /api/snapshots')?.text.includes('before-the-network'),
        answers.get('GET /api/snapshots')?.text.slice(0, 200));
  check('and reads back holding the board',
        answers.get('GET /api/snapshots/:name')?.text.includes(SECRET_TEXT),
        answers.get('GET /api/snapshots/:name')?.text.slice(0, 200));

  // ─── 3a. The socket, on loopback ───

  console.log('\n2. the socket hands a loopback client the board, which is what it is for');
  const openSocket = await socketVerdict(`ws://127.0.0.1:${loopbackPort}/?workspace=reads`);
  check('the upgrade is accepted', openSocket.outcome === 'accepted', JSON.stringify(openSocket));
  check('and initial_elements carries the board', String(openSocket.text ?? '').includes(SECRET_TEXT),
        String(openSocket.text ?? '').slice(0, 200));

  loopback.stop();

  // ─── 2. Bound anywhere else, every one of them refuses ───

  console.log(`\n3. bound to ${offHost}, every read refuses before it reads anything`);
  off = startCanvas({ port: offPort, cwd: workdir, env: { ...env, HOST: offHost } });
  const offBase = `http://${offHost}:${offPort}`;
  await waitForHealth(offBase, off.child);

  // The same snapshot, so the refusal below is a refusal to hand over something that is there.
  // The writes are not this issue's subject and are not guarded here; if that changes, this
  // server simply holds no snapshot and the read still has to answer 403.
  await post(offBase, '/api/snapshots', { name: 'before-the-network' });

  const health = await get(offBase, '/health');
  check('the canvas itself is up — this is a guard, not a broken server', health.status === 200,
        `${health.status} ${health.text.slice(0, 120)}`);

  for (const [name, path] of READS) {
    const refused = await get(offBase, path);
    check(`${name} answers 403`, refused.status === 403,
          `got ${refused.status} — ${refused.text.slice(0, 160)}`);
    check(`  ${name} refuses in the words of the bind`, /loopback/i.test(refused.text),
          refused.text.slice(0, 160));
    const leaked = SECRETS.filter((secret) => refused.text.includes(secret));
    check(`  ${name} leaks none of the board into the refusal`, leaked.length === 0,
          leaked.join(', '));
  }

  // ─── 3b. The socket, off loopback ───

  console.log(`\n4. and the socket, which is the same read by a door HTTP guards cannot see`);
  const refusedSocket = await socketVerdict(`ws://${offHost}:${offPort}/?workspace=reads`);
  check('the upgrade is refused', refusedSocket.outcome === 'refused',
        JSON.stringify(refusedSocket).slice(0, 240));
  check('no initial_elements arrived, so no board did either',
        !String(refusedSocket.text ?? '').includes(SECRET_TEXT),
        String(refusedSocket.text ?? '').slice(0, 200));

  off.stop();
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  if (loopback && process.env.DEBUG_BOARD_READS_GUARD) console.error(loopback.read());
  if (off && process.env.DEBUG_BOARD_READS_GUARD) console.error(off.read());
} finally {
  if (loopback) loopback.stop();
  if (off) off.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  rmSync(workdir, { recursive: true, force: true });
}

// ─── 5. A tenth read cannot be the next one left out ──────────

console.log('\n5. every one of those routes carries the guard in src/server.ts');

const source = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
const declarations = [...source.matchAll(/^app\.(get|post|put|delete|patch)\((['"])([^'"]+)\2/gm)];
check(`src/server.ts declares routes (${declarations.length} found)`, declarations.length > 0);

/** The route bodies, by `METHOD /path`, each running to wherever the next route begins. */
const bodyOf = new Map();
declarations.forEach(([, method, , path], index) => {
  const from = declarations[index].index;
  const to = index + 1 < declarations.length ? declarations[index + 1].index : source.length;
  bodyOf.set(`${method.toUpperCase()} ${path}`, source.slice(from, to));
});

const unguarded = [];
for (const [name] of READS) {
  const body = bodyOf.get(name);
  if (body === undefined) { unguarded.push(`${name} (no such route)`); continue; }
  // A *call* — `offLoopback(res, 'The board is read')` — for the reason
  // `check-workspaces-guard.mjs` gives: matching the bare name counts a declaration.
  if (!/offLoopback\(res,\s*['"]/.test(body)) unguarded.push(name);
}
check('no read in that set lacks an offLoopback call', unguarded.length === 0, unguarded.join(', '));

const upgradeStart = source.indexOf('new WebSocketServer(');
const upgrade = source.slice(upgradeStart, source.indexOf('// Middleware', upgradeStart));
check('and the socket upgrade asks the same question of the bind',
      /boundToLoopback\(\)/.test(upgrade), upgrade.slice(0, 200));

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: a board bound off loopback publishes none of what it holds.');
