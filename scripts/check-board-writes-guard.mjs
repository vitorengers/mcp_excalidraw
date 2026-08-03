#!/usr/bin/env node
/**
 * A board bound off loopback cannot be drawn on either.
 *
 * #366 guarded every **read** of board contents behind the bind and deliberately stopped there,
 * which left a board bound to an interface as something odd: nobody on the network could read it,
 * and anybody reaching the port could still draw on it, empty it and fill its file store. #456 is
 * where the same question was put to the writes, and the answer is the same one: **they are
 * guarded too.** A non-loopback bind now answers nothing at all under `/api` — which is what #366
 * already said such a bind is worth — rather than being readable by nobody and writable by
 * anybody.
 *
 * The other option was to leave them open and write it down, and `docs/rest-api.md` had been
 * doing exactly that in one sentence since #366. A sentence is not a decision: the asymmetry was
 * the shape the routes happened to have, and the half that was easier to notice is not the half
 * that matters. `DELETE /api/elements/clear` takes a copy first, so it is recoverable — it still
 * empties the board of everyone looking at it.
 *
 * The writes are not one route either. Fourteen doors reach the same board:
 *
 *   - `POST /api/elements`, `PUT /api/elements/:id`, `DELETE /api/elements/:id`
 *   - `DELETE /api/elements/clear`, `POST /api/elements/batch`, `POST /api/elements/from-mermaid`,
 *     `POST /api/elements/sync`
 *   - `POST /api/files`, `DELETE /api/files/:id` — the image store
 *   - `POST /api/snapshots`
 *   - the four round-trips: `POST /api/export/image` and `/api/viewport`, which ask the browser to
 *     do something, and their two `/result` routes, which are how an answer gets back in
 *
 * The `/result` pair is guarded with the rest rather than excused as "the browser answering". The
 * browser that would answer cannot open its socket off loopback at all since #366, so nothing is
 * lost; what is refused is a network caller resolving somebody else's pending export by guessing
 * a request id.
 *
 * Four servers over one registry and two seeded projects:
 *
 *   1. bound to loopback — every write answers exactly as it does today, and the board it
 *      changed says so afterwards. This is the half the guard has to keep working.
 *   2. bound off loopback, over a second project — every one answers 403, the refusal names the
 *      bind and carries none of the board, and then a **fresh loopback server over that same
 *      project** finds the board exactly as it was seeded: not drawn on, not synced over, not
 *      emptied. A 403 that still wrote would be a status code rather than a guard.
 *   3. **bound off loopback with the token on**, which is the shipped configuration since #350: a
 *      caller carrying this start's own secret is refused all the same. The bind is a second
 *      answer rather than the token's shadow, and it is the only one left where
 *      `VIBEMAXXING_NO_AUTH` is set — which is every check in this directory.
 *   4. read off `src/server.ts` rather than off a server: each of those routes carries an
 *      `offLoopback` call, so a fifteenth write added beside them cannot be the next one left out.
 *
 * **The off-loopback server is bound to `127.0.0.2`, not to a real interface**, for the reason
 * `check-board-reads-guard.mjs` and `check-workspaces-guard.mjs` both give: the guard's question
 * is `LOOPBACK_ADDRESSES.includes(HOST)` over a list that is `127.0.0.1` and `::1` exactly, so
 * `127.0.0.2` is off loopback to the code under test while never leaving this machine. Where a
 * platform will not bind a loopback alias, the first real interface is the fallback and the check
 * says so on stdout.
 *
 * Self-contained: it builds a throwaway registry and two projects in a temp directory, starts its
 * own servers on ports the kernel just handed out and kills them. No browser. Run
 * `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-board-writes-guard.mjs
 *
 * Tier: fast
 */

import { createServer } from 'node:net';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * A request against one board, named in the header rather than in the query.
 *
 * The header is the third form `workspaceIdFrom()` accepts and the one that means the same thing
 * to every route here, which is what `check-board-reads-guard.mjs` settled for the reads.
 */
async function call(base, method, path, workspace, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-workspace-id': workspace,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, text, json };
}

const get = (base, path, workspace) => call(base, 'GET', path, workspace);

// ─── Two projects worth not letting the network change ────────

const workdir = mkdtempSync(join(tmpdir(), 'check-board-writes-guard-'));

/** What is seeded on a board, and what has to still be there after the network has tried. */
const SEEDED_TEXT = 'the-drawing-the-network-should-not-change';
const SEEDED_IMAGE_ID = 'the-image-the-network-should-not-touch';
// A 1x1 PNG is enough: what matters is that a board comes up holding a file at all.
const SEEDED_IMAGE_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'
  + 'C0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const SEEDED_TEXT_ID = 'seeded-text-element';
const SEEDED_ELEMENT_COUNT = 2;

/** What a caller off loopback tries to leave behind, and what proves it did not. */
const DRAWN_ID = 'drawn-by-the-network';
const DRAWN_TEXT = 'the-drawing-the-network-put-there';
const BATCHED_ID = 'drawn-by-the-network-in-a-batch';
const SYNCED_ID = 'synced-over-the-board-by-the-network';
const SYNCED_TEXT = 'the-board-the-network-synced-over-it';
const PUSHED_FILE_ID = 'the-image-the-network-pushed';

function seedProject(name) {
  const projectPath = join(workdir, name);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, 'board.config.json'), JSON.stringify({
    name,
    board: 'board.excalidraw',
  }), 'utf8');
  writeFileSync(join(projectPath, 'board.excalidraw'), JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'check-board-writes-guard',
    elements: [
      {
        id: SEEDED_TEXT_ID, type: 'text', x: 0, y: 0, width: 400, height: 25,
        text: SEEDED_TEXT, originalText: SEEDED_TEXT, fontSize: 20, fontFamily: 1,
      },
      {
        id: 'seeded-image-element', type: 'image', x: 0, y: 60, width: 10, height: 10,
        fileId: SEEDED_IMAGE_ID,
      },
    ],
    files: {
      [SEEDED_IMAGE_ID]: {
        id: SEEDED_IMAGE_ID, dataURL: SEEDED_IMAGE_DATA, mimeType: 'image/png', created: 1,
      },
    },
  }, null, 1), 'utf8');
  return projectPath;
}

/**
 * Three boards, because emptying one is not a write like the others.
 *
 * `writes` is the half that has to keep working, and section 1 ends by clearing it on purpose.
 * `untouched` takes the thirteen writes that add or change something off loopback, so that what
 * a later loopback server reads back is the whole answer to "did any of them land". The clear
 * goes at `emptied` on its own: pointed at `untouched` it would take everything the other twelve
 * had put there back off again, and a board that ends up looking seeded because two defects
 * cancelled is not evidence about either.
 */
const writablePath = seedProject('writes');
const untouchedPath = seedProject('untouched');
const emptiedPath = seedProject('emptied');

const registryPath = join(workdir, 'workspaces.json');
const stateDir = join(workdir, 'workspaces-state');
writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    { id: 'writes', path: writablePath },
    { id: 'untouched', path: untouchedPath },
    { id: 'emptied', path: emptiedPath },
  ],
}), 'utf8');

/**
 * Every write this issue is about, as a caller writes it, in an order one server can run.
 *
 * `expect` is what a loopback server answers **today** — which for the four round-trips is not
 * 200: with no browser on the board there is nobody to ask, and a `/result` for a request id
 * nobody is waiting on is ignored on purpose. Guarding a route must not change any of that.
 */
const WRITES = [
  ['POST /api/elements', 'POST', '/api/elements', {
    id: DRAWN_ID, type: 'text', x: 10, y: 200, width: 400, height: 25,
    text: DRAWN_TEXT, fontSize: 20,
  }, 200],
  ['PUT /api/elements/:id', 'PUT', `/api/elements/${DRAWN_ID}`, { x: 40 }, 200],
  ['DELETE /api/elements/:id', 'DELETE', `/api/elements/${DRAWN_ID}`, undefined, 200],
  ['POST /api/elements/batch', 'POST', '/api/elements/batch', {
    elements: [{ id: BATCHED_ID, type: 'rectangle', x: 10, y: 300, width: 50, height: 50 }],
  }, 200],
  ['POST /api/elements/from-mermaid', 'POST', '/api/elements/from-mermaid', {
    mermaidDiagram: 'graph TD;\n  A-->B;\n',
  }, 200],
  ['POST /api/elements/sync', 'POST', '/api/elements/sync', {
    elements: [{
      id: SYNCED_ID, type: 'text', x: 0, y: 400, width: 400, height: 25,
      text: SYNCED_TEXT, fontSize: 20, version: 99,
    }],
    timestamp: new Date().toISOString(),
  }, 200],
  ['POST /api/files', 'POST', '/api/files', {
    files: [{ id: PUSHED_FILE_ID, dataURL: SEEDED_IMAGE_DATA, mimeType: 'image/png' }],
  }, 200],
  ['DELETE /api/files/:id', 'DELETE', `/api/files/${PUSHED_FILE_ID}`, undefined, 200],
  ['POST /api/snapshots', 'POST', '/api/snapshots', { name: 'taken-by-the-network' }, 200],
  ['POST /api/export/image', 'POST', '/api/export/image', { format: 'png' }, 503],
  ['POST /api/export/image/result', 'POST', '/api/export/image/result', {
    requestId: 'nobody-is-waiting-on-this', format: 'png', data: 'x',
  }, 200],
  ['POST /api/viewport', 'POST', '/api/viewport', { scrollToContent: true }, 503],
  ['POST /api/viewport/result', 'POST', '/api/viewport/result', {
    requestId: 'nobody-is-waiting-on-this', success: true, message: 'done',
  }, 200],
  // Last on the loopback server, because it empties the board the ones above wrote to.
  ['DELETE /api/elements/clear', 'DELETE', '/api/elements/clear', undefined, 200],
];

/** None of these may appear in a refusal, and none may reach the board it was aimed at. */
const INTRUDERS = [DRAWN_TEXT, BATCHED_ID, SYNCED_TEXT, PUSHED_FILE_ID];

/** Which board each one is aimed at off loopback. The clear stands alone; see the note above. */
const offBoardOf = (name) => (name === 'DELETE /api/elements/clear' ? 'emptied' : 'untouched');

const [loopbackPort, offPort, reReadPort, authedPort] = await freePorts(4);
const env = { EXCALIDRAW_WORKSPACES: registryPath, EXCALIDRAW_LIBRARY: '', LOG_LEVEL: 'error' };

/** The home the token-carrying server below is told it has, so its secret lands in here. */
const fakeHome = join(workdir, 'home');
mkdirSync(fakeHome, { recursive: true });

/**
 * Where that server writes its token, spelled out from the platform rather than asked of the code
 * under test — the same three answers `stateDir()` gives, as `check-token-auth.mjs` spells them.
 */
function conventionalTokenFile(port) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const home = process.platform === 'darwin'
    ? join(fakeHome, 'Library', 'Application Support')
    : fakeHome;
  return join(home, leaf, `server-${port}.token`);
}

let loopback;
let off;
let reRead;
let authed;

try {
  const offHost = await offLoopbackHost();

  // ─── 1. Bound to loopback, every write answers as it does today ───

  console.log('\n1. bound to loopback, every write answers exactly as it does today');
  loopback = startCanvas({ port: loopbackPort, cwd: workdir, env });
  await waitForHealth(loopback.base, loopback.child);

  const answers = new Map();
  for (const [name, method, path, body, expect] of WRITES) {
    const answer = await call(loopback.base, method, path, 'writes', body);
    answers.set(name, answer);
    check(`${name} answers ${expect}`, answer.status === expect,
          `got ${answer.status} — ${answer.text.slice(0, 160)}`);
  }

  check('the element it created came back under the id it was given',
        answers.get('POST /api/elements')?.json?.element?.id === DRAWN_ID,
        answers.get('POST /api/elements')?.text.slice(0, 160));
  check('the update moved it', answers.get('PUT /api/elements/:id')?.json?.element?.x === 40,
        answers.get('PUT /api/elements/:id')?.text.slice(0, 160));
  check('the batch reported what it stored',
        answers.get('POST /api/elements/batch')?.json?.count === 1,
        answers.get('POST /api/elements/batch')?.text.slice(0, 160));
  check('the file store took the image',
        answers.get('POST /api/files')?.json?.count === 1,
        answers.get('POST /api/files')?.text.slice(0, 160));
  check('and gave it back', answers.get('DELETE /api/files/:id')?.json?.success === true,
        answers.get('DELETE /api/files/:id')?.text.slice(0, 160));
  check('the snapshot was taken off the board as it then was',
        typeof answers.get('POST /api/snapshots')?.json?.elementCount === 'number',
        answers.get('POST /api/snapshots')?.text.slice(0, 160));
  check('the clear said how much it took and where the copy went',
        answers.get('DELETE /api/elements/clear')?.json?.count > 0
        && Boolean(answers.get('DELETE /api/elements/clear')?.json?.backup),
        answers.get('DELETE /api/elements/clear')?.text.slice(0, 160));

  const cleared = await get(loopback.base, '/api/elements', 'writes');
  check('and the board is empty afterwards — these are real writes, not accepted no-ops',
        cleared.json?.count === 0, cleared.text.slice(0, 160));

  loopback.stop();

  // ─── 2. Bound anywhere else, every one of them refuses ───

  console.log(`\n2. bound to ${offHost}, every write refuses before it writes anything`);
  off = startCanvas({ port: offPort, cwd: workdir, env: { ...env, HOST: offHost } });
  const offBase = `http://${offHost}:${offPort}`;
  await waitForHealth(offBase, off.child);

  const health = await get(offBase, '/health', 'untouched');
  check('the canvas itself is up — this is a guard, not a broken server', health.status === 200,
        `${health.status} ${health.text.slice(0, 120)}`);

  for (const [name, method, path, body] of WRITES) {
    const refused = await call(offBase, method, path, offBoardOf(name), body);
    check(`${name} answers 403`, refused.status === 403,
          `got ${refused.status} — ${refused.text.slice(0, 160)}`);
    check(`  ${name} refuses in the words of the bind`, /loopback/i.test(refused.text),
          refused.text.slice(0, 160));
    const echoed = INTRUDERS.filter((mark) => refused.text.includes(mark));
    check(`  ${name} does not echo what it was handed`, echoed.length === 0, echoed.join(', '));
  }

  // The board is written back to disk a second after it changes, so a refusal that had
  // nevertheless landed would be on disk by the time this server is stopped.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  off.stop();
  await new Promise((resolve) => setTimeout(resolve, 500));

  // ─── 2b. And that board, read back by a server that may read ───

  console.log('\n3. a loopback server over those same projects finds both boards as they were '
              + 'seeded');
  reRead = startCanvas({ port: reReadPort, cwd: workdir, env });
  await waitForHealth(reRead.base, reRead.child);

  const after = await get(reRead.base, '/api/elements', 'untouched');
  check('it answers at all', after.status === 200, `${after.status} ${after.text.slice(0, 160)}`);
  check('the seeded drawing is still on it', after.text.includes(SEEDED_TEXT),
        after.text.slice(0, 200));
  check('and it is the whole of what is on it', after.json?.count === SEEDED_ELEMENT_COUNT,
        `${after.json?.count} elements, expected ${SEEDED_ELEMENT_COUNT}`);
  const landed = INTRUDERS.filter((mark) => after.text.includes(mark));
  check('so nothing the network drew, batched or synced reached it', landed.length === 0,
        landed.join(', '));

  const afterFiles = await get(reRead.base, '/api/files', 'untouched');
  check('the image store still holds the board\'s own image',
        afterFiles.text.includes(SEEDED_IMAGE_ID), afterFiles.text.slice(0, 160));

  const emptied = await get(reRead.base, '/api/elements', 'emptied');
  check('the board the clear was aimed at is still there',
        emptied.json?.count === SEEDED_ELEMENT_COUNT && emptied.text.includes(SEEDED_TEXT),
        `${emptied.json?.count} elements — ${emptied.text.slice(0, 160)}`);

  /**
   * And it was never emptied in the first place.
   *
   * The count above cannot say that on its own: `chooseSeed` falls back to the project's tracked
   * board file when the saved state has nothing in it, so a board that *was* cleared comes back
   * looking seeded. The copy the route takes before it empties anything is the thing that only
   * exists if the clear ran — `<id>.cleared-<stamp>.excalidraw`, beside the saved state.
   */
  const copies = existsSync(stateDir)
    ? readdirSync(stateDir).filter((name) => name.startsWith('emptied.cleared-'))
    : [];
  check('and the clear never ran on it — it took no copy before emptying anything',
        copies.length === 0, copies.join(', '));

  reRead.stop();

  // ─── 3. The bind guard is not the token's shadow ───

  console.log('\n4. and a caller holding this start\'s token is refused there just the same');
  authed = startCanvas({
    port: authedPort,
    cwd: workdir,
    env: {
      ...env,
      HOST: offHost,
      // `canvasEnvironment` turns the token off for every check in this directory; this is the one
      // server here that has to take it back on, because the question of this section is whether
      // the bind guard survives the control that was supposed to make it unnecessary.
      EXCALIDRAW_NO_AUTH: undefined,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
    },
  });
  const authedBase = `http://${offHost}:${authedPort}`;
  await waitForHealth(authedBase, authed.child);

  const tokenFile = conventionalTokenFile(authedPort);
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  check('this start wrote a token, so the caller below is an entitled one', token.length > 0,
        tokenFile);

  const entitled = await fetch(`${authedBase}/api/elements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-id': 'untouched',
      'x-vibemaxxing-token': token,
    },
    body: JSON.stringify({
      id: DRAWN_ID, type: 'text', x: 10, y: 200, width: 400, height: 25, text: DRAWN_TEXT,
    }),
  });
  const entitledText = await entitled.text();
  check('POST /api/elements answers 403 even with the token', entitled.status === 403,
        `got ${entitled.status} — ${entitledText.slice(0, 160)}`);

  const entitledClear = await fetch(`${authedBase}/api/elements/clear`, {
    method: 'DELETE',
    headers: { 'x-workspace-id': 'untouched', 'x-vibemaxxing-token': token },
  });
  check('and so does the one that empties the board', entitledClear.status === 403,
        `got ${entitledClear.status} — ${(await entitledClear.text()).slice(0, 160)}`);

  authed.stop();
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.DEBUG_BOARD_WRITES_GUARD) {
    for (const server of [loopback, off, reRead, authed]) if (server) console.error(server.read());
  }
} finally {
  for (const server of [loopback, off, reRead, authed]) if (server) server.stop();
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Guarded, because a teardown is not a verdict (#472): Windows releases a killed server's
  // handles on its state directory asynchronously, and `run-checks.mjs` reaps what is left.
  try { rmSync(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the directory outlives the run and costs nothing else */ }
}

// ─── 4. A fifteenth write cannot be the next one left out ──────

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
for (const [name] of WRITES) {
  const body = bodyOf.get(name);
  if (body === undefined) { unguarded.push(`${name} (no such route)`); continue; }
  // A *call* — `offLoopback(res, 'The board is drawn on')` — for the reason
  // `check-workspaces-guard.mjs` gives: matching the bare name counts a declaration.
  if (!/offLoopback\(res,\s*['"]/.test(body)) unguarded.push(name);
}
check('no write in that set lacks an offLoopback call', unguarded.length === 0, unguarded.join(', '));

console.log('');
if (failures) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log('All cases passed: a board bound off loopback cannot be drawn on either.');
