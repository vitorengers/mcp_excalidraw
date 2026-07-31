#!/usr/bin/env node
/**
 * Checks that a registered board's saved scene is in its store when the server comes up.
 *
 * `boardFile` was resolved from `board.config.json`, published by `GET /api/workspaces` and
 * read by nothing: three registered boards came up empty on every restart and the only way
 * back was an ad-hoc import (#184). So the first case here is the plain one — a workspace
 * that declares a board holds its elements a moment after the port opens — and the rest are
 * the ways that seed can be wrong:
 *
 * - A workspace that declares no board stays empty. The feature is opt-in.
 * - A board file that is not there leaves that board empty and the server up.
 * - A tombstone in the file does not come back as an element.
 * - The fields the server authors are seeded as *finished* facts only. An issue that exists
 *   still says so; a run that was in flight when the previous process died does not, because
 *   no run survives its process and the browser cannot correct a store that outranks it.
 * - A browser already connected when the seed lands is told about it. A direct store write
 *   broadcasts nothing, so without that the canvas sits empty until something makes it
 *   refetch — and the socket's own `initial_elements` is the proof it connected first.
 * - The seed goes into the store a request can reach: registry ids are raw and store keys
 *   are normalised, so a project id with a capital letter is where the two spellings part.
 *
 * Self-contained: it builds throwaway projects in a temp directory, starts its own canvas
 * server on a free port and kills it. Run `./node_modules/.bin/tsc` first.
 *
 * Usage: node scripts/check-board-seed.mjs
 *
 * Tier: fast
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

import { freePort } from './lib/free-port.mjs';
import { startCanvas as spawnCanvas } from './lib/spawn-canvas.mjs';

let failures = 0;

function check(name, condition, detail = '') {
  if (condition) console.log(`  ok    ${name}`);
  else { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── The throwaway world ──────────────────────────────────────

const workDir = join(tmpdir(), `board-seed-${process.pid}`);
const registryPath = join(workDir, 'registry.json');

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

function makeProject(name, config) {
  const dir = join(workDir, name);
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'board.config.json'), JSON.stringify(config, null, 1), 'utf8');
  return dir;
}

const issue = (n) => `https://github.com/vitorengers/vibemaxxing/issues/${n}`;

/** A shape as `scripts/export-board.mjs` writes one: no server bookkeeping, a version. */
function shape(id, extra = {}) {
  return {
    id,
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${id}`,
    seed: 1,
    version: 7,
    versionNonce: 11,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}

/**
 * The two stages, written out rather than imported: what a seed does to a look is exactly
 * what is under test here, so reading the values from the module that decides them would
 * leave nothing to disagree with. They are the notes column's hue since #195, and
 * `check-notes-block-hue.mjs` is what holds them to it.
 */
/** The first stage: written on the board, no issue behind it yet. */
const DRAFT_LOOK = { strokeColor: '#1971c2', backgroundColor: '#e7f5ff', strokeStyle: 'dashed' };
/** The second stage: an issue exists. */
const CREATED_LOOK = { strokeColor: '#1864ab', backgroundColor: '#d0ebff', strokeStyle: 'solid' };

const interesting = [
  shape('plain', { customData: undefined }),

  // Finished facts. Both come back exactly as they were written.
  shape('issue-created', {
    ...CREATED_LOOK,
    customData: { kind: 'issue', issueState: 'created', issueUrl: issue(94), issueTitle: 'A block that produced #94' },
  }),
  shape('implement-done', {
    ...CREATED_LOOK,
    customData: {
      kind: 'issue', issueState: 'created', issueUrl: issue(95), issueTitle: 'Implemented',
      implementState: 'done', implementUrl: 'https://github.com/vitorengers/vibemaxxing/pull/95',
      implementError: null, implementStartedAt: '2026-07-01T00:00:00.000Z', implementEndedAt: '2026-07-01T00:10:00.000Z',
    },
  }),

  // In flight when the previous process stopped. Neither run exists any more.
  shape('issue-running', {
    ...DRAFT_LOOK,
    customData: { kind: 'issue', issueState: 'running', issueError: 'half a message' },
  }),
  shape('issue-running-with-url', {
    ...DRAFT_LOOK,
    customData: { kind: 'issue', issueState: 'running', issueUrl: issue(96), issueTitle: 'Already has its issue' },
  }),
  shape('implement-running', {
    ...CREATED_LOOK,
    customData: {
      kind: 'issue', issueState: 'created', issueUrl: issue(97), issueTitle: 'Was being implemented',
      implementState: 'running', implementUrl: null, implementError: null,
      implementStartedAt: '2026-07-01T00:00:00.000Z', implementEndedAt: null,
    },
  }),

  // A tombstone is not an element.
  shape('tombstone', { isDeleted: true }),

  // An image, and the file it points at.
  shape('picture', { type: 'image', fileId: 'file-1' }),
];

/**
 * Filler, and it is doing a job: the socket case below has to connect before the seed
 * lands, and a board with a hundred shapes is read and parsed inside one event loop turn.
 * This is roughly the size of a real board's worth of work, which is the margin the race
 * needs to be decided the same way every run.
 */
const filler = Array.from({ length: 12000 }, (_, n) => shape(`filler-${n}`, { x: n, y: n }));

function boardFile(dir, elements, files = {}) {
  writeFileSync(join(dir, 'docs', 'board.excalidraw'), `${JSON.stringify({
    type: 'excalidraw',
    version: 2,
    source: 'mcp-excalidraw-server',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files,
  }, null, 1)}\n`, 'utf8');
}

const savedDir = makeProject('saved', { name: 'Saved', board: 'docs/board.excalidraw' });
boardFile(savedDir, [...interesting, ...filler], {
  'file-1': {
    mimeType: 'image/png',
    id: 'file-1',
    dataURL: 'data:image/png;base64,iVBORw0KGgo=',
    created: 1700000000000,
    lastRetrieved: 1700000000000,
  },
});

// Declares no board. The case that proves the feature is opt-in, not the case that proves
// it broken.
makeProject('unsaved', { name: 'Unsaved' });

// Declares one that is not there. An empty board and a server that is still up.
makeProject('absent', { name: 'Absent', board: 'docs/board.excalidraw' });

const posix = (value) => value.replace(/\\/g, '/');

writeFileSync(registryPath, JSON.stringify({
  workspaces: [
    // Capitalised on purpose: `elementsFor` normalises its key and the registry does not,
    // so this is the entry that parts the two spellings.
    { id: 'Saved-Board', path: posix(savedDir) },
    { id: 'unsaved', path: posix(join(workDir, 'unsaved')) },
    { id: 'absent', path: posix(join(workDir, 'absent')) },
  ],
}, null, 1), 'utf8');

// ─── The server ───────────────────────────────────────────────

const port = await freePort();
const BASE = `http://127.0.0.1:${port}`;

let child = null;
let output = '';

function startCanvas() {
  child = spawnCanvas({
    port,
    env: {
      LOG_LEVEL: 'error',
      EXCALIDRAW_WORKSPACES: registryPath,
      // This machine's shell exports it, and a terminal block would add shapes to a board
      // whose element count these cases read.
      EXCALIDRAW_TERMINAL: '',
    },
  }).child;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
}

async function elementsOf(workspace) {
  const response = await fetch(`${BASE}/api/elements?workspace=${encodeURIComponent(workspace)}`);
  if (!response.ok) throw new Error(`GET /api/elements -> HTTP ${response.status}`);
  const { elements = [] } = await response.json();
  return elements;
}

async function waitForElements(workspace, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (child.exitCode !== null) throw new Error(`the canvas server exited early:\n${output}`);
    try {
      const elements = await elementsOf(workspace);
      if (elements.length) return elements;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return [];
}

/**
 * A browser that is on the board while it is being loaded.
 *
 * Dialled from before the port opens, so the socket lands in the first moments of the
 * server's life — which is the only window in which the seed can be broadcast *to* anybody.
 * What it received first is kept: an `initial_elements` that already had the board would
 * mean the race went the other way and the case proved nothing.
 */
function watchBoard(workspace) {
  const seen = { initial: null, batch: null };
  let socket = null;
  let stopped = false;

  const dial = () => {
    if (stopped) return;
    socket = new WebSocket(`ws://127.0.0.1:${port}?workspace=${encodeURIComponent(workspace)}`);
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === 'initial_elements' && seen.initial === null) {
        seen.initial = message.elements ?? [];
      }
      if (message.type === 'elements_batch_created' && !seen.batch) seen.batch = message;
    });
    socket.on('error', () => { setTimeout(dial, 5); });
  };
  dial();

  return { seen, stop: () => { stopped = true; try { socket?.close(); } catch { /* already gone */ } } };
}

// ─── The cases ────────────────────────────────────────────────

const watcher = watchBoard('saved-board');
startCanvas();

try {
  console.log('A board a workspace declares');
  const saved = await waitForElements('saved-board');
  check('the saved board is in the store after boot', saved.length > 0,
    `got ${saved.length} elements:\n${output}`);

  const byId = new Map(saved.map((element) => [element.id, element]));
  check('every shape in the file arrived', saved.length === interesting.length - 1 + filler.length,
    `expected ${interesting.length - 1 + filler.length}, got ${saved.length}`);
  check('a tombstone did not come back as an element',
    byId.has('plain') && !byId.has('tombstone'));

  const files = await fetch(`${BASE}/api/files?workspace=saved-board`).then((r) => r.json());
  check('the file an image element points at came with it',
    files?.files?.['file-1']?.dataURL === 'data:image/png;base64,iVBORw0KGgo=',
    JSON.stringify(files?.files ?? {}).slice(0, 200));

  console.log('Opt-in, and honest about a file it cannot read');
  check('a workspace that declares no board stays empty', (await elementsOf('unsaved')).length === 0);
  check('a board file that is not there leaves the board empty', (await elementsOf('absent')).length === 0);
  check('the server is still up after a board it could not read', child.exitCode === null);

  console.log('Finished facts are seeded, runs are not');
  const created = byId.get('issue-created');
  check('an issue that exists still says so',
    created?.customData?.issueState === 'created'
    && created?.customData?.issueUrl === issue(94)
    && created?.customData?.issueTitle === 'A block that produced #94',
    JSON.stringify(created?.customData));

  const done = byId.get('implement-done');
  check('a finished implementation keeps its pull request',
    done?.customData?.implementState === 'done'
    && done?.customData?.implementUrl === 'https://github.com/vitorengers/vibemaxxing/pull/95'
    && done?.customData?.implementStartedAt === '2026-07-01T00:00:00.000Z',
    JSON.stringify(done?.customData));

  const running = byId.get('issue-running');
  check('a research run that died with its process is not asserted as running',
    Boolean(running)
    && running?.customData?.issueState === undefined && running?.customData?.issueError === undefined,
    JSON.stringify(running?.customData));
  check('and the block keeps the look of one with no issue behind it',
    running?.strokeColor === DRAFT_LOOK.strokeColor
    && running?.backgroundColor === DRAFT_LOOK.backgroundColor
    && running?.strokeStyle === DRAFT_LOOK.strokeStyle,
    `${running?.strokeColor} ${running?.backgroundColor} ${running?.strokeStyle}`);

  const runningWithUrl = byId.get('issue-running-with-url');
  check('a run that had already produced its issue comes back created, not running',
    runningWithUrl?.customData?.issueState === 'created'
    && runningWithUrl?.customData?.issueUrl === issue(96),
    JSON.stringify(runningWithUrl?.customData));
  check('and it is repainted as a block that has an issue',
    runningWithUrl?.strokeColor === CREATED_LOOK.strokeColor
    && runningWithUrl?.backgroundColor === CREATED_LOOK.backgroundColor
    && runningWithUrl?.strokeStyle === CREATED_LOOK.strokeStyle,
    `${runningWithUrl?.strokeColor} ${runningWithUrl?.backgroundColor} ${runningWithUrl?.strokeStyle}`);

  const implementing = byId.get('implement-running');
  check('an implementation that died with its process is not asserted as running',
    Boolean(implementing)
    && implementing?.customData?.implementState === undefined
    && implementing?.customData?.implementStartedAt === undefined
    && implementing?.customData?.implementUrl === undefined,
    JSON.stringify(implementing?.customData));
  check('and the issue it was implementing is still recorded',
    implementing?.customData?.issueUrl === issue(97)
    && implementing?.customData?.issueState === 'created',
    JSON.stringify(implementing?.customData));

  console.log('A browser already on the board');
  // Give the broadcast a moment to arrive: the REST read above proves the seed landed, not
  // that the socket has been written to yet.
  for (let attempt = 0; attempt < 50 && !watcher.seen.batch; attempt++) await sleep(100);
  check('the socket connected before the board was loaded',
    Array.isArray(watcher.seen.initial) && watcher.seen.initial.length === 0,
    watcher.seen.initial === null
      ? 'no initial_elements arrived at all'
      : `initial_elements already had ${watcher.seen.initial.length} elements — the race went the other way, re-run`);
  check('a client already connected is told about the seed', Boolean(watcher.seen.batch));
  check('and it is told on the board it is watching, under the normalised id',
    watcher.seen.batch?.workspace === 'saved-board',
    `workspace was ${JSON.stringify(watcher.seen.batch?.workspace)}`);
  check('the broadcast carries the seeded elements',
    saved.length > 0 && (watcher.seen.batch?.elements ?? []).length === saved.length,
    `broadcast ${(watcher.seen.batch?.elements ?? []).length}, store ${saved.length}`);
} catch (error) {
  failures++;
  console.error(`  FAIL  ${error.message}`);
} finally {
  watcher.stop();
  child?.kill();
  await sleep(200);
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
