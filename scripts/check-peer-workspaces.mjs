#!/usr/bin/env node
/**
 * Checks that one peer's projects become tabs, and that a peer which does not answer contributes
 * **zero projects and one liveness state** rather than a project carrying an `error`.
 *
 * That second sentence is the whole issue, and it is a decision about one field name.
 * `Workspace.error` is what `core/workspaces.ts` sets when a project's *configuration* cannot be
 * resolved. It already drives the `!` glyph and the `--broken` underline on a tab, and it gates
 * real behaviour: an implement run refuses outright on a project carrying one, and the
 * implementation queue treats that board as unusable. Writing *the laptop is asleep* into it would
 * dress a transient fact about a network in the clothes of a permanent fact about a configuration
 * — and the moment the host's own projects and a peer's share a code path, a laptop in a bag would
 * start refusing runs the way a broken `board.config.json` does. So the states from
 * `core/peer-liveness.ts` travel **beside** the projection, never inside it.
 *
 * The other half is what the module must not do. `elementsFor` yields an empty store for an
 * unknown id **by design** — it is documented as deliberately forgiving — and eleven sibling maps
 * are created on first use the same way. So a stray local read here does not fail: it manufactures
 * a plausible blank board for a project another machine owns. Nothing in this module may read or
 * write an element store, a board-state file, a terminal session or an implement record, and the
 * last section proves it by asking the **local** server about every namespaced id afterwards.
 *
 * The cases:
 *
 *   - **the module**: its surface, its budget as a named constant, and a source that names no
 *     store, no board state, no terminal and no implement record — and no `process.env`;
 *   - **the tabs**: two of the peer's projects become two tabs with namespaced ids, projected
 *     fields, the peer's own spelling retained beside the local one, and one liveness state each;
 *   - **what does not cross**: a peer answering with fat records — paths, a distro, agent settings
 *     — contributes none of them, because every record goes through
 *     `core/remote-workspace-view.ts` rather than being forwarded;
 *   - **the collision**: two peers each holding a folder of the same name yield two different
 *     local ids, constructed deliberately rather than assumed impossible;
 *   - **the bullet**: a peer that is not there yields zero projects and one liveness state, and
 *     every `error` anywhere in the answer is null;
 *   - **the budget**: a transport that never answers does not hold the answer past the stated
 *     budget, and what comes back is still a liveness state rather than an error;
 *   - **the real half**: two boards on ports the kernel just handed out, the peer seeded with two
 *     projects, driven with **no seams passed at all** — so the defaulted transport is exercised
 *     against a real server. The peer is then killed and the same call is asserted again. Finally
 *     the *local* board is asked for the elements of every namespaced id, and for its own project
 *     list, proving that nothing here manufactured a blank board or registered a peer's project.
 *
 * Self-contained: its own canvas servers on ports the kernel just handed out, all killed at the
 * end. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-peer-workspaces.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { freePorts } from './lib/free-port.mjs';
import { startCanvas } from './lib/spawn-canvas.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The four answers `core/peer-liveness.ts` produces, and there is no fifth. */
const STATES = ['checking', 'online', 'unreachable', 'refused'];

/** Every `error` anywhere in a value, however deep. The bullet is asserted against this. */
function errorsIn(value, found = []) {
  if (Array.isArray(value)) {
    for (const item of value) errorsIn(item, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'error') found.push(inner);
      errorsIn(inner, found);
    }
    return found;
  }
  return found;
}

/** A liveness desk that says one thing, and remembers what it was asked. */
function deskSaying(state, reason = 'because this case says so') {
  const answer = { state, reason, at: 1_000 };
  const desk = {
    asked: [],
    state: () => answer,
    check: async (target) => { desk.asked.push(target); return answer; },
    forget: () => {}
  };
  return desk;
}

/** A transport that answers with what the case decided, and records the target it was given. */
function transportSaying(reply) {
  const call = async (target) => {
    call.asked.push(target);
    return typeof reply === 'function' ? reply() : reply;
  };
  call.asked = [];
  return call;
}

const running = [];

async function startBoard(port, env = {}, cwd = repoRoot) {
  const server = startCanvas({ port, cwd, env: { LOG_LEVEL: 'error', ...env } });
  running.push(server.child);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) {
      throw new Error(`a board exited early:\n${server.read()}`);
    }
    try {
      if ((await fetch(`${server.base}/health`)).ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`a board never answered on ${server.base}:\n${server.read()}`);
}

// ─── 0. The module, and what it is allowed to know ────────────

console.log('0. the module, its budget, and the stores it may not touch');

const modulePath = join(repoRoot, 'dist', 'core', 'peer-workspaces.js');
const sourcePath = join(repoRoot, 'src', 'core', 'peer-workspaces.ts');

if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/peer-workspaces.js exists — run ./node_modules/.bin/tsc first');
  process.exit(1);
}

const module = await import(pathToFileURL(modulePath).href);
const { listPeerWorkspaces, PEER_WORKSPACES_BUDGET_MS } = module;
const { normalizeWorkspaceId } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'element-store.js')).href
);
const { splitRemoteWorkspaceId } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'remote-workspace-id.js')).href
);
const { PEER_CONNECT_BUDGET_MS, PEER_REQUEST_BUDGET_MS } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'peer-liveness.js')).href
);

check('core/peer-workspaces exports listPeerWorkspaces', typeof listPeerWorkspaces === 'function',
      `got ${typeof listPeerWorkspaces}`);
check('the budget an unreachable peer is held to is a named constant',
      typeof PEER_WORKSPACES_BUDGET_MS === 'number' && PEER_WORKSPACES_BUDGET_MS > 0,
      `got ${JSON.stringify(PEER_WORKSPACES_BUDGET_MS)}`);
check('and it is at least what the liveness probe alone may take',
      PEER_WORKSPACES_BUDGET_MS >= PEER_CONNECT_BUDGET_MS + 2 * PEER_REQUEST_BUDGET_MS,
      `${PEER_WORKSPACES_BUDGET_MS} against ${PEER_CONNECT_BUDGET_MS} + 2 × ${PEER_REQUEST_BUDGET_MS}`);

const source = readFileSync(sourcePath, 'utf8');

/**
 * The module with its prose taken out.
 *
 * The banner has to be able to say *why* nothing here reads an element store, and a rule that
 * matched the promise as well as the breach would make writing the promise down the thing that
 * fails. `check-liveness-states.mjs` states the same principle about `process.env` and settles it
 * by matching a read rather than the words; this settles it by looking only at the code.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Direct imports only, and deliberately so: `core/remote-workspace-id.ts` borrows the *normaliser*
// from the element store, which is a pure function of a string, and a transitive ban would forbid
// the one import this module is built on. What must not appear here is a module that owns per-id
// state — the store itself, the board-state file, a terminal session, an implement record.
const FORBIDDEN = [
  'element-store', 'board-state', 'board-files', 'terminal-session', 'terminal-block',
  'implement-state', 'implement-queue', 'implement-agent', 'implement-worktree', 'scene-io'
];
const imported = [...code.matchAll(/from '\.\/([a-z-]+)\.js'/g)].map(([, name]) => name);
const reached = FORBIDDEN.filter((name) => imported.includes(name));
check('it imports no module that owns per-id state', reached.length === 0,
      `${reached.join(', ')} — an unknown id yields an empty store by design, so a stray read `
      + 'manufactures a blank board for a project another machine owns');
check('and its code calls into no store, board state, terminal or implement record',
      !/elementsFor|elementStore|boardStateFor|terminalSession|implementRecord|implementState/
        .test(code), 'the names are what a reviewer greps for');
check('it reads no process.env', !/process\.env\s*[.[]/.test(code));
check('it reads no file',
      !/from '(node:)?fs/.test(code) && !/readFileSync|writeFileSync|fs\.promises/.test(code));
check('and no setting name appears in it', !/VIBEMAXXING_|settingName|settings\.js/.test(code),
      'a budget that became a variable would be a documentation table away from here');

// The transport is a defaulted argument for the reason the connector, the fetch and the clock are
// in `core/peer-liveness.ts`: a board that can be *told* what another machine said is a board that
// can be lied to about a peer. A caller arrives later in this milestone and uses the default.
const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
const supplying = tracked.filter((file) => {
  if (file.endsWith('core/peer-workspaces.ts')) return false;
  const text = readFileSync(join(repoRoot, file), 'utf8');
  return /listPeerWorkspaces/.test(text) && /transport\s*:/.test(text);
});
check('nothing in src/ supplies the transport', supplying.length === 0,
      `${supplying.join(', ')} — a board that can be told what a peer said is a board that can be `
      + 'lied to about a peer');

// ─── 1. One peer's projects become tabs ───────────────────────

console.log('\n1. one peer\'s project list becomes tabs, namespaced, projected, and dated by one state');

const DESK = { id: 'desk', name: 'The desktop', baseUrl: 'http://desk.example:3737', secret: 'a-credential' };

{
  const desk = deskSaying('online', 'desk.example:3737 is running a board and this board is allowed on it.');
  const transport = transportSaying({
    ok: true,
    workspaces: [
      { id: 'notebook', name: 'Notebook', error: null },
      { id: 'notes', name: 'Notes', error: 'board.config.json could not be read' }
    ]
  });
  const answer = await listPeerWorkspaces(DESK, { liveness: desk, transport });

  check('both of the peer\'s projects became tabs', answer.workspaces.length === 2,
        JSON.stringify(answer.workspaces));
  check('every local id is namespaced through core/remote-workspace-id.ts',
        answer.workspaces.every((tab) => splitRemoteWorkspaceId(tab.id)?.peerId === 'desk'),
        JSON.stringify(answer.workspaces.map((tab) => tab.id)));
  check('and every one of them survives the normaliser that decides which board a socket lands on',
        answer.workspaces.every((tab) => normalizeWorkspaceId(tab.id) === tab.id),
        JSON.stringify(answer.workspaces.map((tab) => tab.id)));
  check('the peer\'s own spelling is retained beside the local one rather than re-derived',
        answer.workspaces.map((tab) => tab.remoteId).join(',') === 'notebook,notes',
        JSON.stringify(answer.workspaces.map((tab) => tab.remoteId)));
  check('and it is the spelling the peer\'s own normaliser hands back',
        answer.workspaces.every((tab) => splitRemoteWorkspaceId(tab.id)?.workspaceId === tab.remoteId));
  check('the name a person reads crossed', answer.workspaces.map((tab) => tab.name).join(',') === 'Notebook,Notes',
        JSON.stringify(answer.workspaces.map((tab) => tab.name)));
  check('a project that really is misconfigured keeps its own error',
        answer.workspaces[1]?.error === 'board.config.json could not be read',
        JSON.stringify(answer.workspaces[1]));
  check('and a project that is not has none', answer.workspaces[0]?.error === null,
        JSON.stringify(answer.workspaces[0]));
  check('what replaces the path names the project and the machine',
        answer.workspaces[0]?.location === 'Notebook on The desktop',
        JSON.stringify(answer.workspaces[0]?.location));
  check('the answer carries one liveness state', STATES.includes(answer.liveness?.state),
        JSON.stringify(answer.liveness));
  check('and it is the one the desk gave', answer.liveness?.state === 'online',
        JSON.stringify(answer.liveness));
  check('every tab says which peer owns it', answer.workspaces.every((tab) => tab.peerId === 'desk'));
  check('the peer was asked at the address the record holds',
        transport.asked[0]?.url === DESK.baseUrl, JSON.stringify(transport.asked));
  check('and the credential this board holds on it went with the request',
        transport.asked[0]?.token === 'a-credential', JSON.stringify(transport.asked[0]?.token));
}

// ─── 2. What does not cross ───────────────────────────────────

console.log('\n2. a fat record contributes three fields and nothing else');

{
  const answer = await listPeerWorkspaces(DESK, {
    liveness: deskSaying('online'),
    transport: transportSaying({
      ok: true,
      workspaces: [{
        id: 'notebook',
        name: 'Notebook',
        error: null,
        path: 'C:/Users/somebody/marker-absolute-path',
        innerPath: '/home/somebody/marker-inner-path',
        environment: { kind: 'wsl', distro: 'marker-distro' },
        language: 'marker-language',
        docsDir: 'marker-docs',
        boardFile: 'marker-board-file',
        libraryFile: 'marker-library',
        repo: 'marker/repo',
        githubProject: 'marker-project',
        agents: { implement: { model: 'marker-model' } }
      }]
    })
  });
  const serialised = JSON.stringify(answer);
  const leaked = ['marker-absolute-path', 'marker-inner-path', 'marker-distro', 'marker-language',
    'marker-docs', 'marker-board-file', 'marker-library', 'marker/repo', 'marker-project',
    'marker-model'].filter((marker) => serialised.includes(marker));
  check('nothing the projection did not name reached the tab', leaked.length === 0,
        leaked.join(', '));
  check('and the three that were named did', answer.workspaces[0]?.name === 'Notebook'
        && answer.workspaces[0]?.remoteId === 'notebook' && answer.workspaces[0]?.error === null,
        JSON.stringify(answer.workspaces[0]));
}

// ─── 3. Two peers, one folder name ────────────────────────────

console.log('\n3. two peers holding a folder of the same name are two tabs, not one');

{
  const sameFolder = { ok: true, workspaces: [{ id: 'notebook', name: 'Notebook', error: null }] };
  const onDesk = await listPeerWorkspaces(DESK, {
    liveness: deskSaying('online'), transport: transportSaying(sameFolder)
  });
  const onLaptop = await listPeerWorkspaces(
    { id: 'laptop', name: 'The laptop', baseUrl: 'http://laptop.example:3737' },
    { liveness: deskSaying('online'), transport: transportSaying(sameFolder) }
  );

  check('the collision was constructed: both peers really do hold the same id',
        onDesk.workspaces[0]?.remoteId === onLaptop.workspaces[0]?.remoteId,
        JSON.stringify([onDesk.workspaces[0]?.remoteId, onLaptop.workspaces[0]?.remoteId]));
  check('and the two local ids are different', onDesk.workspaces[0]?.id !== onLaptop.workspaces[0]?.id,
        JSON.stringify([onDesk.workspaces[0]?.id, onLaptop.workspaces[0]?.id]));
  check('each one names its own peer',
        splitRemoteWorkspaceId(onDesk.workspaces[0]?.id ?? '')?.peerId === 'desk'
        && splitRemoteWorkspaceId(onLaptop.workspaces[0]?.id ?? '')?.peerId === 'laptop');
  check('and the tooltips tell them apart by the machine',
        onDesk.workspaces[0]?.location !== onLaptop.workspaces[0]?.location,
        JSON.stringify([onDesk.workspaces[0]?.location, onLaptop.workspaces[0]?.location]));
}

// ─── 4. The bullet ────────────────────────────────────────────

console.log('\n4. a peer that is not there is zero projects and one state, and never an error');

for (const state of ['unreachable', 'refused']) {
  const transport = transportSaying({ ok: true, workspaces: [{ id: 'notebook', name: 'Notebook', error: null }] });
  const answer = await listPeerWorkspaces(DESK, {
    liveness: deskSaying(state, 'The machine did not answer a connection within 250 ms.'),
    transport
  });

  check(`a peer that is ${state} contributes zero projects`, answer.workspaces.length === 0,
        JSON.stringify(answer.workspaces));
  check(`and one liveness state, which is ${state}`, answer.liveness?.state === state,
        JSON.stringify(answer.liveness));
  check('the state carries a sentence a tooltip can show',
        typeof answer.liveness?.reason === 'string' && answer.liveness.reason.length > 0,
        JSON.stringify(answer.liveness));
  check('and every error anywhere in the answer is null — this is the bullet',
        errorsIn(answer).every((value) => value === null),
        JSON.stringify(errorsIn(answer)));
  check('nothing was fetched from a peer that is not answering', transport.asked.length === 0,
        JSON.stringify(transport.asked));
}

{
  // The peer answered the liveness probe and then would not serve its projects. Still not an
  // error on a project: it is a fact about the machine, so it lands on the state.
  const answer = await listPeerWorkspaces(DESK, {
    liveness: deskSaying('online'),
    transport: transportSaying({ ok: false, refused: true, reason: 'It refused this board\'s credential (403).' })
  });
  check('a peer that answers and then will not serve its projects contributes none',
        answer.workspaces.length === 0, JSON.stringify(answer.workspaces));
  check('the answer is still one of the four states', STATES.includes(answer.liveness?.state),
        JSON.stringify(answer.liveness));
  check('and it is not online', answer.liveness?.state !== 'online', JSON.stringify(answer.liveness));
  check('and still no error anywhere', errorsIn(answer).every((value) => value === null),
        JSON.stringify(errorsIn(answer)));
}

// ─── 5. The budget ────────────────────────────────────────────

console.log('\n5. a peer that never answers does not hold the strip past the stated budget');

{
  const started = Date.now();
  const answer = await listPeerWorkspaces(DESK, {
    liveness: deskSaying('online'),
    transport: () => new Promise(() => {})
  });
  const took = Date.now() - started;
  check('the answer came back', answer !== null && answer !== undefined);
  check(`and it took no longer than the stated ${PEER_WORKSPACES_BUDGET_MS} ms`,
        took <= PEER_WORKSPACES_BUDGET_MS + 500, `took ${took} ms`);
  check('with zero projects', answer.workspaces.length === 0, JSON.stringify(answer.workspaces));
  check('a liveness state rather than an error', STATES.includes(answer.liveness?.state)
        && errorsIn(answer).every((value) => value === null),
        JSON.stringify({ liveness: answer.liveness, errors: errorsIn(answer) }));
  check('and the reason names the budget it was held to',
        String(answer.liveness?.reason).includes(String(PEER_WORKSPACES_BUDGET_MS)),
        JSON.stringify(answer.liveness?.reason));
}

// ─── 6. Two real boards, and no seams passed at all ───────────

console.log('\n6. a real peer, a real local board, and nothing left behind on this one');

const workdir = mkdtempSync(join(tmpdir(), 'check-peer-workspaces-'));

try {
  const peerProjects = [
    { id: 'notebook', name: 'Notebook', dir: join(workdir, 'peer-notebook') },
    { id: 'notes', name: 'Notes', dir: join(workdir, 'peer-notes') }
  ];
  for (const project of peerProjects) {
    mkdirSync(project.dir);
    writeFileSync(join(project.dir, 'board.config.json'), JSON.stringify({ name: project.name }));
  }
  const peerRegistry = join(workdir, 'peer-workspaces.json');
  writeFileSync(peerRegistry, JSON.stringify({
    workspaces: peerProjects.map((project) => ({ id: project.id, path: project.dir }))
  }));

  const hereDir = join(workdir, 'a-project-of-this-machines-own');
  mkdirSync(hereDir);
  writeFileSync(join(hereDir, 'board.config.json'), JSON.stringify({ name: 'Here' }));
  const localRegistry = join(workdir, 'local-workspaces.json');
  writeFileSync(localRegistry, JSON.stringify({ workspaces: [{ id: 'here', path: hereDir }] }));

  const [peerPort, localPort] = await freePorts(2);
  const peer = await startBoard(peerPort, { EXCALIDRAW_WORKSPACES: peerRegistry }, workdir);
  const local = await startBoard(localPort, { EXCALIDRAW_WORKSPACES: localRegistry }, workdir);

  const desk = { id: 'desk', name: 'The desktop', baseUrl: peer.base, secret: 'a-credential' };
  // No deps at all: the liveness desk and the transport are the module's own defaults, which is
  // the whole of what "the transport is a defaulted argument" has to mean.
  const alive = await listPeerWorkspaces(desk);

  check('a peer that is there is online', alive.liveness?.state === 'online',
        `${JSON.stringify(alive.liveness)}\n${peer.read().slice(-400)}`);
  check('and both of its projects came back as tabs', alive.workspaces.length === 2,
        JSON.stringify(alive.workspaces));
  check('named as the peer names them',
        alive.workspaces.map((tab) => tab.name).sort().join(',') === 'Notebook,Notes',
        JSON.stringify(alive.workspaces.map((tab) => tab.name)));
  check('with ids nothing local could collide with',
        alive.workspaces.every((tab) => splitRemoteWorkspaceId(tab.id)?.peerId === 'desk'),
        JSON.stringify(alive.workspaces.map((tab) => tab.id)));
  check('and no path of the peer\'s reached this machine — not even through a real server',
        !JSON.stringify(alive).includes('peer-notebook')
        && !JSON.stringify(alive).includes('peer-notes'),
        JSON.stringify(alive).slice(0, 400));

  // The same real server, under a second peer identity: the collision an operator gets for free
  // by keeping a folder of the same name on both machines.
  const laptop = { id: 'laptop', name: 'The laptop', baseUrl: peer.base };
  const alsoAlive = await listPeerWorkspaces(laptop);
  const deskIds = alive.workspaces.map((tab) => tab.id).sort();
  const laptopIds = alsoAlive.workspaces.map((tab) => tab.id).sort();
  check('the same projects under a second peer are different local ids',
        deskIds.every((id) => !laptopIds.includes(id)) && laptopIds.length === 2,
        JSON.stringify({ deskIds, laptopIds }));

  // ─── The peer goes to sleep ─────────────────────────────────
  console.log('\n   and then the peer stops answering');
  peer.stop();
  for (let attempt = 0; attempt < 100 && peer.child.exitCode === null; attempt++) await sleep(50);

  const started = Date.now();
  const gone = await listPeerWorkspaces(desk);
  const took = Date.now() - started;

  check('a peer that is no longer there contributes zero projects', gone.workspaces.length === 0,
        JSON.stringify(gone.workspaces));
  check('and one liveness state, which is unreachable', gone.liveness?.state === 'unreachable',
        JSON.stringify(gone.liveness));
  check('every error anywhere in that answer is null — a sleeping machine is not a broken project',
        errorsIn(gone).every((value) => value === null), JSON.stringify(errorsIn(gone)));
  check(`and the answer came back inside the stated ${PEER_WORKSPACES_BUDGET_MS} ms`,
        took <= PEER_WORKSPACES_BUDGET_MS + 500, `took ${took} ms`);

  // ─── And nothing was manufactured on this machine ───────────
  console.log('\n   and this board has no idea any of it happened');

  const asked = [...deskIds, ...laptopIds];
  const manufactured = [];
  for (const id of asked) {
    const response = await fetch(`${local.base}/api/elements?workspace=${encodeURIComponent(id)}`);
    const body = await response.json();
    if (!response.ok || body.count !== 0 || body.elements?.length !== 0) {
      manufactured.push(`${id}: ${response.status} ${JSON.stringify(body).slice(0, 120)}`);
    }
  }
  check('every namespaced id is an empty store on the local board — nothing was manufactured',
        manufactured.length === 0 && asked.length === 4, manufactured.join('; ') || `asked ${asked.length}`);

  const localList = await (await fetch(`${local.base}/api/workspaces`)).json();
  check('and no peer project was written into this board\'s own registry',
        Array.isArray(localList.workspaces) && localList.workspaces.length === 1
        && localList.workspaces[0]?.id === 'here',
        JSON.stringify(localList.workspaces));
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.message}`);
} finally {
  await sleep(200);
  for (const child of running) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(300);
  try { rmSync(workdir, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
