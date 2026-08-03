#!/usr/bin/env node
/**
 * Which pictures cross: the files a remote board's scene refers to.
 *
 * The file store is the one thing in this server deliberately **not** keyed by workspace — it is
 * process-global and content-addressed, and scoping happens by reference at serve time and at
 * save time through the same walk. That design has a consequence federation cannot avoid: the
 * set of files that has to cross a peer link can only be computed from the elements, and a
 * second implementation of that walk is a bug that presents as missing images on one machine
 * only. `core/peer-files.ts` computes it once, with `referencedFileIds`, and fetches every file
 * it names **through the peer**.
 *
 * **Two machines, two boards each, from one `freePorts(2)` call.** Each server holds an image
 * only it can have, and each holds a *second* board with a second image — which is the whole
 * instrument. The store on one machine is process-global, so "list the store" and "walk the
 * elements" give different answers there; and the two machines make the cross-machine answer
 * decidable at all.
 *
 * **Every assertion about which pictures cross is over ids, never over counts.** Two boards that
 * both hold one image agree on a count and disagree on everything that matters: a draft that
 * answered with the local machine's own image for every board hands back exactly one file per
 * board, of exactly the right shape, and it is the wrong picture.
 *
 * **The local store is seeded on purpose**, in this process, with the peers' file ids and
 * *different bytes* behind them. A content-addressed store makes a local hit look correct, so the
 * only way to show that nothing is looked for locally first is to leave something there to be
 * found and then read the bytes that came back. In a green run that seed is inert, which is the
 * point.
 *
 * Red first, against a draft of the module that computes the set by listing the store rather than
 * walking the elements — and takes the bytes from it too, which is the same mistake one step on.
 * Sixteen cases red: every board's answer contains every image the local process holds, so
 * `alpha`'s answer carries `beta`'s id and its own sibling board's id and not its own, the bytes
 * are the local decoys rather than what the owning machine holds, and the peers are never asked
 * anything at all.
 *
 * Self-contained: two canvas servers on ports the kernel just handed out, with every spelling of
 * "where this user keeps things" pointed inside a temporary directory so no board of this check's
 * lands in the operator's state directory. No browser. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-peer-files.mjs
 *
 * Tier: fast
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The four answers `core/peer-liveness.ts` gives, and there is no fifth. */
const STATES = ['checking', 'online', 'unreachable', 'refused'];

/** Bytes distinct enough that "these are that machine's" is a comparison rather than a hope. */
const imageBytes = (marker) =>
  `data:image/png;base64,${Buffer.from(`\x89PNG\r\n\x1a\n${marker}`, 'binary').toString('base64')}`;

/** What each machine holds. The ids are the assertion; the bytes are how a swap is caught. */
const ALPHA_IMAGE = 'image-that-only-the-first-machine-has';
const ALPHA_ISSUE_IMAGE = 'issue-image-that-only-the-first-machine-has';
const ALPHA_GONE_IMAGE = 'image-a-deleted-shape-on-the-first-machine-pointed-at';
const ALPHA_SIBLING_IMAGE = 'image-another-board-on-the-first-machine-has';
const BETA_IMAGE = 'image-that-only-the-second-machine-has';
const BETA_SIBLING_IMAGE = 'image-another-board-on-the-second-machine-has';

/** An id this process holds and no board on either machine refers to. It may never cross. */
const LOCAL_ONLY_IMAGE = 'image-only-this-machine-ever-held';

const BOARD_ALPHA = 'alpha';
const BOARD_ALPHA_SIBLING = 'alpha-sibling';
const BOARD_BETA = 'beta';
const BOARD_BETA_SIBLING = 'beta-sibling';

const workDir = mkdtempSync(join(tmpdir(), 'check-peer-files-'));
const fakeHome = join(workDir, 'home');
mkdirSync(fakeHome, { recursive: true });

const boards = [];

async function startBoard(port) {
  const server = startCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      LOG_FILE_PATH: join(workDir, `board-${port}.log`),
      // Every spelling of "where this user keeps things", so a board this check seeds is saved
      // inside the temporary directory rather than beside the operator's own.
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      LOCALAPPDATA: fakeHome,
      XDG_STATE_HOME: fakeHome,
    },
  });
  boards.push(server.child);
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.child.exitCode !== null) throw new Error(`a board exited early:\n${server.read()}`);
    try {
      if ((await fetch(`${server.base}/health`)).ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error(`a board never answered on ${server.base}:\n${server.read()}`);
}

async function api(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/** An element as the browser's autosync sends one, with whatever picture it points at. */
const shape = (id, extra = {}) => ({
  id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10,
  version: 1, versionNonce: 1, isDeleted: false, ...extra,
});

async function seed(base, workspace, files, elements) {
  await api(base, `/api/files?workspace=${workspace}`, {
    method: 'POST',
    body: JSON.stringify({ files }),
  });
  await api(base, `/api/elements/sync?workspace=${workspace}`, {
    method: 'POST',
    body: JSON.stringify({ elements, timestamp: new Date().toISOString() }),
  });
}

// ─── 0. The module, and what it is allowed to know ────────────

console.log('0. one walk, no store of its own, and a transport it cannot be told');

const modulePath = join(repoRoot, 'dist', 'core', 'peer-files.js');
const sourcePath = join(repoRoot, 'src', 'core', 'peer-files.ts');

if (!existsSync(modulePath)) {
  console.error('  FAIL  dist/core/peer-files.js exists — run ./node_modules/.bin/tsc first');
  process.exit(1);
}

const module = await import(pathToFileURL(modulePath).href);
const {
  fileIdsThatCross,
  fetchPeerFiles,
  PEER_FILES_LIVENESS,
  PEER_FILE_EVENTS,
  FORWARDED_FILE_EVENTS,
} = module;

const { referencedFileIds } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'board-files.js')).href);
const { mintRemoteWorkspaceId } = await import(
  pathToFileURL(join(repoRoot, 'dist', 'core', 'remote-workspace-id.js')).href);
// The process-global store this machine keeps. Seeded below with the peers' ids behind different
// bytes: a local hit for a peer's id is exactly what a content-addressed store makes look right.
const { files: localStore } = await import(pathToFileURL(join(repoRoot, 'dist', 'types.js')).href);

check('core/peer-files exports fileIdsThatCross', typeof fileIdsThatCross === 'function',
      `got ${typeof fileIdsThatCross}`);
check('and fetchPeerFiles', typeof fetchPeerFiles === 'function', `got ${typeof fetchPeerFiles}`);

const source = readFileSync(sourcePath, 'utf8');
check('it walks with the same function the save uses',
      /from '\.\/board-files\.js'/.test(source) && /referencedFileIds/.test(source),
      'two walks that disagree about which files a scene refers to is a bug that shows up as '
      + 'missing images on one machine only');
check('and it does not re-implement that walk',
      !/issueImages/.test(source) && !/\.fileId\b/.test(source),
      'the ids an image element carries and the ids a block has attached are read in one place');
check('it holds no store of its own, keyed by workspace or otherwise',
      !/new Map\(|new WeakMap\(/.test(source),
      'caching a peer\'s bytes here would invent the per-board bucket the design does not have');
check('and it does not reach for this machine\'s file store',
      !/from '\.\.\/types\.js'/.test(source) && !/\bfiles\.get\(/.test(source),
      'a file a remote scene refers to is fetched through the peer, never found locally');
check('it reads no process.env', !/process\.env\s*[.[]/.test(source));
check('it reads no file',
      !/from '(node:)?fs/.test(source) && !/readFileSync|writeFileSync|fs\.promises/.test(source));
check('and it opens no socket of its own',
      !/from '(node:)?(http|https|net|ws)/.test(source),
      'the transport is core/peer-client.ts\'s, reached through a defaulted argument');

const tracked = execFileSync('git', ['ls-files', '-z', 'src'], { cwd: repoRoot, encoding: 'utf8' })
  .split('\0').filter(Boolean);
// What is banned is a *transport*, not a third argument, and the shape of this rule is
// `check-peer-client.mjs`'s after #563 found the naive one calling a sibling module a breach for
// having named the fields of a request. Comments are blanked first for the same reason: a module
// explaining in prose which transport it defaults to is a module doing the right thing.
const withoutComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const supplying = tracked.filter((file) => {
  if (file.endsWith('core/peer-files.ts')) return false;
  const text = withoutComments(readFileSync(join(repoRoot, file), 'utf8'));
  return /fetchPeerFiles\(/.test(text) && /(transport\s*:|PeerFilesTransport)/.test(text);
});
check('nothing in src/ passes the transport', supplying.length === 0,
      `${supplying.join(', ')} — a board that can be told who answered is a board that can be `
      + 'lied to about a peer');

const kinds = Object.keys(PEER_FILES_LIVENESS ?? {});
check('every outcome this module can produce names one of the four liveness states',
      kinds.length > 0 && kinds.every((kind) => STATES.includes(PEER_FILES_LIVENESS[kind])),
      JSON.stringify(PEER_FILES_LIVENESS));

// ─── 1. The walk itself ───────────────────────────────────────

console.log('\n1. the referenced set is the one the save computes, and not a second one');

{
  const scene = [
    shape('a-plain-shape'),
    shape('an-image', { fileId: 'picture-one' }),
    shape('a-block', { customData: { kind: 'issue-block', issueImages: ['picture-two', 'picture-one'] } }),
    shape('a-tombstone', { fileId: 'picture-three', isDeleted: true }),
    shape('the-same-picture-again', { fileId: 'picture-one' }),
  ];
  const walked = fileIdsThatCross(scene);
  check('it hands back exactly what referencedFileIds does',
        same(walked, referencedFileIds(scene)),
        `${JSON.stringify(walked)} vs ${JSON.stringify(referencedFileIds(scene))}`);
  check('an image element and a block\'s attachments both count',
        walked.includes('picture-one') && walked.includes('picture-two'), JSON.stringify(walked));
  check('a deleted shape refers to nothing', !walked.includes('picture-three'), JSON.stringify(walked));
  check('and a picture named twice crosses once',
        walked.filter((id) => id === 'picture-one').length === 1, JSON.stringify(walked));
}

// ─── 2. Two machines, and the ids that cross ──────────────────

console.log('\n2. each board\'s answer is its own board\'s pictures, asserted by id');

/** Everything the module was asked to send, so "the peer was asked" is a recorded fact. */
function recording(base) {
  const asked = [];
  const call = async (peer, request) => {
    asked.push({ baseUrl: peer?.baseUrl, method: request?.method ?? 'GET', path: request?.path });
    return base(peer, request);
  };
  call.asked = asked;
  return call;
}

const { callPeer } = await import(pathToFileURL(join(repoRoot, 'dist', 'core', 'peer-client.js')).href);

try {
  const [portA, portB] = await freePorts(2);
  const machineA = await startBoard(portA);
  const machineB = await startBoard(portB);

  // Every file each machine holds goes into that machine's one process-global store. Only some
  // of them are referred to by the board being asked about, which is the difference between
  // walking the elements and listing the store.
  await seed(machineA.base, BOARD_ALPHA, [
    { id: ALPHA_IMAGE, dataURL: imageBytes('alpha'), mimeType: 'image/png' },
    { id: ALPHA_ISSUE_IMAGE, dataURL: imageBytes('alpha-issue'), mimeType: 'image/png' },
    { id: ALPHA_GONE_IMAGE, dataURL: imageBytes('alpha-gone'), mimeType: 'image/png' },
  ], [
    shape('alpha-plain'),
    shape('alpha-image', { fileId: ALPHA_IMAGE }),
    shape('alpha-block', { customData: { kind: 'issue-block', issueImages: [ALPHA_ISSUE_IMAGE] } }),
    shape('alpha-tombstone', { fileId: ALPHA_GONE_IMAGE, isDeleted: true }),
  ]);
  await seed(machineA.base, BOARD_ALPHA_SIBLING, [
    { id: ALPHA_SIBLING_IMAGE, dataURL: imageBytes('alpha-sibling'), mimeType: 'image/png' },
  ], [shape('alpha-sibling-image', { fileId: ALPHA_SIBLING_IMAGE })]);

  await seed(machineB.base, BOARD_BETA, [
    { id: BETA_IMAGE, dataURL: imageBytes('beta'), mimeType: 'image/png' },
  ], [shape('beta-image', { fileId: BETA_IMAGE })]);
  await seed(machineB.base, BOARD_BETA_SIBLING, [
    { id: BETA_SIBLING_IMAGE, dataURL: imageBytes('beta-sibling'), mimeType: 'image/png' },
  ], [shape('beta-sibling-image', { fileId: BETA_SIBLING_IMAGE })]);

  // What this machine holds. None of it may reach any answer: the ids are two of the peers' own,
  // behind bytes neither peer has ever seen, plus one nothing anywhere refers to.
  localStore.set(ALPHA_IMAGE,
                 { id: ALPHA_IMAGE, dataURL: imageBytes('a-local-decoy-for-alpha'), mimeType: 'image/png' });
  localStore.set(BETA_IMAGE,
                 { id: BETA_IMAGE, dataURL: imageBytes('a-local-decoy-for-beta'), mimeType: 'image/png' });
  localStore.set(LOCAL_ONLY_IMAGE,
                 { id: LOCAL_ONLY_IMAGE, dataURL: imageBytes('local-only'), mimeType: 'image/png' });

  const peerA = { baseUrl: machineA.base, secret: 'what-the-first-machine-approved-this-one-under' };
  const peerB = { baseUrl: machineB.base, secret: 'what-the-second-machine-approved-this-one-under' };

  const askedA = recording(callPeer);
  const askedB = recording(callPeer);
  const alpha = await fetchPeerFiles(peerA, { workspaceId: BOARD_ALPHA }, { transport: askedA });
  const beta = await fetchPeerFiles(peerB, { workspaceId: BOARD_BETA }, { transport: askedB });

  check('the first machine answered for its own board', alpha?.ok === true,
        `${JSON.stringify(alpha)}\n${machineA.read().slice(-400)}`);
  check('and the second for its own', beta?.ok === true,
        `${JSON.stringify(beta)}\n${machineB.read().slice(-400)}`);

  const alphaIds = alpha?.ids ?? [];
  const betaIds = beta?.ids ?? [];

  check('alpha refers to exactly the two pictures its own shapes name',
        same([...alphaIds].sort(), [ALPHA_IMAGE, ALPHA_ISSUE_IMAGE].sort()), JSON.stringify(alphaIds));
  check('beta refers to exactly the one its own shape names',
        same(betaIds, [BETA_IMAGE]), JSON.stringify(betaIds));

  check('the picture a deleted shape pointed at does not cross',
        !alphaIds.includes(ALPHA_GONE_IMAGE), JSON.stringify(alphaIds));
  check('nor does the picture another board on the same machine holds',
        !alphaIds.includes(ALPHA_SIBLING_IMAGE),
        'the store is process-global; listing it answers for every board at once');
  check('and neither does anything this machine holds by itself',
        !alphaIds.includes(LOCAL_ONLY_IMAGE) && !betaIds.includes(LOCAL_ONLY_IMAGE),
        JSON.stringify([alphaIds, betaIds]));

  check('no id of the second machine\'s appears in the first machine\'s answer',
        !alphaIds.includes(BETA_IMAGE) && !alphaIds.includes(BETA_SIBLING_IMAGE),
        JSON.stringify(alphaIds));
  check('and no id of the first machine\'s appears in the second machine\'s answer',
        !betaIds.includes(ALPHA_IMAGE) && !betaIds.includes(ALPHA_ISSUE_IMAGE)
        && !betaIds.includes(ALPHA_SIBLING_IMAGE),
        JSON.stringify(betaIds));
  check('the two answers have no picture in common at all',
        alphaIds.every((id) => !betaIds.includes(id)),
        `${JSON.stringify(alphaIds)} and ${JSON.stringify(betaIds)}`);

  // The same claim once more, taken from the scene the owning machine served rather than from
  // this check's own memory of what it seeded.
  const servedAlpha = await api(machineA.base, `/api/elements?workspace=${BOARD_ALPHA}`);
  check('and the set is the walk of the scene that machine actually served',
        same(alphaIds, referencedFileIds(servedAlpha.elements)),
        `${JSON.stringify(alphaIds)} vs ${JSON.stringify(referencedFileIds(servedAlpha.elements))}`);

  console.log('\n3. the bytes are the owning machine\'s, and this machine is not consulted');

  const alphaFiles = alpha?.files ?? [];
  check('every picture the set names came back with its bytes',
        same(alphaFiles.map((file) => file.id).sort(), [...alphaIds].sort()),
        JSON.stringify(alphaFiles.map((file) => file.id)));
  check('and they are the bytes that machine holds, not the ones sitting here under the same id',
        alphaFiles.find((file) => file.id === ALPHA_IMAGE)?.dataURL === imageBytes('alpha'),
        `a local hit for a peer\'s id looks correct and is not: `
        + `${JSON.stringify(alphaFiles.find((file) => file.id === ALPHA_IMAGE)?.dataURL)}`);
  check('the second machine\'s picture is its own too',
        beta?.files?.[0]?.dataURL === imageBytes('beta'), JSON.stringify(beta?.files?.[0]?.dataURL));
  check('nothing came back that no shape refers to',
        alphaFiles.every((file) => alphaIds.includes(file.id)),
        JSON.stringify(alphaFiles.map((file) => file.id)));

  check('the peer was asked for the scene and then for each picture by id',
        askedA.asked.length === 1 + alphaIds.length,
        JSON.stringify(askedA.asked));
  check('every request went to that machine and named its own spelling of the board',
        askedA.asked.length > 0 && askedA.asked.every((request) => request.baseUrl === machineA.base
          && request.path.includes(`workspace=${BOARD_ALPHA}`)),
        JSON.stringify(askedA.asked));
  check('and every picture in the answer was asked for by id',
        alphaIds.length > 0
        && alphaIds.every((id) => askedA.asked.some((request) => request.path.includes(encodeURIComponent(id)))),
        JSON.stringify(askedA.asked.map((request) => request.path)));
  check('the second machine was asked nothing about the first machine\'s board',
        askedB.asked.length > 0 && askedB.asked.every((request) => request.baseUrl === machineB.base
          && !request.path.includes(BOARD_ALPHA)),
        JSON.stringify(askedB.asked));

  console.log('\n4. nothing is kept, so a second reader gets the picture as it is now');

  {
    const again = recording(callPeer);
    const second = await fetchPeerFiles(peerA, { workspaceId: BOARD_ALPHA }, { transport: again });
    check('a second call asks the peer again rather than answering from something kept here',
          again.asked.length > 0 && again.asked.length === askedA.asked.length,
          JSON.stringify(again.asked.length));
    check('and it answers the same thing', same(second?.ids, alphaIds), JSON.stringify(second?.ids));
    check('no picture of the peer\'s was written into this machine\'s store',
          !localStore.has(ALPHA_ISSUE_IMAGE) && !localStore.has(ALPHA_SIBLING_IMAGE)
          && !localStore.has(BETA_SIBLING_IMAGE),
          [...localStore.keys()].join(', '));
    check('and the decoys are still exactly as they were left',
          localStore.get(ALPHA_IMAGE)?.dataURL === imageBytes('a-local-decoy-for-alpha'),
          JSON.stringify(localStore.get(ALPHA_IMAGE)?.dataURL));
  }

  console.log('\n5. a picture that is gone, a board that is not theirs, a machine that is not there');

  {
    // A shape pointing at a picture the owning machine no longer holds. That is an answer about
    // a picture, not a failure of the link — and it is emphatically not a reason to look here.
    await seed(machineB.base, BOARD_BETA, [], [
      shape('beta-image-with-nothing-behind-it', { fileId: 'image-the-second-machine-lost' }),
    ]);
    const answer = await fetchPeerFiles(peerB, { workspaceId: BOARD_BETA }, { transport: recording(callPeer) });
    check('a picture the peer no longer holds is named as missing rather than failing the call',
          answer?.ok === true && answer.missing.includes('image-the-second-machine-lost'),
          JSON.stringify(answer));
    check('and no substitute is invented for it',
          answer?.files?.every((file) => file.id !== 'image-the-second-machine-lost') === true,
          JSON.stringify(answer?.files?.map((file) => file.id)));
  }

  {
    const local = mintRemoteWorkspaceId('the-first-machine', BOARD_ALPHA);
    const asked = recording(callPeer);
    const answer = await fetchPeerFiles(peerA, { workspaceId: local.id }, { transport: asked });
    check('this board\'s own name for a peer\'s board is refused rather than sent upstream',
          answer?.ok === false, JSON.stringify(answer));
    check('and nothing was sent, because that id would land on a board nobody named',
          asked.asked.length === 0, JSON.stringify(asked.asked));
    check('the refusal is a sentence naming it', typeof answer?.reason === 'string'
          && answer.reason.includes(local.id), JSON.stringify(answer?.reason));
  }

  {
    const asked = recording(callPeer);
    const answer = await fetchPeerFiles(peerA, { workspaceId: 'a board:with a colon' }, { transport: asked });
    check('a spelling the owning board would rewrite is refused rather than sent',
          answer?.ok === false && asked.asked.length === 0,
          `${JSON.stringify(answer)} — a rewritten id lands the request on that machine's shared `
          + 'default board and nothing logs');
  }

  {
    const answer = await fetchPeerFiles({ baseUrl: 'http://peer.invalid:3737', secret: 'x' },
                                        { workspaceId: BOARD_ALPHA });
    check('a machine that is not there is a value rather than a throw',
          answer?.ok === false && typeof answer.reason === 'string' && answer.reason.length > 0,
          JSON.stringify(answer));
    check('and it carries one of the four liveness states',
          STATES.includes(answer?.liveness), JSON.stringify(answer?.liveness));
  }

  {
    const answered = async () => ({
      ok: true, kind: 'answered', liveness: 'online', status: 200, headers: {},
      body: Buffer.from('<html>a proxy sign-in page</html>'),
    });
    const answer = await fetchPeerFiles(peerA, { workspaceId: BOARD_ALPHA }, { transport: answered });
    check('a machine that answers something that is not a scene is a failure with a sentence',
          answer?.ok === false && typeof answer.reason === 'string', JSON.stringify(answer));
    check('and it is still online, because it answered',
          answer?.liveness === 'online',
          'reporting a machine that replied as unreachable sends its operator to look at a '
          + 'network that is fine');
  }

  {
    // The forwarder usually has the scene already. Handed one, the module asks for no second copy
    // — two reads of a board that is being drawn on are two different scenes.
    const asked = recording(callPeer);
    const answer = await fetchPeerFiles(
      peerA,
      { workspaceId: BOARD_ALPHA, elements: [shape('held', { fileId: ALPHA_ISSUE_IMAGE })] },
      { transport: asked });
    check('a scene the caller already holds is walked rather than fetched again',
          same(answer?.ids, [ALPHA_ISSUE_IMAGE]) && asked.asked.length === 1,
          `${JSON.stringify(answer?.ids)} after ${JSON.stringify(asked.asked.map((r) => r.path))}`);
  }
} catch (error) {
  failures++;
  console.error(`\n  FAIL  ${error.stack ?? error.message}`);
} finally {
  await sleep(100);
  for (const child of boards) if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(300);
  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* Windows holds files */ }
}

// ─── 6. One decision, so two forwarders do not take two ───────

console.log('\n6. what the three events mean over a forwarded link is stated once');

{
  const named = [...(PEER_FILE_EVENTS ?? [])];
  check('the three events a forwarded link carries are named',
        same([...named].sort(), ['elements_synced', 'file_deleted', 'files_added']),
        JSON.stringify(named));

  const types = readFileSync(join(repoRoot, 'src', 'types.ts'), 'utf8');
  check('and each of them is an event this server actually broadcasts',
        named.every((event) => types.includes(`| '${event}'`)),
        'a renamed frame would leave this decision describing something that no longer happens');

  const decisions = FORWARDED_FILE_EVENTS ?? {};
  check('each has a decision rather than a paragraph somewhere',
        named.every((event) => typeof decisions[event]?.says === 'string' && decisions[event].says),
        JSON.stringify(Object.keys(decisions)));
  check('none of the three writes a peer\'s bytes into a store on this machine',
        named.every((event) => decisions[event]?.storesLocally === false),
        JSON.stringify(named.map((event) => [event, decisions[event]?.storesLocally])));
  check('the board on a forwarded frame is relabelled to this board\'s name for it',
        named.every((event) => decisions[event]?.board === 'relabel-to-local'),
        JSON.stringify(named.map((event) => [event, decisions[event]?.board])));
  check('files_added is the one that carries bytes',
        decisions.files_added?.carriesBytes === true
        && decisions.file_deleted?.carriesBytes === false
        && decisions.elements_synced?.carriesBytes === false,
        JSON.stringify(named.map((event) => [event, decisions[event]?.carriesBytes])));
  check('and elements_synced is the one that makes the set stale',
        decisions.elements_synced?.rewalks === true
        && decisions.files_added?.rewalks === false
        && decisions.file_deleted?.rewalks === false,
        JSON.stringify(named.map((event) => [event, decisions[event]?.rewalks])));
}

if (failures) { console.error(`\n${failures} case(s) failed`); process.exit(1); }
console.log('\nall cases passed');
