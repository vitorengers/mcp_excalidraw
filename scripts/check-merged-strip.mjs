#!/usr/bin/env node
/**
 * Checks that one board can be pointed at another, and that the tab strip then answers for both
 * machines without ever manufacturing a board for one it does not own.
 *
 * Two servers, on ports the kernel just handed out, paired **for real**: the asking board runs
 * the device half of the handshake through `POST /api/peers`, the operator approves on the other
 * machine over that machine's own loopback, and the credential the approval mints is the only
 * thing that gets this board its neighbour's projects afterwards. The asking board reaches the
 * other one at the address `offLoopbackHost()` returns rather than at `127.0.0.1`, so the
 * credential is genuinely consulted rather than waved through as a caller on the machine.
 *
 * Four things are asserted, and each of them is a different way for this to go wrong quietly:
 *
 *  - **the gesture answers twice.** `POST /api/peers` comes back with the code the operator has
 *    to compare on the other screen and with no peer at all; the peer appears on `GET /api/peers`
 *    only after the other end approved. A route that answered with a peer straight away would be
 *    one that never asked anybody.
 *  - **the strip holds both machines**, each peer-owned project carrying a liveness state and a
 *    reason of its own — and no absolute path, no path inside a distro, and no distro name. The
 *    project's `error` still means what it always meant, which is why the state is a second
 *    field rather than a sentence written into that one.
 *  - **a machine that stops answering is not a broken project.** The peer is killed; its
 *    projects stop being tabs, what is left is the peer itself carrying `unreachable` and a
 *    reason, `error` is null throughout, and the call still answers inside the stated budget —
 *    because the probe runs on this board's own timer rather than on the request.
 *  - **a peer-owned id is refused rather than answered locally.** `elementsFor` yields an empty
 *    store for an unknown id by design, so a board-scoped route that answered one would show a
 *    blank canvas for a live remote project — and one pointer press arming the autosync would
 *    write that blank scene into a local store and a local `.excalidraw`. Every board-scoped
 *    route refuses it with a stated status and a sentence, and nothing local is made for it.
 *
 * **Load-bearing, and not the happy path:** `EXCALIDRAW_NO_AUTH: undefined` on both boards.
 * `scripts/lib/spawn-canvas.mjs` turns the token off for every check in this directory, and
 * behind it there is no gate for a device credential to be accepted *by* — the peer would serve
 * its projects to anybody who asked and every case here would pass while nothing was consulted.
 *
 * Self-contained: two canvas servers, two throwaway homes, two throwaway registries, all gone at
 * the end. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-merged-strip.mjs
 *
 * Tier: fast
 */

import http from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
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

/** How long the strip may take to answer, whatever any peer is doing. */
const ANSWER_BUDGET_MS = 1000;

/** The namespace a peer's project lives in locally — `core/remote-workspace-id.ts` reserves it. */
const REMOTE_PREFIX = 'peer.';

// ─── The throwaway world ──────────────────────────────────────

const workDir = mkdtempSync(join(tmpdir(), 'check-merged-strip-'));

/** Where a state file has to appear, spelled out from the platform rather than imported. */
function stateFile(home, name) {
  const leaf = process.platform === 'win32' ? 'Excalidraw-Canvas' : 'excalidraw-canvas';
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support') : home;
  return join(base, leaf, name);
}

/** Whether this machine will let a server sit on `host`. */
function canBind(host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

/**
 * An address that is not `127.0.0.1` and that this machine will bind.
 *
 * The point is the *name*: a board reached under an authority nobody approved meets the origin
 * gate rather than the token gate, so pairing has to be what teaches the peer that name. Nothing
 * leaves the machine either way — `127.0.0.2` is a loopback alias, and the interface fallback is
 * this machine's own address.
 */
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
  throw new Error('No address other than 127.0.0.1 could be bound on this machine.');
}

/** One request, over `node:http`, so the address connected to and the `Host` named are ours. */
function call(at, path, { method = 'GET', headers = {}, body = null } = {}) {
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

let log = '';
const running = [];

async function waitFor(fn, what, tries = 200) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}\n${log.slice(-1500)}`);
}

/** The same wait, bounded and never thrown, so one case that never settles is one failure. */
async function settles(fn, tries = 120) {
  for (let attempt = 0; attempt < tries; attempt++) {
    try { const value = await fn(); if (value) return value; } catch { /* not yet */ }
    await sleep(100);
  }
  return null;
}

/** A board with its own home, its own registry and one project in it. */
function board({ port, host, home, project, registry }) {
  mkdirSync(home, { recursive: true });
  mkdirSync(project.path, { recursive: true });
  writeFileSync(join(project.path, 'board.config.json'),
                JSON.stringify({ name: project.id }, null, 1), 'utf8');
  writeFileSync(registry, JSON.stringify({ workspaces: [{ id: project.id, path: project.path }] }),
                'utf8');
  const server = startCanvas({
    port,
    env: {
      HOST: host,
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registry,
      EXCALIDRAW_LIBRARY: '',
      // The gate every assertion about a consulted credential rests on. See the banner.
      EXCALIDRAW_NO_AUTH: undefined,
      // Deliberately unset: the authority the asking board reaches this one under has to come
      // from the approval rather than from an answer written down in advance.
      EXCALIDRAW_ALLOWED_HOSTS: undefined,
      HOME: home,
      USERPROFILE: home,
      LOCALAPPDATA: home,
      XDG_STATE_HOME: home,
    },
  });
  running.push(server.child);
  server.child.stdout.on('data', (chunk) => { log += chunk; });
  server.child.stderr.on('data', (chunk) => { log += chunk; });
  return server;
}

try {
  const offHost = await offLoopbackHost();
  const [portA, portB] = await freePorts(2);

  const homeA = join(workDir, 'home-a');
  const homeB = join(workDir, 'home-b');
  const registryA = join(workDir, 'workspaces-a.json');
  const registryB = join(workDir, 'workspaces-b.json');

  board({
    port: portA,
    host: '127.0.0.1',
    home: homeA,
    registry: registryA,
    project: { id: 'here', path: join(workDir, 'project-here') },
  });
  // Every interface, so the same board is its own operator's on loopback and the asking board's
  // under a name it has never heard of, at the same moment.
  board({
    port: portB,
    host: '0.0.0.0',
    home: homeB,
    registry: registryB,
    project: { id: 'field-notes', path: join(workDir, 'project-field-notes') },
  });

  const here = { address: '127.0.0.1', port: portA };
  const there = { address: '127.0.0.1', port: portB };
  const peerBaseUrl = `http://${offHost}:${portB}`;

  await waitFor(async () => (await fetch(`http://127.0.0.1:${portA}/health`)).ok, 'this board');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${portB}/health`)).ok, 'the peer board');

  const tokenA = readFileSync(stateFile(homeA, `server-${portA}.token`), 'utf-8').trim();
  const tokenB = readFileSync(stateFile(homeB, `server-${portB}.token`), 'utf-8').trim();
  const asA = { [TOKEN_HEADER]: tokenA };
  const asB = { [TOKEN_HEADER]: tokenB };

  // ─── 1. The gesture answers twice ───────────────────────────

  console.log('1. the code comes back before the peer does, and the peer only after an approval');

  const asked = await call(here, '/api/peers', {
    method: 'POST',
    headers: asA,
    body: { name: 'the other machine', baseUrl: peerBaseUrl },
  });
  check('POST /api/peers is accepted', asked.status === 202,
        `${asked.status} ${asked.text.slice(0, 300)}`);
  const attempt = asked.body?.pending ?? null;
  check('and it answers with the code the operator has to compare',
        /^\d{3}-\d{3}$/.test(attempt?.code ?? ''), JSON.stringify(attempt));
  check('the attempt says it is waiting on the other machine', attempt?.state === 'waiting',
        JSON.stringify(attempt));
  check('and no peer exists yet, because nobody has approved anything',
        Array.isArray(asked.body?.peers) ? asked.body.peers.length === 0 : true,
        JSON.stringify(asked.body?.peers));

  const beforeApproval = await call(here, '/api/peers', { headers: asA });
  check('GET /api/peers lists the attempt and no peer',
        beforeApproval.status === 200
        && (beforeApproval.body?.peers ?? []).length === 0
        && (beforeApproval.body?.pending ?? []).length === 1,
        `${beforeApproval.status} ${beforeApproval.text.slice(0, 300)}`);

  const waiting = await settles(async () => {
    const pending = await call(there, '/api/pair/pending', { headers: asB });
    return (pending.body?.requests ?? []).find((entry) => entry.code === attempt?.code) ?? null;
  });
  check('the other machine has a request waiting under that same code', Boolean(waiting),
        JSON.stringify(waiting));
  check('and it arrived under the address this board reached it by',
        waiting?.host === `${offHost}:${portB}`, JSON.stringify(waiting?.host));

  const approved = await call(there, '/api/pair/approve', {
    method: 'POST',
    headers: asB,
    body: { requestId: waiting?.requestId, code: waiting?.code },
  });
  check('the operator approves it on the machine it is about', approved.status === 200,
        `${approved.status} ${approved.text.slice(0, 300)}`);

  const peer = await settles(async () => {
    const listed = await call(here, '/api/peers', { headers: asA });
    return (listed.body?.peers ?? [])[0] ?? null;
  });
  check('the peer appears once the other end approved', Boolean(peer), JSON.stringify(peer));
  check('under the name this operator gave it', peer?.name === 'the other machine',
        JSON.stringify(peer));
  check('and at the address it was registered on', peer?.baseUrl === peerBaseUrl,
        JSON.stringify(peer?.baseUrl));

  const peersFile = stateFile(homeA, 'peers.json');
  const withSecret = existsSync(peersFile) ? readFileSync(peersFile, 'utf-8') : '';
  check('the secret the approval minted is on this machine\'s disk',
        withSecret.includes(`"${peer?.id ?? 'no-peer'}"`) && /"secret":\s*"[^"]+"/.test(withSecret),
        withSecret.slice(0, 300));

  const storedSecret = /"secret":\s*"([^"]+)"/.exec(withSecret)?.[1] ?? '';
  const listed = await call(here, '/api/peers', { headers: asA });
  check('and no route hands it back out',
        storedSecret.length > 0 && !listed.text.includes(storedSecret),
        listed.text.slice(0, 300));

  // ─── 2. The strip answers for both machines ─────────────────

  console.log('\n2. the strip holds both machines, and what crosses is a tab rather than a disk');

  const remoteId = `${REMOTE_PREFIX}${String((peer?.id ?? '').length).padStart(2, '0')}`
    + `.${peer?.id ?? ''}.field-notes`;

  const merged = await settles(async () => {
    const answer = await call(here, '/api/workspaces', { headers: asA });
    const entry = (answer.body?.workspaces ?? []).find((row) => row.id === remoteId);
    return entry ? { answer, entry } : null;
  });
  check('the peer\'s project is on this board\'s strip', Boolean(merged?.entry),
        JSON.stringify((await call(here, '/api/workspaces', { headers: asA })).body?.workspaces));

  const strip = merged?.answer.body?.workspaces ?? [];
  check('and this board\'s own project is still on it',
        strip.some((row) => row.id === 'here'), JSON.stringify(strip.map((row) => row.id)));
  check('the peer-owned project carries a liveness state',
        merged?.entry?.status?.state === 'online', JSON.stringify(merged?.entry?.status));
  check('and a reason a tooltip can show verbatim',
        typeof merged?.entry?.status?.reason === 'string' && merged.entry.status.reason.length > 0,
        JSON.stringify(merged?.entry?.status?.reason));
  check('its error is null, because a project that loads is not broken',
        merged?.entry?.error === null, JSON.stringify(merged?.entry?.error));
  check('it carries no absolute path from the machine that owns it',
        !JSON.stringify(merged?.entry ?? {}).includes(join(workDir, 'project-field-notes')),
        JSON.stringify(merged?.entry));
  check('no innerPath', !merged?.entry?.innerPath, JSON.stringify(merged?.entry?.innerPath));
  check('and no distro name', !JSON.stringify(merged?.entry?.environment ?? {}).includes('distro'),
        JSON.stringify(merged?.entry?.environment));
  check('while this board\'s own project still says where it is',
        strip.find((row) => row.id === 'here')?.path === join(workDir, 'project-here'),
        JSON.stringify(strip.find((row) => row.id === 'here')?.path));

  // ─── 3. An order that spans machines ────────────────────────

  console.log('\n3. the order of the tabs may span machines, and keeps the ids it does not own');

  const ordered = await call(here, '/api/workspaces/order', {
    method: 'PUT',
    headers: asA,
    body: { ids: [remoteId, 'here'] },
  });
  check('PUT /api/workspaces/order accepts an order naming a peer\'s project',
        ordered.status === 200, `${ordered.status} ${ordered.text.slice(0, 300)}`);
  const back = (ordered.body?.workspaces ?? []).map((row) => row.id);
  check('and the list it answers with drops neither id',
        back.includes('here') && back.includes(remoteId), JSON.stringify(back));
  check('the part this board owns is what was written',
        JSON.parse(readFileSync(registryA, 'utf-8')).workspaces.some((entry) => entry.id === 'here'),
        readFileSync(registryA, 'utf-8'));

  // ─── 4. A machine that stops answering ──────────────────────

  console.log('\n4. a peer that goes away loses its tabs and keeps its row, inside the budget');

  const peerServer = running[1];
  peerServer.kill('SIGKILL');
  await sleep(300);

  const gone = await settles(async () => {
    const answer = await call(here, '/api/workspaces', { headers: asA });
    const rows = answer.body?.workspaces ?? [];
    return rows.some((row) => row.id === remoteId) ? null : answer;
  }, 200);
  check('the peer\'s projects stop being tabs', Boolean(gone),
        JSON.stringify((await call(here, '/api/workspaces', { headers: asA })).body?.workspaces));

  const after = gone?.body?.workspaces ?? [];
  const unreachable = after.filter((row) => row.status?.state === 'unreachable');
  check('and exactly one row is left saying so', unreachable.length === 1,
        JSON.stringify(after.map((row) => [row.id, row.status?.state])));
  check('with a reason naming what happened',
        (unreachable[0]?.status?.reason ?? '').length > 0,
        JSON.stringify(unreachable[0]?.status));
  check('error is null throughout, because a sleeping machine is not a broken configuration',
        after.every((row) => row.error === null || row.error === undefined),
        JSON.stringify(after.map((row) => [row.id, row.error])));
  check('and this board\'s own project is untouched', after.some((row) => row.id === 'here'),
        JSON.stringify(after.map((row) => row.id)));

  const startedAt = Date.now();
  const timed = await call(here, '/api/workspaces', { headers: asA });
  const took = Date.now() - startedAt;
  check(`a sleeping peer does not delay the strip past ${ANSWER_BUDGET_MS} ms`,
        timed.status === 200 && took < ANSWER_BUDGET_MS, `took ${took} ms`);

  // Still a registered peer, so this id is the forwarder's to answer (#565) rather than this
  // board's to refuse. Whichever of them answers, what must never come back is 200 with an empty
  // board: that is the reading an operator cannot tell from a project with nothing on it.
  const asleep = await call(here, `/api/elements?workspace=${encodeURIComponent(remoteId)}`,
                            { headers: asA });
  check('a peer-owned id on a machine that is asleep answers a stated status, never a blank board',
        asleep.status !== 200 && asleep.status !== 500,
        `${asleep.status} ${asleep.text.slice(0, 200)}`);
  check('and it is a sentence rather than a stack trace',
        typeof asleep.body?.error === 'string' && asleep.body.error.length > 20,
        asleep.text.slice(0, 200));

  // ─── 5. Forgetting a peer takes the secret with it ──────────

  console.log('\n5. forgetting a peer removes the secret from the file, and only from this end');

  const forgotten = await call(here, `/api/peers/${encodeURIComponent(peer?.id ?? 'none')}`,
                               { method: 'DELETE', headers: asA });
  check('DELETE /api/peers/:id answers', forgotten.status === 200,
        `${forgotten.status} ${forgotten.text.slice(0, 300)}`);

  const withoutSecret = existsSync(peersFile) ? readFileSync(peersFile, 'utf-8') : '';
  check('and the secret is gone from the file\'s bytes',
        !withoutSecret.includes(`"${peer?.id ?? 'no-peer'}"`) && !/"secret"/.test(withoutSecret),
        withoutSecret.slice(0, 300));

  const emptied = await call(here, '/api/peers', { headers: asA });
  check('the peer is off the list', (emptied.body?.peers ?? []).length === 0,
        emptied.text.slice(0, 200));

  const stripAfter = await settles(async () => {
    const answer = await call(here, '/api/workspaces', { headers: asA });
    const rows = answer.body?.workspaces ?? [];
    return rows.every((row) => !row.id.startsWith(REMOTE_PREFIX)) ? rows : null;
  });
  check('and its row is off the strip', Boolean(stripAfter), JSON.stringify(stripAfter));

  // ─── 6. A board nobody can be asked about is refused ────────

  console.log('\n6. a board-scoped route refuses a peer-owned id rather than making one up');

  // With the peer forgotten, `core/peer-proxy.ts` (#565) deliberately stops routing this id and
  // lets it fall through — which is exactly the request that used to be answered out of the empty
  // store `elementsFor` makes for an unknown id. That fall-through is the surviving half of the
  // hazard, and it is what these cases are about; the forwarded half is #565's own check.
  const read = await call(here, `/api/elements?workspace=${encodeURIComponent(remoteId)}`,
                          { headers: asA });
  check('GET /api/elements for a peer-owned id is refused with a stated status',
        read.status === 421, `${read.status} ${read.text.slice(0, 300)}`);
  check('and never 200 with an empty board, which is the failure this closes',
        read.status !== 200, read.text.slice(0, 300));
  check('the refusal is a sentence the page can render',
        typeof read.body?.error === 'string' && read.body.error.length > 20,
        JSON.stringify(read.body));

  const written = await call(here, `/api/elements/sync?workspace=${encodeURIComponent(remoteId)}`, {
    method: 'POST',
    headers: asA,
    body: { elements: [] },
  });
  check('and so is the autosync write that would have overwritten it',
        written.status === 421, `${written.status} ${written.text.slice(0, 200)}`);

  const headerNamed = await call(here, '/api/elements', {
    headers: { ...asA, 'x-workspace-id': remoteId },
  });
  check('naming the board by header rather than by query is the same refusal',
        headerNamed.status === 421, `${headerNamed.status} ${headerNamed.text.slice(0, 200)}`);

  const stateDirA = join(workDir, 'workspaces-a-state');
  const saved = existsSync(stateDirA) ? readdirSync(stateDirA) : [];
  check('no board-state file was made for it',
        !saved.some((name) => name.startsWith(REMOTE_PREFIX)), saved.join(', '));

  const local = await call(here, '/api/elements', { headers: asA });
  check('and the local store is still empty', (local.body?.elements ?? []).length === 0,
        `${local.status} ${local.text.slice(0, 200)}`);

  const runs = await call(here, '/api/implement', { headers: asA });
  check('no implement record was made for it either',
        !JSON.stringify(runs.body ?? {}).includes(REMOTE_PREFIX), runs.text.slice(0, 200));

  // ─── 7. Only the operator, on this machine ──────────────────

  console.log('\n7. all three routes are the operator\'s, from the machine the board runs on');

  // Through the existing funnel rather than through a second copy of the rule, which is a claim
  // about the source and is therefore asked of the source. It is also the half of this section
  // that can be answered on a machine with nothing but a loopback alias to reach itself by.
  const serverSource = readFileSync(join(repoRoot, 'src', 'server.ts'), 'utf8');
  const declarations = [...serverSource.matchAll(/^app\.(get|post|put|delete)\('(\/api\/peers[^']*)'/gm)];
  check('there are three peer routes and no more',
        declarations.length === 3, declarations.map((entry) => entry[2]).join(', '));
  for (const declaration of declarations) {
    const from = declaration.index;
    const next = serverSource.indexOf('\napp.', from + 1);
    const body = serverSource.slice(from, next === -1 ? serverSource.length : next);
    check(`${declaration[1].toUpperCase()} ${declaration[2]} goes through notTheHost`,
          /notTheHost\(req, res,\s*['"]/.test(body),
          'a second copy of the rule is a second chance for one of them to drift');
  }

  const remoteCaller = { address: offHost, port: portA };
  const reachable = await canBind(offHost);
  if (!reachable || offHost.startsWith('127.')) {
    console.log('  note  the only address available here is a loopback alias, which is *on* this');
    console.log('        machine — the caller guard is asked by scripts/check-pairing-handshake.mjs');
  } else {
    for (const [what, probe] of [
      ['GET /api/peers', { path: '/api/peers' }],
      ['POST /api/peers', { path: '/api/peers', method: 'POST', body: { name: 'x', baseUrl: 'http://x:1' } }],
      ['DELETE /api/peers/:id', { path: '/api/peers/anything', method: 'DELETE' }],
    ]) {
      const refused = await call(remoteCaller, probe.path, { ...probe, headers: asA });
      check(`${what} is refused to a caller that is not on this machine`, refused.status === 403,
            `${refused.status} ${refused.text.slice(0, 200)}`);
    }
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(400);
  // Guarded, because a teardown is not a verdict (#472).
  try { rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  catch { /* the directory outlives the run and costs nothing else */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
